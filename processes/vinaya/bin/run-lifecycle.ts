import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve as resolvePath } from 'node:path'
import type { Writable } from 'node:stream'
import { hostname } from 'node:os'
import {
  type ControlStoreDeps,
  type EffectRecord,
  type EscalationRecord,
  type ExecutionRoundMirrorRecord,
  type ParsedRecord,
  type ResolutionRecord,
  compareManifest,
  manifestAsEchoed,
  nextRoundNumber,
  readEffects,
  readExecutionRoundMirror,
  writeExecutionRoundMirror,
  type LoopState,
  type ReconstructedJournal,
  type ReviewInputManifest
} from '@attalabs/aeg-core'
import {
  readRunCheckpoint,
  readRunOutcome,
  runIdentityForRunId,
  type RunIdentity,
  type SpawnedProcessLike,
  type SpawnFn
} from '@atta/executor-agent-spawn'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import {
  type EffectiveResumedState,
  readExecutionRound
} from '../../../harness/dev-process/engine-runtime/checkpoint-round'
import {
  CheckpointCorruptError,
  type CheckpointProvenance,
  type CheckpointRefusal,
  checkpointRefusal
} from '../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import {
  detectUsageLimit,
  getProcessSnapshot,
  resolveDispatchTimeoutMs,
  type UsageLimit
} from '../../../apps/cli/src/lib/dispatch'
import {
  classifyChildLiveness,
  fetchIssueRulings,
  fetchNewestIssueRulingAuthor,
  fetchNewestIssueRulingOrdinal,
  fetchNewestRulingAuthor,
  fetchNewestRulingOrdinal,
  fetchPrBody,
  fetchRulings,
  findOpenPrForBranch,
  reconcileLaunch,
  taskFromPrBody,
  type LaunchReconciliation,
  type ReconcileLaunchDeps
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import {
  keepDriverLock,
  seedLoopHistory,
  type DriverLockExit
} from '../../../apps/cli/src/lib/dev-review-loop/driver-lifecycle'
import {
  acquireDriverLockAtomic,
  bindPauseToPullRequest,
  clearDriverLock,
  escalationIdFor,
  escalationPrOf,
  isAutomaticRecoveryPause,
  isDriverPidAlive,
  isHostRepairPause,
  missingEscalationNextStep,
  ReplayedResolutionError,
  readDriverLock,
  readEscalationRecord,
  readPauseState,
  readResolutionRecord,
  recoverLoopState,
  resolveEscalation,
  StaleEscalationError,
  WrongTargetResolutionError,
  writeDriverLock,
  type PauseState
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import {
  type MergeableState,
  type PrOpenState,
  type PublishedPullRequestRead,
  readPublishedPullRequest
} from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import {
  isUsageLimitPauseDetail,
  MAX_AUTOMATIC_RATE_LIMIT_RESUMES,
  MAX_INFRASTRUCTURE_RETRIES,
  usageLimitResetFromDetail,
  usageLimitWaitMs
} from '../../../apps/cli/src/lib/dev-review-loop/round-assess'
import { crossRunnerRefusal } from '../../../apps/cli/src/lib/task-run-engine'
import type { HeldCleanVerdict } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import type { ParsedLaunch } from '../../../apps/cli/src/lib/dispatch'
import type { LegExit } from '../executing/log-events'

// What the Engine runner does around a run, apart from the run itself: the one
// driver lock per task, the choice between resuming a checkpoint and starting
// fresh, the recovery reads a re-run makes, the ceilings each role launches
// with, and the reaping of every agent process the run started. Each takes
// what it needs as a parameter, so a test drives it without the forge.

// --- the driver lock ---------------------------------------------------------

export interface LockHolder {
  pid: number
  startedAt: string
}

export type LockResult = { acquired: true; token: string } | { acquired: false; holder: LockHolder; message: string }

export interface LockDeps {
  pid: number
  now: () => Date
  isPidAlive: (pid: number) => boolean
  token: string
  /** Narrates a takeover to the per-task driver log. */
  narrate: (line: string) => void
}

const refusal = (task: number, holder: LockHolder): string =>
  `refuses to start for task ${task} — a driver is already running (pid ${holder.pid}, started ${holder.startedAt})`

/**
 * Takes the task's driver lock for this runner, as the standalone loop does: a live holder refuses the start
 * (and names itself), a dead one is taken over, and the claim itself is an exclusive create.
 */
export function takeDriverLock(root: string, task: number, deps: LockDeps): LockResult {
  const existing = readDriverLock(root, task)
  if (existing && deps.isPidAlive(existing.pid)) {
    return { acquired: false, holder: existing, message: refusal(task, existing) }
  }
  if (existing) {
    deps.narrate(
      `task ${task}'s driver lock names pid ${existing.pid} (started ${existing.startedAt}), which is no longer alive — taking over`
    )
    clearDriverLock(root, task)
  }
  const claim = { pid: deps.pid, startedAt: deps.now().toISOString(), token: deps.token }
  if (!acquireDriverLockAtomic(root, task, claim)) {
    // Lost a genuine race for a lock nobody held a moment ago: a live, different holder wins; anything
    // else is a vanishingly narrow residual this single retry closes.
    const raced = readDriverLock(root, task)
    if (raced && raced.pid !== deps.pid && deps.isPidAlive(raced.pid)) {
      return { acquired: false, holder: raced, message: refusal(task, raced) }
    }
    writeDriverLock(root, task, claim)
  }
  return { acquired: true, token: deps.token }
}

/** Clears the lock unless the one shared rule keeps it for this kind of exit. */
export function releaseDriverLock(root: string, task: number, exit: DriverLockExit): 'kept' | 'cleared' {
  if (keepDriverLock(exit)) return 'kept'
  clearDriverLock(root, task)
  return 'cleared'
}

/**
 * How the driver lock sees a leg's exit: a publish, a decided pause, or a crash. A halt is a pause no one else needs
 * to repair. The runner releases the lock only once its watch of a published pull request is over, so a publish is
 * never a watched one by then.
 */
export function lockExitOf(exit: LegExit): DriverLockExit {
  if (exit.reason === 'finished') return { kind: 'publish', watched: false }
  if (exit.reason === 'error') return { kind: 'crash', hostRepair: false }
  const decided = /^pause\((.*)\)$/.exec(exit.lastDecision)
  return { kind: 'pause', reason: decided?.[1] ?? 'halt', watched: false }
}

// --- re-run choice -------------------------------------------------------------

/**
 * The run identity of a task's `generation`th run. The first keeps the task's one identity, so a runner started later
 * finds the checkpoints of the one before it. A run that completed has nothing left to run, so each automatic conflict
 * re-entry of its published pull request starts the next generation under an identity of its own, and every other
 * task's identity is unchanged.
 */
export const runIdentityOfTask = (task: number, generation = 1): RunIdentity =>
  runIdentityForRunId(generation <= 1 ? `engine-task-${task}` : `engine-task-${task}-reentry-${generation - 1}`)

/** The recorded provenance of the newest checkpoint, when the saver keeps one. */
export interface ProvenanceReader {
  latestProvenance?: (threadId: string) => CheckpointProvenance | undefined
}

/** The task's newest run generation with a checkpoint: the one a runner started later continues. 1 when there is none. */
export function currentRunGeneration(reader: ProvenanceReader, task: number): number {
  let generation = 1
  while (reader.latestProvenance?.(runIdentityOfTask(task, generation + 1).threadId) !== undefined) generation += 1
  return generation
}

// --- the published pull request's watch ----------------------------------------

/** The forge reads the watch of a published pull request makes, and how often. */
export interface PublishedWatch {
  fetchPrState: (prNumber: number) => PrOpenState
  fetchMergeableState: (prNumber: number) => MergeableState
  pollMs: number
  sleep: (ms: number, stop: AbortSignal) => Promise<void>
}

/** How the watch of a published pull request ended: merged, closed, conflicting with the default branch, or stopped. */
export type PublishedWatchResult = 'merged' | 'closed' | 'conflicting' | 'stopped'

/**
 * After a run that published: reads the pull request until it is merged or closed, or until the forge reports it
 * conflicting with the default branch (`readPublishedPullRequest`, the standalone watcher's read). `UNKNOWN` is read
 * again on the next poll, never taken as conflicting or clean, and a read that fails is tried again; neither ends it.
 */
export async function watchPublishedPullRequest(
  prNumber: number,
  watch: PublishedWatch,
  stop: AbortSignal,
  narrate: (line: string) => void = () => {}
): Promise<PublishedWatchResult> {
  while (!stop.aborted) {
    let read: PublishedPullRequestRead = 'watching'
    try {
      read = readPublishedPullRequest(prNumber, watch)
    } catch (error) {
      narrate(`a forge read failed: ${error instanceof Error ? error.message : String(error)}; trying again`)
    }
    if (read !== 'watching') return read
    await watch.sleep(watch.pollMs, stop)
  }
  return 'stopped'
}

export type StartChoice =
  | { kind: 'fresh'; identity: RunIdentity }
  | { kind: 'resume'; identity: RunIdentity; checkpointRevision: string | undefined }
  /** The checkpoint records a run that already completed: there is nothing to continue. */
  | { kind: 'completed'; identity: RunIdentity }
  /** The checkpoint records a run that spent its round budget: resuming it has nothing to run either. */
  | { kind: 'exhausted'; identity: RunIdentity }
  /** The checkpoint cannot be resumed by this runner: no step runs, and the run is never started over in its place. */
  | { kind: 'refused'; identity: RunIdentity; refusal: CheckpointRefusal }

/**
 * Resumes the task's checkpoint when one exists, and otherwise starts fresh. A checkpoint whose recorded format or
 * Engine runtime version this runner cannot read, or that records neither, is refused before its state is read; one
 * that cannot be read at all is refused as corrupt. A moved code revision alone resumes.
 */
export async function chooseStart(
  checkpointer: BaseCheckpointSaver & ProvenanceReader,
  identity: RunIdentity
): Promise<StartChoice> {
  try {
    const provenance = checkpointer.latestProvenance?.(identity.threadId)
    const refusal = provenance === undefined ? null : checkpointRefusal(provenance)
    if (refusal !== null) return { kind: 'refused', identity, refusal }
    return await chooseReadableStart(checkpointer, identity, provenance)
  } catch (error) {
    if (!(error instanceof CheckpointCorruptError)) throw error
    return { kind: 'refused', identity, refusal: { code: error.code, detail: error.message } }
  }
}

async function chooseReadableStart(
  checkpointer: BaseCheckpointSaver & ProvenanceReader,
  identity: RunIdentity,
  provenance: CheckpointProvenance | undefined
): Promise<StartChoice> {
  const checkpoint = await readRunCheckpoint(checkpointer, identity)
  if (!checkpoint) return { kind: 'fresh', identity }
  const recorded = await readRunOutcome(checkpointer, identity)
  if (recorded?.reason === 'completed') return { kind: 'completed', identity }
  if (recorded?.reason === 'exhausted') return { kind: 'exhausted', identity }
  return { kind: 'resume', identity, checkpointRevision: provenance?.revision }
}

// --- the execution round a resume continues in ----------------------------------------

/** An effect issued but never acknowledged: a retry reconciles it under the input version it was issued with. */
export interface InterruptedEffect {
  key: string
  operation: string
  inputVersion: number
}

/** What a resume restores as its execution round, read from the checkpoint and checked against the control store. */
export type ExecutionRoundRestore =
  | {
      kind: 'restored'
      round: number
      checkpointId: string
      /** The mirror is absent, unreadable or disagrees with the checkpoint, so it is rewritten from the checkpoint. */
      rewriteMirror: boolean
      interrupted: InterruptedEffect[]
      /** A line for the driver log when the mirror disagreed; null when it agreed. */
      note: string | null
    }
  /** No step of the thread has recorded a round yet: the run is still in the round it started in. */
  | { kind: 'unrecorded' }
  | { kind: 'refused'; detail: string }

/**
 * The execution round a resume continues in: the one the resumed state (the checkpoint with its pending writes)
 * records, never the in-memory counter of the process that wrote it. The mirror is checked against it and loses on
 * any disagreement. An effect record issued at a later input version than that round refuses the resume, since every
 * request it made from there would be refused as a replay; an effect never acknowledged is handed back with the input
 * version it was issued with.
 */
export function restoreExecutionRound(input: {
  threadId: string
  resumed: EffectiveResumedState | null
  mirror: ParsedRecord<ExecutionRoundMirrorRecord>
  effects: readonly ParsedRecord<EffectRecord>[]
}): ExecutionRoundRestore {
  const recorded = input.resumed === null ? null : readExecutionRound(input.resumed)
  if (recorded === null || input.resumed === null) return { kind: 'unrecorded' }
  const { round } = recorded
  const effects = input.effects.flatMap((effect) => (effect.status === 'ok' ? [effect.value] : []))
  const ahead = effects.filter((effect) => effect.inputVersion > round)
  if (ahead.length > 0) {
    const named = ahead.map((effect) => `${effect.key} at input version ${effect.inputVersion}`).join(', ')
    return {
      kind: 'refused',
      detail: `the checkpoint holds execution round ${round}, but the control store records effects issued later (${named}); resuming would present an older input version than the one recorded`
    }
  }
  const interrupted = effects
    .filter((effect) => effect.status === 'started')
    .map((effect) => ({ key: effect.key, operation: effect.operation, inputVersion: effect.inputVersion }))
  const mirror = input.mirror.status === 'ok' ? input.mirror.value : null
  const agrees = mirror !== null && mirror.threadId === input.threadId && mirror.round === round
  const note =
    mirror !== null && !agrees
      ? `the control-store mirror records round ${mirror.round} at checkpoint ${mirror.checkpointId}; the checkpoint holds round ${round}, which wins`
      : null
  return {
    kind: 'restored',
    round,
    checkpointId: input.resumed.checkpointId,
    rewriteMirror: !agrees || mirror?.checkpointId !== input.resumed.checkpointId,
    interrupted,
    note
  }
}

/**
 * Restores a resume's execution round before any dispatch: reads the mirror and the effect records, decides, and
 * rewrites the mirror from the checkpoint when it must. The rewrite is a required write: a failure throws, and the
 * run dispatches nothing.
 */
export function restoreExecutionRoundBeforeDispatch(input: {
  store: ControlStoreDeps
  repository: string
  task: number
  threadId: string
  resumed: EffectiveResumedState | null
}): ExecutionRoundRestore {
  const restore = restoreExecutionRound({
    threadId: input.threadId,
    resumed: input.resumed,
    mirror: readExecutionRoundMirror(input.store, input.task, input.threadId),
    effects: readEffects(input.store, input.task)
  })
  if (restore.kind === 'restored' && restore.rewriteMirror)
    writeExecutionRoundMirror(input.store, input.task, {
      repository: input.repository,
      threadId: input.threadId,
      checkpointId: restore.checkpointId,
      round: restore.round,
      recordedAt: input.store.now().toISOString()
    })
  return restore
}

/** The pause detail of a refused checkpoint: its typed code first, so a reader routes on it. */
export const checkpointRefusalDetail = (refusal: CheckpointRefusal): string =>
  `${refusal.code}: ${refusal.detail}; no step ran and the run was not started over`

/** The line a resume appends to the driver log when the code moved since the checkpoint was made; null when it did not. */
export function revisionMovedLine(checkpointRevision: string | undefined, currentRevision: string): string | null {
  if (checkpointRevision === undefined || checkpointRevision === currentRevision) return null
  return `resuming at the next step on revision ${currentRevision}; the checkpoint was made at revision ${checkpointRevision}`
}

// --- the ruling that resumes a halted run --------------------------------------------

/** The agents an Engine run can use. */
export type AgentName = 'claude' | 'codex'

/**
 * The reads and the claim a resume is made of. Each default is the standalone loop's own function, so the
 * forge is reached only through them and a test replaces them with a fake forge.
 */
export interface ResumeDeps {
  readPauseState: (root: string, task: number) => PauseState | null
  readEscalationRecord: (task: number, escalationId: string) => EscalationRecord | null
  readResolution: (task: number, escalationId: string) => ResolutionRecord | null
  resolveEscalation: typeof resolveEscalation
  bindPauseToPullRequest: typeof bindPauseToPullRequest
  fetchPrBody: (pr: number) => string
  taskFromPrBody: (body: string) => number | null
  findOpenPrForBranch: typeof findOpenPrForBranch
  fetchRulings: (pr: number) => string[]
  fetchIssueRulings: (issue: number) => string[]
  fetchNewestRulingOrdinal: (pr: number) => number
  fetchNewestIssueRulingOrdinal: (issue: number) => number
  fetchNewestRulingAuthor: (pr: number) => string | null
  fetchNewestIssueRulingAuthor: (issue: number) => string | null
  /** The live driver holding the task's lock, or null. */
  liveDriver: (root: string, task: number) => LockHolder | null
  /** The infrastructure retries the control store holds for the task; `null` when it cannot be read. */
  infrastructureRetries: (task: number) => number | null
  /** Why the Engine may not continue the task's pause — another runner recorded it — or null when it may; absent, none. */
  crossRunnerRefusal?: (root: string, task: number) => string | null
}

export const liveResumeDeps: ResumeDeps = {
  crossRunnerRefusal: (root, task) => crossRunnerRefusal(task, 'atta-engine', root),
  readPauseState,
  readEscalationRecord: (task, escalationId) => readEscalationRecord(task, escalationId),
  readResolution: readResolutionRecord,
  resolveEscalation,
  bindPauseToPullRequest,
  fetchPrBody,
  taskFromPrBody,
  findOpenPrForBranch,
  fetchRulings,
  fetchIssueRulings,
  fetchNewestRulingOrdinal,
  fetchNewestIssueRulingOrdinal,
  fetchNewestRulingAuthor,
  fetchNewestIssueRulingAuthor,
  liveDriver: (root, task) => {
    const lock = readDriverLock(root, task)
    return lock && isDriverPidAlive(lock.pid) ? lock : null
  },
  infrastructureRetries: (task) => {
    const recovered = recoverLoopState(task)
    return recovered.status === 'ok'
      ? recovered.value.budgets.infrastructureRetries
      : recovered.status === 'corrupt'
        ? null
        : 0
  }
}

/** The environment variable the standalone loop's watcher reads its poll interval from, and its default. */
export const RULING_POLL_MS_ENV = 'VINAYA_DEV_REVIEW_LOOP_WATCH_POLL_MS'
export const DEFAULT_RULING_POLL_MS = 30_000

/** How often the post-halt watch reads the forge: the standalone watcher's interval. */
export function rulingPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[RULING_POLL_MS_ENV])
  return env[RULING_POLL_MS_ENV] && Number.isFinite(n) && n > 0 ? n : DEFAULT_RULING_POLL_MS
}

