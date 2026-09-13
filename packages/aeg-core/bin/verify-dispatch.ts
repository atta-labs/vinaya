#!/usr/bin/env bun

/**
 * verify-dispatch — the deterministic pre-work gate (aeg-governance-hardening
 * task 11, #324). Mechanizes the prose entry-gate items `roles/developer.md`
 * currently asks every Developer to re-derive by hand — the exact gap the
 * 2026-07-02/03 dispatch wave proved live (four agents independently
 * re-derived, and stopped on, the same archival fact; one walked through the
 * same prose gate others stopped on; one hit two push-time dead ends).
 *
 * Thin CLI/I/O shim, same discipline as `verify-docs.ts`/`verify-coherence.ts`:
 * resolves args, reads freshly-fetched forge/git state, and calls the pure
 * evaluators homed in `@attalabs/aeg-core` (`checkDispatchReadiness`,
 * `classifyLeftover`, `captureBaseline`/`compareToBaseline`,
 * `parsePremiseBlock`/`checkPremises`). No check logic lives here.
 *
 * One implementation per fact (§11 constraint) — reuses `deriveTrancheFromForge`,
 * `hasProvenance`, `taskRefFromBranch`, `checkIssueRationale`, and
 * `fetchProvenance` (imported from `verify-coherence.ts`, where it is already
 * exported — not re-implemented here).
 *
 * Usage:
 *   bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n>
 *   bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n> --premise <body-file>
 *   bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n> --simulate <body-file>
 *   bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n> --check-baseline <file>
 *   bun packages/aeg-core/bin/verify-dispatch.ts <tranche> <n> --surfaces <glob1,glob2,...>
 *
 * Modes:
 *   (default)         Forge dispatch-readiness gate + leftover-branch
 *                      classification + a baseline capture (informational —
 *                      the standing contract is "≤ captured baseline", never
 * "must be green"/live-fire #2).
 *   --premise [file]   Re-assert every `Premise:` pin against the current
 *                      on-disk state. With a file argument, reads that body
 *                      file (a brief not yet dispatched). With none, resolves
 *                      the task Issue's frozen `aeg:brief:v1` comment
 *                      instead (plan-brief-v1 task 2, #427) and re-asserts
 *                      the premises it carries. A failed premise is a stop
 *                      condition, not a silent re-guess (contracts/brief-developer.md).
 *   --simulate <file>  Dry-run the exit gates BEFORE work starts: verify-brief
 *                      + verify-docs --pr + push-mode C5, all against the
 *                      intended body file. No diff exists yet at this point,
 *                      so premise *coverage* (which needs real changed files)
 *                      is not evaluated here — only that the Premise: block
 *                      parses to at least one assertion.
 *   --check-baseline <file>  Compare current verify-docs/verify-coherence
 *                      finding counts against a previously captured baseline
 *                      file (JSON array of `BaselineEntry`). Fails if any
 *                      tool regressed past its baseline. A tool that could
 *                      not run at all (crash, unparseable output) is never
 *                      compared as if it scored 0 — it fails the check
 *                      outright (fail-closed: no signal means no pass).
 *   --surfaces <globs>  Mechanically derive the §7 doc-update-list floor
 * For a comma-separated list of intended surface
 *                      globs, by matching them against
 *                      `.vinaya/doc-owners`. Prints every fired
 *                      binding so the Planner sees, DURING Dig,
 *                      which doc pointers this task's surface will require at
 *                      PR-open (C5) — instead of discovering it for the first
 *                      time when `open-pr.ts` refuses. Read-only; makes no
 *                      forge calls. (`deriveSection7`, previously a
 *                      Planner aid with no CLI entry point.)
 *
 * Exit code: 0 when ready (and, in --premise/--simulate/--check-baseline
 * mode, when that mode's check passes); 1 otherwise, with every failing
 * predicate printed by name.
 *
 * CWD-independent by design: chdir's to the repo root immediately below.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AmbiguousBareEdgeError,
  deriveTrancheFromForge,
  fetchProvenance,
  trancheLabel,
  listActiveTrancheSlugs,
  parseRationaleDeps,
  requireTrancheQualifiedEdges,
  resolveGithubToken,
  resolveRepo,
  splitSlugQualifiedEdge,
  tranchesAttachedToMilestone,
  type RepoRef
} from '@attalabs/aeg-forge-state'
import {
  type BaselineEntry,
  captureBaseline,
  checkDispatchReadiness,
  checkIssueRationale,
  checkPremises,
  classifyLeftover,
  compareToBaseline,
  type DispatchConflictsWithFact,
  type DispatchDependsOnFact,
  type DispatchPriorTrancheFact,
  type DispatchPriorTaskFact,
  deriveSection7,
  classifyDocOwnersManifest,
  DOC_OWNERS_PATH,
  parsePremiseBlock,
  PRINCIPAL_ALLOWLIST,
  resolveNewestFrozenBrief
} from '../src/index'
import type { Tranche, Task } from '../src/types'

const REPO_ROOT = join(import.meta.dirname, '../../..')
process.chdir(REPO_ROOT)

// ---- I/O helpers -------------------------------------------------------------

// Array-form execFileSync — no shell, so no injection surface even though
// today's arguments are fixed/derived literals (`open-issue.ts`'s discipline;
// see also apps/vinaya/cli/src/checks/bin/check-dispatch-readiness.ts:58,
// this CLI's own port of this gate). `cmd`/`args` never pass through a shell,
// so a tranche slug (Milestone-title-derived, settable by any collaborator)
// interpolated into an argument cannot break out into shell syntax.
function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

function shJson<T>(cmd: string, args: string[]): T | null {
  const out = sh(cmd, args)
  if (!out) return null
  try {
    return JSON.parse(out) as T
  } catch {
    return null
  }
}

type IssueJson = {
  number: number
  state: 'OPEN' | 'CLOSED'
  body: string
  labels: Array<{ name: string }>
  milestone: { number: number } | null
}

const issueCache = new Map<number, IssueJson | null>()

function ghIssueView(num: number, repo: RepoRef): IssueJson | null {
  if (issueCache.has(num)) return issueCache.get(num) ?? null
  const result = shJson<IssueJson>('gh', [
    'issue',
    'view',
    String(num),
    '-R',
    `${repo.owner}/${repo.repo}`,
    '--json',
    'number,state,body,labels,milestone'
  ])
  issueCache.set(num, result)
  return result
}

type PrListEntry = { number: number; headRefName: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; mergedAt: string | null }

/** One batched fetch of every PR (any state) whose head branch belongs to this tranche. */
function fetchTrancheBranchPrs(trancheSlug: string, repo: RepoRef): Map<string, PrListEntry> {
  const all =
    shJson<PrListEntry[]>('gh', [
      'pr',
      'list',
      '-R',
      `${repo.owner}/${repo.repo}`,
      '--state',
      'all',
      '--json',
      'number,headRefName,state,mergedAt',
      '--limit',
      '300'
    ]) ?? []
  const prefix = `task/${trancheSlug}/`
  const map = new Map<string, PrListEntry>()
  for (const pr of all) {
    if (!pr.headRefName.startsWith(prefix)) continue
    const taskId = pr.headRefName.slice(prefix.length)
    map.set(taskId, pr)
  }
  return map
}

