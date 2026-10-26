/**
 * The terminate-and-restart procedure that rolls one in-flight Engine run back
 * to the standalone runner. Switching the configured runner only changes the
 * runner of new runs: a run already recorded on the Engine stays there, and
 * either continues on the Engine to its own end or is ended by this procedure.
 *
 * In order, each step only once the one before it held:
 *
 * 1. Refuse a task whose recorded runner is not `atta-engine`.
 * 2. End the Engine run through public run control: a held pause is cancelled
 *    by the shared cancel the Operator uses, which consumes the cancel
 *    resolution, fences every still-started effect as uncertain and lets a
 *    live Engine run's own ruling watch end it; a run already halted at a
 *    node boundary, with no pause held and no live driver, has its started
 *    effects fenced the same way. A run still live with no pause held is
 *    refused, never signalled, and so is a run that already ended.
 * 3. Wait, bounded, for a cancelled run's driver to release its lock, and
 *    refuse while it is still live: a second live driver for one task is
 *    refused by the driver lock, so the restart never starts beside it.
 * 4. Reconcile every started and uncertain effect by its identity against the
 *    forge: one the forge carries is recorded verified, so it is never
 *    repeated; one the forge does not carry is recorded started again, so the
 *    restarted run's effect executor completes it rather than losing it; one
 *    the forge read cannot settle stays uncertain and refuses the restart. No
 *    effect is replayed here.
 * 5. Record the standalone runner and start a fresh standalone run from the
 *    same prepared inputs: the frozen brief on the task Issue.
 *
 * Every rehearsal that reaches step 2 appends one rehearsal record to the
 * task's runtime directory — completed, refused, or failed at a later step —
 * and nothing removes it.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  acquireOwnership,
  CONTROL_AREA_DIRNAME,
  type ControlStoreDeps,
  readEffect,
  type TaskCancelResult,
  writeEffect
} from '@attalabs/aeg-core'
import type { TaskRunner } from './config.js'
import {
  fenceStartedEffectsAsUncertain,
  isDriverPidAlive,
  readDriverLock,
  readPauseState
} from './dev-review-loop/pause-resume.js'
import type { EffectIdentity, EffectReconciler, EffectReconcileResult } from './effects.js'
import { reconcileGhComment } from './forge-write.js'
import { ensureRunDir, runPath } from './run-paths.js'
import { engineRunInFlight } from './task-run-engine.js'
import type { TaskToolCallResult } from './task-tools/handlers.js'
import type { CallerContext } from './task-tools/server.js'

/** Why the procedure refused, with the facts that decided it. */
export type BackendRollbackRefusalReason =
  | { code: 'not_engine_run'; task: number; recorded: TaskRunner }
  | { code: 'engine_running'; task: number; pid: number }
  | { code: 'cancel_refused'; task: number; detail: string }
  | { code: 'effect_ambiguous'; task: number; keys: string[]; detail: string }
  | { code: 'engine_run_ended'; task: number }
  | { code: 'step_failed'; task: number; step: 'reconcile' | 'restart'; detail: string }

export function backendRollbackRefusalText(reason: BackendRollbackRefusalReason): string {
  switch (reason.code) {
    case 'engine_run_ended':
      return `task ${reason.task}'s Engine run has already ended, completed or cancelled, and holds no pause — there is no in-flight run to roll back; start a new run with \`task run\`.`
    case 'step_failed':
      return `task ${reason.task}'s ${reason.step === 'reconcile' ? 'effect reconciliation' : 'restarted standalone run'} failed: ${reason.detail}`
    case 'not_engine_run':
      return `task ${reason.task}'s run is recorded on the ${reason.recorded} runner, not atta-engine — the terminate-and-restart procedure ends only an Engine run.`
    case 'engine_running':
      return `task ${reason.task}'s Engine driver (pid ${reason.pid}) is still running and holds no pause — let it reach its pause, or stop it, then run the procedure again; a second driver for one task is never started beside it.`
    case 'cancel_refused':
      return `task ${reason.task}'s Engine run could not be cancelled: ${reason.detail}`
    case 'effect_ambiguous':
      return `task ${reason.task}'s effect${reason.keys.length > 1 ? 's' : ''} ${reason.keys.map((key) => `'${key}'`).join(', ')} could not be reconciled with the forge (${reason.detail}) — the restart waits until the forge read settles ${reason.keys.length > 1 ? 'them' : 'it'}.`
  }
}

