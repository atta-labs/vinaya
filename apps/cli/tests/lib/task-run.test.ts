/**
 * `runTask`'s Sizing verification story is composition, not re-derivation:
 * `prepareTask` and `devReviewLoop` are each already exhaustively covered by
 * their own suites (`dispatch-task.test.ts`, `dev-review-loop.test.ts`) —
 * this file never re-proves either one's internals. It proves the ONE thing
 * `runTask` itself owns: it calls `prepareTask` then `devReviewLoop`, exactly
 * once each on the fresh-task path, in that order, with the right arguments,
 * and it implements the three O3 refusals — using the exact same
 * fully-injected-deps discipline `dispatch-task.test.ts` already established
 * for this exact composition shape (`dispatchTask` faking
 * `assembleAndRenderBrief`/`postMarkedComment`/`resolveDispatchRole` rather
 * than hitting a real forge).
 *
 * A genuine end-to-end CLI-subprocess proof (mirroring
 * `apps/cli/tests/lib/dev-review-loop.test.ts`'s fake-`claude`/fake-`gh`
 * fixture) is not reachable for the fresh-task path here: `prepareTask`
 * always renders first (its own doc comment), and that render
 * (`assembleAndRenderBrief` -> `createForgeSource`/`fetchOpenIssuesByLabel`)
 * goes straight to `@octokit/graphql` over HTTP, never through a stubbable
 * `gh` binary — the same reason `apps/cli/tests/commands/brief-render.test.ts`
 * and `apps/cli/tests/checks/branch-topology.test.ts` document for declining
 * to build a live-network/GraphQL-mock fixture themselves. See this task's
 * PR Decisions section.
 */

import { describe, expect, it } from 'bun:test'
import { isAlreadyDispatchedError, RunTaskError, runTask, type RunTaskDeps } from '../../src/lib/task-run.js'
import { DispatchTaskError } from '../../src/lib/dispatch-task.js'
import type { LoopResult } from '../../src/lib/dev-review-loop.js'

function neverCalled(name: string) {
  return (...args: unknown[]) => {
    throw new Error(`${name} should not have been called (args: ${JSON.stringify(args)})`)
  }
}

const PUBLISH_RESULT: LoopResult = { finalDecision: { type: 'publish' }, prNumber: 999, task: 427 }

function deps(overrides: Partial<RunTaskDeps> = {}): RunTaskDeps {
  return {
    prepareTask: neverCalled('prepareTask') as unknown as RunTaskDeps['prepareTask'],
    prepareIssueTask: neverCalled('prepareIssueTask') as unknown as RunTaskDeps['prepareIssueTask'],
    assembleAndRenderBrief: neverCalled('assembleAndRenderBrief') as unknown as RunTaskDeps['assembleAndRenderBrief'],
    assembleAndRenderBriefForIssue: neverCalled(
      'assembleAndRenderBriefForIssue'
    ) as unknown as RunTaskDeps['assembleAndRenderBriefForIssue'],
    developerBranchFor: neverCalled('developerBranchFor') as unknown as RunTaskDeps['developerBranchFor'],
    findOpenPrForBranch: neverCalled('findOpenPrForBranch') as unknown as RunTaskDeps['findOpenPrForBranch'],
    devReviewLoop: neverCalled('devReviewLoop') as unknown as RunTaskDeps['devReviewLoop'],
    // Not `neverCalled`: `runTask` always calls this once `devReviewLoop`
    // resolves (to build `prUrl`), so every test that reaches that point
    // needs a real, non-throwing default — `null` mirrors the production
    // fallback for an unresolvable repo, same as `resolvePrUrl`'s own
    // `.catch(() => null)`.
    resolveRepo: async () => null,
    ...overrides
  }
}

describe('isAlreadyDispatchedError', () => {
  it('is true only for prepareTask\'s specific "already dispatched" DispatchTaskError', () => {
    expect(
      isAlreadyDispatchedError(new DispatchTaskError('Task 5 in tranche `x` is already dispatched — see url'))
    ).toBe(true)
  })

  it('is false for a render-refusal DispatchTaskError', () => {
    expect(
      isAlreadyDispatchedError(new DispatchTaskError('cannot dispatch — brief render refused:\n  - missing'))
    ).toBe(false)
  })

  it('is false for a plain Error, or a non-Error value', () => {
    expect(isAlreadyDispatchedError(new Error('is already dispatched'))).toBe(false)
    expect(isAlreadyDispatchedError('is already dispatched')).toBe(false)
    expect(isAlreadyDispatchedError(null)).toBe(false)
  })
})

