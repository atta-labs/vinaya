import { describe, expect, it } from 'bun:test'
import type { MeteringCapability } from '@attalabs/aeg-core'
import { evaluateTokenReportEnforcement } from '../../src/checks/token-report-enforcement-logic'

const CHECK_NAME = 'token-report'

const CAPABLE: MeteringCapability = {
  capable: true,
  transcriptPath: '/tmp/session.jsonl',
  summary: {
    components: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    model: 'claude',
    messageCount: 1
  }
}

const INCAPABLE: MeteringCapability = {
  capable: false,
  reason: 'no-transcript-resolved',
  detail: 'No transcript pointer at /tmp/claude-transcript-x.txt and no --transcript given.'
}

const PRESENT_BODY = `## Summary

Shipped the thing.

## Token report

| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
| --- | --- | --- | --- | --- | --- | --- |
| 4: develop | Developer | claude-sonnet-5 (CC) | 184327 | 22190 | — | 2026-09-01 |
`

const BLANK_BODY = `## Summary

Shipped the thing.

## Token report

| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
| --- | --- | --- | --- | --- | --- | --- |
| 4: develop | Developer | claude-sonnet-5 (CC) | — | — | — | 2026-09-01 |
`

describe('evaluateTokenReportEnforcement', () => {
  it('capable + present numeric cells: passes', () => {
    expect(evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, PRESENT_BODY)).toEqual({ pass: true })
  })

  it('capable + blank Tokens in/out: fails, naming presence/shape only', () => {
    const result = evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, BLANK_BODY)
    expect(result.pass).toBe(false)
    if (result.pass) throw new Error('unreachable')
    expect(result.error.check).toBe(CHECK_NAME)
    expect(result.error.severity).toBe('error')
    expect(result.error.message).toContain('token-report:')
    expect(result.error.message).toMatch(/never whether/i)
  })

  it('empty PR_BODY (no PR yet — likely a local invocation): passes, regardless of capability', () => {
    expect(evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, '')).toEqual({ pass: true })
  })

  it('capable + no "Token report" section at all: fails on presence', () => {
    const result = evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, '## Summary\n\nShipped the thing.\n')
    expect(result.pass).toBe(false)
    if (result.pass) throw new Error('unreachable')
    expect(result.error.message).toContain('no "Token report" row')
  })

  it('incapable + a row present (even all "—" cells): passes — the sanctioned operator-metered shape', () => {
    expect(evaluateTokenReportEnforcement(CHECK_NAME, INCAPABLE, BLANK_BODY)).toEqual({ pass: true })
  })

  it('empty PR_BODY still passes regardless of capability, before the row check ever runs', () => {
    expect(evaluateTokenReportEnforcement(CHECK_NAME, INCAPABLE, '')).toEqual({ pass: true })
  })

  // O13 — the silent hole this task closes: before this fix, `!capability.capable`
  // returned `pass: true` BEFORE the entries.length check ever ran, so a merged
  // task PR on an incapable host could carry no "## Token report" section at
  // all and still pass. `tranche-model.md` §12: the operator-metered case
  // writes `—` in a row — never omits the section.
  it('O13: incapable + NO "Token report" section at all: fails — a silent hole is never sanctioned', () => {
    const result = evaluateTokenReportEnforcement(CHECK_NAME, INCAPABLE, '## Summary\n\nShipped the thing.\n')
    expect(result.pass).toBe(false)
    if (result.pass) throw new Error('unreachable')
    expect(result.error.message).toContain('no "Token report" row')
  })

  it("incapable for a wiring-defect reason still passes here — that is token-collection-wired's job, not this check's", () => {
    const wiringBroken: MeteringCapability = {
      capable: false,
      reason: 'transcript-unreadable',
      detail: 'Resolved transcript path /home/x/session.jsonl does not exist.'
    }
    expect(evaluateTokenReportEnforcement(CHECK_NAME, wiringBroken, BLANK_BODY)).toEqual({ pass: true })
  })

  it('Cost cell exemption: capable + numeric Tokens in/out + Cost "—" passes', () => {
    const body = `## Token report

| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
| --- | --- | --- | --- | --- | --- | --- |
| 4: develop | Developer | claude-sonnet-5 (CC) | 184327 | 22190 | — | 2026-09-01 |
`
    expect(evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, body)).toEqual({ pass: true })
  })

  it('a re-pushed PR with two Token report entries fails if EITHER entry has a blank cell', () => {
    const body = `${PRESENT_BODY}

## Token report

| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |
| --- | --- | --- | --- | --- | --- | --- |
| 4: develop | Developer | claude-sonnet-5 (CC) | — | — | — | 2026-09-02 |
`
    const result = evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, body)
    expect(result.pass).toBe(false)
  })

  it('never claims the figures are verified correct — presence/shape only, in both failure messages', () => {
    const missing = evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, '## Summary\n\nShipped the thing.\n')
    const blank = evaluateTokenReportEnforcement(CHECK_NAME, CAPABLE, BLANK_BODY)
    for (const result of [missing, blank]) {
      expect(result.pass).toBe(false)
      if (result.pass) throw new Error('unreachable')
      expect(result.error.message).toMatch(/never whether/i)
    }
  })
})