/** Sleeps `ms`, or until `stop` aborts. */
export const abortableSleep = (ms: number, stop: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (stop.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      stop.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    stop.addEventListener('abort', done)
  })

export interface RulingWatch {
  deps: ResumeDeps
  /** How long to wait between two reads of the forge. */
  pollMs: number
  sleep: (ms: number, stop: AbortSignal) => Promise<void>
  /** The clock a usage-limit reset is measured against; absent, the system clock. */
  now?: () => number
}

/** What one runner has spent of the resumes it makes without a ruling, across its legs. */
export interface AutomaticResumes {
  usageLimit: number
}

export type WatchResult =
  /** A newer ruling arrived and this watch claimed its resolution: the run continues. */
  | { kind: 'ruled'; escalationId: string }
  /** The agent's usage limit reset within its bound: the watch waited for it and continues the run with no ruling. */
  | { kind: 'recovered'; escalationId: string }
  /** The pause was cancelled. */
  | { kind: 'cancelled' }
  /** Another process consumed the resolution first: it owns the run now. */
  | { kind: 'consumed' }
  /** The resolution was refused; `message` says why. */
  | { kind: 'refused'; message: string }
  /** The watch was stopped, or the run holds no pause that a ruling continues. */
  | { kind: 'stopped' }

/** The pull request a held pause's ruling belongs to: null for a pause whose ruling is on the task Issue. */
const rulingOrdinalOf = (deps: ResumeDeps, held: PauseState, task: number): number => {
  const pr = escalationPrOf(held)
  return pr === null ? deps.fetchNewestIssueRulingOrdinal(task) : deps.fetchNewestRulingOrdinal(pr)
}

