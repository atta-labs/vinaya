import { GRADER_LAYERS, type GraderLayer } from './contracts'
import { BOOTSTRAP_METHODS } from './estimators'
import { STEP_ONE_ADAPTERS, STEP_ONE_SUITES, type StepOneAdapter } from './step-one'

/**
 * The process layer every L5 and L6 suite declares in the module registry
 * (`apps/cli/tests/eval/registry/modules.json`): `G` when its graders read
 * only process-neutral outcomes, `P` when they read one process's artifacts.
 * The registry test proves this table equals the registry's declarations.
 */
export const LIVE_SUITE_LAYERS = {
  'source-delivery.l5': 'P',
  'source-delivery-neutral.l5': 'G',
  'developer-capability.l5': 'P',
  'developer-capability-neutral.l5': 'G',
  'tool-catalog.l5': 'P',
  'code-reviewer-quality.l5': 'P',
  'code-reviewer-quality-neutral.l5': 'G',
  'security-reviewer-quality.l5': 'P',
  'security-reviewer-quality-neutral.l5': 'G',
  'whole-loop.l6': 'G',
  'backend-selection.l6': 'P',
  'operator.l5': 'P'
} as const satisfies Record<string, GraderLayer>
export type LiveSuite = keyof typeof LIVE_SUITE_LAYERS

/** The layer-`G` suites: the only suites the standalone and Engine backends are compared on. */
export const BACKEND_COMPARISON_SUITES = (Object.keys(LIVE_SUITE_LAYERS) as LiveSuite[]).filter(
  (suite) => LIVE_SUITE_LAYERS[suite] === 'G'
)

export interface MeasuredResult {
  suite: string
  /** The suite's process layer, as the module registry declares it. */
  layer: GraderLayer
  /** The renderer version the trial records were made under; empty only for a layer-`P` suite, which has no renderer. */
  rendererVersion: string
  split: 'development' | 'held-out'
  backend: 'standalone' | 'engine'
  adapter: StepOneAdapter
  taskCount: number
  trialsPerTask: number
  tasks: Array<{ taskId: string; successes: number; trials: number }>
  mean: number
  interval: { lower: number; upper: number }
  usage: {
    wallTimeMs: number
    /** Uncached input tokens. */
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    subscriptionQuota: number | null
    estimatedCostUsd: number
  }
}

/** A one-trial development run that measures cost; never evidence for any decision. */
export interface PracticeRunResult extends MeasuredResult {
  split: 'development'
  trialsPerTask: 1
  evidence: 'never'
}

/**
 * A standalone held-out result of a backend-comparison suite: the baseline
 * the Engine held-out result is paired against, pinned to the SHA-256 of the
 * held-out case file it was run on.
 */
export interface StandaloneHeldOutResult extends MeasuredResult {
  split: 'held-out'
  backend: 'standalone'
  heldOutDigest: string
}

/** Each backend-comparison suite's pinned held-out case-file digest, by suite name without its version. */
export type HeldOutDigests = Readonly<Record<string, string>>

/** An Engine held-out result, with the time it was recorded. */
export interface EngineHeldOutResult extends MeasuredResult {
  split: 'held-out'
  backend: 'engine'
  recordedAt: string
}

/** The layer-`G` reviewer suites, whose floors also bound the adjudicated false-blocking rate. */
const REVIEWER_COMPARISON_SUITES: readonly string[] = [
  'code-reviewer-quality-neutral.l5',
  'security-reviewer-quality-neutral.l5'
]
/** The whole-loop suite, whose floor also bounds spend and wall time per task. */
const WHOLE_LOOP_SUITE = 'whole-loop.l6'

/**
 * One backend-comparison floor per layer-`G` suite, valued by the Principal
 * from product risk. The reviewer suites add a maximum adjudicated
 * false-blocking rate; the whole loop adds its spend and wall-time bounds.
 */
export interface BackendComparisonFloor {
  suite: string
  layer: 'G'
  value: number
  basis: 'principal-product-risk'
  maximumAdjudicatedFalseBlockingRate?: number
  maximumSpendUsd?: number
  maximumWallTimeMs?: number
}

