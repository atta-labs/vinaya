/**
 * Where a run is, and what that place usually takes in this repository.
 *
 * Two pure concerns, both read by the task-status reader and the `task_status`
 * tool:
 *
 *   - **The phase vocabulary.** The dev-review-loop's own recovery record
 *     (`loop_state`) carries a `phase` string mirroring the driver's own
 *     `Decision['type']`. `TASK_PHASE_LABELS` maps each recorded phase to the
 *     one word a reader sees, one-to-one — never a phase invented from a
 *     second source, and never one recorded phase split into two.
 *   - **Typical phase times, from history.** `phaseSamplesFromPrComments`
 *     reads durations off a merged task pull request's own principal-authored
 *     comments: a developer round marker, then that round's verdict comments,
 *     then the next round's marker. The interval marker → verdicts is time
 *     spent reviewing; verdicts → next marker is time spent developing.
 *     `summarizePhaseSamples` reduces a set of those to a MEDIAN and a sample
 *     count, and refuses to answer at all below `MIN_PHASE_HISTORY_SAMPLES`.
 *
 * Every figure this module produces is history — what already happened, on
 * merged work — and is named that way (`typicalPhaseMinutes`, never an ETA,
 * never a remaining time, never a deadline). Nothing here predicts when a run
 * in flight will finish.
 *
 * Only principal-authored comments contribute a sample: the same trust
 * boundary every other forge read in this loop applies, so a non-principal
 * commenter cannot post a round-marker- or verdict-shaped comment and shift
 * what the repository reports as typical.
 */

import { parseDeveloperRoundMarker } from './review-status'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from './verdict-extraction'
import { isPrincipal } from './waiver-label'

// --- the phase vocabulary ---------------------------------------------------

/**
 * The phases the loop actually records, and the word each reads as. One entry
 * per `Decision['type']` the driver persists into `loop_state.phase`:
 *
 * | recorded phase       | shown as             |
 * | -------------------- | -------------------- |
 * | `dispatch_developer` | `developing`         |
 * | `ask_confidence`     | `awaiting confidence`|
 * | `dispatch_reviewers` | `reviewing`          |
 * | `publish`            | `publishing`         |
 * | `pause`              | `paused`             |
 *
 * There is deliberately no separate `waiting for CI` phase: the driver polls
 * the head's checks while the record still reads `dispatch_developer`, so a
 * distinct CI-wait row would have to be inferred from a second source rather
 * than read from the record. `developing` therefore spans the developer's own
 * turn AND the gate wait that follows its push — stated here rather than left
 * for a reader to assume.
 */
export const TASK_PHASE_LABELS = {
  dispatch_developer: 'developing',
  ask_confidence: 'awaiting confidence',
  dispatch_reviewers: 'reviewing',
  publish: 'publishing',
  pause: 'paused'
} as const

export type RecordedLoopPhase = keyof typeof TASK_PHASE_LABELS
export type TaskPhaseLabel = (typeof TASK_PHASE_LABELS)[RecordedLoopPhase]

export function isRecordedLoopPhase(phase: string): phase is RecordedLoopPhase {
  return Object.hasOwn(TASK_PHASE_LABELS, phase)
}

/** The shown phase for a recorded one. A phase this vocabulary does not know (a decision type added after this mapping) reads back VERBATIM — the record's own word, never a guess at which known phase it resembles. */
export function taskPhaseLabel(phase: string): string {
  return isRecordedLoopPhase(phase) ? TASK_PHASE_LABELS[phase] : phase
}

/**
 * Which history class a recorded phase compares against — `null` for a phase
 * the pull-request record carries no interval for. `publish` and `pause` have
 * none by nature (publishing is one comment post; a pause ends when a person
 * acts), and `ask_confidence` has none because it is not separable from the
 * developer turn it interrupts.
 */
export type PhaseHistoryClass = 'developing' | 'reviewing'

export function phaseHistoryClassFor(phase: string): PhaseHistoryClass | null {
  if (phase === 'dispatch_developer') return 'developing'
  if (phase === 'dispatch_reviewers') return 'reviewing'
  return null
}

// --- typical phase times, from merged pull requests -------------------------

