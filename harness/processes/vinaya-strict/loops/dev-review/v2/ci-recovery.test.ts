import { describe, expect, test } from 'bun:test'
import {
  BUDGET_STEP,
  type CiJob,
  type CiWorkflowRun,
  classifyFailedJob,
  classifyFailedJobLive,
  EXECUTION_CEILING_MS,
  judgeRequiredCi,
  latestWorkflowRun,
  QUEUE_BOUND_MS,
  readStepLog,
  SANDBOX_SETUP_DIAGNOSTICS,
  sliceStepLog
} from './ci-recovery'

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const WORKFLOW = '.github/workflows/ci.yml'
const CHECK = 'Vinaya CI'
const T0 = Date.parse('2026-10-29T00:00:00Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()

const run = (fields: Partial<CiWorkflowRun> = {}): CiWorkflowRun => ({
  id: 100,
  path: WORKFLOW,
  head_sha: HEAD,
  run_attempt: 1,
  status: 'in_progress',
  conclusion: null,
  html_url: 'https://github.com/o/r/actions/runs/100',
  created_at: iso(0),
  run_started_at: iso(0),
  ...fields
})

let nextId = 1
const job = (name: string, fields: Partial<CiJob> = {}): CiJob => ({
  id: nextId++,
  run_id: 100,
  run_attempt: 1,
  head_sha: HEAD,
  name,
  status: 'completed',
  conclusion: 'success',
  created_at: iso(0),
  started_at: iso(1000),
  completed_at: iso(60_000),
  html_url: `https://github.com/o/r/actions/runs/100/job/${name}`,
  runner_id: 7,
  steps: [],
  ...fields
})

const testStep = (conclusion: string | null, name = 'Test shard 1') => ({
  name,
  number: 6,
  status: 'completed',
  conclusion
})

const judge = (r: CiWorkflowRun | null, jobs: CiJob[] | null, now = T0 + 120_000) =>
  judgeRequiredCi({
    head: HEAD,
    workflow: WORKFLOW,
    check: CHECK,
    run: r,
    jobs,
    now,
    classify: (j) => classifyFailedJob(j)
  })

describe('the strict required-CI read', () => {
  test('green only on the configured workflow run for this head whose required check job completed success', () => {
    const read = judge(run({ status: 'completed', conclusion: 'success' }), [
      job('Test (apps/cli, shard 1)'),
      job(CHECK)
    ])
    expect(read.state).toBe('green')
    if (read.state === 'green') {
      expect(read.identity).toMatchObject({ head: HEAD, workflow: WORKFLOW, check: CHECK, runId: 100, runAttempt: 1 })
      expect(read.identity.checkRunId).toBeGreaterThan(0)
    }
  })

  test.each([
    ['no run for the head', null, []],
    [
      'a queued attempt',
      run({ status: 'queued' }),
      [job(CHECK, { status: 'queued', conclusion: null, runner_id: null, created_at: iso(110_000) })]
    ],
    ['tests still running', run(), [job('Test (shared packages)', { status: 'in_progress', conclusion: null })]],
    ['a required check not started', run(), [job('Build, lint & typecheck')]]
  ])('%s is pending, never green', (_name, r, jobs) => {
    expect(judge(r as CiWorkflowRun | null, jobs as CiJob[]).state).toBe('pending')
  })

  test.each(['skipped', 'neutral', 'cancelled'])(
    'a required check that completed %s never counts as the tests passing',
    (conclusion) => {
      const read = judge(run({ status: 'completed', conclusion }), [job(CHECK, { conclusion })])
      expect(read.state).toBe('red')
      if (read.state === 'red') expect(read.failures[0]?.kind).not.toBe('code')
    }
  )

  test('a required check completed success on a run not yet completed reads pending, and green once the run completes', () => {
    const jobs = [job('Test (apps/cli, shard 1)'), job(CHECK)]
    for (const status of ['in_progress', 'queued']) {
      const read = judge(run({ status, conclusion: null }), jobs)
      expect(read.state).toBe('pending')
      if (read.state === 'pending') expect(read.detail).not.toContain('never counts as the tests passing')
    }
    expect(judge(run({ status: 'completed', conclusion: 'success' }), jobs).state).toBe('green')
  })

  test.each(['skipped', 'neutral', 'cancelled', 'failure'])(
    'a required check that completed %s on a run not yet completed still reads red',
    (conclusion) => {
      expect(judge(run({ status: 'in_progress', conclusion: null }), [job(CHECK, { conclusion })]).state).toBe('red')
    }
  )

  test('a stale-head, wrong-workflow or unrelated successful run does not satisfy the head', () => {
    const runs = [
      run({ id: 1, head_sha: OTHER, status: 'completed', conclusion: 'success' }),
      run({ id: 2, path: '.github/workflows/vinaya-checks.yml', status: 'completed', conclusion: 'success' })
    ]
    expect(latestWorkflowRun(runs, WORKFLOW, HEAD)).toBeNull()
    // A job of another head inside the bound run is ignored too.
    expect(judge(run({ status: 'completed', conclusion: 'success' }), [job(CHECK, { head_sha: OTHER })]).state).toBe(
      'pending'
    )
    // So is an unrelated successful job that is not the required check.
    expect(judge(run({ status: 'completed', conclusion: 'success' }), [job('Some other check')]).state).toBe('pending')
  })

  test('the first completed failing test job reads red at once while other jobs are still pending', () => {
    const read = judge(run(), [
      job('Test (apps/cli, shard 2)', { conclusion: 'failure', steps: [testStep('failure', 'Test shard 2')] }),
      job('Test (apps/cli, shard 3)', { status: 'in_progress', conclusion: null }),
      job(CHECK, { status: 'queued', conclusion: null, runner_id: null })
    ])
    expect(read.state).toBe('red')
    if (read.state === 'red') expect(read.failures).toMatchObject([{ kind: 'code', step: 'Test shard 2' }])
  })

  test('reruns resolve deterministically: the latest attempt decides, a newer failure supersedes an older success and a successful rerun supersedes its failure', () => {
    const older = run({ id: 100, run_attempt: 1, status: 'completed', conclusion: 'success' })
    const failedRerun = run({
      id: 100,
      run_attempt: 2,
      status: 'completed',
      conclusion: 'failure',
      run_started_at: iso(500_000)
    })
    expect(latestWorkflowRun([older, failedRerun], WORKFLOW, HEAD)?.run_attempt).toBe(2)
    const pendingRerun = run({ id: 100, run_attempt: 3, status: 'queued', run_started_at: iso(900_000) })
    expect(latestWorkflowRun([older, failedRerun, pendingRerun], WORKFLOW, HEAD)?.run_attempt).toBe(3)
    // A successful rerun's own jobs are read, not the failed attempt's.
    const passedRerun = run({ run_attempt: 2, status: 'completed', conclusion: 'success' })
    expect(judge(passedRerun, [job(CHECK, { run_attempt: 2 })]).state).toBe('green')
    // A newer run of the same workflow for the head wins over an older one.
    const newer = run({ id: 200, run_started_at: iso(1_000_000) })
    expect(latestWorkflowRun([older, newer], WORKFLOW, HEAD)?.id).toBe(200)
  })

  test('a queued job with no runner stalls only after the queue bound, counted from when it became eligible', () => {
    const queued = (createdAt: number) =>
      job('Test (apps/cli, shard 4)', {
        status: 'queued',
        conclusion: null,
        runner_id: null,
        created_at: iso(createdAt),
        started_at: null,
        completed_at: null
      })
    expect(judge(run(), [queued(0)], T0 + QUEUE_BOUND_MS - 1).state).toBe('pending')
    const stalled = judge(run(), [queued(0)], T0 + QUEUE_BOUND_MS)
    expect(stalled).toMatchObject({ state: 'stalled', bound: 'queue' })
    // Eligible only once its upstream completed: an upstream that finished late restarts the count.
    const upstream = job('Build, lint & typecheck', { completed_at: iso(QUEUE_BOUND_MS) })
    expect(judge(run(), [upstream, queued(0)], T0 + QUEUE_BOUND_MS + 1000).state).toBe('pending')
    // No queue bound while its dependency, the build, has not completed.
    const building = job('Build, lint & typecheck', { status: 'in_progress', conclusion: null, completed_at: null })
    expect(judge(run(), [building, queued(0)], T0 + QUEUE_BOUND_MS + 5000).state).toBe('pending')
    // A sibling job still running does not hold back a job whose dependency completed.
    const sibling = job('Test (shared packages)', { status: 'in_progress', conclusion: null, started_at: iso(1000) })
    const built = job('Build, lint & typecheck', { completed_at: iso(0) })
    expect(judge(run(), [built, sibling, queued(0)], T0 + QUEUE_BOUND_MS + 5000)).toMatchObject({
      state: 'stalled',
      bound: 'queue',
      job: 'Test (apps/cli, shard 4)'
    })
    // The required check waits on every mandatory job; an optional job neither holds it nor is bounded.
    const check = job(CHECK, { status: 'queued', conclusion: null, runner_id: null, created_at: iso(0) })
    expect(judge(run(), [built, sibling, check], T0 + QUEUE_BOUND_MS + 5000).state).toBe('pending')
    const optional = job('Sandbox conformance (macOS)', { status: 'queued', conclusion: null, runner_id: null })
    expect(judge(run(), [built, optional], T0 + QUEUE_BOUND_MS + 5000).state).toBe('pending')
  })

  test('a running mandatory test job stalls past the execution ceiling, never read as a code failure', () => {
    const running = job('Test (apps/cli, shard 5)', { status: 'in_progress', conclusion: null, started_at: iso(0) })
    expect(judge(run(), [running], T0 + EXECUTION_CEILING_MS - 1).state).toBe('pending')
    expect(judge(run(), [running], T0 + EXECUTION_CEILING_MS)).toMatchObject({ state: 'stalled', bound: 'execution' })
    // The ceiling bounds the mandatory test jobs only: a long build or an optional job is not stalled by it.
    for (const name of ['Build, lint & typecheck', 'Sandbox conformance (macOS)'])
      expect(
        judge(
          run(),
          [job(name, { status: 'in_progress', conclusion: null, started_at: iso(0) })],
          T0 + EXECUTION_CEILING_MS
        ).state
      ).toBe('pending')
  })

  test('a newer run of the workflow for the head outranks an older run that was rerun', () => {
    const olderRerun = run({ id: 100, run_attempt: 2, created_at: iso(0), run_started_at: iso(900_000) })
    const newer = run({ id: 200, run_attempt: 1, created_at: iso(600_000), run_started_at: iso(600_000) })
    expect(latestWorkflowRun([olderRerun, newer], WORKFLOW, HEAD)?.id).toBe(200)
    expect(latestWorkflowRun([newer, olderRerun], WORKFLOW, HEAD)?.id).toBe(200)
  })

  test('jobs that cannot be read are unreadable, never green', () => {
    expect(judge(run(), null).state).toBe('unreadable')
  })
})

describe('the recovery classification of a failing job', () => {
  test.each([
    'Lint and format',
    'Typecheck',
    'Test shard 3',
    'vinaya doctor — managed files match their generator',
    'Check the test inventory and run the repository suite'
  ])('a failure in "%s" is a code failure the Developer repairs', (step) => {
    expect(classifyFailedJob(job('j', { conclusion: 'failure', steps: [testStep('failure', step)] })).kind).toBe('code')
  })

  test.each(['Set up job', 'Install dependencies', 'Restore Bun install cache', 'Install the Linux sandbox tools'])(
    'a failed setup step "%s" is an infrastructure pause candidate naming the step',
    (step) => {
      const failure = classifyFailedJob(job('j', { conclusion: 'failure', steps: [testStep('failure', step)] }))
      expect(failure.kind).toBe('infrastructure')
      expect(failure.diagnostic).toContain(step)
    }
  )

  test('a frozen-lockfile install refusing a stale lockfile is the change’s code failure; other install failures stay setup', () => {
    const install = job('Test (shared packages)', {
      conclusion: 'failure',
      steps: [testStep('failure', 'Install dependencies')]
    })
    expect(classifyFailedJob(install, { stepLog: 'error: lockfile had changes, but lockfile is frozen' }).kind).toBe(
      'code'
    )
    expect(classifyFailedJob(install, { stepLog: 'error: GET https://registry.npmjs.org/x - 503' }).kind).toBe(
      'infrastructure'
    )
    const reads: number[] = []
    classifyFailedJobLive(install, (_jobId, step) => {
      reads.push(step)
      return null
    })
    expect(reads).toEqual([6])
  })

  test('a provider API-budget exhaustion reported by the budget step is infrastructure, even on a test step', () => {
    const failing = job('j', { conclusion: 'failure', steps: [testStep('failure')] })
    const failure = classifyFailedJob(failing, { budgetLog: 'vinaya-budget: exhausted=core core_remaining=0' })
    expect(failure).toMatchObject({ kind: 'infrastructure', diagnostic: 'vinaya-budget: exhausted=core' })
    expect(classifyFailedJob(failing, { budgetLog: 'vinaya-budget: exhausted=none core_remaining=10' }).kind).toBe(
      'code'
    )
  })

  test('a sandbox setup diagnostic counts only in the sandbox suite step, never as a substring of a test log', () => {
    const sandbox = job('Sandbox conformance (Linux)', {
      conclusion: 'failure',
      steps: [testStep('failure', 'Run the suite under both sandboxes')]
    })
    const diagnostic = 'bwrap: No permissions to create new namespace'
    expect(classifyFailedJob(sandbox, { stepLog: `noise\n${diagnostic}\n` })).toMatchObject({ kind: 'infrastructure' })
    expect(classifyFailedJob(sandbox, { stepLog: 'expect(received).toBe(expected)' }).kind).toBe('code')
    // The same text inside a test's own log, quoted mid-line, never relabels a code failure.
    const testJob = job('Test (apps/cli, shard 1)', { conclusion: 'failure', steps: [testStep('failure')] })
    expect(classifyFailedJob(testJob, { stepLog: `error: "${diagnostic}"` }).kind).toBe('code')
  })

  test.each([
    "bwrap: Can't remount readonly on /newroot/tmp: Unable to remount destination /newroot/tmp with correct flags: Invalid argument",
    "bwrap: Can't mount tmpfs on /newroot/tmp: Operation not permitted"
  ])('a failed sandbox suite step whose text carries "%s" is infrastructure naming that line', (line) => {
    const sandbox = job('Sandbox conformance (Linux)', {
      conclusion: 'failure',
      steps: [testStep('failure', 'Run the suite under both sandboxes')]
    })
    expect(classifyFailedJob(sandbox, { stepLog: `noise\n${line}\n1 fail` })).toMatchObject({
      kind: 'infrastructure',
      diagnostic: line
    })
    expect(classifyFailedJob(sandbox, { stepLog: `error: "${line}"` }).kind).toBe('code')
  })

  test.each([
    "bwrap: Can't remount readonly on /newroot/tmp: Unable to remount destination /newroot/tmp with correct flags: Invalid argument",
    "bwrap: Can't mount tmpfs on /newroot/tmp: Operation not permitted"
  ])('a failed sandbox suite step whose text carries "%s" is infrastructure naming that line', (line) => {
    const sandbox = job('Sandbox conformance (Linux)', {
      conclusion: 'failure',
      steps: [testStep('failure', 'Run the suite under both sandboxes')]
    })
    expect(classifyFailedJob(sandbox, { stepLog: `noise\n${line}\n1 fail` })).toMatchObject({
      kind: 'infrastructure',
      diagnostic: line
    })
    expect(classifyFailedJob(sandbox, { stepLog: `error: "${line}"` }).kind).toBe('code')
  })

  test('a timed-out, cancelled or unnamed failure is unclassified, never code', () => {
    expect(classifyFailedJob(job('j', { conclusion: 'failure', steps: [testStep('timed_out')] })).kind).toBe('unknown')
    expect(classifyFailedJob(job('j', { conclusion: 'cancelled', steps: [testStep('cancelled')] })).kind).toBe(
      'unknown'
    )
    expect(classifyFailedJob(job('j', { conclusion: 'failure', steps: [] })).kind).toBe('unknown')
    expect(
      classifyFailedJob(job('j', { conclusion: 'failure', steps: [testStep('failure', 'Mystery step')] })).kind
    ).toBe('unknown')
  })

  test('the live classifier reads only the failed sandbox step and the budget step, and writes nothing', () => {
    const reads: string[] = []
    const failing = job('Sandbox conformance (Linux)', {
      conclusion: 'failure',
      steps: [
        { name: 'Run the suite under both sandboxes', number: 5, status: 'completed', conclusion: 'failure' },
        { name: BUDGET_STEP, number: 6, status: 'completed', conclusion: 'success' }
      ]
    })
    const failure = classifyFailedJobLive(failing, (jobId, step) => {
      reads.push(`${jobId}/${step}`)
      return step === 5 ? 'bwrap: setting up uid map: Permission denied' : 'vinaya-budget: exhausted=none'
    })
    expect(reads).toEqual([`${failing.id}/5`, `${failing.id}/6`])
    expect(failure.kind).toBe('infrastructure')
  })
})

// An excerpt around the step-8/step-9 boundary of a real failed Linux sandbox job: step 8 completed 06:04:18Z and
// step 9 started 06:04:18Z, so the 06:04:18 lines mix the failure summary with the budget step's opening group.
const BOUNDARY_LOG = [
  '2026-11-07T06:03:02.1000000Z ##[group]Run bun run test:sandbox',
  '2026-11-07T06:03:02.1100000Z bun run test:sandbox',
  "2026-11-07T06:04:17.5000000Z bwrap: Can't remount readonly on /newroot/tmp: Unable to remount destination /newroot/tmp with correct flags: Invalid argument",
  '2026-11-07T06:04:18.0100000Z  1 fail',
  '2026-11-07T06:04:18.0200000Z ##[error]Process completed with exit code 1.',
  '    at stack frame without a timestamp',
  '2026-11-07T06:04:18.0900000Z ##[group]Run gh api rate_limit',
  '2026-11-07T06:04:18.1000000Z vinaya-budget: exhausted=core core_remaining=0',
  '2026-11-07T06:04:19.2000000Z Post job cleanup.',
  '2026-11-07T06:04:19.3000000Z git config cleanup'
].join('\n')
const SANDBOX_TIMES = {
  name: 'Run the suite under both sandboxes',
  started_at: '2026-11-07T06:03:02Z',
  completed_at: '2026-11-07T06:04:18Z'
}
const BUDGET_TIMES = { name: BUDGET_STEP, started_at: '2026-11-07T06:04:18Z', completed_at: '2026-11-07T06:04:19Z' }

describe('slicing one step out of a whole job log', () => {
  test('the failed step comes back without prefixes and never holds the next step’s lines, even in a shared second', () => {
    const text = sliceStepLog(BOUNDARY_LOG, SANDBOX_TIMES) as string
    expect(text.split('\n')[0]).toBe('##[group]Run bun run test:sandbox')
    expect(text).toContain("bwrap: Can't remount readonly on /newroot/tmp")
    expect(text).toContain('    at stack frame without a timestamp')
    expect(text).not.toContain('2026-11-07')
    expect(text).not.toContain('vinaya-budget')
    expect(text).not.toContain('rate_limit')
    expect(SANDBOX_SETUP_DIAGNOSTICS.some((pattern) => pattern.test(text))).toBe(true)
  })

  test('the next step’s lines come back without the failed step’s lines', () => {
    const text = sliceStepLog(BOUNDARY_LOG, BUDGET_TIMES) as string
    expect(text).toContain('vinaya-budget: exhausted=core')
    expect(text).not.toContain('bwrap')
    expect(text).not.toContain('1 fail')
  })

  test('a post step begins at the post-job cleanup line', () => {
    const text = sliceStepLog(BOUNDARY_LOG, {
      name: 'Post Run actions/checkout',
      started_at: '2026-11-07T06:04:19Z',
      completed_at: '2026-11-07T06:04:19Z'
    })
    expect(text).toBe('Post job cleanup.\ngit config cleanup')
  })

  test('a step with no times, or one the log never opened, is null', () => {
    expect(sliceStepLog(BOUNDARY_LOG, { name: 'x', started_at: null, completed_at: null })).toBeNull()
    expect(sliceStepLog('no stamps here', SANDBOX_TIMES)).toBeNull()
  })
})

describe('the default step-log reader', () => {
  const record = JSON.stringify({
    steps: [
      { number: 8, ...SANDBOX_TIMES },
      { number: 9, ...BUDGET_TIMES }
    ]
  })

  test('reads the job and its whole log, never the per-step endpoint, and returns the slice', () => {
    const calls: string[][] = []
    const text = readStepLog(42, 8, (args) => {
      calls.push(args)
      return args[1]?.endsWith('/logs') ? BOUNDARY_LOG : record
    })
    expect(calls).toEqual([
      ['api', 'repos/{owner}/{repo}/actions/jobs/42'],
      ['api', 'repos/{owner}/{repo}/actions/jobs/42/logs', '--allow-escape-sequences']
    ])
    expect(text).toContain("bwrap: Can't remount readonly on")
  })

  test('retries the log without the escape flag, and is null when a read fails', () => {
    const seen: string[][] = []
    readStepLog(42, 9, (args) => {
      seen.push(args)
      if (args.includes('--allow-escape-sequences')) throw new Error('unknown flag')
      return args[1]?.endsWith('/logs') ? BOUNDARY_LOG : record
    })
    expect(seen).toHaveLength(3)
    expect(
      readStepLog(42, 8, () => {
        throw new Error('404')
      })
    ).toBeNull()
    expect(readStepLog(42, 99, () => record)).toBeNull()
  })
})
