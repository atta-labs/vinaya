import { describe, expect, it } from 'bun:test'
import {
  BACKEND_COMPARISON_SUITES,
  LIVE_SUITE_LAYERS,
  type LiveSuite,
  validateFreezeRecord
} from '../../src/lib/dev-review-eval/freeze-record'
import { STEP_ONE_ADAPTERS, STEP_ONE_SUITES } from '../../src/lib/dev-review-eval/step-one'

// Test-only renderer version; a real layer-G record carries the version its trial records were extracted under.
const RENDERER = '1:0000000000000000000000000000000000000000000000000000000000000000'

const measured = (
  suite: string,
  split: 'development' | 'held-out',
  adapter: 'claude-code' | 'codex',
  trials = 3,
  backend: 'standalone' | 'engine' = 'standalone'
) => ({
  suite,
  layer: LIVE_SUITE_LAYERS[suite as LiveSuite] as string,
  rendererVersion: LIVE_SUITE_LAYERS[suite as LiveSuite] === 'G' ? RENDERER : '',
  split,
  backend,
  adapter,
  taskCount: 1,
  trialsPerTask: trials,
  tasks: [{ taskId: `${suite}-${adapter}`, successes: Math.min(2, trials), trials }],
  mean: 2 / 3,
  interval: { lower: 0.5, upper: 0.8 },
  usage: {
    wallTimeMs: 10,
    inputTokens: 4,
    outputTokens: 2,
    subscriptionQuota: null,
    estimatedCostUsd: 0
  }
})

// Deliberately arbitrary test-only values prove shape and provenance; they are not proposed floors or budgets.
const complete = () => ({
  schemaVersion: 1,
  floors: {
    developerMinimumResolvedRate: {
      value: 0.41,
      basis: 'principal-product-risk'
    },
    codeReviewerMinimumRecall: { value: 0.42, basis: 'principal-product-risk' },
    codeReviewerMaximumAdjudicatedFalseBlockingRate: {
      value: 0.43,
      basis: 'principal-product-risk'
    },
    wholeLoopRemainingTasksPass3: {
      value: 0.44,
      basis: 'principal-product-risk',
      maximumSpendUsd: 123.45,
      maximumWallTimeMs: 12345
    }
  },
  bootstrap: {
    method: 'percentile',
    seed: 7,
    resamples: 100,
    confidence: 0.95
  },
  trialsPerTask: 3,
  liveRunBudget: {
    subscriptionQuota: 5,
    estimatedCostUsd: 10,
    wallTimeMs: 1000
  },
  cadence: {
    nightly: 'sampled role suites',
    weekly: 'whole loop',
    release: 'all live suites'
  },
  developmentRuns: STEP_ONE_SUITES.flatMap((suite) =>
    STEP_ONE_ADAPTERS.map((adapter) => measured(suite, 'development', adapter))
  ),
  backendComparisonFloors: BACKEND_COMPARISON_SUITES.map((suite) => ({ suite, layer: 'G' }) as Record<string, unknown>),
  practiceRuns: BACKEND_COMPARISON_SUITES.map(
    (suite) => ({ ...measured(suite, 'development', 'codex', 1), evidence: 'never' }) as Record<string, unknown>
  ),
  comparisonParameters: {
    recordedAt: '2026-10-20T09:00:00Z',
    margin: 0.1,
    trialsPerTask: 3,
    minimumTaskCount: 12
  },
  engineHeldOut: [
    {
      ...measured('developer-capability-neutral.l5', 'held-out', 'claude-code', 3, 'engine'),
      recordedAt: '2026-11-02T12:00:00Z'
    } as Record<string, unknown>
  ],
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
    wholeLoopStepOne: {
      status: 'owed',
      reason: 'no disposable sandbox repository yet'
    },
    operatorCapabilitySelectionStepOne: {
      status: 'owed',
      project: 'Operator on one host',
      reason: 'owned by that project'
    }
  }
})

