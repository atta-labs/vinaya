/**
 * Reads one completed Harbor 0.24.0 job into one freeze-record result: a
 * practice run or a scored result, of the split, backend and adapter named.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { type Quarantine, validateQuarantine } from './contracts'
import { type BootstrapMethod, separateQuarantined, suiteMean } from './estimators'
import { canonicalJson } from './neutral-case'
import {
  STEP_ONE_ADAPTERS,
  type StepOneAdapter,
  type StepOneResult,
  type StepOneRunSuite,
  type StepOneTrialResult,
  type StepOneUsage
} from './step-one'

export const HARBOR_RESULTS_VERSION = '0.24.0'

/** The committed freeze record, whose `trialsPerTask` a scored read must equal. */
export const FREEZE_RECORD_PATH = resolve(import.meta.dir, '../../../tests/eval/freeze-record.json')

/** What a read job becomes: a one-trial practice run, or a scored result at the freeze record's trials per task. */
export const HARBOR_RESULT_KINDS = ['practice', 'scored'] as const
export type HarborResultKind = (typeof HARBOR_RESULT_KINDS)[number]

export type HarborResultRefusalCode =
  | 'invalid_input'
  | 'unsupported_harbor_version'
  | 'unsupported_agent'
  | 'wrong_trial_count'
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

/** One task's trials in a Harbor job. */
export interface HarborTaskTally {
  taskId: string
  successes: number
  trials: number
  unavailable: string[]
}

type StepOneRun = StepOneResult['runs'][number]

/** The one run a Harbor job reads into, carrying the split, backend, adapter and trials per task it was read as. */
export type HarborRun = Omit<StepOneRun, 'split' | 'backend'> & {
  split: 'development' | 'held-out'
  backend: 'standalone' | 'engine'
  agent: 'vinaya'
  model: string
  auth: 'subscription'
  /** Present on a practice run only: it measures cost and is never evidence. */
  evidence?: 'never'
  /**
   * The quarantined tasks, each with its quarantine and its tally: shown,
   * and counted apart from `tasks`, `taskCount`, `mean` and `interval`;
   * their usage is still counted.
   */
  quarantined: { quarantine: Quarantine; tally: HarborTaskTally }[]
}

export interface HarborJobResult {
  kind: 'harbor-job'
  split: 'development' | 'held-out'
  backend: 'standalone' | 'engine'
  purpose: HarborResultKind
  trialsPerTask: number
  runs: [HarborRun]
}

/** The SHA-256 of the canonical JSON of a quarantine's other four fields, which binds its adjudication. */
export function quarantineAdjudicationDigest(q: Omit<Quarantine, 'adjudicationDigest'>): string {
  const { taskId, cause, reason, reasonVersion } = q
  return createHash('sha256').update(canonicalJson({ taskId, cause, reason, reasonVersion })).digest('hex')
}

/**
 * A quarantine, validated as the `Quarantine` contract and refused when its
 * adjudication digest is stale: not the digest of its other four fields.
 */
export function checkedQuarantine(input: unknown, subject: string): Quarantine {
  const validated = validateQuarantine(input)
  if (!validated.ok) {
    const { path, detail } = validated.refusal
    throw new HarborResultsRefused('invalid_input', `${subject} is not a quarantine at ${path}: ${detail}`)
  }
  if (validated.value.adjudicationDigest !== quarantineAdjudicationDigest(validated.value))
    throw new HarborResultsRefused('invalid_input', `${subject} carries a stale adjudication digest`)
  return validated.value
}

export interface HarborResultsOptions {
  jobDirectory: string
  /** Directory Harbor resolved relative local-task paths from; defaults to this process's working directory. */
  taskRoot?: string
  suite: StepOneRunSuite
  /** What the job is read as; nothing below is inferred from the job itself. */
  resultKind: HarborResultKind
  split: 'development' | 'held-out'
  backend: 'standalone' | 'engine'
  adapter: StepOneAdapter
  /** The trials each task must have: `1` for a practice run, the freeze record's trials per task for a scored one. */
  trialsPerTask: number
  /** The freeze record's `trialsPerTask`, which a scored read's `trialsPerTask` must equal; a scored read needs it. */
  freezeTrialsPerTask?: number
  subscriptionAuth: true
  bootstrap: { method: BootstrapMethod; seed: number; resamples: number; confidence: number }
}

