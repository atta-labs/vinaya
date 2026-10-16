import { describe, expect, it } from 'bun:test'
import { validateFreezeRecord } from '../../src/lib/dev-review-eval/freeze-record'

const complete = () => ({
  schemaVersion: 1,
  floors: {
    developerMinimumResolvedRate: { value: 0.8, basis: 'principal-product-risk' },
    codeReviewerMinimumRecall: { value: 0.9, basis: 'principal-product-risk' },
    codeReviewerMaximumAdjudicatedFalseBlockingRate: { value: 0.1, basis: 'principal-product-risk' },
    wholeLoopRemainingTasksPass3: { value: 0.8, basis: 'principal-product-risk' }
  },
  bootstrap: { method: 'percentile', seed: 7, resamples: 100, confidence: 0.95 },
  trialsPerTask: 3,
  liveRunBudget: { subscriptionQuota: 5, estimatedCostUsd: 10, wallTimeMs: 1000 },
  cadence: { nightly: 'sampled role suites', weekly: 'whole loop', release: 'all live suites' },
  developmentRuns: [],
  heldOut: {
    toolSelection: { suite: 'tool-catalog.l5', floor: 0.95, results: [] },
    sourceCitation: { suite: 'source-delivery.l5', floor: 0.95, results: [] }
  },
  owed: {
    wholeLoopStepOne: { status: 'owed', reason: 'no disposable sandbox repository yet' },
    operatorCapabilitySelectionStepOne: {
      status: 'owed',
      project: 'Operator on one host',
      reason: 'owned by that project'
    }
  }
})

describe('milestone-two freeze record', () => {
  it('accepts a complete Principal-authored record', () => expect(validateFreezeRecord(complete()).ok).toBe(true))

  it('refuses every missing top-level value', () => {
    for (const key of Object.keys(complete())) {
      const value = complete() as Record<string, unknown>
      delete value[key]
      expect(validateFreezeRecord(value)).toMatchObject({ ok: false, refusal: { path: key } })
    }
  })

  it('refuses standalone-derived floors, backend-comparison held-out results and unmarked owed runs', () => {
    const derived = complete()
    derived.floors.developerMinimumResolvedRate.basis = 'standalone-score'
    expect(validateFreezeRecord(derived)).toMatchObject({
      ok: false,
      refusal: { path: expect.stringContaining('basis') }
    })
    const backend = complete()
    backend.heldOut.toolSelection.suite = 'developer-capability.l5'
    expect(validateFreezeRecord(backend)).toMatchObject({ ok: false, refusal: { path: 'heldOut.toolSelection' } })
    const whole = complete()
    whole.owed.wholeLoopStepOne.status = 'complete'
    expect(validateFreezeRecord(whole)).toMatchObject({ ok: false, refusal: { path: 'owed.wholeLoopStepOne' } })
  })
})