// ---- tranche / task resolution ---------------------------------------------

/**
 * Forge-derived (task aeg-forge-state-v1 3a) — no longer reads
 * `aeg-root/tranches/<slug>.md` off `origin/main`; the forge (Milestone +
 * `vinaya/tranche:<slug>`-labeled Issues) is inherently live, so there is no
 * separate "freshly-fetched" version to read. `null` now means the forge
 * call itself failed (network/gh unreachable), not "file absent" — a real,
 * distinct failure mode this bin didn't have before the cutover.
 */
async function readTrancheFromOrigin(trancheSlug: string, repo: RepoRef): Promise<Tranche | null> {
  try {
    return await deriveTrancheFromForge(repo.owner, repo.repo, trancheSlug)
  } catch {
    return null
  }
}

/** `#NNN` or a prose cell containing `#NNN` (e.g. cross-tranche "other-iter #264"). */
function directIssueNumFromEdge(edge: string): number | null {
  const m = edge.match(/#(\d+)/)
  return m ? Number(m[1]) : null
}

function resolveSameTrancheTask(edge: string, tranche: Tranche): Task | undefined {
  return tranche.tasks.find((t) => t.id === edge.trim())
}

/** A sibling tranche's tasks + its branch-PR state — everything a
 * slug-qualified edge (`<slug> <n>`) needs to resolve the same way a
 * same-tranche edge resolves. */
export type SiblingTranche = { tranche: Tranche; branchPrs: Map<string, PrListEntry> }

/** Injectable so tests can fake a sibling tranche without a real forge call.
 * `null` means the slug does not resolve on the forge at all (unknown
 * tranche) — the default impl reuses `deriveTrancheFromForge`, the same
 * derivation every other tranche lookup in this file already uses (one
 * derivation, N consumers — not a second forge-read path). */
export type SiblingTrancheResolver = (slug: string, repo: RepoRef) => Promise<SiblingTranche | null>

const defaultResolveSiblingTranche: SiblingTrancheResolver = async (slug, repo) => {
  try {
    const tranche = await deriveTrancheFromForge(repo.owner, repo.repo, slug)
    return { tranche, branchPrs: fetchTrancheBranchPrs(slug, repo) }
  } catch {
    return null
  }
}

/** Resolves one task the same way a same-tranche `Depends-on` edge resolves
 * — reused for both the current tranche and a sibling tranche found via a
 * slug-qualified edge. */
function dependsOnFactForTask(
  edge: string,
  task: Task,
  pr: PrListEntry | undefined,
  repo: RepoRef
): DispatchDependsOnFact {
  if (pr) return { id: edge, issue: task.issue, merged: pr.state === 'MERGED' }
  if (task.issue !== null) {
    const issueJson = ghIssueView(task.issue, repo)
    return { id: edge, issue: task.issue, merged: issueJson?.state === 'CLOSED' }
  }
  return { id: edge, issue: null, merged: false }
}

export async function resolveDependsOn(
  edges: string[],
  tranche: Tranche,
  branchPrs: Map<string, PrListEntry>,
  repo: RepoRef,
  resolveSibling: SiblingTrancheResolver = defaultResolveSiblingTranche
): Promise<DispatchDependsOnFact[]> {
  const siblingCache = new Map<string, SiblingTranche | null>()
  const facts: DispatchDependsOnFact[] = []
  for (const edge of edges) {
    const sameTask = resolveSameTrancheTask(edge, tranche)
    if (sameTask) {
      facts.push(dependsOnFactForTask(edge, sameTask, branchPrs.get(sameTask.id), repo))
      continue
    }
    const directIssue = directIssueNumFromEdge(edge)
    if (directIssue !== null) {
      const issueJson = ghIssueView(directIssue, repo)
      facts.push({ id: edge, issue: directIssue, merged: issueJson?.state === 'CLOSED' })
      continue
    }
    const qualified = splitSlugQualifiedEdge(edge)
    if (qualified) {
      let sibling = siblingCache.get(qualified.slug)
      if (sibling === undefined) {
        sibling = await resolveSibling(qualified.slug, repo)
        siblingCache.set(qualified.slug, sibling)
      }
      const siblingTask = sibling ? resolveSameTrancheTask(qualified.bareId, sibling.tranche) : undefined
      if (sibling && siblingTask) {
        facts.push(dependsOnFactForTask(edge, siblingTask, sibling.branchPrs.get(siblingTask.id), repo))
        continue
      }
    }
    // Genuinely unresolvable: neither a same-tranche task id, anything
    // containing a `#NNN` reference, nor a slug-qualified edge whose slug
    // AND task both resolve on the forge. Still blocks (conservative
    // default), but flagged distinctly from "not merged yet" (#196) —
    // dispatch-gate.ts reads `resolved: false` to report UNRESOLVABLE
    // rather than misattributing the failure to the forge.
    facts.push({ id: edge, issue: null, merged: false, resolved: false })
  }
  return facts
}

export async function resolveConflictsWith(
  edges: string[],
  tranche: Tranche,
  branchPrs: Map<string, PrListEntry>,
  repo: RepoRef,
  resolveSibling: SiblingTrancheResolver = defaultResolveSiblingTranche
): Promise<DispatchConflictsWithFact[]> {
  const siblingCache = new Map<string, SiblingTranche | null>()
  const facts: DispatchConflictsWithFact[] = []
  for (const edge of edges) {
    const sameTask = resolveSameTrancheTask(edge, tranche)
    if (sameTask) {
      const pr = branchPrs.get(sameTask.id)
      facts.push({ id: edge, issue: sameTask.issue, openOrInFlight: pr ? pr.state === 'OPEN' : false })
      continue
    }
    const directIssue = directIssueNumFromEdge(edge)
    if (directIssue !== null) {
      // No branch-PR knowledge for a cross-tranche #NNN edge — default to
      // not-blocking (a conflict only matters if a PR genuinely exists and
      // is open; we have no evidence of one). Known limitation, unchanged.
      facts.push({ id: edge, issue: directIssue, openOrInFlight: false })
      continue
    }
    const qualified = splitSlugQualifiedEdge(edge)
    if (qualified) {
      let sibling = siblingCache.get(qualified.slug)
      if (sibling === undefined) {
        sibling = await resolveSibling(qualified.slug, repo)
        siblingCache.set(qualified.slug, sibling)
      }
      const siblingTask = sibling ? resolveSameTrancheTask(qualified.bareId, sibling.tranche) : undefined
      if (sibling && siblingTask) {
        const pr = sibling.branchPrs.get(siblingTask.id)
        facts.push({ id: edge, issue: siblingTask.issue, openOrInFlight: pr ? pr.state === 'OPEN' : false })
        continue
      }
    }
    // Genuinely unresolvable (or a resolvable slug with no matching task) —
    // conservative default stays "not blocking": a conflict only matters
    // while a PR genuinely exists and is open, and there is no evidence of
    // one. Unlike depends-on, no message is ever emitted for this case, so
    // there is no misleading "unmerged"-style claim to correct here.
    facts.push({ id: edge, issue: null, openOrInFlight: false })
  }
  return facts
}

/**
 * "The prior task" means the immediately preceding TABLE ROW (`idx - 1`),
 * not the `Depends-on` column. removed the
 * predicate `checkDispatchReadiness` used to evaluate from this fact —
 * automated the provenance-posting signal the row-adjacency block existed to
 * protect. This resolver still runs and still feeds `DispatchGateInput.priorTask`
 * (dormant, no longer consumed by the gate) — dead-but-harmless plumbing, kept
 * rather than stripped to avoid a second, non-required removal pass across
 * every caller of this function.
 */
function resolvePriorTask(
  tranche: Tranche,
  taskId: string,
  branchPrs: Map<string, PrListEntry>,
  provenanceByIssue: Map<number, boolean>,
  repo: RepoRef
): DispatchPriorTaskFact | null {
  const idx = tranche.tasks.findIndex((t) => t.id === taskId)
  if (idx <= 0) return null
  const prior = tranche.tasks[idx - 1] as Task
  const pr = branchPrs.get(prior.id)
  const issueJson = prior.issue !== null ? ghIssueView(prior.issue, repo) : null
  return {
    id: prior.id,
    issue: prior.issue,
    issueClosed: issueJson?.state === 'CLOSED',
    prMerged: pr?.state === 'MERGED',
    hasProvenance: prior.issue !== null ? (provenanceByIssue.get(prior.issue) ?? false) : false
  }
}

/**
 * Label-aware candidate discovery (aeg-review-gate-v1 task 1, #474,
 * amendment; re-keyed off the derived tranche lifecycle by
 * vinaya-milestone-model-v1 task 1): "active" is every tranche whose
 * `vinaya/tranche:<slug>` label resolves to lifecycle `active` — a Milestone
 * titled exactly the slug and open (the legacy regime, unchanged) OR, for a
 * label with no such Milestone, at least one open Issue. The SAME
 * `listActiveTrancheSlugs` Studio's `readOtherActiveTranches`
 * (`apps/vinaya/web/src/lib/forge/dispatch-readiness.ts`, task 5, #429)
 * already calls, shared rather than duplicated per this task's own "no
 * parallel implementation" discipline. Before aeg-review-gate-v1 task 1 this
 * read the local `aeg-root/tranches/*.md` file listing — file-based and
 * unaware of Milestone state, so closing a tranche's topology file to
 * `completed/` WITHOUT also closing its Milestone left this CLI saying READY
 * while Studio correctly said BLOCKED (reproduced live on
 * `aeg-forge-state-v1`/`aeg-review-gate-v1`, 2026-07-08). "The Milestone is
 * open" stopped being the whole story once one Milestone could hold several
 * tranches (a Milestone closing no longer implies every tranche it held is
 * finished) — `listActiveTrancheSlugs` now answers from the derived
 * lifecycle directly, so this call site needed no change of its own.
 */
function otherActiveTrancheSlugs(excludeSlug: string, repo: RepoRef): string[] {
  return listActiveTrancheSlugs(repo.owner, repo.repo)
    .map((m) => m.slug)
    .filter((slug) => slug !== excludeSlug)
}

/**
 * One entry per project named in `projects`: the first active, all-Issues-closed
 * prior tranche found, or a null-slug pass-through when none is found.
 */
async function resolvePriorTrancheArchival(
  projects: string[],
  excludeSlug: string,
  repo: RepoRef
): Promise<DispatchPriorTrancheFact[]> {
  const candidates = otherActiveTrancheSlugs(excludeSlug, repo)
  const facts: DispatchPriorTrancheFact[] = []

  for (const project of projects) {
    let found: DispatchPriorTrancheFact | null = null
    for (const slug of candidates) {
      const candidateTranche = await deriveTrancheFromForge(repo.owner, repo.repo, slug)
      const touchesProject = candidateTranche.tasks.some((t) => t.projects.includes(project))
      if (!touchesProject) continue

      // Not routed through `ghIssueListByAnyLabel`: that helper is internal to
      // `@attalabs/aeg-forge-state`'s `gh.ts` (not exported) and issues a
      // `--state all` query with the full Issue JSON, where this site wants
      // open Issues and their numbers only.
      const openIssues =
        shJson<Array<{ number: number }>>('gh', [
          'issue',
          'list',
          '-R',
          `${repo.owner}/${repo.repo}`,
          '--label',
          trancheLabel(slug),
          '--state',
          'open',
          '--json',
          'number',
          '--limit',
          '100'
        ]) ?? []
      if (openIssues.length === 0) {
        found = { project, priorTrancheSlug: slug, archived: false }
        break
      }
    }
    facts.push(found ?? { project, priorTrancheSlug: null, archived: false })
  }

  return facts
}

// ---- leftover detection -------------------------------------------------------

function computeLeftoverForBranch(branch: string, worktreeDir: string) {
  const branchExistsRemote = sh('git', ['ls-remote', '--heads', 'origin', branch]).length > 0
  const worktreeExistsLocal = existsSync(worktreeDir)

  let commitsAheadOfMain = 0
  if (branchExistsRemote) {
    sh('git', ['fetch', 'origin', branch, '--quiet'])
    const count = sh('git', ['rev-list', '--count', `origin/main..origin/${branch}`])
    commitsAheadOfMain = count && !Number.isNaN(Number(count)) ? Number(count) : 0
  } else if (worktreeExistsLocal) {
    const count = sh('git', ['-C', worktreeDir, 'rev-list', '--count', 'origin/main..HEAD'])
    commitsAheadOfMain = count && !Number.isNaN(Number(count)) ? Number(count) : 0
  }

  return classifyLeftover({ branchExistsRemote, worktreeExistsLocal, commitsAheadOfMain })
}

function computeLeftover(trancheSlug: string, taskId: string) {
  return computeLeftoverForBranch(
    `task/${trancheSlug}/${taskId}`,
    join(REPO_ROOT, '.worktrees', 'task', trancheSlug, taskId)
  )
}

/** `task/issue-<n>` (task-run-v1 task 15, O1) — same leftover classification, keyed to the backlog Issue's own branch/worktree instead of a tranche+task-id pair. */
function computeLeftoverForIssue(issueNumber: number) {
  const branch = `task/issue-${issueNumber}`
  return computeLeftoverForBranch(branch, join(REPO_ROOT, '.worktrees', branch))
}

// ---- baseline capture ----------------------------------------------------------

type CaptureResult = { stdout: string; stderr: string; exitCode: number; ranAtAll: boolean }

/**
 * Non-throwing capture of a child's two streams, kept APART, used ONLY by
 * `currentFindingCounts()`. `sh()`/`shJson()` above deliberately swallow any
 * non-zero exit to `''` — every other call site of theirs relies on that
 * ("not found / not applicable"). Finding counts need the opposite: a
 * non-zero exit from `verify-docs`/`verify-coherence` means "here are the
 * findings," not "nothing to report," so this helper harvests output
 * regardless of exit code instead of throwing it away. Array-form
 * `spawnSync` — no shell, so no `2>&1` redirect is available.
 *
 * The two streams are kept APART, and that separation is the whole point
 * (#173). They used to be concatenated, on the stated premise that "neither
 * writes to stderr on its clean `--json` path". That premise was false:
 * `verify-coherence` probes `aeg-root/tranches` and `aeg-root/tranches/completed`
 * off the base ref, and the forge-native cutover deleted those directories —
 * `no-disk-state.ts` now actively forbids re-adding one — so `git` prints a
 * `fatal:` line per probe while the tool itself exits 0 with correct results.
 * Concatenated, one such line made `JSON.parse` throw, and the caller reported
 * `verify-coherence: UNAVAILABLE (tool failed to run)` on EVERY dispatch check.
 *
 * Worse than the false line: it made a genuinely-crashed run and a healthy but
 * chatty one indistinguishable, so the field could no longer surface the thing
 * it exists to surface. Each caller now picks the stream its own parse needs —
 * see `currentFindingCounts`.
 */
function captureStreams(cmd: string, args: string[]): CaptureResult {
  const result = spawnSync(cmd, args, { encoding: 'utf8' })
  if (result.error) return { stdout: '', stderr: '', exitCode: -1, ranAtAll: false }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
    ranAtAll: true
  }
}

