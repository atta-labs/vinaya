/**
 * The real handler behind the catalog's `task_cancel` binding. It delegates
 * the entire authenticated consumption to the EXISTING `cancelDevReviewLoop`
 * (`dev-review-loop.ts`) unchanged: authentication from a fresh Principal
 * ruling read off the run's own PR, `resolveEscalation`'s wrong-target/
 * stale/replayed refusals, in-flight-role termination, and fencing every
 * still-`'started'` effect as `'uncertain'`. This handler's own job is
 * translating that into the catalog's typed result: resolving the caller's
 * `TaskToolRef` to a PR, classifying the outcome as `'confirmed'`,
 * `'pending'` (the run's own driver was on a different host, so THIS call
 * cannot itself confirm the process stopped) or `'uncertain'` (an effect
 * could not be confirmed and was fenced instead), and reporting the same
 * truthful outcome again — never an error — when a repeat call finds the
 * escalation already cancelled.
 */

import { hostname as osHostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type ControlStoreDeps,
  defaultControlStoreDeps,
  type OperationResult,
  readResolution,
  TaskCancelInputSchema,
  type TaskCancelOutcome,
  type TaskCancelResult,
  taskToolError,
  type TaskToolRef
} from '@attalabs/aeg-core'
import { type AgentVendor, isAgentVendor } from '../dispatch.js'
import { cancelDevReviewLoop, type CancelResult, outboxRoot } from '../dev-review-loop.js'
import { fetchNewestRulingOrdinal, fetchRulings } from '../dev-review-loop/developer-dispatch.js'
import { appendRoleLine, loopLogPathFor } from '../loop-log.js'
import {
  escalationIdFor,
  readEscalationRecord,
  readPauseState,
  ReplayedResolutionError,
  StaleEscalationError,
  WrongTargetResolutionError
} from '../dev-review-loop/pause-resume.js'
import { log } from '../log-sink.js'
import { resolveIssueForRef, type TaskToolCallResult } from './handlers.js'
import { readEscalationPacket } from './read.js'
import type { CallerContext } from './server.js'

function ok<T>(result: T): TaskToolCallResult<T> {
  return { ok: true, result }
}

function fail<T>(error: ReturnType<typeof taskToolError>): TaskToolCallResult<T> {
  return { ok: false, error }
}

export type TaskCancelDeps = {
  outboxRoot: () => string
  resolveIssueForRef: (ref: TaskToolRef) => number | null
  fetchRulings: (pr: number) => string[]
  fetchNewestRulingOrdinal: (pr: number) => number
  cancelDevReviewLoop: (input: { cancelPr: number; agent: AgentVendor }) => Promise<CancelResult>
  hostname: () => string
  /** The Vinaya Log chokepoint (`log-sink.ts`) — injectable so a fixture can capture the typed `operation` event this handler emits without touching the real, machine-global outbox. */
  log: typeof log
}

export const defaultTaskCancelDeps: TaskCancelDeps = {
  outboxRoot,
  resolveIssueForRef,
  fetchRulings,
  fetchNewestRulingOrdinal,
  cancelDevReviewLoop: (input) => cancelDevReviewLoop(input),
  hostname: osHostname,
  log
}

