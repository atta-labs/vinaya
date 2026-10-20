/** Reads one completed Harbor 0.24.0 job into a step-one practice result. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { suiteMean, type BootstrapMethod } from './estimators'
import type { StepOneAdapter, StepOneResult, StepOneRunSuite, StepOneTrialResult, StepOneUsage } from './step-one'

export const HARBOR_RESULTS_VERSION = '0.24.0'

export type HarborResultRefusalCode =
  | 'invalid_input'
  | 'unsupported_harbor_version'
  | 'unsupported_agent'
  | 'multiple_trials_per_task'
  | 'mixed_suites'
  | 'missing_task_metadata'

export class HarborResultsRefused extends Error {
  constructor(
    readonly code: HarborResultRefusalCode,
    message: string
  ) {
    super(message)
    this.name = 'HarborResultsRefused'
  }
}

export interface HarborPracticeRun extends StepOneResult {
  purpose: 'practice'
  trialsPerTask: 1
  runs: Array<
    StepOneResult['runs'][number] & {
      agent: 'vinaya'
      model: string
      auth: 'subscription'
      evidence: 'never'
    }
  >
}

export interface HarborResultsOptions {
  jobDirectory: string
  /** Directory Harbor resolved relative local-task paths from; defaults to this process's working directory. */
  taskRoot?: string
  suite: StepOneRunSuite
  subscriptionAuth: true
  bootstrap: { method: BootstrapMethod; seed: number; resamples: number; confidence: number }
}

type Json = Record<string, any>
const json = (path: string): Json => JSON.parse(readFileSync(path, 'utf8')) as Json
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const number = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback

function taskPath(taskRoot: string | undefined, raw: string): string {
  const root = resolve(taskRoot ?? process.cwd())
  const path = resolve(root, raw)
  const fromRoot = relative(root, path)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
    throw new HarborResultsRefused('missing_task_metadata', `task path ${raw} escapes its declared task root`)
  return path
}

function same(value: unknown, expected: string, subject: string): void {
  if (text(value) !== expected)
    throw new HarborResultsRefused('invalid_input', `${subject} does not match the job lock`)
}

function metadata(path: string): { suite: string; rendererVersion: string } {
  if (!existsSync(path))
    throw new HarborResultsRefused('missing_task_metadata', `${path} is missing the converter's task.toml`)
  const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as Json
  const suite = text(parsed.metadata?.suite)
  const rendererVersion = text(parsed.metadata?.vinaya_renderer_version)
  if (suite === undefined || rendererVersion === undefined)
    throw new HarborResultsRefused('missing_task_metadata', `${path} lacks converter metadata`)
  return { suite, rendererVersion }
}

/**
 * The job's one agent. `configuredName` and `importPath` are exactly what the job config carries, which Harbor
 * copies into every lock and trial config; `agent` is the normalized `vinaya` identity that only a trial result's
 * `agent_info` name and the report carry.
 */
interface AgentIdentity {
  agent: string
  configuredName: string
  importPath: string | undefined
  model: string
}

function agentIdentity(config: Json): AgentIdentity {
  const agents = Array.isArray(config.agents) ? config.agents : config.agent ? [config.agent] : []
  if (agents.length !== 1) throw new HarborResultsRefused('unsupported_agent', 'the job must name exactly one agent')
  const configuredName = text(agents[0]?.name)
  const importPath = text(agents[0]?.import_path)
  const agent =
    configuredName === 'vinaya_harbor_agent:VinayaAgent' || importPath === 'vinaya_harbor_agent:VinayaAgent'
      ? 'vinaya'
      : configuredName
  if (agent !== 'vinaya' || configuredName === undefined)
    throw new HarborResultsRefused('unsupported_agent', `job agent is ${agent ?? 'missing'}, not vinaya`)
  const model = text(agents[0]?.model_name)
  if (model === undefined || model.length === 0)
    throw new HarborResultsRefused('invalid_input', 'the job config does not carry an exact model id')
  return { agent, configuredName, importPath, model }
}

function sameAgent(value: unknown, expected: AgentIdentity, subject: string): void {
  const record = value as Json | null | undefined
  same(record?.name, expected.configuredName, `${subject} agent`)
  same(record?.model_name, expected.model, `${subject} model`)
  if (expected.importPath !== undefined) same(record?.import_path, expected.importPath, `${subject} import path`)
}

function wallTime(result: Json): number {
  const start = Date.parse(text(result.started_at) ?? '')
  const finish = Date.parse(text(result.finished_at) ?? '')
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? finish - start : 0
}

function unavailable(result: Json, reward: unknown): string | undefined {
  const exception = result.exception_info
  if (exception !== null && typeof exception === 'object')
    return `${text(exception.exception_type) ?? 'trial error'}: ${text(exception.exception_message) ?? 'no message'}`
  return typeof reward === 'number' ? undefined : 'trial has no verifier reward'
}

