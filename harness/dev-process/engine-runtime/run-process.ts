import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { compileFlow, type Plan, type StepsFlow } from '@atta/engine'
import {
  type AgentLifecycleNodeExecutor,
  type AgentSpawnExecutorConfig,
  type AgentSpawnGraphStateValue,
  type MechanicalNodeResult,
  type RoleBinaryConfig,
  RunHaltedError,
  type RunControl,
  type RunIdentity,
  type RunOutcome,
  type SpawnFn,
  type StepNodeResult,
  type StartControlledRunParams,
  buildAgentSpawnStateGraph,
  executeAgentSpawnNode,
  renderStepPrompt,
  resumeControlledRun,
  runInvokeConfig,
  startControlledRun
} from '@atta/executor-agent-spawn'
import { parse } from 'yaml'
import type { GeneratedAgentConfig } from '../../adapters/agents/policy'
import type { LoadedProcess } from '../loader/load-process'
import { stageCodexAuth } from '../../adapters/agents/codex/auth'
import { RESUME_SESSION_PLACEHOLDER } from '../../adapters/agents/policy'
import { sessionIdOf } from '../../adapters/agents/structured-result'

// Runs a loaded process's Flow on the packed executor. The runtime knows no
// particular process: everything a Flow names (mechanical actions, deciding
// steps, agent roles) is looked up in registries the process supplies, and a
// name with no entry is refused before the first step runs.
//
// Agent steps spawn through the executor's own spawn path with the argv and
// settings the agent adapters generated. Mechanical steps run in-process. The
// executor's leg wrapper owns halt checks, lifecycle events, revision counting
// and the recursion limit, so this node executor returns neither revision
// counts nor passes a recursion limit.

/** What a mechanical action is told about the step it runs for. */
export interface ActionContext {
  nodeId: string
  action: string
  /** Results recorded so far, keyed by step id. */
  results: Readonly<Record<string, StepNodeResult>>
  /** Aborted when the run's control halts; a long action should honour it. */
  signal?: AbortSignal
}

/**
 * What a mechanical action reports. Decisions read `exitCode`, never
 * `stdout`: stored results are narrowed and may be redacted.
 */
export interface ActionResult {
  exitCode: number
  stdout?: string
  stderr?: string
  /**
   * The step refused and paused the run: it halts without being recorded as completed, so a resume runs it again
   * once its cause is fixed. A step that completed, even with a non-zero exit code, leaves this unset.
   */
  refused?: boolean
}

export type ProcessAction = (context: ActionContext) => Promise<ActionResult> | ActionResult

/** Mechanical action name to its in-process function. */
export type ActionRegistry = Readonly<Record<string, ProcessAction>>

/** Deciding step id to a boolean read from the examined step's result. */
export type DecisionRegistry = Readonly<Record<string, (examined: StepNodeResult) => boolean>>

/** Agent role to the binary, argv and permissions it launches with. */
export type RoleLauncher = Readonly<Record<string, RoleBinaryConfig>>

export interface ProcessBindings {
  actions: ActionRegistry
  decisions: DecisionRegistry
  roles: RoleLauncher
}

export interface ProcessRunOptions {
  process: LoadedProcess
  /** The question every step's prompt template renders as `{{question}}`. */
  question: string
  bindings: ProcessBindings
  /** One checkpointer per run; the caller keeps it between a halt and its resume. */
  checkpointer: StartControlledRunParams['checkpointer']
  /** Root every agent step's working directory is confined to. */
  workingDirectoryRoot: string
  /** Halt and cancel handle for this leg. */
  control?: RunControl
  /** Injected spawn function for agent steps; defaults to the real process spawn. */
  spawnFn?: SpawnFn
  onEvent?: AgentSpawnExecutorConfig['onEvent']
  envAllowlist?: string[]
  /**
   * Agent step id to a function that completes the step's rendered prompt with what only the
   * process knows (a task's brief, say). It runs each time the step starts, over the results so far.
   */
  stepPrompts?: Readonly<Record<string, StepPrompt>>
  /**
   * Agent steps that continue their own earlier session each time they run again (a revision of the same
   * work). The Flow's `resume` names only a prior step, so a step's own continuation is the runner's.
   */
  continueSessions?: readonly string[]
  /**
   * Awaited before every step starts, so no dispatch or effect depends on a write that has not persisted. Defaults to
   * the checkpointer's own `assertPersisted` when it has one; a throw fails the step before it does anything.
   */
  persistenceBarrier?: () => Promise<void>
  /** Observes transport loss; a potentially effectful failed turn is never replayed automatically. */
  agentRedispatch?: AgentRedispatch
}