/**
 * `verify-coherence --json`'s finding count, or `null` when `text` is not that
 * report. Deliberately stricter than "did `JSON.parse` succeed": the payload
 * must be an object carrying a numeric `summary.failed`. Anything else — a
 * scalar, an array, an object of another shape — means the tool did not
 * produce its contract, which is exactly what `unavailable` is for.
 *
 * Exit code is deliberately NOT consulted. `verify-coherence` exits non-zero
 * precisely when findings exist, so a non-zero exit with a well-formed report
 * is the normal finding-carrying case, not a failure. That asymmetry with
 * `docsUnavailable` (which does cross-check the exit code) is intentional:
 * `verify-docs` has no machine-readable payload to validate, so its exit code
 * is the only corroboration available there.
 */
function coherenceFailedCount(stdout: string): number | 'forge-unavailable' | null {
  const parsed = parseJsonSafe<unknown>(stdout)
  if (typeof parsed !== 'object' || parsed === null) return null
  // A forge-degraded sweep is INCOMPLETE, not clean. `verify-coherence` emits
  // `forgeUnavailable: true` when it could not reach the forge for one or more
  // tranches; its checks then run against whatever it could see, so `failed`
  // is a smaller number arrived at honestly and reported honestly — and read
  // as a finding COUNT it is a lie by omission.
  //
  // Before the streams were split, an outage happened to fail closed: the run
  // also printed to stderr, the concatenated parse threw, and the tool read as
  // unavailable. That was an accident, and removing it (#173) left this case
  // uncovered — the deliberate guard below only catches unparseable or
  // wrong-shaped stdout. Treating an outage as unavailable restores the
  // property on purpose, and matches `--check-baseline`'s own stated doctrine:
  // an unavailable tool carries no honest count, so it is never compared as if
  // it scored 0.
  if ((parsed as { forgeUnavailable?: unknown }).forgeUnavailable === true) return 'forge-unavailable'
  const summary = (parsed as { summary?: unknown }).summary
  if (typeof summary !== 'object' || summary === null) return null
  const failed = (summary as { failed?: unknown }).failed
  // Finite and non-negative, not merely `typeof 'number'`: `{"failed": -1}`
  // and `1e999` (→ Infinity) both parse and are not counts. Unreachable from
  // the real producer; rejected here so the guard's contract is the shape it
  // claims, not the shape today's producer happens to emit.
  if (typeof failed !== 'number' || !Number.isFinite(failed) || failed < 0) return null
  return failed
}

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

