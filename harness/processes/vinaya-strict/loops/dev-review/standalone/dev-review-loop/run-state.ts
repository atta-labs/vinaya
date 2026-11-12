import type { LoopRunContext } from './run-context.js'
import { seedLoopHistory } from './driver-lifecycle.js'

import type { TaskClock } from '../../../../tools/dev-review-policy/types'
import { activeBudgetMs } from '../../../../tools/task-phase-history'
import { persistLoopState } from './round-assess.js'
import type { DeveloperHandoff } from './round-assess.js'
import { briefHash as briefHashOf } from '../../../../tools/task-contract/review-input-manifest'

import { policyDigest as policyDigestOf } from '../../../../tools/task-contract/review-input-manifest'

export function applyLoopHistory(c: LoopRunContext): void {
  const { d } = c

  // The forge markers on this task's own pull request — never a log
  // event or the telemetry outbox. `prNumber` is already the attached
  // PR's number by the one call site below.
  const seeded = seedLoopHistory({ fetchLoopHistory: d.fetchLoopHistory, prNumber: c.prNumber, state: c.state })
  c.loopHistory = seeded.loopHistory
  c.historyApplies = seeded.historyApplies
  c.state = seeded.state
}

/**
 * The task's own clock, as `assessRound` is handed it at every round
 * boundary and mechanical retry. `byPhaseMs` is the loop's recorded time
 * per phase, with the phase currently open folded in, so the phase the loop
 * is stuck in is visible in the breakdown rather than missing from it — the
 * full record, `pause` and `publish` phases included.
 *
 * `elapsedMs` is what the budget is measured against, and it counts ONLY
 * the active phases in that record (`activeBudgetMs`): the time a driver
 * spent developing, reviewing and awaiting confidence, never the hours the
 * task sat paused, published, or with no driver at all (which is not
 * recorded against any phase in the first place). It is a sum over the same
 * `byPhaseMs` that survives a driver restart, so — unlike the wall clock
 * since `taskStartedAt` this once measured — a task resumed days after its
 * first start is bounded by the minutes it has worked, not by its age.
 */
export function taskClock(c: LoopRunContext): TaskClock {
  const now = Date.now()
  const byPhaseMs = { ...c.phaseMs }
  if (c.currentPhase !== null) {
    byPhaseMs[c.currentPhase] = (byPhaseMs[c.currentPhase] ?? 0) + Math.max(0, now - c.currentPhaseSince)
  }
  return { elapsedMs: activeBudgetMs(byPhaseMs), byPhaseMs }
}

/** O1: writes the current in-memory round/budget/held-result/delivered-findings state to the control store — called at every meaningful transition below, never only at pause, so a kill mid-round has something fresher than "the last pause" to recover from. */
export function persistCurrentLoopState(c: LoopRunContext, phase: string, pauseReason?: string): void {
  const { task, publicationState } = c

  // Close the interval the previous phase held open before recording the
  // new one, so `phaseMs` accumulates real time per phase rather than one
  // total. A call naming the phase already current leaves the interval
  // open — time keeps accruing to it — since nothing changed.
  const now = Date.now()
  if (c.currentPhase !== null && c.currentPhase !== phase) {
    c.phaseMs[c.currentPhase] = (c.phaseMs[c.currentPhase] ?? 0) + Math.max(0, now - c.currentPhaseSince)
    c.currentPhaseSince = now
  } else if (c.currentPhase === null) {
    c.currentPhaseSince = now
  }
  c.currentPhase = phase
  persistLoopState(task, {
    round: c.round,
    phase,
    pauseReason,
    budgets: {
      mechanicalRetries: c.gateStalledStreak,
      reviewRounds: c.round,
      infrastructureRetries: c.infrastructureRetries
    },
    heldResult: c.heldResultIdentity,
    deliveredFindings: c.deliveredFindingsIdentity,
    // The two repeat detectors, read straight off the live `LoopState`
    // this call is persisting — never a second copy the driver maintains
    // itself. A re-exec (`checkStaleDriver`) and an attach both build a
    // fresh `LoopState`, so without this the next round would re-send the
    // developer at a finding or a failure that had already repeated.
    repeatMemory: { blockingFindings: c.state.lastBlockingFindings, lastFailure: c.state.lastFailure },
    publicationExpectedBase: publicationState.publicationExpectedBase,
    developerHandoff: c.developerHandoff,
    // The task's own clock, carried forward unchanged (`taskStartedAt`) and
    // accumulated (`phaseMs`), so the next driver to take this task over
    // measures the same budget from the same instant.
    taskStartedAt: c.taskStartedAt,
    phaseMs: taskClock(c).byPhaseMs
  })
}

