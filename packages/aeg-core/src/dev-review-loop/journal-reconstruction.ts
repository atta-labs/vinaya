/**
 * The round journal is the task's, not the
 * driver's. `state.rounds` (`types.ts`) starts empty on every process start
 * (`initialLoopState`) and is appended to only by THIS process's own
 * `assessRound` calls — a driver that attaches to a PR mid-loop, or resumes
 * after a pause, published a table that only ever showed its own rounds,
 * even when the task's outbox and the forge already carried a longer real
 * history (confirmed live: "five real rounds, the published table shows
 * one, because the last driver journals only its own rounds").
 *
 * This module is the pure half of the fix: given every `dev_review_loop`
 * log event this task has ever emitted (already-flushed comments off the
 * forge, plus whatever is still sitting unflushed in the local outbox —
 * gathering both is the impure caller's job, `journal-history.ts`), rebuild
 * one `RoundRecord` per concluded round and hand back where the next round
 * should start numbering.
 *
 * Honest about what the log schema actually carries: `round_ended`
 * (`schema.ts`) has no per-severity finding breakdown, and `verdicts_read`
 * carries only a `blockers` count — a round's REAL `countsBySeverity` (major/
 * minor/critical/…) exists only in the live process's own in-memory
 * `VerdictObservation.findings`, which `assessRound` never logs verbatim
 * (`assess-round.ts`'s own `buildRoundRecord`). A reconstructed round's
 * `countsBySeverity` therefore carries only the `blocker` column (from
 * `verdicts_read.blockers`); every other severity reads `0` rather than a
 * fabricated count, and `confidence` is always `null` (never logged at all).
 * What's never dropped is the round's OWN existence, outcome, and diff
 * stats — round_ended carries all three — which is what the Issue's own
 * test bar ("a table that shows fewer rounds than the pull request's verdict
 * comments is a test failure") actually requires.
 */

import { SEVERITY_COLUMNS, type RoundOutcome, type RoundRecord } from './types'
import { DevReviewLoopEventSchema, type DevReviewLoopEvent } from '../log'

/** Exactly the fence `log-flush.ts`'s `renderChunk` posts: a `<!-- aeg:log:<runId>:<seqFrom>-<seqTo> -->` marker line, then one fenced ` ```ndjson ` block, one event per line. */
const LOG_CHUNK_MARKER = /^<!-- aeg:log:[^:]+:\d+-\d+ -->$/
const NDJSON_FENCE = /```ndjson\n([\s\S]*?)\n```/

/** One NDJSON line, best-effort: invalid JSON or a line failing `DevReviewLoopEventSchema` is skipped, never thrown — a single corrupt/foreign line must not blank the whole reconstruction. */
function parseLoopEventLine(raw: string): DevReviewLoopEvent | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  const result = DevReviewLoopEventSchema.safeParse(obj)
  return result.success ? result.data : null
}

/** Every valid `dev_review_loop` event found in `rawLines` — order preserved, invalid lines silently dropped. */
export function parseLoopEventLines(rawLines: readonly string[]): DevReviewLoopEvent[] {
  const out: DevReviewLoopEvent[] = []
  for (const line of rawLines) {
    if (line.length === 0) continue
    const parsed = parseLoopEventLine(line)
    if (parsed) out.push(parsed)
  }
  return out
}

/** A single posted comment's worth of events, or `[]` when `body` isn't one of `log-flush.ts`'s own chunk comments at all. */
export function extractLoopEventsFromCommentBody(body: string): DevReviewLoopEvent[] {
  const firstLine = body.split('\n')[0] ?? ''
  if (!LOG_CHUNK_MARKER.test(firstLine)) return []
  const fence = NDJSON_FENCE.exec(body)
  if (!fence) return []
  const ndjson = fence[1] ?? ''
  return parseLoopEventLines(ndjson.split('\n'))
}

function byTimeThenSeq(a: DevReviewLoopEvent, b: DevReviewLoopEvent): number {
  if (a.meta.ts !== b.meta.ts) return a.meta.ts < b.meta.ts ? -1 : 1
  return a.meta.seq - b.meta.seq
}

