import { describe, expect, it } from 'vitest'
import { nextRoundNumber, renderSummary } from '@attalabs/aeg-core'
import { loopHistoryFromComments } from '../../../src/lib/dev-review-loop/journal-history'
import type { MarkerComment } from '../../../src/lib/dev-review-loop/developer-dispatch'

const PRINCIPAL = 'daniboomerang'
const ALLOWLIST = [PRINCIPAL]

/** A developer round marker comment exactly as `postDeveloperRoundComment` posts it — marker line, then `Head:`. */
function roundMarker(round: number, author: string = PRINCIPAL): MarkerComment {
  return { body: `<!-- aeg:developer:round-${round} -->\nHead: head-${round}`, author }
}

/** The ready-for-merge summary comment exactly as `publishRound` posts it. */
function summaryComment(rounds: number[], author: string = PRINCIPAL): MarkerComment {
  return {
    body: renderSummary({
      rounds: rounds.map((round) => ({ round, countsBySeverity: {}, confidence: null, outcome: 'changes_requested' }))
    }),
    author
  }
}

describe("loopHistoryFromComments — the task journal, rebuilt from the PR's own forge markers", () => {
  it('no comments → an empty journal', () => {
    expect(loopHistoryFromComments([], ALLOWLIST)).toEqual({
      rounds: [],
      totalWallMs: 0,
      totalFilesChanged: 0,
      journalFinalized: null
    })
  })

  // The five run shapes O2 keeps parity on.

  it('shape 1 — a green single round that published: one round, and the summary marks it merged_ready', () => {
    const j = loopHistoryFromComments([roundMarker(1), summaryComment([1])], ALLOWLIST)
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(j.journalFinalized).toEqual({ result: 'merged_ready' })
  })

  it('shape 2 — a revised multi-round run in progress: a row per round, not yet published', () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(2), roundMarker(3)], ALLOWLIST)
    expect(j.rounds.map((r) => r.round)).toEqual([1, 2, 3])
    expect(j.journalFinalized).toBeNull()
    expect(nextRoundNumber(j.rounds)).toBe(4)
  })

  it('shape 4 — an attach holding a request-changes round: the markers give the next round to run', () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(2)], ALLOWLIST)
    expect(nextRoundNumber(j.rounds)).toBe(3)
    expect(j.journalFinalized).toBeNull()
  })

  it('shape 5 — a crash between a green round and its publication: the round exists, but with no summary it never reads as published', () => {
    // Round 1 posted its developer marker, then crashed mid-publish before
    // the summary landed. Only the marker is on the forge.
    const j = loopHistoryFromComments([roundMarker(1)], ALLOWLIST)
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(j.journalFinalized).toBeNull()
    // The next entry bumps to round 2 rather than restarting at 1.
    expect(nextRoundNumber(j.rounds)).toBe(2)
  })

  it('duplicate markers (the same comment fetched twice) collapse to one row', () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(1), roundMarker(2)], ALLOWLIST)
    expect(j.rounds.map((r) => r.round)).toEqual([1, 2])
  })

  // The trust boundary: a non-principal commenter can paste any marker-shaped
  // text; none of it is trusted (the same filter the log-comment read applied).
  it("a non-principal author's round marker is ignored, never a fabricated round", () => {
    const j = loopHistoryFromComments([roundMarker(1), roundMarker(2, 'stranger')], ALLOWLIST)
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(nextRoundNumber(j.rounds)).toBe(2)
  })

  it("a non-principal author's summary comment never marks the run published", () => {
    const j = loopHistoryFromComments([roundMarker(1), summaryComment([1], 'stranger')], ALLOWLIST)
    expect(j.journalFinalized).toBeNull()
  })

  it('an ordinary principal comment with no marker contributes nothing', () => {
    const j = loopHistoryFromComments([{ body: 'looks good to me', author: PRINCIPAL }, roundMarker(1)], ALLOWLIST)
    expect(j.rounds.map((r) => r.round)).toEqual([1])
    expect(j.journalFinalized).toBeNull()
  })
})
