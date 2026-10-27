import type { ActionContext } from '../../../../../harness/dev-process/engine-runtime/run-process'
import { runCli } from '../../../../../harness/gates/run-checks'
import {
  ciResultReadEvent,
  failedTestsRerunEvent,
  prOpenedEvent,
  readyPushEvent
} from '../../../../../apps/cli/src/lib/flow-v2-events'
import { discardHeldVerdicts } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { checkPremiseAtHead } from '../../../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import type { SelectionNote } from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import { readyTestCommand } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import { readUnpushedWorkDetail } from '../../../../../apps/cli/src/lib/dev-review-loop/unpushed-work'
import {
  BACK,
  carriedLoopState,
  FORWARD,
  isSentBack,
  latestRecord,
  NO_COUNTERS,
  ok,
  pauseThrough,
  readAssessment,
  readForgeCi,
  recordedDispatch,
  recordOutput,
  safeRead,
  type TaskInput,
  worktreeHeadOf
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
  /** `none` when the repository runs no local tests (no pre-push hook, or no declared test runner). */
  localTests?: 'none'
}

/** The staged pull request: what the Developer's `open_pull_request` saved while no pull request may open yet. */
export interface StagedPullRequest {
  title: string
  body: string
}

/** The forge and process functions version 2's steps call; the runner supplies the live ones, a test its fakes. */
export interface V2Functions {
  /** Runs the repository's pre-push hook in its ready mode on `head`. */
  runReadyGate: (input: { head: string; signal?: AbortSignal }) => Promise<ReadyGateResult> | ReadyGateResult
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
  }) => Promise<{ ok: true } | { ok: false; reason: string }> | { ok: true } | { ok: false; reason: string }
  /** The local checks of a round: `vinaya check --all --local` with the staged body as the pull-request body. */
  runLocalChecks?: (env: Record<string, string>) => { passed: boolean; output: string }
  /** Milliseconds since an arbitrary origin, for the time a step spends. */
  now?: () => number
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
  return {
    exitCode: BACK,
    stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
      counters: { ...(previous?.counters ?? NO_COUNTERS), stallCheck: null },
      sendBack: { kind, headBefore, detail },
      decision: { type: 'dispatch_developer' },
      ...extra
    })
  }
}

/**
 * The head both reviewers approved: the one the round's reviewer dispatch named (its review inputs' manifest), else
 * — a run with no recorded inputs — the worktree's. Throws when the step follows anything but an approval.
 */
