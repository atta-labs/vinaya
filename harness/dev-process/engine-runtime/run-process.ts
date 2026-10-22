import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { compileFlow, type Plan, type StepsFlow } from '@atta/engine'
import {
  type AgentLifecycleNodeExecutor,
  type AgentSpawnExecutorConfig,
  type AgentSpawnGraphStateValue,
  type MechanicalNodeResult,
  type RoleBinaryConfig,
  type RunControl,
  type RunIdentity,
  type RunOutcome,
  type SpawnFn,
  type StepNodeResult,
  type StartControlledRunParams,
  executeAgentSpawnNode,
  renderStepPrompt,
  resumeControlledRun,
  startControlledRun
} from '@atta/executor-agent-spawn'
import { parse } from 'yaml'
import type { GeneratedAgentConfig } from '../../adapters/agents/policy'
import type { LoadedProcess } from '../loader/load-process'

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
}

export type StepPrompt = (
  rendered: string,
  results: Readonly<Record<string, StepNodeResult>>
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
  config: AgentSpawnExecutorConfig,
  spawnFn: SpawnFn | undefined,
  stepPrompts: Readonly<Record<string, StepPrompt>> = {}
): AgentLifecycleNodeExecutor {
  return async (state: AgentSpawnGraphStateValue, { node, plan, signal }) => {
    if (node.kind === 'mechanical') {
      const action = actions[node.action]
      if (!action) throw new Error(`Action "${node.action}" (step "${node.id}") has no entry in the action registry`)
      const startedAt = Date.now()
      const outcome = await action({ nodeId: node.id, action: node.action, results: state.results, signal })
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
    const resumeSessionId = node.resume ? state.sessions[node.resume] : undefined
    const rendered = renderStepPrompt(node, { question: plan.question, results: state.results })
    const complete = Object.hasOwn(stepPrompts, node.id) ? stepPrompts[node.id] : undefined
    const prompt = complete ? await complete(rendered, state.results) : rendered
    const result = await executeAgentSpawnNode({ node, prompt, resumeSessionId, config, spawnFn, signal })
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
      sessions: result.sessionId ? { [node.id]: result.sessionId } : {}
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
    executor: nodeExecutor(options.bindings.actions, config, options.spawnFn, options.stepPrompts)
  }
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
  return inLeg(identity.threadId, () =>
    resumeControlledRun({
      plan,
      config,
      checkpointer: options.checkpointer,
      control: options.control,
      executor,
      identity
    })
  )
}

/**
 * Writes an agent adapter's generated settings files and returns the launcher
 * for one role: the adapter's argv and environment, allowed to run under the
 * given permissions.
 */
export function createRoleLauncher(
  generated: GeneratedAgentConfig,
  options: { generatedDir: string; allowedPermissions: string[]; timeoutMs?: number }
): RoleBinaryConfig {
  for (const [path, content] of Object.entries(generated.files)) {
    const target = join(options.generatedDir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    if (generated.executableFiles.includes(path)) chmodSync(target, 0o755)
  }
  const [command, ...args] = generated.launch
  if (command === undefined) throw new Error(`The ${generated.vendor} adapter generated an empty launch command`)
  return {
    command,
    buildArgs: () => [...args],
    allowedPermissions: options.allowedPermissions,
    env: generated.env,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  }
}