describe('runTask — O1: fresh task, one developer started', () => {
  it('calls prepareTask, then developerBranchFor/findOpenPrForBranch off the resolved Issue, then devReviewLoop exactly once with { task: issue, agent }', async () => {
    const calls: string[] = []
    const result = await runTask(
      { tranche: 'task-run-v1', n: 2, agent: 'claude' },
      deps({
        prepareTask: async (input) => {
          calls.push('prepareTask')
          expect(input).toEqual({ tranche: 'task-run-v1', n: 2 })
          return {
            issue: 480,
            brief: 'brief text',
            commentUrl: 'https://github.com/x/y/issues/480#issuecomment-1',
            version: 1
          }
        },
        developerBranchFor: (issueNumber) => {
          calls.push('developerBranchFor')
          expect(issueNumber).toBe(480)
          return 'task/task-run-v1/2'
        },
        findOpenPrForBranch: (branch) => {
          calls.push('findOpenPrForBranch')
          expect(branch).toBe('task/task-run-v1/2')
          return null
        },
        devReviewLoop: async (input) => {
          calls.push('devReviewLoop')
          expect(input).toEqual({ task: 480, agent: 'claude' })
          return PUBLISH_RESULT
        }
      })
    )

    expect(calls).toEqual(['prepareTask', 'developerBranchFor', 'findOpenPrForBranch', 'devReviewLoop'])
    expect(result).toEqual({ ...PUBLISH_RESULT, prUrl: null })
  })

  it('never passes --agent-shaped data into prepareTask (Traps to avoid) — prepareTask only ever sees { tranche, n }', async () => {
    let sawInput: unknown
    await runTask(
      { tranche: 't', n: 1, agent: 'codex' },
      deps({
        prepareTask: async (input) => {
          sawInput = input
          return { issue: 1, brief: '', commentUrl: '', version: 1 }
        },
        developerBranchFor: () => 'task/t/1',
        findOpenPrForBranch: () => null,
        devReviewLoop: async () => PUBLISH_RESULT
      })
    )
    expect(Object.keys(sawInput as object).sort()).toEqual(['n', 'tranche'])
  })

  it('propagates whatever devReviewLoop returns (publish or pause) unchanged, plus prUrl', async () => {
    const pauseResult: LoopResult = { finalDecision: { type: 'pause', reason: 'max_rounds' }, prNumber: 5, task: 1 }
    const result = await runTask(
      { tranche: 't', n: 1, agent: 'gemini' },
      deps({
        prepareTask: async () => ({ issue: 1, brief: '', commentUrl: '', version: 1 }),
        developerBranchFor: () => 'task/t/1',
        findOpenPrForBranch: () => null,
        devReviewLoop: async () => pauseResult
      })
    )
    expect(result).toEqual({ ...pauseResult, prUrl: null })
  })

  it('prUrl is the real https://github.com/<owner>/<repo>/pull/<n> URL when the repo resolves', async () => {
    const result = await runTask(
      { tranche: 't', n: 1, agent: 'claude' },
      deps({
        prepareTask: async () => ({ issue: 1, brief: '', commentUrl: '', version: 1 }),
        developerBranchFor: () => 'task/t/1',
        findOpenPrForBranch: () => null,
        devReviewLoop: async () => PUBLISH_RESULT,
        resolveRepo: async () => ({ owner: 'acme', repo: 'widget' })
      })
    )
    expect(result.prUrl).toBe(`https://github.com/acme/widget/pull/${PUBLISH_RESULT.prNumber}`)
  })

  it('prUrl is null, never thrown, when resolveRepo rejects', async () => {
    const result = await runTask(
      { tranche: 't', n: 1, agent: 'claude' },
      deps({
        prepareTask: async () => ({ issue: 1, brief: '', commentUrl: '', version: 1 }),
        developerBranchFor: () => 'task/t/1',
        findOpenPrForBranch: () => null,
        devReviewLoop: async () => PUBLISH_RESULT,
        resolveRepo: async () => {
          throw new Error('git remote get-url origin failed')
        }
      })
    )
    expect(result.prUrl).toBeNull()
  })
})