function approvedHead(task: TaskInput, results: Results, step: string): string {
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
  if (gate.timedOut)
    return `the test run passed its deadline and was stopped. Its output (tail):\n\n${gate.output.slice(-4000)}`
  if (gate.failed === 'all')
    return `the test run failed without naming a test file. Its output (tail):\n\n${gate.output.slice(-4000)}`
  const tail = gate.output
    .split('\n')
    .filter((line) => line.startsWith('  ') && line.includes('.test.'))
    .slice(-40)
  return [...gate.failed.map((file) => `- ${file}`), ...(tail.length > 0 ? ['', ...tail] : [])].join('\n')
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
  const now = nowOf(fns)
  const started = now()
  const gate = await fns.runReadyGate({ head, ...(context.signal ? { signal: context.signal } : {}) })
  const wallMs = gate.wallMs > 0 ? gate.wallMs : Math.max(0, now() - started)
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
        events
      })
    }
  }
  const failures = (latestRecord(results)?.readyPushFailures ?? 0) + 1
  if (failures >= READY_PUSH_FAILURE_LIMIT) {
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
    `both reviewers approved ${head}, but the ready push refused it: ${gate.timedOut ? 'the selected tests ran past the deadline' : 'the selected tests failed'}.\n\n${failingTestLines(gate)}`,
    {
      readyPushFailures: failures,
      outcome: gate.timedOut ? 'timed-out' : 'refused',
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
    const evidence = await writeEvidenceFor(fns, pr, head)
    return {
      exitCode: FORWARD,
      stdout: recordOutput(results, carriedLoopState(results, task.loopState), {
        counters: previous?.counters ?? NO_COUNTERS,
        decision: { type: opened ? 'pr_opened' : 'pr_kept' },
        pr,
        opened,
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
  const command = readyGateCommand(results)
  const staged =
    stagedBody !== null && command !== null
      ? { ...stagedBody, body: withReadyTestCommand(stagedBody.body, command) }
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
 * that fails is recorded, not routed: the pull request's evidence check reads the block, and CI's one read sends the
 * Developer back if it is red.
 */
async function writeEvidenceFor(fns: V2Functions, pr: number, head: string): Promise<string | null> {
  if (!fns.writeEvidence) return null
  try {
    const written = await fns.writeEvidence({ pr, head })
    return written.ok ? 'written' : `not written: ${written.reason}`
  } catch (error) {
    return `not written: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** The test command the passed ready push ran (its selection, as the hook runs it), or null when it ran none. */
function readyGateCommand(results: Results): string | null {
  const ready = results['ready-push']
  if (!ready || !('stdout' in ready)) return null
  try {
    const selected = (JSON.parse(String(ready.stdout)) as { selection?: SelectionNote | null }).selection?.selected
    return selected && selected.length > 0 ? readyTestCommand(selected) : null
  } catch {
    return null
  }
}

const isTestRunLine = (line: string): boolean => /^(bun\s+)?test(\s|$)/.test(line.split('→')[0]?.trim() ?? '')

/**
 * The staged body with its Test Plan's test-run line set to `command`, the ready push's own: the Evidence write then
 * reuses that run, cached for the same head, instead of running the tests again. The first fenced block under the
 * Test Plan heading is the command list; its test-run lines become this one line, and every other command stays. A
 * body with no such block is returned unchanged.
 */
export function withReadyTestCommand(body: string, command: string): string {
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
  return [
    ...lines.slice(0, open + 1),
    `${command} → every selected test file passes`,
    ...kept,
    ...lines.slice(close)
  ].join('\n')
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
    `CI is red on pull request #${open.number} at ${head}. Failing check-run(s): ${ci.failingChecks.length > 0 ? ci.failingChecks.join(', ') : '(unknown)'}. Fix the failing check(s), commit, and publish the fix with publish_changes on this SAME branch — the pull request is open, so this push runs the selected tests.`,
    { ...ci, events }
  )
}

/** Records how the CI read routed; the decision on this step reads that step's own exit result. */
export function classifyCiResult(context: ActionContext): { exitCode: number; stdout: string } {
  const read = context.results['read-ci-once']
  if (!read) throw new Error('classify-ci-result ran before the CI read recorded a result')
  return ok(isSentBack(read) ? 'developer' : 'publish')
}

type V2Binding = {
  adapts: readonly ((...args: never[]) => unknown)[]
  build: (
    task: TaskInput
  ) => (context: ActionContext) => Promise<{ exitCode: number; stdout: string }> | { exitCode: number; stdout: string }
}

/** Version 2's action bindings, beside the shared ones (`ACTION_BINDINGS`) every flow binds. */
export const V2_ACTION_BINDINGS: Readonly<Record<string, V2Binding>> = {
  'vinaya.v2-local-checks': { adapts: [runCli], build: (task) => (context) => runLocalChecks(task, context) },
  'vinaya.v2-check-premise': { adapts: [checkPremiseAtHead], build: (task) => () => checkPremiseStaged(task) },
  'vinaya.v2-ready-push': { adapts: [], build: (task) => (context) => readyPush(task, context) },
  'vinaya.v2-classify-ready-push': { adapts: [], build: () => classifyReadyPush },
  'vinaya.v2-open-pull-request': { adapts: [], build: (task) => (context) => openPullRequestStep(task, context) },
  'vinaya.v2-classify-pr-opened': { adapts: [], build: () => classifyPullRequestOpened },
  'vinaya.v2-read-ci-once': { adapts: [readForgeCi], build: (task) => (context) => readCiOnce(task, context) },
  'vinaya.v2-classify-ci-result': { adapts: [], build: () => classifyCiResult }
}

/** Version 2's deciding steps, each read from the step it examines. */
export const V2_DECISIONS = {
  'classify-ready-push': isSentBack,
  'classify-pr-opened': isSentBack,
  'classify-ci-result': isSentBack
} as const

/** Version 2's action registry for one task. */
export function createV2Actions(task: TaskInput) {
  return Object.fromEntries(Object.entries(V2_ACTION_BINDINGS).map(([name, binding]) => [name, binding.build(task)]))
}
