#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  initialLoopState,
  buildReviewInputManifest,
  DEFAULT_REVIEW_POLICY,
  type DevReviewLoopEventInput,
  type LoopConfig,
  type LoopState,
  type ReviewInputManifest
} from '@attalabs/aeg-core'
import {
  createRunControl,
  type RunControl,
  type RunOutcome,
  type SpawnedProcessLike,
  type SpawnFn,
  type StepNodeResult
} from '@atta/executor-agent-spawn'
import { sessionIdOf } from '../../../harness/adapters/agents/structured-result'
import { loadProcess, type LoadedProcess } from '../../../harness/dev-process/loader/load-process'
import { SqliteCheckpointer } from '../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import {
  resumeProcessRun,
  startProcessRun,
  type ActionRegistry,
  type ProcessRunOptions,
  type RoleLauncher
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
  conflictReentryBoundDetail,
  fetchCiConclusion,
  fetchConflictingFiles,
  fetchFailedCheckWorkflowRunIds,
  fetchFailingCheckRuns,
  fetchMergeableState,
  fetchPrState,
  MAX_AUTOMATIC_CONFLICT_REENTRIES,
  readWorktreeHead,
  rerunFailedWorkflowJobs,
  resolveHead
} from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { postMarkedComment } from '../../../apps/cli/src/lib/forge-write'
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
  currentRunGeneration,
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
  watchPublishedPullRequest,
  type PublishedWatch,
  type RecoveryDeps,
  type ResumeDeps,
  type RulingWatch
} from './run-lifecycle'
import {
  conflictReentryEvent,
  createDriverExitRecorder,
  DRIVER_HEARTBEAT_INTERVAL_MS,
  defaultSetHeartbeat,
  emitDriverHeartbeat
} from '../../../apps/cli/src/lib/dev-review-loop/driver-lifecycle'
import {
  clearDriverLock,
  isDriverPidAlive,
  readPauseState
} from '../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import {
  appendLoopLogLine,
  appendRoleLine,
  appendRunStartMarker,
  loopLogPathFor,
  narrateDriverEvent
} from '../../../apps/cli/src/lib/loop-log'
import { type AgentStreamRenderer, createAgentStreamRenderer } from '../../../apps/cli/src/lib/agent-stream'
import { CLI_ENTRY_ENV } from '../../../apps/cli/src/lib/cli-entry'
import { pollMergeableState } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { developerTurnResultJsonSchema } from '../../../apps/cli/src/lib/developer-turn-result'
import {
  getProcessSnapshot,
  readLaunchRecord,
  completeRunnerDeveloperLaunch,
  recordRunnerDeveloperLaunch,
  renderClaudeEvent,
  renderCodexEvent,
  terminateChildWithGrace
} from '../../../apps/cli/src/lib/dispatch'
import { loadConfig } from '../../../apps/cli/src/lib/config'
import { crossRunnerRefusal, recordTaskRunner } from '../../../apps/cli/src/lib/task-run-engine'
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
  describeObjectivesEdit,
  resolveIssueObjectives,
  reviewPolicyForLoop
} from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { fetchLoopHistory } from '../../../apps/cli/src/lib/dev-review-loop/journal-history'
import {
  buildVerdictFromReview,
  heldVerdictPath,
  latestHeldCleanVerdict,
  persistManifestRecord
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
import { resolveRoleDoctrineText } from '../../../apps/cli/src/roles/plan'
import { developerPrompt, type DeveloperPromptFacts } from '../executing/developer-prompt'
import {
  ACTION_BINDINGS,
  AGENT_EXIT_EVENT,
  agentOutput,
  createActions,
  gatePollOf,
  recordedDispatch,
  recordedScanOutcome,
  recordedVerdicts,
  type BoundFunctions,
  createRoleLaunchers,
  sandboxProbePlanFor,
  worktreeStats,
  type HeldVerdictRole,
  type ReviewRoundInputs,
  type TaskInput
} from '../executing/actions'
import { createV2Actions, V2_ACTION_BINDINGS, V2_DECISIONS } from '../executing/v2-actions'
import { liveV2Functions, stagedPullRequestStore, storagePushLogEvent, withV2DevTools } from './flow-v2-live'
import { readUnpushedWorkDetail, type UnpushedWork } from '../../../apps/cli/src/lib/dev-review-loop/unpushed-work'

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
  /** The flow key the run chooses (`v1`, `v2`); absent takes the process's default flow. */
  flow?: string
}

const USAGE = 'Usage: run-engine.ts --task <n> --agent <claude|codex> [--model <id>] [--flow <key>] [--dry-run]'

/** A flow key as the process contract spells one. */
const FLOW_KEY = /^[a-z0-9][a-z0-9-]*$/

