#!/usr/bin/env bun

/**
 * open-issue — the ONLY sanctioned way to create or body-edit an Issue in
 * this repo. The `check-forge-gates.sh` PreToolUse hook denies raw
 * `gh issue create` / `gh issue edit --body*`, directing every agent here.
 *
 * Gate: a task Issue (any `vinaya/tranche:<slug>` label) must carry the full
 * eight-field Planner's rationale in its body (`checkIssueRationale`,
 * planner-brief contract) — refused locally otherwise, before anything
 * reaches the forge. Non-task Issues (no tranche label) pass through
 * unvalidated: the rationale contract does not apply to them.
 *
 * Content gate: past presence, several checks grade what those fields
 * SAY (and what the Issue carries) against the surface the task touches, and
 * refuse — `checkBlastRadiusScope`
 * (a shared collision domain — live-derived `packages/*` workspace members,
 * built-in cross-cutting defaults, plus `vinaya.config.json`
 * `blastRadius.extraDomains`, see `readSharedPackages` below — that no
 * declared project owns, without a second project or a `blast-radius-ack:`
 * line),
 * `checkProjectsRegistered` (every declared `**Project:**` name resolves
 * against `.vinaya/projects.md`),
 * `checkNoBriefContent` (brief-shaped sections belong in the brief, not here),
 * `checkRationaleNamesDocs` (name a doc/skill path, or the `no-doc-surface`
 * sentinel — the only read-obligation signal a forge write leaves, since the
 * skill-check hook fires on file edits and this edits none),
 * `checkIssueType` (exactly one `vinaya/type:*` label — `labels.ts`'s `type`
 * category, the commit-type vocabulary applied to the Issue instead of the
 * commit). **CREATE-only**, unlike its four siblings above: the label is
 * required going forward from this axis's own merge, never retroactively —
 * running it on `edit` too would refuse an unrelated edit to any
 * pre-existing Issue for lacking a label nothing ever asked it to carry, a
 * forced backfill through the only sanctioned edit path. See the `isEdit`
 * branch below.
 * `checkConflictCompleteness` warns on an undeclared collision-domain overlap
 * and never blocks. The five block-on-fail checks apply to task Issues only,
 * same as the rationale gate; `checkIssueType` additionally applies to
 * `create` only.
 *
 * Label detection is per-path: on `create`, labels come from this command's
 * own argv (`--label` flags are naturally present there). On `edit`, argv is
 * silent — nobody re-passes `--label` when changing a body — so the target
 * Issue's ACTUAL current labels are fetched from the forge
 * (`gh issue view <n> --json labels`) and unioned with any argv labels. A
 * failed forge fetch is a hard refusal, never treated as "no tranche
 * label" (#417).
 *
 * Usage:
 *   bun packages/aeg-core/bin/open-issue.ts --title t --body-file <path> --label "vinaya/tranche:x" [gh args...]
 *   bun packages/aeg-core/bin/open-issue.ts edit <n> --body-file <path> [gh args...]
 *   bun packages/aeg-core/bin/open-issue.ts --validate-only --body-file <path> --label "vinaya/tranche:x"
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  amendRationaleDeps,
  findMilestoneAttachTargetForSlug,
  findTrancheSlug,
  hasExplicitMilestoneFlag,
  trancheLabel,
  trancheSlugLengthError,
  type MilestoneAttachTarget,
  parseRationaleDeps
} from '@attalabs/aeg-forge-state'
import {
  deriveBuiltinCrossCuttingDefaults,
  deriveWorkspacePackageDomains,
  parsePnpmWorkspaceYaml
} from '../src/blast-radius-domains'
import { checkForgeTitle } from '../src/brief-validation'
import {
  checkBlastRadiusScope,
  checkConflictCompleteness,
  checkIssueRationale,
  checkIssueType,
  checkNoBriefContent,
  checkProjectsRegistered,
  checkRationaleNamesDocs,
  isTaskIssueBodyShaped,
  isTaskIssueLabelSet,
  type ProjectPath,
  type TaskIssueFacts
} from '../src/issue-validation'
import { classifyLeftover } from '../src/leftover-detection'
import { parseRegistry } from '../src/parse-registry'

const REPO_ROOT = join(import.meta.dirname, '../../..')
process.chdir(REPO_ROOT)

function fail(msg: string): never {
  console.error(`\n[open-issue] REFUSED — ${msg}`)
  console.error('[open-issue] Nothing was sent to the forge. Fix the body and retry.')
  process.exit(1)
}

/** Where a validated body's bytes came from — a file/stream path, or an inline arg value. */
export type BodySource = { kind: 'file'; argIndex: number; inlineForm: boolean } | { kind: 'inline' }

export interface BodyResult {
  body: string
  source: BodySource
}

/**
 * Reads the body exactly once and records where it came from. `argIndex` +
 * `inlineForm` let `resolveShippableArgs` find and replace the same slot
 * later — the read here and the value shipped to `gh` must be the same
 * buffered string, not two independent reads of the same path.
 */
