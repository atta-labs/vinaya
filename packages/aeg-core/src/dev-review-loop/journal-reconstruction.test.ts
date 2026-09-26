import { describe, expect, it } from 'vitest'
import {
  concludedLoopRefusal,
  isConcludedJournal,
  isPublishedSummaryComment,
  nextRoundNumber,
  reconstructRounds,
  SUMMARY_TABLE_HEADER
} from './journal-reconstruction'
import { renderSummary } from './render-summary'

describe('reconstructRounds — from the forge markers, never a log event', () => {
  it('returns an empty journal for no markers and no published summary', () => {
    expect(reconstructRounds({ roundMarkers: [], summaryPublished: false, reviewGatePasses: false })).toEqual({
      rounds: [],
      totalWallMs: 0,
      totalFilesChanged: 0,
      summaryUrl: null,
      journalFinalized: null
    })
  })

  it('rebuilds one RoundRecord per distinct developer round marker', () => {
    const { rounds } = reconstructRounds({ roundMarkers: [1], summaryPublished: false, reviewGatePasses: false })
    expect(rounds).toEqual([{ round: 1, countsBySeverity: {}, confidence: null, outcome: 'changes_requested' }])
  })

  it('a reconstructed round carries no per-severity counts, no confidence — a marker names neither (O3)', () => {
    const { rounds } = reconstructRounds({ roundMarkers: [1], summaryPublished: false, reviewGatePasses: false })
    expect(rounds[0]?.countsBySeverity).toEqual({})
    expect(rounds[0]?.confidence).toBeNull()
  })

  it('per-round wall time and files changed have no marker source, so the totals read 0, never a fabricated sum (O3)', () => {
    const { totalWallMs, totalFilesChanged } = reconstructRounds({
      roundMarkers: [1, 2, 3],
      summaryPublished: true,
      reviewGatePasses: true
    })
    expect(totalWallMs).toBe(0)
    expect(totalFilesChanged).toBe(0)
  })

  it('deduplicates repeated markers (a comment fetched twice) and sorts ascending regardless of input order', () => {
    const { rounds } = reconstructRounds({
      roundMarkers: [3, 1, 2, 1, 3],
      summaryPublished: false,
      reviewGatePasses: false
    })
    expect(rounds.map((r) => r.round)).toEqual([1, 2, 3])
  })

  // The five run shapes this task keeps parity on, at the pure-function level.

  it('shape 1 — a green single round that published: its summary is the honest merged_ready signal', () => {
    const j = reconstructRounds({ roundMarkers: [1], summaryPublished: true, reviewGatePasses: true })
    expect(j.journalFinalized).toEqual({ result: 'merged_ready' })
  })

  it('shape 2 — a revised multi-round run in progress: every round a row, not yet published', () => {
    const j = reconstructRounds({ roundMarkers: [1, 2, 3], summaryPublished: false, reviewGatePasses: false })
    expect(j.rounds.map((r) => r.round)).toEqual([1, 2, 3])
    expect(j.journalFinalized).toBeNull()
    expect(nextRoundNumber(j.rounds)).toBe(4)
  })

  it('shape 4 — an attach holding a request-changes round: the markers give the next round to run', () => {
    const j = reconstructRounds({ roundMarkers: [1, 2], summaryPublished: false, reviewGatePasses: false })
    expect(nextRoundNumber(j.rounds)).toBe(3)
    expect(j.journalFinalized).toBeNull()
  })

  // Shape 5 — the crash-before-publication signal. A round concluded and
  // decided `publish`, but the process crashed before the summary comment
  // landed on the forge. No summary → NEVER merged_ready, so the next entry
  // never mistakes the crash for a completion.
  describe('shape 5 — journalFinalized is the crash-vs-published signal', () => {
    it('is null when no summary was published, even though a round marker exists', () => {
      expect(
        reconstructRounds({ roundMarkers: [1], summaryPublished: false, reviewGatePasses: false }).journalFinalized
      ).toBeNull()
    })

    it('is merged_ready only once the summary comment is actually on the forge, with the gate passing on the current state', () => {
      expect(
        reconstructRounds({ roundMarkers: [1], summaryPublished: true, reviewGatePasses: true }).journalFinalized
      ).toEqual({
        result: 'merged_ready'
      })
    })
  })
})

