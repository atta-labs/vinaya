import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { DevReviewLoopEventInput } from '@attalabs/aeg-core'
import { type DevToolContext, devToolError } from '../../../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { storagePushEvent } from '../../../../../apps/cli/src/lib/flow-v2-events'
import {
  FAILED_TESTS_RECORD,
  gitPath,
  readLastPushResult,
  removeUnderGit
} from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import {
  containmentLogLine,
  identityOf,
  registerProcess,
  selectContainmentBackend,
  stopRegistered
} from '../../../../../apps/cli/src/lib/process-registry'
import { NO_LOCAL_TESTS_MARKER } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import { PUSH_MODE_MARKER, storageMarkerText } from '../../../../../apps/cli/src/lib/pre-push-mode-logic'
import { createTestTempRun, removeTestTempRun, sweepAbandoned } from '../../../../../apps/cli/src/lib/test-temp'
import { buildReport, computeGroupA, replaceEvidenceBlock } from '../../../../../apps/cli/src/lib/pr-report-engine'
import { readyTestCommand } from '../../../../../apps/cli/src/lib/pre-push-test-runner'
import type { ReadyGateResult, StagedPullRequest, V2Functions } from './v2-actions'

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
  }
): DevToolContext {
  const openPr = (): { number: number } | null => {
    try {
      return options.findOpenPullRequest()
    } catch {
      return null
    }
  }
  return {
    ...base,
    publishChanges: async (header) => {
      const storage = openPr() === null
      if (storage) beginStoragePushes(options.worktreePath, { runId: options.runId, branch: options.branch })
      const result = await base.publishChanges(header)
      if (storage && result.ok) options.onStoragePush(result.result.pushedHead)
      return result
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

/** Twenty minutes: the ready push's deadline. Past it the run is stopped and recorded as a timed-out refusal. */
export const READY_GATE_DEADLINE_MS = 20 * 60 * 1000

/** How long a stopped test run gets between TERM and KILL. */
const STOP_GRACE_MS = 5000

/** The line the generated hook prints when the repository declares no test runner: the ready push ran no tests. */
export { NO_LOCAL_TESTS_MARKER }

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
 * selection. A repository with no pre-push hook, or one whose hook runs no tests, is the `no-local-tests` state,
 * logged rather than passed silently.
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
  log?: (line: string) => void
  /** The registry folder for the run's processes (the default registry when absent). */
  registryDir?: string
  /** Durable registration boundary, injectable for storage-failure tests. */
  register?: typeof registerProcess
}): Promise<ReadyGateResult> {
  const now = input.now ?? (() => Date.now())
  const log = input.log ?? (() => {})
  // The hook runs on the working tree, so the tree must be exactly the approved commit: same head, nothing uncommitted.
  const gitEnv = gitEnvOf()
  const actualHead = await runGit(['rev-parse', 'HEAD'], input.worktreePath, gitEnv, input.signal)
  const status = await runGit(['status', '--porcelain'], input.worktreePath, gitEnv, input.signal)
  const drift =
    actualHead.status !== 0 || actualHead.stdout.trim() !== input.head
      ? `the worktree head is ${actualHead.stdout.trim() || 'unreadable'}, not the approved head ${input.head}`
      : status.status !== 0
        ? 'the worktree status could not be read'
        : status.stdout.trim() !== ''
          ? `the worktree holds uncommitted changes:\n${status.stdout.trim()}`
          : null
  if (drift !== null)
    return { passed: false, output: `ready push refused: ${drift}`, selection: null, failed: 'all', wallMs: 0 }
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
  await sweepReadyGateRuns()
  const ownedRun = createTestTempRun('ready-gates')
  const runToken = ownedRun.marker.owner.runToken
  const runTemp = ownedRun.dir
  const registry = { dir: input.registryDir ?? join(runTemp, 'registry') }
  writeFileSync(
    join(runTemp, 'registry.json'),
    JSON.stringify({ token: runToken, ...(input.registryDir ? { external: input.registryDir } : {}) }),
    { mode: 0o600 }
  )
  const started = now()
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
  // The child waits for one acknowledgement line before it becomes the hook, so no work starts unregistered.
  const child = spawn('sh', ['-c', 'IFS= read -r _vinaya_ack || exit 1; exec sh "$0" "$@"', hook, 'origin', 'origin'], {
    cwd: input.worktreePath,
    env,
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
    await stopRegistered(runToken, { graceMs: STOP_GRACE_MS, ...registry })
  }
  let interrupted: 'cancel' | 'deadline' | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const interruption = new Promise<'cancel' | 'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), input.deadlineMs ?? READY_GATE_DEADLINE_MS)
    if (input.signal?.aborted) resolve('cancel')
    input.signal?.addEventListener('abort', () => resolve('cancel'), { once: true })
  })
  try {
    const identity = child.pid !== undefined ? identityOf(child.pid) : null
    if (child.pid !== undefined && identity !== null) {
      await (input.register ?? registerProcess)(
        { ...identity, runToken, label: 'ready-gate pre-push hook', processGroup: true },
        registry
      )
      child.stdin?.write('ack\n')
      child.stdin?.end(
        `${ref} ${input.head} ${ref} ${input.remoteHead ?? '0000000000000000000000000000000000000000'}\n`
      )
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
    // A finished hook can leave undetached descendants in its group: they stop with the run.
    await stop()
    if (interrupted === 'cancel') throw new ReadyGateCancelledError()
    const wallMs = Math.max(0, now() - started)
    if (interrupted === 'deadline') {
      removeUnderGit(input.worktreePath, FAILED_TESTS_RECORD)
      const minutes = Math.round((input.deadlineMs ?? READY_GATE_DEADLINE_MS) / 60000)
      log(`ready push: timed out after ${minutes} min; the test run was stopped`)
      log(`ready push failed: all; wall time ${wallMs} ms`)
      return {
        passed: false,
        output: `${stdout}${stderr}\nthe ready push timed out after ${minutes} min and was stopped; the next ready push runs its full selection`,
        selection: null,
        failed: 'all',
        wallMs,
        timedOut: true
      }
    }
    const run = (await exited) as { status: number | null; signal: NodeJS.Signals | null; error?: Error }
    const output = `${stdout}${stderr}${run.error ? `\n${run.error.message}` : ''}${run.signal ? `\nthe ready push was stopped by ${run.signal}` : ''}`
    const record = readLastPushResult(input.worktreePath)
    const fresh = record !== null && record.head === input.head && (run.status === 0 || record.outcome === 'failed')
    const passed = run.status === 0
    const failed = passed ? [] : fresh ? record.failed : 'all'
    if (!passed) log(`ready push failed: ${failed === 'all' ? 'all' : failed.join(', ')}; wall time ${wallMs} ms`)
    const noLocalTests = passed && output.includes(NO_LOCAL_TESTS_MARKER)
    if (noLocalTests) log(`ready push: ${NO_LOCAL_TESTS_MARKER} (the repository declares no test runner)`)
    return {
      passed,
      output,
      selection: fresh ? record.selection : null,
      failed,
      wallMs,
      ...(noLocalTests ? { localTests: 'none' as const } : {})
    }
  } catch (error) {
    // Registration can fail before the acknowledgement: the blocked shell still belongs to this driver.
    child.stdin?.destroy()
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
    try {
      await leaderExited
      await stop()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'ready gate failed and process cleanup also failed')
    } finally {
      clearTimeout(killTimer)
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    cleanupReadyGateStorage(ownedRun)
  }
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
  /** A line for the driver's log: the containment backend, the no-local-tests state, a timeout. */
  log?: (line: string) => void
}): V2Functions {
  return {
    runReadyGate: async ({ head, signal }) => {
      const gate = await runReadyGateLive({
        worktreePath: input.worktreePath,
        branch: input.branch,
        head,
        remoteHead: input.remoteHead(),
        ...(signal ? { signal } : {}),
        ...(input.log ? { log: input.log } : {})
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
    ...(input.writeEvidence ? { writeEvidence: input.writeEvidence } : {})
  }
}

/** Composes evidence only from the completed gate record; never executes body commands. */
export async function readyGateEvidence(input: {
  body: string
  head: string
  resultPath: string
  worktreePath: string
}): Promise<string> {
  const record = JSON.parse(readFileSync(input.resultPath, 'utf8')) as { head: string; gate: ReadyGateResult }
  if (record.head !== input.head || record.gate?.passed !== true)
    throw new Error('no successful ready-gate result for the approved head')
  const groupA = await computeGroupA(input.worktreePath)
  if (groupA.head !== input.head) throw new Error('worktree changed after the ready gate')
  const gate = record.gate
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
              ? readyTestCommand(gate.selection.selected)
              : 'repository pre-push hook',
          output: none ? `No local tests ran.\n${gate.output}` : gate.output,
          exitCode: 0,
          timedOut: false,
          overflowed: false,
          reusedFrom: `persisted ready-gate result at ${input.head}`
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