export class BackendRollbackRefusedError extends Error {
  constructor(readonly reason: BackendRollbackRefusalReason) {
    super(`backend rollback: ${backendRollbackRefusalText(reason)}`)
    this.name = 'BackendRollbackRefusedError'
  }
}

/** How the Engine run was ended: its held pause cancelled, or a halted run's started effects fenced. */
export type EngineRunEnding = { action: 'cancelled' | 'halted'; fencedEffectKeys: string[] }

/** One effect the procedure reconciled: its key and identity, the status it was found in and what the forge read said. */
export type ReconciledEffect = {
  key: string
  identity: EffectIdentity
  found: 'started' | 'uncertain'
  outcome: EffectReconcileResult['outcome']
  detail?: string
}

/** One rehearsal of the procedure, as the task's runtime directory keeps it. */
export type RollbackRehearsalRecord = {
  schemaVersion: 1
  task: number
  recordedRunner: 'atta-engine'
  action: EngineRunEnding['action']
  fencedEffectKeys: string[]
  reconciledEffects: ReconciledEffect[]
  restarted: { runner: 'standalone'; terminalState: string } | null
  refusal: BackendRollbackRefusalReason | null
  startedAt: string
  endedAt: string
}

export type BackendRollbackDeps = {
  /** The runtime directory the task's records live in. */
  runtimeDir: string
  controlStore: ControlStoreDeps
  readRunner: (task: number) => TaskRunner
  endEngineRun: (task: number) => Promise<EngineRunEnding>
  reconcile: EffectReconciler
  recordRunner: (task: number, runner: TaskRunner) => void
  /** Starts the fresh standalone run and resolves with its terminal state once it ends. */
  startStandalone: (task: number) => Promise<{ terminalState: string }>
  now?: () => Date
  /** How long a cancelled run's driver gets to release its lock before the restart is refused. */
  engineStopTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** The bound for a cancelled Engine run's driver to see the cancel and release its lock: one ruling-watch poll and grace. */
export const ROLLBACK_ENGINE_STOP_TIMEOUT_MS = 45_000
const ROLLBACK_ENGINE_STOP_POLL_MS = 100

/** True once no live driver holds the task's lock, waiting up to `timeoutMs` for it to be released. */
async function driverReleased(
  runtimeDir: string,
  task: number,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<{ released: true } | { released: false; pid: number }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lock = readDriverLock(runtimeDir, task)
    if (lock === null || !isDriverPidAlive(lock.pid)) return { released: true }
    if (Date.now() >= deadline) return { released: false, pid: lock.pid }
    await sleep(ROLLBACK_ENGINE_STOP_POLL_MS)
  }
}

/** The file in the task's runtime directory that keeps every rehearsal record, one line each. */
export const ROLLBACK_REHEARSALS_FILE = 'backend-rollback-rehearsals.jsonl'

export function rollbackRehearsalPath(task: number, runtimeDir: string): string {
  return runPath(runtimeDir, task, { area: 'task', file: ROLLBACK_REHEARSALS_FILE })
}

/** Every rehearsal record the task's runtime directory keeps, oldest first. */
export function readRollbackRehearsals(task: number, runtimeDir: string): RollbackRehearsalRecord[] {
  const path = rollbackRehearsalPath(task, runtimeDir)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RollbackRehearsalRecord)
}

function appendRehearsal(record: RollbackRehearsalRecord, runtimeDir: string): void {
  const path = rollbackRehearsalPath(record.task, runtimeDir)
  ensureRunDir(dirname(path), runtimeDir)
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

/** The task's effect records still started or uncertain, by key. */
function openEffects(deps: ControlStoreDeps, task: number) {
  const dir = join(deps.root(), String(task), CONTROL_AREA_DIRNAME, 'effect')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const key = name.slice(0, -'.json'.length)
      const read = readEffect(deps, task, key)
      return read.status === 'ok' && (read.value.status === 'started' || read.value.status === 'uncertain')
        ? [{ key, record: read.value }]
        : []
    })
}

