/**
 * The real handler behind the catalog's `task_resume` binding. It never
 * re-derives or re-consumes a decision itself: it reads the SAME durable
 * records `dev-review-loop --resume` already reads (the pause state, the
 * durable `EscalationRecord`, a `ResolutionRecord` if one already exists,
 * the driver lock), requires a CURRENT Principal ruling read fresh from the
 * run's own PR (never a caller-supplied approval — no free-text approved
 * boolean, the Operator never creates a ruling), and — once every check
 * passes — triggers the existing `vinaya dev-review-loop --resume <pr>`
 * continuation exactly as a human typing that command would. The actual
 * authenticated consumption (`resolveEscalation`) happens inside THAT
 * continuation, unchanged; this handler never calls it itself, so there is
 * no double-consumption risk between a peek here and the real write there.
 *
 * "No new worker": an idempotent, escalation-scoped claim (mirroring
 * `start.ts`'s own request-identity claim) and a driver-lock liveness check
 * both gate the launch, so the same paused escalation is never handed to two
 * concurrent continuations. "No retry loop": this handler attempts the
 * launch exactly once and returns — every round/retry decision after that is
 * the existing loop's own, never a second layer built here.
 *
 * O1: this call reports a failed start only for a continuation whose process
 * has EXITED before the run was confirmed — never for one that is merely
 * still coming up. It waits, bounded, for the same driver-lock observable
 * `task_start` confirms against (`start.ts`'s own header), on a shorter wait
 * than `task_start`'s own since `--resume` carries no preparation step of its
 * own to size the wait for; a continuation still alive when that wait ends is
 * reported `outcome: 'started'` exactly as a confirmed one is, and KEEPS its
 * claim, so a repeat call replays it rather than handing the same escalation
 * to a second continuation. Only an exited continuation is a failed start,
 * carrying its own captured stderr, and only then is the claim released so an
 * identical retry launches again.
 * O3: a claim old enough that its own launch must already have concluded,
 * naming a task the driver-lock gate just above already proved has no live
 * driver and whose own launched process is gone too, is superseded —
 * released and re-claimed — so this call launches again rather than replaying
 * `'already_resumed'` forever.
 */

import { spawn } from 'node:child_process'
import { closeSync, ftruncateSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type ControlStoreDeps,
  defaultControlStoreDeps,
  type OperationResult,
  readResolution,
  TaskResumeInputSchema,
  taskToolError,
  type TaskResumeResult,
  type TaskToolRef
} from '@attalabs/aeg-core'
import { type AgentVendor, isAgentVendor } from '../dispatch.js'
import {
  fetchNewestRulingAuthor,
  fetchNewestRulingOrdinal,
  fetchRulings
} from '../dev-review-loop/developer-dispatch.js'
import {
  escalationIdFor,
  isDriverPidAlive,
  readDriverLock,
  readEscalationRecord,
  readPauseState
} from '../dev-review-loop/pause-resume.js'
import { runtimeDir } from '../dev-review-loop.js'
import { newestPublishedRound } from '../task-status.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo, tasksExecutionRoot } from '../run-paths.js'
import { taskFromEscalationId } from '../dev-review-loop/pause-resume.js'
import { log } from '../log-sink.js'
import type { TaskToolCallResult } from './handlers.js'
import { resolveIssueForRef } from './handlers.js'
import { readEscalationPacket } from './read.js'
import type { CallerContext } from './server.js'

function ok<T>(result: T): TaskToolCallResult<T> {
  return { ok: true, result }
}

function fail<T>(error: ReturnType<typeof taskToolError>): TaskToolCallResult<T> {
  return { ok: false, error }
}

// --- idempotent launch claim, keyed by escalation identity ------------------

/** The durable claim one `task_resume` request writes before it launches — keyed by `escalationId`, so the SAME paused escalation is never handed to two continuations, no matter how many times a caller (or a genuine retry) asks. */
export type ResumeRecord = {
  escalationId: string
  caller: string
  pr: number
  startedAt: string
  /** The pid of the continuation this claim's own launch spawned, recorded once that launch is known alive — the one liveness signal that exists before its driver lock does, so a continuation still coming up is never mistaken for a dead claim and superseded (`start.ts`'s own `StartRecord.pid`). */
  pid?: number
}