const STOPPED_CONDITIONS = new Set(['confidence', 'reappearance', 'no_progress', 'max_rounds'])

export type ReconstructedJournal = {
  rounds: RoundRecord[]
  totalWallMs: number
  totalFilesChanged: number
  /**
   * The task's own `journal_finalized` event, if one was ever logged — the
   * ONLY honest signal that this task's loop actually reached a terminal
   * outcome (round 2 review, BLOCKER): a round's own `round_ended.outcome`
   * reads `'green'` the moment `assessRound` decides `publish`, logged
   * immediately — but `journal_finalized` is deliberately DEFERRED until
   * `publishRound` itself returns without throwing (`dev-review-loop.ts`'s
   * own doc comment: "held back... until publishRound actually succeeds").
   * A crash between those two points (a `gh` failure mid-publish) leaves a
   * `round_ended` reading green with NO `journal_finalized` ever landing —
   * treating that `outcome: 'green'` alone as "this task is done" (the
   * bug this field's caller fixes) silently drops every round from the
   * published table and restarts numbering at `1` on the next attach, for
   * a task that never actually published. The newest such event by time
   * wins, matching `reconstructRounds`' own "last write wins" rule.
   */
  journalFinalized: { result: 'merged_ready' | 'stopped' } | null
}

/**
 * One `RoundRecord` per `round_ended` event found — the loop's own signal
 * that a round genuinely concluded (`assess-round.ts` always logs it,
 * whatever the outcome). Duplicate `round_ended`s for the same round number
 * (a flush replayed across two relaunches, or the same comment fetched
 * twice) keep only the one that sorts last, matching "the newest write for
 * a round wins" every other durable-state reader in this driver already
 * assumes (`readPauseState`, `latestHeldRequestChanges`).
 */
export function reconstructRounds(events: readonly DevReviewLoopEvent[]): ReconstructedJournal {
  const sorted = [...events].sort(byTimeThenSeq)

  const verdictsByRound = new Map<number, { blockers: number }>()
  const stopConditionByRound = new Map<number, string>()
  for (const e of sorted) {
    if (e.event === 'verdicts_read') verdictsByRound.set(e.round, { blockers: e.blockers })
    if (e.event === 'stop_condition_met') stopConditionByRound.set(e.round, e.condition)
  }

  const byRound = new Map<number, RoundRecord>()
  const statsByRound = new Map<number, { wallMs: number; filesChanged: number }>()
  for (const e of sorted) {
    if (e.event !== 'round_ended') continue

    const condition = stopConditionByRound.get(e.round)
    const outcome: RoundOutcome = condition && STOPPED_CONDITIONS.has(condition) ? 'stopped' : e.outcome

    const blockers = verdictsByRound.get(e.round)?.blockers ?? 0
    const countsBySeverity: Record<string, number> = {}
    if (blockers > 0 && (SEVERITY_COLUMNS as readonly string[]).includes('blocker')) {
      countsBySeverity.blocker = blockers
    }

    // A round appearing twice (a chunk fetched or replayed twice) keeps
    // only the LAST write — both here and for its own diff stats, so the
    // two never disagree about which occurrence "won".
    byRound.set(e.round, { round: e.round, countsBySeverity, confidence: null, outcome })
    statsByRound.set(e.round, { wallMs: e.wall_ms, filesChanged: e.files_changed })
  }

  const rounds = [...byRound.values()].sort((a, b) => a.round - b.round)
  let totalWallMs = 0
  let totalFilesChanged = 0
  for (const stats of statsByRound.values()) {
    totalWallMs += stats.wallMs
    totalFilesChanged += stats.filesChanged
  }

  let journalFinalized: ReconstructedJournal['journalFinalized'] = null
  for (const e of sorted) {
    if (e.event === 'journal_finalized') journalFinalized = { result: e.result }
  }

  return { rounds, totalWallMs, totalFilesChanged, journalFinalized }
}

/** Where a fresh round should start numbering after reconstruction — `1` when there is no prior history at all. */
export function nextRoundNumber(rounds: readonly RoundRecord[]): number {
  if (rounds.length === 0) return 1
  return Math.max(...rounds.map((r) => r.round)) + 1
}
