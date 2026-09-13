/**
 * verify-coherence pure check evaluators — deterministic plan↔forge coherence
 * oracle logic (A1/A2/A3, T1/T2/T3, D1, L1/L2/L3/L4, closes-N)..
 *
 * Pure — no `fs`, no `fetch`, no `process.env`. All forge facts and tranche
 * topology are injected by the caller (`bin/verify-coherence.ts`, the I/O shim).
 */

import { parseRationaleDeps, trancheLabel, label } from '@attalabs/aeg-forge-state'
import { anchoredRegion, stripCode } from './anchored-region'
import {
  checkIssueObjectives,
  checkIssueRationale,
  checkPartsCiteDefinedObjectives,
  checkProjectsRegistered,
  checkSurfaceExcludesBoundDoc,
  checkSurfaceOverlap,
  isTaskIssueLabelSet,
  parseIssueSurface,
  type TaskSurfaceFacts
} from './issue-validation'
import { parseTaskBranchIdentity } from './task-branch-identity'
import { isPrincipal, PRINCIPAL_ALLOWLIST } from './waiver-label'
import type { ForgeIssue, TaskIssueRef } from '@attalabs/aeg-types'
import type { GhIssue } from '@attalabs/aeg-forge-state'
import type { ForgeFacts, Tranche, Task } from './types'

// ---------- grandfather cutoff -----------------------------------------------

/**
 * Incoherences whose terminal forge event predates this date are grandfathered:
 * emitted as `status: "info"` (visible in the report) rather than `"fail"`
 * (which blocks CI). Applies to A1/A2/A3/T3.
 *
 * Rationale: pre-existing repo-wide debt from tranches that predate the
 * cutoff can't be retro-fixed, so a hard gate on those findings would make
 * every new PR un-mergeable.
 */
export const COHERENCE_ENFORCED_FROM = '2026-07-01'

/** True when `isoDate` is an ISO string whose date portion is strictly before `COHERENCE_ENFORCED_FROM`. */
export function isGrandfathered(isoDate: string | null | undefined): boolean {
  if (!isoDate) return false
  return isoDate.slice(0, 10) < COHERENCE_ENFORCED_FROM
}

/**
 * R1 grandfather — explicit, data-declared Issue numbers whose body predates
 * the rationale grammar (or predates R1 enforcement) and is therefore
 * exempted from blocking. Unlike A1/A2/A3/T3's date-based cutoff, an Issue
 * body carries no reliable "authored under which grammar" timestamp, so this
 * is an explicit number set rather than a date proxy — populated once, at
 * `aeg-governance-hardening` task 1 implementation time, with exactly the
 * active-tranche task Issues that failed `checkIssueRationale` against the
 * live forge (see the task's PR body for the list + counts).
 *
 * New/edited task Issues are already gated at ring 0 (`bin/open-issue.ts`,
 *) — this list is visible debt for the pre-gate stock, not a standing
 * exemption mechanism. Do not add to it going forward; fix the Issue body
 * instead (the planner-brief rationale contract).
 */
export const R1_GRANDFATHERED_ISSUES: ReadonlySet<number> = new Set([279, 280, 281, 282])

// ---------- types -------------------------------------------------------------

/**
 * Every distinct coherence-failure shape this module's checks can produce,
 * named apart from `CheckFailure.reason`'s human string (Issue #355) — the
 * recovery-prompt switch in `check-coherence.ts` matches on THIS, never on
 * parsing `reason`'s text or `CheckResult.check`'s code alone. Closed
 * deliberately, and split finer than the `check` code where one check code
 * hides two failures needing opposite advice: `checkD1` produces both
 * `d1-self-dependency` (unsatisfiable by construction, escalate) and
 * `dispatched-on-unmet-deps` (an ordinary unmet dependency, close it) under
 * the same `D1` check code — keying recovery on `check` alone told an agent
 * to close an uncloseable dependency (the live incident this task fixes).
 * Adding a member here without a matching `case` in the consumer's switch
 * fails typecheck via that switch's exhaustiveness check.
 */
export type CoherenceFailureCode =
  | 'closed-without-merge'
  | 'archived-without-provenance'
  | 'auto-close-misfire'
  | 'phantom-issue-ref'
  | 'orphan-task'
  | 'tbd-in-active-tranche'
  | 'd1-self-dependency'
  | 'dispatched-on-unmet-deps'
  | 'missing-rationale-field'
  | 'surface-excludes-bound-doc'
  | 'surface-overlap'
  | 'archive-recommended'
  | 'premature-archive'
  | 'milestone-drift'
  | 'tranche-not-archived'
  | 'doc-owners-dangling-pointer'
  | 'doc-owners-duplicate-glob'
  | 'forge-read-unavailable'

export type CheckFailure = {
  /** The failure's machine-readable class, beside `reason`'s human string. */
  code: CoherenceFailureCode
  issue?: number | null
  tranche: string
  task?: string
  reason: string
  /** True when the terminal event predates `COHERENCE_ENFORCED_FROM` — finding is info, not fail. */
  grandfathered?: boolean
}

export type CheckResult = {
  check: string
  status: 'pass' | 'fail' | 'info'
  failures: CheckFailure[]
  note?: string
}

export type TaskEntry = {
  trancheSlug: string
  archived: boolean
  task: Task
  /** `undefined` when the forge was unavailable or the issue didn't exist. */
  facts: ForgeFacts | undefined
}

export type TrancheFile = {
  slug: string
  archived: boolean
  tranche: Tranche
}

// ---------- pure check evaluators --------------------------------------------

