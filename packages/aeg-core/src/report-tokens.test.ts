import { describe, expect, it } from 'vitest'
import { parseTokensLines } from './parse-token-report'
import { formatBreakdown, formatTokensLine, type TranscriptSummary } from './report-tokens'

/**
 * Every fixture here is a hand-built `TranscriptSummary` — this suite never
 * imports a collection adapter, deliberately. `TranscriptSummary` is the seam
 * (`aeg-root/tranche-model.md` §12): an adopter on a harness AEG has never
 * seen implements collection themselves and reuses these renderers unchanged,
 * so the renderers must be provable without any host's transcript format in
 * sight. The Claude Code adapter's own tests live in
 * `claude-code-transcript.test.ts`, which additionally pins that what it
 * produces renders identically to a hand-built summary.
 */
function summary(opts: {
  input: number
  output: number
  cacheCreation?: number
  cacheRead?: number
  model?: string | null
  messageCount?: number
}): TranscriptSummary {
  return {
    components: {
      inputTokens: opts.input,
      outputTokens: opts.output,
      cacheCreationInputTokens: opts.cacheCreation ?? 0,
      cacheReadInputTokens: opts.cacheRead ?? 0
    },
    model: opts.model === undefined ? 'claude-sonnet-5' : opts.model,
    messageCount: opts.messageCount ?? 1
  }
}

describe('formatTokensLine', () => {
  it('sums the three input-side components into the single `Tokens in` cell, never blending in a guessed cost', () => {
    const line = formatTokensLine({
      phase: '1: develop',
      role: 'Developer',
      summary: summary({ input: 2848, output: 25604, cacheCreation: 147321, cacheRead: 2267330 })
    })
    expect(line).toBe('Tokens: 1: develop — Developer — claude-sonnet-5 — 2417499/25604/—')
  })

  it('reports the frozen all-`—` numbers segment for an operator-metered role, whose host exposes no usage', () => {
    const line = formatTokensLine({ phase: '1: review', role: 'Reviewer', summary: null })
    expect(line).toBe('Tokens: 1: review — Reviewer — — — —')
  })

  it('honors an explicit model override over the model the adapter derived', () => {
    const line = formatTokensLine({
      phase: '1: develop',
      role: 'Developer',
      summary: summary({ input: 1, output: 1 }),
      modelOverride: 'claude-opus-5 (CC)'
    })
    expect(line).toContain('claude-opus-5 (CC)')
  })
})

describe('round-trip through the real parser', () => {
  it('formatTokensLine output parses back through parseTokensLines to matching component values', () => {
    const line = formatTokensLine({
      phase: '1: develop',
      role: 'Developer',
      // 110 fresh input across two turns, plus 20 cache creation and 30 cache read.
      summary: summary({ input: 110, output: 55, cacheCreation: 20, cacheRead: 30, messageCount: 2 })
    })

    const rows = parseTokensLines(line)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      phase: '1: develop',
      role: 'Developer',
      agentModel: 'claude-sonnet-5',
      tokensIn: 160, // 110 fresh input + 20 cache creation + 30 cache read
      tokensOut: 55,
      cost: null
    })
  })

  it('round-trips the all-unknown line too', () => {
    const line = formatTokensLine({ phase: 'planning', role: 'Planner', summary: null })
    const rows = parseTokensLines(line)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ phase: 'planning', role: 'Planner', tokensIn: null, tokensOut: null, cost: null })
  })
})

describe('formatBreakdown', () => {
  it('reports every component separately, never a single conflated figure', () => {
    const breakdown = formatBreakdown(
      summary({ input: 2848, output: 25604, cacheCreation: 147321, cacheRead: 2267330 })
    )
    expect(breakdown).toContain('fresh input tokens:    2848')
    expect(breakdown).toContain('cache creation tokens: 147321')
    expect(breakdown).toContain('cache read tokens:     2267330')
    expect(breakdown).toContain('output tokens:         25604')
    expect(breakdown).toContain('messages summed:       1')
  })
})
