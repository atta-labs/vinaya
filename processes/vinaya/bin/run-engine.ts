#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import {
  initialLoopState,
  buildReviewInputManifest,
  type LoopConfig,
  type Observations,
  type ReviewInputManifest,
  type VerdictObservation
} from '@attalabs/aeg-core'
import type { RunControl, RunOutcome, SpawnFn, StepNodeResult } from '@atta/executor-agent-spawn'
import { loadProcess, type LoadedProcess } from '../../../harness/dev-process/loader/load-process'
import {
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
import {
  fetchCiConclusion,
  readWorktreeHead,
  resolveHead
} from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { developerBranchFor } from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { publishRound } from '../../../apps/cli/src/lib/dev-review-loop/publication'
import {
  addedDiffLines,
  findCredentialPatterns,
  LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV,
  linuxUnixSocketFilterOptIn
} from '../../../apps/cli/src/lib/worker-boundary'
import {
  appendSourceDeliveryReceipt,
  injectedDeliveryReceipts,
  requiredSourcesPromptBlock,
  sourceReceiptsPath,
  sourceStoreDir
} from '../../../apps/cli/src/lib/source-manifest'
import {
  prepareSources,
  RequiredSourcesUnavailable,
  realSourceProviderDeps
} from '../../../apps/cli/src/lib/source-provider'
import { extractSourceRevision } from '@attalabs/aeg-core'
import type { DevToolContext, DevToolResult } from '../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { validatePrBodyForCreate } from '../../../apps/cli/src/commands/pr'
import { createLogSink } from '../../../apps/cli/src/lib/log-sink'
import { startDevToolsHost, type DevToolsHost } from '../../../apps/cli/src/lib/task-tools/dev-tools-host'
import { devToolsSocketPath } from '../../../apps/cli/src/lib/task-tools/dev-tools-registration'
import { createDeveloperDevToolContext } from '../../../apps/cli/src/lib/task-tools/developer-dev-tools-context'
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
import { buildVerdictFromReview, heldVerdictPath } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { RUNTIME_DIR_ENV_KEY, runtimeDirForRepoAsync } from '../../../apps/cli/src/lib/run-paths'
import { parseReviewResult, type ReviewResult } from '../../../apps/cli/src/lib/review-result'
import type { ReviewerPromptFacts } from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'
import { agentEnvAllowlist } from '../../../harness/adapters/agents/launch-env'
import { grantVariables } from '../../../harness/adapters/agents/variables'
import { ghPullRequestView, pullRequestCheckEnv } from '../executing/pull-request-env'
import { runCli, runCliChecks } from '../../../harness/gates/run-checks'
import { refreshPrEvidence } from '../executing/refresh-evidence'
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
  type HeldVerdictRole,
  type TaskInput
} from '../executing/actions'

// The Engine path for one task: the Vinaya process run on the packed executor
// instead of the standalone review loop. Choosing this entry point is the
// whole switch — the loop stays the default and no CLI command changes,
// because CLI source may not import an Engine package.
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
    finish(outcome: string, results: Readonly<Record<string, StepNodeResult>>, error?: string): RunTrace {
      for (const [nodeId, result] of Object.entries(results)) {
        const last = open(nodeId)
        if (last && last.exitCode === null) last.exitCode = result.exitCode
      }
      const verdicts: Record<string, unknown> = {}
      for (const step of REVIEW_STEPS) verdicts[step] = parseReviewResult(agentOutput(results, step))
      return { ...meta, outcome, ...(error === undefined ? {} : { error }), steps, verdicts }
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
  /** The Linux host opt-in: the generated Claude settings allow Unix sockets and the variable is forwarded to the agent. */
  allowUnixSockets?: boolean
}

export interface EngineRunResult {
  outcome: RunOutcome | null
  exitCode: number
  tracePath: string
}

