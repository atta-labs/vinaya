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
 * forge's own principal-authored developer round markers carry, and whether a
 * ready-for-merge summary was actually published to the forge, hand back one
 * `RoundRecord` per round plus where the next round should start numbering.
 * The impure caller (`journal-history.ts`, `@attalabs/vinaya`) gathers those
 * two facts: it reads the pull request's principal-authored comments and the
 * control store, never a log line. The control store's own authoritative
 * round is recovered separately by the driver (`recoverLoopState`), and is
 * deliberately NOT folded into the numbering here — see `reconstructRounds`.
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
 * The two forge-derived facts a rebuild is handed. `roundMarkers` are the
 * round numbers read off every principal-authored developer round marker on
 * the pull request (order and duplicates irrelevant — deduplicated here).
 * `summaryPublished` is whether a principal-authored summary comment exists.
 */
export type ReconstructionInput = {
  roundMarkers: readonly number[]
  summaryPublished: boolean
}

export type ReconstructedJournal = {
  rounds: RoundRecord[]
  /** Deliberately `0`: per-round wall time has no control-record or forge source, so it is reported unavailable rather than a fabricated sum (O3). */
  totalWallMs: number
  /** Deliberately `0`: per-round files-changed has no control-record or forge source, so it is reported unavailable rather than a fabricated sum (O3). */
  totalFilesChanged: number
  /**
   * `{ result: 'merged_ready' }` ONLY when a principal-authored ready-for-
   * merge summary comment is actually on the forge — the one honest signal a
   * run reached publication. A round that decided `publish` but crashed before
   * the summary landed (a `gh` failure mid-publish) leaves NO summary comment,
   * so this reads `null` and the caller never mistakes that crash for a
   * completion — the exact distinction the old log-derived `journal_finalized`
   * deferral drew, now drawn from the forge instead. Consumers only ever test
   * `=== 'merged_ready'`; `'stopped'` is retained in the type for parity with
   * the shape this replaces but is never produced here.
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
  return {
    rounds,
    totalWallMs: 0,
    totalFilesChanged: 0,
    journalFinalized: input.summaryPublished ? { result: 'merged_ready' } : null
  }
}

/** Where a fresh round should start numbering after reconstruction — `1` when there is no prior history at all. */
export function nextRoundNumber(rounds: readonly RoundRecord[]): number {
  if (rounds.length === 0) return 1
  return Math.max(...rounds.map((r) => r.round)) + 1
}