/** Transport-loss observation. Failed turns pause rather than automatically replaying tool or file effects. */
export interface AgentRedispatch {
  lost: (stepId: string) => string | null
  succeeded?: (stepId: string) => void
}

export type StepPrompt = (
  rendered: string,
  results: Readonly<Record<string, StepNodeResult>>,
  /** The vendor session this step continues (the step's `resume`), absent on a fresh session. */
  context?: { resumeSessionId?: string }
) => Promise<string> | string

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        camelize(item)
      ])
    )
  }
  return value
}

interface FlowStep {
  id: string
  type: string
  action?: string
  role?: string
  permission?: string
  decision?: unknown
}

function readFlow(process: LoadedProcess): StepsFlow {
  return camelize(parse(readFileSync(process.flowPath, 'utf8'))) as StepsFlow
}

function stepsOf(flow: StepsFlow): FlowStep[] {
  return (flow as unknown as { steps: FlowStep[] }).steps
}

/** Throws, naming the first id the registries do not cover. */
function assertBindingsCover(steps: FlowStep[], bindings: ProcessBindings): void {
  for (const step of steps) {
    if (step.type === 'mechanical' && step.action !== undefined && !Object.hasOwn(bindings.actions, step.action)) {
      throw new Error(`Action "${step.action}" (step "${step.id}") has no entry in the action registry`)
    }
    if (step.type === 'agent' && step.role !== undefined) {
      const launcher = Object.hasOwn(bindings.roles, step.role) ? bindings.roles[step.role] : undefined
      if (!launcher) throw new Error(`Role "${step.role}" (step "${step.id}") has no entry in the role launcher`)
      if (step.permission !== undefined && !launcher.allowedPermissions.includes(step.permission)) {
        throw new Error(`Role "${step.role}" does not allow permission "${step.permission}" (step "${step.id}")`)
      }
    }
    if (step.decision !== undefined && !Object.hasOwn(bindings.decisions, step.id)) {
      throw new Error(`Decision "${step.id}" has no entry in the decision registry`)
    }
  }
}