// O1 (task-run-v1 21, #541, round 2 review MAJOR): the identical
// composition story, off `{ issue }` instead of `{ tranche, n }` — a
// backlog Issue with no tranche runs through `prepareIssueTask`/
// `assembleAndRenderBriefForIssue` rather than `prepareTask`/
// `assembleAndRenderBrief`, never both, and every other step (branch
// derivation, the open-PR guard, the one `devReviewLoop` call) is
// unchanged code shared with the tranche path already proven above.
describe('runTask — O1 (task-run-v1 21, #541): a backlog Issue runs the identical unattended path off --issue', () => {
  it('calls prepareIssueTask (never prepareTask), then developerBranchFor/findOpenPrForBranch off the resolved Issue, then devReviewLoop exactly once', async () => {
    const calls: string[] = []
    const result = await runTask(
      { issue: 541, agent: 'claude' },
      deps({
        prepareIssueTask: async (input) => {
          calls.push('prepareIssueTask')
          expect(input).toEqual({ issue: 541 })
          return {
            issue: 541,
            brief: 'brief text',
            commentUrl: 'https://github.com/x/y/issues/541#issuecomment-1',
            version: 1
          }
        },
        developerBranchFor: (issueNumber) => {
          calls.push('developerBranchFor')
          expect(issueNumber).toBe(541)
          return 'task/issue-541'
        },
        findOpenPrForBranch: (branch) => {
          calls.push('findOpenPrForBranch')
          expect(branch).toBe('task/issue-541')
          return null
        },
        devReviewLoop: async (input) => {
          calls.push('devReviewLoop')
          expect(input).toEqual({ task: 541, agent: 'claude' })
          return PUBLISH_RESULT
        }
      })
    )

    expect(calls).toEqual(['prepareIssueTask', 'developerBranchFor', 'findOpenPrForBranch', 'devReviewLoop'])
    expect(result).toEqual({ ...PUBLISH_RESULT, prUrl: null })
  })

  it('on an "already dispatched" refusal, re-resolves the Issue via assembleAndRenderBriefForIssue (read-only) and still calls devReviewLoop once', async () => {
    const calls: string[] = []
    const result = await runTask(
      { issue: 541, agent: 'claude' },
      deps({
        prepareIssueTask: async () => {
          calls.push('prepareIssueTask')
          throw new DispatchTaskError('Issue #541 is already dispatched — see some-url')
        },
        assembleAndRenderBriefForIssue: async (issueNumber) => {
          calls.push('assembleAndRenderBriefForIssue')
          expect(issueNumber).toBe(541)
          return { ok: true, brief: 'irrelevant', issue: 541 }
        },
        developerBranchFor: () => 'task/issue-541',
        findOpenPrForBranch: () => null,
        devReviewLoop: async (input) => {
          calls.push('devReviewLoop')
          expect(input).toEqual({ task: 541, agent: 'claude' })
          return PUBLISH_RESULT
        }
      })
    )

    expect(calls).toEqual(['prepareIssueTask', 'assembleAndRenderBriefForIssue', 'devReviewLoop'])
    expect(result).toEqual({ ...PUBLISH_RESULT, prUrl: null })
  })

  it('an open developer pull request refuses a second start on the --issue path too, never calling devReviewLoop', async () => {
    let loopCalled = false
    await expect(
      runTask(
        { issue: 541, agent: 'claude' },
        deps({
          prepareIssueTask: async () => ({ issue: 541, brief: '', commentUrl: '', version: 1 }),
          developerBranchFor: () => 'task/issue-541',
          findOpenPrForBranch: (branch) => {
            expect(branch).toBe('task/issue-541')
            return { number: 601, branch }
          },
          devReviewLoop: async () => {
            loopCalled = true
            return PUBLISH_RESULT
          }
        })
      )
    ).rejects.toThrow(RunTaskError)
    expect(loopCalled).toBe(false)
  })

  it('propagates a refused preparation unchanged, calling neither assembleAndRenderBriefForIssue nor devReviewLoop', async () => {
    await expect(
      runTask(
        { issue: 541, agent: 'claude' },
        deps({
          prepareIssueTask: async () => {
            throw new DispatchTaskError('cannot dispatch — brief render refused:\n  - missing ## Objectives')
          }
        })
      )
    ).rejects.toThrow(/brief render refused/)
  })
})

