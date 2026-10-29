import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { DevReviewLoopEventInput } from '@attalabs/aeg-core'
import { type DevToolContext, devToolError } from '../../../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { storagePushEvent } from '../../../../../apps/cli/src/lib/flow-v2-events'
import {
  FAILED_TESTS_RECORD,
  gitPath,
  readJsonUnderGit,
  readLastPushResult,
  removeUnderGit,
  SELECTION_NOTE,
  type SelectionNote
} from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import {
  containmentLogLine,
  identityOf,
  registerProcess,
  selectContainmentBackend,
  stopRegistered
} from '../../../../../apps/cli/src/lib/process-registry'
import { ADOPTER_TEST_RUNNER, NO_LOCAL_TESTS_MARKER } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import { PUSH_MODE_MARKER, storageMarkerText } from '../../../../../apps/cli/src/lib/pre-push-mode-logic'
import {
  DEFERRAL_MARKER_TTL_MS,
  deferralMarkerText,
  READY_DEFERRAL_MARKER,
  readDeferredTestsRecord,
  type ReadyTestsPolicy
} from '../../../../../apps/cli/src/lib/pre-push-ready-policy'
import { createTestTempRun, removeTestTempRun, sweepAbandoned } from '../../../../../apps/cli/src/lib/test-temp'
import {
  agentCommandEnv,
  buildReport,
  computeGroupA,
  computeGroupC,
  type DeferredGroupCDeps,
  defaultTestRunCache,
  lookupGreenRun,
  recordGreenTestRun,
  replaceEvidenceBlock,
  resolveCommandTimeoutMs,
  type TestRunCache,
  truncateAgentOutput
} from '../../../../../apps/cli/src/lib/pr-report-engine'
import { defaultReadDefaultBranchTip } from '../../../../../apps/cli/src/lib/dev-review-loop'
import { readPostedReviewVerdicts } from '../../../../../apps/cli/src/lib/review-gate-input'
import {
  type ExplicitCommandsResult,
  type ReadyGateResult,
  readyTestPlanCommand,
  type StagedPullRequest,
  type V2Functions
} from './v2-actions'
import { checkReadyBaseline } from './ready-baseline'
import { readRequiredCiLive } from './ci-recovery'

// The live wiring of review locally, push once (version 2 of the developer-review Flow) for the Engine runner: the
// staged pull request the Developer's `open_pull_request` saves, the storage-push marker its worktree's pre-push hook
// reads, the ready push (the hook run in its ready mode), and the opening of the pull request once both reviewers
// approved. Everything here is a thin shell over git, the hook and the Developer's own driver tools.

/** Where the run keeps the staged pull request: its run directory, never the repository. */
export const stagedPullRequestPath = (runDir: string): string => join(runDir, 'staged-pull-request.json')