/**
 * The comparison parameters, recorded from the paired development pilot
 * before any Engine held-out result, so the standalone layer-`G` baseline may
 * be observed first. Absent until that pilot runs; an Engine held-out result
 * is refused while they are absent.
 */
export interface ComparisonParameters {
  recordedAt: string
  margin: number
  trialsPerTask: number
  minimumTaskCount: number
}

export interface FreezeRecord {
  schemaVersion: 1
  floors: {
    developerMinimumResolvedRate: {
      value: number
      basis: 'principal-product-risk'
    }
    codeReviewerMinimumRecall: {
      value: number
      basis: 'principal-product-risk'
    }
    codeReviewerMaximumAdjudicatedFalseBlockingRate: {
      value: number
      basis: 'principal-product-risk'
    }
    wholeLoopRemainingTasksPass3: {
      value: number
      basis: 'principal-product-risk'
      maximumSpendUsd: number
      maximumWallTimeMs: number
    }
  }
  bootstrap: {
    method: 'percentile' | 'basic'
    seed: number
    resamples: number
    confidence: number
  }
  trialsPerTask: number
  liveRunBudget: {
    subscriptionQuota: number
    estimatedCostUsd: number
    wallTimeMs: number
  }
  cadence: { nightly: string; weekly: string; release: string }
  developmentRuns: MeasuredResult[]
  backendComparisonFloors: BackendComparisonFloor[]
  practiceRuns: PracticeRunResult[]
  standaloneHeldOutBaseline: StandaloneHeldOutResult[]
  comparisonParameters?: ComparisonParameters
  engineHeldOut: EngineHeldOutResult[]
  heldOut: {
    toolSelection: {
      suite: 'tool-catalog.l5'
      floor: 0.95
      results: MeasuredResult[]
    }
    sourceCitation: {
      suite: 'source-delivery.l5'
      floor: 0.95
      results: MeasuredResult[]
    }
  }
  owed: {
    wholeLoopStepOne: {
      status: 'owed'
      reason: 'no disposable sandbox repository yet'
    }
    operatorCapabilitySelectionStepOne: {
      status: 'owed'
      project: 'Operator on one host'
      reason: string
    }
  }
}

export type FreezeRecordValidation =
  | { ok: true; value: FreezeRecord }
  | {
      ok: false
      refusal: { code: 'invalid_freeze_record'; path: string; detail: string }
    }

const fail = (path: string, detail: string): FreezeRecordValidation => ({
  ok: false,
  refusal: { code: 'invalid_freeze_record', path, detail }
})
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const bounded = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1
const nonNegative = (value: unknown): value is number => finite(value) && value >= 0
const positiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
/** A UTC ISO-8601 timestamp that names a real instant, such as `2026-10-17T09:30:00Z`. */
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  TIMESTAMP.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
const exact = (
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
): FreezeRecordValidation | null => {
  const allowed = new Set(keys)
  const extra = Object.keys(value).find((key) => !allowed.has(key))
  if (extra !== undefined) return fail(path === '' ? extra : `${path}.${extra}`, 'unexpected value')
  const missing = keys.find((key) => !(key in value))
  return missing === undefined ? null : fail(path === '' ? missing : `${path}.${missing}`, 'value is required')
}

const MEASURED_KEYS = [
  'suite',
  'layer',
  'rendererVersion',
  'split',
  'backend',
  'adapter',
  'taskCount',
  'trialsPerTask',
  'tasks',
  'mean',
  'interval',
  'usage'
] as const