describe('runTask — O3: already-frozen brief is reused, not re-posted', () => {
  it('on an "already dispatched" refusal, re-resolves the Issue via assembleAndRenderBrief (read-only) and still calls devReviewLoop once — never re-posting', async () => {
    const calls: string[] = []
    const result = await runTask(
      { tranche: 'task-run-v1', n: 2, agent: 'claude' },
      deps({
        prepareTask: async () => {
          calls.push('prepareTask')
          throw new DispatchTaskError('Task 2 in tranche `task-run-v1` is already dispatched — see some-url')
        },
        assembleAndRenderBrief: async (tranche, taskId) => {
          calls.push('assembleAndRenderBrief')
          expect(tranche).toBe('task-run-v1')
          expect(taskId).toBe('2')
          return { ok: true, brief: 'irrelevant', issue: 480 }
        },
        developerBranchFor: (issueNumber) => {
          expect(issueNumber).toBe(480)
          return 'task/task-run-v1/2'
        },
        findOpenPrForBranch: () => null,
        devReviewLoop: async (input) => {
          calls.push('devReviewLoop')
          expect(input).toEqual({ task: 480, agent: 'claude' })
          return PUBLISH_RESULT
        }
      })
    )

    expect(calls).toEqual(['prepareTask', 'assembleAndRenderBrief', 'devReviewLoop'])
    expect(result).toEqual({ ...PUBLISH_RESULT, prUrl: null })
  })

  it('fails clearly (never starts the loop) when the already-dispatched re-resolution itself cannot derive the Issue', async () => {
    let loopCalled = false
    await expect(
      runTask(
        { tranche: 't', n: 3, agent: 'claude' },
        deps({
          prepareTask: async () => {
            throw new DispatchTaskError('Task 3 in tranche `t` is already dispatched — see some-url')
          },
          assembleAndRenderBrief: async () => ({ ok: false, missing: ['could not resolve owner/repo'] }),
          devReviewLoop: async () => {
            loopCalled = true
            return PUBLISH_RESULT
          }
        })
      )
    ).rejects.toThrow(/already dispatched, but re-resolving its Issue number failed/)
    expect(loopCalled).toBe(false)
  })
})

describe('runTask — O3: a refused preparation refuses before any agent starts', () => {
  it('propagates a render-refusal DispatchTaskError unchanged, calling neither assembleAndRenderBrief nor devReviewLoop', async () => {
    await expect(
      runTask(
        { tranche: 't', n: 9, agent: 'claude' },
        deps({
          prepareTask: async () => {
            throw new DispatchTaskError('cannot dispatch — brief render refused:\n  - missing ## Objectives')
          }
        })
      )
    ).rejects.toThrow(/brief render refused/)
  })

  it('propagates a non-DispatchTaskError from prepareTask unchanged too', async () => {
    await expect(
      runTask(
        { tranche: 't', n: 9, agent: 'claude' },
        deps({
          prepareTask: async () => {
            throw new Error('gh issue view failed')
          }
        })
      )
    ).rejects.toThrow('gh issue view failed')
  })
})

describe('runTask — O3: an open developer pull request refuses a second start', () => {
  it('refuses before calling devReviewLoop when the derived developer branch already has an open PR', async () => {
    let loopCalled = false
    await expect(
      runTask(
        { tranche: 'task-run-v1', n: 2, agent: 'claude' },
        deps({
          prepareTask: async () => ({ issue: 480, brief: '', commentUrl: '', version: 1 }),
          developerBranchFor: () => 'task/task-run-v1/2',
          findOpenPrForBranch: (branch) => {
            expect(branch).toBe('task/task-run-v1/2')
            return { number: 501, branch }
          },
          devReviewLoop: async () => {
            loopCalled = true
            return PUBLISH_RESULT
          }
        })
      )
    ).rejects.toThrow(RunTaskError)
    expect(loopCalled).toBe(false)
  })

  it('the refusal names the branch, the open PR number, and the exact dev-review-loop resume command', async () => {
    await expect(
      runTask(
        { tranche: 'task-run-v1', n: 2, agent: 'claude' },
        deps({
          prepareTask: async () => ({ issue: 480, brief: '', commentUrl: '', version: 1 }),
          developerBranchFor: () => 'task/task-run-v1/2',
          findOpenPrForBranch: () => ({ number: 501, branch: 'task/task-run-v1/2' })
        })
      )
    ).rejects.toThrow(/task\/task-run-v1\/2.*#501.*vinaya dev-review-loop --resume 501/s)
  })

  it('also applies on the already-frozen path — reusing the brief still refuses a second start when a PR is already open', async () => {
    let loopCalled = false
    await expect(
      runTask(
        { tranche: 'task-run-v1', n: 2, agent: 'claude' },
        deps({
          prepareTask: async () => {
            throw new DispatchTaskError('Task 2 in tranche `task-run-v1` is already dispatched — see some-url')
          },
          assembleAndRenderBrief: async () => ({ ok: true, brief: '', issue: 480 }),
          developerBranchFor: () => 'task/task-run-v1/2',
          findOpenPrForBranch: () => ({ number: 501, branch: 'task/task-run-v1/2' }),
          devReviewLoop: async () => {
            loopCalled = true
            return PUBLISH_RESULT
          }
        })
      )
    ).rejects.toThrow(RunTaskError)
    expect(loopCalled).toBe(false)
  })
})