/** The staged pull request, read and written as one small file. */
export function stagedPullRequestStore(runDir: string): {
  read: () => StagedPullRequest | null
  write: (staged: StagedPullRequest) => void
  gateResultPath: string
} {
  const path = stagedPullRequestPath(runDir)
  return {
    gateResultPath: join(runDir, 'ready-gate-result.json'),
    read: () => {
      try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StagedPullRequest>
        return typeof value.title === 'string' && typeof value.body === 'string'
          ? { title: value.title, body: value.body }
          : null
      } catch {
        return null
      }
    },
    write: (staged) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(staged)}\n`, { mode: 0o600 })
    }
  }
}

/**
 * Marks the worktree's pushes as this run's storage pushes. The marker names the run, its task branch and its
 * process: the hook honours it only on that branch while that process is alive (and confirms no pull request is
 * open), so a marker a crashed or finished run left behind never touches a later push.
 */
export function beginStoragePushes(worktreePath: string, run: { runId: string; branch: string; pid?: number }): void {
  const path = gitPath(worktreePath, PUSH_MODE_MARKER)
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, storageMarkerText({ runId: run.runId, branch: run.branch, pid: run.pid ?? process.pid }))
}

/** Ends storage pushes for the worktree: its pushes run the selected tests again. */
export function endStoragePushes(worktreePath: string): void {
  const path = gitPath(worktreePath, PUSH_MODE_MARKER)
  if (path) rmSync(path, { force: true })
}

/**
 * Asks the worktree's pre-push hook to defer this one push's selected tests to required CI: a short-lived marker
 * naming the run, its task branch, this driver's own process identity, and either the approved head (`ready`) or the
 * run's open pull request (`repair`). The hook honours it only while all of those still hold and the default branch
 * opts in (`pre-push-ready-policy.ts`). Returns false when this process's identity cannot be read: no marker is
 * written, and the push runs its tests.
 */
export function beginReadyDeferral(
  worktreePath: string,
  marker:
    | { kind: 'ready'; runId: string; branch: string; head: string }
    | {
        kind: 'repair'
        runId: string
        branch: string
        pr: number
      },
  now: () => number = () => Date.now()
): boolean {
  const path = gitPath(worktreePath, READY_DEFERRAL_MARKER)
  const driver = identityOf(process.pid)
  if (!path || driver === null) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    deferralMarkerText({ ...marker, driver, expiresAt: new Date(now() + DEFERRAL_MARKER_TTL_MS).toISOString() }),
    { mode: 0o600 }
  )
  return true
}

/** Removes the deferral marker: every publish removes it on its way out, and a starting run removes a stale one. */
export function endReadyDeferral(worktreePath: string): void {
  const path = gitPath(worktreePath, READY_DEFERRAL_MARKER)
  if (path) rmSync(path, { force: true })
}

/**
 * The Developer's driver tools in version 2. While no pull request is open, `publish_changes` is a storage push
 * (the worktree is marked before it pushes, and each push that lands is reported), `open_pull_request` saves the
 * title and body instead of opening, and `update_pull_request_body` replaces the saved body. Once a pull request is
 * open, every tool is the version 1 one.
 */
export function withV2DevTools(
  base: DevToolContext,
  options: {
    worktreePath: string
    /** The run the storage marker belongs to. */
    runId: string
    store: ReturnType<typeof stagedPullRequestStore>
    findOpenPullRequest: () => { number: number } | null
    onStoragePush: (head: string) => void
    /**
     * The local checks the round's gate runs (`check --all --local`, the staged body as the pull-request body):
     * `run_checks` runs these while no pull request is open, since the checks that need one cannot pass yet.
     */
    runLocalChecks?: (env: Record<string, string>) => { passed: boolean; output: string }
    branch: string
    /**
     * The body checks the pull request's opening will run, run when the body is staged: a body they refuse is
     * refused now, in the Developer's own turn, rather than after both reviewers approved.
     */
    validateBody?: (title: string, body: string) => Promise<{ ok: true } | { ok: false; reason: string }>
    /**
     * The trusted ready-tests policy (the default branch's `prePush.readyTests`): when it opts in, a publish on the
     * run's own open pull request is a driver-owned repair push, marked so the hook defers its selected tests to
     * required CI. A read that fails marks nothing, so the push runs its tests.
     */
    readyTestsPolicy?: () => ReadyTestsPolicy
    /** The read-only loop-baseline guard an opted-in repair push passes before any expensive hook work. */
    checkBaseline?: () => { ok: true } | { ok: false; reason: string }
  }
): DevToolContext {
  const openPr = (): { number: number } | null => {
    try {
      return options.findOpenPullRequest()
    } catch {
      return null
    }
  }
  const optedIn = (): boolean => {
    try {
      return options.readyTestsPolicy?.().mode === 'ci'
    } catch {
      return false
    }
  }
  return {
    ...base,
    publishChanges: async (header) => {
      const open = openPr()
      const storage = open === null
      if (storage) beginStoragePushes(options.worktreePath, { runId: options.runId, branch: options.branch })
      let repair = false
      if (!storage && optedIn()) {
        const baseline = options.checkBaseline?.() ?? { ok: true as const }
        if (!baseline.ok)
          return {
            ok: false,
            error: devToolError(
              'policy_refusal',
              'same_attempt',
              'not_started',
              'loop-baseline',
              baseline.reason,
              'Refresh the loop baseline with the named command, commit it, and call publish_changes again; nothing was pushed.'
            )
          }
        repair = beginReadyDeferral(options.worktreePath, {
          kind: 'repair',
          runId: options.runId,
          branch: options.branch,
          pr: open.number
        })
      }
      try {
        const result = await base.publishChanges(header)
        if (storage && result.ok) options.onStoragePush(result.result.pushedHead)
        return result
      } finally {
        if (repair) endReadyDeferral(options.worktreePath)
      }
    },
    openPullRequest: async (title, body) => {
      if (openPr() !== null) return base.openPullRequest(title, body)
      const validated = options.validateBody ? await options.validateBody(title, body) : { ok: true as const }
      if (!validated.ok) {
        return {
          ok: false,
          error: devToolError(
            'policy_refusal',
            'same_attempt',
            'not_started',
            'pr-body',
            `the staged pull-request body fails the checks its opening runs: ${validated.reason}`,
            'Fix the body and call open_pull_request again; nothing was saved.'
          )
        }
      }
      options.store.write({ title, body })
      return {
        ok: true,
        result: {
          staged: true,
          note: 'Saved. In this flow the pull request opens after both reviewers approve and the ready push passes; finish your turn.'
        } as unknown as { prNumber: number }
      }
    },
    runChecks: async () => {
      if (openPr() !== null || !options.runLocalChecks) return base.runChecks()
      const staged = options.store.read()
      const result = options.runLocalChecks({
        BRANCH: options.branch,
        ...(staged ? { PR_BODY: staged.body } : {})
      })
      return { ok: true, result }
    },
    updatePullRequestBody: async (body) => {
      if (openPr() !== null) return base.updatePullRequestBody(body)
      const staged = options.store.read()
      options.store.write({ title: staged?.title ?? '', body })
      return {
        ok: true,
        result: {
          staged: true,
          note: 'Saved; the driver opens the pull request with this body after approval.'
        } as unknown as {
          prNumber: number
        }
      }
    }
  }
}

/** What one asynchronous child reported. */
interface ChildRun {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** The error a cancelled ready gate rejects with: the step is interrupted, never recorded as a refusal. */
export class ReadyGateCancelledError extends Error {
  constructor() {
    super('the ready push was cancelled')
    this.name = 'ReadyGateCancelledError'
  }
}

/** A short git read as an awaited child, ended when `signal` aborts. */
function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ReadyGateCancelledError())
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.on('close', (status, sig) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) reject(new ReadyGateCancelledError())
      else resolve({ status, signal: sig, stdout, stderr })
    })
  })
}

const gitEnvOf = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return env
}

/** The worktree's pre-push hook: `core.hooksPath` when set (relative to the worktree), else the git hooks folder. */
export async function prePushHookPath(worktreePath: string, signal?: AbortSignal): Promise<string | null> {
  const configured = await runGit(['config', '--get', 'core.hooksPath'], worktreePath, gitEnvOf(), signal)
  const hooksPath = configured.status === 0 ? configured.stdout.trim() : ''
  const dir = hooksPath
    ? isAbsolute(hooksPath)
      ? hooksPath
      : join(worktreePath, hooksPath)
    : (gitPath(worktreePath, 'hooks') ?? join(worktreePath, '.git', 'hooks'))
  const hook = join(dir, 'pre-push')
  return existsSync(hook) ? hook : null
}

/** Twenty minutes: the ready push's default deadline, `reviewPolicy.readyPushTimeoutMinutes` when set. Past it the run is stopped and recorded as a timed-out refusal. */
export const READY_GATE_DEADLINE_MS = 20 * 60 * 1000

/** The selector's note when it describes `head`, else null (absent, unreadable, or left by another commit). */
function parseSelectionNote(text: string | null, head: string): SelectionNote | null {
  if (!text) return null
  try {
    const note = JSON.parse(text) as SelectionNote
    return note.head === head && Array.isArray(note.selected) ? note : null
  } catch {
    return null
  }
}

function startRealDeadline(fire: () => void, ms: number): () => void {
  const timer = setTimeout(fire, ms)
  return () => clearTimeout(timer)
}

/** How long a stopped test run gets between TERM and KILL. */
const STOP_GRACE_MS = 5000

/** The line the generated hook prints when the repository declares no test runner: the ready push ran no tests. */
export { NO_LOCAL_TESTS_MARKER }

/** What one supervised child reported. */
interface SupervisedRun {
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
  stdout: string
  stderr: string
  /** Why the run was stopped before it exited on its own, or null when it did. */
  interrupted: 'cancel' | 'deadline' | null
}

/**
 * Runs `argv` as an awaited child in its own process group, registered (and the registration acknowledged) before
 * it does any work. A cancel (`signal`) or the deadline stops the whole registered group and reports which; a child
 * that exits on its own still has any undetached descendants of its group stopped. A registration failure stops the
 * blocked shell and rethrows. Shared by the ready push's hook and the driver's explicit Test Plan commands, so both
 * phases are covered by the same deadline, cancellation and process-tree cleanup.
 */
async function superviseChild(input: {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written to the child's stdin once it is registered. */
  stdin?: string
  label: string
  runToken: string
  registry: { dir: string }
  register?: typeof registerProcess
  signal?: AbortSignal
  deadlineMs: number
  startDeadline?: (fire: () => void, ms: number) => () => void
}): Promise<SupervisedRun> {
  // The child waits for one acknowledgement line before it becomes the command, so no work starts unregistered.
  const child = spawn('sh', ['-c', 'IFS= read -r _vinaya_ack || exit 1; exec "$0" "$@"', ...input.argv], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdin?.on('error', () => {})
  const exited = new Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.on('error', (error) => resolve({ status: null, signal: null, error }))
    child.on('close', (code, sig) => resolve({ status: code, signal: sig }))
  })
  const leaderExited = new Promise<void>((resolve) => {
    child.on('error', () => resolve())
    child.on('exit', () => resolve())
  })
  const stop = async () => {
    await stopRegistered(input.runToken, { graceMs: STOP_GRACE_MS, ...input.registry })
  }
  let interrupted: 'cancel' | 'deadline' | null = null
  let cancelDeadline: (() => void) | undefined
  const interruption = new Promise<'cancel' | 'deadline'>((resolve) => {
    cancelDeadline = (input.startDeadline ?? startRealDeadline)(() => resolve('deadline'), input.deadlineMs)
    if (input.signal?.aborted) resolve('cancel')
    input.signal?.addEventListener('abort', () => resolve('cancel'), { once: true })
  })
  try {
    const identity = child.pid !== undefined ? identityOf(child.pid) : null
    if (child.pid !== undefined && identity !== null) {
      await (input.register ?? registerProcess)(
        { ...identity, runToken: input.runToken, label: input.label, processGroup: true },
        input.registry
      )
      child.stdin?.write('ack\n')
      child.stdin?.end(input.stdin ?? '')
    } else {
      child.stdin?.end()
    }
    const outcome = await Promise.race([exited, interruption])
    if (typeof outcome === 'string') {
      interrupted = outcome
      await stop()
      // A detached, unregistered descendant may still own a pipe. It cannot extend this run's deadline.
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      await leaderExited
    }
    // A finished child can leave undetached descendants in its group: they stop with the run.
    await stop()
    if (interrupted !== null) return { status: null, signal: null, stdout, stderr, interrupted }
    const run = await exited
    return { ...run, stdout, stderr, interrupted: null }
  } catch (error) {
    // Registration can fail before the acknowledgement: the blocked shell still belongs to this driver.
    child.stdin?.destroy()
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
    try {
      await leaderExited
      await stop()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${input.label} failed and process cleanup also failed`)
    } finally {
      clearTimeout(killTimer)
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    throw error
  } finally {
    cancelDeadline?.()
  }
}