type FindingCount = {
  tool: string
  findingCount: number
  unavailable: boolean
  /**
   * The child's first stderr line, when it wrote one. Carried so the callers
   * that RENDER this baseline can show WHY a tool is unavailable, and can
   * surface a diagnostic from a tool that otherwise succeeded.
   *
   * Splitting the streams stopped stderr corrupting the parse; it also meant
   * nothing read stderr at all, so a `verify-coherence` diagnostic — an
   * unresolvable ref, say — was captured here and dropped on the floor. A
   * diagnostic that reaches no operator is not a diagnostic (review finding,
   * PR #179).
   */
  diagnostic?: string
}

/** The child's first non-empty stderr line, or `undefined` — what the baseline shows an operator. */
function firstStderrLine(stderr: string): string | undefined {
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (line === undefined) return undefined
  // Marked, not silently cut: an unmarked truncation reads as the whole
  // message, and these lines carry shas and paths that a mid-token cut makes
  // look like different values than they are.
  const LIMIT = 300
  return line.length <= LIMIT ? line : `${line.slice(0, LIMIT)}… (truncated)`
}

/**
 * Counts findings regardless of exit code — `verify-docs` and
 * `verify-coherence --json` both exit non-zero exactly when findings exist
 * (a normal, parseable run), which is the case that was previously
 * misreported as 0 (see module docstring). "Unavailable" (tool crashed /
 * produced no parseable output) is reported explicitly and is never folded
 * into the numeric count — see `docsUnavailable`/`coherenceUnavailable` below.
 */
