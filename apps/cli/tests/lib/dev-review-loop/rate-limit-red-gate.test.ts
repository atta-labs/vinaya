/**
 * A GitHub rate limit that reaches the loop through a red check or a
 * Developer's `tooling_unavailable` block is waited out, never escalated.
 * Every CI job's failure-only budget step prints one `vinaya-budget:` marker
 * line; the loop reads the reset from it — CI's token, never this host's —
 * sleeps to it, reruns the failed jobs and continues the round. The sleep is
 * recorded, never waited, so no test here waits on the clock.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { parse } from 'yaml'
import {
  type DriverWatchDeps,
  type LoopDeps,
  type LoopResult,
  runDriverLoop
} from '../../../src/lib/dev-review-loop.js'
import type { PauseState } from '../../../src/lib/dev-review-loop/pause-resume.js'
import {
  isRateLimitPauseDetail,
  RATE_LIMIT_FALLBACK_WAIT_MS,
  rateLimitPauseDetail,
  rateLimitResetFromDetail
} from '../../../src/lib/dev-review-loop/round-assess.js'
import {
  blockedTurnOutput,
  cleanupWorlds,
  completedTurnOutput,
  type LoopWorld,
  makeInProcessDeps,
  makeWorld,
  runLoopInProcess
} from '../dev-review-loop-harness.js'

afterEach(cleanupWorlds)

const AGENTS = ['claude', 'codex'] as const
/** Any wait at least this long is a rate-limit wait; the harness's own poll sleeps are far shorter. */
const LONG_WAIT_MS = 60_000
const SLACK_MS = 5_000
const WORKFLOW_RUN = 4242

const JOB = { id: 7001, name: 'Test (apps/cli, shard 1)', conclusion: 'failure' }
const AGGREGATE = { id: 7002, name: 'Vinaya CI', conclusion: 'failure' }
/** A failed workflow-run entry: no job, so no log is read for it. */
const WORKFLOW_ENTRY = {
  id: WORKFLOW_RUN,
  name: 'CI',
  conclusion: 'failure',
  detail: `workflow CI run ${WORKFLOW_RUN} ended failure`
}

/** A job log tail as GitHub prints it: every line timestamped. */
const tail = (...lines: string[]) => lines.map((line) => `2026-10-18T10:00:00.0000000Z ${line}`).join('\n')
const marker = (exhausted: 'core' | 'graphql' | 'none', coreReset: number, graphqlReset = coreReset + 900) =>
  `vinaya-budget: exhausted=${exhausted} core_remaining=${exhausted === 'core' ? 0 : 4000} core_reset=${coreReset} graphql_remaining=${exhausted === 'graphql' ? 0 : 4000} graphql_reset=${graphqlReset}`
const aggregateLog = (reset: number) =>
  tail('A required job did not succeed: failure', 'vinaya-needs: a required job ended failure', marker('none', reset))

/** A reset ten minutes from now, in epoch seconds — what CI's own marker names. */
function ciReset(): number {
  return Math.floor(Date.now() / 1000) + 600
}

/** The wait the loop takes to `resetEpochSeconds`, within the few seconds the test itself spends. */
function expectWaitTo(waitMs: number | undefined, resetEpochSeconds: number): void {
  const expected = resetEpochSeconds * 1000 - Date.now() + SLACK_MS
  expect(waitMs).toBeDefined()
  expect(Math.abs((waitMs as number) - expected)).toBeLessThan(10_000)
}

/** A red head whose one test job ran out of CI's core budget (its rate-limit wording scrolled out of the tail), plus its workflow-run entry and the aggregate job that failed only on its `needs`. */
function rateLimitedRedWorld(reset: number): LoopWorld {
  const world = makeWorld({ worktreeExists: true })
  world.gate = 'red'
  world.failingCheckRuns = [{ ...JOB }, { ...AGGREGATE }, { ...WORKFLOW_ENTRY }] as never
  world.failedCheckLogTails = {
    [JOB.id]: tail('(fail) reads the pull request', 'error: gh exited 1', marker('core', reset)),
    [AGGREGATE.id]: aggregateLog(reset)
  }
  return world
}