export function parseArgs(argv: readonly string[]): EngineArgs {
  let task: number | undefined
  let agent: Agent | undefined
  let dryRun = false
  let model: string | undefined
  let flow: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--dry-run') dryRun = true
    else if (flag === '--flow') {
      const value = argv[++i] ?? ''
      if (!FLOW_KEY.test(value)) throw new Error(`--flow takes a flow key such as v1 or v2. ${USAGE}`)
      flow = value
    } else if (flag === '--task') {
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
  return { task, agent, dryRun, ...(model ? { model } : {}), ...(flow ? { flow } : {}) }
}

export interface ResumeArgs {
  /** The pull request whose `Closes` line names the task. */
  resume: number
  agent?: Agent
  /** The model for the resumed run; absent takes the one the run's checkpoint recorded. */
  model?: string
  /** The flow key for the resumed run; absent takes the one the run recorded. A different one is refused. */
  flow?: string
}

const RESUME_USAGE = 'Usage: run-engine.ts --resume <pr> [--agent <claude|codex>] [--model <id>] [--flow <key>]'

export function parseResumeArgs(argv: readonly string[]): ResumeArgs {
  let resume: number | undefined
  let agent: Agent | undefined
  let model: string | undefined
  let flow: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--flow') {
      const value = argv[++i] ?? ''
      if (!FLOW_KEY.test(value)) throw new Error(`--flow takes a flow key such as v1 or v2. ${RESUME_USAGE}`)
      flow = value
    } else if (flag === '--resume') {
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
  return { resume, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(flow ? { flow } : {}) }
}

/** The model the newest checkpoint of the task's run recorded; undefined when the run has none or left the vendor's default. */
export function recordedCheckpointModel(runtimeDir: string, task: number): string | undefined {
  const file = checkpointPath(runDirectory(runtimeDir, task))
  if (!existsSync(file)) return undefined
  const saver = new SqliteCheckpointer({ path: file, revision: 'unknown' })
  try {
    const model = saver.latestProvenance(runIdentityOfTask(task, currentRunGeneration(saver, task)).threadId)?.model
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
  const flow = resumeFlow(input.args.flow, recordedRunFlow(input.runtimeDir, claim.task))
  return input.run({
    task: claim.task,
    agent: claim.agent,
    dryRun: false,
    ...(model ? { model } : {}),
    ...(flow ? { flow } : {})
  })
}

/** Where a run records the flow it chose: `<run directory>/flow.json`, the run's provenance of which flow it runs. */
export const runFlowPath = (runtimeDir: string, task: number): string =>
  join(runDirectory(runtimeDir, task), 'flow.json')

/** Records the flow key a run chose, so its resume continues the same flow. */
export function recordRunFlow(runtimeDir: string, task: number, flow: string): void {
  mkdirSync(runDirectory(runtimeDir, task), { recursive: true })
  writeFileSync(runFlowPath(runtimeDir, task), `${JSON.stringify({ schemaVersion: 1, flow })}\n`)
}

/** The flow key the task's run recorded; undefined when it recorded none (a run from before flows were chosen ran v1). */
export function recordedRunFlow(runtimeDir: string, task: number): string | undefined {
  try {
    const value = JSON.parse(readFileSync(runFlowPath(runtimeDir, task), 'utf8')) as {
      schemaVersion?: number
      flow?: unknown
    }
    return value.schemaVersion === 1 && typeof value.flow === 'string' && value.flow !== '' ? value.flow : undefined
  } catch {
    return undefined
  }
}

/** The flow a resume runs: the recorded one; a named one only when it agrees or nothing was recorded. */
export function resumeFlow(named: string | undefined, recorded: string | undefined): string | undefined {
  if (named !== undefined && recorded !== undefined && named !== recorded) {
    throw new Error(
      `run-engine: this run recorded flow ${recorded}; a resume continues that flow and never switches to ${named}.`
    )
  }
  return named ?? recorded
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
    const binding = ACTION_BINDINGS[step.action] ?? V2_ACTION_BINDINGS[step.action]
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

/** Where a run's own Flow is written: the checked-in one with the run's policy ceilings, under its run directory. */
export const renderedFlowPath = (runDir: string): string => join(runDir, 'dev-review.flow.yaml')

/**
 * The process with its Flow rendered for one run: every decision's `max_revisions` set to the review policy's
 * `maxRounds`, written under the run directory, and that file the process's Flow. The checked-in Flow keeps literal
 * numbers, which the loader requires; the run compiles the rendered one. A cap that is not a positive whole number
 * leaves the process as it is, since no Flow can carry it.
 */
export function withPolicyCeilings(loaded: LoadedProcess, runDir: string, maxRounds: number): LoadedProcess {
  if (!Number.isInteger(maxRounds) || maxRounds < 1) return loaded
  const flow = parseYaml(readFileSync(loaded.flowPath, 'utf8')) as {
    steps: Array<{ decision?: { max_revisions?: number } }>
  }
  for (const step of flow.steps) if (step.decision) step.decision.max_revisions = maxRounds
  mkdirSync(runDir, { recursive: true })
  const flowPath = renderedFlowPath(runDir)
  writeFileSync(flowPath, stringifyYaml(flow))
  return { ...loaded, flowPath }
}

/**
 * A launch that lets a reviewer process exit non-zero without failing its step: the exit is appended to its output
 * as one `AGENT_EXIT_EVENT` record and reported as zero, so the reviewer-output step classifies the attempt
 * (`classifyReviewOutcome`) and retries it as the standalone loop does. Every other launch, and a killed process,
 * is passed through as it is.
 */
const STDERR_TAIL_CHARS = 500

export function tolerateReviewerExit(
  spawnFn: SpawnFn,
  isReviewer: (args: readonly string[], env: Readonly<Record<string, string | undefined>> | undefined) => boolean
): SpawnFn {
  return (command, args, options) => {
    const child = spawnFn(command, args, options)
    if (!isReviewer(args, options?.env)) return child
    const stdoutListeners: Array<(chunk: Buffer | string) => void> = []
    const closeListeners: Array<(code: number | null) => void> = []
    // The last of what the process wrote to stderr, so a failed launch names its own reason.
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS)
    })
    // One close handler on the process: the marker reaches the output before any listener learns of the exit.
    child.on('close', (code) => {
      if (code !== null && code !== 0) {
        const stderr = stderrTail.trim()
        const marker = `${JSON.stringify({ type: AGENT_EXIT_EVENT, exit_code: code, ...(stderr === '' ? {} : { stderr }) })}\n`
        for (const write of stdoutListeners) write(marker)
      }
      for (const listener of closeListeners) listener(code === null ? null : 0)
    })
    const wrapped: SpawnedProcessLike = {
      stdin: child.stdin,
      stderr: child.stderr,
      stdout: child.stdout && {
        on: (event: 'data', listener: (chunk: Buffer | string) => void) => {
          stdoutListeners.push(listener)
          child.stdout?.on(event, listener)
        }
      },
      on: ((event: 'close' | 'error', listener: (value: never) => void) => {
        if (event === 'close') closeListeners.push(listener as (code: number | null) => void)
        else child.on('error', listener as (err: Error) => void)
      }) as SpawnedProcessLike['on'],
      kill: (signal?: NodeJS.Signals) => child.kill(signal)
    }
    // The reaper and the executor read the process id from the launch itself.
    const pid = (child as { pid?: unknown }).pid
    return (typeof pid === 'number' ? Object.assign(wrapped, { pid }) : wrapped) as SpawnedProcessLike
  }
}

/** Whether a launch is one of the reviewer roles' generated launches under `generatedRoot`. */
export function isReviewerLaunch(generatedRoot: string) {
  const roots = ['code-reviewer', 'security-reviewer'].map((role) => join(generatedRoot, role))
  return (args: readonly string[], env: Readonly<Record<string, string | undefined>> | undefined): boolean =>
    roots.some(
      (root) =>
        (env?.CODEX_HOME !== undefined && env.CODEX_HOME === root) || args.some((arg) => arg.startsWith(`${root}/`))
    )
}

/** The role whose generated launch a spawn is, matched by its `CODEX_HOME` or a path argument under that role's root. */
function launchRoleOf<Role extends string>(
  roots: Readonly<Record<Role, string>>,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> | undefined
): Role | undefined {
  return (Object.entries(roots) as Array<[Role, string]>).find(
    ([, root]) => env?.CODEX_HOME === root || args.some((arg) => arg.startsWith(`${root}/`))
  )?.[0]
}

/**
 * Gives each reviewer launch the scratch directory prepared for that role's current attempt, and the Developer its
 * task worktree: the Flow's agent steps all start at the target repository's root, which is the default branch's
 * checkout, never where the Developer works.
 */
export function withReviewerWorkingDirectory(
  spawnFn: SpawnFn,
  generatedRoot: string,
  directoryFor: (role: HeldVerdictRole | 'developer') => string | null
): SpawnFn {
  const roots = {
    reviewer: join(generatedRoot, 'code-reviewer'),
    security: join(generatedRoot, 'security-reviewer'),
    developer: join(generatedRoot, 'developer')
  } as const
  return (command, args, options) => {
    const role = launchRoleOf(roots, args, options?.env)
    const directory = role ? directoryFor(role) : null
    return spawnFn(command, args, directory ? { ...options, cwd: directory } : options)
  }
}

