import { describe, expect, it } from 'vitest'
import { isTokenCollectionWiringBroken, resolveMeteringCapability, summarizeTranscript } from './claude-code-transcript'
import type { MeteringCapability, MeteringCapabilityDeps } from './claude-code-transcript'
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

  it('does not claim a stale pointer whose recorded session id disagrees with the current one', () => {
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
    // A pointer whose recorded id disagrees with ours is provably NOT this
    // session's, so it is the can't-claim-it case and passes.
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

/**
 * `#315`: `sanitizeKey` (unexported, still collision-prone by design — see
 * its own doc comment) collapses `/a/b` and `/a-b` to the same string, so
 * two repos checked out at colliding paths shared one pointer file, and a
 * pointer legitimately written by a session in the OTHER project could be
 * read by this one as its own — reaching `pointer-unusable`, which refuses a
 * commit. `transcriptPointerPath`/`legacyTranscriptPointerPath` are private,
 * so these tests observe the PRIMARY (new-format) pointer path indirectly —
 * the first path `resolvePointer` probes via `deps.exists` — rather than
 * importing them.
 */
describe('resolveMeteringCapability — pointer-key collision resistance (#315)', () => {
  function primaryPointerPathFor(projectDir: string): string {
    const probed: string[] = []
    resolveMeteringCapability({
      env: { TMPDIR: '/tmp', CLAUDE_PROJECT_DIR: projectDir },
      cwd: projectDir,
      exists: (p) => {
        probed.push(p)
        return false
      },
      readFile: () => {
        throw new Error('unexpected read')
      }
    })
    // resolvePointer probes the primary (new-format) path first, then the
    // legacy path — see the source doc comment on that ordering.
    expect(probed.length).toBe(2)
    return probed[0] as string
  }

  it("the Issue's exact example: /a/b and /a-b no longer share a pointer path", () => {
    expect(primaryPointerPathFor('/a/b')).not.toBe(primaryPointerPathFor('/a-b'))
  })

  it.each([
    ['/a/b', '/a_b'],
    ['/a/b', '/a..b'],
    ['/a/b', '//a/b']
  ])('%s and %s (colliding under the pre-#315 scheme) now probe distinct pointer paths', (x, y) => {
    expect(primaryPointerPathFor(x)).not.toBe(primaryPointerPathFor(y))
  })
})

/**
 * `#315` migration: a pointer the shipped Stop hook wrote under the
 * PRE-#315 (legacy) filename — `sanitizeKey` alone, no digest — must stay
 * readable once this fix ships, never orphaned. `resolvePointer` falls back
 * to that legacy name only when the new, collision-resistant name is
 * absent.
 */
describe('resolveMeteringCapability — legacy pointer migration (#315)', () => {
  const LEGACY_POINTER = '/tmp/claude-transcript--repo.txt' // sanitizeKey('/repo'), no digest suffix
  const TRANSCRIPT = '/tmp/session.jsonl'
  const REAL_JSONL = JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 } }
  })

  it('a pointer written under the OLD key format is still found and read correctly by the NEW code', () => {
    const files: Record<string, string> = {
      [LEGACY_POINTER]: `s1\t${TRANSCRIPT}`,
      [TRANSCRIPT]: REAL_JSONL
    }
    const result = resolveMeteringCapability({
      env: { TMPDIR: '/tmp', CLAUDE_PROJECT_DIR: '/repo', CLAUDE_CODE_SESSION_ID: 's1' },
      cwd: '/repo',
      exists: (p) => p in files,
      readFile: (p) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`)
        return files[p] as string
      }
    })
    // Nothing here is dropped silently — the legacy pointer resolves to a
    // real, corroborated, capable result, exactly as the new-format one would.
    expect(result.capable).toBe(true)
    if (result.capable) expect(result.transcriptPath).toBe(TRANSCRIPT)
  })
})

describe('isTokenCollectionWiringBroken', () => {
  it('capable: not broken', () => {
    const capability: MeteringCapability = {
      capable: true,
      transcriptPath: '/tmp/session.jsonl',
      summary: {
        components: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        model: null,
        messageCount: 1
      }
    }
    expect(isTokenCollectionWiringBroken(capability)).toBe(false)
  })

  it('no-transcript-resolved: not broken — nothing was ever wired to try', () => {
    const capability: MeteringCapability = { capable: false, reason: 'no-transcript-resolved', detail: 'no pointer' }
    expect(isTokenCollectionWiringBroken(capability)).toBe(false)
  })

  it('transcript-unreadable: broken — a wiring point resolved but reaching it failed', () => {
    const capability: MeteringCapability = { capable: false, reason: 'transcript-unreadable', detail: 'ENOENT' }
    expect(isTokenCollectionWiringBroken(capability)).toBe(true)
  })

  it('transcript-empty: broken — a wiring point resolved but yielded nothing', () => {
    const capability: MeteringCapability = { capable: false, reason: 'transcript-empty', detail: 'zero messages' }
    expect(isTokenCollectionWiringBroken(capability)).toBe(true)
  })
})

/**
 * Binds each `MeteringIncapableReason` to the REAL probe condition that
 * produces it, driving `resolveMeteringCapability` through fake deps rather
 * than constructing `MeteringCapability` literals by hand.
 *
 * This is the test whose absence hid a live defect: every existing predicate
 * test handed `isTokenCollectionWiringBroken` a reason it had chosen itself,
 * so none of them could notice that four distinct pointer conditions all
 * collapsed into `no-transcript-resolved` — three of them wired-but-unreachable
 * states the check exists to refuse. A reviewer found it by probing the built
 * binary; these cases move that probe into the suite.
 */
describe('reason ↔ probe condition, and what each means for the wiring gate', () => {
  const POINTER = '/tmp/claude-transcript--repo.txt'
  const TRANSCRIPT = '/tmp/session.jsonl'
  const REAL_JSONL = JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 } }
  })

  /** Pointer-file world: `TMPDIR`/`CLAUDE_PROJECT_DIR` fixed so the pointer path is deterministic. */
  function world(opts: {
    sessionId?: string
    pointer?: string | 'missing' | 'unreadable'
    transcript?: string | 'missing' | 'unreadable'
  }): MeteringCapabilityDeps {
    const env: Record<string, string | undefined> = { TMPDIR: '/tmp', CLAUDE_PROJECT_DIR: '/repo' }
    if (opts.sessionId) env.CLAUDE_CODE_SESSION_ID = opts.sessionId
    return {
      env,
      cwd: '/repo',
      exists: (p) => {
        if (p === POINTER) return opts.pointer !== 'missing' && opts.pointer !== undefined
        if (p === TRANSCRIPT) return opts.transcript !== 'missing' && opts.transcript !== undefined
        return false
      },
      readFile: (p) => {
        if (p === POINTER) {
          if (opts.pointer === 'unreadable') throw new Error('EACCES: permission denied')
          return opts.pointer as string
        }
        if (p === TRANSCRIPT) {
          if (opts.transcript === 'unreadable') throw new Error('EISDIR: illegal operation on a directory')
          return opts.transcript as string
        }
        throw new Error(`unexpected read: ${p}`)
      }
    }
  }

  const probe = (deps: MeteringCapabilityDeps) => resolveMeteringCapability(deps)

  it('capable — corroborated pointer naming a readable transcript with usage', () => {
    const r = probe(world({ sessionId: 's1', pointer: `s1\t${TRANSCRIPT}`, transcript: REAL_JSONL }))
    expect(r.capable).toBe(true)
    expect(isTokenCollectionWiringBroken(r)).toBe(false)
  })

  it('no pointer at all — the sanctioned operator-metered case, PASSES', () => {
    const r = probe(world({ sessionId: 's1', pointer: 'missing' }))
    expect(r.capable).toBe(false)
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('no-transcript-resolved')
    expect(isTokenCollectionWiringBroken(r)).toBe(false)
  })

  // Conditions an earlier revision passed silently. These two do NOT establish
  // corroboration and must not claim to: an unreadable pointer's id is never
  // read, and a malformed one carries none. They refuse on the other ground —
  // a file we own at our own pointer path that we cannot use, which is broken
  // wiring whoever wrote it. Hence no session id in the fixtures.
  it('pointer present but UNREADABLE — ours by location, wiring defect, FAILS', () => {
    const r = probe(world({ pointer: 'unreadable' }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('pointer-unusable')
    expect(isTokenCollectionWiringBroken(r)).toBe(true)
  })

  it('pointer present but MALFORMED — ours by location, FAILS with or without a session id', () => {
    expect(probe(world({ pointer: 'no-tab-no-path' })).capable).toBe(false)
    const r = probe(world({ sessionId: 's1', pointer: 'no-tab-no-path' }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('pointer-unusable')
    expect(isTokenCollectionWiringBroken(r)).toBe(true)
  })

  // Ruled 2026-08-31 after two reviewers disagreed. A stale pointer is provably
  // NOT this session's, so it is the can't-claim-it case, not a wiring defect:
  // refusing it blocks a second session's very first commit — its own Stop hook
  // fires only after its first turn completes — with no action that clears the
  // refusal, since `vinaya check` accepts no `--transcript`.
  it('pointer present but STALE for this session — not ours to claim, PASSES', () => {
    const r = probe(world({ sessionId: 's2', pointer: `s1\t${TRANSCRIPT}`, transcript: REAL_JSONL }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('no-transcript-resolved')
    expect(isTokenCollectionWiringBroken(r)).toBe(false)
  })

  it('corroborated pointer naming a MISSING transcript — wiring defect, FAILS', () => {
    const r = probe(world({ sessionId: 's1', pointer: `s1\t${TRANSCRIPT}`, transcript: 'missing' }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('transcript-unreadable')
    expect(isTokenCollectionWiringBroken(r)).toBe(true)
  })

  it('corroborated pointer naming an EMPTY transcript — wiring defect, FAILS', () => {
    const r = probe(world({ sessionId: 's1', pointer: `s1\t${TRANSCRIPT}`, transcript: '' }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('transcript-empty')
    expect(isTokenCollectionWiringBroken(r)).toBe(true)
  })

  // The false positive: a plain human terminal has no session id, so a pointer
  // left by an earlier session cannot be shown to be theirs. Refusing their
  // commit over it is the expensive failure `#272` names.
  it('UNCORROBORATED pointer (no session id) naming a missing transcript — PASSES, not the human’s problem', () => {
    const r = probe(world({ pointer: `s1\t${TRANSCRIPT}`, transcript: 'missing' }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('no-transcript-resolved')
    expect(isTokenCollectionWiringBroken(r)).toBe(false)
  })

  it('a degraded verdict carries a detail consistent with its reason, never a contradictory one', () => {
    const r = probe(world({ pointer: `s1\t${TRANSCRIPT}`, transcript: 'missing' }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('no-transcript-resolved')
    expect(r.detail).toContain('could not be shown to belong to this session')
  })

  // The BLOCKER a reviewer proved end to end against the real Stop hook body.
  // The hook writes `(session_id || "") + "\t" + path`, so a Stop payload with
  // no session id yields a pointer beginning with a TAB. `.trim()` ate it, the
  // split found no separator, and a pointer naming a present, readable,
  // summarizable transcript was called malformed — refusing every commit on a
  // host that meters perfectly.
  it('a pointer with an EMPTY session-id field still resolves — the leading tab survives', () => {
    const r = probe(world({ pointer: `\t${TRANSCRIPT}`, transcript: REAL_JSONL }))
    expect(r.capable).toBe(true)
    expect(isTokenCollectionWiringBroken(r)).toBe(false)
  })

  it('a stale pointer degrades its DETAIL as well as its reason, so the pair cannot contradict', () => {
    const r = probe(world({ sessionId: 's2', pointer: `s1\t${TRANSCRIPT}`, transcript: REAL_JSONL }))
    if (r.capable) throw new Error('unreachable')
    expect(r.reason).toBe('no-transcript-resolved')
    expect(r.detail).toContain('belongs to another session')
  })
})
