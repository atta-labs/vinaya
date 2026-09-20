/**
 * Unit tests for `round-assess.ts`'s `parseConfidenceReply` — the developer's
 * `.vinaya-confidence` reply, parsed once, destructively, at the gate read.
 */

import { describe, expect, it } from 'bun:test'
import { CONFIDENCE_REASON_MAX_LENGTH } from '@attalabs/aeg-core'
import { parseConfidenceReply } from '../../../src/lib/dev-review-loop/round-assess'

describe('parseConfidenceReply', () => {
  it('parses a well-formed line into a value and reason', () => {
    expect(parseConfidenceReply('CONFIDENCE: 90 — fixed the reported issue\n')).toEqual({
      value: 90,
      reason: 'fixed the reported issue'
    })
  })

  it('a missing line reads absent, never a guessed number', () => {
    expect(parseConfidenceReply('')).toBe('absent')
  })

  it('an out-of-range value reads absent', () => {
    expect(parseConfidenceReply('CONFIDENCE: 101 — too high\n')).toBe('absent')
  })

  it('a reason longer than the schema bound is truncated to it, never dropped or left to fail validation downstream', () => {
    const longReason = 'x'.repeat(CONFIDENCE_REASON_MAX_LENGTH + 50)
    const result = parseConfidenceReply(`CONFIDENCE: 80 — ${longReason}\n`)
    expect(result).not.toBe('absent')
    if (result === 'absent') throw new Error('unreachable')
    expect(result.reason).toHaveLength(CONFIDENCE_REASON_MAX_LENGTH)
    expect(result.reason).toBe(longReason.slice(0, CONFIDENCE_REASON_MAX_LENGTH))
  })

  it('a reason exactly at the bound is kept whole', () => {
    const exactReason = 'y'.repeat(CONFIDENCE_REASON_MAX_LENGTH)
    const result = parseConfidenceReply(`CONFIDENCE: 80 — ${exactReason}\n`)
    expect(result).not.toBe('absent')
    if (result === 'absent') throw new Error('unreachable')
    expect(result.reason).toBe(exactReason)
  })
})
