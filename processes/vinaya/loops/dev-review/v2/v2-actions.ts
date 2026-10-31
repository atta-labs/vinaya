import type { ActionContext } from '../../../../../harness/dev-process/engine-runtime/run-process'
import { runCli } from '../../../../../harness/gates/run-checks'
import {
  ciResultReadEvent,
  failedTestsRerunEvent,
  prOpenedEvent,
  readyPushEvent
} from '../../../../../apps/cli/src/lib/flow-v2-events'
import { discardHeldVerdicts } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import {
  checkPremiseAtHead,
  describeFailingCheckRun,
  fetchCiConclusion,
  fetchFailingCheckRuns,
  fetchSettledCiConclusion
} from '../../../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import {
  MAX_FAILURE_EXCERPT_CHARS,
  MAX_FAILURE_EXCERPT_TOTAL_CHARS,
  readFailedCheckExcerpt,
  renderFailureExcerpt,
  sanitizeForgeText
} from '../../../../../apps/cli/src/lib/task-tools/pr-facts'
import type { SelectionNote } from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import { PROGRESS_SUMMARY_INTERVAL_MS } from '../../../../../apps/cli/src/lib/push-progress'
import { manifestDigest } from '../../../../../apps/cli/src/lib/review-result'
import { isNativeRunCommand, readyTestCommand } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import {
  isReadyCiCommand,
  readyCiPlanCommand,
  type ReadyTestsPolicy,
  type RequiredCiPolicy
} from '../../../../../apps/cli/src/lib/pre-push-ready-policy'
import { agentCommandText, extractAgentCommandLines } from '../../../../../apps/cli/src/lib/pr-report-engine'
import {
  type CiProgress,
  type ClassifiedFailure,
  createCiProgress,
  type RequiredCiRead,
  type RequiredCiView
} from './ci-recovery'
import { readUnpushedWorkDetail } from '../../../../../apps/cli/src/lib/dev-review-loop/unpushed-work'
import { spawnSync } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import {
  assessRound,
  decideApprovalCarry,
  DEFAULT_READY_PUSH_TIMEOUT_MINUTES,
  DEFAULT_REVIEW_POLICY,
  type DevReviewLoopEventInput,
  type PauseReason,
  type PostedVerdictBodies,
  type ReviewPolicy
} from '@attalabs/aeg-core'
import { ownPatchIdAt, ownPatchInterdiff } from '../../../../../apps/cli/src/lib/patch-id'
import {
  fetchConflictingFiles,
  fetchMergeableState,
  parseMergeTreeConflictFiles,
  pollMergeableState
} from '../../../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { findOpenPrForBranch } from '../../../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import {
  BACK,
  carriedApprovals,
  carriedLoopState,
  CONFLICT_REPAIR_PROVEN,
  createActions,
  dispatchedManifest,
  EXIT_CI_RED_REENTRY,
  EXIT_CONFLICT_REENTRY,
  EXIT_NO_OPEN_PR,
  EXIT_OPEN_PR,
  FORWARD,
  gatePollOf,
  isApprovalCarried,
  isSentBack,
  latestRecord,
  NO_COUNTERS,
  ok,
  owedConflictRepair,
  pauseThrough,
  readAssessment,
  readForgeCi,
  type RecordedApprovalCarry,
  recordedDispatch,
  recordOutput,
  safeRead,
  type SendBack,
  startReviewRound,
  type TaskInput,
  withDeveloperContext,
  worktreeHeadOf,
  worktreeStats
} from '../../../executing/actions'

// Review locally, push once: the actions only version 2 of the developer-review Flow binds. The Developer pushes
// every commit to its task branch as a storage push (cheap checks, no tests) while no pull request is open; each
// round's gate is the local checks, and the reviewers judge the local commit. Once both approve, the ready push runs
// the selected tests (re-running only what a refused one failed), the pull request opens, and CI is read once. A
// refused ready push, a pull request that cannot open and a red CI each send the Developer back with the reason.
// Every forge and process call is a `task.v2` function, so the round flow runs against fakes.

/** What one ready push reported: whether its tests passed, its output, and what it selected. */
export interface ReadyGateResult {
  passed: boolean
  output: string
  /** How the hook selected its tests (full or a re-run of what failed), or null when it recorded none. */
  selection: SelectionNote | null
  /** The failing test files, or `all` when the run failed without naming any. */
  failed: string[] | 'all'
  wallMs: number
  /** True when the run passed its deadline and was stopped: a recorded refusal, never a hang. */
  timedOut?: boolean
  /** The limit the run was stopped at, in minutes (set with `timedOut`). */
  limitMinutes?: number
  /** How many test files the run had selected when it was stopped, when the selector's note says. */
  selectedCount?: number
  /**
   * `none` when the repository runs no local tests (no pre-push hook, or no declared test runner); `deferred` when the
   * hook ran every cheap gate and deferred the selected tests to required current-head CI (`requiredCi`).
   */
  localTests?: 'none' | 'deferred'
  /** The required check a deferred push owes (set with `localTests: 'deferred'`). */
  requiredCi?: { workflow: string; check: string; runId?: string }
}

/** One explicit Test Plan command the driver ran (or reused a receipt for) at the publication boundary. */
export interface ExplicitCommandResult {
  command: string
  outcome: 'passed' | 'failed' | 'timed-out'
  output: string
  /** Set when a genuine green receipt at this head and tree was reused instead of running the command. */
  reusedFrom?: string
  exitCode?: number | null
  wallMs?: number
  limitMs?: number
}

/** The explicit-command phase of a deferred ready push. */
export interface ExplicitCommandsResult {
  /** `drift`: the head or tree changed during verification, so nothing may publish. */
  outcome: 'passed' | 'failed' | 'timed-out' | 'drift'
  results: ExplicitCommandResult[]
  wallMs: number
  detail?: string
}

/** The staged pull request: what the Developer's `open_pull_request` saved while no pull request may open yet. */
export interface StagedPullRequest {
  title: string
  body: string
}

/** The forge and process functions version 2's steps call; the runner supplies the live ones, a test its fakes. */
export interface V2Functions {
  /** Runs the repository's pre-push hook in its ready mode on `head`; `deferTests` asks it to defer to required CI. */
  runReadyGate: (input: {
    head: string
    signal?: AbortSignal
    deferTests?: boolean
  }) => Promise<ReadyGateResult> | ReadyGateResult
  /** The default branch's ready-tests policy; throws when the trusted read fails. Absent: local tests. */
  readyTestsPolicy?: () => ReadyTestsPolicy
  /**
   * The default branch's required-CI descriptor (`prePush.requiredCi`, or the pair a `readyTests` opt-in names), owed
   * by a ready or repair publication wherever its tests ran; `null` when nothing extra is owed. Throws when the
   * trusted read fails or conflicts. Absent: the pair the ready-tests policy names when it opts in, otherwise none.
   */
  requiredCiPolicy?: () => RequiredCiPolicy | null
  /** The read-only loop-baseline guard an opted-in publication passes before any expensive work. */
  checkReadyBaseline?: () => { ok: true } | { ok: false; reason: string }
  /** The ready push's deadline in milliseconds; the explicit-command phase shares it. */
  readyDeadlineMs?: () => number
  /** Runs the approved explicit Test Plan commands on `head`, outside the worker sandbox, through the report engine's receipts. */
  runExplicitCommands?: (input: {
    head: string
    body: string
    commands: readonly string[]
    signal?: AbortSignal
    deadlineAt: number
  }) => Promise<ExplicitCommandsResult> | ExplicitCommandsResult
  /** The strict required-CI read for a deferred head (`ci-recovery.ts`). */
  readRequiredCi?: (
    input: { head: string; workflow: string; check: string; now: number },
    /** Handed what the read saw, for the CI wait's progress lines; it reads nothing and decides nothing. */
    observe?: (view: RequiredCiView) => void
  ) => RequiredCiRead
  /** One progress line for the task's driver log (the CI wait's per-job, state and 60-second lines). */
  progressLine?: (line: string) => void
  /** Calls `fn` every `ms` until the returned canceller runs: the CI wait's 60-second line. A test fakes it. */
  progressEvery?: (fn: () => void, ms: number) => () => void
  /** The staged pull request, or null when the Developer staged none. */
  stagedPullRequest: () => StagedPullRequest | null
  /** The open pull request for the task branch, or null. */
  findOpenPullRequest: () => { number: number } | null
  /** Opens the pull request from the staged one: its number, or the reason it could not open. */
  openPullRequest: (
    staged: StagedPullRequest
  ) =>
    | Promise<{ ok: true; pr: number } | { ok: false; reason: string }>
    | { ok: true; pr: number }
    | { ok: false; reason: string }
  /** Ends storage pushes for the task worktree: from now on its pushes run the selected tests. */
  endStoragePushes: () => void
  /**
   * Writes the open pull request's Evidence block for `head`, the head the ready push passed: the loop's job in
   * this flow, so the Developer runs no tests and no evidence refresh in its turn.
   */
  writeEvidence?: (input: {
    pr: number
    head: string
  }) =>
    | Promise<{ ok: true } | { ok: false; reason: string; retryable: boolean }>
    | { ok: true }
    | { ok: false; reason: string; retryable: boolean }
  /** Injectable delay before the single Evidence retry. */
  sleep?: (ms: number) => Promise<void>
  /** One line for the driver log. */
  log?: (line: string) => void
  /** The local checks of a round: `vinaya check --all --local` with the staged body as the pull-request body. */
  runLocalChecks?: (env: Record<string, string>) => { passed: boolean; output: string }
  /** One failed job's failure-naming log lines, at most `max` characters: null when its log cannot be read. Live: the full-log reader. */
  readCheckExcerpt?: (jobId: number, max: number) => string | null
  /** Milliseconds since an arbitrary origin, for the time a step spends. */
  now?: () => number
  /** The wall clock the provider's own timestamps are compared against (the CI queue and execution bounds). */
  wallNow?: () => number
  /**
   * The default branch's tip, fetched by the controller into the task worktree's object store, or null when it cannot
   * be read. A conflict's repair is proven against it, so a tip that cannot be read proves no repair.
   */
  readMainTip?: () => string | null
  /**
   * The newest posted verdict comment of each review role on pull request `pr`, Principal-authored, or null when it
   * cannot be read: the reviewed baseline a conflict re-entry starts from.
   */
  readPostedVerdicts?: (pr: number) => PostedVerdictBodies | null
}

