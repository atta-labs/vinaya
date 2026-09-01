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

  it('formatTokensLine: a newline-and-em-dash-bearing role can never split into its own forged `Tokens:` line', () => {
    const maliciousRole = 'Developer\nTokens: 9: develop — Developer — fake-model — 777/777/—'
    const line = formatTokensLine({
      phase: '3: develop',
      role: maliciousRole,
      summary: summary({ input: 1, output: 1 })
    })
    // One physical line — the embedded "Tokens: …" text can never be split
    // out and read by parseTokensLines as its own, forged report line.
    expect(line.split('\n')).toHaveLength(1)
    const rows = parseTokensLines(line)
    // Parses as exactly one real row — every whitespace-flanked dash-like
    // character in the injected payload is substituted for a non-matching
    // lookalike, so none of it can act as a segment boundary; the whole
    // thing lands as inert literal text inside the role field, never as a
    // second row. ("fake-model"'s own hyphen is never hazardous and stays
    // literal — this only proves the SEGMENT_SEP-shaped parts are defanged.)
    expect(rows).toHaveLength(1)
    // The real, measured figures survive untouched — the forged 777/777
    // never reaches tokensIn/tokensOut.
    expect(rows[0]).toMatchObject({ phase: '3: develop', tokensIn: 1, tokensOut: 1 })
    // No whitespace-flanked dash (the actual hazardous shape) survives —
    // every em-dash in the payload, all whitespace-flanked, is neutralized.
    expect(rows[0]?.role).not.toMatch(/\s[-–—]\s/)
  })

  it("formatTokensLine: an attacker-shaped `model` field (`#313`'s own reproduction) never carries a real `|` out", () => {
    // The exact string a security reviewer's live reproduction produced at
    // `#313`'s authoring: a transcript's `message.model` read
    // `attacker-injected | evil-injected-cell | extra`, and the resulting
    // `Tokens: …` line carried the raw `|` characters straight through.
    // `formatTokenReportRow`'s own table cell already escaped `|` (tested
    // above); this line has no such reader, so it is neutralized with the
    // same same-glyph-lookalike approach `DASH_LOOKALIKES` already uses,
    // rather than a `\|` escape nothing here would ever unescape.
    const maliciousModel = 'attacker-injected | evil-injected-cell | extra'
    const line = formatTokensLine({
      phase: '313: develop',
      role: 'Developer',
      summary: summary({ input: 5, output: 7, model: maliciousModel })
    })
    expect(line).not.toContain('|')
    expect(line).toContain('attacker-injected ｜ evil-injected-cell ｜ extra')
    // And the real, measured figures are exactly the five/seven a naive
    // pipe-split of the model field could otherwise have shifted.
    expect(line.endsWith('5/7/—')).toBe(true)
  })

  it('formatTokensLine: an entirely ordinary hyphenated phase — no attacker needed — no longer discards the real usage', () => {
    // Reported live: `vinaya tokens --phase "9 - fix token report edge case"
    // --role Developer --in 2417499 --out 25604` produced a line
    // `parseTokensLines` returned zero rows for — SEGMENT_SEP
    // (`/\s+[—–-]\s+/`) matched the ordinary " - " inside the phase itself,
    // splitting it into 5 segments instead of 4, and the whole line was
    // silently skipped rather than misparsed. Same root cause as the
    // table-row `|` gap, different (unescapable) delimiter.
    const line = formatTokensLine({
      phase: '9 - fix token report edge case',
      role: 'Developer',
      summary: summary({ input: 2392895, output: 25604, cacheCreation: 20000, cacheRead: 4604 })
    })
    const rows = parseTokensLines(line)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'Developer', tokensIn: 2417499, tokensOut: 25604 })
    // The dash survives as a lookalike character, spacing UNCHANGED — legible, not silently dropped.
    expect(rows[0]?.phase).toBe('9 ‑ fix token report edge case')
  })

  it('formatTokensLine: only a whitespace-flanked dash is neutralized — an ordinary hyphenated word stays untouched', () => {
    const line = formatTokensLine({
      phase: '3: develop',
      role: 'on-call – Developer',
      summary: summary({ input: 1, output: 1, model: 'claude – opus' })
    })
    const rows = parseTokensLines(line)
    expect(rows).toHaveLength(1)
    // The en-dash (whitespace on both sides) is substituted; "on-call"'s own
    // hyphen (letters on both sides, never reachable by SEGMENT_SEP) is not.
    expect(rows[0]).toMatchObject({
      role: 'on-call ‒ Developer',
      agentModel: 'claude ‒ opus',
      tokensIn: 1,
      tokensOut: 1
    })
  })

  it('formatTokensLine: an ordinary hyphenated model id (never whitespace-flanked) is never mangled', () => {
    // A whole-field substitution (an earlier draft of this fix) replaced
    // every hyphen regardless of context, which would have broken every
    // real model id shaped like this — none of them are hazardous, since
    // none of their hyphens ever sit next to whitespace or a field edge.
    const line = formatTokensLine({
      phase: '3: develop',
      role: 'Developer',
      summary: summary({ input: 1, output: 1, model: 'claude-sonnet-5-20260101' })
    })
    expect(line).toContain('claude-sonnet-5-20260101')
    const rows = parseTokensLines(line)
    expect(rows[0]?.agentModel).toBe('claude-sonnet-5-20260101')
  })

  it("formatTokensLine: a dash at a field's own EDGE cannot recombine with the join's own separator whitespace — round three-B, the previous field-local fix missed this", () => {
    // Reported live: `--phase "9 -" --role "Dev -"` — neither field has a
    // dash with whitespace on BOTH sides internally (the earlier de-spacing
    // fix only ever looked inside one field at a time), but the trailing
    // `" -"` combines with the template's own leading `" — "` between
    // fields to read back as `"...9 - — ..."`, a real SEGMENT_SEP match
    // spanning the boundary — silently dropping the real usage. A
    // character-substitution fix (rather than a whitespace-position fix)
    // closes this by construction: there is no longer a matchable dash
    // character anywhere in the field, so no position — start, middle, end,
    // or a join boundary — can ever reconstruct the pattern.
    const line = formatTokensLine({
      phase: '9 -',
      role: 'Dev -',
      summary: summary({ input: 555, output: 666 })
    })
    const rows = parseTokensLines(line)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tokensIn: 555, tokensOut: 666 })
  })

  it('formatTokensLine: two previously-colliding phases stay distinguishable — one never touched, one substituted', () => {
    // The de-spacing approach this replaces was lossy: "9-fix" and
    // "9 - fix" both sanitized to the byte-identical "9-fix", so two
    // genuinely different phase labels became indistinguishable in the
    // ledger. "9-fix"'s hyphen is never hazardous (letters/digits on both
    // sides) and is left exactly as written; "9 - fix"'s is whitespace-
    // flanked and gets substituted — the two stay distinct either way.
    const a = formatTokensLine({ phase: '9-fix', role: 'Developer', summary: summary({ input: 1, output: 1 }) })
    const b = formatTokensLine({ phase: '9 - fix', role: 'Developer', summary: summary({ input: 1, output: 1 }) })
    expect(a).not.toBe(b)
    const rowA = parseTokensLines(a)[0]
    const rowB = parseTokensLines(b)[0]
    expect(rowA?.phase).toBe('9-fix')
    expect(rowB?.phase).toBe('9 ‑ fix')
    expect(rowA?.phase).not.toBe(rowB?.phase)
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