function measuredResult(
  input: unknown,
  path: string,
  expected: {
    suites: readonly string[]
    split: 'development' | 'held-out'
    backends: readonly ('standalone' | 'engine')[]
    trials: number
    /** Why a result with another trial count is refused. */
    trialsDetail?: string
    /** Keys this kind of result adds to the measured ones. */
    extraKeys?: readonly string[]
  }
): FreezeRecordValidation | null {
  if (!object(input)) return fail(path, 'measured result object is required')
  const shape = exact(input, [...MEASURED_KEYS, ...(expected.extraKeys ?? [])], path)
  if (shape !== null) return shape
  if (!expected.suites.includes(String(input.suite))) return fail(`${path}.suite`, 'suite is not permitted here')
  const declared = LIVE_SUITE_LAYERS[input.suite as LiveSuite] as GraderLayer | undefined
  if (!(GRADER_LAYERS as readonly unknown[]).includes(input.layer)) return fail(`${path}.layer`, 'must be G or P')
  if (input.layer !== declared) return fail(`${path}.layer`, `must equal the layer the registry declares, ${declared}`)
  if (typeof input.rendererVersion !== 'string') return fail(`${path}.rendererVersion`, 'string is required')
  if (input.layer === 'G' && input.rendererVersion.trim() === '')
    return fail(`${path}.rendererVersion`, 'a layer-G result names the renderer version of its trial records')
  if (input.split !== expected.split) return fail(`${path}.split`, `must equal ${expected.split}`)
  if (!(expected.backends as readonly unknown[]).includes(input.backend))
    return fail(`${path}.backend`, `must equal ${expected.backends.join(' or ')}`)
  if (!(STEP_ONE_ADAPTERS as readonly unknown[]).includes(input.adapter))
    return fail(`${path}.adapter`, 'unknown adapter')
  if (!positiveInteger(input.taskCount)) return fail(`${path}.taskCount`, 'positive integer is required')
  if (input.trialsPerTask !== expected.trials)
    return fail(`${path}.trialsPerTask`, expected.trialsDetail ?? 'does not match the freeze')
  if (!Array.isArray(input.tasks) || input.tasks.length !== input.taskCount)
    return fail(`${path}.tasks`, 'must contain exactly taskCount tallies')
  const ids = new Set<string>()
  for (const [index, raw] of input.tasks.entries()) {
    const itemPath = `${path}.tasks[${index}]`
    if (!object(raw)) return fail(itemPath, 'task tally object is required')
    const tallyShape = exact(raw, ['taskId', 'successes', 'trials'], itemPath)
    if (tallyShape !== null) return tallyShape
    if (typeof raw.taskId !== 'string' || raw.taskId === '' || ids.has(raw.taskId))
      return fail(`${itemPath}.taskId`, 'non-empty unique task id is required')
    ids.add(raw.taskId)
    if (raw.trials !== expected.trials)
      return fail(`${itemPath}.trials`, expected.trialsDetail ?? 'does not match the freeze')
    if (
      !Number.isInteger(raw.successes) ||
      (raw.successes as number) < 0 ||
      (raw.successes as number) > (raw.trials as number)
    )
      return fail(itemPath, 'successes and trials are inconsistent')
  }
  if (!bounded(input.mean)) return fail(`${path}.mean`, 'must be between 0 and 1')
  if (!object(input.interval)) return fail(`${path}.interval`, 'interval object is required')
  const intervalShape = exact(input.interval, ['lower', 'upper'], `${path}.interval`)
  if (intervalShape !== null) return intervalShape
  if (
    !bounded(input.interval.lower) ||
    !bounded(input.interval.upper) ||
    input.interval.lower > input.mean ||
    input.mean > input.interval.upper
  )
    return fail(`${path}.interval`, 'must contain the mean inside [0, 1]')
  if (!object(input.usage)) return fail(`${path}.usage`, 'usage object is required')
  const usageShape = exact(
    input.usage,
    [
      'wallTimeMs',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'subscriptionQuota',
      'estimatedCostUsd'
    ],
    `${path}.usage`
  )
  if (usageShape !== null) return usageShape
  for (const key of [
    'wallTimeMs',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'estimatedCostUsd'
  ])
    if (!nonNegative(input.usage[key])) return fail(`${path}.usage.${key}`, 'non-negative number is required')
  if (input.usage.subscriptionQuota !== null && !nonNegative(input.usage.subscriptionQuota))
    return fail(`${path}.usage.subscriptionQuota`, 'must be null or a non-negative number')
  return null
}

