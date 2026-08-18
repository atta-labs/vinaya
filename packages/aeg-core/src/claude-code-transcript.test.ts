import { describe, expect, it } from 'vitest'
import { summarizeTranscript } from './claude-code-transcript'
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