function nodeExecutor(
  actions: ActionRegistry,
  control: RunControl | undefined,
  config: AgentSpawnExecutorConfig,
  spawnFn: SpawnFn | undefined,
  stepPrompts: Readonly<Record<string, StepPrompt>> = {},
  continueSessions: readonly string[] = [],
  persistenceBarrier?: () => Promise<void>,
  redispatch?: AgentRedispatch
): AgentLifecycleNodeExecutor {
  return async (state: AgentSpawnGraphStateValue, { node, plan, signal }) => {
    await persistenceBarrier?.()
    if (node.kind === 'mechanical') {
      const action = actions[node.action]
      if (!action) throw new Error(`Action "${node.action}" (step "${node.id}") has no entry in the action registry`)
      const startedAt = Date.now()
      const outcome = await action({ nodeId: node.id, action: node.action, results: state.results, signal })
      // A refusal halts at this step's own boundary: no result is written, so the checkpoint still holds it pending.
      if (outcome.refused === true) throw new RunHaltedError(node.id, control?.haltReason)
      const result: MechanicalNodeResult = {
        nodeId: node.id,
        kind: 'mechanical',
        action: node.action,
        command: `in-process:${node.action}`,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout ?? '',
        stderr: outcome.stderr ?? '',
        durationMs: Date.now() - startedAt
      }
      return { results: { [node.id]: result } }
    }
    if (node.kind !== 'agent-spawn') {
      throw new Error(`Unsupported node kind "${node.kind}" for step "${node.id}"`)
    }
    const resumeSessionId = node.resume
      ? state.sessions[node.resume]
      : continueSessions.includes(node.id)
        ? state.sessions[node.id]
        : undefined
    const rendered = renderStepPrompt(node, { question: plan.question, results: state.results })
    const complete = Object.hasOwn(stepPrompts, node.id) ? stepPrompts[node.id] : undefined
    const prompt = complete
      ? await complete(rendered, state.results, resumeSessionId === undefined ? {} : { resumeSessionId })
      : rendered
    let result: Awaited<ReturnType<typeof executeAgentSpawnNode>>
    try {
      result = await executeAgentSpawnNode({ node, prompt, resumeSessionId, config, spawnFn, signal })
    } catch (error) {
      const lost = redispatch?.lost(node.id) ?? null
      if (lost !== null)
        throw new Error(
          `tool-host-transport-failure: step "${node.id}" failed while ${lost}; automatic replay is unsafe after possible tool or file effects; inspect the session before resuming`,
          { cause: error }
        )
      throw error
    }
    // Successful output and its session remain authoritative even if an already-open socket was unlinked.
    redispatch?.succeeded?.(node.id)
    // The executor's own node executor reports what the agent printed as streaming events; this one
    // replaces it, so it reports the same records the same way.
    for (const reported of result.events) {
      const content = typeof reported === 'string' ? reported : JSON.stringify(reported)
      try {
        config.onEvent?.({ type: 'node:streaming', nodeId: node.id, runId: state.runId, content })
      } catch {
        // A faulty observer never fails the step it observes.
      }
    }
    return {
      results: { [node.id]: result },
      // The executor reads `session_id`; a Codex stream names its session in `thread.started`.
      sessions: (() => {
        const sessionId = result.sessionId ?? sessionIdOf(result.events)
        return sessionId ? { [node.id]: sessionId } : {}
      })()
    }
  }
}

/** The executor refuses a relative working directory; a Flow declares them relative to the root. */
function withAbsoluteWorkingDirectories(plan: Plan, root: string): Plan {
  const nodes = Object.fromEntries(
    Object.entries(plan.graph.nodes).map(([id, node]) => [
      id,
      node.kind === 'agent-spawn' ? { ...node, workingDirectory: resolve(root, node.workingDirectory) } : node
    ])
  )
  return { ...plan, graph: { ...plan.graph, nodes } }
}

interface PreparedLeg {
  plan: Plan
  config: AgentSpawnExecutorConfig
  executor: AgentLifecycleNodeExecutor
}

function prepare(options: ProcessRunOptions): PreparedLeg {
  const flow = readFlow(options.process)
  assertBindingsCover(stepsOf(flow), options.bindings)
  const plan = withAbsoluteWorkingDirectories(compileFlow(flow, options.question), options.workingDirectoryRoot)
  const config: AgentSpawnExecutorConfig = {
    roleBinaries: { ...options.bindings.roles },
    workingDirectoryRoot: options.workingDirectoryRoot,
    decisionPredicates: { ...options.bindings.decisions },
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.envAllowlist ? { envAllowlist: options.envAllowlist } : {})
  }
  return {
    plan,
    config,
    executor: nodeExecutor(
      options.bindings.actions,
      options.control,
      config,
      options.spawnFn,
      options.stepPrompts,
      options.continueSessions,
      options.persistenceBarrier ?? checkpointerBarrier(options.checkpointer),
      options.agentRedispatch
    )
  }
}

/** The checkpointer's own persistence barrier, when it keeps one. */
function checkpointerBarrier(checkpointer: ProcessRunOptions['checkpointer']): (() => Promise<void>) | undefined {
  const persisted = (checkpointer as { assertPersisted?: () => Promise<void> } | undefined)?.assertPersisted
  return typeof persisted === 'function' ? () => persisted.call(checkpointer) : undefined
}

// The executor cannot serialise legs of one run: two concurrent legs on a
// thread both pass their preconditions and run the same pending step.
const legsInFlight = new Set<string>()

async function inLeg(threadId: string, leg: () => Promise<RunOutcome>): Promise<RunOutcome> {
  if (legsInFlight.has(threadId)) throw new Error(`A leg of run thread "${threadId}" is already executing`)
  legsInFlight.add(threadId)
  try {
    return await leg()
  } finally {
    legsInFlight.delete(threadId)
  }
}

