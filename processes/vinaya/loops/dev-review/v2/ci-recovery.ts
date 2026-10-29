import { sh } from '../../../../../apps/cli/src/lib/dev-review-loop/gate-reading'

// The required-CI read of a version-2 run whose ready push deferred its selected tests: the strict current-head test
// verdict, and the recovery classification of a failure. Only the configured workflow's run for the approved head
// counts, resolved to its latest attempt; its required check must be that attempt's own job, completed `success`.
// A completed failing job is read at once, while other jobs still run. A failure is classified from trusted job and
// step metadata plus a small explicit diagnostic allowlist: a setup step, a provider API-budget exhaustion or a
// recorded sandbox setup diagnostic is an Operator pause candidate; a lint, typecheck, test, policy or security step is
// a code failure the Developer repairs; anything else pauses with what was read. Reads only: nothing here reruns a job
// or writes to the provider. Every time bound reads the provider's own timestamps, so a restarted run keeps it.

/** A queued job with no runner pauses for the Operator after this long, counted from when it became eligible. */
export const QUEUE_BOUND_MS = 10 * 60 * 1000

/** A running mandatory job pauses for the Operator after this long: elapsed time is never read as a code defect. */
export const EXECUTION_CEILING_MS = 20 * 60 * 1000

/** One workflow run for a head, as the REST runs list reports it. */
export interface CiWorkflowRun {
  id: number
  path: string | null
  head_sha: string
  run_attempt: number | null
  status: string
  conclusion: string | null
  html_url: string | null
  created_at: string | null
  run_started_at: string | null
}

/** One job of a workflow run attempt, as the REST jobs list reports it (the fields this read uses). */
export interface CiJob {
  id: number
  run_id: number
  run_attempt?: number | null
  head_sha: string
  name: string
  status: string
  conclusion: string | null
  created_at: string | null
  started_at: string | null
  completed_at: string | null
  html_url: string | null
  runner_id: number | null
  steps?: { name: string; number: number; status: string; conclusion: string | null }[]
}

/** The run, attempt and check that satisfied the required tests. */
export interface RequiredCiIdentity {
  head: string
  workflow: string
  check: string
  runId: number
  runAttempt: number
  checkRunId: number
  url: string | null
}

/** One classified failing job. */
export interface ClassifiedFailure {
  job: string
  jobId: number
  url: string | null
  step: string | null
  kind: 'code' | 'infrastructure' | 'unknown'
  /** What decided `infrastructure`: the failed setup step, or the matched allowlisted diagnostic. */
  diagnostic?: string
}

export type RequiredCiRead =
  | { state: 'green'; identity: RequiredCiIdentity }
  | { state: 'pending'; detail: string }
  | { state: 'red'; runId: number; runUrl: string | null; failures: ClassifiedFailure[] }
  | { state: 'stalled'; bound: 'queue' | 'execution'; job: string; jobId: number; url: string | null; detail: string }
  | { state: 'unreadable'; detail: string }

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required'])

/** Steps a job runs before the repository's own code: their failure is setup, not code. */
const SETUP_STEP = [
  /^Set up job$/,
  /^Run actions\/checkout/,
  /^Run oven-sh\/setup-bun/,
  /^Restore Bun install cache$/,
  /^Install dependencies$/,
  /^Install the Linux sandbox tools$/,
  /^Install the checks' own tools?$/,
  /^Complete job$/,
  /^Post /
]

/** Steps that run the repository's own code: lint, typecheck, build, tests, policy and security checks. */
const CODE_STEP = [
  /^Lint and format$/,
  /^Typecheck$/,
  /^Build /,
  /^Test/,
  /^Run the suite under both sandboxes$/,
  /^vinaya doctor/,
  /^Detect docs-only diff$/,
  /^Arm this checkout's git hooks routing$/,
  /^Every mandatory job succeeded/
]

/** The workflow-authored step that reports a job's provider API budget after a failure. */
export const BUDGET_STEP = "Report this job's GitHub token budget"

