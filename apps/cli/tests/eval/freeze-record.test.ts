import { describe, expect, it } from 'bun:test'
import { validateFreezeRecord } from '../../src/lib/dev-review-eval/freeze-record'
import { STEP_ONE_ADAPTERS, STEP_ONE_SUITES } from '../../src/lib/dev-review-eval/step-one'

const measured = (suite: string, split: 'development' | 'held-out', adapter: 'claude-code' | 'codex') => ({
  suite,
  split,
  backend: 'standalone',
  adapter,
  taskCount: 1,
  trialsPerTask: 3,
  tasks: [{ taskId: `${suite}-${adapter}`, successes: 2, trials: 3 }],
  mean: 2 / 3,
  interval: { lower: 0.5, upper: 0.8 },
  usage: { wallTimeMs: 10, inputTokens: 4, outputTokens: 2, subscriptionQuota: null, estimatedCostUsd: 0 }
})

// Deliberately arbitrary test-only values prove shape and provenance; they are not proposed floors or budgets.
const complete = () => ({
  schemaVersion: 1,
  floors: {
    developerMinimumResolvedRate: { value: 0.41, basis: 'principal-product-risk' },
    codeReviewerMinimumRecall: { value: 0.42, basis: 'principal-product-risk' },
    codeReviewerMaximumAdjudicatedFalseBlockingRate: { value: 0.43, basis: 'principal-product-risk' },
    wholeLoopRemainingTasksPass3: {
      value: 0.44,
      basis: 'principal-product-risk',
      maximumSpendUsd: 123.45,
      maximumWallTimeMs: 12345
    }
  },
  bootstrap: { method: 'percentile', seed: 7, resamples: 100, confidence: 0.95 },
  trialsPerTask: 3,
  liveRunBudget: { subscriptionQuota: 5, estimatedCostUsd: 10, wallTimeMs: 1000 },
  cadence: { nightly: 'sampled role suites', weekly: 'whole loop', release: 'all live suites' },
  developmentRuns: STEP_ONE_SUITES.flatMap((suite) =>
    STEP_ONE_ADAPTERS.map((adapter) => measured(suite, 'development', adapter))
  ),
  heldOut: {
    toolSelection: {
      suite: 'tool-catalog.l5',
      floor: 0.95,
      results: STEP_ONE_ADAPTERS.map((adapter) => measured('tool-catalog.l5', 'held-out', adapter))
    },
    sourceCitation: {
      suite: 'source-delivery.l5',
      floor: 0.95,
      results: STEP_ONE_ADAPTERS.map((adapter) => measured('source-delivery.l5', 'held-out', adapter))
    }
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

  it('refuses incomplete or unexpected nested evidence', () => {
    const missing = complete()
    missing.developmentRuns[0] = {} as (typeof missing.developmentRuns)[number]
    expect(validateFreezeRecord(missing)).toMatchObject({
      ok: false,
      refusal: { path: expect.stringContaining('developmentRuns[0]') }
    })

    const extra = complete() as ReturnType<typeof complete> & {
      heldOut: ReturnType<typeof complete>['heldOut'] & { wholeLoop: unknown }
    }
    extra.heldOut.wholeLoop = { suite: 'whole-loop.l6', results: [] }
    expect(validateFreezeRecord(extra)).toMatchObject({ ok: false, refusal: { path: 'heldOut.wholeLoop' } })
  })

  it('refuses standalone-derived floors, backend-comparison held-out results and unmarked owed runs', () => {
    const derived = complete()
    derived.floors.developerMinimumResolvedRate.basis = 'standalone-score'
    expect(validateFreezeRecord(derived)).toMatchObject({
      ok: false,
      refusal: { path: expect.stringContaining('basis') }
    })

    const backend = complete()
    backend.heldOut.toolSelection.results[0]!.suite = 'developer-capability.l5'
    expect(validateFreezeRecord(backend)).toMatchObject({
      ok: false,
      refusal: { path: expect.stringContaining('suite') }
    })

    const whole = complete()
    whole.owed.wholeLoopStepOne.status = 'complete'
    expect(validateFreezeRecord(whole)).toMatchObject({ ok: false, refusal: { path: 'owed.wholeLoopStepOne' } })
  })

  it('requires whole-loop acceptance spend and wall-time budgets', () => {
    for (const key of ['maximumSpendUsd', 'maximumWallTimeMs'] as const) {
      const value = complete()
      delete value.floors.wholeLoopRemainingTasksPass3[key]
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: `floors.wholeLoopRemainingTasksPass3.${key}` }
      })
    }
  })
})