/** Builds the renderer for one agent launch from the vendor and the directory the launch runs in. */
export type AgentRendererFor = (agent: Agent, worktree: string) => AgentStreamRenderer

/** The standalone dispatch's own renderer: the vendor's translator, falling back to its `renderEvent`. */
const standaloneRendererFor: AgentRendererFor = (agent, worktree) =>
  createAgentStreamRenderer(
    agent,
    { worktree, home: homedir() },
    agent === 'claude' ? renderClaudeEvent : renderCodexEvent
  )

/**
 * Tees each agent launch's stdout into the task's driver log while the agent runs, as the standalone dispatch does:
 * each complete line through that launch's agent-stream renderer, each rendered line written with `appendRoleLine`
 * under the role name the standalone dispatch gives it. The tee is a second `data` listener, so the executor's own
 * reader still gets every byte; a line that fails to render, and any other failure here, is dropped. A launch that is
 * none of the roles' generated launches is passed through untouched.
 */
export function withAgentNarration(
  spawnFn: SpawnFn,
  generatedRoot: string,
  narration: { agent: Agent; logPath: string; rendererFor?: AgentRendererFor }
): SpawnFn {
  const roots = {
    developer: join(generatedRoot, 'developer'),
    'code-reviewer': join(generatedRoot, 'code-reviewer'),
    security: join(generatedRoot, 'security-reviewer')
  } as const
  return (command, args, options) => {
    const child = spawnFn(command, args, options)
    try {
      const role = launchRoleOf(roots, args, options?.env)
      if (role === undefined || !child.stdout) return child
      const renderer = (narration.rendererFor ?? standaloneRendererFor)(narration.agent, options?.cwd ?? process.cwd())
      const decoder = new StringDecoder('utf8')
      // Whatever has arrived since the last complete line: a chunk can split one.
      let carry = ''
      child.stdout.on('data', (chunk: Buffer | string) => {
        try {
          carry += typeof chunk === 'string' ? chunk : decoder.write(chunk)
          const lines = carry.split('\n')
          carry = lines.pop() ?? ''
          for (const line of lines) {
            if (line.trim().length === 0) continue
            try {
              for (const { words, mark, details } of renderer.render(JSON.parse(line) as Record<string, unknown>))
                appendRoleLine(narration.logPath, role, words, details, mark)
            } catch {
              // Not a JSON line, or a renderer that refused it: narration never ends the run it observes.
            }
          }
        } catch {}
      })
    } catch {}
    return child
  }
}

/**
 * The runner's Log sink, each event narrated into the driver log right after it is emitted, with the events
 * narrated before it as context: what the standalone loop's `logEvents` does after each event it writes. The
 * translator and the runner share the one wrapped sink, so no event is narrated twice; a narration failure is dropped.
 * A conflict re-entry is narrated with no earlier events, as the standalone's watching driver narrates its own.
 */