export type ResumeClaimStore = {
  claim: (record: ResumeRecord) => { claimed: boolean; record: ResumeRecord }
  /** Rewrites a record this caller already claimed — how a launch's own child pid joins the claim it was launched under. Never creates a claim. */
  update: (record: ResumeRecord) => void
  release: (escalationId: string) => void
}

/**
 * The durable resume claim, in the task folder of the escalation it
 * resolves: `.../<task>/control/resume-claim-<escalationId>.json`. A
 * resolution is a control-plane record, so it sits beside the escalation
 * record it answers rather than in a flat machine-wide directory where one
 * task's claim sat next to every other task's.
 *
 * An id that carries no task falls back to the unscoped folder — the same
 * folder the scope grammar already reserves for a run file with no
 * resolvable task, never a directory of this module's own.
 */
function resumeRecordPath(escalationId: string): string {
  const task = taskFromEscalationId(escalationId)
  return runPath(runtimeDirForThisRepo(), task ?? 'unscoped', {
    area: 'control',
    file: `resume-claim-${escalationId}.json`
  })
}

export const defaultResumeClaimStore: ResumeClaimStore = {
  claim(record) {
    const path = resumeRecordPath(record.escalationId)
    try {
      ensureRunDir(dirname(path), runtimeDirForThisRepo())
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      return { claimed: true, record }
    } catch {
      try {
        const existing = JSON.parse(readFileSync(path, 'utf8')) as ResumeRecord
        return { claimed: false, record: existing }
      } catch {
        return { claimed: false, record }
      }
    }
  },
  update(record) {
    const path = resumeRecordPath(record.escalationId)
    try {
      // `r+` writes only an EXISTING file: an update never conjures a claim
      // nobody holds, and never undoes a release that raced it.
      const fd = openSync(path, 'r+')
      try {
        const body = `${JSON.stringify(record, null, 2)}\n`
        writeFileSync(fd, body)
        ftruncateSync(fd, Buffer.byteLength(body))
      } finally {
        closeSync(fd)
      }
    } catch {
      // Best-effort — a pid that fails to land only costs the supersede path
      // its extra liveness signal, it never starts a continuation twice.
    }
  },
  release(escalationId) {
    try {
      rmSync(resumeRecordPath(escalationId), { force: true })
    } catch {
      // ignore — a stale record only ever refuses a retry, never starts twice.
    }
  }
}

// --- O3: a claim old enough that its own launch must have concluded --------

/**
 * `defaultResumeLaunch`'s own bounded confirm-wait, below, plus a margin —
 * shorter than `task_start`'s own (`start.ts`'s `START_STALE_CLAIM_GRACE_MS`),
 * since `--resume` carries no preparation step to size a longer wait for.
 * A record still younger than this can only be one call's own launch still
 * in flight — its driver lock may simply not have been written yet, and it
 * is not thereby dead (Traps to avoid: idempotency against a live run is the
 * point).
 */
export const RESUME_CONFIRM_TIMEOUT_MS = 10_000
const RESUME_CONFIRM_POLL_MS = 250
export const RESUME_STALE_CLAIM_GRACE_MS = RESUME_CONFIRM_TIMEOUT_MS + 10_000

function claimIsStale(record: ResumeRecord, now: () => string): boolean {
  const startedAt = Date.parse(record.startedAt)
  const current = Date.parse(now())
  return Number.isFinite(startedAt) && Number.isFinite(current) && current - startedAt > RESUME_STALE_CLAIM_GRACE_MS
}

// --- default detached launcher (the existing continuation), confirmed on the driver lock ------------------

/** Reuses `task_start`'s own resolvable-launcher override — this task's launch is a DIFFERENT existing command (`dev-review-loop --resume`, not `task run`), not a second launcher mechanism. */
export const RESUME_COMMAND_ENV = 'VINAYA_TASK_RUN_COMMAND'

