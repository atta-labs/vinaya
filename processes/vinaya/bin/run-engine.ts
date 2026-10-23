#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  initialLoopState,
  buildReviewInputManifest,
  DEFAULT_REVIEW_POLICY,
  type DevReviewLoopEventInput,
  type LoopConfig,
  type LoopState,
  type Observations,
  type ReviewInputManifest,
  type VerdictObservation
} from '@attalabs/aeg-core'
import {
  createRunControl,
  type RunControl,
  type RunOutcome,
  type SpawnFn,
  type StepNodeResult
} from '@atta/executor-agent-spawn'
import { loadProcess, type LoadedProcess } from '../../../harness/dev-process/loader/load-process'
import { SqliteCheckpointer } from '../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import {
  resumeProcessRun,
  startProcessRun,
  type ActionRegistry,
  type ProcessRunOptions
} from '../../../harness/dev-process/engine-runtime/run-process'
import {
  createLogTranslator,
  recordingActions,
  type EmitLogEvent,
  type LegOutcome,
  type NodeLifecycle
} from '../../../harness/dev-process/logging/translate'
import { createVinayaLogProducers, handoffHaltReason, STEP_FAILED } from '../executing/log-events'
import { createHandoff, liveHandoffDeps, type Handoff, type HandoffDeps } from '../executing/handoff'
import {
  fetchCiConclusion,
  readWorktreeHead,
  resolveHead
} from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { developerBranchFor } from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { publishRound } from '../../../apps/cli/src/lib/dev-review-loop/publication'
import {
  LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV,
  linuxUnixSocketFilterOptIn,
  protectedPathsForTurn,
  startTurnWriteAttribution,
  taskControlDir,
  type TurnWriteAttribution
} from '../../../apps/cli/src/lib/worker-boundary'
import { configPath } from '../../../apps/cli/src/lib/config'
import {
  appendSourceDeliveryReceipt,
  injectedDeliveryReceipts,
  readRequiredSourceManifest,
  requiredSourcesPromptBlock,
  sourceReceiptsPath,
  sourceStoreDir
} from '../../../apps/cli/src/lib/source-manifest'
import {
  prepareSources,
  RequiredSourcesUnavailable,
  realSourceProviderDeps
} from '../../../apps/cli/src/lib/source-provider'
import { briefHash as briefHashOf, extractSourceRevision, policyDigest as policyDigestOf } from '@attalabs/aeg-core'
import {
  reviewerDevToolContext,
  type DevToolContext,
  type DevToolResult
} from '../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { createReadSourceTool } from '../../../apps/cli/src/lib/task-tools/read-source'
import { createLogSink, drainLogSink, LOG_FOLDER_ONLY_ENV, type LogSinkDeps } from '../../../apps/cli/src/lib/log-sink'
import { setEngineLogIdentity } from './engine-log-identity'
import {
  abortableSleep,
  chooseStart,
  claimResume,
  createChildReaper,
  liveResumeDeps,
  lockExitOf,
  onShutdownSignals,
  realLaunchDeps,
  recoverRun,
  releaseDriverLock,
  resumeModel,
  revisionMovedLine,
  roleTimeouts,
  rulingPollMs,
  runIdentityOfTask,
  SIGNAL_EXIT_CODE,
  takeDriverLock,
  watchForRuling,
  type RecoveryDeps,
  type ResumeDeps,
  type RulingWatch
} from './run-lifecycle'
import {
  createDriverExitRecorder,
  DRIVER_HEARTBEAT_INTERVAL_MS,
  defaultSetHeartbeat,
  emitDriverHeartbeat
} from '../../../apps/cli/src/lib/dev-review-loop/driver-lifecycle'
import { isDriverPidAlive } from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { appendLoopLogLine, appendRunStartMarker, loopLogPathFor } from '../../../apps/cli/src/lib/loop-log'
import { getProcessSnapshot, readLaunchRecord, terminateChildWithGrace } from '../../../apps/cli/src/lib/dispatch'
import { loadConfig } from '../../../apps/cli/src/lib/config'
import { startDevToolsHost, type DevToolsHost } from '../../../apps/cli/src/lib/task-tools/dev-tools-host'
import { devToolsSocketPath } from '../../../apps/cli/src/lib/task-tools/dev-tools-registration'
import {
  attributeDriverToolCalls,
  createLivePublicationState,
  createLiveDeveloperContext,
  type LiveDeveloperContextLoopDeps,
  type LivePublicationScope,
  type LivePublicationState,
  resolvePublicationBase
} from '../../../apps/cli/src/lib/task-tools/live-developer-context'
import {
  checkTaskDispatchReadiness,
  createTaskWorktree,
  fetchFrozenBrief,
  fetchSourceRevision,
  fetchIssueRulingsAfterBrief,
  fetchNewestIssueRulingOrdinal,
  fetchRulings,
  fetchNewestRulingOrdinal,
  findOpenPrForBranch,
  resolveDeveloperDoctrineText,
  resolveIssueObjectives,
  reviewPolicyForLoop
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { fetchLoopHistory } from '../../../apps/cli/src/lib/dev-review-loop/journal-history'
import {
  buildVerdictFromReview,
  heldVerdictPath,
  latestHeldCleanVerdict
} from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { RUNTIME_DIR_ENV_KEY, runtimeDirForRepoAsync } from '../../../apps/cli/src/lib/run-paths'
import {
  defaultDeps,
  defaultGitWorktreeUntrackedPaths,
  defaultPatchIdOf,
  ownChangesRangeBase,
  worktreeCheckEnv
} from '../../../apps/cli/src/lib/dev-review-loop'
import { parseReviewResult, type ReviewResult } from '../../../apps/cli/src/lib/review-result'
import type { ReviewerPromptFacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { agentEnvAllowlist } from '../../../harness/adapters/agents/launch-env'
import { grantVariables } from '../../../harness/adapters/agents/variables'
import { ghPullRequestView } from '../executing/pull-request-env'
import {
  createVinayaReviewInputStager,
  renderVinayaReviewerPrompt,
  reviewerRulings,
  type VinayaReviewInputDeps,
  type VinayaStagedReviewInput
} from '../executing/review-input'
import { developerPrompt, type DeveloperPromptFacts } from '../executing/developer-prompt'
import {
  ACTION_BINDINGS,
  agentOutput,
  createActions,
  createRoleLaunchers,
  sandboxProbePlanFor,
  type HeldVerdictRole,
  type TaskInput
} from '../executing/actions'

// The Engine path for one task: the Vinaya process run on the packed executor
// instead of the standalone review loop. Choosing this entry point is the
// whole switch — task run selects this script as a subprocess, keeping
// Engine packages outside the CLI source.
//
//   bun processes/vinaya/bin/run-engine.ts --task <n> --agent <claude|codex> [--dry-run]

export type Agent = 'claude' | 'codex'

export interface EngineArgs {
  task: number
  agent: Agent
  dryRun: boolean
  /** The agent model for every role whose grants say `process-supplied`; absent leaves the vendor's default. */
  model?: string
}

const USAGE = 'Usage: run-engine.ts --task <n> --agent <claude|codex> [--model <id>] [--dry-run]'

export function parseArgs(argv: readonly string[]): EngineArgs {
  let task: number | undefined
  let agent: Agent | undefined
  let dryRun = false
  let model: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run') dryRun = true
    else if (flag === '--task') {
      const value = argv[++i] ?? ''
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--task takes a positive integer. ${USAGE}`)
      task = Number(value)
    } else if (flag === '--agent') {
      const value = argv[++i]
      if (value !== 'claude' && value !== 'codex') throw new Error(`--agent takes claude or codex. ${USAGE}`)
      agent = value
    } else if (flag === '--model') {
      const value = argv[++i] ?? ''
      if (value === '' || value.startsWith('--')) throw new Error(`--model takes a model id. ${USAGE}`)
      model = value
    } else throw new Error(`Unknown argument "${flag}". ${USAGE}`)
  }
  if (task === undefined || agent === undefined) throw new Error(USAGE)
  return { task, agent, dryRun, ...(model ? { model } : {}) }
}

export interface ResumeArgs {
  /** The pull request whose `Closes` line names the task. */
  resume: number
  agent?: Agent
  /** The model for the resumed run; absent takes the one the run's checkpoint recorded. */
  model?: string
}

const RESUME_USAGE = 'Usage: run-engine.ts --resume <pr> [--agent <claude|codex>] [--model <id>]'

export function parseResumeArgs(argv: readonly string[]): ResumeArgs {
  let resume: number | undefined
  let agent: Agent | undefined
  let model: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--resume') {
      const value = argv[++i] ?? ''
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`--resume takes a pull request number. ${RESUME_USAGE}`)
      resume = Number(value)
    } else if (flag === '--agent') {
      const value = argv[++i]
      if (value !== 'claude' && value !== 'codex') throw new Error(`--agent takes claude or codex. ${RESUME_USAGE}`)
      agent = value
    } else if (flag === '--model') {
      const value = argv[++i] ?? ''
      if (value === '' || value.startsWith('--')) throw new Error(`--model takes a model id. ${RESUME_USAGE}`)
      model = value
    } else throw new Error(`Unknown argument "${flag}". ${RESUME_USAGE}`)
  }
  if (resume === undefined) throw new Error(RESUME_USAGE)
  return { resume, ...(agent ? { agent } : {}), ...(model ? { model } : {}) }
}

/** The model the newest checkpoint of the task's run recorded; undefined when the run has none or left the vendor's default. */
export function recordedCheckpointModel(runtimeDir: string, task: number): string | undefined {
  const file = checkpointPath(runDirectory(runtimeDir, task))
  if (!existsSync(file)) return undefined
  const saver = new SqliteCheckpointer({ path: file, revision: 'unknown' })
  try {
    const model = saver.latestProvenance(runIdentityOfTask(task).threadId)?.model
    return model === '' ? undefined : model
  } finally {
    saver.close()
  }
}

export interface ResumeEngineInput {
  args: ResumeArgs
  runtimeDir: string
  deps?: ResumeDeps
  /** Runs the claimed task on the Engine; the checkpoint it finds is the one the halted run left. */
  run: (args: EngineArgs) => Promise<EngineRunResult>
}

/**
 * `--resume <pr>`: settles the task, the agent and the authenticated resolution (`claimResume`), then continues the
 * halted run from its checkpoint with the model `--model` names, else the one the checkpoint recorded.
 */
export async function resumeEngine(input: ResumeEngineInput): Promise<EngineRunResult> {
  const claim = claimResume(
    input.runtimeDir,
    { pr: input.args.resume, agent: input.args.agent },
    input.deps ?? liveResumeDeps
  )
  const model = resumeModel(input.args.model, recordedCheckpointModel(input.runtimeDir, claim.task))
  return input.run({ task: claim.task, agent: claim.agent, dryRun: false, ...(model ? { model } : {}) })
}

const vendorOf = (agent: Agent): 'claude-code' | 'codex' => (agent === 'claude' ? 'claude-code' : 'codex')

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** The script a vendor's MCP settings name as the dev-tools server: it relays to the runner's host socket. */
export function shimContent(socketPath: string, execPath: string, entry: string): string {
  return `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(entry)} task-tools dev-bridge --socket ${shellQuote(socketPath)}\n`
}

/** Where one task's run files go: `<runtimeDir>/engine-runs/<task>`. */
export const runDirectory = (runtimeDir: string, task: number): string => join(runtimeDir, 'engine-runs', String(task))

interface FlowStep {
  id: string
  type: string
  action?: string
  role?: string
}

async function flowSteps(process: LoadedProcess): Promise<FlowStep[]> {
  const { parse } = await import('yaml')
  const { readFileSync } = await import('node:fs')
  return (parse(readFileSync(process.flowPath, 'utf8')) as { steps: FlowStep[] }).steps
}

/** What the dry run shows: the loaded process, the compiled steps, the bound functions and each role's launch. */
export async function dryRunLines(options: {
  process: LoadedProcess
  agent: Agent
  generatedRoot: string
  shimPath: string
}): Promise<string[]> {
  const steps = await flowSteps(options.process)
  const lines = [
    `process ${options.process.identity.id}@${options.process.identity.version} digest ${options.process.digest}`
  ]
  for (const step of steps)
    lines.push(`step ${step.id} ${step.type}${step.action ? ` ${step.action}` : ''}${step.role ? ` ${step.role}` : ''}`)
  for (const step of steps) {
    if (step.type !== 'mechanical' || !step.action) continue
    const binding = ACTION_BINDINGS[step.action]
    const names = binding ? binding.adapts.map((fn) => fn.name).join(', ') : '(no binding)'
    lines.push(`bound ${step.id} ${step.action}: ${names}`)
  }
  const roles = createRoleLaunchers({
    vendor: vendorOf(options.agent),
    generatedRoot: options.generatedRoot,
    mcpCommand: options.shimPath
  })
  for (const [role, launcher] of Object.entries(roles)) {
    lines.push(`launch ${role}: ${[launcher.command, ...launcher.buildArgs({} as never)].join(' ')}`)
    lines.push(`shim ${role}: ${options.shimPath}`)
  }
  return lines
}

/** One execution of a step, in the order the Engine started them. */
export interface TraceStep {
  nodeId: string
  attempt: number
  /** The step's exit code; null for an agent step that ran again later (the executor keeps only the last result) or one that never reported. */
  exitCode: number | null
  /** The message and stack of the error a bound action threw; absent when the step did not throw. */
  error?: string
  /** The `node:streaming` events delivered while the step ran, as delivered. */
  streaming: unknown[]
}

export interface RunTrace {
  task: number
  agent: Agent
  loopId: string
  outcome: string
  error?: string
  /** The reason the handoff paused the run for, when it did. */
  pauseReason?: string
  steps: TraceStep[]
  verdicts: Record<string, unknown>
}

const REVIEW_STEPS = ['code-review', 'security-review'] as const

/** Builds the trace of a run from what the Engine delivers and what the actions return. */
export function createTraceRecorder(
  meta: { task: number; agent: Agent; loopId: string },
  report: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
) {
  const steps: TraceStep[] = []
  const attempts = new Map<string, number>()
  const open = (nodeId: string): TraceStep | undefined => {
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i]?.nodeId === nodeId) return steps[i]
    return undefined
  }
  return {
    onEvent(event: NodeLifecycle): void {
      if (event.type === 'node:start') {
        const attempt = (attempts.get(event.nodeId) ?? 0) + 1
        attempts.set(event.nodeId, attempt)
        steps.push({ nodeId: event.nodeId, attempt, exitCode: null, streaming: [] })
      } else if (event.type === 'node:streaming') open(event.nodeId)?.streaming.push(event)
      else if (event.type === 'node:failed') {
        // An agent step's failure arrives here; a mechanical one was already recorded by `tracedActions`.
        const step = open(event.nodeId)
        if (!step || step.error !== undefined) return
        step.error = event.error.split('\n').slice(0, 8).join('\n')
        if (step.exitCode === null) step.exitCode = 1
        report(`step ${event.nodeId} failed: ${step.error}`)
      }
    },
    recordExit(nodeId: string, exitCode: number, error?: string): void {
      const step = open(nodeId)
      if (!step) return
      step.exitCode = exitCode
      if (error !== undefined) step.error = error
    },
    finish(
      outcome: string,
      results: Readonly<Record<string, StepNodeResult>>,
      error?: string,
      pauseReason?: string
    ): RunTrace {
      for (const [nodeId, result] of Object.entries(results)) {
        const last = open(nodeId)
        if (last && last.exitCode === null) last.exitCode = result.exitCode
      }
      const verdicts: Record<string, unknown> = {}
      for (const step of REVIEW_STEPS) verdicts[step] = parseReviewResult(agentOutput(results, step))
      return {
        ...meta,
        outcome,
        ...(error === undefined ? {} : { error }),
        ...(pauseReason === undefined ? {} : { pauseReason }),
        steps,
        verdicts
      }
    }
  }
}

/** The actions, each reporting its exit code to the trace. */
export function tracedActions(
  actions: ActionRegistry,
  trace: Pick<ReturnType<typeof createTraceRecorder>, 'recordExit'>,
  report: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): ActionRegistry {
  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      async (context: Parameters<typeof action>[0]) => {
        try {
          const result = await action(context)
          trace.recordExit(context.nodeId, result.exitCode)
          return result
        } catch (error) {
          const detail = (error instanceof Error ? (error.stack ?? error.message) : String(error))
            .split('\n')
            .slice(0, 8)
            .join('\n')
          trace.recordExit(context.nodeId, 1, detail)
          report(`step ${context.nodeId} failed: ${detail}`)
          throw error
        }
      }
    ])
  )
}

export interface LogSinkLike {
  log: (event: never) => void
  drain: () => Promise<void>
}

export interface EngineRunOptions {
  args: EngineArgs
  process: LoadedProcess
  /** The repository root the shim's CLI entry is found under. */
  repoRoot: string
  runtimeDir: string
  loopId: string
  taskInput: TaskInput
  /** Replaces the actions built from `taskInput`; for a run that must not reach the forge. */
  actions?: ActionRegistry
  sink: LogSinkLike
  startHost: (options: Parameters<typeof startDevToolsHost>[0]) => Promise<Pick<DevToolsHost, 'close'>>
  devToolsContext: DevToolContext
  /** Told every Engine event, unaltered, before the trace and the Log see it. */
  observe?: (event: NodeLifecycle) => void
  spawnFn?: SpawnFn
  control?: RunControl
  out?: (line: string) => void
  execPath?: string
  /** The Developer's prompt facts, read each time its step starts; absent leaves the prompt as the Flow renders it. */
  developerFacts?: () => Promise<DeveloperPromptFacts>
  /** Told when the Developer step starts, so the live context records the head and base that turn publishes against. */
  beginDeveloperTurn?: () => Promise<void>
  /** The Linux host opt-in: the generated Claude settings allow Unix sockets and the variable is forwarded to the agent. */
  allowUnixSockets?: boolean
  /** The code revision recorded on every checkpoint; defaults to the HEAD of `repoRoot`, the checkout the runner runs from. */
  revision?: string
  /** What the runner does around the run; every member defaults to the live behaviour. */
  lifecycle?: EngineLifecycleOptions
  /** Replaces the writers and forge posts a pause hands off to; for a run that must not reach them. */
  handoffDeps?: HandoffDeps
}

export interface EngineLifecycleOptions {
  /** Starts the driver heartbeat timer; replaced by a test that drives the callback on its own clock. */
  setHeartbeat?: (cb: () => void, intervalMs: number) => () => void
  pid?: number
  isPidAlive?: (pid: number) => boolean
  now?: () => Date
  /** The dispatch settings the role ceilings come from (`dispatch.timeoutMs`, `dispatch.reviewerTimeoutMs`). */
  dispatchConfig?: { timeoutMs?: number; reviewerTimeoutMs?: number }
  /** What a re-run reads before it dispatches; absent for a run that must not reach the forge. */
  recovery?: RecoveryDeps
  /** How long agent process groups are given to exit on the graceful signal before the forced one. */
  killGraceMs?: number
  /** Whether SIGINT and SIGTERM abort the run (default true). */
  handleSignals?: boolean
  /** After a halt that left a pause, waits for a newer ruling or a cancel and continues the run on a ruling; absent ends the runner at the halt. */
  watch?: RulingWatch
}

/** The HEAD of the checkout at `repoRoot`, or `unknown` when it is not a git checkout. */
function checkoutRevision(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return 'unknown'
  }
}

/** The file a run's checkpoints are kept in, under its run directory. */
export const checkpointPath = (runDir: string): string => join(runDir, 'checkpoints.sqlite')

export interface EngineRunResult {
  outcome: RunOutcome | null
  exitCode: number
  tracePath: string
}

/** Runs the task on the Engine. The host is closed and the sink drained on every way out. */
export async function runEngine(options: EngineRunOptions): Promise<EngineRunResult> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const { args } = options
  const lifecycle = options.lifecycle ?? {}
  out(`loopId ${options.loopId}`)
  const runDir = runDirectory(options.runtimeDir, args.task)
  mkdirSync(runDir, { recursive: true })
  const tracePath = join(runDir, 'trace.json')
  const trace = createTraceRecorder({ task: args.task, agent: args.agent, loopId: options.loopId })
  const producers = createVinayaLogProducers({ loopId: options.loopId, task: args.task })
  const translator = createLogTranslator(producers, options.sink.log as unknown as EmitLogEvent)
  const logPath = loopLogPathFor(null, args.task, options.runtimeDir)
  const narrate = (line: string): void => appendLoopLogLine(logPath, `${new Date().toISOString()}  ${line}`)
  let pausedFor: string | undefined
  const writeTrace = (outcome: string, results: Record<string, StepNodeResult>, error?: string): void => {
    // The trace carries tool output verbatim, so only its owner reads it.
    writeFileSync(tracePath, `${JSON.stringify(trace.finish(outcome, results, error, pausedFor), null, 2)}\n`, {
      mode: 0o600
    })
    chmodSync(tracePath, 0o600)
    out(`trace ${tracePath}`)
  }

  // One runner per task: a held lock ends this start before anything is dispatched.
  const lock = takeDriverLock(options.runtimeDir, args.task, {
    pid: lifecycle.pid ?? process.pid,
    now: lifecycle.now ?? (() => new Date()),
    isPidAlive: lifecycle.isPidAlive ?? isDriverPidAlive,
    token: randomUUID(),
    narrate
  })
  if (!lock.acquired) {
    narrate(`engine runner ${lock.message}`)
    out(`engine runner ${lock.message}`)
    await options.sink.drain()
    writeTrace('refused', {}, lock.message)
    return { outcome: null, exitCode: 1, tracePath }
  }

  // Each leg of a run has a run control of its own: a halted one cannot be run again.
  let control = options.control ?? createRunControl()
  const reaper = createChildReaper(options.spawnFn)
  // A halt ends the agents' whole process groups at once: the executor signals only the agent it spawned.
  const reapOnHalt = (): void =>
    control.signal.addEventListener('abort', () => void reaper.reap(lifecycle.killGraceMs), { once: true })
  reapOnHalt()
  const stopWatching = new AbortController()
  const log = (event: DevReviewLoopEventInput): void => (options.sink.log as unknown as (event: unknown) => void)(event)
  let currentNode: string | null = null
  let prNumber = 0
  let signalled: 'SIGINT' | 'SIGTERM' | null = null
  let described = 'starting'
  let stopHeartbeat: () => void = () => {}
  const recordExit = createDriverExitRecorder({
    loopId: options.loopId,
    task: args.task,
    loopLogPath: logPath,
    describeDecision: () => described,
    stopHeartbeat: () => stopHeartbeat(),
    log
  })
  stopHeartbeat = (lifecycle.setHeartbeat ?? defaultSetHeartbeat)(
    () =>
      emitDriverHeartbeat({
        loopId: options.loopId,
        task: args.task,
        round: options.taskInput?.reviewRound?.() ?? 1,
        phase: currentNode,
        prNumber,
        log
      }),
    DRIVER_HEARTBEAT_INTERVAL_MS
  )
  const stopSignals =
    lifecycle.handleSignals === false
      ? () => {}
      : onShutdownSignals((signal) => {
          if (signalled !== null) {
            // A second signal means the first stop is taking too long: end the agents now and leave.
            narrate(`received ${signal} again; ending the agents now`)
            void reaper.reap(0).then(() => process.exit(SIGNAL_EXIT_CODE[signal]))
            return
          }
          signalled = signal
          narrate(`received ${signal}; stopping the run and ending its agents`)
          control.halt(signal)
          stopWatching.abort()
        })

  // Every pausing exit — a pause decision and an error alike — ends here: records, one comment, then the halt.
  const taskForHandoff = options.taskInput
  const makeHandoff = (): Handoff =>
    createHandoff(
      {
        task: args.task,
        branch: taskForHandoff?.branch ?? '',
        runtimeDir: options.runtimeDir,
        runId: options.loopId,
        agent: args.agent,
        ...(args.model ? { model: args.model } : {}),
        round: () => taskForHandoff?.reviewRound?.() ?? 1,
        head: () => {
          try {
            return (taskForHandoff?.worktreePath ? readWorktreeHead(taskForHandoff.worktreePath) : null) ?? 'unknown'
          } catch {
            return 'unknown'
          }
        },
        prNumber: () => {
          if (prNumber > 0) return prNumber
          // The Developer may have opened the pull request since the reconcile step looked.
          const find = taskForHandoff?.bound?.findOpenPrForBranch
          try {
            return find && taskForHandoff?.branch ? (find(taskForHandoff.branch)?.number ?? null) : null
          } catch {
            return null
          }
        },
        versions: () => {
          if (!taskForHandoff?.inputVersions) throw new Error('no input versions are wired for this run')
          return taskForHandoff.inputVersions()
        },
        halt: (reason) => {
          pausedFor = reason
          control.halt(handoffHaltReason(reason))
        }
      },
      options.loopId,
      options.handoffDeps ?? liveHandoffDeps(log)
    )
  // A resumed leg hands its own pauses off afresh: one handoff answers for one leg.
  let handoff = makeHandoff()
  if (taskForHandoff) taskForHandoff.handoff = handoff
  /** An error the run could not absorb is a pause for the infrastructure, never a failed run. */
  const handOffError = (message: string): LegOutcome => {
    const round = taskForHandoff?.reviewRound?.() ?? 1
    handoff.pause({
      reason: 'infrastructure',
      detail: `an uncaught error ended round ${round}'s own processing: ${message}`,
      error: new Error(message)
    })
    return { reason: 'paused', haltReason: handoffHaltReason('infrastructure') }
  }

  const hosts: Array<Pick<DevToolsHost, 'close'>> = []
  let checkpointer: SqliteCheckpointer | undefined
  let outcome: RunOutcome | null = null
  let legOutcome: LegOutcome | null = null
  let error: string | undefined
  try {
    const storeDir = developerSourceStoreDir(options.runtimeDir, args.task)
    const reviewerContext = reviewerDevToolContext(async (readInput) => {
      const manifest = readRequiredSourceManifest(storeDir)
      if (manifest === null) return refusal('read_source', 'the required-source manifest is unavailable')
      return createReadSourceTool({
        storeDir,
        manifestDigest: manifest.digest,
        readObject: realSourceProviderDeps(options.taskInput.worktreePath).readObject
      })(readInput)
    })
    const roleHosts = [
      { role: 'developer' as const, context: options.devToolsContext, file: 'developer-dev-bridge.sh' },
      { role: 'code-reviewer' as const, context: reviewerContext, file: 'code-reviewer-dev-bridge.sh' },
      { role: 'security' as const, context: reviewerContext, file: 'security-dev-bridge.sh' }
    ]
    const mcpCommands: Record<string, string> = {}
    for (const roleHost of roleHosts) {
      const socketPath = devToolsSocketPath(`engine-${args.task}-${roleHost.role}`)
      hosts.push(
        await options.startHost({
          socketPath,
          serverVersion: 'engine-run-1',
          context: roleHost.context,
          role: roleHost.role
        })
      )
      const shimPath = join(runDir, roleHost.file)
      writeFileSync(
        shimPath,
        shimContent(socketPath, options.execPath ?? process.execPath, cliEntryOf(options.repoRoot))
      )
      chmodSync(shimPath, 0o755)
      mcpCommands[roleHost.role === 'security' ? 'security-reviewer' : roleHost.role] = shimPath
    }
    const roles = createRoleLaunchers({
      vendor: vendorOf(args.agent),
      generatedRoot: join(runDir, 'generated'),
      variables: options.taskInput?.worktreePath ? grantVariables(options.taskInput.worktreePath, runDir) : undefined,
      mcpCommands,
      model: args.model,
      allowUnixSockets: options.allowUnixSockets === true,
      stageCodexLogin: true,
      timeouts: roleTimeouts(lifecycle.dispatchConfig)
    })
    // The Developer's sandbox is probed from the launch shape just generated, before the first agent step.
    if (options.taskInput && roles.developer) {
      const vendor = vendorOf(args.agent)
      const developer = roles.developer
      const { taskInput } = options
      taskInput.sandboxPlan = () =>
        sandboxProbePlanFor(vendor, developer, join(runDir, 'generated', 'developer'), taskInput.worktreePath)
    }
    const base = options.actions ?? createActions(options.taskInput)
    // The pull request found by the reconcile step is the one the heartbeat reports.
    const noting: ActionRegistry = Object.fromEntries(
      Object.entries(base).map(([name, action]) => [
        name,
        async (context: Parameters<typeof action>[0]) => {
          // Each Developer turn records the head it starts from, as the standalone loop does.
          if (context.nodeId === 'develop') await options.beginDeveloperTurn?.()
          const result = await action(context)
          if (context.nodeId === 'reconcile-external-state') {
            try {
              const found = (JSON.parse(result.stdout ?? 'null') as { number?: unknown } | null)?.number
              if (typeof found === 'number') {
                prNumber = found
                // A pause raised before this pull request existed now belongs to it.
                handoff.bindToPullRequest(found)
              }
            } catch {}
          }
          return result
        }
      ])
    )
    const actions = recordingActions(tracedActions(noting, trace), translator)
    const revision = options.revision ?? checkoutRevision(options.repoRoot)
    const saver = new SqliteCheckpointer({ path: checkpointPath(runDir), revision, model: args.model })
    checkpointer = saver
    const identity = runIdentityOfTask(args.task)
    const runLeg = async (): Promise<void> => {
      outcome = null
      error = undefined
      pausedFor = undefined
      const choice = await chooseStart(saver, identity)
      appendRunStartMarker(logPath, {
        role: 'engine-runner',
        pid: lifecycle.pid ?? process.pid,
        runId: options.loopId,
        resumed: choice.kind === 'resume'
      })
      const branch = options.taskInput?.branch
      narrate(
        choice.kind === 'resume'
          ? `resuming the run from its checkpoint (${identity.runId})`
          : choice.kind === 'completed'
            ? 'the checkpoint records a completed run; nothing to run'
            : `no checkpoint; starting fresh${branch ? ` on branch ${branch}` : ''}`
      )
      const moved = choice.kind === 'resume' ? revisionMovedLine(choice.checkpointRevision, revision) : null
      if (moved !== null) narrate(moved)

      // What a re-run reads before it dispatches: the prior launch, the round journal and any held verdict.
      const recovery = lifecycle.recovery ? recoverRun(lifecycle.recovery) : null
      if (recovery !== null && options.taskInput) {
        options.taskInput.loopState = recovery.state
        if (recovery.nextRound !== null) options.taskInput.seedRound?.(recovery.nextRound)
      }
      if (recovery?.refusal) {
        narrate(`not dispatching: ${recovery.refusal}`)
        throw new Error(recovery.refusal)
      }
      translator.beginLeg({ resumed: choice.kind === 'resume' })
      if (choice.kind === 'completed') {
        legOutcome = { reason: 'completed' }
      } else if (recovery?.held) {
        // A clean verdict pair still bound to the current head is published as it stands: no review is dispatched again.
        narrate(`held clean verdict from round ${recovery.held.round} still covers the head; publishing it`)
        options.taskInput?.seedRound?.(recovery.held.round)
        const published = await actions['harness.publish']?.({
          nodeId: 'publish-ready-for-merge',
          action: 'harness.publish',
          results: {}
        })
        legOutcome =
          published?.exitCode === 0 ? { reason: 'completed' } : { reason: 'failed', error: 'publication failed' }
      } else {
        const developerFacts = options.developerFacts
        const runOptions: ProcessRunOptions = {
          process: options.process,
          question: `Task ${args.task}`,
          bindings: { actions, decisions: (await import('../executing/actions')).decisions, roles },
          checkpointer: saver,
          workingDirectoryRoot: options.repoRoot,
          // A revision continues the Developer's own session, as the standalone loop resumes it.
          continueSessions: ['develop'],
          envAllowlist: agentEnvAllowlist({
            extra: [
              LOG_FOLDER_ONLY_ENV,
              ...(options.allowUnixSockets === true ? [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV] : [])
            ]
          }),
          ...(developerFacts
            ? {
                stepPrompts: {
                  develop: async (rendered, results, context) =>
                    developerPrompt(rendered, await developerFacts(), results, context),
                  ...(options.taskInput?.reviewerPrompt
                    ? {
                        'code-review': async () => options.taskInput.reviewerPrompt!('reviewer'),
                        'security-review': async () => options.taskInput.reviewerPrompt!('security')
                      }
                    : {})
                }
              }
            : {}),
          spawnFn: reaper.spawnFn,
          control,
          onEvent: (event) => {
            const lifecycleEvent = event as NodeLifecycle
            if (lifecycleEvent.type === 'node:start') currentNode = lifecycleEvent.nodeId
            options.observe?.(lifecycleEvent)
            trace.onEvent(lifecycleEvent)
            translator.onEvent(lifecycleEvent)
          }
        }
        outcome = await (choice.kind === 'resume'
          ? resumeProcessRun(runOptions, identity)
          : startProcessRun(runOptions, identity))
        legOutcome = outcome as unknown as LegOutcome
        if (outcome.reason === 'failed') {
          // A step that threw is handed off like any other pause, keeping what the checkpoint holds.
          error = outcome.error
          legOutcome = { ...legOutcome, ...handOffError(outcome.error) }
        }
      }
      translator.endLeg(legOutcome as LegOutcome)
    }
    for (;;) {
      try {
        await runLeg()
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown)
        legOutcome = handOffError(error)
        translator.endLeg(legOutcome)
      }
      if (!lifecycle.watch || legOutcome?.reason !== 'paused' || signalled !== null) break
      narrate('the run is halted; watching for a newer ruling or a cancel')
      const watched = await watchForRuling(options.runtimeDir, args.task, lifecycle.watch, stopWatching.signal, narrate)
      if (watched.kind === 'ruled') narrate(`a newer ruling resumed escalation ${watched.escalationId}`)
      else if (watched.kind === 'cancelled') narrate('the pause was cancelled; ending')
      else if (watched.kind === 'consumed') narrate('another process claimed the resolution and owns the run; ending')
      else if (watched.kind === 'refused') narrate(`the resolution was refused: ${watched.message}`)
      if (watched.kind !== 'ruled') break
      control = createRunControl()
      reapOnHalt()
      handoff = makeHandoff()
      if (taskForHandoff) taskForHandoff.handoff = handoff
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
    legOutcome = handOffError(error)
    translator.endLeg(legOutcome)
  } finally {
    stopSignals()
    // No agent outlives the run: whatever a halted or finished launch left running is ended with its group.
    await reaper.reap(lifecycle.killGraceMs)
    // The exit is recorded once, before the sink drains, and the lock is kept or cleared by the shared rule.
    const exit = producers.exit({
      outcome: legOutcome ?? { reason: 'failed' },
      cancelled: signalled !== null,
      steps: {}
    })
    described = exit.lastDecision
    recordExit(exit.reason, {
      ...(signalled !== null
        ? { exitCode: SIGNAL_EXIT_CODE[signalled] }
        : exit.exitCode !== undefined
          ? { exitCode: exit.exitCode }
          : {}),
      ...(exit.failedStep ? { error: Object.assign(new Error('a step failed'), { code: STEP_FAILED }) } : {})
    })
    const lockOutcome = releaseDriverLock(options.runtimeDir, args.task, lockExitOf(exit))
    narrate(`driver exited (${exit.reason}, ${exit.lastDecision}); driver lock ${lockOutcome}`)
    try {
      await Promise.all(hosts.map((host) => host.close()))
    } finally {
      try {
        await options.sink.drain()
      } finally {
        checkpointer?.close()
      }
    }
  }
  // The legs assign these from inside a closure, which the compiler's flow analysis does not follow.
  const finalOutcome = outcome as RunOutcome | null
  const results = (
    finalOutcome && 'checkpoint' in finalOutcome ? (finalOutcome.checkpoint?.results ?? {}) : {}
  ) as Record<string, StepNodeResult>
  const reason = (legOutcome as LegOutcome | null)?.reason ?? finalOutcome?.reason ?? 'failed'
  writeTrace(reason, results, error)
  const exitCode =
    signalled !== null ? SIGNAL_EXIT_CODE[signalled] : reason === 'completed' ? 0 : reason === 'paused' ? 2 : 1
  return { outcome: finalOutcome, exitCode, tracePath }
}