describe('milestone-two freeze record', () => {
  it('accepts a complete Principal-authored record', () => expect(validateFreezeRecord(complete()).ok).toBe(true))

  it('enforces the seeded estimator ranges at every boundary', () => {
    for (const seed of [-1, 0x1_0000_0000, 1.5]) {
      const value = complete()
      value.bootstrap.seed = seed
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: 'bootstrap.seed' }
      })
    }
    for (const resamples of [0, -1, 1.5]) {
      const value = complete()
      value.bootstrap.resamples = resamples
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: 'bootstrap.resamples' }
      })
    }
    for (const confidence of [0, 1, -0.1, 1.1]) {
      const value = complete()
      value.bootstrap.confidence = confidence
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: 'bootstrap.confidence' }
      })
    }
  })

  it('refuses every missing top-level value', () => {
    for (const key of Object.keys(complete())) {
      const value = complete() as Record<string, unknown>
      delete value[key]
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: key }
      })
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
    expect(validateFreezeRecord(extra)).toMatchObject({
      ok: false,
      refusal: { path: 'heldOut.wholeLoop' }
    })
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
    expect(validateFreezeRecord(whole)).toMatchObject({
      ok: false,
      refusal: { path: 'owed.wholeLoopStepOne' }
    })
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

  it('names every L5 and L6 suite in the layer table, and compares backends on layer-G suites only', () => {
    expect(BACKEND_COMPARISON_SUITES).toEqual([
      'source-delivery-neutral.l5',
      'developer-capability-neutral.l5',
      'code-reviewer-quality-neutral.l5',
      'security-reviewer-quality-neutral.l5',
      'whole-loop.l6'
    ])
    for (const suite of [...STEP_ONE_SUITES, 'tool-catalog.l5', 'source-delivery.l5'] as const)
      expect(LIVE_SUITE_LAYERS[suite]).toBe('P')
  })
})

describe('every measured result names its layer and renderer version', () => {
  const sections = (value: ReturnType<typeof complete>) =>
    [
      ['developmentRuns[0]', value.developmentRuns[0]],
      ['heldOut.toolSelection.results[0]', value.heldOut.toolSelection.results[0]],
      ['practiceRuns[0]', value.practiceRuns[0]],
      ['engineHeldOut[0]', value.engineHeldOut[0]]
    ] as Array<[string, Record<string, unknown>]>

  it('refuses a result missing its layer or its renderer version, in every section', () => {
    for (const key of ['layer', 'rendererVersion']) {
      for (let index = 0; index < 4; index++) {
        const value = complete()
        const [path, result] = sections(value)[index]!
        delete result[key]
        expect(validateFreezeRecord(value)).toMatchObject({
          ok: false,
          refusal: { path: `${path}.${key}` }
        })
      }
    }
  })

  it('refuses a layer other than the one the registry declares for the suite', () => {
    const value = complete()
    value.developmentRuns[0]!.layer = 'G'
    expect(validateFreezeRecord(value)).toMatchObject({
      ok: false,
      refusal: { path: 'developmentRuns[0].layer' }
    })
    const unknown = complete()
    unknown.developmentRuns[0]!.layer = 'L5'
    expect(validateFreezeRecord(unknown)).toMatchObject({
      ok: false,
      refusal: { path: 'developmentRuns[0].layer' }
    })
  })

  it('refuses a layer-G result whose renderer version is empty, and accepts an empty one on layer P', () => {
    for (const empty of ['', '   ']) {
      const value = complete()
      value.practiceRuns[0]!.rendererVersion = empty
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: 'practiceRuns[0].rendererVersion' }
      })
    }
    const p = complete()
    expect(p.developmentRuns[0]!.rendererVersion).toBe('')
    expect(validateFreezeRecord(p).ok).toBe(true)
  })
})

