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

/**
 * `contentAfterTwoLines` and `AEG_BRIEF_V1_MARKER` are the promoted
 * `@attalabs/aeg-core` exports (plan-brief-v1 task 3, #428) — `dispatch-task.ts`
 * re-exports them rather than carrying its own copy. Pinned identically in
 * `packages/aeg-core/bin/verify-dispatch.content-after-two-lines.test.ts`,
 * proving both packages agree on the SAME function.
 */
const CONTENT_AFTER_TWO_LINES_VECTORS: Array<{ name: string; input: string; expected: string }> = [
  {
    name: 'marker, hash line, then brief text with a trailing newline',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc123\nThe brief text.\nMore text.\n',
    expected: 'The brief text.\nMore text.\n'
  },
  {
    name: 'marker and hash line only, no body at all',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc123',
    expected: ''
  },
  {
    name: 'a body with no newline anywhere',
    input: 'no newline at all',
    expected: ''
  },
  {
    name: 'exactly two lines (no third line to slice out)',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc123\n',
    expected: ''
  },
  {
    name: 'a blank line immediately after the hash line survives verbatim',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc\n\nBrief text after a blank line.\n',
    expected: '\nBrief text after a blank line.\n'
  },
  {
    name: 'brief text that itself contains a line starting with the marker string',
    input: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nSee <!-- aeg:brief:v1 --> for details.\n',
    expected: 'See <!-- aeg:brief:v1 --> for details.\n'
  }
]

function deps(overrides: Partial<DispatchTaskDeps> = {}): DispatchTaskDeps {
  const neverCalled = (name: string) => () => {
    throw new Error(`${name} should not have been called`)
  }
  return {
    assembleAndRenderBrief: neverCalled(
      'assembleAndRenderBrief'
    ) as unknown as DispatchTaskDeps['assembleAndRenderBrief'],
    findExistingV1Comment: neverCalled('findExistingV1Comment') as unknown as DispatchTaskDeps['findExistingV1Comment'],
    postMarkedComment: neverCalled('postMarkedComment') as unknown as DispatchTaskDeps['postMarkedComment'],
    resolveDispatchRole: async () => null,
    resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' }),
    ...overrides
  }
}

/** The common, non-`--agent` deps shape most tests below actually exercise —
 * `assembleAndRenderBrief`/`findExistingV1Comment` are real functions there,
 * so the `deps()` default above (which refuses if either is called) is
 * overridden explicitly per test instead of loosened globally, keeping the
 * "never called" default meaningful for the authorization tests it exists for. */
function postingDeps(overrides: Partial<DispatchTaskDeps> = {}): DispatchTaskDeps {
  return deps({
    assembleAndRenderBrief: async () => ({ ok: true, brief: BRIEF_TEXT, issue: 427 }),
    findExistingV1Comment: () => null,
    ...overrides
  })
}

describe('dispatchTask', () => {
  it('posts one comment whose first two lines are the marker and the hash of the rest', async () => {
    let posted: { kind: string; ref: string; marker: string; body: string } | null = null
    const result = await dispatchTask(
      { tranche: 'plan-brief-v1', n: 427 },
      postingDeps({
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

  it('posts on the resolved Issue, not the task id, when the two differ (task 5, Issue #447, O1)', async () => {
    const findCalls: number[] = []
    const postCalls: string[] = []
    const result = await dispatchTask(
      { tranche: 'plan-brief-v1', n: 3 },
      postingDeps({
        assembleAndRenderBrief: async () => ({ ok: true, brief: BRIEF_TEXT, issue: 986 }),
        findExistingV1Comment: (issue) => {
          findCalls.push(issue)
          return null
        },
        postMarkedComment: (_kind, ref) => {
          postCalls.push(ref)
          return 'https://github.com/acme/widget/issues/986#issuecomment-1'
        }
      })
    )
    expect(result.posted).toBe(true)
    // Live bug this regresses: task id 3 must never be used as the Issue
    // number just because it's numerically a valid one — dispatching task 3
    // once posted its brief on the unrelated, already-merged Issue #3.
    expect(findCalls).toEqual([986])
    expect(postCalls).toEqual(['986'])
  })

  it('refuses a second dispatch on the same Issue, naming the existing comment url — nothing posted', async () => {
    let postCalled = false
    await expect(
      dispatchTask(
        { tranche: 'plan-brief-v1', n: 427 },
        postingDeps({
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
        postingDeps({
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

  it('with --agent and dispatchRole available, calls it with the posted brief and a real promptFile', async () => {
    const calls: unknown[][] = []
    await dispatchTask(
      { tranche: 'plan-brief-v1', n: 427, agent: 'claude' },
      postingDeps({
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-1',
        resolveDispatchRole: async () => {
          return async (...args: unknown[]) => {
            calls.push(args)
          }
        }
      })
    )
    expect(calls.length).toBe(1)
    const [role, agent, prompt, opts] = calls[0] as [string, string, string, { task: number; promptFile: string }]
    expect(role).toBe('developer')
    expect(agent).toBe('claude')
    expect(prompt).toBe(BRIEF_TEXT)
    expect(opts.task).toBe(427)
    // `dispatchRole`'s real `DispatchOpts.promptFile` is required — this is
    // the exact gap a signature mismatch across the dynamic-import boundary
    // let through uncaught by `tsc` (found live, security/code review).
    expect(typeof opts.promptFile).toBe('string')
    expect(opts.promptFile.length).toBeGreaterThan(0)
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
        postingDeps({
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

  describe('dispatch authorization — Principal-only, with or without --agent', () => {
    it('refuses before any render, comment check, or post when the actor is not on the Principal allowlist (--agent given)', async () => {
      await expect(
        dispatchTask(
          { tranche: 'plan-brief-v1', n: 427, agent: 'claude' },
          deps({ resolveDispatchAuthorization: () => ({ authorized: false, login: 'random-collaborator' }) })
        )
      ).rejects.toThrow(/random-collaborator.*Principal allowlist/s)
    })

    it('refuses (fail-closed) when the actor identity cannot be resolved at all (--agent given)', async () => {
      await expect(
        dispatchTask(
          { tranche: 'plan-brief-v1', n: 427, agent: 'claude' },
          deps({ resolveDispatchAuthorization: () => ({ authorized: false, login: null }) })
        )
      ).rejects.toThrow(/could not resolve the identity/)
    })

    it('refuses before any render, comment check, or post when the actor is not on the Principal allowlist — no --agent, posting alone is gated too', async () => {
      let postCalled = false
      await expect(
        dispatchTask(
          { tranche: 'plan-brief-v1', n: 427 },
          deps({
            resolveDispatchAuthorization: () => ({ authorized: false, login: 'random-collaborator' }),
            postMarkedComment: () => {
              postCalled = true
              return 'unused'
            }
          })
        )
      ).rejects.toThrow(/random-collaborator.*Principal allowlist/s)
      expect(postCalled).toBe(false)
    })

    it('proceeds to post when the actor IS on the Principal allowlist, no --agent needed', async () => {
      const result = await dispatchTask(
        { tranche: 'plan-brief-v1', n: 427 },
        postingDeps({
          postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-1',
          resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' })
        })
      )
      expect(result.posted).toBe(true)
    })
  })
})

describe('contentAfterTwoLines', () => {
  for (const { name, input, expected } of CONTENT_AFTER_TWO_LINES_VECTORS) {
    it(name, () => {
      expect(contentAfterTwoLines(input)).toBe(expected)
    })
  }
})