/** The world's own deps, with every Developer prompt, every long sleep and every forge rerun recorded in one ordered event list. */
function recordingDeps(
  world: LoopWorld,
  afterRerun: (rerunCount: number) => void,
  extra: Partial<LoopDeps> = {}
): { deps: Partial<LoopDeps>; prompts: string[]; events: string[]; longSleeps: number[] } {
  const base = makeInProcessDeps(world)
  const prompts: string[] = []
  const events: string[] = []
  const longSleeps: number[] = []
  let reruns = 0
  const deps: Partial<LoopDeps> = {
    dispatchRole: async (role, agent, prompt, opts) => {
      if (role === 'developer') {
        prompts.push(prompt)
        events.push('developer')
      }
      return base.dispatchRole!(role, agent, prompt, opts)
    },
    sleep: async (ms) => {
      if (ms >= LONG_WAIT_MS) {
        longSleeps.push(ms)
        events.push('sleep')
        return
      }
      await base.sleep!(ms)
    },
    fetchFailedCheckWorkflowRunIds: () =>
      world.gate === 'red' && world.failingCheckRuns.length > 0 ? [WORKFLOW_RUN] : [],
    rerunFailedWorkflowJobs: (runId) => {
      reruns += 1
      events.push(`rerun:${runId}`)
      afterRerun(reruns)
    },
    readRateLimitReset: async () => {
      events.push('host-budget-read')
      return null
    },
    ...extra
  }
  return { deps, prompts, events, longSleeps }
}

const turnGreen = (world: LoopWorld) => () => {
  world.gate = 'green'
  world.failingCheckRuns = []
  world.failedCheckLogTails = {}
}

describe('a rate-limited red gate is waited out, rerun and continued — never sent to the Developer', () => {
  for (const agent of AGENTS) {
    it(`${agent}: a failed job, its workflow-run entry and the aggregate job lead to one sleep to the marker's reset, one rerun, and the round going on`, async () => {
      const reset = ciReset()
      const world = rateLimitedRedWorld(reset)
      const { deps, prompts, events, longSleeps } = recordingDeps(world, turnGreen(world))
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)

      expect(result.finalDecision).toEqual({ type: 'publish' })
      expect(longSleeps).toHaveLength(1)
      expectWaitTo(longSleeps[0], reset)
      // Slept first, then reran: a rerun during the limit would fail again.
      expect(events.filter((e) => e !== 'developer')).toEqual(['sleep', `rerun:${WORKFLOW_RUN}`])
      // The red never reached the Developer: one turn, the round's own.
      expect(prompts).toHaveLength(1)
      expect(prompts.some((p) => p.includes('CI is red on the last head'))).toBe(false)
      expect(world.dispatches.filter((d) => d.role === 'code-reviewer')).toHaveLength(1)
      // The host's own budget is never read for a red check.
      expect(events).not.toContain('host-budget-read')
    })

    it(`${agent}: a job whose rate-limit wording scrolled out counts as rate-limited by its marker alone`, async () => {
      const reset = ciReset()
      const world = rateLimitedRedWorld(reset)
      world.failingCheckRuns = [{ ...JOB }]
      world.failedCheckLogTails = { [JOB.id]: tail('(fail) one test', marker('graphql', reset - 300, reset)) }
      const { deps, prompts, longSleeps } = recordingDeps(world, turnGreen(world))
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)
      expect(result.finalDecision).toEqual({ type: 'publish' })
      expect(longSleeps).toHaveLength(1)
      expectWaitTo(longSleeps[0], reset)
      expect(prompts).toHaveLength(1)
    })

    it(`${agent}: a rate-limited job with no marker line waits the fixed fallback, never the host's reset`, async () => {
      const world = rateLimitedRedWorld(ciReset())
      world.failingCheckRuns = [{ ...JOB }]
      world.failedCheckLogTails = { [JOB.id]: tail('GraphQL: API rate limit exceeded for installation ID 1') }
      const { deps, events, longSleeps } = recordingDeps(world, turnGreen(world))
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)
      expect(result.finalDecision).toEqual({ type: 'publish' })
      expect(longSleeps).toEqual([RATE_LIMIT_FALLBACK_WAIT_MS])
      expect(events).not.toContain('host-budget-read')
    })

    it(`${agent}: a real test failure still goes back to the Developer, the rate-limited job included`, async () => {
      const reset = ciReset()
      const world = rateLimitedRedWorld(reset)
      world.failingCheckRuns = [{ ...JOB }, { id: 7003, name: 'Test (apps/cli, shard 2)', conclusion: 'failure' }]
      world.failedCheckLogTails = {
        [JOB.id]: tail('(fail) reads the pull request', marker('core', reset)),
        7003: tail('(fail) adds two numbers', 'error: expect(received).toBe(expected)', marker('none', reset))
      }
      const { deps, prompts, events, longSleeps } = recordingDeps(world, () => {}, {})
      const base = deps.dispatchRole!
      deps.dispatchRole = async (role, a, prompt, opts) => {
        const handle = await base(role, a, prompt, opts)
        if (role === 'developer' && prompts.length === 2) turnGreen(world)()
        return handle
      }
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)
      expect(result.finalDecision).toEqual({ type: 'publish' })
      expect(longSleeps).toEqual([])
      expect(events.some((e) => e.startsWith('rerun:'))).toBe(false)
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('CI is red on the last head')
      expect(prompts[1]).toContain('adds two numbers')
      expect(prompts[1]).toContain(JOB.name)
    })

    it(`${agent}: a real failure in a job whose marker shows a spent budget is waited out and rerun once, then goes to the Developer`, async () => {
      const reset = ciReset()
      const world = rateLimitedRedWorld(reset)
      world.failingCheckRuns = [{ ...JOB }]
      world.failedCheckLogTails = { [JOB.id]: tail('(fail) adds two numbers', marker('core', reset)) }
      // The rerun ran with a fresh budget, and the test failed again for real.
      const { deps, prompts, events, longSleeps } = recordingDeps(world, () => {
        world.failedCheckLogTails = { [JOB.id]: tail('(fail) adds two numbers', marker('none', reset + 3600)) }
      })
      const base = deps.dispatchRole!
      deps.dispatchRole = async (role, a, prompt, opts) => {
        const handle = await base(role, a, prompt, opts)
        if (role === 'developer' && prompts.length === 2) turnGreen(world)()
        return handle
      }
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)
      expect(result.finalDecision).toEqual({ type: 'publish' })
      expect(longSleeps).toHaveLength(1)
      expect(events.filter((e) => e.startsWith('rerun:'))).toEqual([`rerun:${WORKFLOW_RUN}`])
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('CI is red on the last head')
      expect(prompts[1]).toContain('adds two numbers')
    })

    it(`${agent}: a third consecutive rate-limited red pauses with the no-ruling detail and the reset it last read`, async () => {
      const reset = ciReset()
      const world = rateLimitedRedWorld(reset)
      // Every rerun is refused on the limit again.
      const { deps, prompts, events, longSleeps } = recordingDeps(world, () => {})
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)

      expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
      const detail = (result.finalDecision as { detail?: string }).detail
      expect(isRateLimitPauseDetail(detail)).toBe(true)
      expect(detail).toContain('No ruling is needed')
      expect(detail).toContain('2 times')
      expect(rateLimitResetFromDetail(detail)).toBe(reset)
      expect(longSleeps).toHaveLength(2)
      expect(events.filter((e) => e !== 'developer')).toEqual([
        'sleep',
        `rerun:${WORKFLOW_RUN}`,
        'sleep',
        `rerun:${WORKFLOW_RUN}`
      ])
      expect(prompts).toHaveLength(1)
      const held = JSON.parse(
        readFileSync(
          join(world.runtimeDir, 'tasks-execution', String(world.task), 'control', 'pause-state.json'),
          'utf8'
        )
      ) as PauseState
      expect(rateLimitResetFromDetail(held.detail)).toBe(reset)
    })
  }
})

