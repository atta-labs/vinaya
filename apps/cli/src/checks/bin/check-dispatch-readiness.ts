#!/usr/bin/env bun

/**
 * Core check: dispatch-readiness. Thin adapter over `@attalabs/aeg-core`'s
 * `checkDispatchReadiness` — mirrors `packages/aeg-core/bin/verify-dispatch.ts`'s
 * gate-mode input assembly, scoped to the CURRENT task branch (derived from
 * `BRANCH`/the current git branch, `task/<tranche>/<n>`) rather than every
 * task in the repo — the same branch-derived scoping
 * `packages/aeg-core/bin/verify-brief.ts`/`verify-coherence.ts` already use.
 *
 * Tranche state is read ONLY through a `StateSource`
 * (`createForgeSource` from `@attalabs/vinaya-sources`) — no hardcoded state
 * path (task 2's ratified corollary). Forge facts come only from the two
 * primitives `@attalabs/aeg-core` re-exports for this purpose: `fetchForgeFacts`
 * and `fetchOpenIssuesByLabel`.
 *
 * `resolveRepo`/token discovery below are NOT re-derivations of a governance
 * fact — they're the same small env-or-git-remote / env-or-`gh` recipe
 * `@attalabs/aeg-forge-state`'s `resolveRepo`/`resolveGithubToken` use, kept
 * local because those two functions are not re-exported from `@attalabs/aeg-core`
 * (aeg-core-purity, #521) and this task's dependency boundary is
 * `@attalabs/aeg-core` + `@attalabs/vinaya-sources` only.
 *
 * Known scope gap (recorded in the PR body): `priorTrancheArchival` is
 * always reported empty. Resolving it for real requires
 * `listActiveTrancheSlugs` to discover candidate prior tranches per
 * project — not among the forge primitives this task's boundary re-exports.
 * Passing an empty list makes that one predicate trivially pass rather than
 * re-typing the fact via a second implementation; it is a real (if narrow)
 * parity gap versus `bin/verify-dispatch.ts`, not silently equivalent to it.
 *
 * Optional `PREMISE_FILE` (task 10, #59): when set, names a local brief/PR
 * body file whose `Premise:` block is re-asserted against current on-disk
 * state, mirroring `packages/aeg-core/bin/verify-dispatch.ts --premise`'s
 * file-read + assertion semantics (same `parsePremiseBlock`/`checkPremises`
 * pair, same three assertion kinds, paths resolved relative to this
 * process's cwd — the repo under check, since this bin never `chdir`s). A
 * failed pin is folded into this check's own findings, additively: it never
 * suppresses or replaces the existing forge-derived readiness predicates
 * above. Unset, behavior is byte-identical to before this task. **Inert off
 * a task branch:** `main()`'s existing `task/<tranche>/<n>` bypass below
 * exits before `checkPremiseReassertion` is ever called, so a `PREMISE_FILE`
 * set on any other branch is silently a no-op, not an error — the same
 * bypass every forge-derived predicate above already takes.
 *
 * scope: full — reads the live forge, not the local diff.
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { promisify } from 'node:util'
import {
  checkDispatchReadiness,
  checkIssueRationale,
  fetchForgeFacts,
  fetchOpenIssuesByLabel,
  parseTaskBranchIdentity,
  type DispatchConflictsWithFact,
  type DispatchDependsOnFact,
  type DispatchGateInput,
  type DispatchPriorTrancheFact,
  type Task
} from '@attalabs/aeg-core'
import { parseRationaleDeps } from '@attalabs/aeg-forge-state'
import { createForgeSource } from '@attalabs/vinaya-sources'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'
import { containedAbs } from '../../lib/ops'
import { type EdgeFactsSubset, type EdgeTaskRef, resolveEdge } from '../edge-resolve'
import { reassertPremiseFile } from '../premise-reassert-logic'

const CHECK_NAME = 'dispatch-readiness'

// No chdir: the only cwd-dependent work here is `git(...)` shelling out for
// the caller's own remote/branch, and the runner's spawn already inherits
// the caller's cwd — which IS the repo `vinaya check` is meant to evaluate.
// A chdir here previously pointed at wherever this SCRIPT lives (this
// monorepo from source, or the CLI's own install location once bundled),
// never the target repo — silently leaking this repo's own tranche/branch
// facts into whatever repo actually invoked the check.
const execFileAsync = promisify(execFile)

// Array-form execFileSync — no shell, so no injection surface even though
// today's arguments are fixed literals. `stdio: ['ignore', 'pipe', 'pipe']`
// is load-bearing, not cosmetic — see `check-coherence.ts`'s identical
// `git()` helper for the full reasoning: without it, an expected-and-caught
// git failure (e.g. `rev-parse --abbrev-ref HEAD` on an unborn HEAD) leaks
// raw non-JSON text onto this check's stderr, which the runner misreads as
// `status: 'error'` regardless of the real exit code.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function resolveRepo(): { owner: string; repo: string } | null {
  const fromEnv = process.env.AEG_REPO
  if (fromEnv) {
    const m = fromEnv.match(/^([^/]+)\/(.+)$/)
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  }
  const url = git(['remote', 'get-url', 'origin'])
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

async function resolveToken(): Promise<string | null> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'])
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

function currentBranch(): string {
  return process.env.BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD'])
}

function fail(message: string, prompt: string): never {
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: CHECK_NAME,
    severity: 'error',
    message,
    agent_recovery_prompt: prompt
  })
  process.exit(1)
}

/**
 * Re-asserts `PREMISE_FILE`'s `Premise:` pins against current on-disk state.
 * Additive to the forge-derived gate above — never a mode switch, never a
 * short-circuit: this runs regardless of `checkDispatchReadiness`'s own
 * verdict, and its own verdict never suppresses that one's findings either.
 * Returns `true` when the premise re-assertion holds (including the
 * `PREMISE_FILE` env var being unset — nothing to re-assert), `false` when it
 * failed and this check must exit non-zero.
 *
 * Thin `fs`/`process.env` wiring only — the decision logic (which errors to
 * emit for a missing file, zero pins, or a failed pin) lives in
 * `../premise-reassert-logic.ts`, unit-tested directly with fixtures. Mirrors
 * `packages/aeg-core/bin/verify-dispatch.ts`'s `runPremiseMode` semantics but
 * never calls `process.exit` itself: the caller decides the overall exit
 * code once every predicate (forge-derived and premise) has been evaluated
 * and reported.
 *
 * The per-pin `fileReader` passed to `checkPremises` is bounded by
 * `containedRealPath`, not `containedAbs` alone: a `Premise:` pin's `path`
 * field comes from the frozen, unmodified `parsePremiseBlock` grammar, which
 * imposes no containment of its own — an absolute path or a `..`-escaping
 * path in a pin is an arbitrary-file-read (`contains`/`absent`) or
 * arbitrary-file-fingerprint (`sha256`) oracle otherwise, and a path that is
 * lexically inside the root but textually names a SYMLINK whose target
 * resolves outside it is the same oracle again — `containedAbs` alone is a
 * pure `node:path` computation with no filesystem access, so it cannot see
 * that escape; `readFileSync` follows symlinks transparently. This check is
 * reachable from `PREMISE_FILE`, an adopter-wired env var that can point at
 * PR-author-controlled content on that same PR's own branch checkout
 * (mirroring how `PR_BODY_FILE` is wired elsewhere) — an author who controls
 * both the pin and the tree can commit a symlink alongside a malicious pin
 * in the same PR, so this is a real input, not a hypothetical one. No chdir
 * (see module doc comment), so `process.cwd()` is the correct containment
 * root. `checkPremises` itself and the pin grammar it parses are unchanged —
 * this only bounds what the wiring will read on a pin's behalf.
 */
