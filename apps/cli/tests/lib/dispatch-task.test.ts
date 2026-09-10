import { describe, expect, it } from 'bun:test'
import {
  AEG_BRIEF_V1_MARKER,
  briefHash,
  contentAfterTwoLines,
  type DispatchTaskDeps,
  DispatchTaskError,
  dispatchTask,
  extractAgentClass,
  type PrepareTaskDeps,
  prepareTask,
  resolveModelFromRationale
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
    findExistingFrozenBrief: neverCalled('findExistingFrozenBrief') as unknown as DispatchTaskDeps['findExistingFrozenBrief'],
    postMarkedComment: neverCalled('postMarkedComment') as unknown as DispatchTaskDeps['postMarkedComment'],
    resolveDispatchRole: async () => null,
    resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' }),
    resolveModelForDispatch: () => undefined,
    ...overrides
  }
}

/** The common, non-`--agent` deps shape most tests below actually exercise —
 * `assembleAndRenderBrief`/`findExistingFrozenBrief` are real functions there,
 * so the `deps()` default above (which refuses if either is called) is
 * overridden explicitly per test instead of loosened globally, keeping the
 * "never called" default meaningful for the authorization tests it exists for. */
function postingDeps(overrides: Partial<DispatchTaskDeps> = {}): DispatchTaskDeps {
  return deps({
    assembleAndRenderBrief: async () => ({ ok: true, brief: BRIEF_TEXT, issue: 427 }),
    findExistingFrozenBrief: () => null,
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
        findExistingFrozenBrief: (issue: number) => {
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
          findExistingFrozenBrief: () => ({
            body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
            url: 'https://github.com/acme/widget/issues/427#issuecomment-1',
            author: 'a-principal',
            version: 1
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
          findExistingFrozenBrief: () => {
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

  it('O3: an explicit --model wins over resolution, and reaches dispatchRole', async () => {
    const calls: unknown[][] = []
    let resolveArgs: unknown = null
    await dispatchTask(
      { tranche: 'plan-brief-v1', n: 427, agent: 'claude', model: 'opus' },
      postingDeps({
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-1',
        resolveDispatchRole: async () => {
          return async (...args: unknown[]) => {
            calls.push(args)
          }
        },
        resolveModelForDispatch: (agent, issue, explicitModel) => {
          resolveArgs = [agent, issue, explicitModel]
          return explicitModel
        }
      })
    )
    expect(resolveArgs).toEqual(['claude', 427, 'opus'])
    const [, , , opts] = calls[0] as [string, string, string, { model?: string }]
    expect(opts.model).toBe('opus')
  })

  it('O3: no --model given — dispatchRole receives whatever the resolver comes back with, undefined included', async () => {
    const calls: unknown[][] = []
    await dispatchTask(
      { tranche: 'plan-brief-v1', n: 427, agent: 'claude' },
      postingDeps({
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-1',
        resolveDispatchRole: async () => {
          return async (...args: unknown[]) => {
            calls.push(args)
          }
        },
        resolveModelForDispatch: () => 'sonnet'
      })
    )
    const [, , , opts] = calls[0] as [string, string, string, { model?: string }]
    expect(opts.model).toBe('sonnet')
  })

  it('MAJOR 1 (#456 round 1): a throwing model resolution posts nothing — the frozen brief never exists to make the task undispatchable', async () => {
    let postCalled = false
    await expect(
      dispatchTask(
        { tranche: 'plan-brief-v1', n: 427, agent: 'claude' },
        postingDeps({
          postMarkedComment: () => {
            postCalled = true
            return 'https://github.com/acme/widget/issues/427#issuecomment-1'
          },
          resolveDispatchRole: async () => {
            return async () => {
              throw new Error('dispatchRole should never be reached')
            }
          },
          resolveModelForDispatch: () => {
            // The live bug this regresses: this throwing today, AFTER the
            // brief was already posted, left the task permanently
            // undispatchable — the "already dispatched" guard keys on the
            // comment's mere existence, with no flag to override it (#465).
            throw new DispatchTaskError(
              "could not fetch Issue #427's body (`gh issue view`) to resolve its suggested agent-class: boom"
            )
          }
        })
      )
    ).rejects.toThrow(DispatchTaskError)
    expect(postCalled).toBe(false)
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

/**
 * O1 (task-run-v1 task 1) — `prepareTask` is `dispatchTask` minus the
 * developer-start half: its own deps type (`PrepareTaskDeps`) has no
 * `DispatchAgent`, no model, no `resolveDispatchRole` field at all, so
 * there is structurally nothing here that could start a worker — the type
 * itself is the "starts no agent" proof, not merely an assertion at runtime.
 */
function prepareDeps(overrides: Partial<PrepareTaskDeps> = {}): PrepareTaskDeps {
  const neverCalled = (name: string) => () => {
    throw new Error(`${name} should not have been called`)
  }
  return {
    assembleAndRenderBrief: neverCalled(
      'assembleAndRenderBrief'
    ) as unknown as PrepareTaskDeps['assembleAndRenderBrief'],
    findExistingFrozenBrief: neverCalled('findExistingFrozenBrief') as unknown as PrepareTaskDeps['findExistingFrozenBrief'],
    postMarkedComment: neverCalled('postMarkedComment') as unknown as PrepareTaskDeps['postMarkedComment'],
    resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' }),
    ...overrides
  }
}

function preparePostingDeps(overrides: Partial<PrepareTaskDeps> = {}): PrepareTaskDeps {
  return prepareDeps({
    assembleAndRenderBrief: async () => ({ ok: true, brief: BRIEF_TEXT, issue: 427 }),
    findExistingFrozenBrief: () => null,
    ...overrides
  })
}

describe('prepareTask (O1, task-run-v1 task 1)', () => {
  it('renders, posts the frozen comment, and returns the Issue, brief and comment url — no beforePost given', async () => {
    let posted: { kind: string; ref: string; marker: string; body: string } | null = null
    const result = await prepareTask(
      { tranche: 'task-run-v1', n: 1 },
      preparePostingDeps({
        postMarkedComment: (kind, ref, marker, body) => {
          posted = { kind, ref, marker, body }
          return 'https://github.com/acme/widget/issues/427#issuecomment-1'
        }
      })
    )
    expect(result).toEqual({
      issue: 427,
      brief: BRIEF_TEXT,
      version: 1,
      commentUrl: 'https://github.com/acme/widget/issues/427#issuecomment-1'
    })
    expect(posted).not.toBeNull()
  })

  it('refuses before any render, comment check, or post when the actor is not on the Principal allowlist', async () => {
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1 },
        prepareDeps({ resolveDispatchAuthorization: () => ({ authorized: false, login: 'random-collaborator' }) })
      )
    ).rejects.toThrow(/random-collaborator.*Principal allowlist/s)
  })

  it('refuses before ever checking for an existing comment when the render itself refuses', async () => {
    let existingCheckCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1 },
        preparePostingDeps({
          assembleAndRenderBrief: async () => ({
            ok: false,
            missing: ['Test plan (Issue has no `## Test plan` section)']
          }),
          findExistingFrozenBrief: () => {
            existingCheckCalled = true
            return null
          }
        })
      )
    ).rejects.toThrow(DispatchTaskError)
    expect(existingCheckCalled).toBe(false)
  })

  it('refuses when a frozen brief already exists, naming the existing comment url — nothing posted', async () => {
    let postCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1 },
        preparePostingDeps({
          findExistingFrozenBrief: () => ({
            body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
            url: 'https://github.com/acme/widget/issues/427#issuecomment-1',
            author: 'a-principal',
            version: 1
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

  it('calls beforePost with the resolved Issue number, after the existing-comment guard, before the post', async () => {
    const order: string[] = []
    const captured: { issue: number | null } = { issue: null }
    await prepareTask(
      { tranche: 'task-run-v1', n: 1 },
      preparePostingDeps({
        findExistingFrozenBrief: () => {
          order.push('existing-check')
          return null
        },
        beforePost: (issue) => {
          order.push('beforePost')
          captured.issue = issue
        },
        postMarkedComment: () => {
          order.push('post')
          return 'https://github.com/acme/widget/issues/427#issuecomment-1'
        }
      })
    )
    expect(order).toEqual(['existing-check', 'beforePost', 'post'])
    expect(captured.issue).toBe(427)
  })

  it('a throwing beforePost posts nothing — the ordering guarantee MAJOR 1 (#456) relies on', async () => {
    let postCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1 },
        preparePostingDeps({
          beforePost: () => {
            throw new DispatchTaskError('boom')
          },
          postMarkedComment: () => {
            postCalled = true
            return 'unused'
          }
        })
      )
    ).rejects.toThrow(DispatchTaskError)
    expect(postCalled).toBe(false)
  })
})

describe('prepareTask --supersede (O3, task-run-v1 task 4, #483)', () => {
  it('appends a v2 comment naming the v1 predecessor url and the reason, never editing v1', async () => {
    let posted: { kind: string; ref: string; marker: string; body: string } | null = null
    const result = await prepareTask(
      { tranche: 'task-run-v1', n: 1, supersede: { reason: 'wrong tier' } },
      preparePostingDeps({
        findExistingFrozenBrief: () => ({
          body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
          url: 'https://github.com/acme/widget/issues/427#issuecomment-1',
          author: 'a-principal',
          version: 1
        }),
        postMarkedComment: (kind, ref, marker, body) => {
          posted = { kind, ref, marker, body }
          return 'https://github.com/acme/widget/issues/427#issuecomment-2'
        }
      })
    )
    expect(result.version).toBe(2)
    expect(result.commentUrl).toBe('https://github.com/acme/widget/issues/427#issuecomment-2')
    expect(posted).not.toBeNull()
    const p = posted as unknown as { kind: string; ref: string; marker: string; body: string }
    expect(p.marker).toBe('<!-- aeg:brief:v2 -->')
    expect(p.body).toContain('Supersedes: https://github.com/acme/widget/issues/427#issuecomment-1 — wrong tier')
    expect(p.body).toContain(BRIEF_TEXT)
  })

  it('supersedes a v2 into a v3, incrementing off whatever version is actually newest', async () => {
    const result = await prepareTask(
      { tranche: 'task-run-v1', n: 1, supersede: { reason: 'still wrong' } },
      preparePostingDeps({
        findExistingFrozenBrief: () => ({
          body: '<!-- aeg:brief:v2 -->\nBrief hash: def\nSupersedes: url — first fix\nsecond version',
          url: 'https://github.com/acme/widget/issues/427#issuecomment-2',
          author: 'a-principal',
          version: 2
        }),
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-3'
      })
    )
    expect(result.version).toBe(3)
  })

  it('refuses when there is nothing to supersede — no frozen brief exists yet', async () => {
    let postCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1, supersede: { reason: 'wrong tier' } },
        preparePostingDeps({
          findExistingFrozenBrief: () => null,
          postMarkedComment: () => {
            postCalled = true
            return 'unused'
          }
        })
      )
    ).rejects.toThrow(/nothing to supersede/)
    expect(postCalled).toBe(false)
  })

  it('refuses when --supersede is given with an empty reason, before any render or forge read', async () => {
    let renderCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1, supersede: { reason: '   ' } },
        prepareDeps({
          resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' }),
          assembleAndRenderBrief: async () => {
            renderCalled = true
            return { ok: true, brief: BRIEF_TEXT, issue: 427 }
          }
        })
      )
    ).rejects.toThrow(/--reason/)
    expect(renderCalled).toBe(false)
  })

  it('the same Principal-only authorization gate applies under --supersede — never skipped', async () => {
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1, supersede: { reason: 'wrong tier' } },
        prepareDeps({ resolveDispatchAuthorization: () => ({ authorized: false, login: 'random-collaborator' }) })
      )
    ).rejects.toThrow(/random-collaborator.*Principal allowlist/s)
  })

  it('does NOT throw the plain "already dispatched" refusal when --supersede is given and a frozen brief exists', async () => {
    const result = await prepareTask(
      { tranche: 'task-run-v1', n: 1, supersede: { reason: 'wrong tier' } },
      preparePostingDeps({
        findExistingFrozenBrief: () => ({
          body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
          url: 'https://github.com/acme/widget/issues/427#issuecomment-1',
          author: 'a-principal',
          version: 1
        }),
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-2'
      })
    )
    expect(result.version).toBe(2)
  })
})