/** The declared inputs, or a refusal before the job is opened. */
function checkDeclared(options: HarborResultsOptions): void {
  if (!(HARBOR_RESULT_KINDS as readonly unknown[]).includes(options.resultKind))
    throw new HarborResultsRefused('invalid_input', `result kind must be one of ${HARBOR_RESULT_KINDS.join(', ')}`)
  if (options.split !== 'development' && options.split !== 'held-out')
    throw new HarborResultsRefused('invalid_input', 'split must be development or held-out')
  if (options.backend !== 'standalone' && options.backend !== 'engine')
    throw new HarborResultsRefused('invalid_input', 'backend must be standalone or engine')
  if (!(STEP_ONE_ADAPTERS as readonly unknown[]).includes(options.adapter))
    throw new HarborResultsRefused('invalid_input', `adapter must be one of ${STEP_ONE_ADAPTERS.join(', ')}`)
  if (!Number.isInteger(options.trialsPerTask) || options.trialsPerTask < 1)
    throw new HarborResultsRefused('invalid_input', 'trials per task must be a positive integer')
  if (options.resultKind === 'practice') {
    if (options.trialsPerTask !== 1)
      throw new HarborResultsRefused(
        'wrong_trial_count',
        `a practice run carries exactly 1 trial per task, not ${options.trialsPerTask}`
      )
    if (options.split !== 'development')
      throw new HarborResultsRefused('invalid_input', 'a practice run reads the development split only')
    return
  }
  if (!Number.isInteger(options.freezeTrialsPerTask) || (options.freezeTrialsPerTask as number) < 1)
    throw new HarborResultsRefused('invalid_input', "the freeze record's trials per task must be a positive integer")
  if (options.trialsPerTask !== options.freezeTrialsPerTask)
    throw new HarborResultsRefused(
      'wrong_trial_count',
      `a scored result carries the freeze record's ${options.freezeTrialsPerTask} trials per task, not ${options.trialsPerTask}`
    )
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

/** The `[metadata]` fields of `task.toml` the converter writes for a quarantined case, by `Quarantine` field. */
export const QUARANTINE_METADATA = {
  cause: 'quarantine_cause',
  reason: 'quarantine_reason',
  reasonVersion: 'quarantine_reason_version',
  adjudicationDigest: 'quarantine_adjudication_digest'
} as const satisfies Record<Exclude<keyof Quarantine, 'taskId'>, string>

function metadata(
  path: string,
  taskId: string
): { suite: string; rendererVersion: string; quarantine: Quarantine | null } {
  if (!existsSync(path))
    throw new HarborResultsRefused('missing_task_metadata', `${path} is missing the converter's task.toml`)
  const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as Json
  const suite = text(parsed.metadata?.suite)
  const rendererVersion = text(parsed.metadata?.vinaya_renderer_version)
  if (suite === undefined || rendererVersion === undefined)
    throw new HarborResultsRefused('missing_task_metadata', `${path} lacks converter metadata`)
  const fields = Object.entries(QUARANTINE_METADATA).map(([field, key]) => [field, parsed.metadata?.[key]] as const)
  const present = fields.filter(([, value]) => value !== undefined)
  if (present.length === 0) return { suite, rendererVersion, quarantine: null }
  if (present.length !== fields.length)
    throw new HarborResultsRefused('missing_task_metadata', `${path} carries only part of a quarantine`)
  const quarantine = checkedQuarantine({ taskId, ...Object.fromEntries(fields) }, `${path}'s quarantine`)
  return { suite, rendererVersion, quarantine }
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

/**
 * Read and validate one Harbor job as the result kind, split, backend,
 * adapter and trials per task the options declare. A refusal is typed and no
 * partial report is returned.
 */
export function readHarborJob(options: HarborResultsOptions): {
  result: HarborJobResult
  /** Each task's trial results, in trial-directory order. */
  trials: Readonly<Record<string, StepOneTrialResult[]>>
} {
  if (options.subscriptionAuth !== true)
    throw new HarborResultsRefused('invalid_input', 'subscription authentication must be declared')
  checkDeclared(options)
  const expected = options.trialsPerTask
  const checkCount = (taskId: string, actual: number, subject: string) => {
    if (actual !== expected)
      throw new HarborResultsRefused(
        'wrong_trial_count',
        `${subject} has ${actual} trials of task ${taskId}; a ${options.resultKind} read expects exactly ${expected}`
      )
  }
  const lock = json(join(options.jobDirectory, 'lock.json'))
  if (lock.harbor?.version !== HARBOR_RESULTS_VERSION)
    throw new HarborResultsRefused(
      'unsupported_harbor_version',
      `job uses Harbor ${String(lock.harbor?.version)}, not ${HARBOR_RESULTS_VERSION}`
    )
  const identity = agentIdentity(json(join(options.jobDirectory, 'config.json')))
  const lockedTrials = Array.isArray(lock.trials) ? lock.trials : []
  if (lockedTrials.length === 0) throw new HarborResultsRefused('invalid_input', 'the job lock has no trials')
  // The lock names a task once per trial; every trial of one task locks the same task path and digest.
  const lockedByTask = new Map<string, Json>()
  const lockedCounts = new Map<string, number>()
  for (const trial of lockedTrials) {
    const taskId = text(trial.task?.name)
    if (taskId === undefined) throw new HarborResultsRefused('invalid_input', 'the job lock names a trial with no task')
    const first = lockedByTask.get(taskId)
    if (first === undefined) lockedByTask.set(taskId, trial)
    else if (text(trial.task?.path) !== text(first.task?.path) || text(trial.task?.digest) !== text(first.task?.digest))
      throw new HarborResultsRefused('invalid_input', `the job lock gives ${taskId} more than one task path or digest`)
    lockedCounts.set(taskId, (lockedCounts.get(taskId) ?? 0) + 1)
  }
  for (const [taskId, count] of lockedCounts) checkCount(taskId, count, 'the job lock')
  // A trial directory is a direct child with Harbor's terminal result file.
  const directories = readdirSync(options.jobDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(options.jobDirectory, entry.name, 'result.json')))
    .map((entry) => join(options.jobDirectory, entry.name))
    .sort()
  if (directories.length === 0) throw new HarborResultsRefused('invalid_input', 'the job has no completed trial')
  const completedCounts = new Map<string, number>()
  for (const directory of directories) {
    const taskId = text(json(join(directory, 'result.json')).task_name)
    if (taskId === undefined) throw new HarborResultsRefused('invalid_input', `${directory} has no task name`)
    completedCounts.set(taskId, (completedCounts.get(taskId) ?? 0) + 1)
  }
  if (
    completedCounts.size !== lockedByTask.size ||
    [...lockedByTask.keys()].some((taskId) => !completedCounts.has(taskId))
  )
    throw new HarborResultsRefused('invalid_input', 'completed trials do not match the job lock')
  for (const [taskId, count] of completedCounts) checkCount(taskId, count, 'the job')
  const suites = new Set<string>()
  const renderers = new Set<string>()
  const talliesByTask = new Map<string, HarborTaskTally>()
  const quarantines: Quarantine[] = []
  const trials: Record<string, StepOneTrialResult[]> = {}
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
    const taskId = text(result.task_name) as string
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
    const taskMetadata = metadata(join(task, 'task.toml'), taskId)
    if (taskMetadata.quarantine !== null && !talliesByTask.has(taskId)) quarantines.push(taskMetadata.quarantine)
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
    trials[taskId] = [...(trials[taskId] ?? []), trial]
    const tally = talliesByTask.get(taskId) ?? { taskId, successes: 0, trials: 0, unavailable: [] }
    tally.successes += trial.success ? 1 : 0
    tally.trials += 1
    if (reason !== undefined) tally.unavailable.push(reason)
    talliesByTask.set(taskId, tally)
    usage.wallTimeMs += measuredUsage.wallTimeMs
    usage.inputTokens += measuredUsage.inputTokens
    usage.outputTokens += measuredUsage.outputTokens
    usage.cacheReadTokens += measuredUsage.cacheReadTokens
    usage.cacheCreationTokens += measuredUsage.cacheCreationTokens
    usage.estimatedCostUsd += measuredUsage.estimatedCostUsd
    if (measuredUsage.subscriptionQuota === null) quotaUnavailableTrials++
    else usage.subscriptionQuota = (usage.subscriptionQuota ?? 0) + measuredUsage.subscriptionQuota
  }
  const tallies = [...talliesByTask.values()]
  if (suites.size !== 1) throw new HarborResultsRefused('mixed_suites', `job contains ${[...suites].sort().join(', ')}`)
  if (!suites.has(options.suite))
    throw new HarborResultsRefused('mixed_suites', `job suite is ${[...suites][0]}, not ${options.suite}`)
  if (renderers.size !== 1)
    throw new HarborResultsRefused('mixed_suites', 'job tasks do not share one renderer version')
  // A quarantined task is shown with its tally and counted apart: it never enters the estimate.
  const split = separateQuarantined(tallies, quarantines)
  if (!split.ok) throw new HarborResultsRefused('invalid_input', split.refusal.detail)
  const quarantinedIds = new Set(quarantines.map((q) => q.taskId))
  const estimated = tallies.filter((t) => !quarantinedIds.has(t.taskId))
  const quarantined = split.value.quarantined.map(({ quarantine }) => ({
    quarantine,
    tally: tallies.find((t) => t.taskId === quarantine.taskId) as HarborTaskTally
  }))
  const estimate = suiteMean(estimated, options.bootstrap)
  if (!estimate.ok) throw new HarborResultsRefused('invalid_input', estimate.refusal.detail)
  const run: HarborRun = {
    suite: options.suite,
    split: options.split,
    backend: options.backend,
    adapter: options.adapter,
    layer: 'G',
    rendererVersion: [...renderers][0] as string,
    agent: 'vinaya',
    model: identity.model,
    auth: 'subscription',
    ...(options.resultKind === 'practice' ? { evidence: 'never' as const } : {}),
    taskCount: estimated.length,
    trialsPerTask: expected,
    tasks: estimated,
    quarantined,
    mean: estimate.value.mean,
    interval: estimate.value.interval,
    usage: {
      ...usage,
      subscriptionQuota: quotaUnavailableTrials === directories.length ? null : usage.subscriptionQuota
    },
    quotaUnavailableTrials
  }
  return {
    trials,
    result: {
      kind: 'harbor-job',
      split: options.split,
      backend: options.backend,
      purpose: options.resultKind,
      trialsPerTask: expected,
      runs: [run]
    }
  }
}

