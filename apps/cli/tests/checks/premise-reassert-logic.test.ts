import { describe, expect, it } from 'bun:test'
import { reassertPremiseFile } from '../../src/checks/premise-reassert-logic'

const CHECK_NAME = 'dispatch-readiness'

function bodyWithPin(pinLine: string): string {
  return ['## Premise pins', '', '**Premise:**', `- ${pinLine}`, ''].join('\n')
}

describe('reassertPremiseFile', () => {
  it('pass case: a `contains` pin that matches the reader-supplied content passes with no errors', () => {
    const body = bodyWithPin('src/thing.ts contains: export function thing')
    const files: Record<string, string> = { 'src/thing.ts': 'export function thing() {}\n' }
    const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, (p) => files[p] ?? null)
    expect(result).toEqual({ pass: true, errors: [] })
  })

  it('fail case: a `contains` pin whose literal is no longer present fails, naming the pin', () => {
    const body = bodyWithPin('src/thing.ts contains: export function thing')
    const files: Record<string, string> = { 'src/thing.ts': 'export function somethingElse() {}\n' }
    const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, (p) => files[p] ?? null)
    expect(result.pass).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.check).toBe(CHECK_NAME)
    expect(result.errors[0]?.severity).toBe('error')
    expect(result.errors[0]?.message).toContain('dispatch-gate premise:')
    expect(result.errors[0]?.message).toContain('src/thing.ts')
    expect(result.errors[0]?.message).toContain('export function thing')
  })

  it('missing-file case: PREMISE_FILE itself could not be read (body is null) fails with one path-naming error', () => {
    const result = reassertPremiseFile(CHECK_NAME, '/tmp/does-not-exist.md', null, () => null)
    expect(result.pass).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('/tmp/does-not-exist.md')
    expect(result.errors[0]?.message).toContain('does not exist or is unreadable')
  })

  it('no-pins case: a file with no `Premise:` assertions fails rather than passing vacuously', () => {
    const body = ['## Summary', '', 'No premise block here at all.', ''].join('\n')
    const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, () => null)
    expect(result.pass).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('carries no `Premise:` assertions')
  })

  it('multiple failed pins each produce their own error, all pass:false', () => {
    const body = ['**Premise:**', '- src/a.ts contains: foo', '- src/b.ts absent: bar', ''].join('\n')
    const files: Record<string, string> = { 'src/a.ts': 'nothing relevant here', 'src/b.ts': 'this has bar in it' }
    const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, (p) => files[p] ?? null)
    expect(result.pass).toBe(false)
    expect(result.errors).toHaveLength(2)
    for (const error of result.errors) {
      expect(error.check).toBe(CHECK_NAME)
      expect(error.agent_recovery_prompt).toContain('re-dig')
    }
  })
})
