/**
 * The round journal is the task's, not the driver's — and it is rebuilt from
 * the control store and the forge's own principal-authored markers, NEVER
 * from a log event. The Vinaya Log is fail-open telemetry: it "is never the
 * authority for dispatch, approval, publication or recovery" (Log tech spec,
 * §1), so no reconstruction here reads a `dev_review_loop` event, a flushed
 * log comment, or the telemetry outbox. This closes the dependency the Log
 * spec forbade before the log destination moves off the tracker — a rebuild
 * that replayed the loop's own flushed log events would break the moment
 * those events stopped going to the tracker.
 *
 * This module is the PURE half of the rebuild: given the round numbers the
 * forge's own principal-authored developer round markers carry, whether a
 * ready-for-merge summary was actually published to the forge, and the review
 * gate's verdict on the pull request's current state, hand back one
 * `RoundRecord` per round plus where the next round should start numbering.
 * The impure caller (`journal-history.ts`, `@attalabs/vinaya`) gathers those
 * facts: it reads the pull request's principal-authored comments and evaluates
 * the gate, never a log line. Nothing here performs a forge read or a gate
 * evaluation of its own — the gate's verdict arrives as an input fact, which is
 * what keeps this half pure and testable in every combination. The control
 * store's own authoritative round is recovered separately by the driver
 * (`recoverLoopState`), and is deliberately NOT folded into the numbering here
 * — see `reconstructRounds`.
 *
 * Honest about what the forge markers carry: a developer round marker
 * (`<!-- aeg:developer:round-<n> -->`) names only the round's own number and
 * head — never a per-severity finding breakdown, a confidence value, or the
 * round's wall time / files changed. Those had a source only in the log
 * events this rebuild no longer reads, so a reconstructed round carries an
 * empty `countsBySeverity`, a `null` confidence, and the totals read `0`
 * (O3: "the summary says it is unavailable for that round" rather than a
 * fabricated number). What the markers DO carry — the round's own existence
 * and number, and whether the run reached a published summary — is exactly
 * what the numbering and the "already published?" decision need.
 */

import { SEVERITY_COLUMNS, type RoundRecord } from './types'

/**
 * The published summary's own header row, byte-for-byte as `render-summary.ts`
 * emits it — both derived from `SEVERITY_COLUMNS`, so the detector here and
 * the renderer there can never drift about what a summary comment looks like.
 * A principal-authored comment carrying this line is the ready-for-merge
 * summary itself: the one honest "the summary was actually published" signal,
 * distinct from a round merely deciding `publish` (the control store's own
 * `loop_state.phase === 'publish'` is written before `publishRound` runs, so
 * it can never stand in for this).
 */
export const SUMMARY_TABLE_HEADER = `| round | ${SEVERITY_COLUMNS.join(' | ')} | confidence | outcome |`

/** True when `body` is (or contains, verbatim on its own line) the published summary's header — the caller has already confirmed the comment is principal-authored. */
export function isPublishedSummaryComment(body: string): boolean {
  return body.split('\n').some((line) => line.trim() === SUMMARY_TABLE_HEADER)
}

/**
 * The forge-derived facts a rebuild is handed. `roundMarkers` are the round
 * numbers read off every principal-authored developer round marker on the
 * pull request (order and duplicates irrelevant — deduplicated here).
 * `summaryPublished` is whether a principal-authored summary comment exists,
 * and `summaryUrl` is that comment's own address when one does.
 * `reviewGate` is the review gate's verdict on the pull request's CURRENT
 * state.
 */
export type ReconstructionInput = {
  roundMarkers: readonly number[]
  summaryPublished: boolean
  /** The published summary comment's own url, or `null` when none is on the forge (or the caller could not resolve one). */
  summaryUrl?: string | null
  /**
   * The review gate's verdict on the pull request's CURRENT head, objectives
   * version, newest ruling, frozen brief and policy — the second half of
   * "concluded" (see `journalFinalized`). The caller evaluates it
   * (`checkReviewGate`; nothing here ever reads the forge) and hands the
   * answer in.
   */
  reviewGate: ReviewGateFact
}

/**
 * What the caller could learn about the review gate.
 *
 *  - `'pass'`/`'fail'` — the gate genuinely evaluated, against the pull
 *    request's current state.
 *  - `'unknown'` — nobody asked (no summary is on the forge, so the answer
 *    could not change the outcome), or the evaluation could not be made at all
 *    (a failed forge read, an unresolvable head, a thrown evaluation).
 *
 * `'unknown'` deliberately does NOT reopen a published review: it is the
 * absence of evidence, not evidence the review moved on, and the two failure
 * directions are not symmetric. Reading it as "reopened" makes one transient
 * `gh` hiccup dispatch a whole extra review round against a task that was
 * genuinely finished, and post its comments — the "a rerun posts nothing
 * twice" invariant, lost for a fact nobody could check. Reading it as "no new
 * information" costs at most one refusal that names the unevaluable gate
 * (`concludedLoopRefusal`) and clears itself on the next attempt. The merge
 * gate is unaffected either way: the `review-gate` check fails CLOSED on every
 * one of these same unresolvable facts, so nothing merges on an unknown here.
 */
export type ReviewGateFact = 'pass' | 'fail' | 'unknown'