// O1/O2: "concluded" is the summary AND the gate on the current state. A
// summary records no head, so on its own it kept reading "done forever"
// through a red gate, a newer ruling, a superseded brief and a moved head —
// every one of which the gate itself already evaluates.
describe('journalFinalized — concluded is the summary AND a passing gate on the current state (O1)', () => {
  it('a summary posted while the gate is red is NOT concluded — the pull request reopens', () => {
    const j = reconstructRounds({ roundMarkers: [1, 2, 3], summaryPublished: true, reviewGatePasses: false })
    expect(j.journalFinalized).toBeNull()
    expect(isConcludedJournal(j)).toBe(false)
  })

  it('a passing gate with no summary posted is NOT concluded either — publication is still its own fact', () => {
    const j = reconstructRounds({ roundMarkers: [1], summaryPublished: false, reviewGatePasses: true })
    expect(isConcludedJournal(j)).toBe(false)
  })

  it('both facts together are the only concluded state', () => {
    const j = reconstructRounds({ roundMarkers: [1], summaryPublished: true, reviewGatePasses: true })
    expect(isConcludedJournal(j)).toBe(true)
  })

  it('keeps every prior round when a summary plus a red gate reopens the review, so numbering continues past the last marker (O3)', () => {
    const j = reconstructRounds({ roundMarkers: [1, 2, 3], summaryPublished: true, reviewGatePasses: false })
    expect(j.rounds.map((r) => r.round)).toEqual([1, 2, 3])
    expect(nextRoundNumber(j.rounds)).toBe(4)
  })

  it("carries the summary comment's url whether or not the gate passes", () => {
    const url = 'https://forge.example/pr/7#issuecomment-1'
    expect(
      reconstructRounds({ roundMarkers: [1], summaryPublished: true, summaryUrl: url, reviewGatePasses: false })
        .summaryUrl
    ).toBe(url)
    expect(
      reconstructRounds({ roundMarkers: [1], summaryPublished: true, summaryUrl: url, reviewGatePasses: true })
        .summaryUrl
    ).toBe(url)
  })
})

describe('concludedLoopRefusal — the refusal a resume against a truly concluded review gets (O2)', () => {
  it('names the round the summary concluded at and where the summary is', () => {
    const j = reconstructRounds({
      roundMarkers: [1, 2, 3],
      summaryPublished: true,
      summaryUrl: 'https://forge.example/pr/7#issuecomment-1',
      reviewGatePasses: true
    })
    expect(concludedLoopRefusal(j)).toBe(
      'loop already concluded at round 3 (summary posted https://forge.example/pr/7#issuecomment-1)'
    )
  })

  it('is null for a review that is not concluded — a summary posted against a red gate owes no refusal', () => {
    const j = reconstructRounds({
      roundMarkers: [1, 2, 3],
      summaryPublished: true,
      summaryUrl: 'https://forge.example/pr/7#issuecomment-1',
      reviewGatePasses: false
    })
    expect(concludedLoopRefusal(j)).toBeNull()
  })

  it('says the url is unavailable rather than inventing one', () => {
    const j = reconstructRounds({ roundMarkers: [2], summaryPublished: true, reviewGatePasses: true })
    expect(concludedLoopRefusal(j)).toBe('loop already concluded at round 2 (summary posted, comment url unavailable)')
  })

  it('names no round when the pull request carries no round markers at all', () => {
    const j = reconstructRounds({
      roundMarkers: [],
      summaryPublished: true,
      summaryUrl: 'https://forge.example/pr/7#issuecomment-1',
      reviewGatePasses: true
    })
    expect(concludedLoopRefusal(j)).toBe(
      'loop already concluded (summary posted https://forge.example/pr/7#issuecomment-1)'
    )
  })
})

describe('isPublishedSummaryComment', () => {
  it('recognizes a real rendered summary comment by its header', () => {
    const summary = renderSummary({
      rounds: [{ round: 1, countsBySeverity: {}, confidence: null, outcome: 'green' }]
    })
    expect(isPublishedSummaryComment(summary)).toBe(true)
  })

  it('recognizes the header even when a comment prepends other lines before the table', () => {
    expect(isPublishedSummaryComment(`some preamble\n\n${SUMMARY_TABLE_HEADER}\n| 1 | 0 |`)).toBe(true)
  })

  it('is false for an ordinary comment with no summary header', () => {
    expect(isPublishedSummaryComment('just an ordinary comment')).toBe(false)
  })

  it('is false for a developer round marker comment', () => {
    expect(isPublishedSummaryComment('<!-- aeg:developer:round-2 -->\nHead: abc1234')).toBe(false)
  })

  it("the detector header equals render-summary's own header — they cannot drift", () => {
    const summary = renderSummary({ rounds: [] })
    expect(summary.split('\n')[0]).toBe(SUMMARY_TABLE_HEADER)
  })
})

describe('nextRoundNumber', () => {
  it('is 1 when there is no prior history', () => {
    expect(nextRoundNumber([])).toBe(1)
  })

  it('is one past the highest reconstructed round', () => {
    const { rounds } = reconstructRounds({ roundMarkers: [1, 3], summaryPublished: false, reviewGatePasses: false })
    expect(nextRoundNumber(rounds)).toBe(4)
  })
})