export function locateBody(args: string[]): BodyResult | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--body-file' || a === '-F') {
      const p = args[i + 1]
      if (!p) fail('`--body-file` given with no path.')
      return { body: readFileSync(p, 'utf8'), source: { kind: 'file', argIndex: i + 1, inlineForm: false } }
    }
    if (a.startsWith('--body-file=')) {
      const p = a.slice('--body-file='.length)
      return { body: readFileSync(p, 'utf8'), source: { kind: 'file', argIndex: i, inlineForm: true } }
    }
    if (a === '--body' || a === '-b') {
      const v = args[i + 1]
      if (v === undefined) fail('`--body` given with no value.')
      return { body: v, source: { kind: 'inline' } }
    }
    if (a.startsWith('--body=')) return { body: a.slice('--body='.length), source: { kind: 'inline' } }
  }
  return null
}

/**
 * Materializes an already-buffered body into a fresh temp file and rewrites
 * the `--body-file`/`-F` slot to point at it, so `gh`'s own read sees the
 * SAME bytes this process validated — never a second read of the original
 * path (which is empty for a stream by the time `gh` opens it). Inline
 * `--body`/`-b` args are untouched: no file, no second read, no risk.
 */
export function resolveShippableArgs(
  args: string[],
  bodyResult: BodyResult | null
): { finalArgs: string[]; cleanup: () => void } {
  if (bodyResult?.source.kind !== 'file') {
    return { finalArgs: args, cleanup: () => {} }
  }
  const dir = mkdtempSync(join(tmpdir(), 'aeg-open-issue-body-'))
  const tempPath = join(dir, 'body.md')
  writeFileSync(tempPath, bodyResult.body, 'utf8')
  const finalArgs = [...args]
  const { argIndex, inlineForm } = bodyResult.source
  finalArgs[argIndex] = inlineForm ? `--body-file=${tempPath}` : tempPath
  return { finalArgs, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Extracts --title/-t value from the passthrough args, if present. */
function extractTitle(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--title' || a === '-t') return args[i + 1] ?? null
    if (a.startsWith('--title=')) return a.slice('--title='.length)
  }
  return null
}

function extractLabels(args: string[]): string[] {
  const labels: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--label' || a === '-l') {
      const v = args[i + 1]
      if (v) labels.push(...v.split(',').map((s) => s.trim()))
    }
    if (a.startsWith('--label='))
      labels.push(
        ...a
          .slice('--label='.length)
          .split(',')
          .map((s) => s.trim())
      )
    if (a.startsWith('--add-label='))
      labels.push(
        ...a
          .slice('--add-label='.length)
          .split(',')
          .map((s) => s.trim())
      )
    if (a === '--add-label') {
      const v = args[i + 1]
      if (v) labels.push(...v.split(',').map((s) => s.trim()))
    }
  }
  return labels
}

/**
 * Fetches the target Issue's actual current labels from the forge. Edit
 * invocations don't normally re-pass `--label` flags, so argv says nothing
 * about whether the target is a task Issue — the forge is the only truthful
 * source (#417). Fails loud/closed: a failed fetch is never treated as "no
 * tranche label", which would silently re-open the exact bypass this
 * function exists to close.
 */
function fetchForgeLabels(issueRef: string): string[] {
  let out: string
  try {
    out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'labels'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    fail(
      `could not fetch Issue ${issueRef}'s labels from the forge (\`gh issue view\`) — the rationale gate cannot decide whether it applies. Check gh auth/network and retry; refusing to pass the edit through unvalidated.`
    )
  }
  try {
    const parsed = JSON.parse(out) as { labels: Array<{ name: string }> }
    return parsed.labels.map((l) => l.name)
  } catch {
    fail(
      `could not parse \`gh issue view ${issueRef} --json labels\` output — refusing to pass the edit through unvalidated.`
    )
  }
}

/** First `vinaya/tranche:<slug>` label's slug, or `null` when the set carries none. */
function trancheSlugFromLabels(labels: string[]): string | null {
  return findTrancheSlug(labels)
}

/** `<n>` out of a task title `[<slug>] <n> — …` (the same grammar `checkForgeTitle`'s `taskStyle` accepts), or `null`. */
export function taskIdFromTitle(title: string): string | null {
  const m = title.match(/^\[[a-z0-9._-]+\] (\S+) —/)
  return m ? (m[1] as string) : null
}

/** Soft-fail title fetch — unlike `fetchForgeLabels`/`fetchForgeBody`, this only feeds an informational print, never a blocking gate, so an unreachable forge yields `null` rather than refusing the whole command. Untested directly, by the same established convention as its siblings `fetchForgeLabels`/`fetchForgeBody`/`ghEditBody` — a real `gh` shim, not logic. `resolveTitleForLeftoverCheck` below is what actually carries the decision logic, and that IS tested, via injection. */
function fetchForgeTitle(issueRef: string): string | null {
  try {
    const out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'title'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const parsed = JSON.parse(out) as { title: string }
    return parsed.title
  } catch {
    return null
  }
}