/** Consecutive ready-push failures pause independently of review revisions. */
export const READY_PUSH_FAILURE_LIMIT = 3

type Results = ActionContext['results']

/** The results the forge gates' CI read sees: this step's own earlier record, and no local gate to skip on. */
function ciReadResults(results: Results): Results {
  const { 'run-mechanical-gates': _gate, 'read-forge-ci': _v1Ci, ...rest } = results
  const own = results['read-ci-once']
  return own === undefined ? rest : { ...rest, 'read-forge-ci': own }
}

const v2Of = (task: TaskInput): V2Functions => {
  if (!task.v2) throw new Error('the version 2 flow ran with no version 2 functions wired (task.v2)')
  return task.v2
}

const nowOf = (fns: V2Functions): (() => number) => fns.now ?? (() => Date.now())

/** The round's local checks: `check --all --local`, judging the staged pull-request body where CI will judge the real one. */
export async function runLocalChecks(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  // A turn that only re-stated its confidence changed nothing: the head's gate result stands as read.
  const previous = context.results['run-mechanical-gates']
  if (previous && latestRecord(context.results)?.answered === 'ask-confidence')
    return { exitCode: previous.exitCode, stdout: 'stdout' in previous ? String(previous.stdout) : '' }
  const fns = v2Of(task)
  const staged = safeRead(fns.stagedPullRequest)
  const env: Record<string, string> = { BRANCH: task.branch, ...(staged ? { PR_BODY: staged.body } : {}) }
  const run =
    fns.runLocalChecks ??
    ((checkEnv: Record<string, string>) => {
      const res = runCli(task.cliEntry, task.worktreePath, ['check', '--all', '--local'], checkEnv)
      return { passed: res.status === 0, output: `${res.stdout}${res.stderr}` }
    })
  const gates = run(env)
  return { exitCode: gates.passed ? 0 : 1, stdout: gates.output }
}

/**
 * The premise re-check against the staged pull-request body (no pull request is open during the local rounds): a
 * stale pin pauses before any reviewer is dispatched; a body that carries no `Premise:` block is dormant.
 */
export function checkPremiseStaged(task: TaskInput): { exitCode: number; stdout: string } {
  const fns = v2Of(task)
  const open = safeRead(fns.findOpenPullRequest)
  const staged = safeRead(fns.stagedPullRequest)
  if (open === null && staged === null) return ok(JSON.stringify({ premise: 'dormant' }))
  const result = checkPremiseAtHead(open?.number ?? 0, (pr) =>
    open !== null && pr === open.number && task.bound?.fetchPrBody ? task.bound.fetchPrBody(pr) : (staged?.body ?? '')
  )
  if (result === null || result.pass) return ok(JSON.stringify({ premise: result === null ? 'dormant' : 'holds' }))
  const failures = result.errors.map((error) => error.message)
  const head = worktreeHeadOf(task)
  pauseThrough(task, 'check-premise', {
    reason: 'escalation',
    detail: `a Premise pin no longer holds at ${head ?? 'the task head'}, so no reviewer is dispatched: ${failures.join('; ')}`
  })
  return { exitCode: 1, stdout: JSON.stringify({ premise: 'stale', failures }) }
}

/**
 * Sends the Developer back after an approval the push or CI did not keep: the round's held verdicts are discarded
 * (they never publish), and the record names why, so the next turn's prompt carries it. The reviewers judge the
 * Developer's next head again, since a verdict binds to the commit that is pushed.
 */
function sendBackAfterApproval(
  task: TaskInput,
  results: Results,
  kind: 'ready-refused' | 'ci-red' | 'unpushed',
  detail: string,
  extra: Record<string, unknown>
): { exitCode: number; stdout: string } {
  ;(task.bound?.discardHeldVerdicts ?? discardHeldVerdicts)(task.runtimeDir, task.issueNumber, task.reviewRound())
  const previous = latestRecord(results)
  const headBefore = safeRead(task.remoteHead) ?? worktreeHeadOf(task)
  return startReviewRound(task, {
    exitCode: BACK,
    stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
      counters: { ...(previous?.counters ?? NO_COUNTERS), stallCheck: null },
      sendBack: { kind, headBefore, detail },
      decision: { type: 'dispatch_developer' },
      ...extra
    })
  })
}

/**
 * The head both reviewers approved: the one the round's reviewer dispatch named (its review inputs' manifest), else
 * — a run with no recorded inputs — the worktree's. Throws when the step follows anything but an approval.
 */
function approvedHead(task: TaskInput, results: Results, step: string): string {
  // Approvals carried across a proven merge cover the repaired head they were carried to.
  const carried = carriedApprovals(results)
  if (carried !== null) return carried.head
  const assessment = readAssessment(results)
  if (assessment.decision.type !== 'publish')
    throw new Error(`${step} reached after a ${assessment.decision.type} decision, not an approval`)
  const judged = recordedDispatch(results)?.inputs?.manifest.headSha
  if (judged) return judged
  const head = worktreeHeadOf(task)
  if (head === null) throw new Error(`${step} could not read the head of ${task.worktreePath}`)
  return head
}

/**
 * Why the worktree is not exactly the approved commit, or null when it is: its head moved since approval, or it
 * holds uncommitted changes. The ready push tests the approved commit and nothing else.
 */
function worktreeDriftFrom(task: TaskInput, approved: string): string | null {
  const head = worktreeHeadOf(task)
  if (head !== approved) return `the worktree head is ${head ?? 'unreadable'}, not the approved head ${approved}`
  let dirty: string[]
  try {
    dirty = (task.readUnpushedWork ?? (() => readUnpushedWorkDetail(task.worktreePath)))().dirtyFiles
  } catch {
    return 'the worktree status could not be read'
  }
  if (dirty.length > 0)
    return `the worktree holds uncommitted changes (${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', …' : ''})`
  return null
}

const loopOf = (task: TaskInput, results: Results) => ({
  loopId: carriedLoopState(results, task.loopState).config.loopId,
  round: task.reviewRound()
})

/** The failing tests of a refused ready push, one per line, for the Developer's prompt. */
function failingTestLines(gate: ReadyGateResult): string {
  if (gate.failed === 'all')
    return `the test run failed without naming a test file. Its output (tail):\n\n${gate.output.slice(-4000)}`
  const tail = gate.output
    .split('\n')
    .filter((line) => line.startsWith('  ') && line.includes('.test.'))
    .slice(-40)
  return [...gate.failed.map((file) => `- ${file}`), ...(tail.length > 0 ? ['', ...tail] : [])].join('\n')
}

/**
 * The approved Test Plan: the staged pull-request body the reviewers judged, never the live body (an edit there grants
 * no command authority). Null when it cannot be read.
 */
function approvedTestPlanBody(fns: V2Functions): string | null {
  return safeRead(fns.stagedPullRequest)?.body ?? null
}

/**
 * The explicit commands of a Test Plan: every command line but the automatic selected-suite line (a bare test-run
 * line, which the ready push's own selection replaces, or the required-CI line a deferred head carries). A
 * `cd`-wrapped test, a build or any other verification is explicit, and needs its own genuine receipt.
 */
export function explicitTestPlanCommands(body: string): string[] {
  return extractAgentCommandLines(body)
    .filter((line) => !isTestRunLine(line))
    .map(agentCommandText)
    .filter((command) => command.length > 0 && !isReadyCiCommand(command))
}

