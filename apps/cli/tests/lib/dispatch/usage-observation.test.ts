/**
 * O2 — the vendor-level `usage` observation (input/output/cache, honest
 * `unknownReason`) `dispatchRole` now logs alongside its pre-existing
 * `usage` field. Pure unit tests, no spawn: `apps/cli/tests/lib/dispatch.test.ts`
 * and `apps/cli/tests/lib/dev-review-loop.test.ts` already exercise these
 * through a real dispatched attempt end to end.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyRoleAttemptOutcome,
  parseClaudeUsageUnits,
  parseCodexUsageUnits,
  parseGeminiUsageUnits
} from '../../../src/lib/dispatch.js'

describe('parseClaudeUsageUnits', () => {
  it('sums cache_creation_input_tokens and cache_read_input_tokens into one cache figure', () => {
    const stdout = JSON.stringify({
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 30, cache_read_input_tokens: 12 }
    })
    expect(parseClaudeUsageUnits(stdout)).toEqual({
      units: { input: 100, output: 50, cache: 42 },
      unknownReason: null
    })
  })

  it('treats an absent cache field as zero, not unknown — the usage object itself DID parse', () => {
    const stdout = JSON.stringify({ usage: { input_tokens: 5, output_tokens: 2 } })
    expect(parseClaudeUsageUnits(stdout)).toEqual({ units: { input: 5, output: 2, cache: 0 }, unknownReason: null })
  })

  it('an unparseable stream reports null units with an explicit reason, never a fabricated zero', () => {
    const result = parseClaudeUsageUnits('not json\nalso not json')
    expect(result.units).toEqual({ input: null, output: null, cache: null })
    expect(result.unknownReason).toMatch(/no.*stream-json line/)
  })

  it('scans from the end, matching parseClaudeUsage’s own precedent', () => {
    const stdout = [
      JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }),
      JSON.stringify({ usage: { input_tokens: 999, output_tokens: 888, cache_read_input_tokens: 7 } })
    ].join('\n')
    expect(parseClaudeUsageUnits(stdout).units).toEqual({ input: 999, output: 888, cache: 7 })
  })
})

describe('parseCodexUsageUnits', () => {
  it('reads input/output from the terminal turn.completed event', () => {
    const stdout = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } })
    expect(parseCodexUsageUnits(stdout)).toEqual({ units: { input: 20, output: 10, cache: null }, unknownReason: null })
  })

  it('reads cached_input_tokens when present', () => {
    const stdout = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: 4 }
    })
    expect(parseCodexUsageUnits(stdout).units).toEqual({ input: 20, output: 10, cache: 4 })
  })

  it('no turn.completed event at all: null units with an explicit reason', () => {
    const result = parseCodexUsageUnits(JSON.stringify({ type: 'turn.started' }))
    expect(result.units).toEqual({ input: null, output: null, cache: null })
    expect(result.unknownReason).toMatch(/turn\.completed/)
  })
})

describe('parseGeminiUsageUnits', () => {
  it('always reports the confirmed-unread per-model shape as an explicit unknown reason, never a guessed field', () => {
    const stdout = JSON.stringify({ stats: { models: { 'gemini-3.5-flash': { tokens: { input: 1, output: 1 } } } } })
    const result = parseGeminiUsageUnits(stdout)
    expect(result.units).toEqual({ input: null, output: null, cache: null })
    expect(result.unknownReason).toMatch(/stats\.models/)
  })
})

describe('classifyRoleAttemptOutcome — the generic launcher’s own honest classification', () => {
  it('refused takes precedence over every other signal', () => {
    expect(classifyRoleAttemptOutcome(true, true, true, 0)).toBe('capability_refused')
  })

  it('timed out, never refused, reads timed_out', () => {
    expect(classifyRoleAttemptOutcome(false, true, true, null)).toBe('timed_out')
  })

  it('a spawn/exit crash reads infrastructure_failed', () => {
    expect(classifyRoleAttemptOutcome(false, false, true, 1)).toBe('infrastructure_failed')
  })

  it('a clean exit 0 reads completed', () => {
    expect(classifyRoleAttemptOutcome(false, false, false, 0)).toBe('completed')
  })

  it('a non-zero exit with no other signal reads incomplete, never completed', () => {
    expect(classifyRoleAttemptOutcome(false, false, false, 1)).toBe('incomplete')
  })

  it('no exit code at all (never reached exit) reads incomplete', () => {
    expect(classifyRoleAttemptOutcome(false, false, false, null)).toBe('incomplete')
  })
})