/** Provider API-budget exhaustion, as the budget step reports it or the provider words it. */
export const PROVIDER_BUDGET_DIAGNOSTICS = [
  /^vinaya-budget: exhausted=(core|graphql)\b/m,
  /API rate limit exceeded for /,
  /You have exceeded a secondary rate limit/
]

/** The sandbox setup diagnostics recorded from real runs: the namespace or mount could not be created. */
export const SANDBOX_SETUP_DIAGNOSTICS = [
  /^bwrap: No permissions to create new namespace/m,
  /^bwrap: setting up uid map: Permission denied/m,
  /^bwrap: Can't mount proc on \/newroot\/proc/m,
  /^bwrap: Failed to mount tmpfs/m,
  /^sandbox-exec: sandbox_apply: Operation not permitted/m
]

/** The step whose log may carry a sandbox setup diagnostic: the sandbox suite itself, never a test log elsewhere. */
const SANDBOX_STEP = /^Run the suite under both sandboxes$/

const at = (value: string | null | undefined): number => (value ? Date.parse(value) : Number.NaN)

/** The aggregate's build job, every mandatory test and sandbox job's dependency. */
const BUILD_JOB = /^Build, lint & typecheck$/

/** The mandatory test jobs the execution ceiling bounds (one per shard or package set). */
const MANDATORY_TEST_JOB = /^Test \(/

/** The jobs the required check needs: the build, the test jobs, Linux sandbox conformance, and the check itself. */
const isMandatoryJob = (name: string, check: string): boolean =>
  name === check || BUILD_JOB.test(name) || MANDATORY_TEST_JOB.test(name) || name === 'Sandbox conformance (Linux)'

/** The install step, and the diagnostic that names its failure a code defect: a lockfile the change left stale. */
const INSTALL_STEP = /^Install dependencies$/
const STALE_LOCKFILE = /lockfile had changes, but lockfile is frozen/

/**
 * Pure: the newest run of `workflow` for `head`. The newest run wins first — the latest created, then the highest
 * id — so an older run that was rerun never outranks a newer run of the same workflow for the head; within one run
 * id (a rerun keeps its id and raises its attempt) the latest attempt wins.
 */
export function latestWorkflowRun(
  runs: readonly CiWorkflowRun[],
  workflow: string,
  head: string
): CiWorkflowRun | null {
  const own = runs.filter((run) => run.path === workflow && run.head_sha === head)
  if (own.length === 0) return null
  const rank = (run: CiWorkflowRun) => [at(run.created_at), run.id, run.run_attempt ?? 1]
  return own.reduce((best, run) => {
    const a = rank(run)
    const b = rank(best)
    for (let i = 0; i < a.length; i++) {
      const x = Number.isFinite(a[i]) ? (a[i] as number) : -1
      const y = Number.isFinite(b[i]) ? (b[i] as number) : -1
      if (x !== y) return x > y ? run : best
    }
    return best
  })
}

/** Pure: one failing job's class from its failed step and the logs read for it (`stepLog`, `budgetLog`). */
export function classifyFailedJob(
  job: CiJob,
  logs: { stepLog?: string | null; budgetLog?: string | null } = {}
): ClassifiedFailure {
  const failedStep = (job.steps ?? []).find((step) => step.conclusion !== null && FAILED.has(step.conclusion)) ?? null
  const base = { job: job.name, jobId: job.id, url: job.html_url, step: failedStep?.name ?? null }
  const budget = logs.budgetLog
    ? PROVIDER_BUDGET_DIAGNOSTICS.map((pattern) => logs.budgetLog?.match(pattern)?.[0]).find(Boolean)
    : undefined
  if (budget) return { ...base, kind: 'infrastructure', diagnostic: budget.trim() }
  if (failedStep === null) return { ...base, kind: 'unknown' }
  // A frozen-lockfile install refusing a stale lockfile is the change's own defect, not the runner's.
  if (INSTALL_STEP.test(failedStep.name) && logs.stepLog && STALE_LOCKFILE.test(logs.stepLog))
    return { ...base, kind: 'code' }
  if (SETUP_STEP.some((pattern) => pattern.test(failedStep.name)))
    return { ...base, kind: 'infrastructure', diagnostic: `the setup step "${failedStep.name}" failed` }
  if (SANDBOX_STEP.test(failedStep.name) && logs.stepLog) {
    const sandbox = SANDBOX_SETUP_DIAGNOSTICS.map((pattern) => logs.stepLog?.match(pattern)?.[0]).find(Boolean)
    if (sandbox) return { ...base, kind: 'infrastructure', diagnostic: sandbox.trim() }
  }
  if (failedStep.conclusion === 'cancelled' || failedStep.conclusion === 'timed_out')
    return { ...base, kind: 'unknown' }
  if (CODE_STEP.some((pattern) => pattern.test(failedStep.name))) return { ...base, kind: 'code' }
  return { ...base, kind: 'unknown' }
}

/**
 * Pure: the strict required-CI read from the configured workflow's latest run attempt for `head` and that attempt's
 * jobs. Green only when the attempt's job named `check` completed `success` and no job of the attempt failed. A
 * completed failing job reads red at once, while others still run (the required check's own job is classified only
 * when it is the attempt's one failure). A mandatory job queued with no runner reads `stalled` once it waited
 * `QUEUE_BOUND_MS` from when it became eligible — its creation or its dependencies' completion, whichever is later,
 * never while a dependency has not completed; a running mandatory test job reads `stalled` past
 * `EXECUTION_CEILING_MS`. Everything else is pending:
 * no run, a queued or running attempt, or a required check that completed skipped, neutral or anything but success.
 */
export function judgeRequiredCi(input: {
  head: string
  workflow: string
  check: string
  run: CiWorkflowRun | null
  jobs: readonly CiJob[] | null
  now: number
  classify: (job: CiJob) => ClassifiedFailure
}): RequiredCiRead {
  const { run, head } = input
  if (run === null) return { state: 'pending', detail: `no ${input.workflow} run exists for ${head} yet` }
  if (input.jobs === null) return { state: 'unreadable', detail: `the jobs of run ${run.id} could not be read` }
  const attempt = run.run_attempt ?? 1
  const jobs = input.jobs.filter((job) => job.head_sha === head && job.run_id === run.id)
  const failedJobs = jobs.filter(
    (job) => job.status === 'completed' && job.conclusion !== null && FAILED.has(job.conclusion)
  )
  const upstream = failedJobs.filter((job) => job.name !== input.check)
  const toClassify = upstream.length > 0 ? upstream : failedJobs
  if (toClassify.length > 0)
    return { state: 'red', runId: run.id, runUrl: run.html_url, failures: toClassify.map(input.classify) }
  const required = jobs.find((job) => job.name === input.check)
  if (required?.status === 'completed' && required.conclusion === 'success' && run.status === 'completed')
    return {
      state: 'green',
      identity: {
        head,
        workflow: input.workflow,
        check: input.check,
        runId: run.id,
        runAttempt: attempt,
        checkRunId: required.id,
        url: required.html_url
      }
    }
  if (required?.status === 'completed')
    return {
      state: 'red',
      runId: run.id,
      runUrl: run.html_url,
      failures: [
        {
          job: required.name,
          jobId: required.id,
          url: required.html_url,
          step: null,
          kind: 'unknown',
          diagnostic: `the required check completed ${required.conclusion ?? 'with no conclusion'}, which never counts as the tests passing`
        }
      ]
    }
  const running = jobs.filter((job) => job.status === 'in_progress')
  // The execution ceiling bounds the running mandatory test jobs only, never the build or an optional job.
  for (const job of running.filter((candidate) => MANDATORY_TEST_JOB.test(candidate.name))) {
    const started = at(job.started_at)
    if (Number.isFinite(started) && input.now - started >= EXECUTION_CEILING_MS)
      return {
        state: 'stalled',
        bound: 'execution',
        job: job.name,
        jobId: job.id,
        url: job.html_url,
        detail: `the job ${job.name} has run for over ${EXECUTION_CEILING_MS / 60000} minutes on ${head}`
      }
  }
  {
    // A mandatory job is eligible once its dependencies completed: the test and sandbox jobs need the build, the
    // required check needs every other job of the attempt. Its queue timer starts at the later of its creation and
    // the last of those dependencies to complete, and never while one of them has not completed.
    const build = jobs.find((job) => BUILD_JOB.test(job.name))
    for (const job of jobs) {
      if (job.status !== 'queued' || job.runner_id !== null || !isMandatoryJob(job.name, input.check)) continue
      const dependencies =
        job.name === input.check
          ? jobs.filter((other) => other !== job && isMandatoryJob(other.name, input.check))
          : BUILD_JOB.test(job.name) || build === undefined
            ? []
            : [build]
      if (dependencies.some((dependency) => dependency.status !== 'completed')) continue
      const eligible = Math.max(
        at(job.created_at),
        ...dependencies.map((d) => at(d.completed_at)).filter(Number.isFinite)
      )
      if (Number.isFinite(eligible) && input.now - eligible >= QUEUE_BOUND_MS)
        return {
          state: 'stalled',
          bound: 'queue',
          job: job.name,
          jobId: job.id,
          url: job.html_url,
          detail: `the job ${job.name} has waited over ${QUEUE_BOUND_MS / 60000} minutes for a runner on ${head} (no runner assigned)`
        }
    }
  }
  return {
    state: 'pending',
    detail: `run ${run.id} attempt ${attempt} of ${input.workflow} is ${run.status}; ${input.check} is ${required ? required.status : 'not started'}`
  }
}

function ghLines<T>(args: string[]): T[] {
  return sh('gh', args)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T)
}

