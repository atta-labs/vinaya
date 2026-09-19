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
 */

import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
export type ResumeRecord = { escalationId: string; caller: string; pr: number; startedAt: string }

export type ResumeClaimStore = {
  claim: (record: ResumeRecord) => { claimed: boolean; record: ResumeRecord }
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
      ensureRunDir(dirname(path))
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
  release(escalationId) {
    try {
      rmSync(resumeRecordPath(escalationId), { force: true })
    } catch {
      // ignore — a stale record only ever refuses a retry, never starts twice.
    }
  }
}

// --- default detached launcher (the existing continuation) ------------------

/** Reuses `task_start`'s own resolvable-launcher override — this task's launch is a DIFFERENT existing command (`dev-review-loop --resume`, not `task run`), not a second launcher mechanism. */
export const RESUME_COMMAND_ENV = 'VINAYA_TASK_RUN_COMMAND'

export function defaultResumeLaunch(
  target: { pr: number; agent: AgentVendor },
  _meta: { escalationId: string; caller: string },
  onAsyncFailure: (err: Error) => void
): void {
  const program = process.env[RESUME_COMMAND_ENV]?.trim() || 'vinaya'
  const child = spawn(program, ['dev-review-loop', '--resume', String(target.pr), '--agent', target.agent], {
    detached: true,
    stdio: 'ignore'
  })
  child.on('error', (err) => onAsyncFailure(err instanceof Error ? err : new Error(String(err))))
  child.unref()
}

// --- deps ---------------------------------------------------------------------

export type TaskResumeDeps = {
  runtimeDir: () => string
  resolveIssueForRef: (ref: TaskToolRef) => number | null
  fetchRulings: (pr: number) => string[]
  fetchNewestRulingAuthor: (pr: number) => string | null
  fetchNewestRulingOrdinal: (pr: number) => number
  store: ResumeClaimStore
  launch: (
    target: { pr: number; agent: AgentVendor },
    meta: { escalationId: string; caller: string },
    onAsyncFailure: (err: Error) => void
  ) => void
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
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(taskToolError('precondition', `task ${issue} has no paused run recorded — nothing to resume`))
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

    const claim = deps.store.claim({ escalationId, caller: ctx.caller.id, pr, startedAt: deps.now() })
    if (!claim.claimed) {
      emitOperationEvent(deps.log, issue, target, 'ok', null)
      return ok({ task: issue, pr, escalationId, outcome: 'already_resumed', authenticatedBy, authenticatedFrom })
    }

    try {
      deps.launch({ pr, agent }, { escalationId, caller: ctx.caller.id }, (err) => {
        try {
          deps.store.release(escalationId)
        } catch {
          // best-effort
        }
        console.error(`task_resume: task ${issue} (PR ${pr}) failed to launch: ${err.message}`)
      })
    } catch (err) {
      deps.store.release(escalationId)
      emitOperationEvent(deps.log, issue, target, 'error', 'infrastructure')
      return fail(taskToolError('infrastructure', `task_resume could not launch the run: ${(err as Error).message}`))
    }

    emitOperationEvent(deps.log, issue, target, 'ok', null)
    return ok({ task: issue, pr, escalationId, outcome: 'started', authenticatedBy, authenticatedFrom })
  }
}

/** The default `task_resume` handler the server binds. */
export const defaultTaskResumeHandler = createTaskResumeHandler()