/** Reconciles every started and uncertain effect by its identity, writing what the forge read settled. */
function reconcileOpenEffects(
  deps: BackendRollbackDeps,
  task: number,
  now: () => Date
): { reconciled: ReconciledEffect[]; ambiguous: ReconciledEffect[] } {
  const open = openEffects(deps.controlStore, task)
  if (open.length === 0) return { reconciled: [], ambiguous: [] }
  const owned = acquireOwnership(deps.controlStore, task, `backend-rollback:${task}:reconcile`)
  if (!owned.acquired) {
    throw new Error(`backend rollback: could not acquire task ${task}'s control-store epoch to reconcile its effects`)
  }
  const reconciled: ReconciledEffect[] = []
  for (const { key, record } of open) {
    const identity: EffectIdentity = {
      operation: record.operation,
      target: record.target,
      inputVersion: record.inputVersion,
      payloadDigest: record.payloadDigest
    }
    const result = deps.reconcile(identity)
    const recordedAt = now().toISOString()
    if (result.outcome === 'confirmed') {
      writeEffect(deps.controlStore, task, owned.epoch, key, {
        ...identity,
        status: 'verified',
        url: result.url,
        recordedAt
      })
    } else if (result.outcome === 'absent') {
      // Never landed: started again, so the restarted run's executor reconciles it once more and completes it.
      writeEffect(deps.controlStore, task, owned.epoch, key, { ...identity, status: 'started', recordedAt })
    }
    reconciled.push({
      key,
      identity,
      found: record.status as 'started' | 'uncertain',
      outcome: result.outcome,
      ...(result.outcome === 'ambiguous' ? { detail: result.reason } : {})
    })
  }
  return { reconciled, ambiguous: reconciled.filter((entry) => entry.outcome === 'ambiguous') }
}

/** Runs the procedure for one task and returns its rehearsal record, which is also appended to the runtime directory. */
export async function terminateAndRestart(task: number, deps: BackendRollbackDeps): Promise<RollbackRehearsalRecord> {
  const now = deps.now ?? (() => new Date())
  const recorded = deps.readRunner(task)
  if (recorded !== 'atta-engine') throw new BackendRollbackRefusedError({ code: 'not_engine_run', task, recorded })
  const startedAt = now().toISOString()
  const keep = (
    ending: EngineRunEnding | null,
    fields: Pick<RollbackRehearsalRecord, 'reconciledEffects' | 'restarted' | 'refusal'>
  ): RollbackRehearsalRecord => {
    const record: RollbackRehearsalRecord = {
      schemaVersion: 1,
      task,
      recordedRunner: 'atta-engine',
      action: ending?.action ?? 'cancelled',
      fencedEffectKeys: ending?.fencedEffectKeys ?? [],
      ...fields,
      startedAt,
      endedAt: now().toISOString()
    }
    appendRehearsal(record, deps.runtimeDir)
    return record
  }
  const refuse = (ending: EngineRunEnding | null, reason: BackendRollbackRefusalReason) => {
    keep(ending, { reconciledEffects: [], restarted: null, refusal: reason })
    return new BackendRollbackRefusedError(reason)
  }

  let ending: EngineRunEnding
  try {
    ending = await deps.endEngineRun(task)
  } catch (error) {
    if (error instanceof BackendRollbackRefusedError) throw refuse(null, error.reason)
    throw refuse(null, { code: 'cancel_refused', task, detail: error instanceof Error ? error.message : String(error) })
  }
  // A cancelled run's own ruling watch ends it; a halted one has no driver left to wait for.
  const driver = await driverReleased(
    deps.runtimeDir,
    task,
    ending.action === 'cancelled' ? (deps.engineStopTimeoutMs ?? ROLLBACK_ENGINE_STOP_TIMEOUT_MS) : 0,
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  )
  if (!driver.released) throw refuse(ending, { code: 'engine_running', task, pid: driver.pid })

  /** A later step's failure is still a rehearsal: its record is kept before the error is rethrown. */
  const failed = (step: 'reconcile' | 'restart', error: unknown, reconciledEffects: ReconciledEffect[]) => {
    keep(ending, {
      reconciledEffects,
      restarted: null,
      refusal: { code: 'step_failed', task, step, detail: error instanceof Error ? error.message : String(error) }
    })
    return error
  }
  let settled: ReturnType<typeof reconcileOpenEffects>
  try {
    settled = reconcileOpenEffects(deps, task, now)
  } catch (error) {
    throw failed('reconcile', error, [])
  }
  const { reconciled, ambiguous } = settled
  if (ambiguous.length > 0) {
    const reason: BackendRollbackRefusalReason = {
      code: 'effect_ambiguous',
      task,
      keys: ambiguous.map((entry) => entry.key),
      detail: ambiguous.map((entry) => entry.detail).join('; ')
    }
    keep(ending, { reconciledEffects: reconciled, restarted: null, refusal: reason })
    throw new BackendRollbackRefusedError(reason)
  }

  let restarted: { terminalState: string }
  try {
    deps.recordRunner(task, 'standalone')
    restarted = await deps.startStandalone(task)
  } catch (error) {
    throw failed('restart', error, reconciled)
  }
  return keep(ending, {
    reconciledEffects: reconciled,
    restarted: { runner: 'standalone', terminalState: restarted.terminalState },
    refusal: null
  })
}