/**
 * A1: Every closed task-Issue has a merged closing PR — OR was hand-closed
 * directly by a recognized Principal (task `vinaya-engine-v1` 21, #99): a
 * second, narrower "done" path for a dependency Issue whose technical
 * premise dissolved, closed with a stated `COMPLETED` reason rather than via
 * a merge. Every condition is a real forge fact (who performed the
 * CLOSED_EVENT, GitHub's own close reason), never a prose claim in a
 * comment — the trap this task exists to avoid is "any closed Issue with a
 * comment counts."
 * Fail class: `closed-without-merge`
 * Terminal event date: `issueClosedAt` — grandfathered when before `COHERENCE_ENFORCED_FROM`.
 *
 * Excludes `stateReason: 'not_planned'`: a task closed that way with no merged
 * PR is `dropped` — legitimately abandoned, never done, never `todo` — a valid
 * terminal state, not a coherence failure. `stateReason: 'completed'` (or
 * `null`) with no merged PR and no recognized hand-close stays flagged: that
 * is done-but-unprovable, or a broken close, exactly the class this check
 * exists to catch.
 */
export function checkA1(entries: TaskEntry[], principalAllowlist: string[] = PRINCIPAL_ALLOWLIST): CheckResult {
  const failures: CheckFailure[] = []
  for (const e of entries) {
    if (!e.facts) continue
    if (e.facts.stateReason === 'not_planned') continue
    if (e.facts.issueState === 'closed' && e.facts.prState !== 'merged') {
      const handClosed = e.facts.stateReason === 'completed' && isPrincipal(e.facts.closedByActor, principalAllowlist)
      if (handClosed) continue
      failures.push({
        code: 'closed-without-merge',
        issue: e.task.issue,
        tranche: e.trancheSlug,
        task: e.task.id,
        reason: `Issue closed but closing PR is not merged (prState: ${e.facts.prState})`,
        grandfathered: isGrandfathered(e.facts.closedAt)
      })
    }
  }
  const activeFails = failures.filter((f) => !f.grandfathered)
  const status = activeFails.length > 0 ? 'fail' : failures.length > 0 ? 'info' : 'pass'
  return {
    check: 'A1',
    status,
    failures,
    note: status === 'info' ? `${failures.length} grandfathered (pre-${COHERENCE_ENFORCED_FROM})` : undefined
  }
}

/**
 * A2: The closing PR of each closed task-Issue carries an Archivist provenance block.
 * Fail class: `archived-without-provenance`
 * Terminal event date: `prMergedAt` — grandfathered when before `COHERENCE_ENFORCED_FROM`.
 *
 * `hasProvenanceByKey`: Map keyed by `${trancheSlug}/${taskId}` → true when the
 * closing PR has a comment containing `### AEG provenance`.
 */
export function checkA2(entries: TaskEntry[], hasProvenanceByKey: Map<string, boolean>): CheckResult {
  const failures: CheckFailure[] = []
  for (const e of entries) {
    if (!e.facts) continue
    // Only check tasks whose issue is closed AND whose closing PR merged.
    if (e.facts.issueState !== 'closed' || e.facts.prState !== 'merged') continue
    const key = `${e.trancheSlug}/${e.task.id}`
    const hasProvenance = hasProvenanceByKey.get(key)
    // If key is absent from the map we were unable to fetch (forge error); skip.
    if (hasProvenance === undefined) continue
    if (!hasProvenance) {
      failures.push({
        code: 'archived-without-provenance',
        issue: e.task.issue,
        tranche: e.trancheSlug,
        task: e.task.id,
        reason: 'Closing PR has no `### AEG provenance` comment (Archivist close-out missing)',
        grandfathered: isGrandfathered(e.facts.mergedAt)
      })
    }
  }
  const activeFails = failures.filter((f) => !f.grandfathered)
  const status = activeFails.length > 0 ? 'fail' : failures.length > 0 ? 'info' : 'pass'
  return {
    check: 'A2',
    status,
    failures,
    note: status === 'info' ? `${failures.length} grandfathered (pre-${COHERENCE_ENFORCED_FROM})` : undefined
  }
}

/**
 * A3: Every Issue whose closing PR merged is itself closed.
 * Fail class: `auto-close-misfire` — the headline check (#174 class).
 * Terminal event date: `prMergedAt` — grandfathered when before `COHERENCE_ENFORCED_FROM`.
 */
export function checkA3(entries: TaskEntry[]): CheckResult {
  const failures: CheckFailure[] = []
  for (const e of entries) {
    if (!e.facts) continue
    if (e.facts.prState === 'merged' && e.facts.issueState !== 'closed') {
      failures.push({
        code: 'auto-close-misfire',
        issue: e.task.issue,
        tranche: e.trancheSlug,
        task: e.task.id,
        reason: 'Closing PR is merged but Issue is still open (GitHub auto-close misfire)',
        grandfathered: isGrandfathered(e.facts.mergedAt)
      })
    }
  }
  const activeFails = failures.filter((f) => !f.grandfathered)
  const status = activeFails.length > 0 ? 'fail' : failures.length > 0 ? 'info' : 'pass'
  return {
    check: 'A3',
    status,
    failures,
    note: status === 'info' ? `${failures.length} grandfathered (pre-${COHERENCE_ENFORCED_FROM})` : undefined
  }
}

/**
 * T1: Every topology row's Issue ref resolves to a real Issue.
 * Fail class: `phantom-issue-ref`
 *
 * A task has a non-null issue number in the topology but is absent from the
 * forge facts map → the issue doesn't exist on GitHub.
 */