const rulingAuthorOf = (deps: ResumeDeps, held: PauseState, task: number): string | null => {
  const pr = escalationPrOf(held)
  return pr === null ? deps.fetchNewestIssueRulingAuthor(task) : deps.fetchNewestRulingAuthor(pr)
}

const escalationIdOf = (held: PauseState): string =>
  held.escalationId ?? escalationIdFor(held.task, held.round, held.head)

const authenticatedFromOrdinal = (held: PauseState, task: number, ordinal: number): string => {
  const pr = escalationPrOf(held)
  return pr === null ? `issue-${task}-${ordinal}` : `${pr}-${ordinal}`
}

/**
 * After a halt: waits for a ruling newer than the one the pause was raised under, or for a cancel. On a ruling it
 * claims the pause's resolution once with `resolveEscalation` — a loss to another claimant ends the watch without a
 * second resume — and returns so the caller continues the run from its checkpoint. A read that fails is tried again
 * on the next poll; it never ends the watch.
 *
 * A pause for an agent's usage limit whose reset is within the standalone loop's bound is the one exception that
 * needs no ruling: the watch sleeps to the recorded reset, then claims the resolution as the runner's own, at most
 * `MAX_AUTOMATIC_RATE_LIMIT_RESUMES` times per runner. Past that bound, or with no reset recorded, it waits for a
 * ruling like any other pause.
 */