/** A step's log, or null when it cannot be read. */
function readStepLog(jobId: number, step: number): string | null {
  try {
    return sh('gh', ['api', `repos/{owner}/{repo}/actions/jobs/${jobId}/steps/${step}/logs`])
  } catch {
    return null
  }
}

/** Classifies a failing job, reading only the failed step's log and the budget step's log. */
export function classifyFailedJobLive(job: CiJob, readLog: typeof readStepLog = readStepLog): ClassifiedFailure {
  const failedStep = (job.steps ?? []).find((step) => step.conclusion !== null && FAILED.has(step.conclusion))
  const budgetStep = (job.steps ?? []).find((step) => step.name === BUDGET_STEP && step.conclusion === 'success')
  return classifyFailedJob(job, {
    stepLog:
      failedStep && (SANDBOX_STEP.test(failedStep.name) || INSTALL_STEP.test(failedStep.name))
        ? readLog(job.id, failedStep.number)
        : null,
    budgetLog: budgetStep ? readLog(job.id, budgetStep.number) : null
  })
}

/** The live strict read: the runs list for the head, then the latest attempt's jobs. A failed read is `unreadable`. */
export function readRequiredCiLive(request: {
  head: string
  workflow: string
  check: string
  now: number
}): RequiredCiRead {
  let runs: CiWorkflowRun[]
  try {
    runs = ghLines<CiWorkflowRun>([
      'api',
      `repos/{owner}/{repo}/actions/runs?head_sha=${request.head}&per_page=100`,
      '--paginate',
      '--jq',
      '.workflow_runs[] | {id, path, head_sha, run_attempt, status, conclusion, html_url, created_at, run_started_at}'
    ])
  } catch (error) {
    return {
      state: 'unreadable',
      detail: `the workflow runs could not be read: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const run = latestWorkflowRun(runs, request.workflow, request.head)
  let jobs: CiJob[] | null = null
  if (run !== null) {
    try {
      jobs = ghLines<CiJob>([
        'api',
        `repos/{owner}/{repo}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100`,
        '--paginate',
        '--jq',
        '.jobs[] | {id, run_id, run_attempt, head_sha, name, status, conclusion, created_at, started_at, completed_at, html_url, runner_id, steps: [.steps[]? | {name, number, status, conclusion}]}'
      ])
    } catch {
      jobs = null
    }
  }
  return judgeRequiredCi({ ...request, run, jobs, classify: (job) => classifyFailedJobLive(job) })
}