// --- the live wiring: forge, git and Log reached only from `main` -------------

function sh(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function refusal<T>(check: string, output: string): DevToolResult<T> {
  return {
    ok: false,
    error: {
      errorClass: 'internal',
      retryDisposition: 'same_attempt',
      effectState: 'not_started',
      check,
      output,
      fix: 'Read the output, correct the cause and call the tool again.'
    }
  }
}

/**
 * The Developer's live dev-tool context for this Engine run: the module the standalone loop builds its own
 * from, bound to this run's task, worktree and publication state. `beginTurn` records the head and base a
 * Developer turn starts from and builds that turn's context, as the standalone loop does at each dispatch.
 */
export function engineLiveDevToolsContext(input: {
  branch: string
  worktreePath: string
  task: number
  runtimeDir: string
  agent: Agent
  repo: { owner: string; repo: string } | null
  round: () => number
  /** The loop operations the context reads; the real ones unless a test supplies its own. */
  deps?: LiveDeveloperContextLoopDeps
}): {
  context: DevToolContext
  beginTurn: () => Promise<void>
  state: LivePublicationState
  /** The protected paths written since the turn began that no driver tool call wrote. */
  changedProtectedPaths: () => string[]
} {
  const deps = input.deps ?? defaultDeps()
  const state = createLivePublicationState(null)
  const storeDir = developerSourceStoreDir(input.runtimeDir, input.task)
  const scope: LivePublicationScope = {
    d: deps,
    task: input.task,
    branch: input.branch,
    repo: input.repo,
    worktree: input.worktreePath,
    runtimeRoot: input.runtimeDir,
    loopLogPath: loopLogPathFor(null, input.task, input.runtimeDir),
    state
  }
  let attribution: TurnWriteAttribution
  const buildTurnContext = (): DevToolContext => {
    attribution = startTurnWriteAttribution(
      protectedPathsForTurn({
        runtimeDir: input.runtimeDir,
        task: input.task,
        round: input.round(),
        role: 'developer',
        vinayaConfigPath: configPath()
      }),
      [taskControlDir(input.runtimeDir, input.task), sourceReceiptsPath(storeDir)]
    )
    return attributeDriverToolCalls(
      createLiveDeveloperContext({
        ...scope,
        agent: input.agent,
        round: input.round,
        helpers: { ownChangesRangeBase, defaultGitWorktreeUntrackedPaths, worktreeCheckEnv }
      }),
      attribution.driverToolCall
    )
  }
  let turn = buildTurnContext()
  const beginTurn = async (): Promise<void> => {
    turn = buildTurnContext()
    state.turnPreHead = deps.readWorktreeHead(input.worktreePath)
    state.turnPublicationRefusal = null
    state.turnPublicationAttempted = false
    await resolvePublicationBase(scope, state.turnPreHead)
  }
  const context: DevToolContext = {
    publishChanges: (header) => turn.publishChanges(header),
    openPullRequest: (title, body) => turn.openPullRequest(title, body),
    updatePullRequestBody: (body) => turn.updatePullRequestBody(body),
    refreshEvidence: () => turn.refreshEvidence(),
    readPullRequest: () => turn.readPullRequest(),
    runChecks: () => turn.runChecks(),
    fetchDocumentation: (request) => turn.fetchDocumentation(request)
  }
  return { context, beginTurn, state, changedProtectedPaths: () => attribution.changedPaths() }
}

/** The CLI entry script under `repoRoot`: the shim's bridge and the gate checks both run it. */
export const cliEntryOf = (repoRoot: string): string => join(repoRoot, 'apps', 'cli', 'src', 'index.ts')

/** The forge (and forge-backed git) reads and writes the live wiring makes; a replay replaces them. */
export interface EngineForge {
  findOpenPrForBranch: typeof findOpenPrForBranch
  fetchFrozenBrief: typeof fetchFrozenBrief
  resolveIssueObjectives: typeof resolveIssueObjectives
  fetchNewestRulingOrdinal: typeof fetchNewestRulingOrdinal
  fetchNewestIssueRulingOrdinal: typeof fetchNewestIssueRulingOrdinal
  fetchSourceRevision: typeof fetchSourceRevision
  fetchCiConclusion: typeof fetchCiConclusion
  fetchIssueRulingsAfterBrief: typeof fetchIssueRulingsAfterBrief
  fetchRulings: typeof fetchRulings
  fetchLoopHistory: typeof fetchLoopHistory
  resolveHead: typeof resolveHead
  resolveDeveloperDoctrineText: typeof resolveDeveloperDoctrineText
  /** The open pull request's body. */
  prBody: (prNumber: number) => string
  checkTaskDispatchReadiness: typeof checkTaskDispatchReadiness
  createTaskWorktree: typeof createTaskWorktree
  pullRequestView: typeof ghPullRequestView
  publishRound: typeof publishRound
}

export const liveForge: EngineForge = {
  findOpenPrForBranch,
  fetchFrozenBrief,
  resolveIssueObjectives,
  fetchNewestRulingOrdinal,
  fetchNewestIssueRulingOrdinal,
  fetchSourceRevision,
  fetchCiConclusion,
  fetchIssueRulingsAfterBrief,
  fetchRulings,
  fetchLoopHistory,
  resolveHead,
  resolveDeveloperDoctrineText,
  prBody: (prNumber) => sh('gh', ['pr', 'view', String(prNumber), '--json', 'body', '-q', '.body']),
  checkTaskDispatchReadiness,
  createTaskWorktree,
  pullRequestView: ghPullRequestView,
  publishRound
}

/** The per-task input the actions read: the branch, the Log events' loop and the verdict plumbing. */
export async function liveTaskInput(
  args: EngineArgs,
  repoRoot: string,
  /** Where run files go (`<runtimeDir>/tasks-execution/<task>/…`), never under `repoRoot`. */
  runtimeDir: string,
  loopId: string,
  lookups: {
    fetchTitle?: (n: number) => string
    fetchLabels?: (n: number) => string[]
    policy?: typeof reviewPolicyForLoop
    /** Replaces the forge and git reads the review input is staged from, for a run that must not reach them. */
    /** Replaces forge reads and writes, for a run that must not reach the forge. */
    forge?: Partial<EngineForge>
    reviewSources?: Partial<
      Pick<VinayaReviewInputDeps, 'judgedHead' | 'readHead' | 'baseOf' | 'brief' | 'prBody' | 'diff' | 'priorFindings'>
    >
  } = {}
): Promise<TaskInput & { stageReviewInput: (round: number) => VinayaStagedReviewInput | null }> {
  const forge: EngineForge = { ...liveForge, ...lookups.forge }
  // Tranche tasks live on `task/<tranche>/<n>`, backlog tasks on `task/issue-<n>`.
  const branch = developerBranchFor(args.task, lookups.fetchTitle, lookups.fetchLabels)
  const worktreePath = join(repoRoot, '.worktrees', branch)
  // The policy is read when first needed, never when this input is built: an unreadable policy pauses through the
  // handoff (the prepare-run step reports it) instead of throwing before the run starts.
  let readPolicy: ReturnType<typeof reviewPolicyForLoop> | null = null
  const policyNow = (): ReturnType<typeof reviewPolicyForLoop> => {
    if (readPolicy === null) readPolicy = (lookups.policy ?? reviewPolicyForLoop)()
    return readPolicy
  }
  let loopState: LoopState | null = null
  // The review round advances when a revision handoff reads the verdicts it answers.
  let round = 1
  const manifestAt = (headSha: string): ReviewInputManifest => {
    const pr = forge.findOpenPrForBranch(branch)
    let baseSha: string | null = null
    try {
      baseSha = sh('git', ['merge-base', 'origin/main', headSha], worktreePath)
    } catch {
      baseSha = null
    }
    return buildReviewInputManifest({
      headSha,
      baseSha,
      briefContent: forge.fetchFrozenBrief(args.task),
      objectivesVersion: forge.resolveIssueObjectives(args.task).version,
      rulingOrdinal: pr ? forge.fetchNewestRulingOrdinal(pr.number) : 0,
      policy: policyNow()
    })
  }
  const judgedHead = (): string => {
    const head = readWorktreeHead(worktreePath)
    if (head === null) throw new Error(`could not read the head of ${worktreePath}`)
    return head
  }
  const built = (role: HeldVerdictRole, review: ReviewResult) =>
    buildVerdictFromReview(
      role,
      review,
      args.agent === 'claude' ? 'claude' : 'codex',
      args.task,
      { exitCode: 0, durationMs: 0, usage: null } as never,
      manifestAt(judgedHead()),
      policyNow(),
      forge.resolveIssueObjectives(args.task).objectives
    )
  const verdictsOf = (results: Readonly<Record<string, StepNodeResult>>): VerdictObservation[] =>
    (
      [
        ['code-review', 'reviewer'],
        ['security-review', 'security']
      ] as const
    ).map(([step, role]) => {
      const parsed = parseReviewResult(agentOutput(results, step))
      if (!parsed.ok) throw new Error(`${step} output failed ${parsed.stage} validation: ${parsed.errors.join('; ')}`)
      return built(role, parsed.result).observation
    })
  // One staged review input per round: a copy of the task head plus the brief, PR body, diff and prior findings.
  const reviewInput = createVinayaReviewInputStager({
    root: runtimeDir,
    task: args.task,
    worktreePath,
    judgedHead,
    readHead: readWorktreeHead,
    baseOf: (head) => sh('git', ['merge-base', 'origin/main', head], worktreePath).trim(),
    brief: () => forge.fetchFrozenBrief(args.task),
    prBody: () => {
      const pr = forge.findOpenPrForBranch(branch)
      return pr ? forge.prBody(pr.number) : ''
    },
    diff: (base, head) => sh('git', ['diff', `${base}...${head}`], worktreePath),
    ...lookups.reviewSources
  })
  const reviewerPrompt = (role: HeldVerdictRole): string => {
    const staged = reviewInput.stage(round)
    const objectives = forge.resolveIssueObjectives(args.task)
    const facts: ReviewerPromptFacts = {
      objectives: objectives.text,
      resolvedObjectives: objectives.objectives,
      // As the standalone loop's review round: the Issue's rulings after the brief then the pull request's,
      // and the forge's CI conclusion for the judged head (`fetchCiConclusion`).
      rulings: reviewerRulings({
        task: args.task,
        prNumber: forge.findOpenPrForBranch(branch)?.number ?? null,
        fetchIssueRulingsAfterBrief: forge.fetchIssueRulingsAfterBrief,
        fetchRulings: forge.fetchRulings
      }),
      ciConclusion: forge.fetchCiConclusion(judgedHead()),
      revision: forge.fetchSourceRevision(args.task),
      manifest: manifestAt(judgedHead()),
      policy: policyNow()
    }
    return renderVinayaReviewerPrompt(role, facts, staged)
  }
  return {
    reviewerPrompt,
    stageReviewInput: (n) => reviewInput.stage(n),
    runtimeDir,
    cliEntry: cliEntryOf(repoRoot),
    branch,
    issueNumber: args.task,
    worktreePath,
    developerContext: { knownFindingIds: [], requiredSources: [] },
    bound: {
      checkTaskDispatchReadiness: forge.checkTaskDispatchReadiness,
      createTaskWorktree: forge.createTaskWorktree,
      fetchSourceRevision: forge.fetchSourceRevision,
      pullRequestView: forge.pullRequestView,
      findOpenPrForBranch: forge.findOpenPrForBranch,
      publishRound: forge.publishRound
    },
    get loopState(): LoopState {
      if (loopState !== null) return loopState
      // Recovery reads this before the Flow starts. An unreadable policy must not throw here: the state is built from
      // the default caps without being kept, and prepare-run then pauses on the policy with its own detail.
      let policy: ReturnType<typeof reviewPolicyForLoop>
      try {
        policy = policyNow()
      } catch {
        return initialLoopState({
          loopId,
          task: args.task,
          reviewers: ['reviewer', 'security'],
          models: {},
          maxRounds: DEFAULT_REVIEW_POLICY.maxRounds,
          maxTaskMinutes: DEFAULT_REVIEW_POLICY.maxTaskMinutes
        })
      }
      const config: LoopConfig = {
        loopId,
        task: args.task,
        reviewers: ['reviewer', 'security'],
        models: {},
        maxRounds: policy.maxRounds,
        maxTaskMinutes: policy.maxTaskMinutes
      }
      loopState = initialLoopState(config)
      return loopState
    },
    set loopState(next: LoopState) {
      loopState = next
    },
    repoRoot,
    reviewPolicy: policyNow,
    prepareSources: async () => {
      const brief = forge.fetchFrozenBrief(args.task)
      const headSha = readWorktreeHead(worktreePath) ?? sh('git', ['rev-parse', 'origin/main'], repoRoot)
      return prepareSources({
        brief,
        round,
        base: extractSourceRevision(brief) ?? headSha,
        storeDir: developerSourceStoreDir(runtimeDir, args.task),
        deps: realSourceProviderDeps(worktreePath)
      })
    },
    // Read when a pause is raised. A failed Issue read propagates: recording a ruling baseline of zero would
    // let any earlier ruling authenticate this pause's resume, so no escalation record is written instead.
    inputVersions: () => {
      const pr = forge.findOpenPrForBranch(branch)
      let objectivesVersion: string | null = null
      try {
        objectivesVersion = forge.resolveIssueObjectives(args.task).version
      } catch {}
      return {
        briefHash: briefHashOf(forge.fetchFrozenBrief(args.task)),
        objectivesVersion,
        rulingOrdinal: pr ? forge.fetchNewestRulingOrdinal(pr.number) : forge.fetchNewestIssueRulingOrdinal(args.task),
        // An unreadable policy has no digest; the pause that reports it still records the rest.
        policyDigest: (() => {
          try {
            return policyDigestOf(policyNow())
          } catch {
            return 'unknown'
          }
        })()
      }
    },
    reviewRound: () => round,
    // A re-run numbers its first round after the rounds the forge already holds; never backwards.
    seedRound: (next) => {
      round = Math.max(round, next)
    },
    currentManifest: () => {
      try {
        return manifestAt(judgedHead())
      } catch {
        return null
      }
    },
    observe: (results): Observations => ({ kind: 'verdicts', round, verdicts: verdictsOf(results) }),
    verdicts: (results) => {
      const verdicts = verdictsOf(results)
      round += 1
      return verdicts
    },
    renderVerdict: (role, review) => built(role, review).rendered,
    publish: (at) => ({
      task: args.task,
      ...at,
      journal: forge.fetchLoopHistory(at.prNumber),
      policy: policyNow(),
      manifest: manifestAt(at.expectedHead)
    })
  }
}

/** Where the Developer's required sources are stored for `task`: under the runtime directory, never the repository. */
export const developerSourceStoreDir = (runtimeDir: string, task: number): string => sourceStoreDir(runtimeDir, task)

/** The Developer's prompt facts as the review loop reads them for the same Issue, read when its step starts. */
export function liveDeveloperFacts(input: {
  forge?: Partial<EngineForge>
  policy?: typeof reviewPolicyForLoop
  task: number
  repoRoot: string
  runtimeDir: string
  branch: string
  worktreePath: string
  round: () => number
  /** The refusal the Developer's last publication met, read each time the step starts. */
  lastPushRefusal?: () => string | null
}): () => Promise<DeveloperPromptFacts> {
  const { task, repoRoot, runtimeDir, branch, worktreePath } = input
  const forge: EngineForge = { ...liveForge, ...input.forge }
  return async () => {
    const policy = (input.policy ?? reviewPolicyForLoop)()
    const brief = forge.fetchFrozenBrief(task)
    const headSha = readWorktreeHead(worktreePath) ?? sh('git', ['rev-parse', 'origin/main'], repoRoot)
    let baseSha: string
    try {
      baseSha = sh('git', ['merge-base', 'origin/main', headSha], worktreePath)
    } catch {
      baseSha = sh('git', ['rev-parse', 'origin/main'], repoRoot)
    }
    const pr = forge.findOpenPrForBranch(branch)
    const rulings = pr ? forge.fetchRulings(pr.number) : forge.fetchIssueRulingsAfterBrief(task)
    const round = input.round()
    const storeDir = developerSourceStoreDir(runtimeDir, task)
    const prepared = await prepareSources({
      brief,
      round,
      base: extractSourceRevision(brief) ?? headSha,
      storeDir,
      deps: realSourceProviderDeps(worktreePath)
    })
    if (prepared.unavailable.length > 0) throw new RequiredSourcesUnavailable(prepared.unavailable)
    for (const receipt of injectedDeliveryReceipts(prepared.manifest, new Date().toISOString()))
      appendSourceDeliveryReceipt(sourceReceiptsPath(storeDir), receipt)
    return {
      brief,
      objectives: forge.resolveIssueObjectives(task),
      rulings,
      rulingOrdinal: pr ? forge.fetchNewestRulingOrdinal(pr.number) : forge.fetchNewestIssueRulingOrdinal(task),
      policy,
      baseSha,
      headSha,
      sources: {
        block: requiredSourcesPromptBlock(prepared.manifest),
        evidence: prepared.manifest.sources.map((source) => ({
          ref: `source:${source.sourceId}`,
          version: source.contentDigest ?? source.snapshotRef ?? 'unavailable'
        }))
      },
      round,
      doctrine: await (async () => {
        try {
          return await forge.resolveDeveloperDoctrineText()
        } catch {
          return null
        }
      })(),
      issueRulings: (() => {
        try {
          return forge.fetchIssueRulingsAfterBrief(task)
        } catch {
          return []
        }
      })(),
      keptWork: readUnpublishedWork(worktreePath),
      lastPushRefusal: input.lastPushRefusal?.() ?? null,
      resume: {
        task,
        branch,
        worktree: worktreePath,
        remoteHead: (() => {
          try {
            return forge.resolveHead(branch)
          } catch {
            return null
          }
        })()
      },
      heldReview: heldReviewOf(runtimeDir, task, round - 1)
    }
  }
}

/** The worktree's unpublished work, as the loop reads it (`git status --porcelain`, commits ahead of upstream). */
export function readUnpublishedWork(worktreePath: string): { dirtyFiles: string[]; aheadCount: number } | null {
  if (!existsSync(worktreePath)) return null
  let dirtyFiles: string[] = []
  try {
    dirtyFiles = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3))
  } catch {}
  let aheadCount = 0
  try {
    const parsed = Number.parseInt(sh('git', ['-C', worktreePath, 'rev-list', '--count', '@{u}..HEAD']), 10)
    aheadCount = Number.isFinite(parsed) ? parsed : 0
  } catch {}
  return { dirtyFiles, aheadCount }
}