export function checkT1(entries: TaskEntry[]): CheckResult {
  const failures: CheckFailure[] = []
  for (const e of entries) {
    // Skip: issue was null in topology (TBD or empty); T3 handles that.
    if (e.task.issue === null) continue
    // facts === undefined and issue !== null → forge query returned nothing for this issue
    if (e.facts === undefined) {
      failures.push({
        code: 'phantom-issue-ref',
        issue: e.task.issue,
        tranche: e.trancheSlug,
        task: e.task.id,
        reason: `Issue #${e.task.issue} in topology does not resolve to a real GitHub Issue`
      })
    }
  }
  return { check: 'T1', status: failures.length > 0 ? 'fail' : 'pass', failures }
}

/**
 * T2: Every open Issue labeled `vinaya/tranche:X` appears in X's topology file.
 * Fail class: `orphan-task`
 *
 * `openIssuesBySlug`: Map from active tranche slug → list of open issue
 * numbers fetched from the forge with that `vinaya/tranche:` label.
 * `topologyIssuesBySlug`: Map from slug → Set of issue numbers in the topology.
 *
 * `ciTrancheSlug`: when set (parsed from `BRANCH`/`GITHUB_HEAD_REF` env),
 *   only the tranche matching that slug is checked — prevents a coherence
 *   gap in one tranche's topology (e.g. a Planner plan-PR mid-flight) from
 *   blocking CI on an unrelated PR against a different tranche. Mirrors
 *   `checkT3`'s `ciTrancheSlug` parameter exactly.
 */
export function checkT2(
  openIssuesBySlug: Map<string, number[]>,
  topologyIssuesBySlug: Map<string, Set<number>>,
  ciTrancheSlug?: string | null
): CheckResult {
  const failures: CheckFailure[] = []
  for (const [slug, openNums] of openIssuesBySlug) {
    if (ciTrancheSlug && slug !== ciTrancheSlug) continue

    const topologySet = topologyIssuesBySlug.get(slug) ?? new Set<number>()
    for (const num of openNums) {
      if (!topologySet.has(num)) {
        failures.push({
          code: 'orphan-task',
          issue: num,
          tranche: slug,
          reason: `Issue #${num} is open and labeled ${trancheLabel(slug)} but does not appear in the topology file`
        })
      }
    }
  }
  return { check: 'T2', status: failures.length > 0 ? 'fail' : 'pass', failures }
}

/**
 * T2 point-of-power relocation (aeg-governance-hardening task 24, #364,
 * Part 2; supersedes half of task 19's T2-in-task-PR-CI placement).
 * A gate may only red a PR that could cause or cure the violation it
 * reports — live incident #363 (2026-07-04): registering Issues #364/#365
 * correctly reddened same-tranche task PR #363's CI, which could neither
 * have caused nor fixed the topology gap. `checkT2`'s own assertion logic
 * (above) is untouched; this only demotes its CI-blocking status when the
 * current PR is NOT a plan PR (i.e. its diff doesn't touch a tranche
 * topology file) — the only PR kind that can actually close a T2 gap. The
 * underlying findings stay visible (`status: 'info'`, never omitted) for
 * every other context: task-PR CI, `--json`/audit mode, and daily-drift.
 */
export function scopeT2ToPlanPr(result: CheckResult, isPlanPr: boolean): CheckResult {
  if (isPlanPr || result.status !== 'fail') return result
  return {
    ...result,
    status: 'info',
    note:
      result.note ??
      'T2 findings are non-blocking outside plan PRs (point-of-power principle) — see aeg-root/enforcement.md.'
  }
}

/**
 * T3: No `#TBD` rows in an active tranche.
 * Fail class: `tbd-in-active-tranche`
 *
 * A task in an active tranche has a null issue ref (empty / `—` / `#TBD`).
 *
 * `ciTrancheSlug`: when set (parsed from `BRANCH`/`GITHUB_HEAD_REF` env),
 *   only tasks in THAT tranche are checked — prevents legacy `#TBD` rows in
 *   an unrelated tranche from blocking this PR.
 *
 * `enrichedEntries`: when provided (post-forge-fetch), used to determine if a
 *   tranche predates `COHERENCE_ENFORCED_FROM` by proxy: if the tranche has
 *   any task whose `closedAt` or `mergedAt` is pre-cutoff, its #TBD rows are
 *   grandfathered as `info`.
 *
 * `forgeUnavailableSlugs`: tranche slugs whose forge snapshot fetch failed
 *   entirely (the caller couldn't fetch `closedAt`/`mergedAt` for ANY task in
 *   that tranche). A `#TBD` row in one of these tranches cannot be evaluated
 *   against the grandfather proxy at all — treating it as `grandfathered: false`
 *   would silently fail it purely because of a forge outage, not because it's
 *   genuinely un-grandfathered. Such rows are reported `grandfathered: true`
 *   with a distinct reason so they never produce a `fail`, but remain visible.
 */