/**
 * The title to derive a task id from, for the leftover-detection print.
 * Argv title first — works identically on `create` and `edit`, no forge
 * call needed. Falls back to a forge fetch only on `edit` with no `--title`
 * in argv (the common re-plan-a-body-only case); `create` always carries a
 * title in argv (required to open the Issue at all), so it never reaches
 * the fetch branch — `issueRef` is `null` there and the ternary short-circuits.
 * `fetchTitle` is injected (mirrors `fetchLeftoverFacts`/`printLeftoverStatus`
 * and this file's own `resolveMilestoneToAttach`/`lookupAttachTarget`) so
 * this branching is unit-tested without a real `gh` call.
 */
export function resolveTitleForLeftoverCheck(
  bodyArgs: string[],
  isEdit: boolean,
  issueRef: string | null,
  fetchTitle: (issueRef: string) => string | null = fetchForgeTitle
): string | null {
  return extractTitle(bodyArgs) ?? (isEdit && issueRef ? fetchTitle(issueRef) : null)
}

/** The three raw facts `classifyLeftover` needs, already fetched — the injectable boundary `printLeftoverStatus` tests against. */
export type LeftoverFacts = {
  branchExistsRemote: boolean
  commitsAheadOfMain: number
  openPrNumber: number | null
}

/** Real git/gh fetch. Soft-fail: `null` on any failure, never throws — the caller treats that as "could not check," not a refusal. */
function fetchLeftoverFacts(branch: string): LeftoverFacts | null {
  try {
    const branchExistsRemote =
      execFileSync('git', ['ls-remote', '--heads', 'origin', branch], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim().length > 0

    let commitsAheadOfMain = 0
    if (branchExistsRemote) {
      execFileSync('git', ['fetch', 'origin', branch, '--quiet'], { stdio: 'ignore' })
      const count = execFileSync('git', ['rev-list', '--count', `origin/main..origin/${branch}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      commitsAheadOfMain = count && !Number.isNaN(Number(count)) ? Number(count) : 0
    }

    const prOut = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const prs = JSON.parse(prOut) as Array<{ number: number }>
    return { branchExistsRemote, commitsAheadOfMain, openPrNumber: prs[0]?.number ?? null }
  } catch {
    return null
  }
}

/** Pure message builder — the whole reason `printLeftoverStatus` is testable without mocking `console.log` or shelling out. `facts: null` is the soft-fail case (git/gh unreachable). */
export function formatLeftoverPrint(slug: string, taskId: string, facts: LeftoverFacts | null): string {
  if (!facts) {
    return `[open-issue] leftover-detection: could not check task ${taskId} (${slug}) — git/gh unreachable, skipping.`
  }
  const result = classifyLeftover({ ...facts, worktreeExistsLocal: false })
  return `[open-issue] leftover-detection: task ${taskId} (${slug}) — ${result.verdict}. ${result.reason}`
}

/**
 * Unconditional leftover print on both `create` and `edit` — this repo's fix
 * for the class of failure `classifyLeftover`/`verify-dispatch.ts` already
 * solves for the Developer's `Step 0`, one stage too late for a
 * *planning/authoring* session that never runs any command until it opens
 * or re-opens this exact task Issue. `open-issue.ts` is the one command
 * every legitimate task-Issue touch already goes through, so printing here
 * — success or in-flight, every invocation, no flag — needs no agent to
 * remember to ask for it.
 *
 * On `create` too, deliberately (review correction on #311 — an earlier
 * revision of this PR restricted this to `edit` on the reasoning that "an
 * Issue must exist before its branch can," which is true of THIS Issue's
 * own future branch but does not establish that no branch sharing the same
 * `task/<slug>/<n>` name exists yet: `n` is parsed from TITLE TEXT
 * (`taskIdFromTitle`), not derived from this Issue's own number or history,
 * so a brand-new `create` whose title happens to name a task id that
 * collides with an already-in-flight or abandoned branch — two Planner
 * sessions independently cutting `[slug] 3 — …` unaware of each other, the
 * same root cause as the incident this whole check exists to catch, one
 * stage earlier — is exactly the scenario this must not miss. `fetchFacts`
 * is injected (mirrors `resolveMilestoneToAttach`'s `lookupAttachTarget`)
 * purely so the real git/gh shim can be swapped for a fixture in tests;
 * `formatLeftoverPrint` above carries the actual, tested logic.
 */
export function printLeftoverStatus(
  slug: string,
  taskId: string,
  fetchFacts: (branch: string) => LeftoverFacts | null = fetchLeftoverFacts
): void {
  console.log(formatLeftoverPrint(slug, taskId, fetchFacts(`task/${slug}/${taskId}`)))
}

/**
 * Milestone auto-attach on Issue CREATE (aeg-review-gate-v1 task 1 follow-up).
 * `deriveTrancheFromForge`/`listActiveTrancheSlugs` (`@attalabs/aeg-forge-state`)
 * never read an Issue's GitHub-native milestone field — only the
 * `vinaya/tranche:<slug>` label — so this drift was never functionally
 * load-pathing; it is pure GitHub-view hygiene (a Milestone showing
 * `open_issues=0` while 3 real open task Issues carry its label). Creation-time
 * only, by design: `edit` never force-attaches retroactively (an unrelated
 * body edit must not silently reassign an Issue's milestone).
 *
 * Returns the Milestone's TITLE — what `--milestone` actually accepts —
 * never the slug. Those coincide only in the legacy 1:1 regime; an
 * intent-declared Milestone (vinaya-milestone-model-v1) is titled something
 * else entirely, and `gh` handed a slug it does not match fails outright.
 * `lookupAttachTarget` (`resolveMilestoneAttachTarget`'s forge-fetching
 * sibling, `@attalabs/aeg-forge-state`) resolves both cases; it is injected
 * here so this stays testable without a real `gh` call.
 *
 * Not a hard failure when no matching open Milestone exists yet — a
 * tranche's Milestone may not exist yet at first-Issue-cut time (task
 * 5/#429 backfilled Milestones after the fact for the first cohort; a
 * brand-new tranche's very first Issue necessarily precedes its own
 * Milestone in some workflows).
 */
export function resolveMilestoneToAttach(
  labels: string[],
  args: string[],
  isEdit: boolean,
  lookupAttachTarget: (slug: string) => MilestoneAttachTarget | null
): string | null {
  if (isEdit) return null
  if (!isTaskIssueLabelSet(labels)) return null
  if (hasExplicitMilestoneFlag(args)) return null
  const slug = trancheSlugFromLabels(labels)
  if (!slug) return null
  const target = lookupAttachTarget(slug)
  return target ? target.title : null
}

// ---------- amend-deps subcommand --------------------------------------------
//
// `amend-deps` is the ONLY sanctioned way to change a task Issue's dependency
// edges (Issue #481, drift class #1). It rewrites the structured
// `Dependency rationale` field AND appends the matching `**Amendment (...)**`
// paragraph in ONE atomic write (`amendRationaleDeps`), with a runtime
// round-trip parse gate — closing the five-incident class this session where
// the field and a later free-form amendment drifted apart because nothing
// forced them to change together. Modeled on the rule that "the sanctioned path is
// the only path": there is no code path here that rewrites one representation
// without the other.

/** Parses one edge-set flag value into ids. The empty markers (`—`/`–`/`-`/``) yield `[]`. */
export function parseEdgeFlag(value: string): string[] {
  const t = value.trim()
  if (t === '' || t === '—' || t === '–' || t === '-') return []
  return t
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Order-sensitive edge-set equality — the round-trip gate's core predicate. */
export function edgesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export type AmendDepsFlags = {
  issue: string | null
  dependsOn?: string[]
  conflictsWith?: string[]
  note: string
  actor: string
  dryRun: boolean
}

/**
 * Parses the `amend-deps` subcommand's own flags (its body is composed, never
 * accepted, so `locateBody` is deliberately NOT reused here). A field flag that
 * is absent leaves `dependsOn`/`conflictsWith` `undefined` (untouched);
 * present-but-empty yields `[]` (the explicit `—` marker).
 */
export function parseAmendArgs(args: string[]): AmendDepsFlags {
  const flags: AmendDepsFlags = { issue: null, note: '', actor: 'Planner', dryRun: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    const valueFor = (name: string): string => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1)
      const v = args[i + 1] ?? ''
      i++
      return v
    }
    if (a === '--dry-run') flags.dryRun = true
    else if (a === '--depends-on' || a.startsWith('--depends-on='))
      flags.dependsOn = parseEdgeFlag(valueFor('--depends-on'))
    else if (a === '--conflicts-with' || a.startsWith('--conflicts-with='))
      flags.conflictsWith = parseEdgeFlag(valueFor('--conflicts-with'))
    else if (a === '--note' || a.startsWith('--note=')) flags.note = valueFor('--note')
    else if (a === '--actor' || a.startsWith('--actor=')) flags.actor = valueFor('--actor') || 'Planner'
    else if (!a.startsWith('-') && flags.issue === null) flags.issue = a
  }
  return flags
}

/** Static flag validation. Returns a refusal message, or `null` when the flags are well-formed. */
export function validateAmendFlags(flags: AmendDepsFlags): string | null {
  if (flags.issue === null) return 'amend-deps requires the target Issue number as the first argument.'
  if (flags.dependsOn === undefined && flags.conflictsWith === undefined) {
    return 'amend-deps requires at least one of `--depends-on` / `--conflicts-with`.'
  }
  if (flags.note.trim() === '') return 'amend-deps requires a non-empty `--note` (the why for the amendment).'
  return null
}

/** IO seams for {@link runAmendDeps}, injected so the orchestrator is testable without a real `gh`. */
export type AmendDepsDeps = {
  fetchLabels: (issue: string) => string[]
  fetchBody: (issue: string) => string
  editBody: (issue: string, newBody: string) => void
  today: () => string
  log: (msg: string) => void
  fail: (msg: string) => never
}

/**
 * The `amend-deps` orchestrator. Every real invocation is gated on a runtime
 * round-trip parse (`parseRationaleDeps(newBody)` must deep-equal the requested
 * sets) — the rewrite is NEVER trusted by construction. This is the exact
 * "test against real data, not assumptions" trap (Issue #481) enforced on
 * every invocation forever.
 */
export function runAmendDeps(flags: AmendDepsFlags, deps: AmendDepsDeps): void {
  const err = validateAmendFlags(flags)
  if (err) deps.fail(err)
  const issue = flags.issue as string

  const labels = deps.fetchLabels(issue)
  if (!isTaskIssueLabelSet(labels)) {
    deps.fail(`amend-deps targets task Issues only — Issue ${issue} carries no \`vinaya/tranche:*\` label.`)
  }

  const body = deps.fetchBody(issue)
  const before = parseRationaleDeps(body)

  const input = {
    note: flags.note,
    date: deps.today(),
    actor: flags.actor,
    ...(flags.dependsOn !== undefined ? { dependsOn: flags.dependsOn } : {}),
    ...(flags.conflictsWith !== undefined ? { conflictsWith: flags.conflictsWith } : {})
  }

  let newBody: string
  try {
    newBody = amendRationaleDeps(body, input)
  } catch (e) {
    deps.fail(`amend-deps could not rewrite Issue ${issue}: ${(e as Error).message}`)
  }

  // Round-trip gate (hard) — the writer and parser must agree on the grammar.
  const after = parseRationaleDeps(newBody)
  if (flags.dependsOn !== undefined && !edgesEqual(after.dependsOn, flags.dependsOn)) {
    deps.fail(
      `amend-deps round-trip FAILED for Depends-on: requested [${flags.dependsOn.join(', ')}] but parseRationaleDeps read back [${after.dependsOn.join(', ')}]. Nothing written.`
    )
  }
  if (flags.conflictsWith !== undefined && !edgesEqual(after.conflictsWith, flags.conflictsWith)) {
    deps.fail(
      `amend-deps round-trip FAILED for Conflicts-with: requested [${flags.conflictsWith.join(', ')}] but parseRationaleDeps read back [${after.conflictsWith.join(', ')}]. Nothing written.`
    )
  }

  // Rationale gate — the amended body must still carry the full rationale.
  const rationale = checkIssueRationale(newBody)
  if (rationale.status === 'fail') {
    deps.fail(
      `amend-deps: the amended body no longer passes the rationale gate (${rationale.errors.join(' | ')}). Nothing written.`
    )
  }

  if (flags.dryRun) {
    deps.log(newBody)
    deps.log('round-trip PASS')
    return
  }

  deps.editBody(issue, newBody)
  if (flags.dependsOn !== undefined) {
    deps.log(`[open-issue] Depends-on: [${before.dependsOn.join(', ')}] → [${after.dependsOn.join(', ')}]`)
  }
  if (flags.conflictsWith !== undefined) {
    deps.log(`[open-issue] Conflicts-with: [${before.conflictsWith.join(', ')}] → [${after.conflictsWith.join(', ')}]`)
  }
}

// ---------- content gate I/O (A/B/D block, C warns) --------------------------
//
// `issue-validation.ts` stays pure; every disk/forge read the content checks
// need happens here.

/**
 * `package.json`'s `workspaces` array PLUS `pnpm-workspace.yaml`'s
 * `packages:` list, concatenated — the combined source
 * `deriveWorkspacePackageDomains` resolves against. Both are read: pnpm does
 * not honor a `workspaces` key in `package.json` at all, so a pnpm adopter's
 * real workspace glob lives only in `pnpm-workspace.yaml` — reading just
 * `package.json` would silently derive zero `packages/*` domains for every
 * such adopter (review finding on this PR). `repoRoot` is injectable for
 * tests; every real caller uses the default.
 */
function readWorkspaces(repoRoot: string = REPO_ROOT): string[] {
  const fromPackageJson = (): string[] => {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { workspaces?: unknown }
      return Array.isArray(pkg.workspaces) ? pkg.workspaces.filter((w): w is string => typeof w === 'string') : []
    } catch {
      return []
    }
  }
  const fromPnpmWorkspaceYaml = (): string[] => {
    try {
      return parsePnpmWorkspaceYaml(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'))
    } catch {
      return []
    }
  }
  return [...fromPackageJson(), ...fromPnpmWorkspaceYaml()]
}

/** Immediate child directory names of `dir` (relative to `repoRoot`) — the glob-resolution half of `deriveWorkspacePackageDomains`. */
function listWorkspaceChildDirs(dir: string, repoRoot: string = REPO_ROOT): string[] {
  try {
    return readdirSync(join(repoRoot, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * `vinaya.config.json`'s `blastRadius.extraDomains` — the sanctioned path for
 * an adopter to declare a collision domain beyond live derivation and the
 * built-in defaults (a `migrations/` folder, a codegen output dir). Read as
 * plain JSON, not through `apps/cli`'s zod schema: `aeg-core` cannot depend
 * on `apps/cli` (the dependency runs the other way), and this is a single
 * optional field, not full config validation.
 */
function readConfigExtraDomains(repoRoot: string = REPO_ROOT): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'vinaya.config.json'), 'utf8')) as {
      blastRadius?: { extraDomains?: unknown }
    }
    const extra = raw.blastRadius?.extraDomains
    return Array.isArray(extra) ? extra.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}

/**
 * The full collision-domain list checks A/C consume: every `packages/*`
 * workspace member (live-derived from `package.json`, §Part 1), the
 * built-in cross-cutting defaults (lockfile/monorepo-config/CI/git-hooks
 * presence-checks, §Part 2), and `vinaya.config.json`'s
 * `blastRadius.extraDomains` (the sanctioned "one more domain" path). No
 * knowledge of the legacy `.aeg/packages` file — retired, zero backward
 * compatibility, same wave as `apps/cli`'s equivalent removal. A fresh
 * adopter with none of the optional inputs still gets a live, non-empty
 * list from derivation + defaults alone. `repoRoot` is injectable for
 * tests; every real caller uses the default (`REPO_ROOT`).
 */
export function readSharedPackages(repoRoot: string = REPO_ROOT): string[] {
  const derived = deriveWorkspacePackageDomains(readWorkspaces(repoRoot), (dir) =>
    listWorkspaceChildDirs(dir, repoRoot)
  )
  const defaults = deriveBuiltinCrossCuttingDefaults((p) => existsSync(join(repoRoot, p)))
  const configExtra = readConfigExtraDomains(repoRoot)
  return [...new Set([...derived, ...defaults, ...configExtra])]
}

/** Registry rows (`projects.md`) — the authority for which project owns which path. Absent ⇒ nothing is owned. */
function readProjectPaths(): ProjectPath[] {
  try {
    return parseRegistry(readFileSync(join(REPO_ROOT, '.vinaya/projects.md'), 'utf8'))
  } catch {
    return []
  }
}

/**
 * The tranche's other open task Issues, for check C. Best-effort by design:
 * C is warn-only, so a forge hiccup must degrade to "no warning", never to a
 * refusal — the opposite of `fetchForgeLabels`, which fails closed because a
 * missing label there would silently skip a *blocking* gate.
 */
function fetchSiblingTaskIssues(slug: string, selfRef: string | null): TaskIssueFacts[] {
  try {
    // Labels are filtered CLIENT-side, deliberately. `gh issue list --label
    // vinaya/tranche:<slug>` returns an empty set against this repo's live labels
    // even though the label exists and Issues carry it (reproduced on
    // `vinaya/tranche:vinaya-pages-v2`: 11 matching open Issues, `--label` yields
    // 0). Server-side filtering would have shipped C permanently silent and
    // indistinguishable from "no overlap" — the exact false-green shape this
    // whole change exists to remove. Listing open Issues and matching here is
    // one request either way.
    const out = execFileSync(
      'gh',
      ['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,body,labels'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
    )
    return (JSON.parse(out) as Array<{ number: number; body: string; labels: Array<{ name: string }> }>)
      .filter((i) => i.labels.some((l) => l.name === trancheLabel(slug)))
      .filter((i) => String(i.number) !== String(selfRef ?? '').replace(/^#/, ''))
      .map((i) => ({
        ref: `#${i.number}`,
        body: i.body ?? '',
        conflictsWith: parseRationaleDeps(i.body ?? '').conflictsWith
      }))
  } catch {
    console.warn('[open-issue] could not list sibling task Issues — skipping the conflict-completeness warning (C).')
    return []
  }
}

/** Fetches an Issue's current body from the forge — hard refusal on fetch/parse failure (#417 pattern). */
function fetchForgeBody(issueRef: string): string {
  let out: string
  try {
    out = execFileSync('gh', ['issue', 'view', issueRef, '--json', 'body'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    fail(
      `could not fetch Issue ${issueRef}'s body from the forge (\`gh issue view\`). Check gh auth/network and retry; refusing to amend blind.`
    )
  }
  try {
    return (JSON.parse(out) as { body: string }).body
  } catch {
    fail(`could not parse \`gh issue view ${issueRef} --json body\` output — refusing to amend blind.`)
  }
}

/** Ships an amended body through the SAME same-bytes edit machinery `edit` uses (`resolveShippableArgs`). */
function ghEditBody(issueRef: string, newBody: string): void {
  const bodyResult: BodyResult = { body: newBody, source: { kind: 'file', argIndex: 1, inlineForm: false } }
  const { finalArgs, cleanup } = resolveShippableArgs(['--body-file', '__amend_placeholder__'], bodyResult)
  try {
    const out = execFileSync('gh', ['issue', 'edit', issueRef, ...finalArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    })
    console.log(out.trim())
  } finally {
    cleanup()
  }
}

/**
 * Create-if-absent for the `vinaya/tranche:<slug>` label — the real
 * creation path Issue #54's Origin names as missing: the prefix family is
 * open-ended by design (a slug the Planner cuts at tranche-cut time), so no
 * fixed install-time list can enumerate it, and until now nothing created it
 * either — cutting a tranche's first Issue failed outright at `gh` with
 * `not found`, worked around by hand-running `gh label create`. This is the
 * one place a new tranche's label is ever minted, matching this file's own
 * status as the ONLY sanctioned Issue-creation path (module header). No
 * `-R` flag — `gh` resolves the current repo from cwd (`REPO_ROOT`, chdir'd
 * above), the same no-`-R` convention `ghLabelGateway` uses
 * (apps/cli/src/lib/detect.ts). Existing labels are never modified, matching
 * every other create-if-absent label path in this repo.
 */
const TRANCHE_LABEL_COLOR = '1D76DB'

function ensureTrancheLabelExists(slug: string): void {
  const name = trancheLabel(slug)
  let existing: Array<{ name: string }>
  try {
    const out = execFileSync('gh', ['label', 'list', '--json', 'name', '--limit', '200'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    existing = JSON.parse(out) as Array<{ name: string }>
  } catch (err) {
    fail(`could not list labels (\`gh label list\`) to check for '${name}': ${(err as Error).message}`)
  }
  if (existing.some((l) => l.name === name)) return
  try {
    execFileSync('gh', ['label', 'create', name, '--color', TRANCHE_LABEL_COLOR, '--description', `Tranche: ${slug}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    console.log(`[open-issue] created missing tranche label '${name}'.`)
  } catch (err) {
    fail(`could not create tranche label '${name}' (\`gh label create\`): ${(err as Error).message}`)
  }
}

export function main(): void {
  const argv = process.argv.slice(2)
  const validateOnly = argv.includes('--validate-only')
  const args = argv.filter((a) => a !== '--validate-only')

  if (args[0] === 'amend-deps') {
    runAmendDeps(parseAmendArgs(args.slice(1)), {
      fetchLabels: fetchForgeLabels,
      fetchBody: fetchForgeBody,
      editBody: ghEditBody,
      today: () => new Date().toISOString().slice(0, 10),
      log: (m) => console.log(m),
      fail
    })
    return
  }

  const isEdit = args[0] === 'edit'
  const ghArgs = isEdit ? args.slice(1) : args
  const bodyArgs = isEdit ? ghArgs.slice(1) : ghArgs

  const bodyResult = locateBody(bodyArgs)
  const body = bodyResult?.body ?? null
  let labels = extractLabels(bodyArgs)
  if (isEdit) {
    const issueRef = ghArgs[0]
    if (!issueRef || issueRef.startsWith('-')) {
      fail('edit mode requires the target Issue number/URL as the first argument after `edit`.')
    }
    const forgeLabels = fetchForgeLabels(issueRef)
    console.log(`[open-issue] edit — Issue ${issueRef} carries ${forgeLabels.length} label(s) on the forge.`)
    labels = [...new Set([...forgeLabels, ...labels])]
  }

  // O1 (task-run-v1 task 11) — a body carrying the Planner's `## Objectives`/
  // `## Planner's rationale` sections but posted with no `vinaya/tranche:*`
  // label reads, to the `isTaskIssueLabelSet` gate just below, as "not a task
  // Issue" and would otherwise sail through every check that gate guards,
  // unvalidated — a task Issue reaching the forge unlabeled. Mirrors
  // `apps/cli/src/lib/forge-write.ts`'s `refuseUnlabeledTaskShapedBody`
  // (the CLI's own copy of this same gate), never infers the label and adds
  // it silently — the Planner types it; this only refuses and names what's
  // missing.
  if (body !== null && !isTaskIssueLabelSet(labels) && isTaskIssueBodyShaped(body)) {
    fail(
      "the body carries task-Issue sections (`## Objectives` / `## Planner's rationale`) but no `vinaya/tranche:*` label was given — a task Issue never reaches the forge unlabeled. Add one with `--label vinaya/tranche:<slug>`."
    )
  }

  if (isTaskIssueLabelSet(labels)) {
    // GitHub caps a label name at 50 characters and `vinaya/tranche:` spends
    // 15 of them, so a slug that reads fine in prose can be one the forge
    // refuses to create. Caught here — the first place a new tranche's label
    // reaches the forge — rather than as an opaque `gh` 422 later.
    const labelSlug = trancheSlugFromLabels(labels)
    if (labelSlug !== null) {
      const lengthError = trancheSlugLengthError(labelSlug)
      if (lengthError) fail(`open-issue label-length: ${lengthError}`)
    }

    // Unconditional on every create/edit — see printLeftoverStatus's own doc
    // comment for why create must be covered too, not just edit.
    if (labelSlug !== null) {
      const titleForLeftoverCheck = resolveTitleForLeftoverCheck(
        bodyArgs,
        isEdit,
        isEdit ? (ghArgs[0] as string) : null
      )
      const taskIdForLeftoverCheck = titleForLeftoverCheck ? taskIdFromTitle(titleForLeftoverCheck) : null
      if (taskIdForLeftoverCheck !== null) {
        printLeftoverStatus(labelSlug, taskIdForLeftoverCheck)
      }
    }

    const title = extractTitle(bodyArgs)
    if (title !== null) {
      const t = checkForgeTitle(title)
      if (t.status === 'fail') fail(t.errors[0] as string)
    }
    if (body === null) {
      fail(
        'a task Issue (vinaya/tranche:* label) requires a `--body-file <path>` so the rationale gate can validate it.'
      )
    }
    console.log('[open-issue] task Issue (tranche label) — validating the Planner rationale…')
    const { status, errors } = checkIssueRationale(body)
    if (status === 'fail') {
      console.error(`\n[open-issue] FAILED — ${errors.length} rationale field(s) missing:\n`)
      for (const e of errors) console.error(`  ✗ ${e}`)
      fail('the Issue body does not carry the full eight-field Planner rationale (planner-brief contract).')
    }
    console.log('[open-issue] rationale gate PASS.')

    // ---- content gate: A/B/D block, C warns --------------------------------
    // The rationale gate above proves the eight fields EXIST. These prove what
    // they say is consistent with the surface the task touches — the three
    // failure classes that passed the presence gate on #621/#622/#626.
    const sharedPackages = readSharedPackages()
    if (sharedPackages.length === 0) {
      console.warn(
        '[open-issue] no collision domains derived, defaulted, or declared (no `packages/*` workspace, no cross-cutting default present, no `vinaya.config.json` blastRadius.extraDomains) — blast-radius check (A) is dormant.'
      )
    }
    const projectPaths = readProjectPaths()
    if (projectPaths.length === 0) {
      console.warn('[open-issue] no `.vinaya/projects.md` registry — the project-registry check is dormant.')
    }
    // checkIssueType is CREATE-ONLY, deliberately. "Forward-only, no
    // backfill" (task 10's §10 answer) means the label is required on a
    // task Issue from the moment it is CUT, not re-required every time it
    // is later edited — `open-issue.ts` is the only sanctioned edit path
    // for ANY Issue body, so running this check on `edit` too would refuse
    // an unrelated edit (a typo fix, a dependency update) to any Issue that
    // predates this axis, which is a de facto forced backfill through the
    // back door. A task Issue created after this merges gets the label at
    // creation and keeps it — nothing removes it — so skipping re-checks on
    // edit costs nothing for the forward case and exempts every pre-merge
    // Issue exactly as promised.
    const typeErrors = isEdit ? [] : checkIssueType(body, labels).errors
    const contentErrors = [
      ...checkBlastRadiusScope(body, labels, sharedPackages, projectPaths).errors,
      ...checkProjectsRegistered(
        body,
        labels,
        projectPaths.map((p) => p.name)
      ).errors,
      ...checkNoBriefContent(body).errors,
      ...checkRationaleNamesDocs(body).errors,
      ...typeErrors
    ]
    if (contentErrors.length > 0) {
      console.error(`\n[open-issue] FAILED — ${contentErrors.length} content check(s):\n`)
      for (const e of contentErrors) console.error(`  ✗ ${e}`)
      fail('the Issue body fails the blast-radius / project-registry / brief-content / docs-read / task-type checks.')
    }
    console.log(
      `[open-issue] content gate PASS (blast radius, project registry, brief content, docs read${isEdit ? '' : ', task type'}).`
    )
    if (isEdit) {
      console.log('[open-issue] edit — task-type check skipped (create-only; forward-only enforcement, no backfill).')
    }

    // C — warn-only. Never blocks: an Issue declares no precise file surface,
    // so an overlapping collision domain is a hint, not a fact.
    const slug = trancheSlugFromLabels(labels)
    if (slug) {
      const selfRef = isEdit ? (ghArgs[0] as string) : null
      const conflictWarnings = checkConflictCompleteness(
        {
          ref: selfRef ? `#${selfRef.replace(/^#/, '')}` : '(new)',
          body,
          conflictsWith: parseRationaleDeps(body).conflictsWith
        },
        fetchSiblingTaskIssues(slug, selfRef),
        sharedPackages
      )
      for (const w of conflictWarnings) console.warn(`[open-issue] WARNING — ${w}`)
    }
  } else {
    console.log('[open-issue] no tranche label — rationale gate does not apply, passing through.')
  }

  if (validateOnly) {
    console.log('[open-issue] --validate-only: stopping before gh.')
    process.exit(0)
  }

  // Give the target tranche label a real chance to exist BEFORE `gh issue
  // create`/`edit` ships — otherwise a brand-new tranche's first Issue fails
  // outright at `gh` with `not found`, far from its actual cause.
  const labelSlugToEnsure = trancheSlugFromLabels(labels)
  if (labelSlugToEnsure) {
    ensureTrancheLabelExists(labelSlugToEnsure)
  }

  const milestoneTitle = resolveMilestoneToAttach(labels, bodyArgs, isEdit, (slug) => {
    try {
      return findMilestoneAttachTargetForSlug('{owner}', '{repo}', slug)
    } catch {
      console.warn(`[open-issue] milestone lookup for "${slug}" failed (gh api) — creating without --milestone.`)
      return null
    }
  })
  const createArgs = milestoneTitle ? [...bodyArgs, '--milestone', milestoneTitle] : bodyArgs
  if (milestoneTitle) {
    console.log(`[open-issue] auto-attaching to open Milestone "${milestoneTitle}" (tranche label match).`)
  }

  const { finalArgs, cleanup } = resolveShippableArgs(createArgs, bodyResult)
  try {
    const finalGhArgs = isEdit ? [ghArgs[0] as string, ...finalArgs] : finalArgs
    const ghCmd = isEdit ? ['issue', 'edit', ...finalGhArgs] : ['issue', 'create', ...finalGhArgs]
    const out = execFileSync('gh', ghCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    console.log(out.trim())
  } finally {
    cleanup()
  }
}

if (import.meta.main) {
  main()
}