/** Text in a fence no backtick run inside it can close. */
const fenced = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

/**
 * Routes an explicit-command phase that did not pass: a failing command goes back to the Developer with its command
 * and output, through the ready push's own failure count; a timeout pauses, since it proved nothing about the code; a
 * head or tree that moved during verification publishes nothing and sends the Developer back to publish its work.
 */
function explicitCommandsRefused(
  task: TaskInput,
  results: Results,
  head: string,
  explicit: ExplicitCommandsResult
): { exitCode: number; stdout: string } {
  const last = explicit.results.at(-1)
  const summary = explicit.results.map(({ command, outcome }) => ({ command, outcome }))
  if (explicit.outcome === 'drift')
    return sendBackAfterApproval(
      task,
      results,
      'ready-refused',
      `both reviewers approved ${head}, but the worktree changed while the driver ran the Test Plan's commands (${explicit.detail ?? 'head or tree moved'}), so nothing was published. Commit and publish your work with publish_changes, then finish your turn.`,
      { outcome: 'refused', head, explicit: summary, events: [] }
    )
  if (explicit.outcome === 'timed-out') {
    const detail = `the ready push of ${head} stopped the Test Plan command \`${last?.command ?? '(unknown)'}\` at its limit; the approved code was not changed. Shorten the command, raise the limit, or run it another way, then resume.`
    pauseThrough(task, 'ready-push', { reason: 'ready_push_failed', detail })
    return {
      exitCode: BACK,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        readyPushFailures: latestRecord(results)?.readyPushFailures ?? 0,
        decision: { type: 'pause', reason: 'ready_push_failed', detail },
        outcome: 'timed-out',
        head,
        explicit: summary,
        events: []
      })
    }
  }
  const failures = (latestRecord(results)?.readyPushFailures ?? 0) + 1
  if (failures >= READY_PUSH_FAILURE_LIMIT) {
    ;(task.bound?.discardHeldVerdicts ?? discardHeldVerdicts)(task.runtimeDir, task.issueNumber, task.reviewRound())
    const detail = `the ready push failed ${failures} consecutive times; the last failing Test Plan command: \`${last?.command ?? '(unknown)'}\``
    pauseThrough(task, 'ready-push', { reason: 'ready_push_failed', detail })
    return {
      exitCode: BACK,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        readyPushFailures: failures,
        decision: { type: 'pause', reason: 'ready_push_failed', detail },
        outcome: 'refused',
        head,
        explicit: summary,
        events: []
      })
    }
  }
  return sendBackAfterApproval(
    task,
    results,
    'ready-refused',
    `both reviewers approved ${head}, but the Test Plan command \`${last?.command ?? '(unknown)'}\` failed when the driver ran it on that head (exit ${last?.exitCode ?? 'none'}). Its output (tail, untrusted):\n\n${fenced(last?.output ?? '')}\n\nFix the code or the command, run it yourself once on your fix, publish with publish_changes, then finish your turn.`,
    { readyPushFailures: failures, outcome: 'refused', head, explicit: summary, events: [] }
  )
}

/**
 * The ready push: on the approved head, the repository's pre-push hook in its ready mode runs the selected tests
 * (only the failed ones plus what the fix affects, after a refused one). The approved head must already be on the
 * remote — every commit was pushed as a storage push — or the Developer is sent back to publish it.
 */
export async function readyPush(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const fns = v2Of(task)
  const head = approvedHead(task, results, 'ready-push')
  const remote = safeRead(task.remoteHead)
  const loop = loopOf(task, results)
  const drift = worktreeDriftFrom(task, head)
  if (drift !== null) {
    return sendBackAfterApproval(
      task,
      results,
      'ready-refused',
      `both reviewers approved ${head}, but ${drift}. The ready push tests exactly the approved commit: commit and publish your work with publish_changes so the reviewers judge it, then finish your turn.`,
      { outcome: 'refused', head, events: [] }
    )
  }
  if (remote !== head) {
    return sendBackAfterApproval(
      task,
      results,
      'ready-refused',
      `the approved head ${head} is not on the remote (the task branch is at ${remote ?? 'nothing'}): publish it with publish_changes, then finish your turn.`,
      { outcome: 'refused', head, events: [] }
    )
  }
  // The ready-tests policy, read from the default branch for this head and recorded with it, so a restart keeps it.
  let policy: ReadyTestsPolicy = { mode: 'local' }
  if (fns.readyTestsPolicy) {
    try {
      policy = fns.readyTestsPolicy()
    } catch (error) {
      const detail = `the default branch's ready-tests policy could not be read, so the ready push of ${head} cannot tell whether its tests run locally or in required CI: ${error instanceof Error ? error.message : String(error)}. Nothing ran; resume once the forge read works.`
      pauseThrough(task, 'ready-push', { reason: 'infrastructure', detail })
      return {
        exitCode: BACK,
        stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
          readyPushFailures: latestRecord(results)?.readyPushFailures ?? 0,
          decision: { type: 'pause', reason: 'infrastructure', detail },
          outcome: 'policy-unreadable',
          head,
          events: []
        })
      }
    }
  }
  // The required check this publication owes, read from the same trusted source and recorded with the head whatever
  // the tests do: where they run never decides whether it is owed.
  let owedCi: RequiredCiPolicy | null = policy.mode === 'ci' ? { workflow: policy.workflow, check: policy.check } : null
  if (fns.requiredCiPolicy) {
    try {
      owedCi = fns.requiredCiPolicy()
    } catch (error) {
      const detail = `the default branch's required-CI policy could not be read, so the ready push of ${head} cannot tell which required check it owes: ${error instanceof Error ? error.message : String(error)}. Nothing ran; resume once the trusted read works.`
      pauseThrough(task, 'ready-push', { reason: 'infrastructure', detail })
      return {
        exitCode: BACK,
        stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
          readyPushFailures: latestRecord(results)?.readyPushFailures ?? 0,
          decision: { type: 'pause', reason: 'infrastructure', detail },
          outcome: 'policy-unreadable',
          head,
          events: []
        })
      }
    }
  }
  const deferTests = policy.mode === 'ci'
  if (deferTests) {
    // Read-only, before any expensive work: a stale loop baseline is the Developer's own reviewed refresh.
    const baseline = fns.checkReadyBaseline?.() ?? { ok: true as const }
    if (!baseline.ok)
      return sendBackAfterApproval(
        task,
        results,
        'ready-refused',
        `both reviewers approved ${head}, but ${baseline.reason}`,
        {
          outcome: 'baseline-refused',
          head,
          events: []
        }
      )
  }
  const now = nowOf(fns)
  const started = now()
  const gate = await fns.runReadyGate({
    head,
    ...(context.signal ? { signal: context.signal } : {}),
    ...(deferTests ? { deferTests: true } : {})
  })
  const wallMs = gate.wallMs > 0 ? gate.wallMs : Math.max(0, now() - started)
  const deferred = gate.passed && gate.localTests === 'deferred' && gate.requiredCi !== undefined
  // A passed local run with a non-empty selection: the hook ran the selected suite, so the explicit commands follow it.
  const local =
    gate.passed &&
    !deferred &&
    gate.localTests !== 'none' &&
    (gate.selection?.selected.length ?? 0) > 0 &&
    fns.runExplicitCommands !== undefined
  // Deferred or local: the approved explicit Test Plan commands run now, through the driver, on the head being published.
  let explicit: ExplicitCommandsResult | null = null
  if (deferred || local) {
    const approved = approvedTestPlanBody(fns)
    if (approved === null) {
      const detail = `the ready push of ${head} ${deferred ? 'deferred its selected tests' : 'ran its selected tests'}, but the approved Test Plan (the staged pull-request body) could not be read, so its explicit commands cannot run; the live body grants no command authority. Restore the staged body, then resume.`
      pauseThrough(task, 'ready-push', { reason: 'infrastructure', detail })
      return {
        exitCode: BACK,
        stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
          readyPushFailures: latestRecord(results)?.readyPushFailures ?? 0,
          decision: { type: 'pause', reason: 'infrastructure', detail },
          outcome: 'plan-unreadable',
          head,
          events: []
        })
      }
    }
    const commands = explicitTestPlanCommands(approved)
    if (commands.length > 0 && fns.runExplicitCommands) {
      const deadlineMs = fns.readyDeadlineMs?.() ?? DEFAULT_READY_PUSH_TIMEOUT_MINUTES * 60_000
      explicit = await fns.runExplicitCommands({
        head,
        body: approved,
        commands,
        deadlineAt: started + deadlineMs,
        ...(context.signal ? { signal: context.signal } : {})
      })
      fns.log?.(
        `ready push: explicit Test Plan commands ${explicit.outcome} in ${explicit.wallMs} ms (${commands.length} command(s))`
      )
    }
  }
  if (explicit !== null && explicit.outcome !== 'passed') return explicitCommandsRefused(task, results, head, explicit)
  const selected = gate.selection?.selected.length ?? 0
  const failedCount = gate.failed === 'all' ? Math.max(selected, 1) : gate.failed.length
  const events = [
    readyPushEvent(loop, {
      head,
      outcome: gate.passed ? 'passed' : 'refused',
      selected,
      failed: gate.passed ? 0 : failedCount,
      rerun: gate.selection?.mode === 'rerun',
      wallMs
    }),
    ...(gate.selection?.mode === 'rerun'
      ? [
          failedTestsRerunEvent(loop, {
            head,
            rerunOf: gate.selection.rerunOf ?? '',
            failedFiles: gate.selection.rerunFailed?.length ?? 0,
            affectedFiles: gate.selection.affectedSince?.length ?? 0,
            fullCount: gate.selection.fullCount
          })
        ]
      : [])
  ]
  if (gate.passed) {
    const previous = latestRecord(results)
    // A deferred head owes the check its hook recorded; a locally tested head owes the trusted descriptor's check.
    const owed = deferred ? gate.requiredCi : owedCi
    return {
      exitCode: FORWARD,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        counters: previous?.counters ?? NO_COUNTERS,
        decision: { type: 'ready' },
        outcome: 'passed',
        readyPushFailures: 0,
        head,
        selection: gate.selection,
        ...(gate.localTests ? { localTests: gate.localTests } : {}),
        // The CI obligation the head carries, deferred or locally tested, bound to it here so a restarted run cannot
        // forget it. `localTests` alone says whether the selected tests were deferred.
        ...(owed ? { requiredCi: { ...owed, head } } : {}),
        ...(explicit
          ? {
              explicit: explicit.results.map(({ command, outcome, reusedFrom, wallMs: ms }) => ({
                command,
                outcome,
                ...(reusedFrom ? { reusedFrom } : {}),
                ...(ms !== undefined ? { wallMs: ms } : {})
              })),
              explicitWallMs: explicit.wallMs
            }
          : {}),
        events
      })
    }
  }
  if (gate.timedOut) {
    // A run stopped at its limit proved nothing about the code: the approved commit stays as it is, no Developer turn
    // is spent on it, and a person decides whether to raise the limit or run the tests elsewhere.
    const limit = gate.limitMinutes ?? DEFAULT_READY_PUSH_TIMEOUT_MINUTES
    const files =
      gate.selectedCount !== undefined ? `${gate.selectedCount} selected test files` : 'its selected test files'
    const detail = `the ready push stopped ${files} at its ${limit}-minute limit (reviewPolicy.readyPushTimeoutMinutes); the approved code was not changed. Raise the limit, or run the tests another way, then resume.`
    pauseThrough(task, 'ready-push', { reason: 'ready_push_failed', detail })
    return {
      exitCode: BACK,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        readyPushFailures: latestRecord(results)?.readyPushFailures ?? 0,
        decision: { type: 'pause', reason: 'ready_push_failed', detail },
        outcome: 'timed-out',
        head,
        failed: gate.failed,
        events
      })
    }
  }
  const failures = (latestRecord(results)?.readyPushFailures ?? 0) + 1
  if (failures >= READY_PUSH_FAILURE_LIMIT) {
    ;(task.bound?.discardHeldVerdicts ?? discardHeldVerdicts)(task.runtimeDir, task.issueNumber, task.reviewRound())
    const detail = `the ready push failed ${failures} consecutive times; failing test files: ${gate.failed === 'all' ? 'all' : gate.failed.join(', ')}`
    pauseThrough(task, 'ready-push', { reason: 'ready_push_failed', detail })
    return {
      exitCode: BACK,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        readyPushFailures: failures,
        decision: { type: 'pause', reason: 'ready_push_failed', detail },
        outcome: 'refused',
        head,
        failed: gate.failed,
        events
      })
    }
  }
  return sendBackAfterApproval(
    task,
    results,
    'ready-refused',
    `both reviewers approved ${head}, but the ready push refused it: the selected tests failed.\n\n${failingTestLines(gate)}\n\nThe ready push runs the selected test files on the approved head through the repository's pre-push hook in ready mode. Run the named failing files before publishing your fix; when the files are unknown, run the full selection.`,
    {
      readyPushFailures: failures,
      outcome: 'refused',
      head,
      selection: gate.selection,
      failed: gate.failed,
      events
    }
  )
}