// --- the live wiring ---------------------------------------------------------

type CancelHandler = (input: unknown, ctx: CallerContext) => Promise<TaskToolCallResult<TaskCancelResult>>

/** The caller the shared cancel records for a rollback's cancel. */
export const BACKEND_ROLLBACK_CALLER = { id: 'backend-rollback' }

/**
 * Ends a task's Engine run through public run control: a held pause through the shared cancel, a halted run by
 * fencing its started effects. A live driver holding no pause is refused, never signalled, and so is an Engine run
 * that already ended: with no pause held there is nothing in flight to roll back.
 */
export function endEngineRunThrough(
  cancel: CancelHandler,
  runtimeDir: string,
  controlStore: ControlStoreDeps,
  inFlight: (task: number) => boolean = (task) => engineRunInFlight(task, runtimeDir)
): (task: number) => Promise<EngineRunEnding> {
  return async (task) => {
    if (readPauseState(runtimeDir, task) === null) {
      const lock = readDriverLock(runtimeDir, task)
      if (lock !== null && isDriverPidAlive(lock.pid)) {
        throw new BackendRollbackRefusedError({ code: 'engine_running', task, pid: lock.pid })
      }
      if (!inFlight(task)) throw new BackendRollbackRefusedError({ code: 'engine_run_ended', task })
      const owned = acquireOwnership(controlStore, task, `backend-rollback:${task}:fence`)
      if (!owned.acquired) throw new Error(`could not acquire task ${task}'s control-store epoch to fence its effects`)
      return { action: 'halted', fencedEffectKeys: fenceStartedEffectsAsUncertain(task, owned.epoch, controlStore) }
    }
    const result = await cancel(
      {
        task: { issue: task },
        reason: 'terminate and restart: the Engine run is rolled back to the standalone runner'
      },
      { caller: BACKEND_ROLLBACK_CALLER }
    )
    if (!result.ok)
      throw new BackendRollbackRefusedError({ code: 'cancel_refused', task, detail: result.error.message })
    return { action: 'cancelled', fencedEffectKeys: result.result.fencedEffectKeys }
  }
}

/** The forge read that settles a comment effect: `pr:<n>` and `issue:<n>` targets; any other effect stays ambiguous. */
export const reconcileEffectOnForge: EffectReconciler = (identity) => {
  const target = /^(pr|issue):(\d+)$/.exec(identity.target)
  const kind = identity.operation === 'pr-comment' ? 'pr' : identity.operation === 'issue-comment' ? 'issue' : null
  if (kind === null || target === null || target[1] !== kind) {
    return {
      outcome: 'ambiguous',
      reason: `no forge read reconciles a '${identity.operation}' effect on '${identity.target}'`
    }
  }
  return reconcileGhComment(kind, target[2] as string)(identity)
}