/** Why the worktree is not exactly `head` with nothing uncommitted, or null when it is. */
async function worktreeDrift(worktreePath: string, head: string, signal?: AbortSignal): Promise<string | null> {
  const gitEnv = gitEnvOf()
  const actualHead = await runGit(['rev-parse', 'HEAD'], worktreePath, gitEnv, signal)
  const status = await runGit(['status', '--porcelain'], worktreePath, gitEnv, signal)
  return actualHead.status !== 0 || actualHead.stdout.trim() !== head
    ? `the worktree head is ${actualHead.stdout.trim() || 'unreadable'}, not the approved head ${head}`
    : status.status !== 0
      ? 'the worktree status could not be read'
      : status.stdout.trim() !== ''
        ? `the worktree holds uncommitted changes:\n${status.stdout.trim()}`
        : null
}

/** A fresh, owned temp run for one supervised phase: its folder, token and process registry. */
async function openSupervisedRun(registryDir: string | undefined) {
  await sweepReadyGateRuns()
  const ownedRun = createTestTempRun('ready-gates')
  const runToken = ownedRun.marker.owner.runToken
  const runTemp = ownedRun.dir
  writeFileSync(
    join(runTemp, 'registry.json'),
    JSON.stringify({ token: runToken, ...(registryDir ? { external: registryDir } : {}) }),
    { mode: 0o600 }
  )
  return { ownedRun, runToken, runTemp, registry: { dir: registryDir ?? join(runTemp, 'registry') } }
}

