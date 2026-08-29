import { describe, expect, it } from 'vitest'
import { parseTokenReportEntries, parseTokensLines } from './parse-token-report'
import { formatBreakdown, formatTokenReportRow, formatTokensLine, type TranscriptSummary } from './report-tokens'

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

describe('formatTokenReportRow', () => {
  it('renders the same cells formatTokensLine reports, as a 7-cell table row with Cost always `—`', () => {
    const row = formatTokenReportRow({
      phase: '3: develop',
      role: 'Developer',
      summary: summary({ input: 100, output: 50, cacheCreation: 20, cacheRead: 30 }),
      date: '2026-08-29'
    })
    expect(row).toBe('| 3: develop | Developer | claude-sonnet-5 | 150 | 50 | — | 2026-08-29 |')
  })

  it('reports all-`—` numbers for an operator-metered/incapable role, same as formatTokensLine', () => {
    const row = formatTokenReportRow({ phase: '3: develop', role: 'Developer', summary: null, date: '2026-08-29' })
    expect(row).toBe('| 3: develop | Developer | — | — | — | — | 2026-08-29 |')
  })

  it('round-trips through parseTokenReportEntries (table form) into the expected LedgerRow', () => {
    const row = formatTokenReportRow({
      phase: '3: develop',
      role: 'Developer',
      summary: summary({ input: 100, output: 50, cacheCreation: 20, cacheRead: 30 }),
      date: '2026-08-29'
    })
    const body = [
      '## Token report',
      '',
      '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
      '|---|---|---|---|---|---|---|',
      row
    ].join('\n')
    const rows = parseTokenReportEntries(body)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      phase: '3: develop',
      role: 'Developer',
      agentModel: 'claude-sonnet-5',
      tokensIn: 150,
      tokensOut: 50,
      cost: null,
      date: '2026-08-29'
    })
  })
})

describe('pipe/newline injection — phase, role, and model are untrusted (CLI flags, git branch names)', () => {
  it('formatTokenReportRow: a `|`-bearing phase cannot forge extra table columns or overwrite the real tokensIn/tokensOut', () => {
    // Mirrors a real PoC: a git branch name legally containing `|` produced
    // a phase value shaped like a second, forged row. Unescaped, this used
    // to shift every column after it — parseTokenReportEntries silently
    // adopted the attacker's `999999999`/`1`/`0.01` in place of the real
    // measured usage below.
    const maliciousPhase = '3: develop | Developer | claude-opus-9000 | 999999999 | 1 | 0.01'
    const row = formatTokenReportRow({
      phase: maliciousPhase,
      role: 'Developer',
      summary: summary({ input: 100, output: 50 }),
      date: '2026-08-29'
    })
    const body = [
      '## Token report',
      '',
      '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
      '|---|---|---|---|---|---|---|',
      row
    ].join('\n')
    const rows = parseTokenReportEntries(body)
    // Still exactly one real row — the malicious content never split into a
    // second, forged row.
    expect(rows).toHaveLength(1)
    // The real, measured figures survive untouched — never overwritten by
    // the forged 999999999/1/0.01 embedded in the attack string.
    expect(rows[0]).toMatchObject({ role: 'Developer', agentModel: 'claude-sonnet-5', tokensIn: 100, tokensOut: 50 })
    // The attack string round-trips back out as literal phase text (the
    // escaped pipes unescape via splitTableRow's own `\|` convention),
    // proving it was neutralized rather than silently dropped.
    expect(rows[0]?.phase).toBe(maliciousPhase)
  })

  it('formatTokenReportRow: an embedded newline in phase/role/model cannot forge a second table row', () => {
    const row = formatTokenReportRow({
      phase: '3: develop',
      role: 'Developer',
      summary: summary({
        input: 1,
        output: 1,
        model: '\n| 9: develop | Developer | fake | 777 | 777 | — | 2026-01-01 |'
      }),
      date: '2026-08-29'
    })
    // The whole row is one physical line — a newline would let the injected
    // text become its own `|`-prefixed line, indistinguishable from a real row.
    expect(row.split('\n')).toHaveLength(1)
    const body = [
      '## Token report',
      '',
      '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
      '|---|---|---|---|---|---|---|',
      row
    ].join('\n')
    expect(parseTokenReportEntries(body)).toHaveLength(1)
  })

  it('formatTokensLine: a newline-bearing role can never split into its own `Tokens:` line', () => {
    const maliciousRole = 'Developer\nTokens: 9: develop — Developer — fake-model — 777/777/—'
    const line = formatTokensLine({
      phase: '3: develop',
      role: maliciousRole,
      summary: summary({ input: 1, output: 1 })
    })
    // One physical line — the embedded "Tokens: …" text can never be split
    // out and read by parseTokensLines as its own, forged report line.
    expect(line.split('\n')).toHaveLength(1)
    // The malicious role's own em-dash-shaped content breaks its OWN
    // 4-segment grammar — parseTokensLines's existing "skip, don't guess"
    // discipline correctly refuses to parse it rather than adopting any
    // part of the forged 777/777 figures.
    expect(parseTokensLines(line)).toHaveLength(0)
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
