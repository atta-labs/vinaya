import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
    cacheReadTokens: 5,
    cacheCreationTokens: 1,
    subscriptionQuota: null,
    estimatedCostUsd: 0
  }
})

const REVIEWERS: readonly string[] = ['code-reviewer-quality-neutral.l5', 'security-reviewer-quality-neutral.l5']

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
  backendComparisonFloors: BACKEND_COMPARISON_SUITES.map(
    (suite) =>
      ({
        suite,
        layer: 'G',
        value: 0.45,
        basis: 'principal-product-risk',
        ...(REVIEWERS.includes(suite) ? { maximumAdjudicatedFalseBlockingRate: 0.46 } : {}),
        ...(suite === 'whole-loop.l6' ? { maximumSpendUsd: 12.5, maximumWallTimeMs: 4567 } : {})
      }) as Record<string, unknown>
  ),
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

  it('refuses every missing top-level value but the comparison parameters', () => {
    for (const key of Object.keys(complete()).filter((key) => key !== 'comparisonParameters')) {
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
  it('holds one valued floor per layer-G suite and refuses a floor on a layer-P suite', () => {
    const p = complete()
    p.backendComparisonFloors.push({
      suite: 'developer-capability.l5',
      layer: 'G',
      value: 0.5,
      basis: 'principal-product-risk'
    })
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

    const duplicate = complete()
    duplicate.backendComparisonFloors.push({ ...duplicate.backendComparisonFloors[0]! })
    expect(validateFreezeRecord(duplicate)).toMatchObject({
      ok: false,
      refusal: { path: `backendComparisonFloors[${BACKEND_COMPARISON_SUITES.length}].suite` }
    })
  })

  const floorOf = (value: ReturnType<typeof complete>, suite: string) => {
    const index = value.backendComparisonFloors.findIndex((floor) => floor.suite === suite)
    return [index, value.backendComparisonFloors[index]!] as const
  }

  it('requires every backend-comparison floor to carry a value between 0 and 1 from product risk', () => {
    for (const suite of BACKEND_COMPARISON_SUITES) {
      for (const bad of [undefined, -0.01, 1.01, '0.5']) {
        const value = complete()
        const [index, floor] = floorOf(value, suite)
        if (bad === undefined) delete floor.value
        else floor.value = bad
        expect(validateFreezeRecord(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].value` }
        })
      }
      for (const bad of [undefined, 'standalone-score']) {
        const value = complete()
        const [index, floor] = floorOf(value, suite)
        if (bad === undefined) delete floor.basis
        else floor.basis = bad
        expect(validateFreezeRecord(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].basis` }
        })
      }
    }
    for (const bound of [0, 1]) {
      const value = complete()
      for (const floor of value.backendComparisonFloors) floor.value = bound
      expect(validateFreezeRecord(value).ok).toBe(true)
    }
  })

  it('requires a maximum adjudicated false-blocking rate on the code and security reviewer floors only', () => {
    for (const suite of REVIEWERS) {
      for (const bad of [undefined, -0.1, 1.5]) {
        const value = complete()
        const [index, floor] = floorOf(value, suite)
        if (bad === undefined) delete floor.maximumAdjudicatedFalseBlockingRate
        else floor.maximumAdjudicatedFalseBlockingRate = bad
        expect(validateFreezeRecord(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].maximumAdjudicatedFalseBlockingRate` }
        })
      }
    }
    const other = complete()
    const [index, floor] = floorOf(other, 'developer-capability-neutral.l5')
    floor.maximumAdjudicatedFalseBlockingRate = 0.1
    expect(validateFreezeRecord(other)).toMatchObject({
      ok: false,
      refusal: { path: `backendComparisonFloors[${index}].maximumAdjudicatedFalseBlockingRate` }
    })
  })

  it('requires a maximum spend and wall time on the whole-loop floor only', () => {
    for (const key of ['maximumSpendUsd', 'maximumWallTimeMs']) {
      for (const bad of [undefined, -1, '10']) {
        const value = complete()
        const [index, floor] = floorOf(value, 'whole-loop.l6')
        if (bad === undefined) delete floor[key]
        else floor[key] = bad
        expect(validateFreezeRecord(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].${key}` }
        })
      }
      const other = complete()
      const [index, floor] = floorOf(other, 'source-delivery-neutral.l5')
      floor[key] = 0
      expect(validateFreezeRecord(other)).toMatchObject({
        ok: false,
        refusal: { path: `backendComparisonFloors[${index}].${key}` }
      })
    }
    const zero = complete()
    const [, floor] = floorOf(zero, 'whole-loop.l6')
    floor.maximumSpendUsd = 0
    expect(validateFreezeRecord(zero).ok).toBe(true)
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

  it('accepts a record without comparison parameters while no Engine held-out result exists', () => {
    const value = complete() as Partial<ReturnType<typeof complete>>
    delete value.comparisonParameters
    value.engineHeldOut = []
    expect(validateFreezeRecord(value).ok).toBe(true)
  })

  it('refuses any Engine held-out result in a record without comparison parameters', () => {
    const value = complete() as Partial<ReturnType<typeof complete>>
    delete value.comparisonParameters
    expect(validateFreezeRecord(value)).toMatchObject({
      ok: false,
      refusal: { path: 'engineHeldOut[0]' }
    })
  })

  it('refuses comparison parameters present but not an object', () => {
    for (const bad of [null, [], 'later']) {
      const value = complete() as Record<string, unknown>
      value.comparisonParameters = bad
      expect(validateFreezeRecord(value)).toMatchObject({
        ok: false,
        refusal: { path: 'comparisonParameters' }
      })
    }
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

describe('measured-only results', () => {
  it('accepts empty or partial development runs and fixed-floor held-out results', () => {
    const empty = complete()
    empty.developmentRuns = []
    empty.heldOut.toolSelection.results = []
    empty.heldOut.sourceCitation.results = []
    expect(validateFreezeRecord(empty).ok).toBe(true)

    const partial = complete()
    partial.developmentRuns = partial.developmentRuns.slice(0, 1)
    partial.heldOut.toolSelection.results = partial.heldOut.toolSelection.results.slice(0, 1)
    partial.heldOut.sourceCitation.results = partial.heldOut.sourceCitation.results.slice(1)
    expect(validateFreezeRecord(partial).ok).toBe(true)
  })

  it('refuses a second result for one suite and adapter', () => {
    const development = complete()
    development.developmentRuns.push(measured(STEP_ONE_SUITES[0]!, 'development', STEP_ONE_ADAPTERS[0]!))
    const last = development.developmentRuns.length - 1
    expect(validateFreezeRecord(development)).toMatchObject({
      ok: false,
      refusal: { path: `developmentRuns[${last}]` }
    })

    const held = complete()
    held.heldOut.sourceCitation.results = [
      measured('source-delivery.l5', 'held-out', 'codex'),
      measured('source-delivery.l5', 'held-out', 'codex')
    ]
    expect(validateFreezeRecord(held)).toMatchObject({
      ok: false,
      refusal: { path: 'heldOut.sourceCitation.results[1]' }
    })
  })

  it('still fully validates each partial result', () => {
    const development = complete()
    development.developmentRuns = [{ ...measured(STEP_ONE_SUITES[0]!, 'development', 'codex'), trialsPerTask: 1 }]
    expect(validateFreezeRecord(development)).toMatchObject({
      ok: false,
      refusal: { path: 'developmentRuns[0].trialsPerTask' }
    })

    const held = complete()
    held.heldOut.toolSelection.results = [{ ...measured('tool-catalog.l5', 'held-out', 'codex'), split: 'development' }]
    expect(validateFreezeRecord(held)).toMatchObject({
      ok: false,
      refusal: { path: 'heldOut.toolSelection.results[0].split' }
    })
  })

  it('requires non-negative cache read and cache creation tokens on every usage', () => {
    for (const key of ['cacheReadTokens', 'cacheCreationTokens']) {
      for (const bad of [undefined, -1, '3']) {
        const value = complete()
        const usage = value.practiceRuns[0]!.usage as Record<string, unknown>
        if (bad === undefined) delete usage[key]
        else usage[key] = bad
        expect(validateFreezeRecord(value)).toMatchObject({
          ok: false,
          refusal: { path: `practiceRuns[0].usage.${key}` }
        })
      }
    }
  })
})

describe('the committed freeze record', () => {
  const record = JSON.parse(readFileSync(join(import.meta.dir, 'freeze-record.json'), 'utf8')) as Record<
    string,
    unknown
  > & {
    practiceRuns: Array<Record<string, unknown>>
    heldOut: Record<string, { results: unknown[] }>
  }

  it('is accepted by the validator', () => expect(validateFreezeRecord(record).ok).toBe(true))

  it('holds practice runs only, and no comparison parameters or scored result', () => {
    expect('comparisonParameters' in record).toBe(false)
    expect(record.developmentRuns).toEqual([])
    expect(record.engineHeldOut).toEqual([])
    expect(record.heldOut.toolSelection!.results).toEqual([])
    expect(record.heldOut.sourceCitation!.results).toEqual([])
    expect(record.practiceRuns.map((run) => [run.suite, run.layer, run.adapter, run.evidence])).toEqual([
      ['developer-capability-neutral.l5', 'G', 'claude-code', 'never'],
      ['code-reviewer-quality-neutral.l5', 'G', 'claude-code', 'never'],
      ['security-reviewer-quality-neutral.l5', 'G', 'claude-code', 'never'],
      ['source-delivery-neutral.l5', 'G', 'claude-code', 'never']
    ])
  })
})