describe('contentAfterTwoLines', () => {
  for (const { name, input, expected } of CONTENT_AFTER_TWO_LINES_VECTORS) {
    it(name, () => {
      expect(contentAfterTwoLines(input)).toBe(expected)
    })
  }
})

describe('extractAgentClass (O3, #456)', () => {
  it('reads the class word out of the rendered rationale field, label included', () => {
    expect(
      extractAgentClass(
        '**Suggested agent-class** — mid — the per-vendor flag discovery and the precedence rule are judgment; the wiring is mechanical.'
      )
    ).toBe('mid')
    expect(extractAgentClass('**agent-class** — high — needs a deep dig.')).toBe('high')
    expect(extractAgentClass('**Suggested agent-class** – fast – a quick fix.')).toBe('fast')
  })

  it('returns null for a word outside the three-value vocabulary, never a guess', () => {
    expect(extractAgentClass('**Suggested agent-class** — low — a single small pure function.')).toBeNull()
  })

  it('returns null when the field is missing entirely', () => {
    expect(extractAgentClass('')).toBeNull()
    expect(extractAgentClass('**Boundary** — some unrelated field.')).toBeNull()
  })
})

describe('resolveModelFromRationale (O3/MAJOR 2, #456 round 1) — the real resolution wiring, no faked deps', () => {
  const MID_RATIONALE = '**Suggested agent-class** — mid — the wiring is mechanical.'

  it('an explicit model wins over a resolved class', () => {
    expect(resolveModelFromRationale('claude', MID_RATIONALE, 'opus')).toBe('opus')
  })

  it('a resolved class is used when no model is named', () => {
    expect(resolveModelFromRationale('claude', MID_RATIONALE, undefined)).toBe('sonnet')
    // No verified, non-stale class-to-model table exists for these two
    // (`dispatch.ts`'s own `classModels` doc comment) — `undefined`, never a
    // guessed, version-pinned name.
    expect(resolveModelFromRationale('codex', MID_RATIONALE, undefined)).toBeUndefined()
    expect(resolveModelFromRationale('gemini', MID_RATIONALE, undefined)).toBeUndefined()
  })

  it('no rationale field at all, and no explicit model, resolves to undefined rather than guessing', () => {
    expect(resolveModelFromRationale('claude', undefined, undefined)).toBeUndefined()
  })

  it('an unacceptable (wrong-vendor-shaped) explicit model reaches dispatchRole unchanged — this layer never refuses or sanitizes by shape', () => {
    // `dispatch.ts`'s own `identifyVendorFromModelShape`/O4 refusal is what
    // actually blocks a model like this, by name, before any spawn — tested
    // directly there. This layer's own job is narrower: decide which value
    // reaches `dispatchRole` at all, and an explicit caller value always
    // passes through exactly as given, never quietly corrected or dropped
    // just because it looks wrong for the vendor.
    expect(resolveModelFromRationale('codex', MID_RATIONALE, 'claude-opus-5')).toBe('claude-opus-5')
  })
})
