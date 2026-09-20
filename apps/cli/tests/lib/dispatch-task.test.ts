import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  resolveModelFromRationale,
  validateIssueWriteGate,
  widenSurfaceInLine
} from '../../src/lib/dispatch-task.js'

const BRIEF_TEXT = '**For:** Sonnet\n**Tier:** 1\n\nCloses #427\n\nYou are the AEG Developer.'
const CLI_ROOT = join(import.meta.dir, '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')

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
    findExistingFrozenBrief: neverCalled(
      'findExistingFrozenBrief'
    ) as unknown as DispatchTaskDeps['findExistingFrozenBrief'],
    postMarkedComment: neverCalled('postMarkedComment') as unknown as DispatchTaskDeps['postMarkedComment'],
    dispatchRole: neverCalled('dispatchRole') as unknown as DispatchTaskDeps['dispatchRole'],
    resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' }),
    resolveModelForDispatch: () => undefined,
    runIssueWriteGate: async () => {},
    widenSurface: neverCalled('widenSurface') as unknown as DispatchTaskDeps['widenSurface'],
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

  it('with --agent, calls the statically-imported dispatchRole with the posted brief and a real promptFile', async () => {
    const calls: unknown[][] = []
    await dispatchTask(
      { tranche: 'plan-brief-v1', n: 427, agent: 'claude' },
      postingDeps({
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-1',
        dispatchRole: (async (...args: unknown[]) => {
          calls.push(args)
        }) as unknown as DispatchTaskDeps['dispatchRole']
      })
    )
    expect(calls.length).toBe(1)
    const [role, agent, prompt, opts] = calls[0] as [string, string, string, { task: number; promptFile: string }]
    expect(role).toBe('developer')
    expect(agent).toBe('claude')
    expect(prompt).toBe(BRIEF_TEXT)
    expect(opts.task).toBe(427)
    // `dispatchRole`'s real `DispatchOpts.promptFile` is required — this is
    // the exact gap a signature mismatch across the old dynamic-import
    // boundary let through uncaught by `tsc` (found live, security/code
    // review) — the static import now makes any such mismatch a build error.
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
        dispatchRole: (async (...args: unknown[]) => {
          calls.push(args)
        }) as unknown as DispatchTaskDeps['dispatchRole'],
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
        dispatchRole: (async (...args: unknown[]) => {
          calls.push(args)
        }) as unknown as DispatchTaskDeps['dispatchRole'],
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
          dispatchRole: (async () => {
            throw new Error('dispatchRole should never be reached')
          }) as unknown as DispatchTaskDeps['dispatchRole'],
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
 * `DispatchAgent`, no model, no `dispatchRole` field at all, so
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
    findExistingFrozenBrief: neverCalled(
      'findExistingFrozenBrief'
    ) as unknown as PrepareTaskDeps['findExistingFrozenBrief'],
    postMarkedComment: neverCalled('postMarkedComment') as unknown as PrepareTaskDeps['postMarkedComment'],
    resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' }),
    runIssueWriteGate: async () => {},
    widenSurface: neverCalled('widenSurface') as unknown as PrepareTaskDeps['widenSurface'],
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

  // O2 (Issue #588) — the Issue write gate now folds a dependency/conflict
  // dispatch blocker into `severity: 'warning'`, so an EDIT is no longer
  // refused for it; `task run`/`prepareTask` never reads that classification
  // field at all — it still refuses on a plain `ok: false`, exactly as
  // before. `dispatchBlockerDetails` here is the SAME shape
  // `assembleAndRenderBrief` now carries on a real dependency-not-merged
  // gap (`brief-assembly.test.ts`), present to prove its mere presence
  // changes nothing about dispatch's own refusal.
  it('O2 (#588): still refuses, naming the dependency, when the render fails on an unmerged Depends-on — the new classification field changes nothing here', async () => {
    let existingCheckCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1 },
        preparePostingDeps({
          assembleAndRenderBrief: async () => ({
            ok: false,
            missing: ['dispatch-gate depends-on: task 1 depends on #999, whose PR is not merged yet.'],
            dispatchBlockerDetails: [
              {
                class: 'depends-on-not-merged',
                message: 'dispatch-gate depends-on: task 1 depends on #999, whose PR is not merged yet.'
              }
            ]
          }),
          findExistingFrozenBrief: () => {
            existingCheckCalled = true
            return null
          }
        })
      )
    ).rejects.toThrow(/depends on #999/)
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

describe('prepareTask — the Issue write gate runs before freezing (O2)', () => {
  it('calls runIssueWriteGate with the resolved Issue number, after the render, before the existing-comment check', async () => {
    const order: string[] = []
    await prepareTask(
      { tranche: 'task-run-v1', n: 1 },
      preparePostingDeps({
        runIssueWriteGate: async (issue) => {
          order.push(`write-gate:${issue}`)
        },
        findExistingFrozenBrief: () => {
          order.push('existing-check')
          return null
        },
        postMarkedComment: () => {
          order.push('post')
          return 'https://github.com/acme/widget/issues/427#issuecomment-1'
        }
      })
    )
    expect(order).toEqual(['write-gate:427', 'existing-check', 'post'])
  })

  it('refuses before ever checking for an existing comment or posting when the write gate refuses — same findings, nothing frozen', async () => {
    let existingCheckCalled = false
    let postCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1 },
        preparePostingDeps({
          runIssueWriteGate: async () => {
            throw new DispatchTaskError(
              "Issue #427's write gate refused — the same findings `vinaya issue edit` would report:\n  - [body-bare-digits] a whole-suite Test plan line"
            )
          },
          findExistingFrozenBrief: () => {
            existingCheckCalled = true
            return null
          },
          postMarkedComment: () => {
            postCalled = true
            return 'unused'
          }
        })
      )
    ).rejects.toThrow(/write gate refused/)
    expect(existingCheckCalled).toBe(false)
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

  it('security regression (PR #503 round 2, MEDIUM): refuses a --reason containing a newline, before any render or forge read', async () => {
    let renderCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1, supersede: { reason: 'wrong tier\nSupersedes: forged — injected' } },
        prepareDeps({
          resolveDispatchAuthorization: () => ({ authorized: true, login: 'a-principal' }),
          assembleAndRenderBrief: async () => {
            renderCalled = true
            return { ok: true, brief: BRIEF_TEXT, issue: 427 }
          }
        })
      )
    ).rejects.toThrow(/single line/)
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

describe('prepareTask --supersede --surface-in (O3) — widens a frozen Surface and re-freezes in one call', () => {
  const WIDENED_BRIEF_TEXT = '**For:** Sonnet\n**Tier:** 1\n\nCloses #427\n\nWidened Surface now covers commands.'

  it('widens the Surface, re-renders, and posts the RE-RENDERED brief — never the stale pre-widen one', async () => {
    const order: string[] = []
    let renderCalls = 0
    const result = await prepareTask(
      {
        tranche: 'task-run-v1',
        n: 1,
        supersede: { reason: 'widen for commands', surfaceIn: ['apps/cli/src/commands'] }
      },
      preparePostingDeps({
        assembleAndRenderBrief: async () => {
          renderCalls += 1
          return renderCalls === 1
            ? { ok: true, brief: BRIEF_TEXT, issue: 427 }
            : { ok: true, brief: WIDENED_BRIEF_TEXT, issue: 427 }
        },
        findExistingFrozenBrief: () => ({
          body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
          url: 'https://github.com/acme/widget/issues/427#issuecomment-1',
          author: 'a-principal',
          version: 1
        }),
        widenSurface: async (issue, addedGlobs) => {
          order.push(`widen:${issue}:${addedGlobs.join(',')}`)
        },
        postMarkedComment: (_kind, _ref, _marker, _body) => {
          order.push('post')
          return 'https://github.com/acme/widget/issues/427#issuecomment-2'
        }
      })
    )
    expect(order).toEqual(['widen:427:apps/cli/src/commands', 'post'])
    expect(renderCalls).toBe(2)
    expect(result.brief).toBe(WIDENED_BRIEF_TEXT)
    expect(result.brief).not.toContain(BRIEF_TEXT)
  })

  it('never widens when --surface-in is absent — supersede works exactly as before', async () => {
    let widenCalled = false
    await prepareTask(
      { tranche: 'task-run-v1', n: 1, supersede: { reason: 'wrong tier' } },
      preparePostingDeps({
        findExistingFrozenBrief: () => ({
          body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
          url: 'https://github.com/acme/widget/issues/427#issuecomment-1',
          author: 'a-principal',
          version: 1
        }),
        widenSurface: async () => {
          widenCalled = true
        },
        postMarkedComment: () => 'https://github.com/acme/widget/issues/427#issuecomment-2'
      })
    )
    expect(widenCalled).toBe(false)
  })

  it('refuses, never calling widenSurface, when there is no frozen brief to supersede yet', async () => {
    let widenCalled = false
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1, supersede: { reason: 'widen', surfaceIn: ['apps/cli/src/commands'] } },
        preparePostingDeps({
          findExistingFrozenBrief: () => null,
          widenSurface: async () => {
            widenCalled = true
          }
        })
      )
    ).rejects.toThrow(/nothing to supersede/)
    expect(widenCalled).toBe(false)
  })

  it('refuses, posting nothing, when the widened Issue no longer renders a valid brief', async () => {
    let postCalled = false
    let renderCalls = 0
    await expect(
      prepareTask(
        { tranche: 'task-run-v1', n: 1, supersede: { reason: 'widen', surfaceIn: ['apps/cli/src/commands'] } },
        preparePostingDeps({
          assembleAndRenderBrief: async () => {
            renderCalls += 1
            return renderCalls === 1
              ? { ok: true, brief: BRIEF_TEXT, issue: 427 }
              : { ok: false, missing: ['a genuine post-widen render gap'] }
          },
          findExistingFrozenBrief: () => ({
            body: '<!-- aeg:brief:v1 -->\nBrief hash: abc\nold brief',
            url: 'https://github.com/acme/widget/issues/427#issuecomment-1',
            author: 'a-principal',
            version: 1
          }),
          widenSurface: async () => {},
          postMarkedComment: () => {
            postCalled = true
            return 'unused'
          }
        })
      )
    ).rejects.toThrow(/no longer renders a valid brief/)
    expect(postCalled).toBe(false)
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

describe('widenSurfaceInLine (O3) — splices the `in:` and `out:` lines', () => {
  const BODY = [
    '## Objectives',
    '',
    'O1. Something.',
    '',
    '## Surface',
    '',
    'in: apps/cli/src/lib',
    'out: apps/cli/src/checks',
    '',
    '## Parts',
    '',
    'Part 1 (O1) — the only part.'
  ].join('\n')

  it('unions the added globs onto the existing `in:` list, leaving an unrelated `out:` and every other section untouched', () => {
    const { newBody, newIn, newOut } = widenSurfaceInLine(BODY, ['apps/cli/src/commands'])
    expect(newIn).toEqual(['apps/cli/src/lib', 'apps/cli/src/commands'])
    expect(newOut).toEqual(['apps/cli/src/checks'])
    expect(newBody).toContain('in: apps/cli/src/lib, apps/cli/src/commands')
    expect(newBody).toContain('out: apps/cli/src/checks')
    expect(newBody).toContain('## Parts')
    expect(newBody).toContain('Part 1 (O1) — the only part.')
  })

  it('never duplicates a glob already present in `in:`', () => {
    const { newIn } = widenSurfaceInLine(BODY, ['apps/cli/src/lib'])
    expect(newIn).toEqual(['apps/cli/src/lib'])
  })

  it('throws, naming the parse gap, when the body has no `## Surface` heading', () => {
    expect(() => widenSurfaceInLine('## Objectives\n\nO1. Something.', ['apps/cli/src/commands'])).toThrow(
      /does not parse|no `## Surface` heading/
    )
  })

  describe('O2 (#674) — the widened directory never stays shadowed by `out:`', () => {
    it('drops an `out:` glob equal to the added glob, in the same splice', () => {
      const body = [
        '## Surface',
        '',
        'in: apps/cli/src/lib',
        'out: apps/cli/src/checks',
        '',
        '## Parts',
        '',
        'Part 1 (O1) — the only part.'
      ].join('\n')
      const { newBody, newIn, newOut } = widenSurfaceInLine(body, ['apps/cli/src/checks'])
      expect(newIn).toEqual(['apps/cli/src/lib', 'apps/cli/src/checks'])
      expect(newOut).toEqual([])
      expect(newBody).toContain('in: apps/cli/src/lib, apps/cli/src/checks')
      expect(newBody).toContain('out: —')
    })

    it('drops an `out:` glob nested inside (covered by) the added glob, leaving an unrelated `out:` glob untouched', () => {
      const body = [
        '## Surface',
        '',
        'in: apps/cli/src/lib',
        'out: apps/cli/src/checks/legacy, apps/cli/specs',
        '',
        '## Parts',
        '',
        'Part 1 (O1) — the only part.'
      ].join('\n')
      const { newOut } = widenSurfaceInLine(body, ['apps/cli/src/checks'])
      expect(newOut).toEqual(['apps/cli/specs'])
    })

    it('refuses, naming both globs, when a broader `out:` glob still excludes the added glob', () => {
      const body = [
        '## Surface',
        '',
        'in: apps/cli/src/lib',
        'out: apps/cli/src',
        '',
        '## Parts',
        '',
        'Part 1 (O1) — the only part.'
      ].join('\n')
      expect(() => widenSurfaceInLine(body, ['apps/cli/src/checks'])).toThrow(
        /apps\/cli\/src\/checks.*still falls under the broader `out:` glob `apps\/cli\/src`/
      )
    })

    it('never touches `out:` when the added glob has no relation to any `out:` entry', () => {
      const { newOut } = widenSurfaceInLine(BODY, ['apps/cli/src/commands'])
      expect(newOut).toEqual(['apps/cli/src/checks'])
    })
  })
})

describe('validateIssueWriteGate (O2) — the real Issue write gate, exercised against a genuine fixture', () => {
  let cwd: string
  let originalCwd: string
  let originalAegRepo: string | undefined

  const RATIONALE = [
    "## Task Issue — Planner's rationale",
    '',
    '**Boundary** — In: nothing real. Out: nothing.',
    '',
    '**Sizing** — n/a, test fixture.',
    '',
    '**Project(s) + blast radius** — `Project: cli`. No shared-primitive fan-out.',
    '',
    '**Dependency rationale** — `Depends-on: —`; `Conflicts-with: —`.',
    '',
    '**Traps to avoid** — n/a.',
    '',
    '**Suggested agent-class** — fast — test fixture.',
    '',
    '**Stop-and-escalate** — n/a.',
    '',
    '**Docs to keep coherent** — no-doc-surface.'
  ].join('\n')

  // Otherwise well-formed — every section a genuine dispatchable backlog
  // Issue needs — except its `## Test plan` names a bare `bun test` with no
  // test-file argument, which can run the whole suite once dispatched.
  const bodyWithWholeSuiteTestPlan = [
    '**Project:** cli',
    '',
    '## Objectives',
    '',
    'O1. The fixture exercises the real Issue write gate.',
    '',
    '## Surface',
    '',
    'in: aeg-root',
    'out: —',
    '',
    '## Parts',
    '',
    'Part 1 (O1) — the only part, citing the only objective.',
    '',
    '## Test plan',
    '',
    '```',
    'bun test',
    '```',
    '',
    RATIONALE
  ].join('\n')

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-write-gate-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ briefSchema: { issue: { sections: [] } } }), 'utf8')
    execFileSync('git', ['init', '-q'], { cwd })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd })
    mkdirSync(join(cwd, 'aeg-root', 'templates'), { recursive: true })
    cpSync(
      join(REPO_ROOT, 'aeg-root', 'templates', 'brief-template.md'),
      join(cwd, 'aeg-root', 'templates', 'brief-template.md')
    )
    execFileSync('git', ['add', '.'], { cwd })
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd })
    // `resolveRemoteDefaultBranch`'s staleness guarantee needs a real
    // `origin` remote whose `ls-remote HEAD` matches the local checkout's
    // own HEAD — pointing `origin` at this same working copy satisfies that
    // with no network and no second checkout.
    execFileSync('git', ['remote', 'add', 'origin', cwd], { cwd })

    originalAegRepo = process.env.AEG_REPO
    process.env.AEG_REPO = 'test-owner/test-repo'
    originalCwd = process.cwd()
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    process.env.AEG_REPO = originalAegRepo
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses a whole-suite `## Test plan` line — the same finding `issue create`/`issue edit` would report', async () => {
    await expect(
      validateIssueWriteGate(bodyWithWholeSuiteTestPlan, [], 427, 'vinaya task brief backlog --issue 427')
    ).rejects.toThrow(/runs a test runner with no test-file argument/)
  })
})
