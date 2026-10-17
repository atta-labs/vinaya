import { BOOTSTRAP_METHODS } from './estimators'
import { STEP_ONE_ADAPTERS, STEP_ONE_SUITES, type StepOneAdapter } from './step-one'

export interface MeasuredResult {
  suite: string
  split: 'development' | 'held-out'
  backend: 'standalone'
  adapter: StepOneAdapter
  taskCount: number
  trialsPerTask: number
  tasks: Array<{ taskId: string; successes: number; trials: number }>
  mean: number
  interval: { lower: number; upper: number }
  usage: {
    wallTimeMs: number
    inputTokens: number
    outputTokens: number
    subscriptionQuota: number | null
    estimatedCostUsd: number
  }
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

function measuredResult(
  input: unknown,
  path: string,
  expected: {
    suites: readonly string[]
    split: 'development' | 'held-out'
    trials: number
  }
): FreezeRecordValidation | null {
  if (!object(input)) return fail(path, 'measured result object is required')
  const shape = exact(
    input,
    ['suite', 'split', 'backend', 'adapter', 'taskCount', 'trialsPerTask', 'tasks', 'mean', 'interval', 'usage'],
    path
  )
  if (shape !== null) return shape
  if (!expected.suites.includes(String(input.suite))) return fail(`${path}.suite`, 'suite is not permitted here')
  if (input.split !== expected.split) return fail(`${path}.split`, `must equal ${expected.split}`)
  if (input.backend !== 'standalone') return fail(`${path}.backend`, 'must equal standalone')
  if (!(STEP_ONE_ADAPTERS as readonly unknown[]).includes(input.adapter))
    return fail(`${path}.adapter`, 'unknown adapter')
  if (!Number.isInteger(input.taskCount) || (input.taskCount as number) < 1)
    return fail(`${path}.taskCount`, 'positive integer is required')
  if (input.trialsPerTask !== expected.trials) return fail(`${path}.trialsPerTask`, 'does not match the freeze')
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
    if (
      raw.trials !== expected.trials ||
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
    ['wallTimeMs', 'inputTokens', 'outputTokens', 'subscriptionQuota', 'estimatedCostUsd'],
    `${path}.usage`
  )
  if (usageShape !== null) return usageShape
  for (const key of ['wallTimeMs', 'inputTokens', 'outputTokens', 'estimatedCostUsd'])
    if (!nonNegative(input.usage[key])) return fail(`${path}.usage.${key}`, 'non-negative number is required')
  if (input.usage.subscriptionQuota !== null && !nonNegative(input.usage.subscriptionQuota))
    return fail(`${path}.usage.subscriptionQuota`, 'must be null or a non-negative number')
  return null
}

/** Validates the complete record before any authoritative held-out run. */
export function validateFreezeRecord(input: unknown): FreezeRecordValidation {
  if (!object(input)) return fail('', 'record is required')
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

  if (!Array.isArray(input.developmentRuns)) return fail('developmentRuns', 'array is required')
  const expectedDevelopment = STEP_ONE_SUITES.flatMap((suite) =>
    STEP_ONE_ADAPTERS.map((adapter) => `${suite}:${adapter}`)
  )
  const seenDevelopment: string[] = []
  for (const [index, result] of input.developmentRuns.entries()) {
    const invalid = measuredResult(result, `developmentRuns[${index}]`, {
      suites: STEP_ONE_SUITES,
      split: 'development',
      trials
    })
    if (invalid !== null) return invalid
    const value = result as MeasuredResult
    seenDevelopment.push(`${value.suite}:${value.adapter}`)
  }
  if (
    new Set(seenDevelopment).size !== expectedDevelopment.length ||
    expectedDevelopment.some((key) => !seenDevelopment.includes(key))
  )
    return fail('developmentRuns', 'exactly one result per suite and adapter is required')

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
        trials
      })
      if (invalid !== null) return invalid
      adapters.push((result as MeasuredResult).adapter)
    }
    if (
      new Set(adapters).size !== STEP_ONE_ADAPTERS.length ||
      STEP_ONE_ADAPTERS.some((adapter) => !adapters.includes(adapter))
    )
      return fail(`${path}.results`, 'exactly one held-out result per adapter is required')
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