function checkPremiseReassertion(): boolean {
  const premiseFile = process.env.PREMISE_FILE
  if (!premiseFile) return true

  const body = existsSync(premiseFile) ? readFileSync(premiseFile, 'utf8') : null
  const result = reassertPremiseFile(CHECK_NAME, premiseFile, body, (p) => {
    const real = containedRealPath(process.cwd(), p)
    if (real === null) return null
    try {
      return readFileSync(real, 'utf8')
    } catch {
      return null
    }
  })
  for (const error of result.errors) emitCheckError(error)
  return result.pass
}

/**
 * `containedAbs(root, p)`, then re-verified through the REAL (symlink-
 * resolved) path — matches `apps/cli/src/lib/self-host.ts`'s
 * `resolvesInsideRepo`, the same fix for the same escape class (a lexically-
 * safe path that resolves, through a symlink, to somewhere outside the
 * bound). Every failure shape — the lexical escape `containedAbs` already
 * refuses, a broken symlink, a missing file, or a real symlink escape —
 * collapses to the same `null`, which `checkPremiseReassertion` folds into
 * `checkPremises`'s existing "does not exist on disk" outcome. That
 * collapse is load-bearing, not incidental: it is what stops a `sha256` pin
 * on an escaping symlink from ever reaching the branch that would compute
 * and disclose the real target's digest in the failure message.
 */
