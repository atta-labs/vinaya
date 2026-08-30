import { describe, expect, it } from 'bun:test'
import type { MeteringCapability } from '@attalabs/aeg-core'
import { evaluateTokenCollectionWiring } from '../../src/checks/token-collection-wiring-logic'

const CHECK_NAME = 'token-collection-wired'

describe('evaluateTokenCollectionWiring', () => {
  it('capable + resolvable: passes', () => {
    const capability: MeteringCapability = {
      capable: true,
      transcriptPath: '/tmp/session.jsonl',
      summary: {
        components: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        model: 'claude',
        messageCount: 1
      }
    }
    expect(evaluateTokenCollectionWiring(CHECK_NAME, capability)).toEqual({ pass: true })
  })

  it('incapable, no-transcript-resolved: passes (sanctioned operator-metered case)', () => {
    const capability: MeteringCapability = {
      capable: false,
      reason: 'no-transcript-resolved',
      detail: 'No transcript pointer at /tmp/claude-transcript-x.txt and no --transcript given.'
    }
    expect(evaluateTokenCollectionWiring(CHECK_NAME, capability)).toEqual({ pass: true })
  })

  it('capable-but-unresolvable, transcript-unreadable: fails, naming the wiring', () => {
    const capability: MeteringCapability = {
      capable: false,
      reason: 'transcript-unreadable',
      detail: 'Resolved transcript path /home/x/session.jsonl does not exist.'
    }
    const result = evaluateTokenCollectionWiring(CHECK_NAME, capability)
    expect(result.pass).toBe(false)
    if (result.pass) throw new Error('unreachable')
    expect(result.error.check).toBe(CHECK_NAME)
    expect(result.error.severity).toBe('error')
    expect(result.error.message).toContain('token-collection-wired:')
    expect(result.error.message).toContain('transcript-unreadable')
    expect(result.error.message).toContain('does not exist')
    expect(result.error.agent_recovery_prompt).not.toContain('agent declined')
  })

  it('capable-but-unresolvable, transcript-empty: fails, naming the wiring', () => {
    const capability: MeteringCapability = {
      capable: false,
      reason: 'transcript-empty',
      detail: 'Transcript at /home/x/session.jsonl yielded zero assistant messages with usage data.'
    }
    const result = evaluateTokenCollectionWiring(CHECK_NAME, capability)
    expect(result.pass).toBe(false)
    if (result.pass) throw new Error('unreachable')
    expect(result.error.message).toContain('transcript-empty')
  })

  it('never names the agent in the failure message — only the wiring', () => {
    const capability: MeteringCapability = {
      capable: false,
      reason: 'transcript-unreadable',
      detail: 'Resolved transcript path /tmp/whatever.jsonl does not exist.'
    }
    const result = evaluateTokenCollectionWiring(CHECK_NAME, capability)
    expect(result.pass).toBe(false)
    if (result.pass) throw new Error('unreachable')
    expect(result.error.message.toLowerCase()).not.toContain('agent')
  })
})