export function currentFindingCounts(): FindingCount[] {
  // verify-docs is COUNTED, not parsed: `✗` lines are scanned, and a stray
  // stderr line cannot corrupt a line count the way it corrupts a JSON parse.
  // Both streams are scanned so a finding printed to stderr still counts.
  const docs = captureStreams('bun', ['packages/aeg-core/bin/verify-docs.ts'])
  const docsFindingCount = docs.ranAtAll ? countErrorLines(`${docs.stdout}${docs.stderr}`) : 0
  // verify-docs's own contract: exit 1 iff errors.length > 0 (bin/verify-docs.ts).
  // A non-zero exit with zero ✗ lines means it crashed before reaching that
  // contract, not that it ran and found nothing.
  const docsUnavailable = !docs.ranAtAll || (docs.exitCode !== 0 && docsFindingCount === 0)

  // verify-coherence is PARSED, so it reads stdout ALONE. `--json` writes the
  // document to stdout; anything on stderr is a subprocess's diagnostic noise
  // and is not part of the payload. Including it is what made a healthy run
  // report UNAVAILABLE (#173).
  const coherence = captureStreams('bun', ['packages/aeg-core/bin/verify-coherence.ts', '--json'])
  const coherenceRead = coherence.ranAtAll ? coherenceFailedCount(coherence.stdout) : null
  const coherenceFailed = typeof coherenceRead === 'number' ? coherenceRead : null
  // Three ways to be unavailable: the tool could not run, its stdout is not
  // the report this expects, or it ran against a forge it could not reach and
  // its count is therefore incomplete (`forgeUnavailable`, see above).
  // The second is a SHAPE check, not just `JSON.parse` succeeding — a scalar
  // or an object without `summary.failed` is valid JSON and would otherwise
  // throw a TypeError on property access. Reachable only since the streams
  // were split: concatenated stderr used to make every such stdout
  // unparseable, so the wrong-shape case never got that far.
  const coherenceUnavailable = !coherence.ranAtAll || coherenceFailed === null
  // `unavailable` covers two different facts and the operator needs to know
  // which: a tool that could not run, and a tool that ran fine against a forge
  // it could not reach. `fetchForgeFacts`'s own `reason` never reaches stderr,
  // so without this the second case renders as a bare "tool failed to run" for
  // a run that succeeded — a false statement this file's own fix introduced.
  const coherenceReason =
    coherenceRead === 'forge-unavailable'
      ? 'ran, but could not reach the forge — its finding count is incomplete, not clean'
      : undefined
  const coherenceFindingCount = coherenceFailed ?? 0

  const docsDiagnostic = firstStderrLine(docs.stderr)
  const coherenceDiagnostic = firstStderrLine(coherence.stderr)
  return [
    {
      tool: 'verify-docs-full',
      findingCount: docsFindingCount,
      unavailable: docsUnavailable,
      // verify-docs writes its own findings to stderr, so a diagnostic is only
      // worth showing when the run is unavailable — otherwise every clean run
      // would echo its first finding as if it were an error.
      ...(docsUnavailable && docsDiagnostic ? { diagnostic: docsDiagnostic } : {})
    },
    {
      tool: 'verify-coherence',
      findingCount: coherenceFindingCount,
      // Shown whether or not the run is unavailable: `--json` puts the report
      // on stdout, so ANY stderr here is a diagnostic the operator should see.
      // The forge-outage reason wins when both exist — it explains the verdict,
      // where a stderr line only accompanies it.
      ...((coherenceReason ?? coherenceDiagnostic) ? { diagnostic: coherenceReason ?? coherenceDiagnostic } : {}),
      unavailable: coherenceUnavailable
    }
  ]
}

function countErrorLines(output: string): number {
  return output.split('\n').filter((l) => l.trim().startsWith('✗')).length
}

// ---- modes ---------------------------------------------------------------------

export type ResolvePremiseBriefTextResult = { ok: true; text: string } | { ok: false; message: string }

/**
 * Resolves the newest principal-authored frozen brief's content out of an
 * Issue's raw `gh issue view --json comments` payload — via
 * `resolveNewestFrozenBrief` (task 4, Issue #483, O3), the same single
 * resolver `check-brief-shape.ts`/`fetchFrozenBrief` use, rather than a
 * v1-only marker match. Pure and exported so `--premise`'s Issue-derived
 * mode is unit-testable without spawning `gh` or the forge — the exact gap
 * that let a v1-only match ship here silently (security review, PR #503
 * round 2, BLOCKER: after `--supersede`, this refused every dispatch of the
 * corrected task at Step 0).
 */
export function resolvePremiseBriefText(
  comments: Array<{ body: string; author?: { login?: string } | null }>,
  issueNumber: number
): ResolvePremiseBriefTextResult {
  const normalized = comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
  const briefComment = resolveNewestFrozenBrief(normalized, PRINCIPAL_ALLOWLIST)
  if (!briefComment) {
    return { ok: false, message: `not dispatched — no \`aeg:brief:v<k>\` comment on Issue #${issueNumber}.` }
  }
  return { ok: true, text: briefComment.content }
}