function containedRealPath(root: string, p: string): string | null {
  const abs = containedAbs(root, p)
  if (abs === null) return null
  try {
    const real = realpathSync(abs)
    const realRoot = realpathSync(root)
    return real === realRoot || real.startsWith(realRoot + sep) ? real : null
  } catch {
    return null
  }
}

type IssueJson = { number: number; state: 'OPEN' | 'CLOSED'; body: string; labels: { name: string }[] }

function fetchIssueJson(issueNumber: number): IssueJson | null {
  try {
    const out = execFileSync('gh', ['issue', 'view', String(issueNumber), '--json', 'number,state,body,labels'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return JSON.parse(out) as IssueJson
  } catch {
    return null
  }
}

/**
 * `--issue <n>` gate: task-run-v1 task 15, O2. Same `checkDispatchReadiness`
 * evaluation as the tranche path, sourced from a backlog Issue directly — no
 * topology row, no Milestone, `dependsOn`/`conflictsWith` parsed straight
 * off the Issue's own "Dependency rationale" field and optional (per O2)
 * rather than required. No prior-tranche-archival predicate applies (there
 * is no tranche); premise re-assertion still runs (`PREMISE_FILE`),
 * unchanged.
 */
async function runIssueMode(issueNumber: number): Promise<void> {
  const issueJson = fetchIssueJson(issueNumber)
  if (!issueJson) {
    fail(
      `dispatch-gate issue-existence: Issue #${issueNumber} does not resolve on the forge.`,
      'Confirm the Issue number is correct and `gh auth status` passes, then re-run `vinaya check dispatch-readiness`.'
    )
  }
  if (issueJson.labels.some((l) => l.name.startsWith('vinaya/tranche:'))) {
    fail(
      `dispatch-gate: Issue #${issueNumber} carries a vinaya/tranche:* label — it belongs to a tranche, not the tranche-less backlog path.`,
      'This Issue has a real tranche home — run this check on its tranche-shaped branch instead.'
    )
  }

  const repo = resolveRepo()
  if (!repo) {
    fail(
      'dispatch-gate severity:infra — could not resolve owner/repo.',
      'Set AEG_REPO=owner/repo, or confirm `git remote get-url origin` resolves to a GitHub URL, then re-run `vinaya check dispatch-readiness`.'
    )
  }

  const issueRationalePass = checkIssueRationale(issueJson.body).status !== 'fail'
  const { dependsOn: dependsOnIds, conflictsWith: conflictsWithIds } = parseRationaleDeps(issueJson.body)

  const taskById = new Map<string, EdgeTaskRef>()
  const factsByTaskId = new Map<string, EdgeFactsSubset>()
  const dependsOn: DispatchDependsOnFact[] = await Promise.all(
    dependsOnIds.map(async (dep) => {
      const r = await resolveEdge(dep, taskById, factsByTaskId, repo)
      return {
        id: dep,
        issue: r.issue,
        merged: r.merged,
        resolved: r.resolved,
        issueState: r.issueState,
        stateReason: r.stateReason,
        closedByActor: r.closedByActor
      }
    })
  )
  const conflictsWith: DispatchConflictsWithFact[] = await Promise.all(
    conflictsWithIds.map(async (c) => {
      const r = await resolveEdge(c, taskById, factsByTaskId, repo)
      return { id: c, issue: r.issue, openOrInFlight: r.open }
    })
  )

  const task: Task = {
    id: String(issueNumber),
    title: '',
    issue: issueNumber,
    projects: [],
    dependsOn: dependsOnIds,
    conflictsWith: conflictsWithIds,
    rationaleMarkdown: ''
  }

  const input: DispatchGateInput = {
    trancheSlug: `issue-${issueNumber}`,
    task,
    issue: { number: issueNumber, state: issueJson.state === 'OPEN' ? 'open' : 'closed' },
    issueRationalePass,
    dependsOn,
    conflictsWith,
    priorTask: null,
    priorTrancheArchival: [],
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig())
  }

  const result = checkDispatchReadiness(input)

  let ready = true
  if (!result.ready) {
    for (const blocker of result.blockers) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: blocker,
        agent_recovery_prompt: recoveryPromptFor(blocker)
      })
    }
    ready = false
  }

  if (!checkPremiseReassertion()) ready = false

  process.exit(ready ? 0 : 1)
}