describe('a tooling_unavailable turn during a rate limit sleeps to the right reset and is re-dispatched', () => {
  for (const agent of AGENTS) {
    it(`${agent}: with rate-limited failed jobs on the head, it sleeps to their marker's reset before the rerun, then re-dispatches`, async () => {
      const reset = ciReset()
      const world = rateLimitedRedWorld(reset)
      world.developerTurnOutput = (_round, _prompt, dispatch) =>
        dispatch === 1 ? blockedTurnOutput('tooling_unavailable', 'gh refused: rate limited') : completedTurnOutput()
      const { deps, prompts, events, longSleeps } = recordingDeps(world, turnGreen(world))
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)

      expect(result.finalDecision).toEqual({ type: 'publish' })
      expect(longSleeps).toHaveLength(1)
      expectWaitTo(longSleeps[0], reset)
      expect(events.slice(0, 4)).toEqual(['developer', 'sleep', `rerun:${WORKFLOW_RUN}`, 'developer'])
      expect(events).not.toContain('host-budget-read')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('never yours to escalate')
      expect(world.dispatches.filter((d) => d.role === 'developer').map((d) => d.round)).toEqual([1, 1])
    })

    it(`${agent}: with no rate-limited job but a spent host budget, it sleeps to that budget's reset, then re-dispatches`, async () => {
      const hostReset = Math.floor(Date.now() / 1000) + 1200
      const world = makeWorld({ worktreeExists: true })
      world.developerTurnOutput = (_round, _prompt, dispatch) =>
        dispatch === 1 ? blockedTurnOutput('tooling_unavailable', 'gh refused') : completedTurnOutput()
      const { deps, prompts, events, longSleeps } = recordingDeps(world, () => {}, {})
      deps.readRateLimitReset = async () => {
        events.push('host-budget-read')
        return hostReset
      }
      const result = await runLoopInProcess(world, { task: world.task, agent }, deps)

      expect(result.finalDecision).toEqual({ type: 'publish' })
      expect(longSleeps).toHaveLength(1)
      expectWaitTo(longSleeps[0], hostReset)
      expect(events.slice(0, 4)).toEqual(['developer', 'host-budget-read', 'sleep', 'developer'])
      expect(events.some((e) => e.startsWith('rerun:'))).toBe(false)
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain("driver's own GitHub token")
    })
  }
})