/**
 * The ready push: the worktree's own pre-push hook, run in its ready mode on the approved head with the default
 * branch as its base (storage pushes already moved the branch's upstream there). The approved head is already on
 * the remote, so the hook is run as the push would run it — with the push's own ref line on its stdin — rather
 * than through a push that has nothing left to send. The hook's last-push record says what it selected and what
 * failed.
 *
 * The hook runs as an awaited child in its own process group, registered (and the registration acknowledged)
 * before it does any work, with its own temp folder. A cancel (`signal`) stops the group, removes the folder and
 * rejects with `ReadyGateCancelledError`; the deadline stops it the same way and records a timed-out refusal, and
 * clears the failed-tests record, since a stopped run left no complete one: the next ready push runs its full
 * selection.
 *
 * With `deferTests` (the default branch opts in), the driver marks this push for deferral first; the hook then runs
 * every cheap gate and defers the selected tests to required CI, recording that for this head and run. What the
 * hook did is read from fresh, head- and run-bound records, never from its printed output: a deferred-tests record
 * for this head and run is `deferred`; a last-push record the hook wrote for this head during this run is an
 * executed (or empty) selection; a repository with no pre-push hook, or a hook that wrote no record in a repository
 * declaring no test runner, is the `no-local-tests` state, logged rather than passed silently.
 */