async function runPremiseModeFromIssue(trancheSlug: string, taskId: string): Promise<void> {
  const repo = await resolveRepo()
  if (!repo) {
    console.error(
      'verify-dispatch --premise: could not resolve a GitHub repo (set AEG_REPO=owner/repo, or confirm `gh auth login`).'
    )
    process.exit(1)
  }

  let tranche: Tranche
  try {
    tranche = await deriveTrancheFromForge(repo.owner, repo.repo, trancheSlug)
  } catch (err) {
    console.error(
      `verify-dispatch --premise: could not derive tranche \`${trancheSlug}\` from the forge: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  }
  const task = tranche.tasks.find((t) => t.id === taskId)
  if (!task || task.issue === null) {
    console.error(
      `verify-dispatch --premise: not dispatched — task "${taskId}" in tranche \`${trancheSlug}\` has no Issue.`
    )
    process.exit(1)
  }

  const commentsJson = shJson<{ comments: Array<{ body: string; author?: { login?: string } | null }> }>('gh', [
    'issue',
    'view',
    String(task.issue),
    '-R',
    `${repo.owner}/${repo.repo}`,
    '--json',
    'comments'
  ])
  const resolved = resolvePremiseBriefText(commentsJson?.comments ?? [], task.issue)
  if (!resolved.ok) {
    console.error(`verify-dispatch --premise: ${resolved.message}`)
    process.exit(1)
  }

  const brief = resolved.text

  const assertions = parsePremiseBlock(brief)
  if (assertions.length === 0) {
    console.log(
      'verify-dispatch --premise: no `Premise:` assertions found in the dispatched brief — nothing to re-assert.'
    )
    process.exit(0)
  }
  const result = checkPremises(assertions, (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null))
  if (!result.pass) {
    console.error(`\nverify-dispatch --premise FAILED — ${result.failures.length} premise(s) no longer hold:\n`)
    for (const f of result.failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.log(`verify-dispatch --premise: all ${assertions.length} premise(s) re-asserted successfully.`)
  process.exit(0)
}

function runPremiseMode(bodyFile: string): void {
  const body = readFileSync(bodyFile, 'utf8')
  const assertions = parsePremiseBlock(body)
  if (assertions.length === 0) {
    console.log('verify-dispatch --premise: no `Premise:` assertions found in the body file — nothing to re-assert.')
    process.exit(0)
  }
  const result = checkPremises(assertions, (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null))
  if (!result.pass) {
    console.error(`\nverify-dispatch --premise FAILED — ${result.failures.length} premise(s) no longer hold:\n`)
    for (const f of result.failures) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.log(`verify-dispatch --premise: all ${assertions.length} premise(s) re-asserted successfully.`)
  process.exit(0)
}

function runSimulateMode(trancheSlug: string, taskId: string, bodyFile: string): void {
  const branch = `task/${trancheSlug}/${taskId}`
  const body = readFileSync(bodyFile, 'utf8')
  const assertions = parsePremiseBlock(body)
  console.log(
    assertions.length > 0
      ? `verify-dispatch --simulate: Premise: block present (${assertions.length} assertion(s)).`
      : 'verify-dispatch --simulate: WARNING — no `Premise:` block found in the body file (checkPremiseCoverage will fail at PR time if this task has a code surface).'
  )

  let failed = false
  const gates: Array<[string, () => void]> = [
    [
      'verify-brief',
      () =>
        execFileSync('bun', ['packages/aeg-core/bin/verify-brief.ts'], {
          env: { ...process.env, BRANCH: branch, PR_BODY: body },
          stdio: 'inherit'
        })
    ],
    [
      'verify-docs --pr',
      () =>
        execFileSync('bun', ['packages/aeg-core/bin/verify-docs.ts', '--pr'], {
          env: { ...process.env, PR_BODY: body },
          stdio: 'inherit'
        })
    ],
    [
      'verify-docs --push (C5, via PR_BODY_FILE)',
      () =>
        execFileSync('bun', ['packages/aeg-core/bin/verify-docs.ts', '--push'], {
          env: { ...process.env, PR_BODY_FILE: bodyFile },
          stdio: 'inherit'
        })
    ]
  ]

  for (const [label, run] of gates) {
    try {
      run()
      console.log(`verify-dispatch --simulate: ${label} PASS.`)
    } catch {
      console.error(`verify-dispatch --simulate: ${label} FAILED (output above).`)
      failed = true
    }
  }

  process.exit(failed ? 1 : 0)
}

function runSurfacesMode(surfacesArg: string): void {
  const surfaces = surfacesArg
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (surfaces.length === 0) {
    console.log('verify-dispatch --surfaces: no surface globs given — nothing to check.')
    process.exit(0)
  }

  // A repo that never configured doc ownership is legitimately dormant. A repo
  // that HAS a manifest but resolves the wrong path is a broken derivation
  // reporting success — the failure mode a silent `exit 0` used to hide. The
  // two are distinguished by whether the manifest exists where config says.
  const docOwnersContent = existsSync(DOC_OWNERS_PATH) ? readFileSync(DOC_OWNERS_PATH, 'utf8') : null
  const manifestState = classifyDocOwnersManifest(docOwnersContent)
  if (manifestState === 'absent') {
    console.log(
      `verify-dispatch --surfaces: no doc-ownership manifest at ${DOC_OWNERS_PATH} — dormant, no bindings to check.`
    )
    process.exit(0)
  }
  if (manifestState === 'empty') {
    console.error(
      `verify-dispatch --surfaces: ${DOC_OWNERS_PATH} is empty — refusing to report an empty derivation as success.`
    )
    process.exit(1)
  }

  // `present` is the only state that reaches here, so the content is a string.
  const { pointers, matches, errors } = deriveSection7(surfaces, docOwnersContent as string)
  if (errors.length > 0) {
    console.error(`verify-dispatch --surfaces: ${DOC_OWNERS_PATH} parse error(s):`)
    for (const e of errors) console.error(`  ✗ ${e}`)
    process.exit(1)
  }

  if (pointers.length === 0) {
    console.log(
      'verify-dispatch --surfaces: 0 doc-owners binding(s) match the given surface(s) — §7 has no mechanical floor.'
    )
    process.exit(0)
  }

  console.log(
    `verify-dispatch --surfaces: ${pointers.length} doc-owners binding(s) will fire for this surface at PR-open (C5) — plan §7 (or a vinaya/waiver:docs/vinaya/override:docs) for these now:\n`
  )
  for (const m of matches) {
    console.log(`  ${m.surface} matches ${DOC_OWNERS_PATH}:${m.lineNum} (glob \`${m.glob}\`) → ${m.pointer}`)
  }
  process.exit(0)
}

function runCheckBaselineMode(baselineFile: string): void {
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as BaselineEntry[]
  const current = currentFindingCounts()

  // Fail-closed: an unavailable tool carries no honest count, so it is never
  // fed into compareToBaseline's numeric comparison as if it scored 0 — that
  // would silently pass a regression the tool simply failed to observe.
  const unavailable = current.filter((c) => c.unavailable)
  if (unavailable.length > 0) {
    console.error('\nverify-dispatch --check-baseline FAILED — tool(s) produced no honest count to compare:')
    for (const u of unavailable) {
      console.error(`  ✗ ${u.tool}: UNAVAILABLE (no usable finding count)`)
      if (u.diagnostic) console.error(`      ↳ ${u.diagnostic}`)
    }
    console.error(
      '\nAn unavailable tool is never compared as if it scored 0. Fix the tool, then re-run --check-baseline.'
    )
    process.exit(1)
  }

  const comparison = compareToBaseline(
    current.map(({ tool, findingCount }) => ({ tool, findingCount })),
    baseline
  )
  console.log(JSON.stringify(comparison, null, 2))
  if (!comparison.withinBudget) {
    console.error('\nverify-dispatch --check-baseline FAILED — one or more tools regressed past their baseline.')
    process.exit(1)
  }
  console.log('\nverify-dispatch --check-baseline: within budget.')
  process.exit(0)
}

/**
 * **O5 (Issue #542) — a bare `Depends-on`/`Conflicts-with` edge id is
 * refused once the subject Issue's own Milestone holds more than one
 * tranche.** `requireTrancheQualifiedEdges` (`@attalabs/aeg-forge-state`,
 * shipped by issue-545) already carries the rule and the refusal message
 * (quoting the bare token and every tranche it could mean); this wraps it in
 * the string-or-null shape both gate modes fold into their own printed
 * blockers/exit code identically, rather than each call site re-deriving its
 * own try/catch. Pure over `milestoneTranches` — resolving that list from a
 * live Milestone number is the caller's job (`tranchesAttachedToMilestone`,
 * called once per gate run, below), keeping this testable without a real
 * forge call.
 */
export function checkMilestoneEdgeQualification(
  rawEdges: readonly string[],
  milestoneTranches: readonly string[]
): string | null {
  try {
    requireTrancheQualifiedEdges(rawEdges, milestoneTranches)
    return null
  } catch (err) {
    if (err instanceof AmbiguousBareEdgeError) return err.message
    throw err
  }
}

/**
 * The Milestone's own tranche list for O5's qualification check —
 * `tranchesAttachedToMilestone` when the subject Issue carries a Milestone,
 * `[]` (dormant: `requireTrancheQualifiedEdges` no-ops under two) when it
 * does not. One resolution point shared by both gate modes.
 */
function resolveMilestoneTranches(milestoneNumber: number | null, repo: RepoRef): string[] {
  return milestoneNumber === null ? [] : tranchesAttachedToMilestone(repo.owner, repo.repo, milestoneNumber)
}

async function runGateMode(trancheSlug: string, taskId: string): Promise<void> {
  // Still needed here: computeLeftover() below compares against the local
  // origin/main ref (git rev-list origin/main..origin/<branch>) — freshness
  // that used to be a side effect of the file-based tranche read above,
  // now made explicit since the forge read no longer needs it.
  sh('git', ['fetch', 'origin', 'main', '--quiet'])

  const repo = await resolveRepo()
  const token = await resolveGithubToken()
  if (!repo || !token) {
    console.error(
      'verify-dispatch severity:infra — could not resolve a GitHub repo/token (set AEG_REPO / GITHUB_TOKEN, or `gh auth login`). Cannot evaluate forge-dependent predicates.'
    )
    process.exit(1)
  }

  const tranche = await readTrancheFromOrigin(trancheSlug, repo)
  if (!tranche) {
    console.error(
      `verify-dispatch row-existence: could not derive tranche \`${trancheSlug}\` from the forge (no reachable Milestone/Issues, or the forge call failed).`
    )
    process.exit(1)
  }

  const task = (tranche as Tranche).tasks.find((t) => t.id === taskId)
  if (!task) {
    console.error(
      `verify-dispatch row-existence: task "${taskId}" is not present in tranche \`${trancheSlug}\`'s forge-derived task list (no \`${trancheLabel(trancheSlug)}\`-labeled Issue with this task id yet) — the plan/Issue for this task hasn't merged/opened. Not dispatchable until it does.`
    )
    process.exit(1)
  }

  const issueJson = task.issue !== null ? ghIssueView(task.issue, repo) : null
  const issueRationalePass = issueJson ? checkIssueRationale(issueJson.body).status === 'pass' : true

  const branchPrs = fetchTrancheBranchPrs(trancheSlug, repo)
  const dependsOn = await resolveDependsOn(task.dependsOn, tranche as Tranche, branchPrs, repo)
  const conflictsWith = await resolveConflictsWith(task.conflictsWith, tranche as Tranche, branchPrs, repo)

  const priorTaskRaw = resolvePriorTaskRaw(tranche as Tranche, taskId)
  let provenanceByIssue = new Map<number, boolean>()
  if (priorTaskRaw?.issue !== null && priorTaskRaw !== null) {
    provenanceByIssue = await fetchProvenance([priorTaskRaw.issue as number], repo.owner, repo.repo, token)
  }
  const priorTask = resolvePriorTask(tranche as Tranche, taskId, branchPrs, provenanceByIssue, repo)

  const priorTrancheArchival = await resolvePriorTrancheArchival(task.projects, trancheSlug, repo)

  const gateResult = checkDispatchReadiness({
    trancheSlug,
    task,
    issue:
      task.issue !== null && issueJson
        ? { number: task.issue, state: issueJson.state === 'OPEN' ? 'open' : 'closed' }
        : null,
    issueRationalePass,
    dependsOn,
    conflictsWith,
    priorTask,
    priorTrancheArchival
  })

  const edgeQualificationBlocker = checkMilestoneEdgeQualification(
    [...task.dependsOn, ...task.conflictsWith],
    resolveMilestoneTranches(issueJson?.milestone?.number ?? null, repo)
  )
  const blockers = edgeQualificationBlocker ? [...gateResult.blockers, edgeQualificationBlocker] : gateResult.blockers
  const ready = gateResult.ready && edgeQualificationBlocker === null

  const leftover = computeLeftover(trancheSlug, taskId)

  const rawCounts = currentFindingCounts()
  const nowIso = sh('git', ['log', '-1', '--format=%cI']) || new Date(0).toISOString()
  const capturedBaseline = captureBaseline(
    rawCounts.map(({ tool, findingCount }) => ({ tool, findingCount })),
    nowIso
  )

  console.log(`\nverify-dispatch: ${trancheSlug} task ${taskId}\n`)
  console.log(`dispatch-readiness: ${ready ? 'READY' : 'NOT READY'}`)
  for (const b of blockers) console.log(`  ✗ ${b}`)

  console.log(`\nleftover-detection: ${leftover.verdict}`)
  console.log(`  ${leftover.reason}`)

  console.log('\nbaseline (informational — captured this run, not a committed file):')
  for (const raw of rawCounts) {
    const captured = capturedBaseline.find((b) => b.tool === raw.tool)
    const capturedAt = captured?.capturedAt ?? nowIso
    console.log(
      raw.unavailable
        ? `  ${raw.tool}: UNAVAILABLE (no usable finding count) at ${capturedAt}`
        : `  ${raw.tool}: ${raw.findingCount} finding(s) at ${capturedAt}`
    )
    if (raw.diagnostic) console.log(`    ↳ ${raw.diagnostic}`)
  }

  const overallReady = ready && leftover.verdict !== 'stop'
  console.log(`\nverify-dispatch: ${overallReady ? 'READY TO DISPATCH' : 'NOT READY'}`)
  process.exit(overallReady ? 0 : 1)
}

/**
 * `--issue <n>` gate mode (task-run-v1 task 15, O1) — same dispatch-readiness
 * derivation as `runGateMode`, sourced from a backlog Issue directly instead
 * of a tranche topology row: no tranche, no Milestone, `dependsOn`/
 * `conflictsWith` parsed straight off the Issue's own "Dependency rationale"
 * field (`parseRationaleDeps`) and optional per O2. `resolveDependsOn`/
 * `resolveConflictsWith` are reused unchanged against an empty synthetic
 * tranche (no same-tranche sibling ids to match against a backlog Issue —
 * every edge resolves through their `#NNN`/slug-qualified paths instead,
 * exactly as O2 requires).
 *
 * Narrower than `runGateMode` in one respect, documented rather than
 * silently matched: no prior-task/prior-tranche-archival predicate (neither
 * applies with no tranche) and no `--premise`/`--simulate`/`--check-baseline`/
 * `--surfaces` companion mode — Step 0's own gate check is this mode's whole
 * job.
 */
async function runGateModeForIssue(issueNumber: number): Promise<void> {
  sh('git', ['fetch', 'origin', 'main', '--quiet'])

  const repo = await resolveRepo()
  const token = await resolveGithubToken()
  if (!repo || !token) {
    console.error(
      'verify-dispatch severity:infra — could not resolve a GitHub repo/token (set AEG_REPO / GITHUB_TOKEN, or `gh auth login`). Cannot evaluate forge-dependent predicates.'
    )
    process.exit(1)
  }

  const issueJson = ghIssueView(issueNumber, repo)
  if (!issueJson) {
    console.error(`verify-dispatch issue-existence: Issue #${issueNumber} does not resolve on the forge.`)
    process.exit(1)
  }
  if (issueJson.labels.some((l) => l.name.startsWith('vinaya/tranche:'))) {
    console.error(
      `verify-dispatch: Issue #${issueNumber} carries a vinaya/tranche:* label — it belongs to a tranche; use \`verify-dispatch <tranche> <n>\` instead of --issue.`
    )
    process.exit(1)
  }

  const issueRationalePass = checkIssueRationale(issueJson.body).status === 'pass'
  const { dependsOn: dependsOnIds, conflictsWith: conflictsWithIds } = parseRationaleDeps(issueJson.body)

  const emptyTranche: Tranche = { name: '', lifecycle: 'active', goal: '', tasks: [], backlog: [] }
  const noBranchPrs = new Map<string, PrListEntry>()
  const dependsOn = await resolveDependsOn(dependsOnIds, emptyTranche, noBranchPrs, repo)
  const conflictsWith = await resolveConflictsWith(conflictsWithIds, emptyTranche, noBranchPrs, repo)

  const task: Task = {
    id: String(issueNumber),
    title: '',
    issue: issueNumber,
    projects: [],
    dependsOn: dependsOnIds,
    conflictsWith: conflictsWithIds,
    rationaleMarkdown: ''
  }

  const gateResult = checkDispatchReadiness({
    trancheSlug: `issue-${issueNumber}`,
    task,
    issue: { number: issueNumber, state: issueJson.state === 'OPEN' ? 'open' : 'closed' },
    issueRationalePass,
    dependsOn,
    conflictsWith,
    priorTask: null,
    priorTrancheArchival: []
  })

  const edgeQualificationBlocker = checkMilestoneEdgeQualification(
    [...dependsOnIds, ...conflictsWithIds],
    resolveMilestoneTranches(issueJson.milestone?.number ?? null, repo)
  )
  const blockers = edgeQualificationBlocker ? [...gateResult.blockers, edgeQualificationBlocker] : gateResult.blockers
  const ready = gateResult.ready && edgeQualificationBlocker === null

  const leftover = computeLeftoverForIssue(issueNumber)

  const rawCounts = currentFindingCounts()
  const nowIso = sh('git', ['log', '-1', '--format=%cI']) || new Date(0).toISOString()
  const capturedBaseline = captureBaseline(
    rawCounts.map(({ tool, findingCount }) => ({ tool, findingCount })),
    nowIso
  )

  console.log(`\nverify-dispatch: Issue #${issueNumber} (backlog, no tranche)\n`)
  console.log(`dispatch-readiness: ${ready ? 'READY' : 'NOT READY'}`)
  for (const b of blockers) console.log(`  ✗ ${b}`)

  console.log(`\nleftover-detection: ${leftover.verdict}`)
  console.log(`  ${leftover.reason}`)

  console.log('\nbaseline (informational — captured this run, not a committed file):')
  for (const raw of rawCounts) {
    const captured = capturedBaseline.find((b) => b.tool === raw.tool)
    const capturedAt = captured?.capturedAt ?? nowIso
    console.log(
      raw.unavailable
        ? `  ${raw.tool}: UNAVAILABLE (no usable finding count) at ${capturedAt}`
        : `  ${raw.tool}: ${raw.findingCount} finding(s) at ${capturedAt}`
    )
    if (raw.diagnostic) console.log(`    ↳ ${raw.diagnostic}`)
  }

  const overallReady = ready && leftover.verdict !== 'stop'
  console.log(`\nverify-dispatch: ${overallReady ? 'READY TO DISPATCH' : 'NOT READY'}`)
  process.exit(overallReady ? 0 : 1)
}

/** Raw prior-task lookup (before forge facts are attached) — used only to know which Issue to batch-fetch provenance for. */
function resolvePriorTaskRaw(tranche: Tranche, taskId: string): Task | null {
  const idx = tranche.tasks.findIndex((t) => t.id === taskId)
  if (idx <= 0) return null
  return (tranche.tasks[idx - 1] as Task) ?? null
}

// ---- CLI entry point -----------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2)

  // `--issue <n>` (task-run-v1 task 15, O1) — a backlog Issue with no
  // tranche. Mutually exclusive with the `<tranche> <n>` positional form;
  // takes only the default gate mode (see `runGateModeForIssue`'s own doc
  // comment for the documented narrowing versus the tranche path's other
  // modes).
  const issueIdx = argv.indexOf('--issue')
  if (issueIdx !== -1) {
    const issueArg = argv[issueIdx + 1]
    const issueNumber = issueArg !== undefined ? Number.parseInt(issueArg, 10) : Number.NaN
    if (!issueArg || !Number.isInteger(issueNumber) || String(issueNumber) !== issueArg) {
      console.error('Usage: verify-dispatch --issue <n>')
      process.exit(1)
    }
    await runGateModeForIssue(issueNumber)
  } else {
    const trancheSlug = argv[0]
    const taskId = argv[1]

    if (!trancheSlug || !taskId || trancheSlug.startsWith('--')) {
      console.error(
        'Usage: verify-dispatch <tranche> <n> [--premise [file]] [--simulate <file>] [--check-baseline <file>] [--surfaces <glob1,glob2,...>]\n' +
          '   or: verify-dispatch --issue <n>'
      )
      process.exit(1)
    }

    await runGateModeOrCompanion(trancheSlug, taskId, argv)
  }
}

async function runGateModeOrCompanion(trancheSlug: string, taskId: string, argv: string[]): Promise<void> {
  const premiseIdx = argv.indexOf('--premise')
  const simulateIdx = argv.indexOf('--simulate')
  const checkBaselineIdx = argv.indexOf('--check-baseline')
  const surfacesIdx = argv.indexOf('--surfaces')

  if (surfacesIdx !== -1) {
    const globs = argv[surfacesIdx + 1]
    if (!globs) {
      console.error('--surfaces requires a comma-separated list of globs.')
      process.exit(1)
    }
    runSurfacesMode(globs)
  } else if (premiseIdx !== -1) {
    const file = argv[premiseIdx + 1]
    if (!file || file.startsWith('--')) {
      await runPremiseModeFromIssue(trancheSlug, taskId)
    } else {
      runPremiseMode(file)
    }
  } else if (simulateIdx !== -1) {
    const file = argv[simulateIdx + 1]
    if (!file) {
      console.error('--simulate requires a body-file path.')
      process.exit(1)
    }
    runSimulateMode(trancheSlug, taskId, file)
  } else if (checkBaselineIdx !== -1) {
    const file = argv[checkBaselineIdx + 1]
    if (!file) {
      console.error('--check-baseline requires a baseline-file path.')
      process.exit(1)
    }
    runCheckBaselineMode(file)
  } else {
    await runGateMode(trancheSlug, taskId)
  }
}