export async function watchForRuling(
  root: string,
  task: number,
  watch: RulingWatch,
  stop: AbortSignal,
  narrate: (line: string) => void = () => {},
  automatic: AutomaticResumes = { usageLimit: 0 }
): Promise<WatchResult> {
  const { deps } = watch
  const held = deps.readPauseState(root, task)
  if (held === null) return { kind: 'stopped' }
  const escalationId = escalationIdOf(held)
  const tolerate = <T>(read: () => T, fallback: T): T => {
    try {
      return read()
    } catch (error) {
      narrate(`a forge read failed: ${error instanceof Error ? error.message : String(error)}; trying again`)
      return fallback
    }
  }
  const waitMs = isUsageLimitPauseDetail(held.detail)
    ? usageLimitWaitMs(usageLimitResetFromDetail(held.detail), (watch.now ?? Date.now)())
    : null
  if (waitMs !== null && automatic.usageLimit < MAX_AUTOMATIC_RATE_LIMIT_RESUMES) {
    narrate(`the agent's usage limit resets within its bound; waiting ${waitMs} ms for the reset, then resuming`)
    await watch.sleep(waitMs, stop)
    if (stop.aborted) return { kind: 'stopped' }
    const resolution = tolerate(() => deps.readResolution(task, escalationId), null)
    if (resolution?.decision === 'cancel') return { kind: 'cancelled' }
    if (resolution !== null) return { kind: 'consumed' }
    automatic.usageLimit += 1
    const pr = escalationPrOf(held)
    try {
      deps.resolveEscalation(
        task,
        escalationId,
        pr,
        'resume',
        'driver-self',
        `${pr ?? `issue-${task}`}-usage-limit-reset`
      )
    } catch (error) {
      if (error instanceof ReplayedResolutionError) return { kind: 'consumed' }
      if (error instanceof WrongTargetResolutionError) return { kind: 'refused', message: error.message }
      // A resume that asks no Principal for anything has nothing to authenticate when the record is missing.
      if (!(error instanceof StaleEscalationError)) throw error
    }
    return { kind: 'recovered', escalationId }
  }
  // A ruling "newer than the pause" is measured from the ordinal the escalation was raised under.
  let baseline: number | null = tolerate(
    () => deps.readEscalationRecord(task, escalationId)?.rulingOrdinal ?? null,
    null
  )
  while (!stop.aborted) {
    const resolution = tolerate(() => deps.readResolution(task, escalationId), null)
    if (resolution?.decision === 'cancel') return { kind: 'cancelled' }
    if (resolution !== null) return { kind: 'consumed' }
    const newest = tolerate(() => rulingOrdinalOf(deps, held, task), null)
    if (newest !== null) {
      baseline ??= newest
      if (newest > baseline) {
        try {
          deps.resolveEscalation(
            task,
            escalationId,
            escalationPrOf(held),
            'resume',
            tolerate(() => rulingAuthorOf(deps, held, task), null) ?? 'unknown-principal',
            authenticatedFromOrdinal(held, task, newest)
          )
          return { kind: 'ruled', escalationId }
        } catch (error) {
          if (error instanceof ReplayedResolutionError) return { kind: 'consumed' }
          if (error instanceof StaleEscalationError || error instanceof WrongTargetResolutionError)
            return { kind: 'refused', message: error.message }
          narrate(
            `claiming the resolution failed: ${error instanceof Error ? error.message : String(error)}; trying again`
          )
        }
      }
    }
    await watch.sleep(watch.pollMs, stop)
  }
  return { kind: 'stopped' }
}