export async function runReadyGateLive(input: {
  worktreePath: string
  branch: string
  head: string
  remoteHead: string | null
  defaultBranch?: string
  now?: () => number
  signal?: AbortSignal
  deadlineMs?: number
  /** Starts the deadline: calls `fire` after `ms` and returns its canceller. A test fakes the clock through it. */
  startDeadline?: (fire: () => void, ms: number) => () => void
  log?: (line: string) => void
  /** The registry folder for the run's processes (the default registry when absent). */
  registryDir?: string
  /** Durable registration boundary, injectable for storage-failure tests. */
  register?: typeof registerProcess
  /** Asks the hook to defer the selected tests to required CI (the trusted policy opts in). */
  deferTests?: boolean
  /** The run the deferral marker and its record belong to. */
  runId?: string
}): Promise<ReadyGateResult> {
  const now = input.now ?? (() => Date.now())
  const log = input.log ?? (() => {})
  // The hook runs on the working tree, so the tree must be exactly the approved commit: same head, nothing uncommitted.
  const drift = await worktreeDrift(input.worktreePath, input.head, input.signal)
  if (drift !== null) {
    log(`ready push failed: all; refused before the hook ran: ${drift.split('\n')[0]}`)
    return { passed: false, output: `ready push refused: ${drift}`, selection: null, failed: 'all', wallMs: 0 }
  }
  const hook = await prePushHookPath(input.worktreePath, input.signal)
  if (hook === null) {
    log(`ready push: ${NO_LOCAL_TESTS_MARKER} (the repository has no pre-push hook)`)
    return {
      passed: true,
      output: `${NO_LOCAL_TESTS_MARKER}: the repository has no pre-push hook`,
      selection: null,
      failed: [],
      wallMs: 0,
      localTests: 'none'
    }
  }
  const backend = selectContainmentBackend()
  log(`ready push: ${containmentLogLine(backend)}`)
  const { ownedRun, runToken, runTemp, registry } = await openSupervisedRun(input.registryDir)
  const started = now()
  const runId = input.runId ?? 'ready-push'
  const baseline: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'LANG', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'BUN_INSTALL_CACHE_DIR']) {
    if (process.env[key] !== undefined) baseline[key] = process.env[key]
  }
  const env: NodeJS.ProcessEnv = {
    ...baseline,
    TMPDIR: runTemp,
    VINAYA_TEST_TMP: join(runTemp, 'fixtures'),
    VINAYA_PROCESS_REGISTRY_DIR: join(runTemp, 'processes'),
    VINAYA_PUSH_MODE: 'ready',
    VINAYA_PUSH_BASE: `origin/${input.defaultBranch ?? 'main'}`
  }
  const ref = `refs/heads/${input.branch}`
  const marked =
    input.deferTests === true &&
    beginReadyDeferral(input.worktreePath, { kind: 'ready', runId, branch: input.branch, head: input.head }, now)
  if (input.deferTests === true && !marked)
    log('ready push: the deferral marker could not be written; the tests run locally')
  try {
    const run = await superviseChild({
      argv: ['sh', hook, 'origin', 'origin'],
      cwd: input.worktreePath,
      env,
      stdin: `${ref} ${input.head} ${ref} ${input.remoteHead ?? '0000000000000000000000000000000000000000'}\n`,
      label: 'ready-gate pre-push hook',
      runToken,
      registry,
      ...(input.register ? { register: input.register } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      deadlineMs: input.deadlineMs ?? READY_GATE_DEADLINE_MS,
      ...(input.startDeadline ? { startDeadline: input.startDeadline } : {})
    })
    if (run.interrupted === 'cancel') throw new ReadyGateCancelledError()
    const wallMs = Math.max(0, now() - started)
    if (run.interrupted === 'deadline') {
      removeUnderGit(input.worktreePath, FAILED_TESTS_RECORD)
      const minutes = Math.round((input.deadlineMs ?? READY_GATE_DEADLINE_MS) / 60000)
      log(`ready push: timed out after ${minutes} min; the test run was stopped`)
      log(`ready push failed: all; wall time ${wallMs} ms`)
      // The selector writes its note before the tests start, so a stopped run still says how many files it selected.
      const note = parseSelectionNote(readJsonUnderGit(input.worktreePath, SELECTION_NOTE), input.head)
      return {
        passed: false,
        output: `${run.stdout}${run.stderr}\nthe ready push timed out after ${minutes} min and was stopped; the next ready push runs its full selection`,
        selection: null,
        failed: 'all',
        wallMs,
        timedOut: true,
        limitMinutes: minutes,
        ...(note ? { selectedCount: note.selected.length } : {})
      }
    }
    const output = `${run.stdout}${run.stderr}${run.error ? `\n${run.error.message}` : ''}${run.signal ? `\nthe ready push was stopped by ${run.signal}` : ''}`
    const passed = run.status === 0
    const deferred = marked ? readDeferredTestsRecord(input.worktreePath, { head: input.head, runId }) : null
    if (passed && deferred !== null && deferred.kind === 'ready') {
      log(`ready push: local checks passed; the selected tests are deferred to the required check ${deferred.check}`)
      return {
        passed: true,
        output,
        selection: null,
        failed: [],
        wallMs,
        localTests: 'deferred',
        requiredCi: { workflow: deferred.workflow, check: deferred.check }
      }
    }
    const record = readLastPushResult(input.worktreePath)
    const forHead = record !== null && record.head === input.head
    const fresh = forHead && (run.status === 0 || record.outcome === 'failed')
    const failed = passed ? [] : fresh ? record.failed : 'all'
    if (!passed) log(`ready push failed: ${failed === 'all' ? 'all' : failed.join(', ')}; wall time ${wallMs} ms`)
    // No runner is decided by structured facts first: a hook that ran a selection wrote its last-push record for
    // this head, so that record rules the state out whatever the output says — a marker line a nested test's own
    // fixture printed during a real run never stands for it. Only with no such record, and no declared test runner
    // in the repository, does the hook's own marker line (a line of its own, never a substring) name the state.
    const markerLine = output.split('\n').some((line) => line.startsWith(NO_LOCAL_TESTS_MARKER))
    const noLocalTests =
      passed && !forHead && markerLine && !isExecutable(join(input.worktreePath, ADOPTER_TEST_RUNNER))
    if (noLocalTests) log(`ready push: ${NO_LOCAL_TESTS_MARKER} (the repository declares no test runner)`)
    return {
      passed,
      output,
      selection: fresh ? record.selection : null,
      failed,
      wallMs,
      ...(noLocalTests ? { localTests: 'none' as const } : {})
    }
  } finally {
    if (marked) endReadyDeferral(input.worktreePath)
    cleanupReadyGateStorage(ownedRun)
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The approved explicit Test Plan commands, run by the driver outside the worker sandbox on the exact head being
 * published, one after another in their Test Plan order, through the report engine's own receipts: a command that
 * already holds a genuine green receipt at this head and tree is reused, never re-run; any other runs under the
 * report engine's environment and per-command limit, bounded by what is left of the ready push's deadline, in its
 * own registered process group, and records a receipt when it passes. The first failure, timeout, or a head or tree
 * that changed underneath, stops the phase. A cancel rejects with `ReadyGateCancelledError`.
 */
export async function runExplicitCommandsLive(input: {
  worktreePath: string
  head: string
  branch: string
  body: string
  commands: readonly string[]
  /** The ready push's own deadline, as an absolute time on `now`'s clock. */
  deadlineAt: number
  now?: () => number
  signal?: AbortSignal
  startDeadline?: (fire: () => void, ms: number) => () => void
  registryDir?: string
  register?: typeof registerProcess
  cache?: TestRunCache
  commandTimeoutMs?: number
  log?: (line: string) => void
}): Promise<ExplicitCommandsResult> {
  const now = input.now ?? (() => Date.now())
  const log = input.log ?? (() => {})
  const cache = input.cache ?? defaultTestRunCache()
  const started = now()
  const results: ExplicitCommandsResult['results'] = []
  const finish = (
    outcome: ExplicitCommandsResult['outcome'],
    extra: { detail?: string } = {}
  ): ExplicitCommandsResult => ({ outcome, results, wallMs: Math.max(0, now() - started), ...extra })
  if (input.commands.length === 0) return finish('passed')
  const drift = await worktreeDrift(input.worktreePath, input.head, input.signal)
  if (drift !== null) return finish('drift', { detail: drift })
  for (const command of input.commands) {
    if (input.signal?.aborted) throw new ReadyGateCancelledError()
    const reused = await lookupGreenRun(command, input.worktreePath, cache)
    if (reused) {
      results.push({ command, outcome: 'passed', output: reused.output, reusedFrom: reused.reusedFrom ?? 'a receipt' })
      log(`ready push: explicit command reused its receipt: ${command}`)
      continue
    }
    const remaining = input.deadlineAt - now()
    if (remaining <= 0) {
      results.push({ command, outcome: 'timed-out', output: 'the ready push deadline passed before this command ran' })
      return finish('timed-out')
    }
    const limit = Math.min(input.commandTimeoutMs ?? resolveCommandTimeoutMs(), remaining)
    const { ownedRun, runToken, registry } = await openSupervisedRun(input.registryDir)
    const commandStarted = now()
    try {
      const run = await superviseChild({
        argv: ['bash', '-c', command],
        cwd: input.worktreePath,
        env: agentCommandEnv({ PR_BODY: input.body, BRANCH: input.branch }),
        label: 'ready-gate explicit command',
        runToken,
        registry,
        ...(input.register ? { register: input.register } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        deadlineMs: limit,
        ...(input.startDeadline ? { startDeadline: input.startDeadline } : {})
      })
      if (run.interrupted === 'cancel') throw new ReadyGateCancelledError()
      const output = truncateAgentOutput(`${run.stdout}${run.stderr}`.trim())
      const wallMs = Math.max(0, now() - commandStarted)
      if (run.interrupted === 'deadline') {
        results.push({ command, outcome: 'timed-out', output, wallMs, limitMs: limit })
        log(`ready push: explicit command timed out after ${limit} ms: ${command}`)
        return finish('timed-out')
      }
      if (run.status !== 0) {
        results.push({ command, outcome: 'failed', output, wallMs, exitCode: run.status })
        log(`ready push: explicit command failed (exit ${run.status ?? 'none'}): ${command}`)
        return finish('failed')
      }
      // Only a genuine pass at this exact head and tree becomes a receipt.
      const after = await worktreeDrift(input.worktreePath, input.head, input.signal)
      if (after !== null) return finish('drift', { detail: after })
      await recordGreenTestRun(command, output, input.worktreePath, 'pr-report', cache)
      results.push({ command, outcome: 'passed', output, wallMs })
      log(`ready push: explicit command passed in ${wallMs} ms: ${command}`)
    } finally {
      cleanupReadyGateStorage(ownedRun)
    }
  }
  return finish('passed')
}

function cleanupReadyGateStorage(run: Parameters<typeof removeTestTempRun>[0]): void {
  const report = removeTestTempRun(run)
  if (report.failed.length) throw new Error(`ready gate storage cleanup failed: ${JSON.stringify(report.failed)}`)
}

/** Reaps abandoned ready gates before removing their owned storage. */
export async function sweepReadyGateRuns(): Promise<void> {
  const report = await sweepAbandoned('ready-gates', {
    stop: (token, opts, directory) => {
      const metadata = join(directory, 'registry.json')
      const recorded = existsSync(metadata)
        ? (JSON.parse(readFileSync(metadata, 'utf8')) as { token: string; external?: string })
        : null
      if (recorded !== null && recorded.token !== token) throw new Error('ready gate registry ownership disagrees')
      return stopRegistered(token, { ...opts, dir: recorded?.external ?? join(directory, 'registry') })
    }
  })
  if (report.failed.length) throw new Error(`ready gate recovery cleanup failed: ${JSON.stringify(report.failed)}`)
}

/** Version 2's live functions for one task. */
export function liveV2Functions(input: {
  worktreePath: string
  branch: string
  store: ReturnType<typeof stagedPullRequestStore>
  findOpenPullRequest: () => { number: number } | null
  remoteHead: () => string | null
  /** The Developer's own `open_pull_request` (version 1's), which opens through the forge behind its body checks. */
  openWithDeveloperTool: (title: string, body: string) => ReturnType<DevToolContext['openPullRequest']>
  /** Writes the open pull request's Evidence block for the head the ready push passed. */
  writeEvidence?: V2Functions['writeEvidence']
  /** The ready push's test-run limit in milliseconds, read from the review policy; `READY_GATE_DEADLINE_MS` when absent. */
  readyPushDeadlineMs?: () => number
  /** The ready push's deadline timer, for a test that fakes the clock. */
  startDeadline?: (fire: () => void, ms: number) => () => void
  /** A line for the driver's log: the containment backend, the no-local-tests state, a timeout, an Evidence failure. */
  log?: (line: string) => void
  /** The repository's URL the default branch's tip is read and fetched from, or null when the run names none. */
  remoteUrl?: string | null
  /** The run the ready push's deferral marker and record belong to. */
  runId?: string
  /** The default branch's ready-tests policy; throws when the trusted read fails. */
  readyTestsPolicy?: () => ReadyTestsPolicy
  /** The repository root the loop baseline is read from (this repository's own scenario corpus). */
  baselineRoot?: string
}): V2Functions {
  // A marker an earlier run (a crash, a stop) left in this worktree is never reused.
  endReadyDeferral(input.worktreePath)
  return {
    runReadyGate: async ({ head, signal, deferTests }) => {
      const gate = await runReadyGateLive({
        worktreePath: input.worktreePath,
        branch: input.branch,
        head,
        remoteHead: input.remoteHead(),
        ...(signal ? { signal } : {}),
        ...(input.readyPushDeadlineMs ? { deadlineMs: input.readyPushDeadlineMs() } : {}),
        ...(input.startDeadline ? { startDeadline: input.startDeadline } : {}),
        ...(input.log ? { log: input.log } : {}),
        ...(deferTests ? { deferTests: true } : {}),
        ...(input.runId ? { runId: input.runId } : {})
      })
      const path = input.store.gateResultPath
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify({ head, gate }), { mode: 0o600 })
      renameSync(temporary, path)
      return gate
    },
    stagedPullRequest: input.store.read,
    findOpenPullRequest: input.findOpenPullRequest,
    openPullRequest: async (staged) => {
      const opened = await input.openWithDeveloperTool(staged.title, staged.body)
      if (opened.ok) return { ok: true, pr: opened.result.prNumber }
      const error = opened.error as { message?: string; code?: string } | undefined
      return { ok: false, reason: error?.message ?? error?.code ?? JSON.stringify(opened.error) }
    },
    endStoragePushes: () => endStoragePushes(input.worktreePath),
    readMainTip: () => readFetchedMainTip(input.worktreePath, input.remoteUrl ?? null),
    // The approvals a conflict re-entry starts from: the Principal-authored verdicts the gate itself reads.
    readPostedVerdicts: (pr) => readPostedReviewVerdicts(pr),
    ...(input.readyTestsPolicy ? { readyTestsPolicy: input.readyTestsPolicy } : {}),
    checkReadyBaseline: () => checkReadyBaseline(input.baselineRoot ?? input.worktreePath),
    ...(input.readyPushDeadlineMs ? { readyDeadlineMs: input.readyPushDeadlineMs } : {}),
    runExplicitCommands: ({ head, body, commands, signal, deadlineAt }) =>
      runExplicitCommandsLive({
        worktreePath: input.worktreePath,
        branch: input.branch,
        head,
        body,
        commands,
        deadlineAt,
        ...(signal ? { signal } : {}),
        ...(input.startDeadline ? { startDeadline: input.startDeadline } : {}),
        ...(input.log ? { log: input.log } : {})
      }),
    readRequiredCi: (request) => readRequiredCiLive(request),
    ...(input.log ? { log: input.log } : {}),
    ...(input.writeEvidence ? { writeEvidence: input.writeEvidence } : {})
  }
}

/**
 * The default branch's tip as the remote reports it, made present in the task worktree's object store: fetched from
 * the driver-built `remoteUrl`, never through the worktree's own `origin`, and used only under the hash the remote
 * reported. Null when the tip cannot be read or fetched.
 */
export function readFetchedMainTip(worktreePath: string, remoteUrl: string | null): string | null {
  if (remoteUrl === null) return null
  const tip = defaultReadDefaultBranchTip(remoteUrl)
  if (tip === null) return null
  const present = () =>
    spawnSync('git', ['cat-file', '-e', `${tip}^{commit}`], { cwd: worktreePath, stdio: 'ignore' }).status === 0
  if (present()) return tip
  spawnSync('git', ['fetch', '-q', remoteUrl, 'refs/heads/main'], {
    cwd: worktreePath,
    stdio: 'ignore',
    timeout: 120_000
  })
  return present() ? tip : null
}

/** Composes evidence only from the completed gate record; never executes body commands. */
export async function readyGateEvidence(input: {
  body: string
  head: string
  resultPath: string
  worktreePath: string
  /** Where the driver's receipts are read; the repository's own test-run cache when absent. */
  cache?: TestRunCache
  /** The deferred-head reads, for a test that injects them. */
  deferral?: DeferredGroupCDeps
}): Promise<string> {
  const record = JSON.parse(readFileSync(input.resultPath, 'utf8')) as { head: string; gate: ReadyGateResult }
  if (record.head !== input.head || record.gate?.passed !== true)
    throw new Error('no successful ready-gate result for the approved head')
  const groupA = await computeGroupA(input.worktreePath)
  if (groupA.head !== input.head) throw new Error('worktree changed after the ready gate')
  const gate = record.gate
  if (gate.localTests === 'deferred') {
    // Deferred: the required-CI line reports pending and every other command reuses the receipt the driver recorded
    // at the publication boundary; the report engine refuses rather than execute anything.
    const report = await buildReport({
      cwd: input.worktreePath,
      body: input.body,
      groupA,
      gradedBodySource: 'push',
      gateRunner: () => ({ failed: false, outcomes: [{ name: 'ready-gate', status: 'pass', errors: [] }] }),
      groupC: await computeGroupC(
        input.body,
        input.worktreePath,
        {},
        input.cache ?? defaultTestRunCache(),
        input.deferral
      )
    })
    return replaceEvidenceBlock(input.body, report.blockInner)
  }
  const none = gate.localTests === 'none' || gate.selection?.selected.length === 0
  const report = await buildReport({
    cwd: input.worktreePath,
    body: input.body,
    groupA,
    gradedBodySource: 'push',
    gateRunner: () => ({ failed: false, outcomes: [{ name: 'ready-gate', status: 'pass', errors: [] }] }),
    groupC: {
      commands: [
        {
          command: none
            ? 'no local tests'
            : gate.selection
              ? readyTestPlanCommand(gate.selection.selected, input.worktreePath)
              : 'repository pre-push hook',
          // The same tail every other Test Plan command keeps: a whole run's output would overflow the body.
          output: truncateAgentOutput(none ? `No local tests ran.\n${gate.output}` : gate.output),
          exitCode: 0,
          timedOut: false,
          overflowed: false,
          // The head sits in a code span: the note renders as prose, where the body gate refuses a bare digit.
          reusedFrom: `persisted ready-gate result at \`${input.head}\``
        }
      ]
    }
  })
  return replaceEvidenceBlock(input.body, report.blockInner)
}

/** The `storage_push` Log event for one landed storage push. */
export function storagePushLogEvent(
  loopId: string,
  round: number,
  branch: string,
  head: string
): DevReviewLoopEventInput {
  return storagePushEvent({ loopId, round }, branch, head)
}