export function narratingLog(
  log: (event: unknown) => void,
  logPath: string,
  task: number,
  narrateEvent: typeof narrateDriverEvent = narrateDriverEvent
): (event: unknown) => void {
  const narrated: unknown[] = []
  return (event) => {
    log(event)
    try {
      const reentry = (event as { event?: unknown } | null)?.event === 'conflict_reentry'
      narrateEvent(logPath, event, reentry ? [] : narrated, task)
    } catch {}
    narrated.push(event)
  }
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
  /** The repository the task runs in. */
  repoRoot: string
  /** Where the shim's CLI entry is found: the Vinaya install. Defaults to `repoRoot`, which is the install when Vinaya runs on itself. */
  cliRoot?: string
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
  /** Called when a newer ruling resumes the halted run, so the next Developer turn carries the rulings' text. */
  onRulingResume?: () => void
  /** Whether the pull request a held verdict would publish is in conflict; the live forge read unless a test supplies its own. */
  heldPullRequestConflicts?: () => Promise<boolean>
  /** Called with the Developer's vendor session once its turn's agent has finished. */
  completeDeveloperTurn?: (resumeId: string | null) => void
  /** The Linux host opt-in: the generated Claude settings allow Unix sockets and the variable is forwarded to the agent. */
  allowUnixSockets?: boolean
  /** The code revision recorded on every checkpoint; defaults to the HEAD of `repoRoot`, the checkout the runner runs from. */
  revision?: string
  /** What the runner does around the run; every member defaults to the live behaviour. */
  lifecycle?: EngineLifecycleOptions
  /** Replaces the writers and forge posts a pause hands off to; for a run that must not reach them. */
  handoffDeps?: HandoffDeps
  /** Replaces the driver log's agent-stream renderer or event narration; the standalone loop's own by default. */
  narration?: { rendererFor?: AgentRendererFor; narrateEvent?: typeof narrateDriverEvent }
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
  /**
   * After a run that completed, watches its pull request until it is merged or closed, and starts a fresh run on a
   * conflict with the default branch; absent ends the runner at completion.
   */
  publishedWatch?: PublishedWatch
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

/**
 * Runs the task on the Engine, its Log events naming the task, the `loop`
 * host and, once found, the pull request, as the standalone driver's do; the
 * caller's own values are restored afterwards.
 */
export async function runEngine(options: EngineRunOptions): Promise<EngineRunResult> {
  const saved = { task: process.env.VINAYA_TASK, host: process.env.VINAYA_HOST, pr: process.env.VINAYA_PR }
  process.env.VINAYA_TASK = String(options.args.task)
  if (saved.host === undefined) process.env.VINAYA_HOST = 'loop'
  delete process.env.VINAYA_PR
  try {
    return await runEngineLegs(options)
  } finally {
    for (const [key, value] of [
      ['VINAYA_TASK', saved.task],
      ['VINAYA_HOST', saved.host],
      ['VINAYA_PR', saved.pr]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Runs the task's legs. The host is closed and the sink drained on every way out. */
async function runEngineLegs(options: EngineRunOptions): Promise<EngineRunResult> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const { args } = options
  const lifecycle = options.lifecycle ?? {}
  out(`loopId ${options.loopId}`)
  const runDir = runDirectory(options.runtimeDir, args.task)
  mkdirSync(runDir, { recursive: true })
  const tracePath = join(runDir, 'trace.json')
  const trace = createTraceRecorder({ task: args.task, agent: args.agent, loopId: options.loopId })
  const producers = createVinayaLogProducers({
    loopId: options.loopId,
    task: args.task,
    baseHead: () => (options.taskInput ? worktreeStats(options.taskInput.worktreePath, 0).baseHead : null),
    flow: options.process.flowKey,
    head: () => (options.taskInput ? worktreeStats(options.taskInput.worktreePath, 0).head : null)
  })
  const logPath = loopLogPathFor(null, args.task, options.runtimeDir)
  // The translator's rows and the runner's own reach the sink through this one wrapper, each narrated once.
  const sinkLog = narratingLog(
    options.sink.log as unknown as (event: unknown) => void,
    logPath,
    args.task,
    options.narration?.narrateEvent
  )
  const translator = createLogTranslator(producers, sinkLog as unknown as EmitLogEvent)
  const narrate = (line: string): void => appendLoopLogLine(logPath, `${new Date().toISOString()}  ${line}`)
  let pausedFor: string | undefined
  const writeTrace = (
    outcome: string,
    results: Record<string, StepNodeResult>,
    error?: string,
    path: string = tracePath
  ): void => {
    // The trace carries tool output verbatim, so only its owner reads it.
    writeFileSync(path, `${JSON.stringify(trace.finish(outcome, results, error, pausedFor), null, 2)}\n`, {
      mode: 0o600
    })
    chmodSync(path, 0o600)
    out(`trace ${path}`)
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
    // The running driver owns `trace.json`; a refused start records itself beside it, never over it.
    const refusedPath = join(runDir, 'trace-refused.json')
    writeTrace('refused', {}, lock.message, refusedPath)
    return { outcome: null, exitCode: 1, tracePath: refusedPath }
  }
  // The task's run is this runner's from here: the Operator routes its controls by this record.
  recordTaskRunner(args.task, 'atta-engine', options.runtimeDir)

  // Each leg of a run has a run control of its own: a halted one cannot be run again.
  let control = options.control ?? createRunControl()
  const reaper = createChildReaper(options.spawnFn)
  // A halt ends the agents' whole process groups at once: the executor signals only the agent it spawned.
  const reapOnHalt = (): void =>
    control.signal.addEventListener('abort', () => void reaper.reap(lifecycle.killGraceMs), { once: true })
  reapOnHalt()
  const stopWatching = new AbortController()
  const log = (event: DevReviewLoopEventInput): void => sinkLog(event)
  // Standalone's shared sink drains handoff records after the driver's own
  // terminal events. Preserve that observable ordering on the Engine path.
  const deferredHandoffEvents: DevReviewLoopEventInput[] = []
  const handoffLog = (event: DevReviewLoopEventInput): void => {
    deferredHandoffEvents.push(event)
  }
  let currentNode: string | null = null
  let prNumber = 0
  let signalled: 'SIGINT' | 'SIGTERM' | null = null
  /** Set when the ruling watch found the pause resolved as a cancel: the run ends and leaves no lock. */
  let cancelledByWatch = false
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

  // A pull request any step finds is the run's from then on: its later Log events name it, as standalone's do.
  const notePullRequest = (pr: number): void => {
    prNumber = pr
    process.env.VINAYA_PR = String(pr)
  }
  const bound = options.taskInput?.bound
  const unwrappedFindPr = bound?.findOpenPrForBranch
  if (bound && unwrappedFindPr)
    bound.findOpenPrForBranch = (branch) => {
      const found = unwrappedFindPr(branch)
      if (found !== null) notePullRequest(found.number)
      return found
    }

  // Every pausing exit — a pause decision and an error alike — ends here: records, one comment, then the halt.
  const taskForHandoff = options.taskInput
  /** The open pull request on the run's branch, or null when none is or it cannot be read. */
  const openPullRequest = (): number | null => {
    const find = taskForHandoff?.bound?.findOpenPrForBranch
    try {
      return find && taskForHandoff?.branch ? (find(taskForHandoff.branch)?.number ?? null) : null
    } catch {
      return null
    }
  }
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
        // The Developer may have opened the pull request since the reconcile step looked.
        prNumber: () => (prNumber > 0 ? prNumber : openPullRequest()),
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
      options.handoffDeps ? { ...options.handoffDeps, log: handoffLog } : liveHandoffDeps(handoffLog)
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
        shimContent(socketPath, options.execPath ?? process.execPath, cliEntryOf(options.cliRoot ?? options.repoRoot))
      )
      chmodSync(shimPath, 0o755)
      mcpCommands[roleHost.role === 'security' ? 'security-reviewer' : roleHost.role] = shimPath
    }
    const roles: Record<string, RoleLauncher[string]> = {
      ...createRoleLaunchers({
        vendor: vendorOf(args.agent),
        generatedRoot: join(runDir, 'generated'),
        variables: options.taskInput?.worktreePath
          ? grantVariables(options.taskInput.worktreePath, runDir, options.repoRoot)
          : undefined,
        mcpCommands,
        model: args.model,
        allowUnixSockets: options.allowUnixSockets === true,
        stageCodexLogin: true,
        timeouts: roleTimeouts(lifecycle.dispatchConfig)
      })
    }
    // Each Developer launch carries the turn schema the standalone loop builds per turn: the task's current
    // required sources and known finding ids, never the static role schema (which allows no source use).
    if (options.taskInput?.developerContext && roles.developer) {
      roles.developer = withTurnSchema(roles.developer, join(runDir, 'generated', 'developer'), () =>
        developerTurnResultJsonSchema(options.taskInput.developerContext)
      )
    }
    // The Developer's sandbox is probed from the launch shape just generated, before the first agent step.
    if (options.taskInput && roles.developer) {
      const vendor = vendorOf(args.agent)
      const developer = roles.developer
      const { taskInput } = options
      taskInput.sandboxPlan = () =>
        sandboxProbePlanFor(vendor, developer, join(runDir, 'generated', 'developer'), taskInput.worktreePath)
    }
    // Every flow's shared actions, and version 2's own beside them; a flow binds only the ones it names.
    const base = options.actions ?? { ...createActions(options.taskInput), ...createV2Actions(options.taskInput) }
    // The pull request found by the reconcile step is the one the heartbeat reports.
    const noting: ActionRegistry = Object.fromEntries(
      Object.entries(base).map(([name, action]) => [
        name,
        async (context: Parameters<typeof action>[0]) => {
          // The step after the Developer's agent: its turn is over, so its launch record is closed with the session.
          if (context.nodeId === 'validate-developer-output') {
            const develop = context.results.develop as { sessionId?: string; events?: unknown[] } | undefined
            options.completeDeveloperTurn?.(develop?.sessionId ?? sessionIdOf(develop?.events ?? []) ?? null)
          }
          const result = await action(context)
          if (context.nodeId === 'reconcile-external-state') {
            try {
              const found = (JSON.parse(result.stdout ?? 'null') as { number?: unknown } | null)?.number
              if (typeof found === 'number') {
                notePullRequest(found)
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
    // The task's newest run: a completed one is watched, and a conflict on its pull request starts the next.
    let generation = currentRunGeneration(saver, args.task)
    let identity = runIdentityOfTask(args.task, generation)
    // This runner's automatic conflict re-entries of the published pull request.
    let conflictReentries = 0
    // The run compiles its own Flow, ceilings from the review policy; an unreadable policy leaves the checked-in one,
    // and the prepare-run step pauses on that policy before any decision is reached.
    const runProcess = (): LoadedProcess => {
      let maxRounds: number | undefined
      try {
        maxRounds = options.taskInput?.reviewPolicy?.()?.maxRounds
      } catch {
        maxRounds = undefined
      }
      return maxRounds === undefined ? options.process : withPolicyCeilings(options.process, runDir, maxRounds)
    }
    const runLeg = async (): Promise<void> => {
      outcome = null
      error = undefined
      pausedFor = undefined
      let choice = await chooseStart(saver, identity)
      // A checkpoint resume continues past steps it already ran, the mergeability check among them: when the pull
      // request is in conflict now, the run starts the next generation instead, as the conflict re-entry does, so the
      // Flow's mergeability step sends the conflict back to the Developer before any publication.
      if (
        choice.kind === 'resume' &&
        (await (options.heldPullRequestConflicts ?? heldPullRequestConflictsLive(options.taskInput))())
      ) {
        generation += 1
        identity = runIdentityOfTask(args.task, generation)
        narrate(
          `the pull request is in conflict with the default branch: starting a fresh run (${identity.runId}) instead of resuming the checkpoint`
        )
        choice = await chooseStart(saver, identity)
      }
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
            : choice.kind === 'exhausted'
              ? 'the checkpoint records a run that spent its round budget; a ruling continues it as a fresh run'
              : `no checkpoint; starting fresh${branch ? ` on branch ${branch}` : ''}`
      )
      const moved = choice.kind === 'resume' ? revisionMovedLine(choice.checkpointRevision, revision) : null
      if (moved !== null) narrate(moved)

      // What a re-run reads before it dispatches: the prior launch, the round journal and any held verdict.
      const recovery = lifecycle.recovery ? recoverRun(lifecycle.recovery) : null
      if (recovery !== null && options.taskInput) {
        options.taskInput.loopState = recovery.state
        // A checkpoint resume continues inside the round it stopped in, so it keeps that round; only a fresh start
        // on an existing branch begins the round after the journal's last.
        if (recovery.nextRound !== null && choice.kind !== 'resume') options.taskInput.seedRound?.(recovery.nextRound)
      }
      if (recovery?.refusal) {
        narrate(`not dispatching: ${recovery.refusal}`)
        throw new Error(recovery.refusal)
      }
      translator.beginLeg({ resumed: choice.kind === 'resume' })
      // A held verdict is published only while its pull request is not in conflict: a conflicting head runs the
      // Flow, whose mergeability step sends it back to the Developer before any publication.
      const heldUsable =
        choice.kind !== 'completed' &&
        recovery?.held !== undefined &&
        recovery.held !== null &&
        !(await (options.heldPullRequestConflicts ?? heldPullRequestConflictsLive(options.taskInput))())
      if (choice.kind !== 'completed' && choice.kind !== 'exhausted' && recovery?.held && !heldUsable)
        narrate('held clean verdict not published: the pull request is in conflict with the default branch')
      if (choice.kind === 'completed') {
        legOutcome = { reason: 'completed' }
      } else if (choice.kind === 'exhausted') {
        legOutcome = { reason: 'exhausted' }
      } else if (recovery?.held && heldUsable) {
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
          process: runProcess(),
          question: `Task ${args.task}`,
          bindings: {
            actions,
            decisions: { ...(await import('../executing/actions')).decisions, ...V2_DECISIONS },
            roles
          },
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
                  develop: async (rendered, results, context) => {
                    // Each Developer turn records the head it starts from and its launch, as the standalone loop does
                    // at each dispatch. `develop` is an agent step, so the action wrapper below never sees it.
                    await options.beginDeveloperTurn?.()
                    return developerPrompt(rendered, await developerFacts(), results, context)
                  },
                  ...(options.taskInput?.reviewerPrompt
                    ? {
                        'code-review': async (_rendered, results) =>
                          options.taskInput.reviewerPrompt!('reviewer', results),
                        'security-review': async (_rendered, results) =>
                          options.taskInput.reviewerPrompt!('security', results)
                      }
                    : {})
                }
              }
            : {}),
          spawnFn: tolerateReviewerExit(
            withReviewerWorkingDirectory(
              // Innermost, so the tee sees the directory the launch runs in and the agent's own stdout.
              withAgentNarration(reaper.spawnFn, join(runDir, 'generated'), {
                agent: args.agent,
                logPath,
                rendererFor: options.narration?.rendererFor
              }),
              join(runDir, 'generated'),
              (role) =>
                role === 'developer'
                  ? (options.taskInput?.worktreePath ?? null)
                  : (options.taskInput?.reviewerWorkingDirectory?.(role) ?? null)
            ),
            isReviewerLaunch(join(runDir, 'generated'))
          ),
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
      if (lifecycle.publishedWatch && legOutcome?.reason === 'completed' && signalled === null) {
        const published = prNumber > 0 ? prNumber : openPullRequest()
        if (published === null) break
        narrate(`watching PR #${published} after its publication, until it is merged or closed`)
        const read = await watchPublishedPullRequest(published, lifecycle.publishedWatch, stopWatching.signal, narrate)
        if (read !== 'conflicting') {
          narrate(read === 'stopped' ? 'the watch was stopped; ending' : `PR #${published} was ${read}; ending`)
          break
        }
        if (conflictReentries >= MAX_AUTOMATIC_CONFLICT_REENTRIES) {
          // The bound is spent: a person decides, through the ordinary pause and its comment.
          narrate(
            `PR #${published} fell into conflict with the default branch again, and its ${MAX_AUTOMATIC_CONFLICT_REENTRIES} automatic re-entries are spent; pausing for a person`
          )
          handoff = makeHandoff()
          if (taskForHandoff) taskForHandoff.handoff = handoff
          handoff.pause({
            reason: 'repeat_failure',
            detail: conflictReentryBoundDetail(published, MAX_AUTOMATIC_CONFLICT_REENTRIES)
          })
          legOutcome = { reason: 'paused', haltReason: handoffHaltReason('repeat_failure') }
          break
        }
        conflictReentries += 1
        log(
          conflictReentryEvent({
            loopId: options.loopId,
            task: args.task,
            prNumber: published,
            attempt: conflictReentries,
            bound: MAX_AUTOMATIC_CONFLICT_REENTRIES
          })
        )
        // A completed checkpoint has nothing left to run: the re-entry is a fresh run of the next generation, which
        // attaches to the open pull request and sends the Developer back with the conflicting files.
        generation += 1
        identity = runIdentityOfTask(args.task, generation)
        narrate(
          `PR #${published} fell into conflict with the default branch after it was published: starting a fresh run (${identity.runId}) to send it back to the Developer (re-entry ${conflictReentries} of ${MAX_AUTOMATIC_CONFLICT_REENTRIES})`
        )
        control = createRunControl()
        reapOnHalt()
        handoff = makeHandoff()
        if (taskForHandoff) taskForHandoff.handoff = handoff
        continue
      }
      // The Flow spent a decision's revision budget (the review policy's round cap): a pause like any other, made
      // durable by the handoff, so its comment asks for the ruling the watch below then picks up.
      const exhausted = legOutcome?.reason === 'exhausted' && signalled === null
      if (exhausted)
        handoff.pause({ reason: 'max_rounds', detail: 'the round cap is reached: a ruling grants a fresh run' })
      if (!lifecycle.watch || (legOutcome?.reason !== 'paused' && !exhausted) || signalled !== null) break
      narrate('the run is halted; watching for a newer ruling or a cancel')
      const watched = await watchForRuling(options.runtimeDir, args.task, lifecycle.watch, stopWatching.signal, narrate)
      if (watched.kind === 'ruled') {
        narrate(`a newer ruling resumed escalation ${watched.escalationId}`)
        options.onRulingResume?.()
      } else if (watched.kind === 'cancelled') {
        // The Operator's cancel consumed the resolution and fenced the effects; the run only ends.
        cancelledByWatch = true
        narrate('the pause was cancelled; ending')
      } else if (watched.kind === 'consumed') narrate('another process claimed the resolution and owns the run; ending')
      else if (watched.kind === 'refused') narrate(`the resolution was refused: ${watched.message}`)
      if (watched.kind !== 'ruled') break
      // An exhausted checkpoint would exhaust again at once: the ruling continues as a fresh run of the next
      // generation, which attaches to the open pull request with a fresh revision budget.
      if (exhausted) {
        generation += 1
        identity = runIdentityOfTask(args.task, generation)
        narrate(`the ruling continues past the round cap as a fresh run (${identity.runId})`)
      }
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
    for (const event of deferredHandoffEvents) log(event)
    deferredHandoffEvents.length = 0
    let lockOutcome: ReturnType<typeof releaseDriverLock> | 'cleared'
    if (cancelledByWatch) {
      legOutcome = { reason: 'cancelled' } as unknown as LegOutcome
      clearDriverLock(options.runtimeDir, args.task)
      lockOutcome = 'cleared'
    } else {
      lockOutcome = releaseDriverLock(options.runtimeDir, args.task, lockExitOf(exit))
    }
    narrate(`driver exited (${exit.reason}, ${exit.lastDecision}); driver lock ${lockOutcome}`)
    if (bound && unwrappedFindPr) bound.findOpenPrForBranch = unwrappedFindPr
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
  /** Writes the turn's Developer launch record; the real writer unless a test supplies its own. */
  recordLaunch?: typeof recordRunnerDeveloperLaunch
  /** Closes the turn's Developer launch record; the real one unless a test supplies its own. */
  completeLaunch?: typeof completeRunnerDeveloperLaunch
}): {
  context: DevToolContext
  beginTurn: () => Promise<void>
  /** Closes this turn's launch record, completed, with the Developer's vendor session bound. */
  completeTurn: (resumeId: string | null) => void
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
  let launchRunId: string | null = null
  const completeTurn = (resumeId: string | null): void => {
    if (launchRunId === null) return
    ;(input.completeLaunch ?? completeRunnerDeveloperLaunch)({
      agent: input.agent,
      repo: input.repo,
      task: input.task,
      runId: launchRunId,
      resumeId
    })
    launchRunId = null
  }
  const beginTurn = async (): Promise<void> => {
    // The Broker authenticates this turn's pushes against a Developer launch record; the Engine's executor
    // spawns the agent itself, so the runner writes that record here.
    launchRunId = (input.recordLaunch ?? recordRunnerDeveloperLaunch)({
      agent: input.agent,
      repo: input.repo,
      task: input.task,
      round: input.round()
    })
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
  return { context, beginTurn, completeTurn, state, changedProtectedPaths: () => attribution.changedPaths() }
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
  fetchFailingCheckRuns: typeof fetchFailingCheckRuns
  fetchFailedCheckWorkflowRunIds: typeof fetchFailedCheckWorkflowRunIds
  rerunFailedWorkflowJobs: typeof rerunFailedWorkflowJobs
  fetchMergeableState: typeof fetchMergeableState
  fetchConflictingFiles: typeof fetchConflictingFiles
  postMarkedComment: typeof postMarkedComment
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
  publishRound,
  fetchFailingCheckRuns,
  fetchFailedCheckWorkflowRunIds,
  rerunFailedWorkflowJobs,
  fetchMergeableState,
  fetchConflictingFiles,
  postMarkedComment
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
    /** Replaces forge reads and writes, for a run that must not reach the forge. */
    forge?: Partial<EngineForge>
    /** Replaces the role doctrine resolver the reviewer prompts take their doctrine from. */
    resolveReviewerDoctrine?: (role: 'reviewer' | 'security') => Promise<string | null>
    /** Replaces the functions the security scan, live check and deferred-findings Issue call, for a run that must not reach them. */
    completion?: Partial<BoundFunctions>
    /** The repository (`owner/repo`) the round's manifest record names. */
    repository?: string
    /** Where the CLI the checks run from lives; defaults to `repoRoot`. The live runner passes the Vinaya install, which differs from the task's repository when Vinaya is adopted elsewhere. */
    cliRoot?: string
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
  // One snapshot of the review inputs per dispatch of a round's reviewers: every reviewer prompt, held verdict and
  // publication of the round reads it, so a head or a ruling that moves after it is taken never reaches them.
  const reviewInputs = (reviewRound: number): ReviewRoundInputs => {
    const manifest = manifestAt(judgedHead())
    const resolved = forge.resolveIssueObjectives(args.task)
    const pr = forge.findOpenPrForBranch(branch)
    // Best-effort: a record that cannot be written never costs the round.
    persistManifestRecord(runtimeDir, args.task, manifest, {
      repository: lookups.repository ?? 'unknown',
      pr: pr?.number ?? 0,
      branch,
      round: reviewRound,
      recordedAt: new Date().toISOString()
    })
    return {
      manifest,
      objectives: resolved.objectives.map((objective) => ({ id: objective.id, text: objective.text })),
      objectivesText: resolved.text
    }
  }
  const buildVerdict = (role: HeldVerdictRole, review: ReviewResult, inputs: ReviewRoundInputs, sessionId?: string) =>
    buildVerdictFromReview(
      role,
      review,
      args.agent === 'claude' ? 'claude' : 'codex',
      args.task,
      { exitCode: 0, durationMs: 0, usage: null, ...(sessionId === undefined ? {} : { resumeId: sessionId }) } as never,
      inputs.manifest,
      policyNow(),
      inputs.objectives
    )
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
      if (pr) return forge.prBody(pr.number)
      // Version 2 opens no pull request before approval: the reviewers read the body the Developer staged.
      return args.flow === 'v2' ? (stagedPullRequestStore(runDirectory(runtimeDir, args.task)).read()?.body ?? '') : ''
    },
    diff: (base, head) => sh('git', ['diff', `${base}...${head}`], worktreePath),
    ...lookups.reviewSources
  })
  const reviewerDirectories: Record<HeldVerdictRole, string | null> = { reviewer: null, security: null }
  const reviewerPrompt = async (
    role: HeldVerdictRole,
    results: Readonly<Record<string, StepNodeResult>>
  ): Promise<string> => {
    const attempt = recordedDispatch(results)?.attempt ?? 1
    const staged = reviewInput.stageAttempt(round, role, attempt)
    reviewerDirectories[role] = staged?.dir ?? null
    // The role's doctrine, resolved as the standalone loop resolves it; a failed resolution renders none.
    let doctrine: string | null = null
    try {
      doctrine = await (lookups.resolveReviewerDoctrine ?? resolveRoleDoctrineText)(role)
    } catch {
      doctrine = null
    }
    // The round's snapshot binds the prompt; a prompt rendered with no recorded dispatch reads the inputs as they stand.
    const dispatched = recordedDispatch(results)?.inputs ?? null
    const objectives = dispatched ?? null
    const live = objectives === null ? forge.resolveIssueObjectives(args.task) : null
    const facts: ReviewerPromptFacts = {
      objectives: dispatched?.objectivesText ?? live?.text ?? '',
      resolvedObjectives: dispatched?.objectives ?? live?.objectives ?? [],
      // As the standalone loop's review round: the Issue's rulings after the brief then the pull request's,
      // and the forge's CI conclusion for the judged head (`fetchCiConclusion`).
      rulings: reviewerRulings({
        task: args.task,
        prNumber: forge.findOpenPrForBranch(branch)?.number ?? null,
        fetchIssueRulingsAfterBrief: forge.fetchIssueRulingsAfterBrief,
        fetchRulings: forge.fetchRulings
      }),
      // Version 2 reviews locally before any pull request (and so any CI) exists: the CI conclusion is pending.
      ciConclusion:
        args.flow === 'v2' && forge.findOpenPrForBranch(branch) === null
          ? 'pending'
          : forge.fetchCiConclusion(judgedHead()),
      revision: forge.fetchSourceRevision(args.task),
      manifest: dispatched?.manifest ?? manifestAt(judgedHead()),
      policy: policyNow(),
      // The scan outcome reaches the security prompt only.
      ...(role === 'security' ? { configScan: recordedScanOutcome(results) } : {})
    }
    return renderVinayaReviewerPrompt(role, facts, staged, doctrine)
  }
  return {
    reviewerPrompt,
    reviewerWorkingDirectory: (role) => reviewerDirectories[role],
    candidateDir: () => reviewInput.stage(round)?.dir ?? null,
    frozenBrief: () => forge.fetchFrozenBrief(args.task),
    stageReviewInput: (n) => reviewInput.stage(n),
    runtimeDir,
    cliEntry: cliEntryOf(lookups.cliRoot ?? repoRoot),
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
      publishRound: forge.publishRound,
      fetchPrBody: forge.prBody,
      fetchCiConclusion: forge.fetchCiConclusion,
      fetchFailingCheckRuns: forge.fetchFailingCheckRuns,
      fetchFailedCheckWorkflowRunIds: forge.fetchFailedCheckWorkflowRunIds,
      rerunFailedWorkflowJobs: forge.rerunFailedWorkflowJobs,
      fetchMergeableState: forge.fetchMergeableState,
      fetchConflictingFiles: forge.fetchConflictingFiles,
      postMarkedComment: forge.postMarkedComment,
      ...lookups.completion
    },
    get loopState(): LoopState {
      if (loopState !== null) return loopState
      // The Log's role names and models, exactly as the standalone loop records them in `loop_started`.
      const loopRoles: Pick<LoopConfig, 'reviewers' | 'models'> = {
        reviewers: ['code-reviewer', 'security'],
        models: { developer: args.model ?? args.agent, 'code-reviewer': args.agent, security: args.agent }
      }
      // Recovery reads this before the Flow starts. An unreadable policy must not throw here: the state is built from
      // the default caps and kept so later writes are not lost,
      // and prepare-run then pauses on the policy with its own detail.
      let policy: ReturnType<typeof reviewPolicyForLoop>
      try {
        policy = policyNow()
      } catch {
        loopState = initialLoopState({
          loopId,
          task: args.task,
          ...loopRoles,
          maxRounds: DEFAULT_REVIEW_POLICY.maxRounds,
          maxTaskMinutes: DEFAULT_REVIEW_POLICY.maxTaskMinutes
        })
        return loopState
      }
      const config: LoopConfig = {
        loopId,
        task: args.task,
        ...loopRoles,
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
    objectivesEdit: () => {
      const { edit } = forge.resolveIssueObjectives(args.task)
      return edit ? describeObjectivesEdit(args.task, edit) : null
    },
    reviewInputs,
    buildVerdict,
    verdicts: (results) => {
      const verdicts = recordedVerdicts(results)
      round += 1
      return verdicts
    },
    remoteHead: () => forge.resolveHead(branch),
    readUnpushedWork: () => readUnpushedWorkDetail(worktreePath),
    publish: ({ manifest, ...at }) => ({
      task: args.task,
      ...at,
      journal: forge.fetchLoopHistory(at.prNumber),
      policy: policyNow(),
      // The round's snapshot; a held verdict published with no recorded dispatch is bound to the head it judged.
      manifest: manifest ?? manifestAt(at.expectedHead)
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
  /** Whether this turn is the first after a resume from a ruling; reading it clears it. */
  takeRulingsOwed?: () => boolean
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
      rulingsOwed: input.takeRulingsOwed?.() ?? false,
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

/** The worktree's unpublished work, read with the standalone loop's own reader; null when the worktree is gone. */
export function readUnpublishedWork(worktreePath: string): UnpushedWork | null {
  return existsSync(worktreePath) ? readUnpushedWorkDetail(worktreePath) : null
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

/** Engine events use the same destination-resolving sink as the standalone runner. */
export function createEngineLogSink(overrides: Partial<LogSinkDeps> = {}) {
  return createLogSink(overrides)
}

/** Remove the former local-only override so child processes resolve the configured destination too. */
export function configureEngineLogEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  delete env[LOG_FOLDER_ONLY_ENV]
}

/** Refuses a fresh Engine start on a task whose held pause another runner recorded, naming that runner. */
export function refuseAnotherRunnersPause(runtimeDir: string, task: number): void {
  if (readPauseState(runtimeDir, task) === null) return
  const refusal = crossRunnerRefusal(task, 'atta-engine', runtimeDir)
  if (refusal !== null) throw new Error(`run-engine: ${refusal}`)
}

/** Runs one task on the Engine against the live forge, git and Log. */
async function runLive(
  args: EngineArgs,
  loaded: LoadedProcess,
  repoRoot: string,
  runtimeDir: string,
  opts: { rulingsOwed?: boolean } = {}
): Promise<number> {
  // The first Developer turn after a resume from a ruling carries the rulings' text, once.
  const rulings = { owed: opts.rulingsOwed === true }
  refuseAnotherRunnersPause(runtimeDir, args.task)
  recordRunFlow(runtimeDir, args.task, loaded.flowKey)
  configureEngineLogEnvironment()
  setEngineLogIdentity(loaded, args.agent)
  const sink = createEngineLogSink()
  const loopId = randomUUID()
  process.env.VINAYA_RUN = loopId
  const repo = liveRepo()
  const taskInput = await liveTaskInput(args, repoRoot, runtimeDir, loopId, {
    cliRoot: VINAYA_ROOT,
    ...(repo ? { repository: `${repo.owner}/${repo.repo}` } : {})
  })
  const liveContext = engineLiveDevToolsContext({
    branch: taskInput.branch,
    worktreePath: taskInput.worktreePath,
    task: args.task,
    runtimeDir,
    agent: args.agent,
    repo,
    round: taskInput.reviewRound
  })
  // A turn whose last publication a driver tool refused has no push coming: the stall names the refusal.
  taskInput.publicationRefusal = () => liveContext.state.turnPublicationRefusal
  // Version 2 (review locally, push once): storage pushes, a staged pull request, the ready push and CI once.
  let devToolsContext = liveContext.context
  if (loaded.flowKey === 'v2') {
    const store = stagedPullRequestStore(runDirectory(runtimeDir, args.task))
    const findOpenPullRequest = () => findOpenPrForBranch(taskInput.branch)
    taskInput.flow = 'v2'
    taskInput.stagedPullRequest = store.read
    taskInput.v2 = liveV2Functions({
      worktreePath: taskInput.worktreePath,
      branch: taskInput.branch,
      store,
      findOpenPullRequest,
      remoteHead: () => taskInput.remoteHead?.() ?? null,
      openWithDeveloperTool: (title, body) => liveContext.context.openPullRequest(title, body)
    })
    devToolsContext = withV2DevTools(liveContext.context, {
      worktreePath: taskInput.worktreePath,
      store,
      findOpenPullRequest,
      onStoragePush: (head) =>
        sink.log(storagePushLogEvent(loopId, taskInput.reviewRound(), taskInput.branch, head) as never)
    })
  }
  const baseFacts = liveDeveloperFacts({
    takeRulingsOwed: () => {
      const owed = rulings.owed
      rulings.owed = false
      return owed
    },
    task: args.task,
    repoRoot,
    runtimeDir,
    branch: taskInput.branch,
    worktreePath: taskInput.worktreePath,
    round: taskInput.reviewRound,
    lastPushRefusal: () => liveContext.state.lastPushRefusal
  })
  const result = await runEngine({
    args,
    process: loaded,
    repoRoot,
    // The shim's CLI entry lives in the Vinaya install, not in the task's repository.
    cliRoot: VINAYA_ROOT,
    runtimeDir,
    loopId,
    taskInput,
    sink,
    startHost: startDevToolsHost,
    developerFacts: async () => ({ ...(await baseFacts()), flow: loaded.flowKey }),
    allowUnixSockets: linuxUnixSocketFilterOptIn(),
    lifecycle: {
      dispatchConfig: loadConfig()?.dispatch,
      recovery: liveRecovery({ args, runtimeDir, taskInput }),
      watch: { deps: liveResumeDeps, pollMs: rulingPollMs(), sleep: abortableSleep },
      publishedWatch: { fetchPrState, fetchMergeableState, pollMs: rulingPollMs(), sleep: abortableSleep }
    },
    devToolsContext,
    onRulingResume: () => {
      rulings.owed = true
    },
    beginDeveloperTurn: liveContext.beginTurn,
    completeDeveloperTurn: liveContext.completeTurn
  })
  // The handoff's escalation record logs through the default sink, which nothing else drains.
  await drainLogSink()
  return result.exitCode
}

/** The Vinaya install this runner ships in: where the CLI and the process folder live. */
const VINAYA_ROOT = resolve(import.meta.dir, '../../..')

/** The repository the task runs in: the git top level of the directory the runner was started from, which is not the Vinaya install when Vinaya is adopted elsewhere. */
export function targetRepoRoot(cwd: string = process.cwd()): string {
  return sh('git', ['rev-parse', '--show-toplevel'], cwd).trim()
}

export async function main(argv: readonly string[]): Promise<number> {
  // This process hosts the CLI's code without being the CLI: commands it runs as the CLI start the install's entry.
  process.env[CLI_ENTRY_ENV] = cliEntryOf(VINAYA_ROOT)
  const repoRoot = targetRepoRoot()
  // The run's flow is chosen by `--flow` (or, on a resume, recorded by the run it continues); none takes the default.
  const processFolder = resolve(import.meta.dir, '..')
  const runtimeDir = await liveRuntimeDir()
  if (argv.includes('--resume')) {
    const args = parseResumeArgs(argv)
    const result = await resumeEngine({
      args,
      runtimeDir,
      run: async (resolved) => ({
        outcome: null,
        exitCode: await runLive(
          resolved,
          loadProcess(processFolder, resolved.flow ? { flow: resolved.flow } : {}),
          repoRoot,
          runtimeDir,
          { rulingsOwed: true }
        ),
        tracePath: ''
      })
    })
    return result.exitCode
  }
  const args = parseArgs(argv)
  const loaded = loadProcess(processFolder, args.flow ? { flow: args.flow } : {})
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

/**
 * A role launcher whose output schema is rebuilt at every launch: inline for Claude (`--json-schema <json>`),
 * a rewritten file for Codex (`--output-schema <path>`). Any other argument is unchanged.
 */
export function withTurnSchema(
  launcher: RoleLauncher[string],
  generatedDir: string,
  schema: () => Record<string, unknown>
): RoleLauncher[string] {
  return {
    ...launcher,
    buildArgs: (input) => {
      const args = [...launcher.buildArgs(input)]
      const current = schema()
      const inline = args.indexOf('--json-schema')
      if (inline !== -1 && inline + 1 < args.length) args[inline + 1] = JSON.stringify(current)
      const file = args.indexOf('--output-schema')
      if (file !== -1 && file + 1 < args.length) {
        const path = join(generatedDir, 'turn-output.schema.json')
        writeFileSync(path, JSON.stringify(current))
        args[file + 1] = path
      }
      return args
    }
  }
}

/** The live read behind a held verdict's conflict guard: the task's open pull request, polled for mergeability as the Flow's own step polls it. */
export function heldPullRequestConflictsLive(task: TaskInput | undefined): () => Promise<boolean> {
  return async () => {
    if (!task) return false
    const pr = (task.bound?.findOpenPrForBranch ?? findOpenPrForBranch)(task.branch)
    if (pr === null) return false
    const state = await pollMergeableState(pr.number, {
      ...gatePollOf(task),
      fetchMergeableState: task.bound?.fetchMergeableState ?? fetchMergeableState
    })
    return state === 'CONFLICTING'
  }
}
