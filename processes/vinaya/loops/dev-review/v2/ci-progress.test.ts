import { describe, expect, test } from 'bun:test'
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