export interface ResumeRequest {
  /** The pull request whose `Closes` line names the task. */
  pr: number
  /** The agent the Principal asks for; absent takes the pause's own. */
  agent?: AgentName
}

export interface ResumeClaim {
  task: number
  agent: AgentName
  held: PauseState
  escalationId: string
  /** True when the resolution had already been consumed by an earlier run: this resume attaches rather than claims. */
  attached: boolean
}

/**
 * Everything `--resume <pr>` settles before it runs anything: the task from the pull request's `Closes` line, the
 * held pause, the agent, and the authenticated resolution, claimed at most once. A refusal throws with the reason.
 * A resolution an earlier run already consumed as `resume` attaches instead of refusing.
 */
export function claimResume(root: string, request: ResumeRequest, deps: ResumeDeps): ResumeClaim {
  const refuse = (detail: string): never => {
    throw new Error(`run-engine --resume: ${detail}`)
  }
  const { pr } = request
  const task = deps.taskFromPrBody(deps.fetchPrBody(pr))
  if (task === null) return refuse(`PR #${pr}'s body carries no \`Closes #N\` reference — cannot derive its task.`)
  // Refused before anything is read or consumed: a pause another runner recorded is that runner's to continue.
  const otherRunner = deps.crossRunnerRefusal?.(root, task) ?? null
  if (otherRunner !== null) return refuse(otherRunner)
  const driver = deps.liveDriver(root, task)
  if (driver !== null) return refuse(refusal(task, driver))
  let held = deps.readPauseState(root, task)
  if (held === null) return refuse(`no held pause state found for task ${task} (PR #${pr}) — nothing to resume.`)
  if (held.prNumber === null) {
    // A pause raised before any pull request existed belongs to the open pull request on its own branch, and to no other.
    const open = deps.findOpenPrForBranch(held.branch)
    if (open?.number !== pr)
      return refuse(
        `task ${task}'s held pause state records no pull request and PR #${pr} is not the open pull request on its branch \`${held.branch}\`.`
      )
    held = deps.bindPauseToPullRequest(root, held, pr)
  }
  if (held.prNumber !== pr) return refuse(`task ${task}'s held pause state names PR #${held.prNumber}, not PR #${pr}.`)
  if (held.agent !== undefined && held.agent !== 'claude' && held.agent !== 'codex')
    return refuse(`held pause state carries invalid agent '${held.agent}' — expected claude or codex.`)
  const recorded = held.agent as AgentName | undefined
  if (request.agent !== undefined && recorded !== undefined && request.agent !== recorded)
    return refuse(
      `task ${task} paused on ${recorded}, and the Engine continues a run on the agent it started with; asked for ${request.agent}.`
    )
  const agent = request.agent ?? recorded
  if (agent === undefined) return refuse('this pause does not record an agent; retry once with --agent <claude|codex>.')

  const escalationPr = escalationPrOf(held)
  const escalationId = escalationIdOf(held)
  const retriesSoFar = Math.max(
    deps.infrastructureRetries(task) ?? Number.POSITIVE_INFINITY,
    held.infrastructureRetries ?? 0
  )
  const hostRepair = isHostRepairPause(held.reason)
  const bare = hostRepair || (isAutomaticRecoveryPause(held.reason) && retriesSoFar < MAX_INFRASTRUCTURE_RETRIES)
  if (!bare && deps.readEscalationRecord(task, escalationId) === null) {
    const stale = new StaleEscalationError(
      task,
      escalationId,
      'no escalation record was ever written for it, or it could not be read'
    )
    return refuse(`${stale.message}. ${missingEscalationNextStep(held, false)}`)
  }
  const source = escalationPr === null ? `Issue #${task}` : `PR #${pr}`
  if (!bare) {
    const rulings = escalationPr === null ? deps.fetchIssueRulings(task) : deps.fetchRulings(pr)
    if (rulings.length === 0)
      return refuse(
        `${source} carries no Principal ruling comment yet — nothing to resume from. Continuing task ${task} needs a Principal ruling posted on ${source}; then run \`run-engine --resume ${pr}\`.`
      )
  }
  const authenticatedBy = bare
    ? 'driver-self'
    : ((escalationPr === null ? deps.fetchNewestIssueRulingAuthor(task) : deps.fetchNewestRulingAuthor(pr)) ??
      'unknown-principal')
  const authenticatedFrom = bare
    ? `${pr}-${hostRepair ? 'host-repaired' : 'infrastructure-retry'}`
    : authenticatedFromOrdinal(held, task, rulingOrdinalOf(deps, held, task))
  try {
    deps.resolveEscalation(task, escalationId, escalationPr, 'resume', authenticatedBy, authenticatedFrom)
    return { task, agent, held, escalationId, attached: false }
  } catch (error) {
    if (error instanceof WrongTargetResolutionError) return refuse(error.message)
    if (error instanceof StaleEscalationError) {
      // A bare resume asks no Principal for anything, so a missing record leaves nothing to authenticate.
      if (!bare) return refuse(`${error.message}. ${missingEscalationNextStep(held, false)}`)
      return { task, agent, held, escalationId, attached: true }
    }
    if (error instanceof ReplayedResolutionError) {
      // The run that consumed the resolution may itself have ended before the pause was settled: this attaches to it.
      if (error.existing?.decision !== 'resume') return refuse(error.message)
      return { task, agent, held, escalationId, attached: true }
    }
    throw error
  }
}