/** Records how the ready push routed; the decision on this step reads that step's own exit result. */
export function classifyReadyPush(context: ActionContext): { exitCode: number; stdout: string } {
  const pushed = context.results['ready-push']
  if (!pushed) throw new Error('classify-ready-push ran before the ready push recorded a result')
  return ok(isSentBack(pushed) ? 'developer' : 'open-pull-request')
}

/**
 * Opens the pull request from the staged one once the ready push passed, and ends storage pushes for the worktree.
 * A pull request already open (a CI-red fix came back through review) is kept. A staged body the forge's checks
 * refuse sends the Developer back with the refusal.
 */
export async function openPullRequestStep(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const fns = v2Of(task)
  const head = worktreeHeadOf(task) ?? ''
  const loop = loopOf(task, results)
  const previous = latestRecord(results)
  const forward = async (pr: number, opened: boolean, events: unknown[]) => {
    // Publish the held verdicts before evidence edits or CI reads can observe a verdict-less pull request.
    await createActions(task)['harness.publish']!({
      ...context,
      nodeId: 'publish-ready-for-merge',
      action: 'harness.publish'
    })
    const evidence = await writeEvidenceFor(fns, pr, head)
    return {
      exitCode: FORWARD,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        counters: previous?.counters ?? NO_COUNTERS,
        decision: { type: opened ? 'pr_opened' : 'pr_kept' },
        pr,
        opened,
        verdictPublication: {
          pr,
          head,
          round: task.reviewRound(),
          manifest: dispatchedManifest(results) ? manifestDigest(dispatchedManifest(results)!) : null
        },
        head,
        ...(evidence ? { evidence } : {}),
        events
      })
    }
  }
  const open = safeRead(fns.findOpenPullRequest)
  if (open !== null) {
    fns.endStoragePushes()
    return forward(open.number, false, [])
  }
  const stagedBody = safeRead(fns.stagedPullRequest)
  const command = readyGateCommand(results, task.worktreePath)
  const staged =
    stagedBody !== null && command !== null
      ? { ...stagedBody, body: withReadyTestCommand(stagedBody.body, command.command, command.observable) }
      : stagedBody
  if (staged === null) {
    return sendBackAfterApproval(
      task,
      results,
      'ready-refused',
      `both reviewers approved ${head}, but no pull-request body is staged: call open_pull_request with the full PR-report body (in this flow it saves the body, and the driver opens the pull request), then finish your turn.`,
      { outcome: 'no-staged-body', head, events: [] }
    )
  }
  const opened = await fns.openPullRequest(staged)
  if (!opened.ok) {
    return sendBackAfterApproval(
      task,
      results,
      'ready-refused',
      `both reviewers approved ${head}, but the pull request could not open from the staged body: ${opened.reason}\n\nFix the body and call open_pull_request again (it saves the body), then finish your turn.`,
      { outcome: 'open-refused', head, events: [] }
    )
  }
  fns.endStoragePushes()
  return forward(opened.pr, true, [prOpenedEvent(loop, opened.pr, head)])
}

/**
 * The Evidence block for the head the ready push passed, written by the loop once the pull request is open. A write
 * that fails transiently is retried once after a short wait; every failed attempt is logged. A final failure is
 * recorded, not routed: the pull request's evidence check reads the block, and CI's one read sends the
 * Developer back if it is red.
 */
async function writeEvidenceFor(fns: V2Functions, pr: number, head: string): Promise<string | null> {
  if (!fns.writeEvidence) return null
  const write = fns.writeEvidence
  const attempt = async () => {
    try {
      return await write({ pr, head })
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error), retryable: true }
    }
  }
  const logFailure = (reason: string) =>
    fns.log?.(`Evidence write for pull request #${pr} failed: ${reason.replace(/[\r\n]+/g, ' ')}`)
  let written = await attempt()
  if (!written.ok) {
    logFailure(written.reason)
    if (written.retryable) {
      await (fns.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(1000)
      written = await attempt()
      if (!written.ok) logFailure(written.reason)
    }
  }
  return written.ok ? 'written' : `not written: ${written.reason}`
}

/**
 * The ready push's test command as the pull-request body names it: the hook's own command text with each selected
 * file as a `./`-prefixed path relative to the task worktree's root, never the worktree's absolute path. The Evidence
 * write still reuses the hook's run per file, since the report engine resolves each relative path against the
 * worktree before comparing it with the hook's recorded absolute ones.
 */
export function readyTestPlanCommand(files: readonly string[], worktreePath: string): string {
  return readyTestCommand(
    files.map((file) => {
      const rel = relative(worktreePath, resolve(worktreePath, file)).split(sep).join('/')
      return rel.startsWith('../') ? rel : `./${rel}`
    })
  )
}

