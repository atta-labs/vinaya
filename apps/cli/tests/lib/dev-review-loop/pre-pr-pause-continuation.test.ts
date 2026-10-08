/**
 * Issue #1165 — a task paused before its pull request existed always has a
 * way to continue. The case that stranded a task: a GitHub rate limit paused
 * the run before the driver knew of any pull request, the pull request was
 * opened afterwards, and then every exit refused — `task run` routed to
 * `--resume <pr>`, which refused because the pause recorded no pull request,
 * and the paused driver never watched the pause, so the automatic rate-limit
 * resume never fired.
 *
 * Driven in-process on the real loop — the real `devReviewLoop` round 1, a
 * real `--resume` bind, a real round 2 on real gates, the real control-store
 * escalation and resolution records — with only the forge and the agents
 * faked by the shared harness.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  cancelDevReviewLoop,
  type DriverWatchDeps,
  type LoopDeps,
  type LoopInput,
  type LoopResult,
  readResolutionRecord,
  runDriverLoop,
  taskFromPrBody
} from '../../../src/lib/dev-review-loop.js'
import { ownRepoPrForBranch } from '../../../src/lib/dev-review-loop/developer-dispatch.js'
import {
  type PauseState,
  readDriverLock,
  readPauseState,
  writeDriverLock,
  writePauseState
} from '../../../src/lib/dev-review-loop/pause-resume.js'
import { rateLimitPauseDetail } from '../../../src/lib/dev-review-loop/round-assess.js'
import { type RunTaskDeps, runTask } from '../../../src/lib/task-run.js'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  runDriverLoopInProcess,
  runLoopInProcess,
  type LoopWorld,
  withWorldEnv
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

/** A pid no process holds — what a driver that has since exited leaves in its lock. */
const EXITED_PID = 999_999_999

/**
 * A world whose round-1 reviewer blocks, so the continuation must run a real
 * round 2, and whose pull-request reads hit a GitHub rate limit from the
 * Developer's first turn until `limit.lifted` — the limit lands after the
 * Developer pushed, before the driver ever saw a pull request. The pull
 * request itself is opened only when the test says so (`world.prOpened`).
 */
function strandingWorld(): { world: LoopWorld; limit: { active: boolean }; deps: Partial<LoopDeps> } {
  const world = makeWorld({
    roleOutcomes: {
      1: {
        reviewer: {
          findings: 'BLOCKER|smoke.ts:1|deliberate round-1 blocker to force a real round 2',
          report: 'BRIEF_CONFORMANCE: yes\nSPEC_CONFORMANCE: yes\nSCOPE: small\nTESTS: pass\nDOCS: n/a\n',
          objectives: 'O1|MET|done.\n',
          sessionId: 'rev-session-1'
        }
      }
    }
  })
  const limit = { active: false }
  const base = makeInProcessDeps(world)
  const deps: Partial<LoopDeps> = {
    dispatchRole: async (role, agent, prompt, opts) => {
      const handle = await base.dispatchRole!(role, agent, prompt, opts)
      if (role === 'developer' && (world.dispatchCountByRole.developer ?? 0) === 1) limit.active = true
      return handle
    },
    findOpenPrForBranch: (branch) => {
      if (limit.active) throw new Error('gh: API rate limit exceeded for user ID 1.')
      return world.prOpened ? { number: world.prNumber, branch } : null
    }
  }
  return { world, limit, deps }
}

/** `runTask`'s deps, every forge read answered by the world and the loop itself the real watching driver on it. */
function runTaskDeps(world: LoopWorld, deps: Partial<LoopDeps>, watch: Partial<DriverWatchDeps> = {}): RunTaskDeps {
  return {
    prepareTask: async () => {
      throw new Error('unused: a backlog task')
    },
    prepareIssueTask: async ({ issue }) => ({
      issue,
      brief: world.frozenBrief,
      commentUrl: 'https://example/brief',
      version: 1
    }),
    assembleAndRenderBrief: async () => {
      throw new Error('unused: a backlog task')
    },
    assembleAndRenderBriefForIssue: async () => {
      throw new Error('unused: the brief is not frozen twice')
    },
    developerBranchFor: () => world.branch,
    findOpenPrForBranch: (branch) => deps.findOpenPrForBranch!(branch),
    isDriverAlive: (task) => {
      const lock = readDriverLock(world.runtimeDir, task)
      return lock !== null && lock.pid !== EXITED_PID
    },
    hasPauseState: (task) => readPauseState(world.runtimeDir, task) !== null,
    resolveModelForDispatch: () => undefined,
    devReviewLoop: (input) => runDriverLoopInProcess(world, input, deps, watch),
    resolveRepo: async () => null
  }
}