/** The model a resume runs with: the one `--model` names, else the one the run's checkpoint recorded, else the vendor's default. */
export function resumeModel(explicit: string | undefined, recorded: string | undefined): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit
  return recorded !== undefined && recorded !== '' ? recorded : undefined
}

// --- recovery --------------------------------------------------------------------

export interface RecoveryDeps {
  /** The task's open pull request number, or null. */
  prNumber: () => number | null
  /** The round journal rebuilt from Principal-authored forge comments and the review-gate verdict. */
  fetchLoopHistory: (prNumber: number | null) => ReconstructedJournal
  /** The loop state the history seeds. */
  loopState: () => LoopState
  /** The recorded prior Developer launch. */
  readLaunch: () => ParsedLaunch
  launchDeps: ReconcileLaunchDeps
  /** The newest held verdict pair that is clean, or null. */
  heldVerdict: () => HeldCleanVerdict | null
  /** The manifest of the head as it stands now; null when it cannot be built. */
  currentManifest: () => ReviewInputManifest | null
  patchIdOf?: (sha: string) => string | null
}

export interface Recovery {
  launch: LaunchReconciliation
  state: LoopState
  /** True when the forge journal has rounds that are not yet concluded, so the next round is numbered after them. */
  historyApplies: boolean
  nextRound: number | null
  /** A held clean verdict still bound to the current head by the manifest comparison. */
  held: HeldCleanVerdict | null
  /** Set when a prior launch forbids another: the runner dispatches nothing. */
  refusal: string | null
}

/** The launch deps a real host reads liveness and identity with. */
export function realLaunchDeps(
  snapshot: ReconcileLaunchDeps['getProcessSnapshot'],
  terminate: ReconcileLaunchDeps['terminateChild']
): ReconcileLaunchDeps {
  return {
    isPidAlive: isDriverPidAlive,
    hostname: () => hostname(),
    getProcessSnapshot: snapshot,
    terminateChild: terminate
  }
}

/**
 * What a re-run reads before it dispatches anything: the prior Developer launch, reconciled; the round journal,
 * rebuilt from the forge; and any held clean verdict that still covers the head. The Vinaya Log is never read.
 */