/** The test command the passed ready push ran (its selection, worktree-relative), or null when it ran none. */
function readyGateCommand(results: Results, worktreePath: string): { command: string; observable: string } | null {
  const ready = results['ready-push']
  if (!ready || !('stdout' in ready)) return null
  try {
    const record = JSON.parse(String(ready.stdout)) as {
      selection?: SelectionNote | null
      localTests?: 'none' | 'deferred'
      requiredCi?: { workflow: string; check: string } | null
    }
    // Only a head whose selected tests were actually deferred names the required check as its automatic line; a
    // required-CI obligation on a locally tested head never implies that its tests did not run.
    if (record.localTests === 'deferred' && record.requiredCi)
      return {
        command: readyCiPlanCommand(record.requiredCi),
        observable: 'the selected tests pass in the required current-head CI check'
      }
    // A native run names its own aggregate command: the identities, configurations and context it executed.
    const native = record.selection?.native
    if (native?.command)
      return { command: native.command, observable: 'every selected test passes under its own native runner' }
    if (native) return null
    const selected = record.selection?.selected
    return selected && selected.length > 0
      ? { command: readyTestPlanCommand(selected, worktreePath), observable: 'every selected test file passes' }
      : null
  } catch {
    return null
  }
}

/**
 * The automatic selected-suite line of a Test Plan: a bare test-run line, a native run's aggregate command, or a
 * deferred head's required-CI line.
 */
export const isTestRunLine = (line: string): boolean => {
  const command = line.split('→')[0]?.trim() ?? ''
  return /^(bun\s+)?test(\s|$)/.test(command) || isNativeRunCommand(command) || isReadyCiCommand(command)
}

/**
 * The staged body with its Test Plan's test-run line set to `command`, the ready push's own: the Evidence write then
 * reuses that run, cached for the same head, instead of running the tests again. The first fenced block under the
 * Test Plan heading is the command list; its test-run lines become this one line, and every other command stays. A
 * body with no such block is returned unchanged.
 */
export function withReadyTestCommand(
  body: string,
  command: string,
  observable = 'every selected test file passes'
): string {
  const lines = body.split('\n')
  const heading = lines.findIndex((line) => /^#{1,6}\s+test plan\b/i.test(line.trim()))
  if (heading === -1) return body
  let open = -1
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i] as string
    if (/^#{1,6}\s/.test(line.trim())) return body
    if (line.trim().startsWith('```')) {
      open = i
      break
    }
  }
  if (open === -1) return body
  const close = lines.findIndex((line, i) => i > open && line.trim().startsWith('```'))
  if (close === -1) return body
  const kept = lines.slice(open + 1, close).filter((line) => !isTestRunLine(line))
  return [...lines.slice(0, open + 1), `${command} → ${observable}`, ...kept, ...lines.slice(close)].join('\n')
}

/** Records how the opening routed; the decision on this step reads that step's own exit result. */
export function classifyPullRequestOpened(context: ActionContext): { exitCode: number; stdout: string } {
  const opened = context.results['open-pull-request']
  if (!opened) throw new Error('classify-pr-opened ran before the opening recorded a result')
  return ok(isSentBack(opened) ? 'developer' : 'ci')
}

/**
 * The one CI read of the approved head: waited on while pending (the forge gates' own read, `readForgeCi`). Red
 * sends the Developer back with the failing checks, and so does a head the remote does not hold yet, to publish it
 * with no CI read; anything else goes on to publication.
 */
export async function readCiOnce(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const fns = v2Of(task)
  const loop = loopOf(task, results)
  const open = safeRead(fns.findOpenPullRequest)
  if (open === null) throw new Error(`read-ci-once found no open pull request for branch ${task.branch}`)
  // A head that owes a required check — its tests deferred or run locally — owes the strict required-CI read; with no
  // strict reader the run refuses to complete rather than fall back to the generic read.
  const owed = requiredCiOwed(results)
  if (owed !== null) {
    if (fns.readRequiredCi)
      return withCiProgress(fns, (progress) => readRequiredCiStep(task, context, open.number, owed, progress))
    const detail = `the head ${owed.head} owes the required check ${owed.check} (${owed.workflow}), and this driver has no strict required-CI reader, so no CI read can complete the run; the generic check read never stands in for it. Resume under a driver that reads required CI.`
    pauseThrough(task, 'read-ci-once', { reason: 'infrastructure', detail })
    return {
      exitCode: BACK,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        decision: { type: 'pause', reason: 'infrastructure', detail },
        head: owed.head,
        requiredCi: owed,
        conclusion: 'pending',
        failingChecks: [],
        events: []
      })
    }
  }
  const now = nowOf(fns)
  const started = now()
  // The forge gates' read, given this step's own earlier record and no local gate to skip on.
  const read = await readForgeCi(task, {
    ...context,
    results: ciReadResults(results)
  })
  const waitMs = Math.max(0, now() - started)
  const ci = JSON.parse(read.stdout) as {
    head: string | null
    conclusion: 'green' | 'red' | 'pending' | 'skipped' | 'unpushed'
    failingChecks: string[]
  }
  const head = ci.head ?? worktreeHeadOf(task) ?? ''
  if (ci.conclusion === 'unpushed')
    return sendBackAfterApproval(
      task,
      results,
      'unpushed',
      `The head ${head} is not on the remote branch, so no CI has run on it. Publish it with publish_changes on this SAME branch.`,
      ci
    )
  const events = [
    ciResultReadEvent(loop, {
      pr: open.number,
      head,
      conclusion: ci.conclusion,
      failingChecks: ci.failingChecks,
      waitMs
    })
  ]
  if (ci.conclusion !== 'red') {
    const previous = latestRecord(results)
    return {
      exitCode: FORWARD,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        counters: previous?.counters ?? NO_COUNTERS,
        decision: { type: 'ci_green' },
        ...ci,
        events
      })
    }
  }
  return sendBackAfterApproval(
    task,
    results,
    'ci-red',
    `CI is red on pull request #${open.number} at ${head}. Failing check-run(s): ${ci.failingChecks.length > 0 ? ci.failingChecks.join(', ') : '(unknown)'}. Fix the failing check(s), commit, and publish the fix with publish_changes on this SAME branch — the pull request is open, so this push runs the selected tests.${failureExcerptsOnHead(task, fns, head)}`,
    { ...ci, events }
  )
}

/** The required CI the ready push's record binds to its head — deferred or locally tested — or null when none is owed. */
export function requiredCiOwed(results: Results): { workflow: string; check: string; head: string } | null {
  const ready = results['ready-push']
  if (!ready || !('stdout' in ready)) return null
  try {
    const record = JSON.parse(String(ready.stdout)) as {
      requiredCi?: { workflow?: unknown; check?: unknown; head?: unknown } | null
    }
    const owed = record.requiredCi
    return owed && typeof owed.workflow === 'string' && typeof owed.check === 'string' && typeof owed.head === 'string'
      ? { workflow: owed.workflow, check: owed.check, head: owed.head }
      : null
  } catch {
    return null
  }
}

/** One failure, as the send-back and pause details name it. */
const describeFailure = (failure: ClassifiedFailure): string =>
  `${failure.job} (job ${failure.jobId}${failure.step ? `, step "${failure.step}"` : ''}${failure.url ? `, ${failure.url}` : ''}${failure.diagnostic ? `: ${failure.diagnostic}` : ''})`

/**
 * The CI read of a head that owes a required check, whether its ready push deferred its selected tests or ran them locally (version 2 only). Polled within the gate poll
 * budget, each poll reads two things: the strict required-CI verdict (`readRequiredCi` — the configured workflow's
 * latest attempt for exactly this head, its required check completed `success`) and the ordinary mechanical
 * conclusion, so another required check's failure is never hidden behind a green test check. A completed failing job
 * is reacted to at once. Code failures (assertion, lint, typecheck, policy, security) go back to the Developer;
 * recognized setup or provider failures, unclassified failures and a stalled queue or run pause for the Operator with
 * the head, job, URL and diagnostic — nothing is rerun and no Developer turn is spent. Green only on both; pending
 * past the budget pauses, and never reads green. The time bounds read the provider's own timestamps, and the
 * obligation itself sits in the ready push's checkpointed record, so a restarted run resumes the same read.
 */