/** A round's held review verdicts, rendered as the loop hands them on: the reviewer's, then the security reviewer's. */
export function heldReviewOf(runtimeDir: string, task: number, round: number): string | null {
  if (round < 1) return null
  const read = (role: 'reviewer' | 'security') => {
    const path = heldVerdictPath(runtimeDir, task, round, role)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  const reviewer = read('reviewer')
  const security = read('security')
  if (reviewer === null && security === null) return null
  return `${reviewer ?? ''}\n\n---\n\n${security ?? ''}`
}

/** The GitHub repository the checkout's origin names, or null when it names none. */
function liveRepo(): { owner: string; repo: string } | null {
  try {
    const match = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(sh('git', ['remote', 'get-url', 'origin']))
    return match ? { owner: match[1] as string, repo: match[2] as string } : null
  } catch {
    return null
  }
}

async function liveRuntimeDir(): Promise<string> {
  const fromEnv = process.env[RUNTIME_DIR_ENV_KEY]
  if (fromEnv) return fromEnv
  const repo = liveRepo()
  return repo ? runtimeDirForRepoAsync(repo) : join(homedir(), '.vinaya', 'runtime')
}

/** What a re-run of the live task reads: the forge, the prior launch record and the held verdicts on disk. */
export function liveRecovery(input: {
  args: EngineArgs
  runtimeDir: string
  taskInput: Awaited<ReturnType<typeof liveTaskInput>>
  forge?: Partial<EngineForge>
  repo?: { owner: string; repo: string } | null
}): RecoveryDeps {
  const forge: EngineForge = { ...liveForge, ...input.forge }
  const { args, runtimeDir, taskInput } = input
  return {
    prNumber: () => forge.findOpenPrForBranch(taskInput.branch)?.number ?? null,
    fetchLoopHistory: forge.fetchLoopHistory,
    loopState: () => taskInput.loopState,
    readLaunch: () =>
      readLaunchRecord('developer', args.agent, input.repo === undefined ? liveRepo() : input.repo, args.task),
    launchDeps: realLaunchDeps(getProcessSnapshot, terminateChildWithGrace),
    heldVerdict: () => latestHeldCleanVerdict(runtimeDir, args.task),
    currentManifest: () => taskInput.currentManifest?.() ?? null,
    patchIdOf: defaultPatchIdOf
  }
}

/** Engine events use the shared sink with delivery restricted to its local folder. */
export function createEngineLogSink(overrides: Partial<LogSinkDeps> = {}) {
  return createLogSink({ ...overrides, folderOnly: true })
}

/** Apply before any Engine act so CLI children and their own children inherit local-only recording. */
export function configureEngineLogEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  env[LOG_FOLDER_ONLY_ENV] = '1'
}