export function recoverRun(deps: RecoveryDeps): Recovery {
  const parsed = deps.readLaunch()
  // An abandoned child is reaped before the reconciliation, so it never races the worker it hands continuity to.
  if (parsed.status === 'ok' && parsed.record.childPid !== null) {
    if (classifyChildLiveness(parsed.record, deps.launchDeps) === 'orphaned')
      deps.launchDeps.terminateChild(parsed.record.childPid)
  }
  const launch = reconcileLaunch(parsed, { requireContinuity: true }, deps.launchDeps)
  const prNumber = deps.prNumber()
  const seeded = seedLoopHistory({
    fetchLoopHistory: deps.fetchLoopHistory,
    prNumber,
    state: deps.loopState()
  })
  const refusal =
    launch.kind === 'live'
      ? `the Developer's prior launch (pid ${launch.record.childPid}) is still running; a second worker must never race the first`
      : launch.kind === 'pause'
        ? launch.detail
        : null
  let held: HeldCleanVerdict | null = null
  const candidate = refusal === null && prNumber !== null ? deps.heldVerdict() : null
  const current = candidate ? deps.currentManifest() : null
  if (candidate && current && current.headSha !== candidate.head) {
    // A held record written before manifest v2 has no protocol or pause-ruling slots: it is compared in its own legacy mode.
    const comparable: ReviewInputManifest =
      candidate.manifest.manifestVersion === undefined
        ? {
            headSha: current.headSha,
            baseSha: current.baseSha,
            briefHash: current.briefHash,
            objectivesVersion: current.objectivesVersion,
            rulingOrdinal: current.rulingOrdinal,
            policyDigest: current.policyDigest
          }
        : current
    const binding = compareManifest(manifestAsEchoed(candidate.manifest), comparable, deps.patchIdOf)
    if (binding.bound) held = candidate
  }
  return {
    launch,
    state: seeded.state,
    historyApplies: seeded.historyApplies,
    nextRound: seeded.historyApplies ? nextRoundNumber(seeded.loopHistory.rounds) : null,
    held,
    refusal
  }
}

// --- role ceilings ----------------------------------------------------------------

/** The Flow's agent roles and the dispatch role whose ceiling each launches under. */
const CEILING_ROLE = {
  developer: 'developer',
  'code-reviewer': 'code-reviewer',
  'security-reviewer': 'security'
} as const

/** Each Flow role's launch ceiling, as `resolveDispatchTimeoutMs` gives it for the dispatch config. */
export function roleTimeouts(
  config: { timeoutMs?: number; reviewerTimeoutMs?: number } | undefined
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(CEILING_ROLE).map(([role, dispatchRole]) => [role, resolveDispatchTimeoutMs(dispatchRole, config)])
  )
}

// --- provider usage limits ---------------------------------------------------------

/**
 * Wraps a spawn function so each agent launch's stdout is read, when the launch ends, the way the standalone dispatch
 * reads it (`detectUsageLimit`): a launch that ended on the vendor's usage limit is reported to `onLimit` with the
 * reset it named. The launch itself is unchanged.
 */
export function withUsageLimitWatch(
  spawnFn: SpawnFn,
  agent: AgentName,
  onLimit: (limit: UsageLimit) => void,
  now: () => number = Date.now
): SpawnFn {
  return (command, args, options) => {
    const child = spawnFn(command, args, options)
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.on('close', (code) => {
      const limit = detectUsageLimit(agent, stdout, code, now())
      if (limit !== null) onLimit(limit)
    })
    return child
  }
}

// --- no orphaned agent -------------------------------------------------------------

export interface ChildReaper {
  /** Spawns through `base`, each agent as the leader of a process group of its own. */
  spawnFn: SpawnFn
  /** The process groups launched so far. */
  groups: () => readonly number[]
  /** Terminates every launched group that still has a member: the graceful signal, then the forced one after `graceMs`. */
  reap: (graceMs?: number) => Promise<void>
}

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Already gone.
  }
}

/** One agent process group a runner launched, as its group file records it: the group id and its leader's start time. */
export interface RecordedGroup {
  pgid: number
  /** The leader's start time as `liveStartTime` reads it; null when it could not be read at launch. */
  startedAt: string | null
}

/** Reads a process's start time; the live read unless a test supplies its own. */
export type StartTimeOf = (pid: number) => string | null

/**
 * The kernel's start time of `pid` where `/proc` has it: field 22 of `/proc/<pid>/stat`, in clock ticks since
 * boot, fixed for the life of the process. Linux `ps` derives `lstart` from the current time minus the uptime,
 * so two reads of one process can differ by a second and a live agent would read as a reused pid. Elsewhere
 * (macOS) `ps` reports a fixed `lstart`.
 */
export const liveStartTime: StartTimeOf = (pid) => {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return getProcessSnapshot(pid)?.startedAt ?? null
  }
  // The fields after the parenthesised command name, which may itself hold spaces: state is field 3.
  const ticks = stat
    .slice(stat.lastIndexOf(')') + 2)
    .split(' ')
    .at(22 - 3)
  return ticks === undefined ? null : `ticks:${ticks}`
}

function readGroupFile(path: string): RecordedGroup[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is RecordedGroup =>
            typeof entry?.pgid === 'number' && (typeof entry.startedAt === 'string' || entry.startedAt === null)
        )
      : []
  } catch {
    return []
  }
}

