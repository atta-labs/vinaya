import { describe, expect, it } from 'bun:test'
import {
  AEG_BRIEF_V1_MARKER,
  briefHash,
  contentAfterTwoLines,
  type DispatchTaskDeps,
  DispatchTaskError,
  dispatchTask
} from '../../src/lib/dispatch-task.js'

const BRIEF_TEXT = '**For:** Sonnet\n**Tier:** 1\n\nCloses #427\n\nYou are the AEG Developer.'

function deps(overrides: Partial<DispatchTaskDeps> = {}): DispatchTaskDeps {
  const neverCalled = (name: string) => () => {
    throw new Error(`${name} should not have been called`)
  }
  return {
    assembleAndRenderBrief: async () => ({ ok: true, brief: BRIEF_TEXT }),
    findExistingV1Comment: () => null,
    postMarkedComment: neverCalled('postMarkedComment') as unknown as DispatchTaskDeps['postMarkedComment'],
    resolveDispatchRole: async () => null,
    ...overrides
  }
}

describe('dispatchTask', () => {
  it('posts one comment whose first two lines are the marker and the hash of the rest', async () => {
    let posted: { kind: string; ref: string; marker: string; body: string } | null = null
    const result = await dispatchTask(
      { tranche: 'plan-brief-v1', n: 427 },
      deps({
        postMarkedComment: (kind, ref, marker, body) => {
          posted = { kind, ref, marker, body }
          return 'https://github.com/acme/widget/issues/427#issuecomment-1'
        }
      })
    )

    expect(result.posted).toBe(true)
    expect(result.commentUrl).toBe('https://github.com/acme/widget/issues/427#issuecomment-1')
    expect(posted).not.toBeNull()
    const p = posted as unknown as { kind: string; ref: string; marker: string; body: string }
    expect(p.kind).toBe('issue')
    expect(p.ref).toBe('427')
    expect(p.marker).toBe(AEG_BRIEF_V1_MARKER)

    // The full posted comment, as `postMarkedComment` would actually write it
    // (marker line, then the body verbatim, then its own trailing newline) —
    // a reader recomputes the hash over exactly this reconstruction.
    const fullComment = `${AEG_BRIEF_V1_MARKER}\n${p.body}\n`
    const reconstructed = contentAfterTwoLines(fullComment)
    expect(reconstructed).toBe(`${BRIEF_TEXT}\n`)
    const hashLine = p.body.split('\n')[0]
    expect(hashLine).toBe(`Brief hash: ${briefHash(BRIEF_TEXT)}`)
  })

  it('refuses a second dispatch on the same Issue, naming the existing comment url — nothing posted', async () => {
    let postCalled = false
    await expect(
      dispatchTask(
        { tranche: 'plan-brief-v1', n: 427 },
        deps({
          findExistingV1Comment: () => ({
            body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
            url: 'https://github.com/acme/widget/issues/427#issuecomment-1'
          }),
          postMarkedComment: () => {
            postCalled = true
            return 'unused'
          }
        })
      )
    ).rejects.toThrow(/already dispatched.*issuecomment-1/s)
    expect(postCalled).toBe(false)
  })

  it('refuses before ever checking for an existing comment when the render itself refuses', async () => {
    let existingCheckCalled = false
    await expect(
      dispatchTask(
        { tranche: 'plan-brief-v1', n: 427 },
        deps({
          assembleAndRenderBrief: async () => ({
            ok: false,
            missing: ['Test plan (Issue has no `## Test plan` section)']
          }),
          findExistingV1Comment: () => {
            existingCheckCalled = true
            return null
          }
        })
      )
    ).rejects.toThrow(DispatchTaskError)
    expect(existingCheckCalled).toBe(false)
  })

  it('with --agent and dispatchRole available, calls it with the posted brief', async () => {
    const calls: unknown[][] = []
    await dispatchTask(
      { tranche: 'plan-brief-v1', n: 427, agent: 'claude' },
      deps({
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-1',
        resolveDispatchRole: async () => {
          return async (...args: unknown[]) => {
            calls.push(args)
          }
        }
      })
    )
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual(['developer', 'claude', BRIEF_TEXT, { task: 427 }])
  })

  it('with --agent and dispatchRole unavailable, prints the manual instruction and resolves cleanly', async () => {
    const originalWrite = process.stdout.write.bind(process.stdout)
    let printed = ''
    process.stdout.write = ((chunk: string) => {
      printed += chunk
      return true
    }) as typeof process.stdout.write
    try {
      const result = await dispatchTask(
        { tranche: 'plan-brief-v1', n: 427, agent: 'codex' },
        deps({
          postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-1',
          resolveDispatchRole: async () => null
        })
      )
      expect(result.posted).toBe(true)
    } finally {
      process.stdout.write = originalWrite
    }
    expect(printed).toContain('dispatchRole` is not available yet')
    expect(printed).toContain('--agent codex')
  })
})