/**
 * `log()` fills `subject.issue` from `process.env.VINAYA_TASK`, never from an
 * argument (`log-sink.ts`), so this event lands under the outbox for `task`
 * — the one this handler is actually acting on — only if `VINAYA_TASK` is
 * set for the duration of the call, exactly the save/restore-around-one-call
 * discipline `log-flush.ts`'s `logForFlush` and this same handler's own
 * `cancelDevReviewLoop` call already use. Without this, every `task_cancel`
 * event emitted by the shared, multi-tenant `vinaya task-tools serve` MCP
 * server (`server.ts`) — not just a concurrent one — misfiles into whatever
 * task (or none) the process's ambient env happened to carry (round 2
 * review, HIGH).
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
      operation: 'task_cancel',
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

export function createTaskCancelHandler(
  deps: TaskCancelDeps = defaultTaskCancelDeps
): (input: unknown, ctx: CallerContext) => Promise<TaskToolCallResult<TaskCancelResult>> {
  return async (input, ctx) => {
    const parsed = TaskCancelInputSchema.safeParse(input)
    if (!parsed.success) {
      return fail(taskToolError('validation', parsed.error.issues[0]?.message ?? 'invalid input'))
    }

    if (!ctx.caller) {
      return fail(
        taskToolError(
          'authority',
          'task_cancel requires an authenticated caller from the invocation context; none was present.'
        )
      )
    }

    const issue = deps.resolveIssueForRef(parsed.data.task)
    if (issue === null) {
      return fail(taskToolError('precondition', 'no open task matches this reference'))
    }
    const target = `task:${issue}`

    const root = deps.outboxRoot()
    // Same control-store-root-from-outbox-root derivation `resume.ts` and
    // `read.ts`'s own `readEscalationPacket` use — never the real global
    // default, so a fixture's injected `outboxRoot` fully isolates every read.
    const controlStoreDeps: ControlStoreDeps = defaultControlStoreDeps(() => join(dirname(root), 'control-store'))
    const packet = readEscalationPacket(root, issue)
    if (packet === null || packet.inputs === null || packet.inputs.prNumber === null) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
      return fail(taskToolError('precondition', `task ${issue} has no paused run with a PR — nothing to cancel`))
    }
    const pr = packet.inputs.prNumber

    const held = readPauseState(root, issue)
    const escalationId = held?.escalationId ?? escalationIdFor(issue, packet.inputs.round, packet.inputs.head)
    const peekedEscalation = readEscalationRecord(issue, escalationId, controlStoreDeps)

    // Security review, round 3, MEDIUM (the same defect as `resume.ts`'s
    // identical gate): `rulings.length > 0` alone only proves SOME principal
    // ruling exists on this PR, ever — never that it authorizes cancelling
    // THIS pause. `peekedEscalation.rulingOrdinal` is the ruling ordinal this
    // pause was already raised under; a ruling that authorizes cancelling it
    // must postdate that, exactly the inequality `compareManifest`'s own
    // `binding.rulingOrdinal` uses for "a new ruling landed." When no durable
    // escalation record exists yet to compare against, this falls back to
    // the plain any-ruling check — `cancelDevReviewLoop`'s own
    // `resolveEscalation` call below refuses that case on its own terms
    // (`StaleEscalationError`) regardless of what this gate decides.
    const rulings = deps.fetchRulings(pr)
    const newestRulingOrdinal = deps.fetchNewestRulingOrdinal(pr)
    if (rulings.length === 0 || (peekedEscalation !== null && newestRulingOrdinal <= peekedEscalation.rulingOrdinal)) {
      emitOperationEvent(deps.log, issue, target, 'refused', 'authority')
      return fail(
        taskToolError(
          'authority',
          rulings.length === 0
            ? `PR ${pr} carries no Principal ruling comment yet — nothing authenticates this cancel`
            : `PR ${pr}'s newest ruling (ordinal ${newestRulingOrdinal}) is no newer than the ruling this escalation was already raised under (ordinal ${peekedEscalation?.rulingOrdinal}) — nothing new authenticates cancelling this pause`
        )
      )
    }

    const agent: AgentVendor =
      peekedEscalation?.agent && isAgentVendor(peekedEscalation.agent) ? peekedEscalation.agent : 'claude'

    appendRoleLine(loopLogPathFor(null, issue), 'operator', `task_cancel requested: ${parsed.data.reason}`)

    try {
      const result = await deps.cancelDevReviewLoop({ cancelPr: pr, agent })
      const resolutionRead = readResolution(controlStoreDeps, issue, result.escalationId)
      const resolution = resolutionRead.status === 'ok' ? resolutionRead.value : null
      const outcome: TaskCancelOutcome =
        result.fencedEffectKeys.length > 0
          ? 'uncertain'
          : peekedEscalation && peekedEscalation.host !== deps.hostname()
            ? 'pending'
            : 'confirmed'
      emitOperationEvent(deps.log, issue, target, 'ok', null)
      return ok({
        task: issue,
        pr,
        escalationId: result.escalationId,
        outcome,
        authenticatedBy: resolution?.authenticatedBy ?? 'unknown-principal',
        authenticatedFrom: resolution?.authenticatedFrom ?? `${pr}-unknown`,
        fencedEffectKeys: result.fencedEffectKeys
      })
    } catch (err) {
      if (err instanceof ReplayedResolutionError) {
        if (err.existing?.decision === 'cancel') {
          emitOperationEvent(deps.log, issue, target, 'ok', null)
          return ok({
            task: issue,
            pr,
            escalationId,
            outcome: 'confirmed',
            authenticatedBy: err.existing.authenticatedBy,
            authenticatedFrom: err.existing.authenticatedFrom,
            fencedEffectKeys: []
          })
        }
        emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
        return fail(
          taskToolError(
            'precondition',
            `task ${issue}'s escalation '${escalationId}' was already resolved as 'resume', not 'cancel'`
          )
        )
      }
      if (err instanceof StaleEscalationError || err instanceof WrongTargetResolutionError) {
        emitOperationEvent(deps.log, issue, target, 'refused', 'precondition')
        return fail(taskToolError('precondition', err.message))
      }
      emitOperationEvent(deps.log, issue, target, 'error', 'infrastructure')
      return fail(taskToolError('infrastructure', err instanceof Error ? err.message : String(err)))
    }
  }
}

/** The default `task_cancel` handler the server binds. */
export const defaultTaskCancelHandler = createTaskCancelHandler()