/** Ends each group: the graceful signal, then the forced one to any member left after `graceMs`. */
async function endGroups(groups: readonly number[], graceMs: number): Promise<void> {
  for (const pgid of groups) signalGroup(pgid, 'SIGTERM')
  const deadline = Date.now() + graceMs
  while (groups.some(groupAlive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  for (const pgid of groups) if (groupAlive(pgid)) signalGroup(pgid, 'SIGKILL')
}

function plainSpawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
  return spawn(command, args, {
    ...options,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  }) as unknown as SpawnedProcessLike
}

/**
 * The gate an agent is held at: it reads one line from descriptor 3 and replaces itself with the agent (same pid,
 * same start time) only when that line is `go`. A launcher that dies before releasing it closes the pipe, and the
 * gate exits without running the agent.
 */
const AGENT_GATE = 'IFS= read -r go <&3 && [ "$go" = go ] || exit 125; exec 3<&-; exec "$@"'

function gatedSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): { child: SpawnedProcessLike; release: () => void } {
  const child = spawn('/bin/sh', ['-c', AGENT_GATE, 'vinaya-agent-gate', command, ...args], {
    ...options,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe']
  })
  const gate = child.stdio[3] as Writable
  // The gate may already be gone (killed before release); its pipe error is that exit, reported by the child.
  gate.on('error', () => {})
  return { child: child as unknown as SpawnedProcessLike, release: () => gate.end('go\n') }
}

/**
 * True when `command` names a file the gate's `exec` can run. A command that cannot be found is launched without
 * the gate, so it fails the way a direct launch does (a spawn error), not as the gate's exit status.
 */
function isResolvable(command: string, options: { cwd: string; env: NodeJS.ProcessEnv }): boolean {
  const runnable = (path: string) => {
    try {
      accessSync(path, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (command.includes('/')) return runnable(resolvePath(options.cwd, command))
  return (options.env.PATH ?? '')
    .split(delimiter)
    .some((dir) => dir !== '' && runnable(join(resolvePath(options.cwd, dir), command)))
}

/**
 * Wraps a spawn function so every agent starts in a process group of its own, and records the group. The
 * executor's abort signals only the agent it spawned, so what that agent started would outlive a halted run;
 * `reap` ends the whole group. With a `groupFile`, each group is also written to that file in the run's folder
 * as it is launched, and cleared once reaped, so a runner that dies without reaping leaves a record the next
 * runner ends them by (`reapAbandonedGroups`).
 */
export function createChildReaper(
  base?: SpawnFn,
  record: { groupFile?: string; startTimeOf?: StartTimeOf } = {}
): ChildReaper {
  const launched = new Map<number, string | null>()
  // With a group file and the real launcher, an agent starts held at a gate and runs only once its group is
  // recorded: a runner killed between the launch and the record would otherwise leave a working agent no later
  // runner knows to end.
  const gated = base === undefined && record.groupFile !== undefined
  const launch: SpawnFn = base ?? ((command, args, options) => plainSpawn(command, args, options))
  const writeRecord = (): void => {
    if (record.groupFile === undefined) return
    const groups: RecordedGroup[] = [...launched].map(([pgid, startedAt]) => ({ pgid, startedAt }))
    writeFileSync(record.groupFile, `${JSON.stringify(groups)}\n`, { mode: 0o600 })
  }
  const spawnFn: SpawnFn = (command, args, options) => {
    const held = gated && isResolvable(command, options) ? gatedSpawn(command, args, options) : null
    const child = held?.child ?? launch(command, args, { ...options, detached: true } as typeof options)
    const pid = (child as { pid?: unknown }).pid
    if (typeof pid === 'number') {
      launched.set(pid, record.groupFile === undefined ? null : (record.startTimeOf ?? liveStartTime)(pid))
      writeRecord()
    }
    held?.release()
    return child
  }
  return {
    spawnFn,
    groups: () => [...launched.keys()],
    reap: async (graceMs = 2000) => {
      await endGroups([...launched.keys()].filter(groupAlive), graceMs)
      launched.clear()
      writeRecord()
    }
  }
}

/**
 * Ends the agent process groups a runner that died left running, as its group file records them, and clears the
 * file. Called once the task's driver lock is this runner's, so no live runner owns them. A group whose leader is
 * alive is ended only when the leader's start time is the one recorded at launch — a reused process id is never
 * signalled; a group whose leader has exited keeps its id reserved while any member lives, so it is the one launched.
 * Returns the groups it ended.
 */
export async function reapAbandonedGroups(
  groupFile: string,
  graceMs = 2000,
  startTimeOf: StartTimeOf = liveStartTime
): Promise<number[]> {
  if (!existsSync(groupFile)) return []
  const abandoned = readGroupFile(groupFile)
    .filter((group) => groupAlive(group.pgid))
    .filter((group) => {
      const leader = startTimeOf(group.pgid)
      return leader === null || (group.startedAt !== null && leader === group.startedAt)
    })
    .map((group) => group.pgid)
  await endGroups(abandoned, graceMs)
  writeFileSync(groupFile, '[]\n', { mode: 0o600 })
  return abandoned
}

/** The exit code a shell reports for a process ended by `signal`. */
export const SIGNAL_EXIT_CODE: Readonly<Record<'SIGINT' | 'SIGTERM', number>> = { SIGINT: 130, SIGTERM: 143 }

/**
 * Maps SIGINT and SIGTERM to `onSignal` for as long as the returned function has not been called. The handler is
 * the run's abort: the process keeps running until the run has stopped and its agents have been reaped.
 */
export function onShutdownSignals(onSignal: (signal: 'SIGINT' | 'SIGTERM') => void): () => void {
  const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
    const handler = () => onSignal(signal)
    process.on(signal, handler)
    return [signal, handler] as const
  })
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}