describe('backend-comparison floors, practice runs and comparison parameters', () => {
  it('holds one unset floor per layer-G suite and refuses a floor on a layer-P suite', () => {
    const p = complete()
    p.backendComparisonFloors.push({ suite: 'developer-capability.l5', layer: 'G' })
    expect(validateFreezeRecord(p)).toMatchObject({
      ok: false,
      refusal: { path: `backendComparisonFloors[${BACKEND_COMPARISON_SUITES.length}].suite` }
    })

    const missing = complete()
    missing.backendComparisonFloors.pop()
    expect(validateFreezeRecord(missing)).toMatchObject({
      ok: false,
      refusal: { path: 'backendComparisonFloors' }
    })

    const valued = complete()
    valued.backendComparisonFloors[0]!.value = 0.5
    expect(validateFreezeRecord(valued)).toMatchObject({
      ok: false,
      refusal: { path: 'backendComparisonFloors[0].value' }
    })
  })

  it('refuses a practice run with more than one trial per task, or not marked as never evidence', () => {
    const many = complete()
    many.practiceRuns[0] = {
      ...measured('developer-capability-neutral.l5', 'development', 'codex', 2),
      evidence: 'never'
    }
    expect(validateFreezeRecord(many)).toMatchObject({
      ok: false,
      refusal: { path: 'practiceRuns[0].trialsPerTask' }
    })

    const tally = complete()
    ;(tally.practiceRuns[0]!.tasks as Array<{ trials: number }>)[0]!.trials = 2
    expect(validateFreezeRecord(tally)).toMatchObject({
      ok: false,
      refusal: { path: 'practiceRuns[0].tasks[0].trials' }
    })

    for (const evidence of [undefined, 'sometimes']) {
      const value = complete()
      if (evidence === undefined) delete value.practiceRuns[0]!.evidence
      else value.practiceRuns[0]!.evidence = evidence
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: 'practiceRuns[0].evidence' }
      })
    }

    const cost = complete()
    delete (cost.practiceRuns[0]!.usage as Record<string, unknown>).estimatedCostUsd
    expect(validateFreezeRecord(cost)).toMatchObject({
      ok: false,
      refusal: { path: 'practiceRuns[0].usage.estimatedCostUsd' }
    })
  })

  it('requires dated comparison parameters', () => {
    for (const key of ['recordedAt', 'margin', 'trialsPerTask', 'minimumTaskCount'] as const) {
      const value = complete()
      delete (value.comparisonParameters as Record<string, unknown>)[key]
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: `comparisonParameters.${key}` }
      })
    }
    for (const recordedAt of ['2026-10-20', '2026-02-30T00:00:00Z', 'yesterday']) {
      const value = complete()
      value.comparisonParameters.recordedAt = recordedAt
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: 'comparisonParameters.recordedAt' }
      })
    }
  })

  it('refuses comparison parameters dated after any recorded Engine held-out result', () => {
    const late = complete()
    late.comparisonParameters.recordedAt = '2026-11-02T12:00:01Z'
    expect(validateFreezeRecord(late)).toMatchObject({
      ok: false,
      refusal: { path: 'comparisonParameters.recordedAt' }
    })

    const second = complete()
    second.engineHeldOut.push({
      ...measured('code-reviewer-quality-neutral.l5', 'held-out', 'codex', 3, 'engine'),
      recordedAt: '2026-10-19T00:00:00Z'
    })
    expect(validateFreezeRecord(second)).toMatchObject({
      ok: false,
      refusal: { path: 'comparisonParameters.recordedAt' }
    })

    const same = complete()
    same.comparisonParameters.recordedAt = '2026-11-02T12:00:00Z'
    expect(validateFreezeRecord(same).ok).toBe(true)

    const none = complete()
    none.engineHeldOut = []
    none.comparisonParameters.recordedAt = '2027-01-01T00:00:00Z'
    expect(validateFreezeRecord(none).ok).toBe(true)
  })

  it('accepts Engine held-out results only for layer-G suites', () => {
    const value = complete()
    value.engineHeldOut[0] = {
      ...measured('developer-capability.l5', 'held-out', 'claude-code', 3, 'engine'),
      recordedAt: '2026-11-02T12:00:00Z'
    }
    expect(validateFreezeRecord(value)).toMatchObject({
      ok: false,
      refusal: { path: 'engineHeldOut[0].suite' }
    })
  })
})