/** Round 1 paused on the rate limit before the driver knew of any pull request — the stranded state. */
function expectPrePrRateLimitPause(world: LoopWorld, result: LoopResult): PauseState {
  expect(result.finalDecision.type).toBe('pause')
  expect(result.prNumber).toBeLessThanOrEqual(0)
  const held = readPauseState(world.runtimeDir, world.task)
  expect(held?.prNumber).toBeNull()
  expect(held?.reason).toBe('infrastructure')
  expect(held?.detail?.startsWith('GitHub rate limit:')).toBe(true)
  // Recorded on the task Issue, saying no ruling is needed.
  const issueComment = world.postedComments.find((c) => c.kind === 'issue')
  expect(issueComment?.body).toContain('No Principal ruling is needed')
  return held!
}

/** The task went on to a real round 2 and published it — no hand intervention between the pause and here. */
async function expectContinuedToRoundTwo(world: LoopWorld, held: PauseState): Promise<void> {
  // Bound to the pull request opened after the pause.
  const bound = readPauseState(world.runtimeDir, world.task)
  expect(bound?.prNumber).toBe(world.prNumber)
  expect(bound?.boundAt).toBeDefined()
  // The pause's own escalation was resumed once, by the driver itself.
  const resolution = await withWorldEnv(world, () => readResolutionRecord(world.task, held.escalationId!))
  expect(resolution?.decision).toBe('resume')
  expect(resolution?.authenticatedBy).toBe('driver-self')
}

describe('a rate-limit pause recorded before the pull request existed', () => {
  it('continues through `task run` once the pull request is open: bound to it, then on to a real round 2', async () => {
    const { world, limit, deps } = strandingWorld()

    // 1. The rate limit pauses round 1 before the driver knows of a pull request.
    const paused = await runLoopInProcess(world, { task: world.task, agent: 'claude' }, deps)
    const held = expectPrePrRateLimitPause(world, paused)
    // That driver has exited since.
    writeDriverLock(world.runtimeDir, world.task, { pid: EXITED_PID, startedAt: new Date(0).toISOString() })

    // 2. The pull request is opened afterwards, and the limit resets.
    world.prOpened = true
    limit.active = false

    // 3. `task run`.
    const result = await runTask({ issue: world.task, agent: 'claude' }, runTaskDeps(world, deps))

    // A real round 2: round 1's blocker went to the Developer, round 2's
    // reviewers approved, and round 2 is what published.
    expect({
      finalDecision: result.finalDecision,
      prNumber: result.prNumber,
      developerRounds: world.dispatches.filter((d) => d.role === 'developer').map((d) => d.round),
      // Distinct rounds: round 1's reviewer is resent once for its uncitable report.
      reviewerRounds: [...new Set(world.dispatches.filter((d) => d.role === 'code-reviewer').map((d) => d.round))],
      publishedRounds: world.publishedRounds
    }).toEqual({
      finalDecision: { type: 'publish' },
      prNumber: world.prNumber,
      developerRounds: [1, 2],
      reviewerRounds: [1, 2],
      publishedRounds: [2]
    })
    await expectContinuedToRoundTwo(world, held)
  })

  it('is watched by the paused driver, which binds it and resumes by itself after the reset; `task run` meanwhile names no dead end', async () => {
    const { world, limit, deps } = strandingWorld()
    const watchSleeps: number[] = []
    const taskRun: { refusal: string | null } = { refusal: null }

    const result = await runDriverLoopInProcess(world, { task: world.task, agent: 'claude' }, deps, {
      sleep: async (ms) => {
        watchSleeps.push(ms)
        // While the driver waits out the limit: the pull request is opened,
        // the limit resets, and someone runs `task run`.
        if (watchSleeps.length === 1) {
          expectPrePrRateLimitPause(world, {
            finalDecision: { type: 'pause', reason: 'infrastructure' },
            prNumber: -1,
            task: world.task
          })
          world.prOpened = true
          limit.active = false
          try {
            await runTask({ issue: world.task, agent: 'claude' }, runTaskDeps(world, deps, { sleep: async () => {} }))
          } catch (err) {
            taskRun.refusal = err instanceof Error ? err.message : String(err)
          }
        }
      },
      readRateLimitReset: async () => 1_000 + 60,
      now: () => 1_000_000
    })

    // One wait, until the reported reset plus its slack — never a poll.
    expect(watchSleeps[0]).toBe(65_000)
    // The one driver kept the task: `task run` was refused, and its refusal
    // says the running driver continues by itself rather than naming a
    // command that refuses in turn.
    expect(taskRun.refusal).toContain('a driver is already running for it')
    expect(taskRun.refusal).toContain('continues the task by itself')
    expect(taskRun.refusal).not.toContain('--resume')

    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(world.dispatches.filter((d) => d.role === 'developer').map((d) => d.round)).toEqual([1, 2])
    expect(world.publishedRounds).toEqual([2])
    const held = readPauseState(world.runtimeDir, world.task)!
    await expectContinuedToRoundTwo(world, held)
  })
})