async function readRequiredCiStep(
  task: TaskInput,
  context: ActionContext,
  pr: number,
  owed: { workflow: string; check: string; head: string },
  /** The wait's progress lines, from what each read already saw: no read of their own, no say in any decision. */
  progress: CiProgress | null = null
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const fns = v2Of(task)
  const loop = loopOf(task, results)
  const now = nowOf(fns)
  const started = now()
  const head = worktreeHeadOf(task)
  const remote = safeRead(task.remoteHead)
  const base = { head: owed.head, requiredCi: owed }
  if (head !== owed.head || remote !== owed.head)
    return sendBackAfterApproval(
      task,
      results,
      'unpushed',
      `The head ${owed.head}, which owes the required check, is not the published head (worktree ${head ?? 'unreadable'}, remote ${remote ?? 'nothing'}), so its required CI cannot complete the run. Publish your work with publish_changes on this SAME branch.`,
      { ...base, conclusion: 'unpushed', failingChecks: [] }
    )
  const pause = (
    detail: string,
    extra: Record<string, unknown>,
    why: 'infrastructure' | 'poll-budget' = 'infrastructure'
  ) => {
    // A stalled job already has its own queue or ceiling line.
    if (extra.stalled === undefined) progress?.paused(detail, why)
    pauseThrough(task, 'read-ci-once', { reason: 'infrastructure', detail })
    return {
      exitCode: BACK,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        decision: { type: 'pause', reason: 'infrastructure', detail },
        ...base,
        conclusion: 'pending',
        failingChecks: [],
        ...extra,
        events: [
          ciResultReadEvent(loop, {
            pr,
            head: owed.head,
            conclusion: 'pending',
            failingChecks: [],
            waitMs: Math.max(0, now() - started)
          })
        ]
      })
    }
  }
  const readGeneric = task.bound?.fetchCiConclusion ?? fetchCiConclusion
  const poll = gatePollOf(task)
  const wallNow = fns.wallNow ?? (() => Date.now())
  let last = 'no read completed'
  for (let attempt = 1; attempt <= poll.gatePollMaxAttempts; attempt++) {
    const strict = fns.readRequiredCi!({ ...owed, now: wallNow() }, progress?.observe)
    progress?.result(strict)
    const generic = safeRead(() => readGeneric(owed.head)) ?? 'pending'
    if (strict.state === 'red') {
      const code = strict.failures.filter((failure) => failure.kind === 'code')
      if (code.length === 0) {
        const named = strict.failures.map(describeFailure).join('; ')
        return pause(
          `the required check ${owed.check} failed on ${owed.head} for a reason the driver reads as ${strict.failures.some((f) => f.kind === 'infrastructure') ? 'a CI setup or provider failure' : 'unclassified'}: ${named}. Run ${strict.runUrl ?? strict.runId}. No Developer turn was sent and nothing was rerun; rerun the job or fix the runner, then resume — only a successful run on this head completes the task.`,
          { failures: strict.failures, runId: strict.runId }
        )
      }
      const failingChecks = code.map(describeFailure)
      return sendBackAfterApproval(
        task,
        results,
        'ci-red',
        `The required check ${owed.check} is red on pull request #${pr} at ${owed.head}. Failing job(s): ${failingChecks.join(', ')}. Fix them, commit, and publish the fix with publish_changes on this SAME branch.${failureExcerptsOnHead(task, fns, owed.head, progress?.excerpt)}`,
        {
          ...base,
          conclusion: 'red',
          failingChecks,
          failures: strict.failures,
          events: [
            ciResultReadEvent(loop, {
              pr,
              head: owed.head,
              conclusion: 'red',
              failingChecks,
              waitMs: Math.max(0, now() - started)
            })
          ]
        }
      )
    }
    if (strict.state === 'stalled')
      return pause(
        `${strict.detail} (${strict.url ?? `job ${strict.jobId}`}); the ${strict.bound === 'queue' ? 'queue' : 'execution'} bound is not a code failure. No Developer turn was sent and nothing was rerun; resolve the runner, then resume — only a successful run on this head completes the task.`,
        { stalled: strict.bound, jobId: strict.jobId }
      )
    if (generic === 'red') {
      // Another required mechanical check failed: the ordinary CI send-back, with its failing checks.
      const failingChecks =
        safeRead(() =>
          (task.bound?.fetchFailingCheckRuns ?? fetchFailingCheckRuns)(owed.head).map(describeFailingCheckRun)
        ) ?? []
      return sendBackAfterApproval(
        task,
        results,
        'ci-red',
        `CI is red on pull request #${pr} at ${owed.head}. Failing check-run(s): ${failingChecks.length > 0 ? failingChecks.join(', ') : '(unknown)'}. Fix the failing check(s), commit, and publish the fix with publish_changes on this SAME branch.${failureExcerptsOnHead(task, fns, owed.head, progress?.excerpt)}`,
        {
          ...base,
          conclusion: 'red',
          failingChecks,
          events: [
            ciResultReadEvent(loop, {
              pr,
              head: owed.head,
              conclusion: 'red',
              failingChecks,
              waitMs: Math.max(0, now() - started)
            })
          ]
        }
      )
    }
    if (strict.state === 'green' && generic === 'green') {
      const previous = latestRecord(results)
      return {
        exitCode: FORWARD,
        stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
          counters: previous?.counters ?? NO_COUNTERS,
          decision: { type: 'ci_green' },
          ...base,
          conclusion: 'green',
          failingChecks: [],
          // The run and check that satisfied the required tests, kept with the current head.
          requiredCiIdentity: strict.identity,
          events: [
            ciResultReadEvent(loop, {
              pr,
              head: owed.head,
              conclusion: 'green',
              failingChecks: [],
              waitMs: Math.max(0, now() - started)
            })
          ]
        })
      }
    }
    last = strict.state === 'green' ? `${owed.check} passed; other checks are ${generic}` : strict.detail
    if (attempt < poll.gatePollMaxAttempts) await poll.sleep(poll.gatePollIntervalMs)
  }
  return pause(
    `the required CI on ${owed.head} did not complete within the poll budget (${last}); pending never counts as the tests passing. Resume once it completes.`,
    {},
    'poll-budget'
  )
}

/**
 * Runs the required-CI wait with its progress, when the driver log takes progress lines: the tracker the wait feeds
 * its reads to, its 60-second line on a timer, and on the way out the held failed-job lines and the timer's end. None
 * of it can throw into the wait or change what it returns.
 */
async function withCiProgress<T>(fns: V2Functions, wait: (progress: CiProgress | null) => Promise<T>): Promise<T> {
  if (!fns.progressLine) return wait(null)
  const progress = createCiProgress(fns.progressLine, fns.wallNow ?? (() => Date.now()))
  let stopSummary: () => void = () => {}
  try {
    stopSummary = (fns.progressEvery ?? everyInterval)(() => progress.summary(), PROGRESS_SUMMARY_INTERVAL_MS)
  } catch {
    // No 60-second line; the wait itself is unchanged.
  }
  try {
    return await wait(progress)
  } finally {
    progress.flush()
    try {
      stopSummary()
    } catch {
      // The timer is the wait's own; it never fails the step.
    }
  }
}

/** `setInterval` with its timer unreferenced, so a pending line never keeps the driver alive. */
function everyInterval(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * The failure lines of each failed job on `head`, rendered for the send-back prompt under the check's name. A job's log
 * is read only for a check that failed (a failed workflow run is no job, so it has none), each excerpt is bounded and
 * the total is too; a log that cannot be read keeps its check's name and says so.
 */
function failureExcerptsOnHead(
  task: TaskInput,
  fns: V2Functions,
  head: string,
  /** Shown each excerpt this send-back read, for the CI wait's progress; it reads nothing of its own. */
  onExcerpt?: (check: string, excerpt: string | null) => void
): string {
  const read = fns.readCheckExcerpt ?? ((jobId: number, max: number) => readFailedCheckExcerpt(jobId, max))
  let runs: { name: string; id: number; detail?: string }[]
  try {
    runs = (task.bound?.fetchFailingCheckRuns ?? fetchFailingCheckRuns)(head)
  } catch {
    return ''
  }
  const parts: string[] = []
  let remaining = MAX_FAILURE_EXCERPT_TOTAL_CHARS
  for (const run of runs) {
    if (run.detail !== undefined) continue
    const check = sanitizeForgeText(run.name, 200)
    if (remaining <= 0) {
      parts.push(`Failure lines of \`${check}\` (run ${run.id}): omitted, the other checks' excerpts fill the prompt.`)
      continue
    }
    let excerpt: string | null
    try {
      excerpt = read(run.id, Math.min(MAX_FAILURE_EXCERPT_CHARS, remaining))
    } catch {
      excerpt = null
    }
    remaining -= excerpt?.length ?? 0
    // `run.name`, not the sanitized label: it is the CI job's own name, the key its progress line was held under.
    onExcerpt?.(run.name, excerpt)
    parts.push(renderFailureExcerpt(check, run.id, excerpt))
  }
  return parts.length === 0 ? '' : `\n\n${parts.join('\n\n')}`
}

/** Records how the CI read routed; the decision on this step reads that step's own exit result. */
export function classifyCiResult(context: ActionContext): { exitCode: number; stdout: string } {
  const read = context.results['read-ci-once']
  if (!read) throw new Error('classify-ci-result ran before the CI read recorded a result')
  return ok(isSentBack(read) ? 'developer' : 'publish')
}

/**
 * Version 2's reconcile step: the task branch's open pull request, and — when one is open — its mergeability, read
 * before anything else runs. A conflicting one records the conflict send-back (the conflicting files, and the default
 * branch's tip the controller fetched for the repair) and routes to the Developer, so even a fresh run's first turn is
 * the conflict turn, before any local check or reviewer. One that does not conflict but whose head's CI is red records
 * the failing checks instead (`reconcileCiRed`) and routes to the Developer the same way. The record is checkpointed
 * with the step: a restart neither repeats nor skips it.
 */
export async function reconcileExternalState(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const open = (task.bound?.findOpenPrForBranch ?? findOpenPrForBranch)(task.branch)
  if (open === null) return { exitCode: EXIT_NO_OPEN_PR, stdout: JSON.stringify(open) }
  const mergeable = await pollMergeableState(open.number, {
    ...gatePollOf(task),
    fetchMergeableState: task.bound?.fetchMergeableState ?? fetchMergeableState
  })
  if (mergeable !== 'CONFLICTING')
    return reconcileCiRed(task, context, open) ?? { exitCode: EXIT_OPEN_PR, stdout: JSON.stringify(open) }
  const { results } = context
  const files = (task.bound?.fetchConflictingFiles ?? fetchConflictingFiles)('main', task.branch)
  const fns = v2Of(task)
  const mainTip = safeRead(fns.readMainTip)
  // The approvals the published pull request already carries: recorded with the conflict, the baseline its repair
  // is judged against.
  const baseline = safeRead(() => fns.readPostedVerdicts?.(open.number) ?? null)
  const sendBack: SendBack = {
    kind: 'conflict',
    headBefore: safeRead(task.remoteHead) ?? worktreeHeadOf(task),
    files,
    mainTip,
    baseline
  }
  return {
    exitCode: EXIT_CONFLICT_REENTRY,
    stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
      // The runner reads the open pull request's number from this step's result, as it does when no conflict is found.
      number: open.number,
      decision: { type: 'dispatch_developer' },
      sendBack,
      mergeable,
      files
    })
  }
}