describe('the watching driver resumes a rate-limit pause at the reset it recorded', () => {
  const NOW_MS = 1_000_000_000_000
  const RECORDED = NOW_MS / 1000 + 900
  const HOST = NOW_MS / 1000 + 120

  it("sleeps to the recorded reset, never reads the host's, and resumes", async () => {
    const detail = `${rateLimitPauseDetail(2, RECORDED)} (round 1: the failed checks on head abc was still refused)`
    const pause: LoopResult = {
      finalDecision: { type: 'pause', reason: 'infrastructure', detail },
      prNumber: 7,
      task: 1449
    }
    const held: PauseState = {
      task: 1449,
      round: 1,
      head: 'abc',
      branch: 'task/issue-1449',
      prNumber: 7,
      reason: 'infrastructure',
      detail,
      pausedAt: new Date(NOW_MS).toISOString(),
      escalationId: 'esc-1'
    }
    const sleeps: number[] = []
    const resumes: unknown[] = []
    let hostReads = 0
    const watch: Partial<DriverWatchDeps> = {
      devReviewLoop: async (input) => {
        if (!('resumePr' in input)) return pause
        resumes.push(input.resumePr)
        return { finalDecision: { type: 'publish' }, prNumber: 7, task: 1449 }
      },
      // Open while the pause is watched; merged once the resumed run has published it.
      fetchPrState: () => (resumes.length > 0 ? 'MERGED' : 'OPEN'),
      fetchNewestRulingOrdinal: () => 0,
      readPauseState: () => held,
      readResolutionRecord: () => null,
      clearDriverLock: () => {},
      runtimeDir: () => '/nonexistent',
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      watchPollIntervalMs: 1,
      infrastructureBackoffMs: 60_000,
      readRateLimitReset: async () => {
        hostReads += 1
        return HOST
      },
      now: () => NOW_MS
    }
    const result = await runDriverLoop({ task: 1449, agent: 'claude' }, {}, watch)
    expect(result.finalDecision).toEqual({ type: 'publish' })
    expect(sleeps).toEqual([900_000 + SLACK_MS])
    expect(hostReads).toBe(0)
    expect(resumes).toEqual([7])
  })
})

describe('every CI job ends with the failure-only budget step', () => {
  const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
  const STEP = "Report this job's GitHub token budget"
  // The temporary limits step may follow the budget step; it is judged by its own test.
  const LIMITS_STEP = "Print the limits of this job's GitHub reads"
  for (const file of [
    'ci.yml',
    'vinaya-checks.yml',
    'vinaya-body-checks.yml',
    'vinaya-review.yml',
    'vinaya-review-verdict.yml',
    'vinaya-archivist.yml'
  ]) {
    it(`${file}: every job's last step runs only on failure and never fails the job again`, () => {
      const workflow = parse(readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8')) as {
        jobs: Record<
          string,
          { steps: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }> }
        >
      }
      for (const [job, { steps }] of Object.entries(workflow.jobs)) {
        const budgetSteps = steps.filter((step) => step.name !== LIMITS_STEP)
        const last = budgetSteps[budgetSteps.length - 1]!
        expect(`${job}: ${last.name}`).toBe(`${job}: ${STEP}`)
        expect(last.if).toBe('failure()')
        expect(last.run).toContain('gh api rate_limit')
        expect(last.run?.trimEnd().endsWith('|| true')).toBe(true)
        // The one job that holds no forge credential by design reads no budget.
        if (!(file === 'ci.yml' && job === 'test-cli-config-anchor'))
          expect(last.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
      }
    })
  }

  it("ci.yml's aggregate job names an upstream failure on its own line", () => {
    const text = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(text).toContain('echo "vinaya-needs: a required job ended $result"')
  })
})
