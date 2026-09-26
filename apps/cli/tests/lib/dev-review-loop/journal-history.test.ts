import { describe, expect, it } from 'vitest'
import { nextRoundNumber, renderSummary, type ReviewGateFact } from '@attalabs/aeg-core'
import { loopHistoryFromComments } from '../../../src/lib/dev-review-loop/journal-history'
import type { MarkerComment } from '../../../src/lib/dev-review-loop/developer-dispatch'

const PRINCIPAL = 'daniboomerang'
const ALLOWLIST = [PRINCIPAL]

/** A developer round marker comment exactly as `postDeveloperRoundComment` posts it — marker line, then `Head:`. */
function roundMarker(round: number, author: string = PRINCIPAL): MarkerComment {
  return { body: `<!-- aeg:developer:round-${round} -->\nHead: head-${round}`, author }
}

const SUMMARY_URL = 'https://forge.example/pr/7#issuecomment-1'

/** The ready-for-merge summary comment exactly as `publishRound` posts it. */
function summaryComment(rounds: number[], author: string = PRINCIPAL): MarkerComment {
  return {
    body: renderSummary({
      rounds: rounds.map((round) => ({ round, countsBySeverity: {}, confidence: null, outcome: 'changes_requested' }))
    }),
    author,
    url: SUMMARY_URL
  }
}

/** The review gate's verdict on the pull request's current state — passing, so a posted summary reads as concluded. */
const GATE_PASSES = (): ReviewGateFact => 'pass'
/** The gate genuinely red on the current state — a posted summary then reopens the review. */
const GATE_RED = (): ReviewGateFact => 'fail'
/** The gate could not be evaluated at all — never a reopen, since the absence of an answer is not evidence the review moved on. */
const GATE_UNKNOWN = (): ReviewGateFact => 'unknown'

describe("loopHistoryFromComments — the task journal, rebuilt from the PR's own forge markers", () => {
  it('no comments → an empty journal', () => {
    expect(loopHistoryFromComments([], ALLOWLIST, GATE_PASSES)).toEqual({
      rounds: [],
      totalWallMs: 0,
      totalFilesChanged: 0,
      summaryUrl: null,
      reviewGate: 'unknown',
      journalFinalized: null
    })
  })

  // The five run shapes O2 keeps parity on.

  it('shape 1 — a green single round that published: one round, and the summary marks it merged_ready', () => {
    const j = loopHistoryFromComments([roundMarker(1), summaryComment([1])], ALLOWLIST, GATE_PASSES)
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(j.journalFinalized).toEqual({ result: 'merged_ready' })
  })

  it('shape 2 — a revised multi-round run in progress: a row per round, not yet published', () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(2), roundMarker(3)], ALLOWLIST, GATE_PASSES)
    expect(j.rounds.map((r) => r.round)).toEqual([1, 2, 3])
    expect(j.journalFinalized).toBeNull()
    expect(nextRoundNumber(j.rounds)).toBe(4)
  })

  it('shape 4 — an attach holding a request-changes round: the markers give the next round to run', () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(2)], ALLOWLIST, GATE_PASSES)
    expect(nextRoundNumber(j.rounds)).toBe(3)
    expect(j.journalFinalized).toBeNull()
  })

  it('shape 5 — a crash between a green round and its publication: the round exists, but with no summary it never reads as published', () => {
    // Round 1 posted its developer marker, then crashed mid-publish before
    // the summary landed. Only the marker is on the forge.
    const j = loopHistoryFromComments([roundMarker(1)], ALLOWLIST, GATE_PASSES)
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(j.journalFinalized).toBeNull()
    // The next entry bumps to round 2 rather than restarting at 1.
    expect(nextRoundNumber(j.rounds)).toBe(2)
  })

  it('duplicate markers (the same comment fetched twice) collapse to one row', () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(1), roundMarker(2)], ALLOWLIST, GATE_PASSES)
    expect(j.rounds.map((r) => r.round)).toEqual([1, 2])
  })

  // The trust boundary: a non-principal commenter can paste any marker-shaped
  // text; none of it is trusted (the same filter the log-comment read applied).
  it("a non-principal author's round marker is ignored, never a fabricated round", () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(2, 'stranger')], ALLOWLIST, GATE_PASSES)
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(nextRoundNumber(j.rounds)).toBe(2)
  })

  it("a non-principal author's summary comment never marks the run published", () => {
    const j = loopHistoryFromComments([roundMarker(1), summaryComment([1], 'stranger')], ALLOWLIST, GATE_PASSES)
    expect(j.journalFinalized).toBeNull()
  })

  it('an ordinary principal comment with no marker contributes nothing', () => {
    const j = loopHistoryFromComments(
      [{ body: 'looks good to me', author: PRINCIPAL }, roundMarker(1)],
      ALLOWLIST,
      GATE_PASSES
    )
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(j.journalFinalized).toBeNull()
  })
})