/**
 * Validates the complete record before any authoritative held-out run.
 * `heldOutDigests` names each backend-comparison suite's pinned held-out
 * case-file digest, which its standalone baseline entries must carry.
 */
export function validateFreezeRecord(input: unknown, heldOutDigests: HeldOutDigests): FreezeRecordValidation {
  if (!object(input)) return fail('', 'record is required')
  // The comparison parameters are the one optional root value: they are
  // recorded only from the paired development pilot.
  const hasParameters = 'comparisonParameters' in input
  const root = exact(
    input,
    [
      'schemaVersion',
      'floors',
      'bootstrap',
      'trialsPerTask',
      'liveRunBudget',
      'cadence',
      'developmentRuns',
      'backendComparisonFloors',
      'practiceRuns',
      'standaloneHeldOutBaseline',
      ...(hasParameters ? ['comparisonParameters'] : []),
      'engineHeldOut',
      'heldOut',
      'owed'
    ],
    ''
  )
  if (root !== null) return root
  if (input.schemaVersion !== 1) return fail('schemaVersion', 'must equal 1')
  if (!object(input.floors)) return fail('floors', 'object is required')
  const floorKeys = [
    'developerMinimumResolvedRate',
    'codeReviewerMinimumRecall',
    'codeReviewerMaximumAdjudicatedFalseBlockingRate',
    'wholeLoopRemainingTasksPass3'
  ]
  const floorShape = exact(input.floors, floorKeys, 'floors')
  if (floorShape !== null) return floorShape
  for (const key of floorKeys) {
    const floor = input.floors[key]
    if (!object(floor)) return fail(`floors.${key}`, 'object is required')
    const keys =
      key === 'wholeLoopRemainingTasksPass3'
        ? ['value', 'basis', 'maximumSpendUsd', 'maximumWallTimeMs']
        : ['value', 'basis']
    const shape = exact(floor, keys, `floors.${key}`)
    if (shape !== null) return shape
    if (!bounded(floor.value)) return fail(`floors.${key}.value`, 'must be between 0 and 1')
    if (floor.basis !== 'principal-product-risk')
      return fail(`floors.${key}.basis`, 'floors must come from Principal product risk, never a standalone score')
    if (
      key === 'wholeLoopRemainingTasksPass3' &&
      (!nonNegative(floor.maximumSpendUsd) || !nonNegative(floor.maximumWallTimeMs))
    )
      return fail(`floors.${key}`, 'spend and wall-time acceptance budgets are required')
  }
  if (!object(input.bootstrap)) return fail('bootstrap', 'object is required')
  const bootstrapShape = exact(input.bootstrap, ['method', 'seed', 'resamples', 'confidence'], 'bootstrap')
  if (bootstrapShape !== null) return bootstrapShape
  if (!(BOOTSTRAP_METHODS as readonly unknown[]).includes(input.bootstrap.method))
    return fail('bootstrap.method', 'unsupported bootstrap method')
  if (
    !Number.isInteger(input.bootstrap.seed) ||
    (input.bootstrap.seed as number) < 0 ||
    (input.bootstrap.seed as number) > 0xffff_ffff
  )
    return fail('bootstrap.seed', 'unsigned 32-bit integer is required')
  if (!Number.isInteger(input.bootstrap.resamples) || (input.bootstrap.resamples as number) < 1)
    return fail('bootstrap.resamples', 'positive integer is required')
  if (
    !finite(input.bootstrap.confidence) ||
    !((input.bootstrap.confidence as number) > 0 && (input.bootstrap.confidence as number) < 1)
  )
    return fail('bootstrap.confidence', 'must lie strictly between 0 and 1')
  if (!Number.isInteger(input.trialsPerTask) || (input.trialsPerTask as number) < 1)
    return fail('trialsPerTask', 'positive integer is required')
  const trials = input.trialsPerTask as number
  if (!object(input.liveRunBudget)) return fail('liveRunBudget', 'object is required')
  const budgetShape = exact(
    input.liveRunBudget,
    ['subscriptionQuota', 'estimatedCostUsd', 'wallTimeMs'],
    'liveRunBudget'
  )
  if (budgetShape !== null) return budgetShape
  for (const key of ['subscriptionQuota', 'estimatedCostUsd', 'wallTimeMs'])
    if (!nonNegative(input.liveRunBudget[key])) return fail(`liveRunBudget.${key}`, 'non-negative number is required')
  if (!object(input.cadence)) return fail('cadence', 'object is required')
  const cadenceShape = exact(input.cadence, ['nightly', 'weekly', 'release'], 'cadence')
  if (cadenceShape !== null) return cadenceShape
  for (const key of ['nightly', 'weekly', 'release'])
    if (typeof input.cadence[key] !== 'string' || input.cadence[key] === '')
      return fail(`cadence.${key}`, 'value is required')

  // The step-one suites run standalone only; a backend-comparison suite's
  // paired development pilot holds one standalone and one Engine result per
  // adapter, on the same tasks at the same trials per task.
  if (!Array.isArray(input.developmentRuns)) return fail('developmentRuns', 'array is required')
  const development = new Map<string, { index: number; value: MeasuredResult }>()
  for (const [index, result] of input.developmentRuns.entries()) {
    const path = `developmentRuns[${index}]`
    const invalid = measuredResult(result, path, {
      suites: [...STEP_ONE_SUITES, ...BACKEND_COMPARISON_SUITES],
      split: 'development',
      backends: ['standalone', 'engine'],
      trials
    })
    if (invalid !== null) return invalid
    const value = result as MeasuredResult
    if (value.backend === 'engine' && !BACKEND_COMPARISON_SUITES.includes(value.suite as LiveSuite))
      return fail(`${path}.backend`, 'only a backend-comparison suite has an Engine development result')
    const key = `${value.suite}:${value.adapter}:${value.backend}`
    if (development.has(key)) return fail(path, 'at most one result per suite, adapter and backend is permitted')
    development.set(key, { index, value })
  }
  for (const { index, value: engine } of development.values()) {
    if (engine.backend !== 'engine') continue
    const standalone = development.get(`${engine.suite}:${engine.adapter}:standalone`)?.value
    if (standalone === undefined) continue
    const path = `developmentRuns[${index}]`
    if (engine.trialsPerTask !== standalone.trialsPerTask)
      return fail(
        `${path}.trialsPerTask`,
        `a pilot pair runs both backends at the same trials per task: Engine ${engine.trialsPerTask}, standalone ${standalone.trialsPerTask}`
      )
    const standaloneTasks = new Set(standalone.tasks.map((task) => task.taskId))
    if (engine.tasks.length !== standaloneTasks.size || engine.tasks.some((task) => !standaloneTasks.has(task.taskId)))
      return fail(`${path}.tasks`, 'a pilot pair runs both backends on the same tasks')
  }

  if (!Array.isArray(input.backendComparisonFloors)) return fail('backendComparisonFloors', 'array is required')
  const floored: string[] = []
  for (const [index, floor] of input.backendComparisonFloors.entries()) {
    const path = `backendComparisonFloors[${index}]`
    if (!object(floor)) return fail(path, 'floor object is required')
    const declared = LIVE_SUITE_LAYERS[floor.suite as LiveSuite] as GraderLayer | undefined
    if (declared === 'P') return fail(`${path}.suite`, 'a backend-comparison floor attaches only to a layer-G suite')
    if (declared === undefined) return fail(`${path}.suite`, 'unknown live suite')
    const suite = floor.suite as string
    const floorShape = exact(
      floor,
      [
        'suite',
        'layer',
        'value',
        'basis',
        ...(REVIEWER_COMPARISON_SUITES.includes(suite) ? ['maximumAdjudicatedFalseBlockingRate'] : []),
        ...(suite === WHOLE_LOOP_SUITE ? ['maximumSpendUsd', 'maximumWallTimeMs'] : [])
      ],
      path
    )
    if (floorShape !== null) return floorShape
    if (floor.layer !== 'G') return fail(`${path}.layer`, 'must equal G')
    if (!bounded(floor.value)) return fail(`${path}.value`, 'must be between 0 and 1')
    if (floor.basis !== 'principal-product-risk')
      return fail(`${path}.basis`, 'floors must come from Principal product risk, never a standalone score')
    if ('maximumAdjudicatedFalseBlockingRate' in floor && !bounded(floor.maximumAdjudicatedFalseBlockingRate))
      return fail(`${path}.maximumAdjudicatedFalseBlockingRate`, 'must be between 0 and 1')
    for (const key of ['maximumSpendUsd', 'maximumWallTimeMs'])
      if (key in floor && !nonNegative(floor[key])) return fail(`${path}.${key}`, 'non-negative number is required')
    if (floored.includes(suite)) return fail(`${path}.suite`, 'one floor per suite')
    floored.push(suite)
  }
  const unfloored = BACKEND_COMPARISON_SUITES.find((suite) => !floored.includes(suite))
  if (unfloored !== undefined) return fail('backendComparisonFloors', `layer-G suite ${unfloored} has no floor entry`)

  if (!Array.isArray(input.practiceRuns)) return fail('practiceRuns', 'array is required')
  for (const [index, result] of input.practiceRuns.entries()) {
    const path = `practiceRuns[${index}]`
    const invalid = measuredResult(result, path, {
      suites: Object.keys(LIVE_SUITE_LAYERS),
      split: 'development',
      backends: ['standalone', 'engine'],
      trials: 1,
      trialsDetail: 'a practice run carries exactly one trial per task',
      extraKeys: ['evidence']
    })
    if (invalid !== null) return invalid
    if ((result as Record<string, unknown>).evidence !== 'never')
      return fail(`${path}.evidence`, 'a practice run measures cost and is never evidence')
  }

  if (!Array.isArray(input.standaloneHeldOutBaseline)) return fail('standaloneHeldOutBaseline', 'array is required')
  const baselined: string[] = []
  for (const [index, result] of input.standaloneHeldOutBaseline.entries()) {
    const path = `standaloneHeldOutBaseline[${index}]`
    const invalid = measuredResult(result, path, {
      suites: BACKEND_COMPARISON_SUITES,
      split: 'held-out',
      backends: ['standalone'],
      trials,
      extraKeys: ['heldOutDigest']
    })
    if (invalid !== null) return invalid
    const value = result as StandaloneHeldOutResult
    const pinned = Object.hasOwn(heldOutDigests, value.suite) ? heldOutDigests[value.suite] : undefined
    if (pinned === undefined) return fail(`${path}.suite`, `no pinned held-out digest names suite ${value.suite}`)
    if (value.heldOutDigest !== pinned)
      return fail(`${path}.heldOutDigest`, `must equal the pinned held-out digest of ${value.suite}, ${pinned}`)
    const key = `${value.suite}:${value.adapter}`
    if (baselined.includes(key))
      return fail(path, 'at most one standalone held-out baseline per suite and adapter is permitted')
    baselined.push(key)
  }

  const parameters = input.comparisonParameters
  if (hasParameters && !object(parameters)) return fail('comparisonParameters', 'object is required')
  if (object(parameters)) {
    const parametersShape = exact(
      parameters,
      ['recordedAt', 'margin', 'trialsPerTask', 'minimumTaskCount'],
      'comparisonParameters'
    )
    if (parametersShape !== null) return parametersShape
    if (!timestamp(parameters.recordedAt))
      return fail('comparisonParameters.recordedAt', 'UTC ISO-8601 timestamp is required')
    if (!finite(parameters.margin) || !(parameters.margin > 0 && parameters.margin <= 1))
      return fail('comparisonParameters.margin', 'must lie in (0, 1]')
    if (!positiveInteger(parameters.trialsPerTask))
      return fail('comparisonParameters.trialsPerTask', 'positive integer is required')
    if (!positiveInteger(parameters.minimumTaskCount))
      return fail('comparisonParameters.minimumTaskCount', 'positive integer is required')
  }

  if (!Array.isArray(input.engineHeldOut)) return fail('engineHeldOut', 'array is required')
  for (const [index, result] of input.engineHeldOut.entries()) {
    const path = `engineHeldOut[${index}]`
    if (!object(parameters))
      return fail(path, 'an Engine held-out result needs comparison parameters recorded before it')
    const invalid = measuredResult(result, path, {
      suites: BACKEND_COMPARISON_SUITES,
      split: 'held-out',
      backends: ['engine'],
      trials: parameters.trialsPerTask as number,
      trialsDetail: 'does not match the comparison parameters',
      extraKeys: ['recordedAt']
    })
    if (invalid !== null) return invalid
    const recordedAt = (result as Record<string, unknown>).recordedAt
    if (!timestamp(recordedAt)) return fail(`${path}.recordedAt`, 'UTC ISO-8601 timestamp is required')
    if (Date.parse(parameters.recordedAt as string) > Date.parse(recordedAt))
      return fail(
        'comparisonParameters.recordedAt',
        `must not be dated after the Engine held-out result recorded at ${recordedAt}`
      )
  }

  if (!object(input.heldOut)) return fail('heldOut', 'object is required')
  const heldShape = exact(input.heldOut, ['toolSelection', 'sourceCitation'], 'heldOut')
  if (heldShape !== null) return heldShape
  for (const [key, suite] of [
    ['toolSelection', 'tool-catalog.l5'],
    ['sourceCitation', 'source-delivery.l5']
  ] as const) {
    const wrapper = input.heldOut[key]
    const path = `heldOut.${key}`
    if (!object(wrapper)) return fail(path, 'object is required')
    const wrapperShape = exact(wrapper, ['suite', 'floor', 'results'], path)
    if (wrapperShape !== null) return wrapperShape
    if (wrapper.suite !== suite || wrapper.floor !== 0.95 || !Array.isArray(wrapper.results))
      return fail(path, `must contain only ${suite} results against its fixed floor`)
    const adapters: string[] = []
    for (const [index, result] of wrapper.results.entries()) {
      const invalid = measuredResult(result, `${path}.results[${index}]`, {
        suites: [suite],
        split: 'held-out',
        backends: ['standalone'],
        trials
      })
      if (invalid !== null) return invalid
      const adapter = (result as MeasuredResult).adapter
      if (adapters.includes(adapter))
        return fail(`${path}.results[${index}]`, 'at most one held-out result per adapter is permitted')
      adapters.push(adapter)
    }
  }

  if (!object(input.owed)) return fail('owed', 'object is required')
  const owedShape = exact(input.owed, ['wholeLoopStepOne', 'operatorCapabilitySelectionStepOne'], 'owed')
  if (owedShape !== null) return owedShape
  const whole = input.owed.wholeLoopStepOne
  if (!object(whole)) return fail('owed.wholeLoopStepOne', 'object is required')
  const wholeShape = exact(whole, ['status', 'reason'], 'owed.wholeLoopStepOne')
  if (wholeShape !== null) return wholeShape
  if (whole.status !== 'owed' || whole.reason !== 'no disposable sandbox repository yet')
    return fail('owed.wholeLoopStepOne', 'must be owed because no disposable sandbox repository exists yet')
  const operator = input.owed.operatorCapabilitySelectionStepOne
  if (!object(operator)) return fail('owed.operatorCapabilitySelectionStepOne', 'object is required')
  const operatorShape = exact(operator, ['status', 'project', 'reason'], 'owed.operatorCapabilitySelectionStepOne')
  if (operatorShape !== null) return operatorShape
  if (
    operator.status !== 'owed' ||
    operator.project !== 'Operator on one host' ||
    typeof operator.reason !== 'string' ||
    operator.reason === ''
  )
    return fail(
      'owed.operatorCapabilitySelectionStepOne',
      'must be owed by the Operator on one host project with a reason'
    )
  return { ok: true, value: input as unknown as FreezeRecord }
}
