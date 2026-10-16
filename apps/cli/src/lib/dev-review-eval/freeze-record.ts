import { BOOTSTRAP_METHODS } from './estimators'

export interface FreezeRecord {
  schemaVersion: 1
  floors: {
    developerMinimumResolvedRate: { value: number; basis: 'principal-product-risk' }
    codeReviewerMinimumRecall: { value: number; basis: 'principal-product-risk' }
    codeReviewerMaximumAdjudicatedFalseBlockingRate: { value: number; basis: 'principal-product-risk' }
    wholeLoopRemainingTasksPass3: { value: number; basis: 'principal-product-risk' }
  }
  bootstrap: { method: 'percentile' | 'basic'; seed: number; resamples: number; confidence: number }
  trialsPerTask: number
  liveRunBudget: { subscriptionQuota: number; estimatedCostUsd: number; wallTimeMs: number }
  cadence: { nightly: string; weekly: string; release: string }
  developmentRuns: unknown[]
  heldOut: {
    toolSelection: { suite: 'tool-catalog.l5'; floor: 0.95; results: unknown[] }
    sourceCitation: { suite: 'source-delivery.l5'; floor: 0.95; results: unknown[] }
  }
  owed: {
    wholeLoopStepOne: { status: 'owed'; reason: 'no disposable sandbox repository yet' }
    operatorCapabilitySelectionStepOne: { status: 'owed'; project: 'Operator on one host'; reason: string }
  }
}

export type FreezeRecordValidation =
  | { ok: true; value: FreezeRecord }
  | { ok: false; refusal: { code: 'invalid_freeze_record'; path: string; detail: string } }

const fail = (path: string, detail: string): FreezeRecordValidation => ({
  ok: false,
  refusal: { code: 'invalid_freeze_record', path, detail }
})
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** Validates the complete record before any authoritative held-out run. */
export function validateFreezeRecord(input: unknown): FreezeRecordValidation {
  if (!object(input)) return fail('', 'record is required')
  const required = [
    'schemaVersion',
    'floors',
    'bootstrap',
    'trialsPerTask',
    'liveRunBudget',
    'cadence',
    'developmentRuns',
    'heldOut',
    'owed'
  ]
  for (const key of required) if (!(key in input)) return fail(key, 'value is required')
  if (input.schemaVersion !== 1) return fail('schemaVersion', 'must equal 1')
  if (!object(input.floors)) return fail('floors', 'object is required')
  for (const key of [
    'developerMinimumResolvedRate',
    'codeReviewerMinimumRecall',
    'codeReviewerMaximumAdjudicatedFalseBlockingRate',
    'wholeLoopRemainingTasksPass3'
  ]) {
    const floor = input.floors[key]
    if (!object(floor) || !finite(floor.value)) return fail(`floors.${key}.value`, 'numeric value is required')
    if (floor.value < 0 || floor.value > 1) return fail(`floors.${key}.value`, 'must be between 0 and 1')
    if (floor.basis !== 'principal-product-risk')
      return fail(`floors.${key}.basis`, 'floors must come from Principal product risk, never a standalone score')
  }
  if (!object(input.bootstrap)) return fail('bootstrap', 'object is required')
  if (!(BOOTSTRAP_METHODS as readonly unknown[]).includes(input.bootstrap.method))
    return fail('bootstrap.method', 'unsupported bootstrap method')
  if (
    !Number.isInteger(input.bootstrap.seed) ||
    !Number.isInteger(input.bootstrap.resamples) ||
    !finite(input.bootstrap.confidence)
  )
    return fail('bootstrap', 'seed, resamples and confidence are required')
  if (!Number.isInteger(input.trialsPerTask) || (input.trialsPerTask as number) < 1)
    return fail('trialsPerTask', 'positive integer is required')
  if (!object(input.liveRunBudget)) return fail('liveRunBudget', 'object is required')
  for (const key of ['subscriptionQuota', 'estimatedCostUsd', 'wallTimeMs'])
    if (!finite(input.liveRunBudget[key])) return fail(`liveRunBudget.${key}`, 'numeric value is required')
  if (!object(input.cadence)) return fail('cadence', 'object is required')
  for (const key of ['nightly', 'weekly', 'release'])
    if (typeof input.cadence[key] !== 'string' || input.cadence[key] === '')
      return fail(`cadence.${key}`, 'value is required')
  if (!Array.isArray(input.developmentRuns)) return fail('developmentRuns', 'array is required')
  if (!object(input.heldOut)) return fail('heldOut', 'object is required')
  for (const [key, suite] of [
    ['toolSelection', 'tool-catalog.l5'],
    ['sourceCitation', 'source-delivery.l5']
  ] as const) {
    const result = input.heldOut[key]
    if (!object(result) || result.suite !== suite || result.floor !== 0.95 || !Array.isArray(result.results))
      return fail(`heldOut.${key}`, `must contain only ${suite} results against its fixed floor`)
  }
  if (!object(input.owed)) return fail('owed', 'object is required')
  const whole = input.owed.wholeLoopStepOne
  if (!object(whole) || whole.status !== 'owed' || whole.reason !== 'no disposable sandbox repository yet')
    return fail('owed.wholeLoopStepOne', 'must be owed because no disposable sandbox repository exists yet')
  const operator = input.owed.operatorCapabilitySelectionStepOne
  if (
    !object(operator) ||
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