describe('devReviewLoop --resume <pr> against a pause recorded before any pull request existed', () => {
  function heldPrePrPause(world: LoopWorld): PauseState {
    return {
      task: world.task,
      round: 1,
      head: 'unknown',
      branch: world.branch,
      prNumber: null,
      reason: 'infrastructure',
      detail: rateLimitPauseDetail(0),
      pausedAt: new Date(0).toISOString(),
      agent: 'claude'
    }
  }

  it('refuses a pull request that is not the open one on the pause’s own branch, naming the one that is — and binds nothing', async () => {
    const world = makeWorld({ prOpened: true, developerPushed: true })
    writePauseState(world.runtimeDir, heldPrePrPause(world))

    await expect(
      runLoopInProcess(world, { resumePr: world.prNumber + 1, agent: 'claude' } as LoopInput, {
        fetchPrBody: () => `Closes #${world.task}`
      })
    ).rejects.toThrow(`Continue it with \`vinaya dev-review-loop --resume ${world.prNumber}\``)
    expect(readPauseState(world.runtimeDir, world.task)?.prNumber).toBeNull()
  })

  it('names `task run` when no pull request is open on its branch at all', async () => {
    const world = makeWorld()
    writePauseState(world.runtimeDir, heldPrePrPause(world))

    await expect(runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' } as LoopInput)).rejects.toThrow(
      'Continue it with `vinaya task run'
    )
  })
})