/**
 * The reconcile step's CI half, for an open pull request that does not conflict: one read of its remote head's CI
 * under the every-run-completed rule (`fetchSettledCiConclusion`), never waited on. Red records the CI send-back —
 * each failing check by name and run, and the failure lines of each failed job — and routes to the Developer, so a
 * fresh run re-entering a pull request whose CI turned red after publication starts with the turn that fixes it.
 * Null when the head cannot be read or CI is not red: the run attaches as before.
 */
function reconcileCiRed(
  task: TaskInput,
  context: ActionContext,
  open: { number: number }
): { exitCode: number; stdout: string } | null {
  const head = safeRead(task.remoteHead)
  if (head === null) return null
  const conclusion = safeRead(() => (task.bound?.fetchSettledCiConclusion ?? fetchSettledCiConclusion)(head))
  if (conclusion !== 'red') return null
  const fns = v2Of(task)
  const failingChecks =
    safeRead(() => (task.bound?.fetchFailingCheckRuns ?? fetchFailingCheckRuns)(head).map(describeFailingCheckRun)) ??
    []
  const { results } = context
  const sendBack: SendBack = {
    kind: 'ci-red',
    headBefore: head,
    detail: `CI turned red on pull request #${open.number} at ${head} after it was published. Failing check-run(s): ${failingChecks.length > 0 ? failingChecks.join(', ') : '(unknown)'}. Fix the failing check(s), commit, and publish the fix with publish_changes on this SAME branch — the pull request is open, so this push runs the selected tests.${failureExcerptsOnHead(task, fns, head)}`
  }
  return {
    exitCode: EXIT_CI_RED_REENTRY,
    stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
      // The runner reads the open pull request's number from this step's result, as it does when CI is not red.
      number: open.number,
      decision: { type: 'dispatch_developer' },
      sendBack,
      head,
      conclusion,
      failingChecks
    })
  }
}

/** Why a conflict repair is not proven: a stable code the repeat bound compares, the reason, and the files it names. */
export interface ConflictRepairFailure {
  code:
    | 'unreadable-head'
    | 'unpublished'
    | 'unchanged-head'
    | 'single-parent'
    | 'main-tip-missing'
    | 'unresolved-index'
    | 'main-unreadable'
    | 'not-clean'
    | 'not-mergeable'
    | 'pr-unreadable'
  reason: string
  files: string[]
}