async function main(): Promise<void> {
  const branch = currentBranch()
  const ref = parseTaskBranchIdentity(branch)
  if (!ref) {
    // Non-task branch — nothing scoped to evaluate. Mirrors verify-brief.ts's bypass.
    process.exit(0)
  }

  // task-run-v1 task 15, O2: a backlog Issue with no tranche — resolved
  // straight from the Issue itself, no topology lookup.
  if (ref.kind === 'issue') {
    await runIssueMode(ref.issueNumber)
    return
  }

  const trancheSlug = ref.tranche
  const taskId = ref.taskId

  const repo = resolveRepo()
  if (!repo) {
    fail(
      'dispatch-gate severity:infra — could not resolve owner/repo.',
      'Set AEG_REPO=owner/repo, or confirm `git remote get-url origin` resolves to a GitHub URL, then re-run `vinaya check dispatch-readiness`.'
    )
  }

  const source = createForgeSource({ owner: repo.owner, repo: repo.repo })
  let tranche: Awaited<ReturnType<typeof source.getTranche>>
  try {
    tranche = await source.getTranche(trancheSlug)
  } catch (err) {
    fail(
      `dispatch-gate severity:infra — could not derive tranche "${trancheSlug}" from the forge: ${(err as Error).message}`,
      'Confirm `gh auth status` passes and the tranche has a Milestone + labeled Issues on the forge, then re-run this check.'
    )
  }

  const task = tranche.tasks.find((t) => t.id === taskId)
  if (!task) {
    fail(
      `dispatch-gate row-existence: task "${taskId}" is not present in tranche "${trancheSlug}"'s forge-derived task list.`,
      'Confirm the branch name matches a real, forge-registered task id, or wait for the Planner to open the task Issue before re-running.'
    )
  }

  const taskRefs = tranche.tasks.map((t) => ({ id: t.id, issue: t.issue }))
  const snapshot = await fetchForgeFacts({
    owner: repo.owner,
    repo: repo.repo,
    tranche: trancheSlug,
    tasks: taskRefs
  })

  const token = (await resolveToken()) ?? ''
  const openIssuesBySlug = await fetchOpenIssuesByLabel([trancheSlug], repo.owner, repo.repo, token)
  const openIssues = openIssuesBySlug.get(trancheSlug) ?? []

  const issueFacts = task.issue !== null ? snapshot.facts.get(task.id) : undefined
  const issue =
    task.issue !== null && issueFacts
      ? { number: task.issue, state: (issueFacts.issueState === 'closed' ? 'closed' : 'open') as 'open' | 'closed' }
      : null

  // Rationale is only checkable when the issue's body is available — the
  // OPEN-issues-by-label fetch is the only forge primitive this check has for
  // issue bodies. A closed issue's body is unavailable through it; defaulting
  // to pass in that case is a scoped decision (see module doc comment / PR body).
  const openIssueMatch = task.issue !== null ? openIssues.find((i) => i.number === task.issue) : undefined
  const issueRationalePass = openIssueMatch ? checkIssueRationale(openIssueMatch.body).status !== 'fail' : true

  const taskById = new Map(tranche.tasks.map((t) => [t.id, t]))
  const factsByTaskId = snapshot.facts

  const dependsOn: DispatchDependsOnFact[] = await Promise.all(
    task.dependsOn.map(async (dep) => {
      const r = await resolveEdge(dep, taskById, factsByTaskId, repo)
      return {
        id: dep,
        issue: r.issue,
        merged: r.merged,
        resolved: r.resolved,
        issueState: r.issueState,
        stateReason: r.stateReason,
        closedByActor: r.closedByActor
      }
    })
  )
  const conflictsWith: DispatchConflictsWithFact[] = await Promise.all(
    task.conflictsWith.map(async (c) => {
      const r = await resolveEdge(c, taskById, factsByTaskId, repo)
      return { id: c, issue: r.issue, openOrInFlight: r.open }
    })
  )

  const priorTrancheArchival: DispatchPriorTrancheFact[] = []

  const input: DispatchGateInput = {
    trancheSlug,
    task,
    issue,
    issueRationalePass,
    dependsOn,
    conflictsWith,
    priorTask: null,
    priorTrancheArchival,
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig())
  }

  const result = checkDispatchReadiness(input)

  let ready = true
  if (!result.ready) {
    for (const blocker of result.blockers) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: blocker,
        agent_recovery_prompt: recoveryPromptFor(blocker)
      })
    }
    ready = false
  }

  // Additive, not a short-circuit: runs (and reports) regardless of the
  // forge-derived verdict above, and never suppresses it either — see
  // `checkPremiseReassertion`'s own doc comment.
  if (!checkPremiseReassertion()) ready = false

  process.exit(ready ? 0 : 1)
}