describe('runDriverLoop — which pauses recorded before a pull request it watches', () => {
  function prePrPause(reason: PauseState['reason'], detail: string, extra: Partial<PauseState> = {}): PauseState {
    return {
      task: 1165,
      round: 1,
      head: 'unknown',
      branch: 'task/issue-1165',
      prNumber: null,
      reason,
      detail,
      pausedAt: new Date(0).toISOString(),
      agent: 'claude',
      escalationId: 'esc-1',
      ...extra
    }
  }

  /** A watcher whose first `devReviewLoop` call pauses with `pause`, and whose resume attempts are recorded. */
  function harness(pause: PauseState, openPr: number | null) {
    const continuations: LoopInput[] = []
    const sleeps: number[] = []
    const paused: LoopResult = {
      finalDecision: { type: 'pause', reason: pause.reason, detail: pause.detail },
      prNumber: -1,
      task: 1165
    }
    const watch: Partial<DriverWatchDeps> = {
      devReviewLoop: async (input) => {
        if ('task' in input && continuations.length === 0 && sleeps.length === 0) return paused
        continuations.push(input)
        return { finalDecision: { type: 'publish' }, prNumber: openPr ?? 42, task: 1165 }
      },
      readPauseState: () => pause,
      readResolutionRecord: () => null,
      findOpenPrForBranch: (branch) => (openPr === null ? null : { number: openPr, branch }),
      clearDriverLock: () => {},
      runtimeDir: () => '/nonexistent',
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      infrastructureBackoffMs: 60_000,
      readRateLimitReset: async () => null,
      now: () => 0
    }
    return { watch, continuations, sleeps }
  }

  it('resumes an infrastructure pause through the open pull request after the backoff, under its own lock', async () => {
    const h = harness(prePrPause('infrastructure', 'an uncaught error ended round 1’s own processing: boom'), 42)
    const result = await runDriverLoop({ task: 1165, agent: 'claude' }, {}, h.watch)
    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(h.sleeps).toEqual([60_000])
    expect(h.continuations).toHaveLength(1)
    expect(h.continuations[0]).toMatchObject({ resumePr: 42, agent: 'claude' })
    expect(h.continuations[0]?.retainDriverLock).toBeDefined()
  })

  it('re-enters the task itself when no pull request has been opened yet', async () => {
    const h = harness(prePrPause('infrastructure', rateLimitPauseDetail(0)), null)
    await runDriverLoop({ task: 1165, agent: 'claude' }, {}, h.watch)
    expect(h.continuations).toHaveLength(1)
    expect(h.continuations[0]).toMatchObject({ task: 1165, agent: 'claude' })
  })

  it('stops watching once the task’s bare-resume budget is spent', async () => {
    const h = harness(
      prePrPause('infrastructure', 'an uncaught error ended round 1’s own processing: boom', {
        infrastructureRetries: 5
      }),
      42
    )
    const result = await runDriverLoop({ task: 1165, agent: 'claude' }, {}, h.watch)
    expect(result.finalDecision.type).toBe('pause')
    expect(h.sleeps).toEqual([])
    expect(h.continuations).toEqual([])
  })

  it('never watches a pause that asks a Principal for a decision', async () => {
    const h = harness(prePrPause('escalation', 'needs a call'), 42)
    const result = await runDriverLoop({ task: 1165, agent: 'claude' }, {}, h.watch)
    expect(result.finalDecision.type).toBe('pause')
    expect(h.continuations).toEqual([])
  })

  it('re-enters a stale-driver pause bare when no pull request exists yet', async () => {
    const h = harness(prePrPause('stale_driver', 'base moved'), null)
    const result = await runDriverLoop({ task: 1165, agent: 'claude' }, {}, h.watch)
    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(h.sleeps).toEqual([60_000])
    expect(h.continuations).toHaveLength(1)
    expect(h.continuations[0]).toMatchObject({ task: 1165, agent: 'claude' })
    expect(h.continuations[0]?.retainDriverLock).toBeDefined()
  })

  it('ends on a cancel recorded while it waited', async () => {
    const h = harness(prePrPause('stale_driver', 'base moved'), 42)
    h.watch.readResolutionRecord = () => ({ decision: 'cancel' }) as never
    const result = await runDriverLoop({ task: 1165, agent: 'claude' }, {}, h.watch)
    expect(result.finalDecision).toEqual({ type: 'ended', reason: 'cancelled' })
    expect(h.continuations).toEqual([])
  })

  for (const [openPr, expected] of [
    [null, ['dev-review-loop', '--task', '1165', '--agent', 'claude']] as const,
    [42, ['dev-review-loop', '--resume', '42', '--agent', 'claude']] as const
  ]) {
    it(`hands a stale automatic-recovery pause to a fresh ${openPr === null ? '--task' : '--resume'} driver`, async () => {
      const h = harness(prePrPause('infrastructure', 'temporary failure'), openPr)
      const reexecArgs: string[][] = []
      let reads = 0
      h.watch.gitRevParseOriginMain = () => (++reads === 1 ? 'start' : 'new-driver-code')
      h.watch.gitCommitsTouchingDriverPaths = () => ['apps/cli/src/lib/dev-review-loop.ts']
      h.watch.pullDefaultBranch = () => ({ ok: true })
      h.watch.reexecSelf = (args) => {
        reexecArgs.push(args)
        return 0
      }
      h.watch.exitProcess = (() => undefined) as never

      const result = await runDriverLoop({ task: 1165, agent: 'claude' }, {}, h.watch)

      expect(result.finalDecision.type).toBe('pause')
      expect(h.continuations).toEqual([])
      expect(reexecArgs).toEqual([[...expected]])
    })
  }
})