const gitIn = (cwd: string, args: readonly string[]) =>
  spawnSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean =>
  gitIn(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0

/**
 * The local half of a conflict repair's proof, read from the task worktree with plain git: the published head moved
 * and is a merge commit; one of its merged parents is the default branch's tip fetched for the repair (or a later
 * commit of the default branch that contains it); the index holds no unresolved entry; and the head merges cleanly
 * with the default branch's tip fetched now. Null when every part holds.
 */
export function conflictRepairFailure(input: {
  worktreePath: string
  head: string | null
  remote: string | null
  headBefore: string | null
  /** The tip recorded with the conflict; null when none was recorded, and the fresh tip stands for it. */
  mainTip: string | null
  freshTip: string | null
}): ConflictRepairFailure | null {
  const { worktreePath: cwd, head, remote, headBefore, freshTip } = input
  if (head === null) return { code: 'unreadable-head', reason: 'the task worktree head could not be read', files: [] }
  if (remote !== head)
    return {
      code: 'unpublished',
      reason: `the merge is not published: the remote branch is at ${remote ?? 'nothing'}, the worktree at ${head}`,
      files: []
    }
  if (head === headBefore)
    return { code: 'unchanged-head', reason: `the head ${head} did not move, so no merge was published`, files: [] }
  const parents = (gitIn(cwd, ['rev-list', '--parents', '-n', '1', head]).stdout ?? '').trim().split(/\s+/).slice(1)
  if (parents.length < 2)
    return {
      code: 'single-parent',
      reason: `the head ${head} is a single-parent commit, not a merge of the default branch`,
      files: []
    }
  const tip = input.mainTip ?? freshTip
  const merged = parents.slice(1)
  if (
    tip === null ||
    !merged.some(
      (parent) =>
        parent === tip || (freshTip !== null && isAncestor(cwd, tip, parent) && isAncestor(cwd, parent, freshTip))
    )
  )
    return {
      code: 'main-tip-missing',
      reason: `the merge ${head}'s parents (${parents.join(', ')}) do not include the default branch's tip ${tip ?? '(unreadable)'}`,
      files: []
    }
  const unresolved = gitIn(cwd, ['ls-files', '-u'])
  const unresolvedFiles = [
    ...new Set(
      (unresolved.stdout ?? '')
        .split('\n')
        .map((line) => line.split('\t')[1]?.trim() ?? '')
        .filter(Boolean)
    )
  ].sort()
  if (unresolved.status !== 0 || unresolvedFiles.length > 0)
    return {
      code: 'unresolved-index',
      reason:
        unresolved.status !== 0
          ? 'the worktree index could not be read'
          : `unresolved index entries remain: ${unresolvedFiles.join(', ')}`,
      files: unresolvedFiles
    }
  if (freshTip === null)
    return { code: 'main-unreadable', reason: 'the default branch tip could not be fetched', files: [] }
  const check = gitIn(cwd, ['merge-tree', '--write-tree', freshTip, head])
  if (check.status !== 0)
    return {
      code: 'not-clean',
      reason: `the head ${head} does not merge cleanly with the default branch at ${freshTip}`,
      files: parseMergeTreeConflictFiles(check.stdout ?? '')
    }
  return null
}

/**
 * Proves a conflict's repair before any reviewer is dispatched (version 2): the local proof
 * (`conflictRepairFailure`), then the open pull request's forge mergeability, which must read MERGEABLE. A step with
 * no conflict owed passes and records nothing. An unproven repair goes back to the Developer as a conflict with what
 * failed, never to the local checks or the reviewers; the same failure twice in a row pauses `repeat_failure`, as an
 * unresolved conflict does.
 */
export async function proveConflictRepair(
  task: TaskInput,
  context: ActionContext
): Promise<{ exitCode: number; stdout: string }> {
  const { results } = context
  const owed = owedConflictRepair(results)
  if (owed === null) return ok(JSON.stringify({ proof: 'not-owed' }))
  const fns = v2Of(task)
  const previous = latestRecord(results)
  let state = carriedLoopState(results, task.loopState)
  const counters = previous?.counters ?? NO_COUNTERS
  const round = task.reviewRound()
  const head = worktreeHeadOf(task)
  const remote = safeRead(task.remoteHead)
  const freshTip = safeRead(fns.readMainTip)
  let failure = conflictRepairFailure({
    worktreePath: task.worktreePath,
    head,
    remote,
    headBefore: owed.headBefore ?? null,
    mainTip: owed.mainTip ?? null,
    freshTip
  })
  let mergeable: string | null = null
  if (failure === null) {
    // A conflict is only ever owed on an open pull request, so a lookup that finds none failed: never proven.
    const open = safeRead(fns.findOpenPullRequest)
    if (open === null)
      failure = {
        code: 'pr-unreadable',
        reason: `the open pull request for ${task.branch} could not be read, so its mergeability is unknown`,
        files: []
      }
    else {
      mergeable = await pollMergeableState(open.number, {
        ...gatePollOf(task),
        fetchMergeableState: task.bound?.fetchMergeableState ?? fetchMergeableState
      })
      if (mergeable !== 'MERGEABLE')
        failure = {
          code: 'not-mergeable',
          reason: `the pull request's mergeability is ${mergeable}, not MERGEABLE`,
          files:
            mergeable === 'CONFLICTING'
              ? (task.bound?.fetchConflictingFiles ?? fetchConflictingFiles)('main', task.branch)
              : []
        }
    }
  }
  const fields = { head, mainTip: freshTip, mergeable, answered: previous?.answered ?? null }
  if (failure === null) {
    // The proven head and the tip are both frozen here: the approval decision reads only these two revisions.
    const carry = approvalCarryFor(task, owed.baseline ?? null, head as string, freshTip as string)
    fns.log?.(
      carry.kind === 'carry'
        ? `The merge ${carry.head} leaves the pull request's own patch unchanged: the approvals of ${carry.judgedHead} carry to it, with no new review.`
        : carry.kind === 'interdiff'
          ? `The merge ${carry.head} changed the pull request's own patch: both reviewers judge the change against the approvals of ${carry.judgedHead}.`
          : `The merge ${carry.head} gets a fresh review: ${carry.reason}.`
    )
    return {
      exitCode: FORWARD,
      stdout: recordOutput(results, state, {
        ...fields,
        counters: { ...counters, stallCheck: null },
        decision: { type: CONFLICT_REPAIR_PROVEN },
        carry
      })
    }
  }
  const sendBack: SendBack = {
    kind: 'conflict',
    headBefore: remote ?? head,
    files: failure.files.length > 0 ? failure.files : (owed.files ?? []),
    mainTip: freshTip ?? owed.mainTip ?? null,
    baseline: owed.baseline ?? null,
    detail: `The merge is not proven, so no reviewer is dispatched: ${failure.reason}.`
  }
  const stats = worktreeStats(task.worktreePath, 0)
  const assessed = assessRound(
    state,
    { kind: 'mechanical_failure', round, failure: `conflict repair not proven (${failure.code})`, stats },
    task.clock
  )
  state = assessed.state
  const events: DevReviewLoopEventInput[] = [...assessed.events]
  const record = (decision: { type: string; reason?: string; detail?: string }, nextCounters = counters) => ({
    exitCode: BACK,
    stdout: recordOutput(results, state, {
      ...fields,
      failure: failure.code,
      counters: { ...nextCounters, stallCheck: null },
      sendBack,
      events,
      decision
    })
  })
  if (assessed.decision.type === 'pause') {
    const reason: PauseReason = assessed.decision.reason
    const detail = `${assessed.decision.detail ?? reason}: ${failure.reason}`
    pauseThrough(task, 'prove-conflict-repair', { reason, detail })
    return record({ type: 'pause', reason, detail }, NO_COUNTERS)
  }
  return record({ type: 'dispatch_developer' })
}

/**
 * What a proven repair means for the approvals the conflict was recorded with (`decideApprovalCarry`): each own
 * patch is read in the task worktree against the default branch's tip fetched for the proof, from each head's own
 * merge base with it and with zero context, so neither the lines the default branch brought in nor the lines around
 * the pull request's own changes count. A changed own patch carries its interdiff for the reviewers.
 */
export function approvalCarryFor(
  task: TaskInput,
  baseline: PostedVerdictBodies | null,
  head: string,
  mainTip: string
): RecordedApprovalCarry {
  const none = (reason: string): RecordedApprovalCarry => ({ kind: 'none', reason, head, mainTip, baseline })
  if (baseline === null) return none('no posted approvals were recorded with the conflict')
  const current = safeRead(task.currentManifest)
  if (current === null || current.headSha !== head)
    return none('the review inputs of the repaired head could not be read')
  let policy: ReviewPolicy = DEFAULT_REVIEW_POLICY
  try {
    policy = task.reviewPolicy?.() ?? DEFAULT_REVIEW_POLICY
  } catch {
    return none('the review policy could not be read')
  }
  const options = { cwd: task.worktreePath }
  const decision = decideApprovalCarry({
    verdicts: baseline,
    current,
    policy,
    patchIdOf: (sha) => ownPatchIdAt(mainTip, sha, options)
  })
  if (decision.kind === 'none') return none(decision.reason)
  if (decision.kind === 'carry') return { kind: 'carry', judgedHead: decision.judgedHead, head, mainTip, baseline }
  const interdiff = ownPatchInterdiff(mainTip, decision.judgedHead, head, options)
  if (interdiff === null) return none('the change between the two own patches could not be read')
  return { kind: 'interdiff', judgedHead: decision.judgedHead, head, mainTip, interdiff, baseline }
}

/** Records how the approval decision routed: carried approvals go on to the ready push, anything else to the gates. */
export function classifyApprovalCarry(context: ActionContext): { exitCode: number; stdout: string } {
  const proved = context.results['prove-conflict-repair']
  if (!proved) throw new Error('classify-approval-carry ran before the proof recorded a result')
  return ok(isApprovalCarried(proved) ? 'ready-push' : 'gates')
}

/** The step carried approvals pass through on their way to the ready push: it records which head they carry to. */
export function carryApprovals(context: ActionContext): { exitCode: number; stdout: string } {
  const carried = carriedApprovals(context.results)
  if (carried === null) throw new Error('carry-approvals ran with no carried approvals recorded by the proof')
  return ok(JSON.stringify({ judgedHead: carried.judgedHead, head: carried.head }))
}

/** Records how the proof routed; the decision on this step reads that step's own exit result. */
export function classifyConflictRepair(context: ActionContext): { exitCode: number; stdout: string } {
  const proved = context.results['prove-conflict-repair']
  if (!proved) throw new Error('classify-conflict-repair ran before the proof recorded a result')
  return ok(isSentBack(proved) ? 'developer' : 'gates')
}

type V2Binding = {
  adapts: readonly ((...args: never[]) => unknown)[]
  build: (
    task: TaskInput
  ) => (context: ActionContext) => Promise<{ exitCode: number; stdout: string }> | { exitCode: number; stdout: string }
}

/** Version 2's action bindings, beside the shared ones (`ACTION_BINDINGS`) every flow binds. */
export const V2_ACTION_BINDINGS: Readonly<Record<string, V2Binding>> = {
  'vinaya.v2-reconcile-external-state': {
    adapts: [
      findOpenPrForBranch,
      pollMergeableState,
      fetchConflictingFiles,
      fetchSettledCiConclusion,
      fetchFailingCheckRuns
    ],
    build: (task) => (context) => reconcileExternalState(task, context)
  },
  'vinaya.v2-prove-conflict-repair': {
    adapts: [pollMergeableState, fetchConflictingFiles, assessRound],
    build: (task) => (context) => proveConflictRepair(task, context)
  },
  'vinaya.v2-classify-conflict-repair': { adapts: [], build: () => classifyConflictRepair },
  'vinaya.v2-classify-approval-carry': { adapts: [], build: () => classifyApprovalCarry },
  'vinaya.v2-carry-approvals': { adapts: [], build: () => carryApprovals },
  'vinaya.v2-local-checks': { adapts: [runCli], build: (task) => (context) => runLocalChecks(task, context) },
  'vinaya.v2-check-premise': { adapts: [checkPremiseAtHead], build: (task) => () => checkPremiseStaged(task) },
  'vinaya.v2-ready-push': { adapts: [], build: (task) => (context) => readyPush(task, context) },
  'vinaya.v2-classify-ready-push': { adapts: [], build: () => classifyReadyPush },
  'vinaya.v2-open-pull-request': { adapts: [], build: (task) => (context) => openPullRequestStep(task, context) },
  'vinaya.v2-classify-pr-opened': { adapts: [], build: () => classifyPullRequestOpened },
  'vinaya.v2-read-ci-once': {
    adapts: [readForgeCi, fetchCiConclusion, fetchFailingCheckRuns],
    build: (task) => (context) => readCiOnce(task, context)
  },
  'vinaya.v2-classify-ci-result': { adapts: [], build: () => classifyCiResult }
}

/** Version 2's deciding steps, each read from the step it examines. */
export const V2_DECISIONS = {
  'classify-conflict-repair': isSentBack,
  'classify-approval-carry': isApprovalCarried,
  'classify-ready-push': isSentBack,
  'classify-pr-opened': isSentBack,
  'classify-ci-result': isSentBack
} as const

/** Version 2's action registry for one task. */
export function createV2Actions(task: TaskInput) {
  return Object.fromEntries(
    Object.entries(V2_ACTION_BINDINGS).map(([name, binding]) => [name, withDeveloperContext(task, binding.build(task))])
  )
}