export function checkT3(
  entries: TaskEntry[],
  ciTrancheSlug?: string | null,
  enrichedEntries?: TaskEntry[],
  forgeUnavailableSlugs?: Set<string>
): CheckResult {
  // Build set of tranches that are pre-enforcement (by proxy: any task with a pre-cutoff date).
  const preEnforcement = new Set<string>()
  if (enrichedEntries) {
    for (const e of enrichedEntries) {
      if (isGrandfathered(e.facts?.closedAt) || isGrandfathered(e.facts?.mergedAt)) {
        preEnforcement.add(e.trancheSlug)
      }
    }
  }

  const failures: CheckFailure[] = []
  for (const e of entries) {
    if (!e.archived && e.task.issue === null) {
      // Branch-scope: in CI for a specific tranche, only check that tranche.
      if (ciTrancheSlug && e.trancheSlug !== ciTrancheSlug) continue

      if (forgeUnavailableSlugs?.has(e.trancheSlug)) {
        failures.push({
          code: 'tbd-in-active-tranche',
          issue: null,
          tranche: e.trancheSlug,
          task: e.task.id,
          reason: `Task ${e.task.id} in active tranche has no Issue ref (#TBD or empty), but forge data for tranche "${e.trancheSlug}" was unavailable — cannot evaluate grandfather status, not silently failed`,
          grandfathered: true
        })
        continue
      }

      failures.push({
        code: 'tbd-in-active-tranche',
        issue: null,
        tranche: e.trancheSlug,
        task: e.task.id,
        reason: `Task ${e.task.id} in active tranche has no Issue ref (#TBD or empty) — the model requires all active tasks to have Issue numbers`,
        grandfathered: preEnforcement.has(e.trancheSlug)
      })
    }
  }
  const activeFails = failures.filter((f) => !f.grandfathered)
  const status = activeFails.length > 0 ? 'fail' : failures.length > 0 ? 'info' : 'pass'
  return {
    check: 'T3',
    status,
    failures,
    note: status === 'info' ? `${failures.length} grandfathered (pre-${COHERENCE_ENFORCED_FROM})` : undefined
  }
}

/**
 * D1: A task with an open PR has all `depends-on` Issues closed.
 * Fail class: `dispatched-on-unmet-deps`
 *
 * `issueToEntry`: Map from issue number → TaskEntry, for resolving `#NNN`
 * style depends-on refs in addition to task-ID style refs.
 * `taskToEntry`: Map from `${slug}/${taskId}` → TaskEntry for same-tranche refs.
 */
export function checkD1(
  entries: TaskEntry[],
  issueToEntry: Map<number, TaskEntry>,
  taskToEntry: Map<string, TaskEntry>
): CheckResult {
  const failures: CheckFailure[] = []
  for (const e of entries) {
    if (!e.facts) continue
    if (e.facts.prState !== 'open') continue

    for (const dep of e.task.dependsOn) {
      const depEntry = resolveDepEntry(dep, e.trancheSlug, issueToEntry, taskToEntry)
      if (!depEntry) continue // unknown dep — not a D1 concern

      // A self-dependency is unsatisfiable by construction, so it is never a
      // real D1 state — it is proof of a parser defect upstream. Reported as
      // an INTERNAL error rather than as "is not closed", which reads as a
      // legitimate unmet dependency and invites routing around the gate.
      // Mirrors `isSelfDependency` in `dispatch-gate.ts`; deliberately a
      // second small local predicate rather than a shared export, since the
      // two modules match on different fact shapes.
      const sameTask = depEntry.trancheSlug === e.trancheSlug && depEntry.task.id === e.task.id
      const sameIssue = depEntry.task.issue !== null && e.task.issue !== null && depEntry.task.issue === e.task.issue
      if (sameTask || sameIssue) {
        failures.push({
          code: 'd1-self-dependency',
          issue: e.task.issue,
          tranche: e.trancheSlug,
          task: e.task.id,
          reason: `INTERNAL: parsed a self-dependency (depends-on ${dep}) — this is a parser bug in parseRationaleDeps, not a real dependency. Please report it upstream.`
        })
        continue
      }

      const depFacts = depEntry.facts
      const depClosed = depFacts?.issueState === 'closed'
      if (!depClosed) {
        failures.push({
          code: 'dispatched-on-unmet-deps',
          issue: e.task.issue,
          tranche: e.trancheSlug,
          task: e.task.id,
          reason: `Task has open PR but depends-on ${dep} (issue #${depEntry.task.issue ?? '?'}) is not closed`
        })
      }
    }
  }
  return { check: 'D1', status: failures.length > 0 ? 'fail' : 'pass', failures }
}