/** Records a changed Developer handoff in the `loop_state` record at once, under the phase already current. */
export function persistDeveloperHandoff(c: LoopRunContext, next: Partial<DeveloperHandoff>): void {
  c.developerHandoff = { ...c.developerHandoff, ...next }
  persistCurrentLoopState(c, c.currentPhase ?? 'dispatch_developer')
}

/**
 * O1: the input-version facts an escalation record binds to
 * (`writeEscalationRecord`'s own `briefHash`/`objectivesVersion`/
 * `rulingOrdinal`/`policyDigest`) — the round's own dispatched manifest
 * when one exists (a pause after reviewers ran), else a fresh best-effort
 * read of the same four facts (a pause before any manifest was ever
 * built — an early gate-red stall, a round-1 infrastructure hiccup).
 * Never throws: any individual read failing here must not turn a
 * best-effort escalation write into a reason the pause itself fails.
 */
export function bestEffortInputVersions(c: LoopRunContext): {
  briefHash: string | null
  objectivesVersion: string | null
  rulingOrdinal: number
  policyDigest: string
} {
  const { d, task } = c

  if (c.lastDispatchedManifest) {
    return {
      briefHash: c.lastDispatchedManifest.briefHash,
      objectivesVersion: c.lastDispatchedManifest.objectivesVersion,
      rulingOrdinal: c.lastDispatchedManifest.rulingOrdinal,
      policyDigest: c.lastDispatchedManifest.policyDigest
    }
  }
  let brief: string | null = null
  let objectives: string | null = null
  let ordinal = 0
  try {
    brief = briefHashOf(d.fetchFrozenBrief(task))
  } catch {
    // Best-effort — no frozen brief yet, or unreadable.
  }
  try {
    objectives = d.resolveIssueObjectives(task).version
  } catch {
    // Best-effort — objectives unresolvable this early.
  }
  // The baseline a later resume/cancel must postdate, read from WHEREVER
  // this pause's own ruling will be posted. A pause with no pull request
  // used to record `0` unconditionally, which made the Issue-side
  // freshness gate vacuous: `newestIssueRulingOrdinal > 0` is satisfied by
  // ANY ruling ever posted on the Issue, including one an earlier pause on
  // this same task already consumed, so a single stale approval could
  // authenticate every later before-any-push resume or cancel. The
  // pull-request path always captured a real baseline; this makes the
  // Issue path capture one too.
  //
  // Best-effort in OPPOSITE directions for the two sources, deliberately.
  // A failed pull-request read still falls through to `0`, as it always
  // has: that path's own `--resume` gate re-reads the live ordinal against
  // a pull request the caller had to name, and a `0` there is the same
  // permissive default it was before this task. A failed ISSUE read cannot
  // fall through, because `0` there is not a missing value — it is the
  // positive claim "this Issue carries no rulings", which a failed read did
  // not establish, and recording it reopens exactly the vacuous gate above
  // on nothing more than a transient `gh` failure. So it propagates: the
  // caller's own best-effort `try` around `writeEscalationRecord` swallows
  // it, no escalation record is written, and BOTH tools then fail closed on
  // machinery that already exists — `task_resume` refuses "no durable
  // record — cannot authenticate a resume", and `task_cancel`'s
  // `resolveEscalation` refuses `StaleEscalationError`. The pause is still
  // fully recorded and still continuable by running its printed command
  // directly, which needs no ruling at all.
  if (c.prNumber > 0) {
    try {
      ordinal = d.fetchNewestRulingOrdinal(c.prNumber)
    } catch {
      // Best-effort — no PR ruling yet, or the forge read failed.
    }
  } else {
    ordinal = d.fetchNewestIssueRulingOrdinal(task)
  }
  let digest = 'unknown'
  try {
    digest = policyDigestOf(c.policy)
  } catch {
    // Best-effort — a crash this early in setup can leave `policy` unassigned.
  }
  return { briefHash: brief, objectivesVersion: objectives, rulingOrdinal: ordinal, policyDigest: digest }
}

export function handoffFindingIds(c: LoopRunContext): string[] {
  return c.developerHandoff.findings.map((finding) => finding.id)
}
