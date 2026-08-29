import { describe, expect, it } from 'vitest'
import { resolveMeteringCapability, summarizeTranscript } from './claude-code-transcript'
import type { MeteringCapabilityDeps } from './claude-code-transcript'
import { formatTokensLine } from './report-tokens'

function assistantLine(opts: {
  id: string
  model: string
  input: number
  output: number
  cacheCreation?: number
  cacheRead?: number
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: opts.id,
      model: opts.model,
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        cache_creation_input_tokens: opts.cacheCreation ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0
      }
    }
  })
}

describe('summarizeTranscript', () => {
  it('sums usage across unique assistant messages', () => {
    const jsonl = [
      assistantLine({ id: 'msg_1', model: 'claude-sonnet-5', input: 100, output: 50, cacheCreation: 10, cacheRead: 5 }),
      assistantLine({ id: 'msg_2', model: 'claude-sonnet-5', input: 20, output: 30, cacheCreation: 0, cacheRead: 1000 })
    ].join('\n')

    const summary = summarizeTranscript(jsonl)
    expect(summary.messageCount).toBe(2)
    expect(summary.model).toBe('claude-sonnet-5')
    expect(summary.components).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 1005
    })
  })

  it('dedups repeated JSONL entries sharing one message.id — a real turn split across content blocks', () => {
    // Mirrors the shape confirmed against a live transcript: one API turn
    // (thinking + tool_use blocks) becomes multiple JSONL lines that all
    // carry an identical copy of that turn's usage.
    const repeatedUsage = {
      id: 'msg_shared',
      model: 'claude-sonnet-5',
      input: 2,
      output: 100,
      cacheCreation: 59671,
      cacheRead: 0
    }
    const jsonl = [assistantLine(repeatedUsage), assistantLine(repeatedUsage), assistantLine(repeatedUsage)].join('\n')

    const summary = summarizeTranscript(jsonl)
    expect(summary.messageCount).toBe(1)
    expect(summary.components).toEqual({
      inputTokens: 2,
      outputTokens: 100,
      cacheCreationInputTokens: 59671,
      cacheReadInputTokens: 0
    })
  })

  it('takes the most recent model id across a session', () => {
    const jsonl = [
      assistantLine({ id: 'msg_1', model: 'claude-haiku-4-5', input: 1, output: 1 }),
      assistantLine({ id: 'msg_2', model: 'claude-sonnet-5', input: 1, output: 1 })
    ].join('\n')

    expect(summarizeTranscript(jsonl).model).toBe('claude-sonnet-5')
  })

  it('skips lines that are not JSON, not assistant-typed, or missing an id/usage', () => {
    const jsonl = [
      'not json at all',
      JSON.stringify({ type: 'user', message: { id: 'msg_1', usage: { input_tokens: 1 } } }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5' } }), // no id/usage
      assistantLine({ id: 'msg_2', model: 'claude-sonnet-5', input: 5, output: 5 })
    ].join('\n')

    const summary = summarizeTranscript(jsonl)
    expect(summary.messageCount).toBe(1)
    expect(summary.components.inputTokens).toBe(5)
  })

  it('returns a zeroed summary with a null model for an empty transcript', () => {
    const summary = summarizeTranscript('')
    expect(summary.messageCount).toBe(0)
    expect(summary.model).toBeNull()
    expect(summary.components).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    })
  })
})

describe('the adapter seam', () => {
  // The point of splitting this module out of `report-tokens.ts`: what
  // crosses the boundary is a `TranscriptSummary`, so the portable renderer
  // accepts one built by hand exactly as it accepts one this adapter
  // produced. That equivalence is what an adopter on another harness relies
  // on when they implement collection themselves and reuse everything else.
  it('renders an adapter-produced summary and a hand-built one identically', () => {
    const fromAdapter = summarizeTranscript(
      assistantLine({ id: 'msg_1', model: 'claude-sonnet-5', input: 100, output: 50, cacheCreation: 10, cacheRead: 5 })
    )
    const handBuilt = {
      components: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 5 },
      model: 'claude-sonnet-5',
      messageCount: 1
    }

    const args = { phase: '113: develop', role: 'Developer' }
    expect(formatTokensLine({ ...args, summary: fromAdapter })).toBe(formatTokensLine({ ...args, summary: handBuilt }))
  })
})