// O1: the gate on the current state is the second half of "concluded", and
// the summary comment's own url is carried so a refusal can name it.
describe('loopHistoryFromComments — the review gate decides whether a posted summary still means concluded (O1)', () => {
  it('a posted summary with the gate red reads as NOT concluded, and keeps every prior round for numbering (O3)', () => {
    const j = loopHistoryFromComments(
      [roundMarker(1), roundMarker(2), roundMarker(3), summaryComment([1, 2, 3])],
      ALLOWLIST,
      GATE_RED
    )
    expect(j.journalFinalized).toBeNull()
    expect(j.rounds.map((r) => r.round)).toEqual([1, 2, 3])
    expect(nextRoundNumber(j.rounds)).toBe(4)
  })

  it("carries the published summary comment's own url", () => {
    const j = loopHistoryFromComments([roundMarker(1), summaryComment([1])], ALLOWLIST, GATE_PASSES)
    expect(j.summaryUrl).toBe(SUMMARY_URL)
  })

  it('leaves the url null when the summary comment carried none', () => {
    const noUrl: MarkerComment = { ...summaryComment([1]), url: null }
    const j = loopHistoryFromComments([roundMarker(1), noUrl], ALLOWLIST, GATE_PASSES)
    expect(j.summaryUrl).toBeNull()
    expect(j.journalFinalized).toEqual({ result: 'merged_ready' })
  })

  it('a posted summary with a gate that could not be evaluated stays concluded — no reopen on the absence of an answer', () => {
    const j = loopHistoryFromComments([roundMarker(1), summaryComment([1])], ALLOWLIST, GATE_UNKNOWN)
    expect(j.journalFinalized).toEqual({ result: 'merged_ready' })
    expect(j.reviewGate).toBe('unknown')
  })

  it('never evaluates the gate at all when no summary is on the forge — the ordinary attach pays for no gate read', () => {
    let evaluations = 0
    const gate = (): ReviewGateFact => {
      evaluations += 1
      return 'pass'
    }
    loopHistoryFromComments([roundMarker(1), roundMarker(2)], ALLOWLIST, gate)
    expect(evaluations).toBe(0)
  })

  it('evaluates the gate exactly once when a summary IS on the forge', () => {
    let evaluations = 0
    const gate = (): ReviewGateFact => {
      evaluations += 1
      return 'pass'
    }
    loopHistoryFromComments([roundMarker(1), summaryComment([1])], ALLOWLIST, gate)
    expect(evaluations).toBe(1)
  })

  it("a non-principal author's summary comment never reaches the gate either", () => {
    let evaluations = 0
    const gate = (): ReviewGateFact => {
      evaluations += 1
      return 'pass'
    }
    const j = loopHistoryFromComments([roundMarker(1), summaryComment([1], 'stranger')], ALLOWLIST, gate)
    expect(evaluations).toBe(0)
    expect(j.journalFinalized).toBeNull()
    expect(j.summaryUrl).toBeNull()
  })
})