/** Tailors the instruction to `checkDispatchReadiness`'s own `dispatch-gate <category>:` blocker prefixes, rather than one canned prompt for every failure type. */
export function recoveryPromptFor(blocker: string): string {
  // Checked first: an INTERNAL blocker is a tool-bug report, not a gate state,
  // and every prompt below tells the agent to resolve something. Falling
  // through to the generic "resolve the named dispatch blocker" would invite
  // exactly the improvisation this blocker class exists to prevent.
  if (blocker.startsWith('dispatch-gate INTERNAL:')) {
    return 'This is an INTERNAL parser-bug report, not a real dispatch gate — a task cannot depend on itself, so there is nothing here to wait for or resolve. Do NOT work around it and do NOT skip the hook. Report it upstream, and re-run once the rationale text is corrected or the parser fix ships.'
  }
  if (blocker.startsWith('dispatch-gate issue-existence:')) {
    return 'This task has no resolvable Issue yet. Wait for the Planner to cut the Issue (or fix the phantom reference in the topology), then re-run `vinaya check dispatch-readiness`.'
  }
  if (blocker.startsWith('dispatch-gate rationale:')) {
    return "The task's Issue fails the rationale gate. Ask the Planner to complete the eight-field rationale on the Issue body, then re-run `vinaya check dispatch-readiness`."
  }
  if (blocker.startsWith('dispatch-gate depends-on:') && blocker.includes('UNRESOLVABLE')) {
    return 'A declared dependency edge could not be resolved to any tranche/task/Issue — check the tranche slug and task id in the edge text, then re-run `vinaya check dispatch-readiness`.'
  }
  if (blocker.startsWith('dispatch-gate depends-on:')) {
    return 'A declared dependency is not merged yet. Do not start this task — wait for the named dependency PR to merge, then re-run `vinaya check dispatch-readiness`.'
  }
  if (blocker.startsWith('dispatch-gate conflicts-with:')) {
    return 'A declared conflicting task has an open or in-flight PR. Wait for it to merge before continuing, then re-run `vinaya check dispatch-readiness`.'
  }
  if (blocker.startsWith('dispatch-gate prior-tranche-archival:')) {
    return "This project's previous tranche is not archived. Ask the Tranche Archivist to run first, then re-run `vinaya check dispatch-readiness`."
  }
  return 'Resolve the named dispatch blocker before continuing work on this task, then re-run `vinaya check dispatch-readiness`.'
}

// Guarded so this module can be imported by unit tests without executing the
// check. Spawned as a bin (the only way it runs for real) this is still true.
if (import.meta.main) {
  main()
}
