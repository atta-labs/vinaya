import type { ActionContext } from '../../../../../harness/dev-process/engine-runtime/run-process'
import { runCli } from '../../../../../harness/gates/run-checks'
import {
  ciResultReadEvent,
  failedTestsRerunEvent,
  prOpenedEvent,
  readyPushEvent
} from '../../../../../apps/cli/src/lib/flow-v2-events'
import { discardHeldVerdicts } from '../../../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { checkPremiseAtHead, fetchFailingCheckRuns } from '../../../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import {
  MAX_FAILURE_EXCERPT_CHARS,
  MAX_FAILURE_EXCERPT_TOTAL_CHARS,
  readFailedCheckExcerpt,
  renderFailureExcerpt,
  sanitizeForgeText
} from '../../../../../apps/cli/src/lib/task-tools/pr-facts'
import type { SelectionNote } from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import { manifestDigest } from '../../../../../apps/cli/src/lib/review-result'
import { readyTestCommand } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import { readUnpushedWorkDetail } from '../../../../../apps/cli/src/lib/dev-review-loop/unpushed-work'
import { spawnSync } from 'node:child_process'
import { assessRound, type DevReviewLoopEventInput, type PauseReason } from '@attalabs/aeg-core'
import {
  fetchConflictingFiles,
  fetchMergeableState,
  parseMergeTreeConflictFiles,
  pollMergeableState
} from '../../../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { findOpenPrForBranch } from '../../../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import {
  BACK,
  carriedLoopState,
  CONFLICT_REPAIR_PROVEN,
  createActions,
  dispatchedManifest,
  EXIT_CONFLICT_REENTRY,
  EXIT_NO_OPEN_PR,
  EXIT_OPEN_PR,
  FORWARD,
  gatePollOf,
  isSentBack,
  latestRecord,
  NO_COUNTERS,
  ok,
  owedConflictRepair,
  pauseThrough,
  readAssessment,
  readForgeCi,
  recordedDispatch,
  recordOutput,
  safeRead,
  type SendBack,
  startReviewRound,
  type TaskInput,
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
  /** One failed job's failure-naming log lines, at most `max` characters: null when its log cannot be read. Live: the full-log reader. */
  readCheckExcerpt?: (jobId: number, max: number) => string | null
  /** Milliseconds since an arbitrary origin, for the time a step spends. */
  now?: () => number
  /**
   * The default branch's tip, fetched by the controller into the task worktree's object store, or null when it cannot
   * be read. A conflict's repair is proven against it, so a tip that cannot be read proves no repair.
   */
  readMainTip?: () => string | null
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
    `both reviewers approved ${head}, but the ready push refused it: ${gate.timedOut ? 'the selected tests ran past the deadline' : 'the selected tests failed'}.\n\n${failingTestLines(gate)}\n\nThe ready push runs the selected test files on the approved head through the repository's pre-push hook in ready mode, with a 20-minute deadline. Run the named failing files before publishing your fix; when the files are unknown, run the full selection.`,
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
    `CI is red on pull request #${open.number} at ${head}. Failing check-run(s): ${ci.failingChecks.length > 0 ? ci.failingChecks.join(', ') : '(unknown)'}. Fix the failing check(s), commit, and publish the fix with publish_changes on this SAME branch — the pull request is open, so this push runs the selected tests.${failureExcerptsOnHead(task, fns, head)}`,
    { ...ci, events }
  )
}

/**
 * The failure lines of each failed job on `head`, rendered for the send-back prompt under the check's name. A job's log
 * is read only for a check that failed (a failed workflow run is no job, so it has none), each excerpt is bounded and
 * the total is too; a log that cannot be read keeps its check's name and says so.
 */
function failureExcerptsOnHead(task: TaskInput, fns: V2Functions, head: string): string {
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
 * the conflict turn, before any local check or reviewer. The record is checkpointed with the step: a restart neither
 * repeats nor skips it.
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
  if (mergeable !== 'CONFLICTING') return { exitCode: EXIT_OPEN_PR, stdout: JSON.stringify(open) }
  const { results } = context
  const files = (task.bound?.fetchConflictingFiles ?? fetchConflictingFiles)('main', task.branch)
  const mainTip = safeRead(v2Of(task).readMainTip)
  const sendBack: SendBack = {
    kind: 'conflict',
    headBefore: safeRead(task.remoteHead) ?? worktreeHeadOf(task),
    files,
    mainTip
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
    const open = safeRead(fns.findOpenPullRequest)
    if (open !== null) {
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
  if (failure === null)
    return {
      exitCode: FORWARD,
      stdout: recordOutput(results, state, {
        ...fields,
        counters: { ...counters, stallCheck: null },
        decision: { type: CONFLICT_REPAIR_PROVEN }
      })
    }
  const sendBack: SendBack = {
    kind: 'conflict',
    headBefore: remote ?? head,
    files: failure.files.length > 0 ? failure.files : (owed.files ?? []),
    mainTip: freshTip ?? owed.mainTip ?? null,
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
    adapts: [findOpenPrForBranch, pollMergeableState, fetchConflictingFiles],
    build: (task) => (context) => reconcileExternalState(task, context)
  },
  'vinaya.v2-prove-conflict-repair': {
    adapts: [pollMergeableState, fetchConflictingFiles, assessRound],
    build: (task) => (context) => proveConflictRepair(task, context)
  },
  'vinaya.v2-classify-conflict-repair': { adapts: [], build: () => classifyConflictRepair },
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
  'classify-conflict-repair': isSentBack,
  'classify-ready-push': isSentBack,
  'classify-pr-opened': isSentBack,
  'classify-ci-result': isSentBack
} as const

/** Version 2's action registry for one task. */
export function createV2Actions(task: TaskInput) {
  return Object.fromEntries(Object.entries(V2_ACTION_BINDINGS).map(([name, binding]) => [name, binding.build(task)]))
}