/** Runs one task on the Engine against the live forge, git and Log. */
async function runLive(args: EngineArgs, loaded: LoadedProcess, repoRoot: string, runtimeDir: string): Promise<number> {
  configureEngineLogEnvironment()
  setEngineLogIdentity(loaded)
  const sink = createEngineLogSink()
  const loopId = randomUUID()
  process.env.VINAYA_RUN = loopId
  const taskInput = await liveTaskInput(args, repoRoot, runtimeDir, loopId)
  const liveContext = engineLiveDevToolsContext({
    branch: taskInput.branch,
    worktreePath: taskInput.worktreePath,
    task: args.task,
    runtimeDir,
    agent: args.agent,
    repo: liveRepo(),
    round: taskInput.reviewRound
  })
  const result = await runEngine({
    args,
    process: loaded,
    repoRoot,
    runtimeDir,
    loopId,
    taskInput,
    sink,
    startHost: startDevToolsHost,
    developerFacts: liveDeveloperFacts({
      task: args.task,
      repoRoot,
      runtimeDir,
      branch: taskInput.branch,
      worktreePath: taskInput.worktreePath,
      round: taskInput.reviewRound,
      lastPushRefusal: () => liveContext.state.lastPushRefusal
    }),
    allowUnixSockets: linuxUnixSocketFilterOptIn(),
    lifecycle: {
      dispatchConfig: loadConfig()?.dispatch,
      recovery: liveRecovery({ args, runtimeDir, taskInput }),
      watch: { deps: liveResumeDeps, pollMs: rulingPollMs(), sleep: abortableSleep }
    },
    devToolsContext: liveContext.context,
    beginDeveloperTurn: liveContext.beginTurn
  })
  // The handoff's escalation record logs through the default sink, which nothing else drains.
  await drainLogSink()
  return result.exitCode
}

export async function main(argv: readonly string[]): Promise<number> {
  const repoRoot = resolve(import.meta.dir, '../../..')
  const loaded = loadProcess(resolve(import.meta.dir, '..'))
  const runtimeDir = await liveRuntimeDir()
  if (argv.includes('--resume')) {
    const args = parseResumeArgs(argv)
    const result = await resumeEngine({
      args,
      runtimeDir,
      run: async (resolved) => ({
        outcome: null,
        exitCode: await runLive(resolved, loaded, repoRoot, runtimeDir),
        tracePath: ''
      })
    })
    return result.exitCode
  }
  const args = parseArgs(argv)
  const runDir = runDirectory(runtimeDir, args.task)
  if (args.dryRun) {
    const lines = await dryRunLines({
      process: loaded,
      agent: args.agent,
      generatedRoot: mkdtempSync(join(tmpdir(), 'engine-dry-run-')),
      shimPath: join(runDir, 'dev-bridge.sh')
    })
    for (const line of lines) process.stdout.write(`${line}\n`)
    return 0
  }
  return runLive(args, loaded, repoRoot, runtimeDir)
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
  )
}