function readCapturedStderr(path: string): string {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    return raw ? ` — captured stderr:\n${raw}` : ''
  } catch {
    return ''
  }
}

/** What launching a continuation and waiting for its own confirmation produced — the same three outcomes `start.ts`'s own `LaunchResult` carries: the driver lock appeared (`confirmed`), the bounded wait ended with the process still alive (`starting` — a started run, never a failure), or the process exited or never spawned (`exited` — the only failed start). `pid` is the launched child's own, recorded on the claim. */
export type LaunchResult =
  | { status: 'confirmed'; pid: number | null }
  | { status: 'starting'; pid: number | null }
  | { status: 'exited'; error: Error }

/**
 * Races the spawned child's own `error`/`exit` against the task's driver
 * lock appearing and naming a live pid — never a sleep-then-assume. Whichever
 * happens first decides the outcome; the loser's listeners/timers are torn
 * down so this never resolves twice, and the wait merely running out is the
 * third outcome (`starting`), not a failure. Identical in shape to `start.ts`'s own
 * `waitForLiveDriver` — kept as a sibling copy rather than a shared import
 * across two files this task's Surface keeps independently modifiable
 * (`Conflicts-with: 8` on this exact file).
 */
function waitForLiveDriver(
  child: ReturnType<typeof spawn>,
  root: string,
  task: number,
  stderrPath: string,
  timeoutMs: number,
  pollMs: number
): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let settled = false
    const finishAlive = (status: 'confirmed' | 'starting') => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      child.removeAllListeners('error')
      child.removeAllListeners('exit')
      // Alive and must outlive this server — unref only now, never before
      // the race is decided, so a premature exit is still observed.
      child.unref()
      resolve({ status, pid: child.pid ?? null })
    }
    const finishDead = (reason: string) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      resolve({ status: 'exited', error: new Error(`${reason}${readCapturedStderr(stderrPath)}`) })
    }
    child.on('error', (err) => finishDead(`spawn failed: ${err instanceof Error ? err.message : String(err)}`))
    child.on('exit', (code, signal) =>
      finishDead(
        `process exited before its driver confirmed alive (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      )
    )
    const poll = setInterval(() => {
      const lock = readDriverLock(root, task)
      if (lock && isDriverPidAlive(lock.pid)) finishAlive('confirmed')
    }, pollMs)
    // The wait running out decides nothing about the run: the child is still
    // alive (its own `exit` would have won this race otherwise), so this is a
    // continuation still coming up, not a failed start.
    const timer = setTimeout(() => finishAlive('starting'), timeoutMs)
  })
}

/**
 * `root` defaults to the SAME resolution `devReviewLoop` itself uses but is
 * overridable so a test can point the confirm-wait at a temporary tree
 * (`defaultTaskResumeDeps.launch` never overrides it).
 */
export function defaultResumeLaunch(
  target: { pr: number; agent: AgentVendor; issue: number },
  meta: { escalationId: string; caller: string },
  root: string = runtimeDir()
): Promise<LaunchResult> {
  const program = process.env[RESUME_COMMAND_ENV]?.trim() || 'vinaya'
  const stderrPath = runPath(root, target.issue, {
    area: 'output',
    file: `task-resume-${meta.escalationId}.stderr.log`
  })
  ensureRunDir(dirname(stderrPath), root)
  const stderrFd = openSync(stderrPath, 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(program, ['dev-review-loop', '--resume', String(target.pr), '--agent', target.agent], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd]
    })
  } finally {
    // Spawn dup's the fd into the child; our own copy is safe to close
    // immediately, whether spawn succeeded or threw synchronously.
    closeSync(stderrFd)
  }
  return waitForLiveDriver(child, root, target.issue, stderrPath, RESUME_CONFIRM_TIMEOUT_MS, RESUME_CONFIRM_POLL_MS)
}

// --- deps ---------------------------------------------------------------------

export type TaskResumeDeps = {
  runtimeDir: () => string
  resolveIssueForRef: (ref: TaskToolRef) => number | null
  fetchRulings: (pr: number) => string[]
  fetchNewestRulingAuthor: (pr: number) => string | null
  fetchNewestRulingOrdinal: (pr: number) => number
  store: ResumeClaimStore
  /** Is this pid still running? Asked of the pid a claim's own launch recorded — the one liveness signal that exists before a driver lock does. */
  isPidAlive: (pid: number) => boolean
  /**
   * Starts the continuation detached and resolves once its own driver lock
   * confirms it alive, or it exits/errors first, or the bounded wait ends with
   * the process still alive (O1) — see this file's own header.
   */
  launch: (
    target: { pr: number; agent: AgentVendor; issue: number },
    meta: { escalationId: string; caller: string }
  ) => Promise<LaunchResult>
  now: () => string
  /** The Vinaya Log chokepoint (`log-sink.ts`) — injectable so a fixture can capture the typed `operation` event this handler emits without touching the real, machine-global outbox. */
  log: typeof log
}

export const defaultTaskResumeDeps: TaskResumeDeps = {
  runtimeDir,
  resolveIssueForRef,
  fetchRulings,
  fetchNewestRulingAuthor,
  fetchNewestRulingOrdinal,
  store: defaultResumeClaimStore,
  isPidAlive: isDriverPidAlive,
  launch: defaultResumeLaunch,
  now: () => new Date().toISOString(),
  log
}

/**
 * `log()` fills `subject.issue` from `process.env.VINAYA_TASK`, never from an
 * argument (`log-sink.ts`), so this event lands under the outbox for `task`
 * — the one this handler is actually acting on — only if `VINAYA_TASK` is
 * set for the duration of the call, exactly the save/restore-around-one-call
 * discipline `log-flush.ts`'s `logForFlush` and `dev-review-loop.ts`'s
 * `cancelDevReviewLoop` already use. Without this, every `task_resume` event
 * emitted by the shared, multi-tenant `vinaya task-tools serve` MCP server
 * (`server.ts`) — not just a concurrent one — misfiles into whatever task
 * (or none) the process's ambient env happened to carry (round 2 review,
 * HIGH).
 */
function emitOperationEvent(
  emit: typeof log,
  task: number,
  target: string,
  result: OperationResult,
  errorClass: string | null
): void {
  const prevTask = process.env.VINAYA_TASK
  process.env.VINAYA_TASK = String(task)
  try {
    emit({
      kind: 'operation',
      event: 'completed',
      operation: 'task_resume',
      target,
      result,
      error_class: errorClass,
      payload: {}
    })
  } finally {
    if (prevTask === undefined) delete process.env.VINAYA_TASK
    else process.env.VINAYA_TASK = prevTask
  }
}

// --- the handler ---------------------------------------------------------------

export function createTaskResumeHandler(
  deps: TaskResumeDeps = defaultTaskResumeDeps
): (input: unknown, ctx: CallerContext) => Promise<TaskToolCallResult<TaskResumeResult>> {
  return async (input, ctx) => {
    const parsed = TaskResumeInputSchema.safeParse(input)
    if (!parsed.success) {
      return fail(taskToolError('validation', parsed.error.issues[0]?.message ?? 'invalid input'))
    }

    if (!ctx.caller) {
      return fail(
        taskToolError(
          'authority',
          'task_resume requires an authenticated caller from the invocation context; none was present.'
        )
      )
    }
    const caller = ctx.caller

    const issue = deps.resolveIssueForRef(parsed.data.task)
    if (issue === null) {
      return fail(taskToolError('precondition', 'no open task matches this reference'))
    }
    const target = `task:${issue}`

    const root = deps.runtimeDir()
    // The SAME control-store-root-from-outbox-root derivation `read.ts`'s own
    // `readEscalationPacket` uses internally — never the real global default,
    // so a fixture's injected `runtimeDir` fully isolates both reads.
    const controlStoreDeps: ControlStoreDeps = defaultControlStoreDeps(() => tasksExecutionRoot(root))
    const packet = readEscalationPacket(root, issue)
    if (packet === null) {
      // O2: a run that published its verdicts and holds no pause is a
      // finished run, not a broken one — name the round it published at (the
      // same shared reader `task_status`/`deriveLoopState` derive `published`
      // from) rather than the generic "no paused run" refusal an Operator
      // reading it would mistake for a task that never ran.
      const published = newestPublishedRound(root, issue)
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(
        taskToolError(
          'precondition',
          published !== null
            ? `task ${issue}'s run already published at round ${published} and holds no pause — nothing to resume`
            : `task ${issue} has no paused run recorded — nothing to resume`
        )
      )
    }
    if (packet.inputs === null || packet.inputs.prNumber === null) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(
        taskToolError('precondition', `task ${issue}'s pause carries no PR yet — resume it with \`vinaya task run\``)
      )
    }
    if (packet.freshness === 'stale') {
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(
        taskToolError('precondition', `task ${issue}'s pause has already been superseded by a published round`)
      )
    }

    const pr = packet.inputs.prNumber
    const held = readPauseState(root, issue)
    if (held === null) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(taskToolError('precondition', `task ${issue} has no paused run recorded — nothing to resume`))
    }
    const escalationId = held.escalationId ?? escalationIdFor(issue, held.round, held.head)

    const resolutionRead = readResolution(controlStoreDeps, issue, escalationId)
    const existingResolution = resolutionRead.status === 'ok' ? resolutionRead.value : null
    if (existingResolution) {
      if (existingResolution.decision === 'cancel') {
        emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
        return fail(
          taskToolError(
            'precondition',
            `task ${issue}'s escalation '${escalationId}' was already resolved as 'cancel', not 'resume'`
          )
        )
      }
      emitOperationEvent(deps.log, issue, target, 'ok', null)
      return ok({
        task: issue,
        pr,
        escalationId,
        outcome: 'already_resumed',
        authenticatedBy: existingResolution.authenticatedBy,
        authenticatedFrom: existingResolution.authenticatedFrom
      })
    }

    const escalation = readEscalationRecord(issue, escalationId, controlStoreDeps)
    if (escalation === null) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(
        taskToolError(
          'precondition',
          `task ${issue}'s escalation '${escalationId}' has no durable record — cannot authenticate a resume`
        )
      )
    }
    if (escalation.pr !== pr) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(
        taskToolError(
          'precondition',
          `task ${issue}'s escalation '${escalationId}' names PR ${escalation.pr ?? '(none)'}, not PR ${pr}`
        )
      )
    }

    const lock = readDriverLock(root, issue)
    if (lock && isDriverPidAlive(lock.pid)) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(
        taskToolError(
          'precondition',
          `task ${issue} already has a driver running (pid ${lock.pid}) — refusing to start a second worker`
        )
      )
    }

    // Unlike `dev-review-loop --resume`'s own bare-command allowance for a
    // fresh `'infrastructure'` pause, the Operator's tool always requires a
    // real, freshly-read Principal ruling — reconnecting the conversation
    // (or calling this tool at all) never implies resume authorization
    // (Traps to avoid). A driver hitting an infrastructure hiccup is still
    // resumable through `vinaya dev-review-loop --resume` directly; this is
    // a deliberately narrower, more conservative gate for the Operator path.
    //
    // Security review, round 3, MEDIUM: `rulings.length > 0` alone only
    // proves SOME principal ruling exists on this PR at some point in its
    // history — never that it says anything about THIS escalation. A ruling
    // left over from an earlier, already-addressed round would satisfy that
    // check forever after, letting a stale approval authenticate a resume it
    // never spoke to. `escalation.rulingOrdinal` is the ruling ordinal this
    // pause was ALREADY raised under (the same "input version a round was
    // judged against" `ManifestRecord`/`compareManifest` bind a verdict to);
    // a ruling that authorizes resuming THIS pause must postdate that — its
    // ordinal must have moved, exactly the inequality `compareManifest`'s own
    // `binding.rulingOrdinal` already checks for "a new ruling landed."
    const rulings = deps.fetchRulings(pr)
    const newestRulingOrdinal = deps.fetchNewestRulingOrdinal(pr)
    if (rulings.length === 0 || newestRulingOrdinal <= escalation.rulingOrdinal) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'authority')
      return fail(
        taskToolError(
          'authority',
          rulings.length === 0
            ? `PR ${pr} carries no Principal ruling comment yet — nothing authenticates this resume`
            : `PR ${pr}'s newest ruling (ordinal ${newestRulingOrdinal}) is no newer than the ruling this escalation was already raised under (ordinal ${escalation.rulingOrdinal}) — nothing new authenticates resuming this pause`
        )
      )
    }
    const authenticatedBy = deps.fetchNewestRulingAuthor(pr) ?? 'unknown-principal'
    const authenticatedFrom = `${pr}-${newestRulingOrdinal}`

    const agent: AgentVendor = escalation.agent && isAgentVendor(escalation.agent) ? escalation.agent : 'claude'

    const buildRecord = (): ResumeRecord => ({ escalationId, caller: caller.id, pr, startedAt: deps.now() })
    let claim = deps.store.claim(buildRecord())

    // O3: a claim old enough that its own launch must already have
    // concluded, naming a task the driver-lock gate above already proved
    // has no live driver, is dead — superseded rather than replayed as
    // `'already_resumed'` forever. A claim still within its own confirm
    // window is left alone: it may simply not have written its driver lock
    // yet, and the gate above already refused the genuinely-alive case.
    if (!claim.claimed && claimIsStale(claim.record, deps.now)) {
      // The process that claim's own launch spawned, asked on its own: a
      // continuation still coming up has no driver lock yet and a live pid
      // saying so, and superseding it would hand one escalation to a second
      // continuation (O2).
      const launchedPid = claim.record.pid
      if (launchedPid === undefined || !deps.isPidAlive(launchedPid)) {
        deps.store.release(claim.record.escalationId)
        claim = deps.store.claim(buildRecord())
      }
    }

    if (!claim.claimed) {
      emitOperationEvent(deps.log, issue, target, 'ok', null)
      return ok({ task: issue, pr, escalationId, outcome: 'already_resumed', authenticatedBy, authenticatedFrom })
    }

    let outcome: LaunchResult
    try {
      outcome = await deps.launch({ pr, agent, issue }, { escalationId, caller: caller.id })
    } catch (err) {
      deps.store.release(escalationId)
      emitOperationEvent(deps.log, issue, target, 'error', 'infrastructure')
      return fail(taskToolError('infrastructure', `task_resume could not launch the run: ${(err as Error).message}`))
    }
    if (outcome.status === 'exited') {
      // The ONLY failed start: the launched process is gone. Release the claim
      // so an identical retry, once the underlying problem is fixed, launches
      // again instead of replaying a start that never happened. A wait that
      // merely ran out never reaches here — the continuation is alive.
      deps.store.release(escalationId)
      emitOperationEvent(deps.log, issue, target, 'error', 'infrastructure')
      return fail(
        taskToolError(
          'infrastructure',
          `task_resume: task ${issue} (PR ${pr}) did not confirm alive: ${outcome.error.message}`,
          outcome.error.message
        )
      )
    }

    // Alive — confirmed, or still starting. Either way the claim STAYS, and
    // the launched pid joins it so a later call can re-check liveness against
    // the process itself while its driver lock is still unwritten.
    if (outcome.pid !== null) deps.store.update({ ...claim.record, pid: outcome.pid })

    emitOperationEvent(deps.log, issue, target, 'ok', null)
    return ok({ task: issue, pr, escalationId, outcome: 'started', authenticatedBy, authenticatedFrom })
  }
}

/** The default `task_resume` handler the server binds. */
export const defaultTaskResumeHandler = createTaskResumeHandler()