describe('ownRepoPrForBranch — the bind and the attach only ever take this repository’s own pull request', () => {
  it('refuses a fork’s pull request from a head ref of the same name, and takes the one from this repository', () => {
    const branch = 'task/issue-1165'
    expect(ownRepoPrForBranch([{ number: 9, headRefName: branch, isCrossRepository: true }], branch)).toBeNull()
    expect(
      ownRepoPrForBranch(
        [
          { number: 9, headRefName: branch, isCrossRepository: true },
          { number: 10, headRefName: branch, isCrossRepository: false }
        ],
        branch
      )
    ).toEqual({ number: 10, branch })
    expect(
      ownRepoPrForBranch([{ number: 11, headRefName: 'task/issue-1', isCrossRepository: false }], branch)
    ).toBeNull()
  })
})

describe('a pause whose escalation has no durable record — every refusal names what works', () => {
  function pauseOnPr(world: LoopWorld, extra: Partial<PauseState>): void {
    writePauseState(world.runtimeDir, {
      task: world.task,
      round: 1,
      head: world.head,
      branch: world.branch,
      prNumber: world.prNumber,
      reason: 'escalation',
      pausedAt: new Date(0).toISOString(),
      agent: 'claude',
      ...extra
    })
  }

  function cancelInProcess(world: LoopWorld, cancelPr: number) {
    return withWorldEnv(world, () =>
      cancelDevReviewLoop(
        { cancelPr, agent: 'claude' },
        {
          fetchPrBody: () => world.prBody,
          taskFromPrBody,
          readPauseState,
          fetchRulings: () => ['Go ahead.'],
          fetchNewestRulingOrdinal: () => 1,
          fetchNewestRulingAuthor: () => 'principal-1',
          findOpenPrForBranch: (branch) => (world.prOpened ? { number: world.prNumber, branch } : null),
          runtimeDir: () => world.runtimeDir,
          resolveRepo: async () => null,
          terminateInFlightLaunchesOnShutdown: () => {},
          sleep: (ms) => new Promise((r) => setTimeout(r, ms > 0 ? 1 : 0))
        }
      )
    )
  }

  it('`--resume` refuses a pause that needs a ruling before asking for one, naming the Principal decision — never a `--resume` that refuses again', async () => {
    const world = makeWorld({ developerPushed: true, prOpened: true })
    pauseOnPr(world, {})
    const refusal = runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' } as LoopInput)
    await expect(refusal).rejects.toThrow('no escalation record was ever written')
    await expect(refusal).rejects.toThrow('is a Principal decision')
    await expect(refusal).rejects.not.toThrow('then run `vinaya dev-review-loop --resume')
  })

  it('names the Principal decision for an infrastructure pause whose bare-resume budget is spent', async () => {
    const world = makeWorld({ developerPushed: true, prOpened: true })
    pauseOnPr(world, { reason: 'infrastructure', infrastructureRetries: 5 })
    await expect(runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' } as LoopInput)).rejects.toThrow(
      'is a Principal decision'
    )
  })

  it('`--resume` attaches past a missing record for a bare infrastructure pause, and the run publishes', async () => {
    const world = makeWorld({ developerPushed: true, prOpened: true })
    pauseOnPr(world, { reason: 'infrastructure', detail: 'an uncaught error ended round 1’s own processing: boom' })
    const result = await runLoopInProcess(world, { resumePr: world.prNumber, agent: 'claude' } as LoopInput)
    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(world.publishedRounds).toEqual([1])
  })

  it('`--cancel` appends the continuation that works to its stale-escalation refusal', async () => {
    const world = makeWorld({ developerPushed: true, prOpened: true })
    pauseOnPr(world, { reason: 'infrastructure' })
    const refusal = cancelInProcess(world, world.prNumber)
    await expect(refusal).rejects.toThrow('is stale')
    await expect(refusal).rejects.toThrow('no ruling is needed. Continue it with `vinaya task run')
  })

  it('`--cancel <pr>` against a pause from before the pull request, naming the wrong one, names the open one', async () => {
    const world = makeWorld({ developerPushed: true, prOpened: true })
    pauseOnPr(world, { prNumber: null, head: 'unknown' })
    await expect(cancelInProcess(world, world.prNumber + 1)).rejects.toThrow(
      `cancel it with \`vinaya dev-review-loop --cancel ${world.prNumber}\``
    )
    expect(readPauseState(world.runtimeDir, world.task)?.prNumber).toBeNull()
  })
})