export type ReconstructedJournal = {
  rounds: RoundRecord[]
  /** Deliberately `0`: per-round wall time has no control-record or forge source, so it is reported unavailable rather than a fabricated sum (O3). */
  totalWallMs: number
  /** Deliberately `0`: per-round files-changed has no control-record or forge source, so it is reported unavailable rather than a fabricated sum (O3). */
  totalFilesChanged: number
  /** The published summary comment's own url, or `null` when no summary is on the forge (or the caller could not resolve one). Carried even when the gate is red, so a refusal can name where the summary was posted. */
  summaryUrl: string | null
  /** The gate verdict this journal was reconstructed against, carried so a refusal can say the gate could not be evaluated rather than implying it passed. */
  reviewGate: ReviewGateFact
  /**
   * `{ result: 'merged_ready' }` while a principal-authored ready-for-merge
   * summary comment is actually on the forge AND the review gate has not
   * FAILED against the pull request's CURRENT state (`ReviewGateFact`, whose
   * own doc explains why an `'unknown'` gate is not a reopen). Concluded is a
   * property of the pull request now, not a one-way latch it once passed
   * through.
   *
   * The summary alone was the old signal, and it is sticky in a way the forge
   * is not: the summary table records no head, so a summary posted for an
   * older head keeps reading "done forever" after a red gate, a newer
   * Principal ruling, a superseded brief or a moved head — observed on an
   * adopter pull request whose every `--resume` was refused while the gate was
   * red and a ruling sat unaddressed. The gate is the one evaluation already
   * bound to all of those, so asking it about the current state is what makes
   * this reopen when any of them moves.
   *
   * A round that decided `publish` but crashed before the summary landed (a
   * `gh` failure mid-publish) still leaves NO summary comment, so this still
   * reads `null` and no caller mistakes that crash for a completion — the
   * distinction the old log-derived `journal_finalized` deferral drew is
   * unchanged, now with a second condition in front of it. Consumers test this
   * through `isConcludedJournal` below; `'stopped'` is retained in the type
   * for parity with the shape this replaces but is never produced here.
   */
  journalFinalized: { result: 'merged_ready' | 'stopped' } | null
}

/**
 * One `RoundRecord` per distinct developer round marker found on the forge,
 * sorted ascending. Deliberately marker-derived ONLY: the control store's own
 * `loop_state.round` is the driver's authoritative current round and is
 * clamped in separately by `recoverLoopState` (`dev-review-loop.ts`'s round
 * bump), NEVER folded into the numbering here. Were it folded in, an attach
 * whose control store records an in-flight round `k` (its markers not yet on
 * the forge) would reconstruct `k` rounds and bump the next round to `k+1`,
 * skipping the very round the control store says is still running — the
 * "recovers from the control store alone" fixture proves round `k` must be
 * kept, so this function must not carry it past `nextRoundNumber`.
 *
 * `countsBySeverity`/`confidence` are unavailable from a marker (O3): empty and
 * `null`, never a guessed count. `outcome` is `'changes_requested'` — the
 * loop only posts a later round's marker after the prior round concluded
 * changes-requested and re-dispatched the developer, so every reconstructed
 * round is one the loop moved past; the published/green round is the live
 * run's own computed record, never one rebuilt here.
 */
export function reconstructRounds(input: ReconstructionInput): ReconstructedJournal {
  const distinct = [...new Set(input.roundMarkers)].sort((a, b) => a - b)
  const rounds: RoundRecord[] = distinct.map((round) => ({
    round,
    countsBySeverity: {},
    confidence: null,
    outcome: 'changes_requested'
  }))
  const concluded = input.summaryPublished && input.reviewGate !== 'fail'
  return {
    rounds,
    totalWallMs: 0,
    totalFilesChanged: 0,
    summaryUrl: input.summaryUrl ?? null,
    reviewGate: input.reviewGate,
    journalFinalized: concluded ? { result: 'merged_ready' } : null
  }
}

/**
 * The ONE predicate every reader of "is this task's review concluded?" calls
 * — the `--resume` replayed-resolution refusal, the attach's round-history
 * seeding, and the held-clean carry path's "already published?" check alike.
 * A second hand-written `=== 'merged_ready'` test at any of those sites is how
 * they drifted apart before: two of them treated a posted summary as final
 * while the pull request's own gate said otherwise.
 */
export function isConcludedJournal(journal: ReconstructedJournal): boolean {
  return journal.journalFinalized?.result === 'merged_ready'
}

/**
 * The refusal text for a resume against a genuinely concluded review — `null`
 * when the journal is not concluded, so a caller reads "no refusal owed" from
 * the same call that renders one. Names the round the summary concluded at and
 * where that summary is, rather than the storage layer's own
 * consumed-resolution wording, which describes a mechanism the reader did not
 * ask about and hid the real reason the loop would not continue.
 *
 * Degrades rather than inventing: a journal with no round markers at all (a
 * summary posted on a pull request whose round comments were deleted) names no
 * round, an unresolvable summary url says so, and a gate that could not be
 * evaluated at all is named as such rather than left to read as though the gate
 * had been asked and passed.
 */
export function concludedLoopRefusal(journal: ReconstructedJournal): string | null {
  if (!isConcludedJournal(journal)) return null
  const newest = journal.rounds[journal.rounds.length - 1]
  const at = newest === undefined ? '' : ` at round ${newest.round}`
  const where =
    journal.summaryUrl === null ? 'summary posted, comment url unavailable' : `summary posted ${journal.summaryUrl}`
  const gateNote = journal.reviewGate === 'unknown' ? '; review gate could not be evaluated' : ''
  return `loop already concluded${at} (${where}${gateNote})`
}

/** Where a fresh round should start numbering after reconstruction — `1` when there is no prior history at all. */
export function nextRoundNumber(rounds: readonly RoundRecord[]): number {
  if (rounds.length === 0) return 1
  return Math.max(...rounds.map((r) => r.round)) + 1
}