/** Read and validate one Harbor job. A refusal is typed and no partial report is returned. */
export function readHarborPracticeRun(options: HarborResultsOptions): {
  result: HarborPracticeRun
  trials: Readonly<Record<string, StepOneTrialResult>>
} {
  if (options.subscriptionAuth !== true)
    throw new HarborResultsRefused('invalid_input', 'subscription authentication must be declared')
  const lock = json(join(options.jobDirectory, 'lock.json'))
  if (lock.harbor?.version !== HARBOR_RESULTS_VERSION)
    throw new HarborResultsRefused(
      'unsupported_harbor_version',
      `job uses Harbor ${String(lock.harbor?.version)}, not ${HARBOR_RESULTS_VERSION}`
    )
  const identity = agentIdentity(json(join(options.jobDirectory, 'config.json')))
  const lockedTrials = Array.isArray(lock.trials) ? lock.trials : []
  if (lockedTrials.length === 0) throw new HarborResultsRefused('invalid_input', 'the job lock has no trials')
  const lockedByTask = new Map<string, Json>()
  for (const trial of lockedTrials) {
    const taskId = text(trial.task?.name)
    if (taskId === undefined || lockedByTask.has(taskId))
      throw new HarborResultsRefused('multiple_trials_per_task', 'the job lock must name each task exactly once')
    lockedByTask.set(taskId, trial)
  }
  // A trial directory is a direct child with Harbor's terminal result file.
  const directories = readdirSync(options.jobDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(options.jobDirectory, entry.name, 'result.json')))
    .map((entry) => join(options.jobDirectory, entry.name))
    .sort()
  if (directories.length === 0) throw new HarborResultsRefused('invalid_input', 'the job has no completed trial')
  const discoveredTaskIds = directories.map((directory) => text(json(join(directory, 'result.json')).task_name))
  if (new Set(discoveredTaskIds).size !== discoveredTaskIds.length)
    throw new HarborResultsRefused('multiple_trials_per_task', 'the job has more than one trial for one task')
  const seen = new Set<string>()
  const suites = new Set<string>()
  const renderers = new Set<string>()
  const tallies: Array<{ taskId: string; successes: number; trials: number; unavailable: string[] }> = []
  const trials: Record<string, StepOneTrialResult> = {}
  const usage: StepOneUsage = {
    wallTimeMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    subscriptionQuota: 0,
    estimatedCostUsd: 0
  }
  let quotaUnavailableTrials = 0
  for (const directory of directories) {
    const result = json(join(directory, 'result.json'))
    const config = existsSync(join(directory, 'config.json'))
      ? json(join(directory, 'config.json'))
      : (result.config ?? {})
    const trialLock = existsSync(join(directory, 'lock.json')) ? json(join(directory, 'lock.json')) : {}
    const taskId = text(result.task_name)
    if (taskId === undefined) throw new HarborResultsRefused('invalid_input', `${directory} has no task name`)
    if (seen.has(taskId))
      throw new HarborResultsRefused('multiple_trials_per_task', `job has more than one trial for ${taskId}`)
    seen.add(taskId)
    const locked = lockedByTask.get(taskId)
    if (locked === undefined)
      throw new HarborResultsRefused('invalid_input', `${directory} names a task absent from the job lock`)
    const trialName = basename(directory)
    const lockedPath = text(locked.task?.path)
    if (lockedPath === undefined)
      throw new HarborResultsRefused('missing_task_metadata', `the job lock has no path for ${taskId}`)
    same(result.trial_name, trialName, `${directory} result trial name`)
    same(config.trial_name, trialName, `${directory} config trial name`)
    sameAgent(locked.agent, identity, `${directory} job lock`)
    sameAgent(config.agent, identity, `${directory} config`)
    sameAgent(trialLock.agent, identity, `${directory} trial lock`)
    same(result.agent_info?.name, identity.agent, `${directory} result agent`)
    same(result.agent_info?.model_info?.name, identity.model, `${directory} result model`)
    same(trialLock.task?.name, taskId, `${directory} trial lock task name`)
    same(config.task?.path, lockedPath, `${directory} config task path`)
    same(trialLock.task?.path, lockedPath, `${directory} trial lock task path`)
    same(result.task_id?.path, lockedPath, `${directory} result task path`)
    // Harbor's result `task_checksum` is a different hash from the lock digest, so only the two locks are bound.
    same(trialLock.task?.digest, text(locked.task?.digest) ?? '', `${directory} trial lock task digest`)
    const task = taskPath(options.taskRoot, lockedPath)
    const taskMetadata = metadata(join(task, 'task.toml'))
    suites.add(taskMetadata.suite)
    renderers.add(taskMetadata.rendererVersion)
    const reward = result.verifier_result?.rewards?.reward
    const reason = unavailable(result, reward)
    const usagePath = join(directory, 'agent', 'vinaya-usage.json')
    if (!existsSync(usagePath) && reason === undefined)
      throw new HarborResultsRefused('invalid_input', `${directory} has no synced vinaya-usage.json`)
    const trialUsage = existsSync(usagePath) ? json(usagePath) : null
    const measuredUsage: StepOneUsage = {
      wallTimeMs: wallTime(result),
      inputTokens: number(trialUsage?.inputTokens),
      outputTokens: number(trialUsage?.outputTokens),
      // A usage file written before cache was counted has neither field: it reads as `0`.
      cacheReadTokens: number(trialUsage?.cacheReadTokens),
      cacheCreationTokens: number(trialUsage?.cacheCreationTokens),
      subscriptionQuota:
        trialUsage === null || trialUsage.subscriptionQuota === null ? null : number(trialUsage.subscriptionQuota),
      estimatedCostUsd: number(trialUsage?.estimatedCostUsd)
    }
    const trial: StepOneTrialResult = {
      success: reward === 1 && reason === undefined,
      ...(reason === undefined ? {} : { unavailableReason: reason }),
      layer: 'G',
      rendererVersion: taskMetadata.rendererVersion,
      usage: measuredUsage
    }
    trials[taskId] = trial
    tallies.push({ taskId, successes: trial.success ? 1 : 0, trials: 1, unavailable: reason ? [reason] : [] })
    usage.wallTimeMs += measuredUsage.wallTimeMs
    usage.inputTokens += measuredUsage.inputTokens
    usage.outputTokens += measuredUsage.outputTokens
    usage.cacheReadTokens += measuredUsage.cacheReadTokens
    usage.cacheCreationTokens += measuredUsage.cacheCreationTokens
    usage.estimatedCostUsd += measuredUsage.estimatedCostUsd
    if (measuredUsage.subscriptionQuota === null) quotaUnavailableTrials++
    else usage.subscriptionQuota = (usage.subscriptionQuota ?? 0) + measuredUsage.subscriptionQuota
  }
  if (seen.size !== lockedByTask.size || [...lockedByTask.keys()].some((taskId) => !seen.has(taskId)))
    throw new HarborResultsRefused('invalid_input', 'completed trials do not match the job lock')
  if (suites.size !== 1) throw new HarborResultsRefused('mixed_suites', `job contains ${[...suites].sort().join(', ')}`)
  if (!suites.has(options.suite))
    throw new HarborResultsRefused('mixed_suites', `job suite is ${[...suites][0]}, not ${options.suite}`)
  if (renderers.size !== 1)
    throw new HarborResultsRefused('mixed_suites', 'job tasks do not share one renderer version')
  const estimate = suiteMean(tallies, options.bootstrap)
  if (!estimate.ok) throw new HarborResultsRefused('invalid_input', estimate.refusal.detail)
  const run: HarborPracticeRun['runs'][number] = {
    suite: options.suite,
    split: 'development',
    backend: 'standalone',
    adapter: 'claude-code' as StepOneAdapter,
    layer: 'G',
    rendererVersion: [...renderers][0] as string,
    agent: 'vinaya',
    model: identity.model,
    auth: 'subscription',
    evidence: 'never',
    taskCount: tallies.length,
    trialsPerTask: 1,
    tasks: tallies,
    mean: estimate.value.mean,
    interval: estimate.value.interval,
    usage: { ...usage, subscriptionQuota: quotaUnavailableTrials === tallies.length ? null : usage.subscriptionQuota },
    quotaUnavailableTrials
  }
  return {
    trials,
    result: {
      kind: 'development-standalone-step-one',
      split: 'development',
      backend: 'standalone',
      purpose: 'practice',
      trialsPerTask: 1,
      runs: [run]
    }
  }
}

