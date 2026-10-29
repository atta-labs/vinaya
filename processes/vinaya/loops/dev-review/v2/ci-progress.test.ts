import { describe, expect, test } from 'bun:test'
import { initialLoopState } from '@attalabs/aeg-core'
import type { ActionContext } from '../../../../../harness/dev-process/engine-runtime/run-process'
import type { TaskInput } from '../../../executing/actions'
import { readCiOnce, type V2Functions } from './v2-actions'
import {
  type CiJob,
  type CiWorkflowRun,
  createCiProgress,
  QUEUE_BOUND_MS,
  type RequiredCiRead,
  type RequiredCiView,
  readRequiredCiLive
} from './ci-recovery'

// The CI wait's progress: lines from what the strict CI read already saw, never a read of its own and never a say in
// its verdict.

const HEAD = 'a'.repeat(40)
const WORKFLOW = '.github/workflows/ci.yml'
const CHECK = 'Vinaya CI'
const T0 = Date.parse('2026-10-29T10:00:00Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()

const run: CiWorkflowRun = {
  id: 7,
  path: WORKFLOW,
  head_sha: HEAD,
  run_attempt: 1,
  status: 'in_progress',
  conclusion: null,
  html_url: 'https://ci/run/7',
  created_at: iso(0),
  run_started_at: iso(0)
}

function job(id: number, name: string, fields: Partial<CiJob> = {}): CiJob {
  return {
    id,
    run_id: 7,
    run_attempt: 1,
    head_sha: HEAD,
    name,
    status: 'queued',
    conclusion: null,
    created_at: iso(0),
    started_at: null,
    completed_at: null,
    html_url: `https://ci/job/${id}`,
    runner_id: null,
    steps: [],
    ...fields
  }
}

const build = job(1, 'Build, lint & typecheck', {
  status: 'completed',
  conclusion: 'success',
  started_at: iso(0),
  completed_at: iso(95_000),
  runner_id: 1
})
const failedSandbox = job(2, 'Sandbox conformance (Linux)', {
  status: 'completed',
  conclusion: 'failure',
  started_at: iso(100_000),
  completed_at: iso(160_000),
  runner_id: 2,
  steps: [{ name: 'Run the suite under both sandboxes', number: 4, status: 'completed', conclusion: 'failure' }]
})
const failedTests = job(3, 'Test (cli 1)', {
  status: 'completed',
  conclusion: 'failure',
  started_at: iso(100_000),
  completed_at: iso(220_000),
  runner_id: 3,
  steps: [{ name: 'Test', number: 5, status: 'completed', conclusion: 'failure' }]
})

/** A fake `gh`: answers the runs and jobs reads, and records every call. */
function forge(jobs: CiJob[]) {
  const calls: string[] = []
  const logReads: string[] = []
  return {
    calls,
    logReads,
    gh: (args: string[]) => {
      calls.push(args.join(' '))
      const path = args[1] ?? ''
      if (path.includes('/actions/runs?head_sha=')) return `${JSON.stringify(run)}\n`
      if (path.includes('/jobs?')) return jobs.map((j) => JSON.stringify(j)).join('\n')
      throw new Error(`unexpected read ${path}`)
    },
    readLog: (jobId: number, step: number) => {
      logReads.push(`${jobId}/${step}`)
      return 'bwrap: No permissions to create new namespace\n'
    }
  }
}

const request = { head: HEAD, workflow: WORKFLOW, check: CHECK, now: T0 + 300_000 }

describe('the strict CI read with progress on', () => {
  test('makes the same forge calls, reads a failed job’s log once, and reaches the same verdict on, off and throwing', () => {
    const jobs = [
      build,
      failedSandbox,
      job(4, 'Test (cli 2)', { status: 'in_progress', started_at: iso(100_000), runner_id: 4 })
    ]
    const off = forge(jobs)
    const offRead = readRequiredCiLive(request, undefined, off)
    const on = forge(jobs)
    const seen: RequiredCiView[] = []
    const onRead = readRequiredCiLive(request, (view) => seen.push(view), on)
    const throwing = forge(jobs)
    const throwingRead = readRequiredCiLive(
      request,
      () => {
        throw new Error('the progress sink is broken')
      },
      throwing
    )
    expect(onRead).toEqual(offRead)
    expect(throwingRead).toEqual(offRead)
    expect(on.calls).toEqual(off.calls)
    expect(throwing.calls).toEqual(off.calls)
    expect(off.calls).toHaveLength(2)
    expect(on.logReads).toEqual(['2/4'])
    expect(on.logReads).toEqual(off.logReads)
    expect(seen).toEqual([{ run, jobs }])
    expect(offRead.state).toBe('red')
  })
})

describe('the CI wait’s lines', () => {
  const capture = () => {
    const lines: string[] = []
    let now = T0
    return {
      lines,
      advance: (ms: number) => {
        now += ms
      },
      progress: createCiProgress(
        (line) => lines.push(line),
        () => now
      )
    }
  }

  test('one line per job as it completes, the first red job, and a failed test job’s first failing test from the send-back excerpt', () => {
    const { lines, progress } = capture()
    progress.observe({ run, jobs: [build, job(3, 'Test (cli 1)', { status: 'in_progress', runner_id: 3 })] })
    expect(lines).toEqual(['CI progress: Build, lint & typecheck ✓, 1 min 35 s'])
    // The same completed job read again on the next poll writes nothing more.
    progress.observe({ run, jobs: [build, job(3, 'Test (cli 1)', { status: 'in_progress', runner_id: 3 })] })
    expect(lines).toHaveLength(1)
    progress.observe({ run, jobs: [build, failedTests] })
    const red: RequiredCiRead = {
      state: 'red',
      runId: 7,
      runUrl: run.html_url,
      failures: [{ job: 'Test (cli 1)', jobId: 3, url: null, step: 'Test', kind: 'code' }]
    }
    progress.result(red)
    expect(lines.at(-1)).toBe('CI progress: first red job: Test (cli 1)')
    progress.result(red)
    expect(lines.filter((line) => line.includes('first red job'))).toHaveLength(1)
    // The send-back's own excerpt read, never one of progress's own.
    progress.excerpt(
      'Test (cli 1)',
      '2026-10-29T10:03:00.0000000Z tests/lib/a.test.ts:\n2026-10-29T10:03:00.0000000Z (fail) a breaks [2.00ms]\n'
    )
    progress.flush()
    expect(lines.at(-1)).toBe(
      'CI progress: Test (cli 1) ✗, 2 min 00 s — first failing test: tests/lib/a.test.ts: a breaks'
    )
  })

  test('a job queued without a runner, a pause for an infrastructure failure and the execution ceiling each show', () => {
    const { lines, progress } = capture()
    progress.result({
      state: 'stalled',
      bound: 'queue',
      job: 'Test (cli 2)',
      jobId: 4,
      url: null,
      detail: 'waited'
    })
    progress.paused('the required check failed for a reason the driver reads as a CI setup or provider failure')
    progress.result({
      state: 'stalled',
      bound: 'execution',
      job: 'Test (cli 3)',
      jobId: 5,
      url: null,
      detail: 'the job Test (cli 3) has run for over 20 minutes'
    })
    expect(lines).toEqual([
      `CI progress: Test (cli 2) queued ${QUEUE_BOUND_MS / 60000} min without a runner`,
      'CI progress: paused for an infrastructure failure: the required check failed for a reason the driver reads as a CI setup or provider failure',
      'CI progress: execution ceiling reached: the job Test (cli 3) has run for over 20 minutes'
    ])
  })

  test('the 60-second line reads only what the last read saw: jobs done of total, failures and elapsed time', () => {
    const { lines, progress, advance } = capture()
    const reads = forge([build, failedSandbox])
    readRequiredCiLive(request, progress.observe, reads)
    const before = [...reads.calls]
    advance(61_000)
    progress.summary()
    expect(lines.at(-1)).toBe('CI progress: 2/2 jobs done, 1 failing, 1 min 01 s elapsed')
    expect(reads.calls).toEqual(before)
  })

  test('a throwing line writer leaves every method harmless', () => {
    const progress = createCiProgress(
      () => {
        throw new Error('the driver log is unwritable')
      },
      () => T0
    )
    expect(() => {
      progress.observe({ run, jobs: [build, failedTests] })
      progress.result({ state: 'red', runId: 7, runUrl: null, failures: [] })
      progress.paused('x')
      progress.excerpt('Test (cli 1)', null)
      progress.flush()
      progress.summary()
    }).not.toThrow()
  })
})

/**
 * The CI wait itself, with progress on: `readCiOnce` over a head whose ready push deferred its tests, driving the
 * strict read through `readRequiredCiLive` against a fake forge, one jobs list per poll.
 */
describe('the required-CI wait with progress on', () => {
  type Run = { lines: string[]; ticks: (() => void)[]; cancelled: number; excerptReads: number[]; pauses: string[] }

  async function wait(
    polls: CiJob[][],
    options: { lines?: boolean; throwingLines?: boolean; failingRuns?: { name: string; id: number }[] } = {}
  ): Promise<{ result: { exitCode: number; stdout: string }; run: Run; forgeCalls: string[] }> {
    const run: Run = { lines: [], ticks: [], cancelled: 0, excerptReads: [], pauses: [] }
    const forgeCalls: string[] = []
    let poll = 0
    // Twelve minutes in: past the queue bound for a job eligible since the build finished, short of the ceiling.
    const now = T0 + 720_000
    const fns = {
      findOpenPullRequest: () => ({ number: 11 }),
      readRequiredCi: (request: typeof requestShape, observe?: (view: RequiredCiView) => void) => {
        const jobs = polls[Math.min(poll, polls.length - 1)] as CiJob[]
        poll += 1
        const reads = forge(jobs)
        const read = readRequiredCiLive(request, observe, reads)
        forgeCalls.push(...reads.calls)
        return read
      },
      readCheckExcerpt: (jobId: number) => {
        run.excerptReads.push(jobId)
        return 'tests/lib/a.test.ts:\n(fail) a breaks [2.00ms]\n'
      },
      now: () => now,
      wallNow: () => now,
      ...(options.lines === false
        ? {}
        : {
            progressLine: (line: string) => {
              if (options.throwingLines) throw new Error('the driver log is unwritable')
              run.lines.push(line)
            },
            progressEvery: (fn: () => void) => {
              run.ticks.push(fn)
              return () => {
                run.cancelled += 1
              }
            }
          })
    } as unknown as V2Functions
    const task = {
      runtimeDir: '/nowhere',
      issueNumber: 7,
      branch: 'task/issue-7',
      worktreePath: '/nowhere',
      flow: 'v2',
      v2: fns,
      reviewRound: () => 1,
      remoteHead: () => HEAD,
      loopState: initialLoopState({
        loopId: 'loop-1',
        task: 7,
        reviewers: ['code-reviewer'],
        models: {},
        maxRounds: 3,
        maxTaskMinutes: 0
      }),
      gatePoll: { gatePollMaxAttempts: polls.length, gatePollIntervalMs: 0, sleep: async () => {} },
      handoff: { pause: (request: { detail: string }) => run.pauses.push(request.detail) },
      bound: {
        readWorktreeHead: () => HEAD,
        fetchCiConclusion: () => 'pending',
        fetchFailingCheckRuns: () => options.failingRuns ?? [],
        discardHeldVerdicts: () => {}
      }
    } as unknown as TaskInput
    const context = {
      nodeId: 'read-ci-once',
      action: 'read-ci-once',
      results: {
        'ready-push': {
          exitCode: 0,
          stdout: JSON.stringify({ requiredCi: { workflow: WORKFLOW, check: CHECK, head: HEAD } })
        }
      }
    } as unknown as ActionContext
    const result = await readCiOnce(task, context)
    return { result, run, forgeCalls }
  }
  const requestShape = request

  const pending = job(4, 'Test (cli 2)', { status: 'in_progress', started_at: iso(100_000), runner_id: 4 })
  const queued = job(5, 'Test (cli 3)', { status: 'queued', created_at: iso(100_000) })

  test('a completed job and a job queued without a runner show before the wait ends; the timer runs and stops', async () => {
    const { result, run } = await wait([
      [build, pending],
      [build, pending, queued]
    ])
    expect(run.lines).toEqual([
      'CI progress: Build, lint & typecheck ✓, 1 min 35 s',
      `CI progress: Test (cli 3) queued ${QUEUE_BOUND_MS / 60000} min without a runner`
    ])
    expect(run.pauses).toHaveLength(1)
    expect(JSON.parse(result.stdout).stalled).toBe('queue')
    // The 60-second line is on a timer the wait stops on its way out; firing it reads nothing.
    expect(run.ticks).toHaveLength(1)
    run.ticks[0]?.()
    expect(run.lines.at(-1)).toBe('CI progress: 1/3 jobs done, 0 failing, 0 ms elapsed')
    expect(run.cancelled).toBe(1)
  })

  test('the first red job, then the failed job with its first failing test from the send-back’s own excerpt read', async () => {
    const { run } = await wait([[build, failedTests]], { failingRuns: [{ name: 'Test (cli 1)', id: 3 }] })
    expect(run.lines).toEqual([
      'CI progress: Build, lint & typecheck ✓, 1 min 35 s',
      'CI progress: first red job: Test (cli 1)',
      'CI progress: Test (cli 1) ✗, 2 min 00 s — first failing test: tests/lib/a.test.ts: a breaks'
    ])
    // The one excerpt read is the send-back's; progress adds none.
    expect(run.excerptReads).toEqual([3])
  })

  test('a wait still pending at the end of the poll budget is never called an infrastructure failure', async () => {
    const { run } = await wait([
      [build, pending],
      [build, pending]
    ])
    expect(run.lines.at(-1)).toStartWith('CI progress: still pending when the poll budget ran out: ')
    expect(run.lines.some((line) => line.includes('infrastructure'))).toBe(false)
  })

  test('the decision, its record and the forge calls are the same with progress off, on and throwing', async () => {
    const polls = [
      [build, pending],
      [build, failedTests]
    ]
    const failingRuns = [{ name: 'Test (cli 1)', id: 3 }]
    const off = await wait(polls, { lines: false, failingRuns })
    const on = await wait(polls, { failingRuns })
    const throwing = await wait(polls, { throwingLines: true, failingRuns })
    for (const other of [on, throwing]) {
      expect(other.result.exitCode).toBe(off.result.exitCode)
      expect(other.result.stdout).toBe(off.result.stdout)
      expect(other.forgeCalls).toEqual(off.forgeCalls)
      expect(other.run.excerptReads).toEqual(off.run.excerptReads)
    }
  })
})