/** One comment as a history read sees it: its body, its author, and the forge's own creation timestamp. */
export type HistoryComment = { body: string; author: string | null; createdAt: string }

/** Minutes, one entry per interval the record actually carried — never a filled-in or interpolated value. */
export type PhaseSamples = { [K in PhaseHistoryClass]: number[] }

export function emptyPhaseSamples(): PhaseSamples {
  return { developing: [], reviewing: [] }
}

/** A verdict comment is one either merge-gate extractor parses clean — the same "did this cast a verdict" test the gate itself applies, so this read can never disagree with it about which comment ended a round. */
function isVerdictComment(body: string): boolean {
  return (
    extractCodeReviewVerdict([body]).danglingNote === null || extractSecurityReviewVerdict([body]).danglingNote === null
  )
}

type PhaseEvent = { kind: 'marker'; at: number } | { kind: 'verdict'; at: number }

function minutesBetween(fromMs: number, toMs: number): number | null {
  const ms = toMs - fromMs
  return ms >= 0 ? ms / 60_000 : null
}

/**
 * The phase intervals one pull request's comments record. Ordered by the
 * forge's own timestamps rather than by the order the read returned them, so
 * a paginated or re-ordered read measures the same intervals.
 *
 * A round whose verdicts were never posted as comments contributes NOTHING —
 * neither a reviewing nor a developing sample — because the record does not
 * say where that round's time went. Today the driver posts a round's verdict
 * comments when it publishes, so a pull request that took several rounds
 * carries one reviewing interval and no developing interval at all; that is
 * a thin history, and `summarizePhaseSamples` below refuses to turn a thin
 * history into a number.
 */
export function phaseSamplesFromPrComments(
  comments: readonly HistoryComment[],
  allowlist: readonly string[]
): PhaseSamples {
  const events: PhaseEvent[] = []
  for (const comment of comments) {
    if (!isPrincipal(comment.author, allowlist as string[])) continue
    const at = Date.parse(comment.createdAt)
    if (!Number.isFinite(at)) continue
    if (parseDeveloperRoundMarker(comment.body) !== null) events.push({ kind: 'marker', at })
    else if (isVerdictComment(comment.body)) events.push({ kind: 'verdict', at })
  }
  events.sort((a, b) => a.at - b.at)

  const samples = emptyPhaseSamples()
  let markerAt: number | null = null
  let lastVerdictAt: number | null = null
  const closeRound = (): void => {
    if (markerAt === null || lastVerdictAt === null) return
    const minutes = minutesBetween(markerAt, lastVerdictAt)
    if (minutes !== null) samples.reviewing.push(minutes)
  }
  for (const event of events) {
    if (event.kind === 'marker') {
      closeRound()
      if (lastVerdictAt !== null) {
        const minutes = minutesBetween(lastVerdictAt, event.at)
        if (minutes !== null) samples.developing.push(minutes)
      }
      markerAt = event.at
      lastVerdictAt = null
      continue
    }
    // A round posts more than one verdict (a code review and a security
    // pass); the round's review ends at the LAST of them.
    if (markerAt !== null) lastVerdictAt = lastVerdictAt === null ? event.at : Math.max(lastVerdictAt, event.at)
  }
  closeRound()
  return samples
}

/** Below this many past intervals, a phase reports no typical time at all: two samples from two pull requests describe those two pull requests, not this repository. */
export const MIN_PHASE_HISTORY_SAMPLES = 3

/** The median of a phase's past intervals, with the count it was computed from. The MEDIAN, never the mean: one pull request left open over a weekend would drag a mean into uselessness. */
export type PhaseHistory = { typicalPhaseMinutes: number; typicalPhaseSamples: number }

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** `null` — no typical time, never an invented one — for a phase with fewer than `MIN_PHASE_HISTORY_SAMPLES` past intervals, and for one with none at all. */
export function summarizePhaseSamples(minutes: readonly number[]): PhaseHistory | null {
  if (minutes.length < MIN_PHASE_HISTORY_SAMPLES) return null
  const median = medianOf(minutes)
  if (median === null) return null
  return { typicalPhaseMinutes: Math.round(median), typicalPhaseSamples: minutes.length }
}
