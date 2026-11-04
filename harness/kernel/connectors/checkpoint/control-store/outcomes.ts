/**
 * The parent-validated outcome normalizer (O2). One pure function that turns
 * the raw signals a launch leaves behind — did it time out, was it cancelled,
 * did the capability refuse, did the infrastructure fail, are the required
 * artifacts on disk, do the declared postconditions hold, and what exit code
 * it returned — into ONE truthful outcome, drawn from a closed vocabulary:
 *
 *   - `completed`            — the work is genuinely done: the required
 *                              artifacts exist and every declared
 *                              postcondition holds.
 *   - `incomplete`           — the attempt ended without the work being done:
 *                              a required artifact is missing, or a
 *                              postcondition is unmet. **This is the case a
 *                              bare exit code hides:** a process that exits 0
 *                              having produced nothing is `incomplete`, never
 *                              `completed` — the whole point of this
 *                              normalizer is that exit zero is never equated
 *                              with task success.
 *   - `infrastructure-failed`— the launch itself failed (a crash, a spawn
 *                              fault) before it could fairly attempt the work
 *                              — not the task's own doing.
 *   - `timed-out`            — the ceiling fired and the launch was killed.
 *   - `cancelled`            — an operator or a supervisor stopped it.
 *   - `capability-refused`   — the capability declined the work up front (a
 *                              missing/rejected binary, a refused model) —
 *                              distinct from an infrastructure fault mid-run.
 *
 * **Exit code is an INPUT, never the decider.** It is carried into the
 * outcome's `reason` for the record, but the `completed`/`incomplete` split is
 * decided ENTIRELY by `artifactsPresent`/`postconditionsMet` — a non-zero
 * exit with the artifacts genuinely present and the postconditions met still
 * reads `completed` (the artifacts are the truth), and a zero exit with a
 * missing artifact still reads `incomplete`. The manner-of-death signals
 * (`refused`/`cancelled`/`timedOut`/`infrastructure`) take precedence over
 * the artifact read, because an attempt the ceiling killed, the operator
 * stopped, or the infrastructure broke never got a fair chance to leave its
 * artifacts, and misreporting it as a plain `incomplete` would blame the task
 * for the environment's failure.
 *
 * Pure — no `fs`, no clock, no process access. The caller (a parent
 * validating a launch — `apps/cli/src/lib/dispatch.ts`'s launcher, the
 * dev-review-loop's recovery) supplies every signal; this only classifies.
 */

/** The closed outcome vocabulary a parent-validated launch resolves to (O2). */
export type TaskOutcomeStatus =
  | 'completed'
  | 'incomplete'
  | 'infrastructure-failed'
  | 'timed-out'
  | 'cancelled'
  | 'capability-refused'

/**
 * The raw signals a launch leaves behind, as observed by the parent that
 * validates it. `exitCode` is carried for the record only — it never decides
 * the `completed`/`incomplete` split (see this module's own doc). The four
 * manner-of-death booleans are mutually exhaustive with "ran to a natural
 * end"; when more than one is somehow set, the precedence in `normalizeOutcome`
 * decides which one names the outcome.
 */
export type OutcomeSignals = {
  /** The process exit code, or `null` when the launch never produced one (a pre-spawn refusal, a signal death). Input only — never the decider. */
  exitCode: number | null
  /** The ceiling fired and the launch was killed. */
  timedOut: boolean
  /** An operator or supervisor stopped the launch. */
  cancelled: boolean
  /** The capability declined the work up front — a missing or rejected binary, a refused model — before it ever ran. */
  refused: boolean
  /** The launch itself failed (a crash, a spawn fault) — an environment failure, not the task's own doing. */
  infrastructure: boolean
  /** The required work artifacts exist — the parent's own check, never inferred from the exit code. */
  artifactsPresent: boolean
  /** Every declared postcondition holds — likewise the parent's own check. */
  postconditionsMet: boolean
}

export type NormalizedOutcome = {
  status: TaskOutcomeStatus
  /** A human-readable justification carrying the deciding facts — including the exit code, so a reader sees it was considered as input without it having decided anything. */
  reason: string
}

function exitCodeNote(exitCode: number | null): string {
  return exitCode === null ? 'no exit code' : `exit code ${exitCode}`
}

/**
 * Classify one launch's raw signals into a single truthful outcome (O2). See
 * this module's own doc for the vocabulary, the exit-code-is-input-only rule,
 * and why the manner-of-death signals take precedence over the artifact read.
 */
export function normalizeOutcome(signals: OutcomeSignals): NormalizedOutcome {
  const { exitCode, timedOut, cancelled, refused, infrastructure, artifactsPresent, postconditionsMet } = signals

  // Manner-of-death first: an attempt that was refused, cancelled, timed out,
  // or broke on infrastructure never got a fair chance to leave its
  // artifacts, so its outcome is named by HOW it ended, never by an artifact
  // read that was never going to succeed. Order among them is deliberate:
  // a refusal happens before anything runs; a cancellation and a timeout are
  // both external stops (cancellation is the operator's intent, checked first
  // so a cancel that also tripped the ceiling still reads as the deliberate
  // stop); an infrastructure fault is the catch-all launch failure.
  if (refused) {
    return { status: 'capability-refused', reason: `the capability refused the launch (${exitCodeNote(exitCode)})` }
  }
  if (cancelled) {
    return { status: 'cancelled', reason: `the launch was cancelled (${exitCodeNote(exitCode)})` }
  }
  if (timedOut) {
    return { status: 'timed-out', reason: `the launch exceeded its ceiling and was killed (${exitCodeNote(exitCode)})` }
  }
  if (infrastructure) {
    return {
      status: 'infrastructure-failed',
      reason: `the launch failed on infrastructure, not the task itself (${exitCodeNote(exitCode)})`
    }
  }

  // Ran to a natural end. The artifacts and postconditions are the truth —
  // NOT the exit code, which is only reported here, never consulted for the
  // decision. This is where exit-zero-with-no-artifact becomes `incomplete`.
  if (artifactsPresent && postconditionsMet) {
    return {
      status: 'completed',
      reason: `required artifacts present and postconditions met (${exitCodeNote(exitCode)} treated as input only)`
    }
  }
  const missing = !artifactsPresent ? 'a required artifact is missing' : 'a declared postcondition is unmet'
  return {
    status: 'incomplete',
    reason: `${missing} — ${exitCodeNote(exitCode)} does not by itself prove the work is done`
  }
}