/** Runs the task on the Engine. The host is closed and the sink drained on every way out. */
export async function runEngine(options: EngineRunOptions): Promise<EngineRunResult> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const { args } = options
  out(`loopId ${options.loopId}`)
  const runDir = runDirectory(options.runtimeDir, args.task)
  mkdirSync(runDir, { recursive: true })
  const tracePath = join(runDir, 'trace.json')
  const trace = createTraceRecorder({ task: args.task, agent: args.agent, loopId: options.loopId })
  const translator = createLogTranslator(
    // The producers are the Vinaya process's own; they know the loop and the task.
    (await import('../executing/log-events')).createVinayaLogProducers({ loopId: options.loopId, task: args.task }),
    options.sink.log as unknown as EmitLogEvent
  )
  const developerFacts = options.developerFacts
  let host: Pick<DevToolsHost, 'close'> | undefined
  let outcome: RunOutcome | null = null
  let error: string | undefined
  try {
    const socketPath = devToolsSocketPath(`engine-${args.task}`)
    host = await options.startHost({
      socketPath,
      serverVersion: 'engine-run-1',
      context: options.devToolsContext,
      role: 'developer'
    })
    const shimPath = join(runDir, 'dev-bridge.sh')
    writeFileSync(shimPath, shimContent(socketPath, options.execPath ?? process.execPath, cliEntryOf(options.repoRoot)))
    chmodSync(shimPath, 0o755)
    const roles = createRoleLaunchers({
      vendor: vendorOf(args.agent),
      generatedRoot: join(runDir, 'generated'),
      variables: options.taskInput?.worktreePath ? grantVariables(options.taskInput.worktreePath, runDir) : undefined,
      mcpCommand: shimPath,
      model: args.model,
      allowUnixSockets: options.allowUnixSockets === true,
      stageCodexLogin: true
    })
    const base = options.actions ?? createActions(options.taskInput)
    const actions = recordingActions(tracedActions(base, trace), translator)
    const runOptions: ProcessRunOptions = {
      process: options.process,
      question: `Task ${args.task}`,
      bindings: { actions, decisions: (await import('../executing/actions')).decisions, roles },
      checkpointer: new MemorySaver(),
      workingDirectoryRoot: options.repoRoot,
      // A revision continues the Developer's own session, as the standalone loop resumes it.
      continueSessions: ['develop'],
      envAllowlist: agentEnvAllowlist({
        extra: options.allowUnixSockets === true ? [LINUX_SANDBOX_ALLOW_UNIX_SOCKETS_ENV] : []
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
      ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      ...(options.control ? { control: options.control } : {}),
      onEvent: (event) => {
        options.observe?.(event as NodeLifecycle)
        trace.onEvent(event as NodeLifecycle)
        translator.onEvent(event as NodeLifecycle)
      }
    }
    translator.beginLeg()
    outcome = await startProcessRun(runOptions)
    translator.endLeg(outcome as unknown as LegOutcome)
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
    translator.endLeg({ reason: 'failed', error })
  } finally {
    try {
      await host?.close()
    } finally {
      await options.sink.drain()
    }
  }
  const results = (outcome && 'checkpoint' in outcome ? (outcome.checkpoint?.results ?? {}) : {}) as Record<
    string,
    StepNodeResult
  >
  const reason = outcome?.reason ?? 'failed'
  // The trace carries tool output verbatim, so only its owner reads it.
  writeFileSync(tracePath, `${JSON.stringify(trace.finish(reason, results, error), null, 2)}\n`, { mode: 0o600 })
  chmodSync(tracePath, 0o600)
  out(`trace ${tracePath}`)
  const exitCode = reason === 'completed' ? 0 : reason === 'paused' ? 2 : 1
  return { outcome, exitCode, tracePath }
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

/** The gate-backed tools the Developer calls, over plain git and gh run here, outside its sandbox. */
function liveDevToolsContext(input: {
  branch: string
  worktreePath: string
  task: number
  cliEntry: string
}): DevToolContext {
  const { branch, worktreePath, cliEntry } = input
  const git = (...args: string[]) => sh('git', args, worktreePath)
  const attempt = async <T>(check: string, run: () => T | Promise<T>): Promise<DevToolResult<T>> => {
    try {
      return { ok: true, result: await run() }
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr
      return refusal(check, stderr ? String(stderr) : error instanceof Error ? error.message : String(error))
    }
  }
  const changedPaths = (): string[] => {
    const base = git('merge-base', 'origin/main', 'HEAD')
    const paths = new Set([
      ...git('diff', '--name-only', base).split('\n'),
      ...git('ls-files', '--others', '--exclude-standard').split('\n')
    ])
    paths.delete('')
    return [...paths]
  }
  const prNumber = (): number => {
    const pr = findOpenPrForBranch(branch)
    if (pr === null) throw new Error(`no open pull request for branch ${branch}`)
    return pr.number
  }
  const readPullRequest = async () =>
    attempt('read_pull_request', () => {
      const pr = findOpenPrForBranch(branch)
      if (pr === null)
        return { prNumber: null, state: null, head: null, checks: null, reviews: null, body: null, failedChecks: [] }
      const raw = JSON.parse(
        sh('gh', ['pr', 'view', String(pr.number), '--json', 'number,state,headRefOid,statusCheckRollup,body'])
      ) as Record<string, unknown>
      return {
        prNumber: pr.number,
        state: String(raw.state),
        head: String(raw.headRefOid),
        checks: (raw.statusCheckRollup ?? []) as never,
        reviews: [],
        body: String(raw.body ?? ''),
        failedChecks: []
      }
    })
  return createDeveloperDevToolContext({
    readPublicationCheckInput: () => {
      const base = git('merge-base', 'origin/main', 'HEAD')
      return {
        worktreeBranch: git('rev-parse', '--abbrev-ref', 'HEAD'),
        expectedBranch: branch,
        worktreeHead: readWorktreeHead(worktreePath),
        recordedHead: null,
        base,
        expectedBase: base,
        changedPaths: changedPaths(),
        surface: null
      }
    },
    commitAndPush: (header) =>
      attempt('publish_changes', () => {
        // The loop's pre-push credential scan: the header and the added lines, before anything leaves.
        const found = [
          ...findCredentialPatterns(header, 'the proposed commit header'),
          ...(() => {
            git('add', '-A')
            return findCredentialPatterns(addedDiffLines(git('diff', '--cached', '-U0')), 'the staged diff')
          })()
        ]
        if (found.length > 0) {
          git('reset', '-q')
          throw new Error(`recognized credential pattern(s): ${found.map((f) => f.pattern).join(', ')}`)
        }
        git('commit', '--allow-empty-message', '-m', header)
        git('push', 'origin', `HEAD:refs/heads/${branch}`)
        return { pushedHead: git('rev-parse', 'HEAD') }
      }),
    // The loop's own body gate, over the files the branch changed: a body the brief-schema checks refuse is never opened.
    validatePrBody: async (body, title) => {
      const errors = await validatePrBodyForCreate({
        body,
        title: title ?? `Task ${input.task}`,
        changedFiles: changedPaths(),
        branch,
        baseBranch: 'main'
      })
      return errors.length === 0
        ? { ok: true }
        : { ok: false, reason: errors.map((e) => `${e.check}: ${e.message}`).join('; ') }
    },
    openPullRequest: (title, body) =>
      attempt('open_pull_request', () => {
        sh('gh', ['pr', 'create', '--head', branch, '--base', 'main', '--title', title, '--body', body])
        return { prNumber: prNumber() }
      }),
    updatePullRequestBody: (body) =>
      attempt('update_pull_request_body', () => {
        const number = prNumber()
        sh('gh', ['pr', 'edit', String(number), '--body', body])
        return { prNumber: number }
      }),
    refreshEvidence: () =>
      attempt('refresh_evidence', () =>
        refreshPrEvidence({ cliEntry, worktreePath, prNumber, readHead: readWorktreeHead, runCli })
      ),
    readPullRequest,
    runChecks: () => attempt('run_checks', () => runCliChecks(cliEntry, worktreePath, pullRequestCheckEnv(branch)))
  })
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
  const policy = (lookups.policy ?? reviewPolicyForLoop)()
  const config: LoopConfig = {
    loopId,
    task: args.task,
    reviewers: ['reviewer', 'security'],
    models: {},
    maxRounds: policy.maxRounds,
    maxTaskMinutes: policy.maxTaskMinutes
  }
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
      policy
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
      policy,
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
      policy
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
    loopState: initialLoopState(config),
    reviewRound: () => round,
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
      policy,
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

async function liveRuntimeDir(): Promise<string> {
  const fromEnv = process.env[RUNTIME_DIR_ENV_KEY]
  if (fromEnv) return fromEnv
  let repo: { owner: string; repo: string } | null = null
  try {
    const match = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(sh('git', ['remote', 'get-url', 'origin']))
    if (match) repo = { owner: match[1] as string, repo: match[2] as string }
  } catch {
    repo = null
  }
  return repo ? runtimeDirForRepoAsync(repo) : join(homedir(), '.vinaya', 'runtime')
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  const repoRoot = resolve(import.meta.dir, '../../..')
  const loaded = loadProcess(resolve(import.meta.dir, '..'))
  const runtimeDir = await liveRuntimeDir()
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
  const sink = createLogSink()
  const loopId = randomUUID()
  process.env.VINAYA_RUN = loopId
  const taskInput = await liveTaskInput(args, repoRoot, runtimeDir, loopId)
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
      round: taskInput.reviewRound
    }),
    allowUnixSockets: linuxUnixSocketFilterOptIn(),
    devToolsContext: liveDevToolsContext({
      branch: taskInput.branch,
      worktreePath: taskInput.worktreePath,
      task: args.task,
      cliEntry: taskInput.cliEntry
    })
  })
  return result.exitCode
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