function resolveDepEntry(
  dep: string,
  trancheSlug: string,
  issueToEntry: Map<number, TaskEntry>,
  taskToEntry: Map<string, TaskEntry>
): TaskEntry | undefined {
  // `#NNN` style — resolve by issue number
  const issueMatch = dep.match(/^#(\d+)$/)
  if (issueMatch?.[1]) return issueToEntry.get(Number(issueMatch[1]))
  // Task-ID style — resolve within same tranche first, then globally
  return taskToEntry.get(`${trancheSlug}/${dep}`) ?? taskToEntry.get(dep)
}

/**
 * `ForgeIssue` lives in `@attalabs/aeg-types` (aeg-core-purity fix, #521) —
 * re-exported here since every existing call site imports it from
 * `@attalabs/aeg-core`.
 */
export type { ForgeIssue }

/**
 * R1: Every active-tranche task Issue's body carries the full eight-field
 * Planner's rationale (`aeg-root/contracts/planner-brief.md`), and every
 * project its `Project:` field names has a `.vinaya/projects.md` row.
 * Fail class: `missing-rationale-field`
 *
 * Presence-only — delegates entirely to `checkIssueRationale` and
 * `checkProjectsRegistered` (the same evaluators `bin/open-issue.ts` enforces
 * at ring 0 on new/edited Issues). This is the ring-1/2 half: continuous
 * re-checking of the stock, which is what catches an Issue edited by an
 * ungated writer (the GitHub web UI, a raw API call) or one that predates the
 * gate. One grammar, one parser — this function re-implements neither.
 *
 * `issuesBySlug`: open Issues per active tranche slug, from the same
 * batched label-scoped query T2 uses (`fetchOpenIssuesByLabel`), extended to
 * carry `body` + `labels`.
 * `grandfatheredIssues`: `R1_GRANDFATHERED_ISSUES` — pre- stock,
 * reported as `info`, never `fail`.
 * `registeredNames`: the registry's project names, read by the caller
 * (aeg-core is pure). Defaults to `[]`, which leaves the registry half
 * dormant — so a caller that has no registry to hand keeps R1's prior
 * behaviour exactly.
 */
export function checkR1(
  issuesBySlug: Map<string, ForgeIssue[]>,
  grandfatheredIssues: ReadonlySet<number>,
  registeredNames: string[] = []
): CheckResult {
  const failures: CheckFailure[] = []
  for (const [slug, issues] of issuesBySlug) {
    for (const issue of issues) {
      if (!isTaskIssueLabelSet(issue.labels)) continue
      const errors = [
        ...checkIssueRationale(issue.body).errors,
        ...checkProjectsRegistered(issue.body, issue.labels, registeredNames).errors,
        ...checkIssueObjectives(issue.body, issue.number).errors,
        // task 17, O2 — Parts coverage joins the sweep here: same
        // dormant-when-absent posture as the other two, zero new inputs.
        ...checkPartsCiteDefinedObjectives(issue.body).errors
      ]
      if (errors.length === 0) continue
      failures.push({
        code: 'missing-rationale-field',
        issue: issue.number,
        tranche: slug,
        reason: `Issue #${issue.number} fails the rationale gate: ${errors.join(' | ')}`,
        grandfathered: grandfatheredIssues.has(issue.number)
      })
    }
  }
  const activeFails = failures.filter((f) => !f.grandfathered)
  const status = activeFails.length > 0 ? 'fail' : failures.length > 0 ? 'info' : 'pass'
  return {
    check: 'R1',
    status,
    failures,
    note:
      status === 'info'
        ? `${failures.length} grandfathered task Issue(s) predate this check's grammar (rationale fields and/or the project registry)`
        : undefined
  }
}

/**
 * R2: The same `checkSurfaceExcludesBoundDoc` predicate (O1/task-run-v1 9),
 * run over every open task Issue in an active tranche. This is O2's own
 * obligation: a task Issue whose `## Surface` `out:` list excludes a
 * `.vinaya/doc-owners`-bound document its `in:` list otherwise covers must be
 * reported, not silently left to fail at the Developer's first commit — the
 * ring-0 gate in `forge-write.ts` catches this at create/edit time going
 * forward, but an Issue written before this gate shipped, or edited outside
 * the validated path, needs the ring-1/2 half the way R1 does.
 * Fail class: `surface-excludes-bound-doc`
 *
 * `docOwnersContent`: the caller's own tree read of `.vinaya/doc-owners` — a
 * repo with no manifest, or one with no binding, leaves this dormant for
 * every Issue (the predicate itself already returns `pass` in both cases).
 * One grammar, one parser, same discipline as R1: this function never
 * re-implements `checkSurfaceExcludesBoundDoc`'s matching.
 */
export function checkR2(issuesBySlug: Map<string, ForgeIssue[]>, docOwnersContent: string | null): CheckResult {
  const failures: CheckFailure[] = []
  for (const [slug, issues] of issuesBySlug) {
    for (const issue of issues) {
      if (!isTaskIssueLabelSet(issue.labels)) continue
      const errors = checkSurfaceExcludesBoundDoc(issue.body, docOwnersContent).errors
      if (errors.length === 0) continue
      failures.push({
        code: 'surface-excludes-bound-doc',
        issue: issue.number,
        tranche: slug,
        reason: `Issue #${issue.number} fails the surface/doc-owners gate: ${errors.join(' | ')}`
      })
    }
  }
  return { check: 'R2', status: failures.length > 0 ? 'fail' : 'pass', failures }
}

/**
 * R3: The same `checkSurfaceOverlap` predicate (O5, task-run-v1 task 11) run
 * pairwise over every open task Issue sharing a Milestone — the coherence
 * half of O5's own obligation ("the same predicate runs in the coherence
 * check over open task Issues"). The write-time gate
 * (`apps/cli/src/lib/forge-write.ts`) only ever compares the ONE Issue being
 * created/edited against its siblings at that moment; this is the sweep that
 * re-checks the whole open set afterward — a sibling's Surface widened
 * later, or an Issue edited outside the validated path, still surfaces here.
 *
 * Takes the RAW `GhIssue` list (not the derived `ForgeIssue`/`Tranche`
 * shapes R1/R2 consume) because only the raw shape carries the GitHub-native
 * `milestone` field — see this module's own header note on why the raw
 * per-slug Issue lists are threaded through the sweep for exactly this
 * reason. An Issue with no Milestone, or whose `## Surface` doesn't parse,
 * is excluded from every group: O5 only binds tasks that share a real
 * Milestone, and a Surface this function cannot read is `checkIssueBriefSections`'s
 * finding to report, not this one's.
 *
 * Fail class: `surface-overlap`
 */
export function checkR3(issuesBySlug: Map<string, GhIssue[]>): CheckResult {
  type Entry = { slug: string; issue: GhIssue; facts: TaskSurfaceFacts }
  const byMilestone = new Map<string, Entry[]>()

  for (const [slug, issues] of issuesBySlug) {
    for (const issue of issues) {
      if (issue.state !== 'OPEN') continue
      const milestoneTitle = issue.milestone?.title
      if (!milestoneTitle) continue
      const labels = issue.labels.map((l) => l.name)
      if (!isTaskIssueLabelSet(labels)) continue
      const body = issue.body ?? ''
      const surface = parseIssueSurface(body)
      if (!surface.ok) continue

      const facts: TaskSurfaceFacts = {
        ref: String(issue.number),
        surfaceIn: surface.value.in,
        conflictsWith: parseRationaleDeps(body).conflictsWith
      }
      const group = byMilestone.get(milestoneTitle) ?? []
      group.push({ slug, issue, facts })
      byMilestone.set(milestoneTitle, group)
    }
  }

  const failures: CheckFailure[] = []
  for (const group of byMilestone.values()) {
    if (group.length < 2) continue
    for (const entry of group) {
      const siblings = group.filter((g) => g.facts.ref !== entry.facts.ref).map((g) => g.facts)
      const errors = checkSurfaceOverlap(entry.facts, siblings).errors
      if (errors.length === 0) continue
      failures.push({
        code: 'surface-overlap',
        issue: entry.issue.number,
        tranche: entry.slug,
        reason: `Issue #${entry.issue.number} fails the cross-task surface-overlap gate: ${errors.join(' | ')}`
      })
    }
  }
  return { check: 'R3', status: failures.length > 0 ? 'fail' : 'pass', failures }
}

/**
 * L1: Active tranche with zero open task-Issues → should be archived.
 * **Advisory (info-only)** per `state-machine.md` §12 (L1/L2 are lifecycle-hygiene
 * signals, not the done-lifecycle gate). Findings are surfaced for a human to
 * investigate; they never fail CI. Only A1/A2/A3/M1/M3/L5 block (L5 promoted, vinaya-milestone-model-v1 task 1).
 *
 * An active tranche (file not in completed/) where every task with a
 * known issue has `issueState === 'closed'`.
 */
export function checkL1(files: TrancheFile[], entriesBySlug: Map<string, TaskEntry[]>): CheckResult {
  const failures: CheckFailure[] = []
  for (const f of files) {
    if (f.archived) continue
    const entries = entriesBySlug.get(f.slug) ?? []
    const withFacts = entries.filter((e) => e.facts !== undefined)
    if (withFacts.length === 0) continue // forge unavailable or no tasks with issues
    const allClosed = withFacts.every((e) => e.facts?.issueState === 'closed')
    if (allClosed) {
      failures.push({
        code: 'archive-recommended',
        tranche: f.slug,
        reason: 'Active tranche has no open task-Issues — consider archiving to completed/'
      })
    }
  }
  return {
    check: 'L1',
    status: 'info',
    failures,
    note:
      failures.length > 0
        ? `${failures.length} active tranche(s) with no open task-Issues — consider archiving (advisory)`
        : undefined
  }
}

/**
 * L2: Archived tranche with any open task-Issue → premature archive.
 * **Advisory (info-only)** per `state-machine.md` §12 (L1/L2 are lifecycle-hygiene
 * signals, not the done-lifecycle gate). Findings are surfaced for a human to
 * investigate; they never fail CI. Only A1/A2/A3/M1/M3/L5 block (L5 promoted, vinaya-milestone-model-v1 task 1).
 */
export function checkL2(files: TrancheFile[], entriesBySlug: Map<string, TaskEntry[]>): CheckResult {
  const failures: CheckFailure[] = []
  for (const f of files) {
    if (!f.archived) continue
    const entries = entriesBySlug.get(f.slug) ?? []
    for (const e of entries) {
      if (!e.facts) continue
      if (e.facts.issueState === 'open') {
        failures.push({
          code: 'premature-archive',
          issue: e.task.issue,
          tranche: f.slug,
          task: e.task.id,
          reason: `Archived tranche has open task-Issue #${e.task.issue ?? '?'} (premature archive)`
        })
      }
    }
  }
  return {
    check: 'L2',
    status: 'info',
    failures,
    note:
      failures.length > 0
        ? `${failures.length} archived tranche(s) with an open task-Issue — investigate (advisory)`
        : undefined
  }
}

/**
 * L3: Count of active tranches — informational only, does not affect exit code.
 */
export function checkL3(files: TrancheFile[]): CheckResult {
  const active = files.filter((f) => !f.archived)
  return {
    check: 'L3',
    status: 'info',
    failures: [],
    note: `${active.length} active tranche(s): ${active.map((f) => f.slug).join(', ') || '(none)'}`
  }
}

/**
 * L4: Issue-level Milestone-attachment drift (aeg-review-gate-v1 task 1
 * follow-up). An open task-Issue carrying `vinaya/tranche:<slug>` for an ACTIVE
 * tranche (open Milestone titled the slug) whose GitHub-native
 * `milestone` field doesn't match that same Milestone.
 *
 * **Scope changed (vinaya-milestone-model-v1 task 1): the exact-title-match
 * invariant this check evaluates is only meaningful for LEGACY tranches** —
 * a Milestone titled exactly the tranche slug, the 1:1 regime that predates
 * the label model. Once one Milestone can legitimately hold several
 * tranches, an Issue attached to a shared Milestone will never have a
 * `milestone.title` equal to any one of the several slugs it might carry,
 * so flagging that as drift would be noise on every label-only tranche. The
 * restriction to legacy slugs is applied by the CALLER
 * (`verify-coherence.ts`, via `TrancheMilestoneIndex.legacySlugs`) — this
 * function's own logic is unchanged and still trusts whatever
 * `activeTrancheSlugs` it is handed.
 *
 * **Advisory (info-only)**, same framing as L1/L2 (`state-machine.md` §12):
 * confirmed NOT functionally load-bearing — `deriveTrancheFromForge`/
 * `listActiveTrancheSlugs` never read an Issue's milestone field, only the
 * `vinaya/tranche:<slug>` label, which remains the sole, sufficient membership
 * signal. This is real drift between GitHub's own Milestone view (e.g.
 * `open_issues`/`closed_issues` counts) and reality — cosmetic, not a gate,
 * surfaced so it doesn't silently accumulate rather than because anything
 * downstream currently breaks. `open-issue.ts` prevents new drift at
 * creation time (ring 0); this is the ring-1/2 detection half for whatever
 * predates that gate or was created outside it.
 */
export function checkL4(
  activeTrancheSlugs: string[],
  issueMilestones: Array<{ tranche: string; issue: number; milestoneTitle: string | null }>
): CheckResult {
  const activeSet = new Set(activeTrancheSlugs)
  const failures: CheckFailure[] = []
  for (const f of issueMilestones) {
    if (!activeSet.has(f.tranche)) continue
    if (f.milestoneTitle === f.tranche) continue
    failures.push({
      code: 'milestone-drift',
      issue: f.issue,
      tranche: f.tranche,
      reason:
        f.milestoneTitle === null
          ? `Issue #${f.issue} carries ${trancheLabel(f.tranche)} (active) but has no GitHub-native milestone attached`
          : `Issue #${f.issue} carries ${trancheLabel(f.tranche)} (active) but is attached to Milestone "${f.milestoneTitle}" instead`
    })
  }
  return {
    check: 'L4',
    status: 'info',
    failures,
    note:
      failures.length > 0
        ? `${failures.length} open task-Issue(s) in an active tranche whose GitHub-native milestone doesn't match their ${label('tranche')}<slug> label (cosmetic drift, advisory)`
        : undefined
  }
}

/**
 * L5: an active tranche whose every task Issue is closed → the tranche is
 * effectively complete but was never archived (Issue #481, drift class #2;
 * 1 live incident this session — `aeg-forge-state-v1`'s Milestone left open
 * after full archive).
 *
 * This is the FORGE-NATIVE analogue of file-based L1: L1 reads `TrancheFile[]`
 * (a `!f.archived` file location), but post-cutover most tranches have no
 * topology file at all, so their Milestone-object drift is invisible to L1.
 * L5 keys off `activeTrancheSlugs` (the derived-active population — the
 * authority) instead, so it sees exactly the tranches L1 no longer can.
 *
 * **Promoted from advisory to authoritative (vinaya-milestone-model-v1 task
 * 1): `status` is now `'fail'`, joining A1/A2/A3/M1/M3 as CI-blocking.**
 * Before this task, "the tranche is complete" meant "its Milestone is
 * closed" — a fact a Milestone shared by several tranches can no longer
 * carry reliably (closing it would close every tranche it holds, not just
 * the one that finished). This check's underlying signal was ALREADY the
 * correct one even before this task — per-task-Issue state from
 * `entriesBySlug`, never the Milestone's own open/closed field — so
 * promoting it is a severity change, not a logic change: the signal is now
 * trustworthy enough to be the completeness answer other consumers should
 * defer to, rather than a maybe-stale hint. Applies uniformly to legacy and
 * label-only tranches alike; unlike L4, no legacy restriction is needed here,
 * since Issue state (not Milestone attachment) is what this check reads.
 *
 * Slugs whose facts are unavailable (forge outage) are skipped, mirroring
 * L1's `withFacts.length === 0` guard — an outage is not a finding.
 */
export function checkL5(activeTrancheSlugs: string[], entriesBySlug: Map<string, TaskEntry[]>): CheckResult {
  const failures: CheckFailure[] = []
  for (const slug of activeTrancheSlugs) {
    const entries = entriesBySlug.get(slug) ?? []
    const withFacts = entries.filter((e) => e.facts !== undefined)
    if (withFacts.length === 0) continue // forge unavailable or no tasks with issues
    const allClosed = withFacts.every((e) => e.facts?.issueState === 'closed')
    if (allClosed) {
      failures.push({
        code: 'tranche-not-archived',
        tranche: slug,
        reason: 'Every task Issue is closed but the tranche is not recorded as complete — archive it'
      })
    }
  }
  return {
    check: 'L5',
    status: failures.length > 0 ? 'fail' : 'pass',
    failures,
    note:
      failures.length > 0
        ? `${failures.length} tranche(s) whose task Issues are all closed but were never archived`
        : undefined
  }
}

/** Extracts the set of Issue numbers a PR body's `Closes #N` (and Fixes/
 * Resolves synonyms) references. Shared by `checkClosesNTopology`'s forward and
 * reverse directions, and by the CI wiring script that must resolve each
 * referenced Issue's task identity *before* calling `checkClosesNTopology` — one
 * grammar, not a second copy of the pattern (discipline). Honors the
 * AEG:CLOSES anchor pair (`anchored-region.ts`, task 30) when present: only
 * references inside the pair count, so a Closes-shaped line in a pasted
 * reference brief elsewhere in the PR body isn't picked up. The searched region
 * is additionally `stripCode`d before matching, for parity with GitHub's
 * auto-close parser (which ignores `Closes #N` inside code) — a backticked-only
 * reference resolves to no Issue here exactly as it does on merge, so this
 * repo-wide check and the pre-merge `checkClosesNTopology` agree with GitHub.
 *
 * The separator groups are bounded (`\s{0,8}`) for the same reason, and to the
 * same width, as `checkClosesNTopology`'s — see the ReDoS note there. The two patterns
 * must stay byte-identical apart from the capture group; a divergence here is
 * a gate-disagreement bug, not a style difference. */
export function extractClosesReferences(prBody: string): Set<number> {
  const closesPattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s{0,8}:?\s{0,8}#(\d+)/gi
  // Strip the WHOLE body, then slice the anchor region out of the stripped
  // text — never strip a sliced region. A region has lost the block context
  // the strip's rules read (list vs indented-code, fence pairing), so an
  // anchor indented inside a list item was blanked as if it were code, and
  // this parser silently disagreed with the whole-body path in the same call
  // (PR #617 review MAJOR). See `archive-task.ts`'s `extractIssue`.
  const stripped = stripCode(prBody)
  const searchIn = anchoredRegion(stripped, 'CLOSES') ?? stripped
  const referenced = new Set<number>()
  for (const hit of searchIn.matchAll(closesPattern)) {
    referenced.add(Number(hit[1]))
  }
  return referenced
}

/**
 * Closes #N gate — Layer 1 of forge-lifecycle enforcement.
 *
 * Forward direction: a task PR (branch `task/<tranche>/<n>`) must carry
 * `Closes #<its-issue>` in the body. Non-task branches are silently
 * bypassed for this direction (returns ok:true).
 *
 * Reverse direction (added: a branch NOT named `task/<tranche>/<n>` that
 * nonetheless closes a real AEG task Issue must be named after that task —
 * the gap that let `feat/vinaya-landing-v3` implement Issue #509 with zero
 * forge-visible status. Runs for ANY branch, gated on `taskIssueRefs` being
 * supplied: each `Closes #N` the body references is looked up in the map;
 * an entry resolving to a task's `{trancheSlug, taskId}` requires
 * `branch === "task/<trancheSlug>/<taskId>"`. A missing map entry (issue not
 * resolved, e.g. no forge token) or an ordinary non-task Issue (`null` in
 * the map) skips the check for that reference — this direction only ever
 * *adds* a failure, never silently passes something the forward direction
 * would have caught.
 *
 * Pure function; reads from injected parameters. The CLI entry-point wires
 * in BRANCH + PR_BODY env vars (forward) and a batched forge lookup
 * (reverse, see `@attalabs/aeg-forge-state`'s `fetchTaskIssueRefs`).
 */
export function checkClosesNTopology(
  branch: string,
  prBody: string,
  trancheFiles: TrancheFile[],
  taskIssueRefs?: Map<number, TaskIssueRef | null>
): { ok: boolean; message?: string; expectedIssue?: number } {
  const referenced = extractClosesReferences(prBody)

  if (taskIssueRefs) {
    for (const n of referenced) {
      const ref = taskIssueRefs.get(n)
      if (!ref) continue
      const expectedBranch = `task/${ref.trancheSlug}/${ref.taskId}`
      if (branch !== expectedBranch) {
        return {
          ok: false,
          message: `closes-n-reverse: branch "${branch}" closes #${n} (task ${ref.taskId} of tranche "${ref.trancheSlug}") but is not named "${expectedBranch}" — rename the branch and re-push, or if this work is intentionally outside AEG's dispatch flow, remove the Closes reference.`
        }
      }
    }
  }

  const ref = parseTaskBranchIdentity(branch)
  if (!ref) return { ok: true } // non-task branch — forward direction bypass

  // task-run-v1 task 15, O2: a backlog Issue's task IS its Issue — the
  // expected `Closes #N` is the branch's own issue number, no topology
  // lookup needed at all.
  if (ref.kind === 'issue') {
    const expectedIssue = ref.issueNumber
    if (!referenced.has(expectedIssue)) {
      return {
        ok: false,
        expectedIssue,
        message: `closes-n: PR body does not contain \`Closes #${expectedIssue}\` (required for branch "${branch}"). Add it to the PR body Summary section.`
      }
    }
    return { ok: true, expectedIssue }
  }

  const trancheSlug = ref.tranche
  const taskId = ref.taskId

  const trancheFile = trancheFiles.find((f) => f.slug === trancheSlug)
  if (!trancheFile) {
    return {
      ok: false,
      message: `closes-n: branch "${branch}" references tranche "${trancheSlug}" but no topology file found at aeg-root/tranches/${trancheSlug}.md. Ensure the tranche file exists before opening the PR.`
    }
  }

  const task = trancheFile.tranche.tasks.find((t) => t.id === taskId)
  if (!task) {
    return {
      ok: false,
      message: `closes-n: branch "${branch}" references task "${taskId}" not found in ${trancheSlug} topology. Verify the task ID matches the tranche file.`
    }
  }

  if (task.issue === null) {
    return {
      ok: false,
      message: `closes-n: task "${taskId}" in "${trancheSlug}" has no Issue number (#TBD). The Planner must cut the Issue before this PR can be validated.`
    }
  }

  const expectedIssue = task.issue
  if (!referenced.has(expectedIssue)) {
    return {
      ok: false,
      expectedIssue,
      message: `closes-n: PR body does not contain \`Closes #${expectedIssue}\` (required for task "${taskId}" in tranche "${trancheSlug}"). Add it to the PR body Summary section.`
    }
  }

  return { ok: true, expectedIssue }
}