function value(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`)
  return at < 0 ? undefined : argv[at + 1]
}

export function harborResultsMain(argv: readonly string[]): number {
  try {
    const jobDirectory = argv[0]
    const suite = value(argv, 'suite') as StepOneRunSuite | undefined
    const method = value(argv, 'bootstrap') as BootstrapMethod | undefined
    const seed = Number(value(argv, 'seed'))
    const resamples = Number(value(argv, 'resamples'))
    const confidence = Number(value(argv, 'confidence'))
    if (!jobDirectory || !suite || !method || !argv.includes('--subscription-auth'))
      throw new HarborResultsRefused(
        'invalid_input',
        'job directory, suite, subscription auth and bootstrap flags are required'
      )
    const report = readHarborPracticeRun({
      jobDirectory,
      taskRoot: value(argv, 'task-root'),
      suite,
      subscriptionAuth: true,
      bootstrap: { method, seed, resamples, confidence }
    }).result
    const output = `${JSON.stringify(report, null, 2)}\n`
    const out = value(argv, 'out')
    if (out) writeFileSync(out, output)
    else process.stdout.write(output)
    return 0
  } catch (error) {
    const refusal =
      error instanceof HarborResultsRefused ? error : new HarborResultsRefused('invalid_input', String(error))
    process.stderr.write(`${refusal.code}: ${refusal.message}\n`)
    return 2
  }
}

if (import.meta.main) process.exit(harborResultsMain(process.argv.slice(2)))
