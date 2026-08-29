import type { MeteringCapabilityDeps } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import { buildTokensResult, parseArgs } from '../src/commands/tokens'

function assistantLine(opts: { id: string; model: string; input: number; output: number }): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: opts.id,
      model: opts.model,
      usage: { input_tokens: opts.input, output_tokens: opts.output }
    }
  })
}

function fakeDeps(overrides: Partial<MeteringCapabilityDeps> = {}): MeteringCapabilityDeps {
  return {
    env: {},
    cwd: '/repo',
    exists: () => false,
    readFile: () => {
      throw new Error('unexpected readFile call')
    },
    ...overrides
  }
}

describe('parseArgs', () => {
  it('requires --phase and --role', () => {
    expect(() => parseArgs(['--phase', '1: develop'])).toThrow()
    expect(() => parseArgs(['--role', 'Developer'])).toThrow()
  })

  it('parses phase/role/model/transcript', () => {
    const parsed = parseArgs([
      '--phase',
      '1: develop',
      '--role',
      'Developer',
      '--model',
      'claude-sonnet-5',
      '--transcript',
      '/tmp/x.jsonl'
    ])
    expect(parsed).toEqual({
      phase: '1: develop',
      role: 'Developer',
      model: 'claude-sonnet-5',
      transcriptPath: '/tmp/x.jsonl',
      tokensIn: undefined,
      tokensOut: undefined
    })
  })

  it('parses --in/--out as numbers', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer', '--in', '100', '--out', '50'])
    expect(parsed.tokensIn).toBe(100)
    expect(parsed.tokensOut).toBe(50)
  })

  it('refuses --in without --out and vice versa', () => {
    expect(() => parseArgs(['--phase', 'p', '--role', 'r', '--in', '10'])).toThrow()
    expect(() => parseArgs(['--phase', 'p', '--role', 'r', '--out', '10'])).toThrow()
  })

  it('refuses a negative or non-numeric --in', () => {
    expect(() => parseArgs(['--phase', 'p', '--role', 'r', '--in', '-1', '--out', '1'])).toThrow()
    expect(() => parseArgs(['--phase', 'p', '--role', 'r', '--in', 'nope', '--out', '1'])).toThrow()
  })
})

describe('buildTokensResult — manual entry', () => {
  it('renders --in/--out directly, never touching transcript resolution', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer', '--in', '100', '--out', '50'])
    const result = buildTokensResult(parsed, fakeDeps())
    expect(result.line).toBe('Tokens: 1: develop — Developer — — — 100/50/—')
  })

  it('honors --model as the model override for manual entry', () => {
    const parsed = parseArgs([
      '--phase',
      '1: develop',
      '--role',
      'Developer',
      '--model',
      'claude-sonnet-5',
      '--in',
      '10',
      '--out',
      '5'
    ])
    const result = buildTokensResult(parsed, fakeDeps())
    expect(result.line).toBe('Tokens: 1: develop — Developer — claude-sonnet-5 — 10/5/—')
  })
})

describe('buildTokensResult — transcript route', () => {
  it('prints a real Tokens: line from a resolvable explicit transcript', () => {
    const jsonl = assistantLine({ id: 'msg_1', model: 'claude-sonnet-5', input: 10, output: 5 })
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer', '--transcript', '/tmp/real.jsonl'])
    const result = buildTokensResult(parsed, fakeDeps({ exists: () => true, readFile: () => jsonl }))
    expect(result.line).toBe('Tokens: 1: develop — Developer — claude-sonnet-5 — 10/5/—')
    expect(result.breakdown).toBeDefined()
  })

  it('refuses rather than emitting 0/0/— when the transcript is empty', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer', '--transcript', '/tmp/empty.jsonl'])
    expect(() => buildTokensResult(parsed, fakeDeps({ exists: () => true, readFile: () => '' }))).toThrow(
      /transcript-empty/
    )
  })

  it('refuses with a clear message when no transcript resolves at all', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer'])
    expect(() => buildTokensResult(parsed, fakeDeps())).toThrow(/no-transcript-resolved/)
  })
})