describe('resolveMeteringCapability', () => {
  // Fake fs/env — the point of deps-injection: no real file, no real
  // process.env, but the exact same resolution logic runs.
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

  it('is incapable with no-transcript-resolved when no --transcript and no pointer file exists', () => {
    const result = resolveMeteringCapability(fakeDeps())
    expect(result.capable).toBe(false)
    if (!result.capable) expect(result.reason).toBe('no-transcript-resolved')
  })

  it('is incapable with transcript-unreadable when an explicit path does not exist', () => {
    const result = resolveMeteringCapability(fakeDeps({ exists: () => false }), '/tmp/does-not-exist.jsonl')
    expect(result.capable).toBe(false)
    if (!result.capable) expect(result.reason).toBe('transcript-unreadable')
  })

  it('is incapable with transcript-unreadable when the resolved file throws on read', () => {
    const result = resolveMeteringCapability(
      fakeDeps({
        exists: () => true,
        readFile: () => {
          throw new Error('EACCES: permission denied')
        }
      }),
      '/tmp/locked.jsonl'
    )
    expect(result.capable).toBe(false)
    if (!result.capable) expect(result.reason).toBe('transcript-unreadable')
  })

  it('is incapable with transcript-empty when the transcript summarizes to zero messages', () => {
    const result = resolveMeteringCapability(fakeDeps({ exists: () => true, readFile: () => '' }), '/tmp/empty.jsonl')
    expect(result.capable).toBe(false)
    if (!result.capable) expect(result.reason).toBe('transcript-empty')
  })

  it('is capable and returns the real summary when an explicit transcript resolves and reads', () => {
    const jsonl = assistantLine({ id: 'msg_1', model: 'claude-sonnet-5', input: 10, output: 5 })
    const result = resolveMeteringCapability(fakeDeps({ exists: () => true, readFile: () => jsonl }), '/tmp/real.jsonl')
    expect(result.capable).toBe(true)
    if (result.capable) {
      expect(result.transcriptPath).toBe('/tmp/real.jsonl')
      expect(result.summary.messageCount).toBe(1)
    }
  })

  it('resolves via the Stop-hook pointer file when no explicit path is given', () => {
    const pointerPath = '/tmp/claude-transcript--repo.txt'
    const jsonl = assistantLine({ id: 'msg_1', model: 'claude-sonnet-5', input: 10, output: 5 })
    const files: Record<string, string> = {
      [pointerPath]: 'session-a\t/real/transcript.jsonl',
      '/real/transcript.jsonl': jsonl
    }
    const result = resolveMeteringCapability(
      fakeDeps({
        env: { TMPDIR: '/tmp' },
        cwd: '/repo',
        exists: (p) => p in files,
        readFile: (p) => {
          if (!(p in files)) throw new Error(`ENOENT: ${p}`)
          return files[p] as string
        }
      })
    )
    expect(result.capable).toBe(true)
    if (result.capable) expect(result.transcriptPath).toBe('/real/transcript.jsonl')
  })

  it('refuses a stale pointer whose recorded session id disagrees with the current one', () => {
    const pointerPath = '/tmp/claude-transcript--repo.txt'
    const files: Record<string, string> = {
      [pointerPath]: 'session-old\t/real/transcript.jsonl'
    }
    const result = resolveMeteringCapability(
      fakeDeps({
        env: { TMPDIR: '/tmp', CLAUDE_CODE_SESSION_ID: 'session-new' },
        cwd: '/repo',
        exists: (p) => p in files,
        readFile: (p) => {
          if (!(p in files)) throw new Error(`ENOENT: ${p}`)
          return files[p] as string
        }
      })
    )
    expect(result.capable).toBe(false)
    if (!result.capable) expect(result.reason).toBe('no-transcript-resolved')
  })

  it('explicit --transcript wins outright over a resolvable pointer file', () => {
    const pointerPath = '/tmp/claude-transcript--repo.txt'
    const pointerTranscript = assistantLine({ id: 'msg_pointer', model: 'claude-sonnet-5', input: 1, output: 1 })
    const explicitTranscript = assistantLine({ id: 'msg_explicit', model: 'claude-sonnet-5', input: 2, output: 2 })
    const files: Record<string, string> = {
      [pointerPath]: 'session-a\t/pointer/transcript.jsonl',
      '/pointer/transcript.jsonl': pointerTranscript,
      '/explicit/transcript.jsonl': explicitTranscript
    }
    const result = resolveMeteringCapability(
      fakeDeps({
        env: { TMPDIR: '/tmp' },
        cwd: '/repo',
        exists: (p) => p in files,
        readFile: (p) => {
          if (!(p in files)) throw new Error(`ENOENT: ${p}`)
          return files[p] as string
        }
      }),
      '/explicit/transcript.jsonl'
    )
    expect(result.capable).toBe(true)
    if (result.capable) expect(result.transcriptPath).toBe('/explicit/transcript.jsonl')
  })
})