function value(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`)
  return at < 0 ? undefined : argv[at + 1]
}

/** The `trialsPerTask` of the freeze record at `path`. */
function freezeTrialsPerTask(path: string): number {
  if (!existsSync(path)) throw new HarborResultsRefused('invalid_input', `no freeze record at ${path}`)
  const trials = json(path).trialsPerTask
  if (!Number.isInteger(trials) || trials < 1)
    throw new HarborResultsRefused('invalid_input', `${path} carries no positive integer trialsPerTask`)
  return trials
}

export function harborResultsMain(argv: readonly string[]): number {
  try {
    const jobDirectory = argv[0]
    const suite = value(argv, 'suite') as StepOneRunSuite | undefined
    const resultKind = value(argv, 'result-kind') as HarborResultKind | undefined
    const split = value(argv, 'split') as HarborResultsOptions['split'] | undefined
    const backend = value(argv, 'backend') as HarborResultsOptions['backend'] | undefined
    const adapter = value(argv, 'adapter') as StepOneAdapter | undefined
    const trials = value(argv, 'trials-per-task')
    const method = value(argv, 'bootstrap') as BootstrapMethod | undefined
    const seed = Number(value(argv, 'seed'))
    const resamples = Number(value(argv, 'resamples'))
    const confidence = Number(value(argv, 'confidence'))
    if (!jobDirectory || !suite || !method || !argv.includes('--subscription-auth'))
      throw new HarborResultsRefused(
        'invalid_input',
        'job directory, suite, subscription auth and bootstrap flags are required'
      )
    // What the job is read as is declared, never inferred from the job or its folder name.
    if (!resultKind || !split || !backend || !adapter || trials === undefined)
      throw new HarborResultsRefused(
        'invalid_input',
        '--result-kind, --split, --backend, --adapter and --trials-per-task are required'
      )
    const report = readHarborJob({
      jobDirectory,
      taskRoot: value(argv, 'task-root'),
      suite,
      resultKind,
      split,
      backend,
      adapter,
      trialsPerTask: Number(trials),
      ...(resultKind === 'scored'
        ? { freezeTrialsPerTask: freezeTrialsPerTask(value(argv, 'freeze-record') ?? FREEZE_RECORD_PATH) }
        : {}),
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