/** Starts a run of the process's Flow; a halt reports `paused` rather than rejecting. */
export async function startProcessRun(options: ProcessRunOptions, identity?: RunIdentity): Promise<RunOutcome> {
  const { plan, config, executor } = prepare(options)
  // The identity is minted inside the executor, so the leg is registered once it is known.
  let threadId: string | undefined
  try {
    return await startControlledRun({
      plan,
      config,
      checkpointer: options.checkpointer,
      control: options.control,
      executor,
      identity,
      onIdentity: (known) => {
        if (legsInFlight.has(known.threadId))
          throw new Error(`A leg of run thread "${known.threadId}" is already executing`)
        legsInFlight.add(known.threadId)
        threadId = known.threadId
      }
    })
  } finally {
    if (threadId !== undefined) legsInFlight.delete(threadId)
  }
}

/** Continues a halted run from its checkpoint on the same checkpointer; completed steps do not run again. */
export async function resumeProcessRun(options: ProcessRunOptions, identity: RunIdentity): Promise<RunOutcome> {
  const { plan, config, executor } = prepare(options)
  return inLeg(identity.threadId, async () => {
    await foldCompletedPendingWrites(plan, config, options.checkpointer, identity)
    return resumeControlledRun({
      plan,
      config,
      checkpointer: options.checkpointer,
      control: options.control,
      executor,
      identity
    })
  })
}

/**
 * A run that stopped after its last step's writes were stored but before the next full checkpoint was saved (the
 * executor saves checkpoints without blocking) holds every pending step completed: the executor would read that as a
 * terminal run and refuse the resume. Applying those writes once, stopping before any next step runs, saves the full
 * checkpoint the run would have saved, so the resume continues from the step after them and never re-runs them.
 */
async function foldCompletedPendingWrites(
  plan: Plan,
  config: AgentSpawnExecutorConfig,
  checkpointer: ProcessRunOptions['checkpointer'],
  identity: RunIdentity
): Promise<void> {
  if (checkpointer === undefined) return
  const never: AgentLifecycleNodeExecutor = async (_state, { node }) => {
    throw new Error(`step "${node.id}" ran while folding stored writes into a checkpoint`)
  }
  const graph = buildAgentSpawnStateGraph(plan, never, config, { checkpointer })
  const invokeConfig = runInvokeConfig(identity)
  const snapshot = await graph.getState(invokeConfig)
  if (snapshot.next.length > 0 || snapshot.tasks.length === 0) return
  const completed = snapshot.tasks.every((task) => task.error === undefined && task.interrupts.length === 0)
  if (!completed) return
  await graph.invoke(null, { ...invokeConfig, interruptBefore: '*' })
}

/**
 * Writes an agent adapter's generated settings files and returns the launcher
 * for one role: the adapter's argv and environment, allowed to run under the
 * given permissions.
 */
export function createRoleLauncher(
  generated: GeneratedAgentConfig,
  options: {
    generatedDir: string
    allowedPermissions: string[]
    timeoutMs?: number
    /** A Codex launch whose CODEX_HOME is the generated directory gets a copy of the operator's subscription login there. */
    stageCodexLogin?: boolean
  }
): RoleBinaryConfig {
  for (const [path, content] of Object.entries(generated.files)) {
    const target = join(options.generatedDir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    if (generated.executableFiles.includes(path)) chmodSync(target, 0o755)
  }
  if (
    options.stageCodexLogin === true &&
    generated.vendor === 'codex' &&
    generated.env.CODEX_HOME === options.generatedDir
  )
    stageCodexAuth(options.generatedDir)
  const [command, ...args] = generated.launch
  if (command === undefined) throw new Error(`The ${generated.vendor} adapter generated an empty launch command`)
  const resume = generated.resumeLaunch
  return {
    command,
    // A step that continues a session launches the adapter's resume form with that session's id.
    buildArgs: ({ resumeSessionId }) =>
      resumeSessionId !== undefined && resume !== undefined
        ? resume.slice(1).map((arg) => (arg === RESUME_SESSION_PLACEHOLDER ? resumeSessionId : arg))
        : [...args],
    allowedPermissions: options.allowedPermissions,
    env: generated.env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  }
}
