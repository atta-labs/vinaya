import { describe, expect, it } from 'vitest'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from '../verdict-extraction'
import { isPublishedSummaryComment } from './journal-reconstruction'
import { parseSummaryConfidenceRows, renderPublishedMarker } from './render-summary'
import type { RoundRecord } from './types'

function round(n: number, confidence: RoundRecord['confidence']): RoundRecord {
  return { round: n, countsBySeverity: {}, confidence, outcome: 'green' }
}

const HEAD = 'abc1234def'

describe('renderPublishedMarker', () => {
  it("is one hidden marker line carrying the head and each round's confidence", () => {
    const marker = renderPublishedMarker(
      { rounds: [round(1, null), round(2, { value: 80 }), round(3, 'absent')] },
      HEAD
    )
    expect(marker).toBe(`<!-- aeg:loop:published head=${HEAD} confidence=1:-,2:80,3:absent -->`)
  })

  it('posts no round table and no finding text', () => {
    const marker = renderPublishedMarker({ rounds: [round(1, null)] }, HEAD)
    expect(marker).not.toContain('|')
    expect(marker.split('\n')).toHaveLength(1)
  })

  it('never emits a line either verdict extractor reads as a real verdict', () => {
    const marker = renderPublishedMarker({ rounds: [round(1, null), round(2, 'absent')] }, HEAD)
    expect(extractCodeReviewVerdict([marker]).danglingNote).not.toBeNull()
    expect(extractSecurityReviewVerdict([marker]).danglingNote).not.toBeNull()
  })

  it('renders for a journal with zero rounds without crashing, and is still detected as published', () => {
    expect(isPublishedSummaryComment(renderPublishedMarker({ rounds: [] }, HEAD))).toBe(true)
  })
})

describe('parseSummaryConfidenceRows', () => {
  it("reads back every round's confidence from a marker this module itself rendered", () => {
    const marker = renderPublishedMarker(
      { rounds: [round(1, null), round(2, { value: 80 }), round(3, 'absent')] },
      HEAD
    )
    expect(parseSummaryConfidenceRows(marker)).toEqual([
      { round: 1, percent: null, asked: false },
      { round: 2, percent: 80, asked: true },
      { round: 3, percent: null, asked: true }
    ])
  })

  it('reads a marker quoted inside a longer comment, and nothing from prose', () => {
    const body = `Deferred findings are tracked in #12.\n\n<!-- aeg:loop:published head=${HEAD} confidence=2:70 -->\n\n| 9 | 99% |`
    expect(parseSummaryConfidenceRows(body)).toEqual([{ round: 2, percent: 70, asked: true }])
    expect(parseSummaryConfidenceRows('1:90 and 2:80, no marker')).toEqual([])
  })

  it('drops an entry whose confidence exceeds the percentage a caller is allowed to publish, or is malformed', () => {
    const body = `<!-- aeg:loop:published head=${HEAD} confidence=1:101,2:90,x:50,3:-5 -->`
    expect(parseSummaryConfidenceRows(body)).toEqual([{ round: 2, percent: 90, asked: true }])
  })
})
