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
import { DERIVED_FILE_DIGESTS, heldOutCases, heldOutDigestsBySuite } from './generic-suites'
import { GENERIC_SUITE_IDS } from './recut-generic-cases'

// Test-only renderer version; a real layer-G record carries the version its trial records were extracted under.
const RENDERER = '1:0000000000000000000000000000000000000000000000000000000000000000'

// A fake held-out digest per backend-comparison suite: the validator takes the map as an input.
const DIGESTS: Record<string, string> = Object.fromEntries(
  BACKEND_COMPARISON_SUITES.map((suite, index) => [suite, String(index + 1).repeat(64)])
)
const validate = (value: unknown, digests: Record<string, string> = DIGESTS) => validateFreezeRecord(value, digests)

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
  standaloneHeldOutBaseline: BACKEND_COMPARISON_SUITES.map(
    (suite) =>
      ({ ...measured(suite, 'held-out', 'claude-code'), heldOutDigest: DIGESTS[suite] }) as Record<string, unknown>
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
  it('accepts a complete Principal-authored record', () => expect(validate(complete()).ok).toBe(true))

  it('enforces the seeded estimator ranges at every boundary', () => {
    for (const seed of [-1, 0x1_0000_0000, 1.5]) {
      const value = complete()
      value.bootstrap.seed = seed
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: 'bootstrap.seed' }
      })
    }
    for (const resamples of [0, -1, 1.5]) {
      const value = complete()
      value.bootstrap.resamples = resamples
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: 'bootstrap.resamples' }
      })
    }
    for (const confidence of [0, 1, -0.1, 1.1]) {
      const value = complete()
      value.bootstrap.confidence = confidence
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: 'bootstrap.confidence' }
      })
    }
  })

  it('refuses every missing top-level value but the comparison parameters', () => {
    for (const key of Object.keys(complete()).filter((key) => key !== 'comparisonParameters')) {
      const value = complete() as Record<string, unknown>
      delete value[key]
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: key }
      })
    }
  })

  it('refuses incomplete or unexpected nested evidence', () => {
    const missing = complete()
    missing.developmentRuns[0] = {} as (typeof missing.developmentRuns)[number]
    expect(validate(missing)).toMatchObject({
      ok: false,
      refusal: { path: expect.stringContaining('developmentRuns[0]') }
    })

    const extra = complete() as ReturnType<typeof complete> & {
      heldOut: ReturnType<typeof complete>['heldOut'] & { wholeLoop: unknown }
    }
    extra.heldOut.wholeLoop = { suite: 'whole-loop.l6', results: [] }
    expect(validate(extra)).toMatchObject({
      ok: false,
      refusal: { path: 'heldOut.wholeLoop' }
    })
  })

  it('refuses standalone-derived floors, backend-comparison held-out results and unmarked owed runs', () => {
    const derived = complete()
    derived.floors.developerMinimumResolvedRate.basis = 'standalone-score'
    expect(validate(derived)).toMatchObject({
      ok: false,
      refusal: { path: expect.stringContaining('basis') }
    })

    const backend = complete()
    backend.heldOut.toolSelection.results[0]!.suite = 'developer-capability.l5'
    expect(validate(backend)).toMatchObject({
      ok: false,
      refusal: { path: expect.stringContaining('suite') }
    })

    const whole = complete()
    whole.owed.wholeLoopStepOne.status = 'complete'
    expect(validate(whole)).toMatchObject({
      ok: false,
      refusal: { path: 'owed.wholeLoopStepOne' }
    })
  })

  it('requires whole-loop acceptance spend and wall-time budgets', () => {
    for (const key of ['maximumSpendUsd', 'maximumWallTimeMs'] as const) {
      const value = complete()
      delete value.floors.wholeLoopRemainingTasksPass3[key]
      expect(validate(value)).toMatchObject({
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
        expect(validate(value)).toMatchObject({
          ok: false,
          refusal: { path: `${path}.${key}` }
        })
      }
    }
  })

  it('refuses a layer other than the one the registry declares for the suite', () => {
    const value = complete()
    value.developmentRuns[0]!.layer = 'G'
    expect(validate(value)).toMatchObject({
      ok: false,
      refusal: { path: 'developmentRuns[0].layer' }
    })
    const unknown = complete()
    unknown.developmentRuns[0]!.layer = 'L5'
    expect(validate(unknown)).toMatchObject({
      ok: false,
      refusal: { path: 'developmentRuns[0].layer' }
    })
  })

  it('refuses a layer-G result whose renderer version is empty, and accepts an empty one on layer P', () => {
    for (const empty of ['', '   ']) {
      const value = complete()
      value.practiceRuns[0]!.rendererVersion = empty
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: 'practiceRuns[0].rendererVersion' }
      })
    }
    const p = complete()
    expect(p.developmentRuns[0]!.rendererVersion).toBe('')
    expect(validate(p).ok).toBe(true)
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
    expect(validate(p)).toMatchObject({
      ok: false,
      refusal: { path: `backendComparisonFloors[${BACKEND_COMPARISON_SUITES.length}].suite` }
    })

    const missing = complete()
    missing.backendComparisonFloors.pop()
    expect(validate(missing)).toMatchObject({
      ok: false,
      refusal: { path: 'backendComparisonFloors' }
    })

    const duplicate = complete()
    duplicate.backendComparisonFloors.push({ ...duplicate.backendComparisonFloors[0]! })
    expect(validate(duplicate)).toMatchObject({
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
        expect(validate(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].value` }
        })
      }
      for (const bad of [undefined, 'standalone-score']) {
        const value = complete()
        const [index, floor] = floorOf(value, suite)
        if (bad === undefined) delete floor.basis
        else floor.basis = bad
        expect(validate(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].basis` }
        })
      }
    }
    for (const bound of [0, 1]) {
      const value = complete()
      for (const floor of value.backendComparisonFloors) floor.value = bound
      expect(validate(value).ok).toBe(true)
    }
  })

  it('requires a maximum adjudicated false-blocking rate on the code and security reviewer floors only', () => {
    for (const suite of REVIEWERS) {
      for (const bad of [undefined, -0.1, 1.5]) {
        const value = complete()
        const [index, floor] = floorOf(value, suite)
        if (bad === undefined) delete floor.maximumAdjudicatedFalseBlockingRate
        else floor.maximumAdjudicatedFalseBlockingRate = bad
        expect(validate(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].maximumAdjudicatedFalseBlockingRate` }
        })
      }
    }
    const other = complete()
    const [index, floor] = floorOf(other, 'developer-capability-neutral.l5')
    floor.maximumAdjudicatedFalseBlockingRate = 0.1
    expect(validate(other)).toMatchObject({
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
        expect(validate(value)).toMatchObject({
          ok: false,
          refusal: { path: `backendComparisonFloors[${index}].${key}` }
        })
      }
      const other = complete()
      const [index, floor] = floorOf(other, 'source-delivery-neutral.l5')
      floor[key] = 0
      expect(validate(other)).toMatchObject({
        ok: false,
        refusal: { path: `backendComparisonFloors[${index}].${key}` }
      })
    }
    const zero = complete()
    const [, floor] = floorOf(zero, 'whole-loop.l6')
    floor.maximumSpendUsd = 0
    expect(validate(zero).ok).toBe(true)
  })

  it('refuses a practice run with more than one trial per task, or not marked as never evidence', () => {
    const many = complete()
    many.practiceRuns[0] = {
      ...measured('developer-capability-neutral.l5', 'development', 'codex', 2),
      evidence: 'never'
    }
    expect(validate(many)).toMatchObject({
      ok: false,
      refusal: { path: 'practiceRuns[0].trialsPerTask' }
    })

    const tally = complete()
    ;(tally.practiceRuns[0]!.tasks as Array<{ trials: number }>)[0]!.trials = 2
    expect(validate(tally)).toMatchObject({
      ok: false,
      refusal: { path: 'practiceRuns[0].tasks[0].trials' }
    })

    for (const evidence of [undefined, 'sometimes']) {
      const value = complete()
      if (evidence === undefined) delete value.practiceRuns[0]!.evidence
      else value.practiceRuns[0]!.evidence = evidence
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: 'practiceRuns[0].evidence' }
      })
    }

    const cost = complete()
    delete (cost.practiceRuns[0]!.usage as Record<string, unknown>).estimatedCostUsd
    expect(validate(cost)).toMatchObject({
      ok: false,
      refusal: { path: 'practiceRuns[0].usage.estimatedCostUsd' }
    })
  })

  it('accepts a record without comparison parameters while no Engine held-out result exists', () => {
    const value = complete() as Partial<ReturnType<typeof complete>>
    delete value.comparisonParameters
    value.engineHeldOut = []
    expect(validate(value).ok).toBe(true)
  })

  it('refuses any Engine held-out result in a record without comparison parameters', () => {
    const value = complete() as Partial<ReturnType<typeof complete>>
    delete value.comparisonParameters
    expect(validate(value)).toMatchObject({
      ok: false,
      refusal: { path: 'engineHeldOut[0]' }
    })
  })

  it('refuses comparison parameters present but not an object', () => {
    for (const bad of [null, [], 'later']) {
      const value = complete() as Record<string, unknown>
      value.comparisonParameters = bad
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: 'comparisonParameters' }
      })
    }
  })

  it('requires dated comparison parameters', () => {
    for (const key of ['recordedAt', 'margin', 'trialsPerTask', 'minimumTaskCount'] as const) {
      const value = complete()
      delete (value.comparisonParameters as Record<string, unknown>)[key]
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: `comparisonParameters.${key}` }
      })
    }
    for (const recordedAt of ['2026-10-20', '2026-02-30T00:00:00Z', 'yesterday']) {
      const value = complete()
      value.comparisonParameters.recordedAt = recordedAt
      expect(validate(value)).toMatchObject({
        ok: false,
        refusal: { path: 'comparisonParameters.recordedAt' }
      })
    }
  })

  it('refuses comparison parameters dated after any recorded Engine held-out result', () => {
    const late = complete()
    late.comparisonParameters.recordedAt = '2026-11-02T12:00:01Z'
    expect(validate(late)).toMatchObject({
      ok: false,
      refusal: { path: 'comparisonParameters.recordedAt' }
    })

    const second = complete()
    second.engineHeldOut.push({
      ...measured('code-reviewer-quality-neutral.l5', 'held-out', 'codex', 3, 'engine'),
      recordedAt: '2026-10-19T00:00:00Z'
    })
    expect(validate(second)).toMatchObject({
      ok: false,
      refusal: { path: 'comparisonParameters.recordedAt' }
    })

    const same = complete()
    same.comparisonParameters.recordedAt = '2026-11-02T12:00:00Z'
    expect(validate(same).ok).toBe(true)

    const none = complete()
    none.engineHeldOut = []
    none.comparisonParameters.recordedAt = '2027-01-01T00:00:00Z'
    expect(validate(none).ok).toBe(true)
  })

  it('accepts Engine held-out results only for layer-G suites', () => {
    const value = complete()
    value.engineHeldOut[0] = {
      ...measured('developer-capability.l5', 'held-out', 'claude-code', 3, 'engine'),
      recordedAt: '2026-11-02T12:00:00Z'
    }
    expect(validate(value)).toMatchObject({
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
    expect(validate(empty).ok).toBe(true)

    const partial = complete()
    partial.developmentRuns = partial.developmentRuns.slice(0, 1)
    partial.heldOut.toolSelection.results = partial.heldOut.toolSelection.results.slice(0, 1)
    partial.heldOut.sourceCitation.results = partial.heldOut.sourceCitation.results.slice(1)
    expect(validate(partial).ok).toBe(true)
  })

  it('refuses a second result for one suite and adapter', () => {
    const development = complete()
    development.developmentRuns.push(measured(STEP_ONE_SUITES[0]!, 'development', STEP_ONE_ADAPTERS[0]!))
    const last = development.developmentRuns.length - 1
    expect(validate(development)).toMatchObject({
      ok: false,
      refusal: { path: `developmentRuns[${last}]` }
    })

    const held = complete()
    held.heldOut.sourceCitation.results = [
      measured('source-delivery.l5', 'held-out', 'codex'),
      measured('source-delivery.l5', 'held-out', 'codex')
    ]
    expect(validate(held)).toMatchObject({
      ok: false,
      refusal: { path: 'heldOut.sourceCitation.results[1]' }
    })
  })

  it('still fully validates each partial result', () => {
    const development = complete()
    development.developmentRuns = [{ ...measured(STEP_ONE_SUITES[0]!, 'development', 'codex'), trialsPerTask: 1 }]
    expect(validate(development)).toMatchObject({
      ok: false,
      refusal: { path: 'developmentRuns[0].trialsPerTask' }
    })

    const held = complete()
    held.heldOut.toolSelection.results = [{ ...measured('tool-catalog.l5', 'held-out', 'codex'), split: 'development' }]
    expect(validate(held)).toMatchObject({
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
        expect(validate(value)).toMatchObject({
          ok: false,
          refusal: { path: `practiceRuns[0].usage.${key}` }
        })
      }
    }
  })
})

describe('the standalone held-out baseline', () => {
  const first = 'standaloneHeldOutBaseline[0]'
  const refused = (value: unknown, path: string, digests?: Record<string, string>) =>
    expect(validate(value, digests)).toMatchObject({ ok: false, refusal: { path } })

  it('accepts one digest-pinned result per backend-comparison suite and adapter', () => {
    const value = complete()
    value.standaloneHeldOutBaseline.push(
      ...BACKEND_COMPARISON_SUITES.map(
        (suite) =>
          ({ ...measured(suite, 'held-out', 'codex'), heldOutDigest: DIGESTS[suite] }) as Record<string, unknown>
      )
    )
    expect(validate(value).ok).toBe(true)
  })

  it('refuses a missing or wrong held-out digest', () => {
    const missing = complete()
    delete missing.standaloneHeldOutBaseline[0]!.heldOutDigest
    refused(missing, `${first}.heldOutDigest`)
    const wrong = complete()
    wrong.standaloneHeldOutBaseline[0]!.heldOutDigest = DIGESTS[BACKEND_COMPARISON_SUITES[1]!]
    refused(wrong, `${first}.heldOutDigest`)
  })

  it('refuses an Engine backend or the development split', () => {
    const engine = complete()
    engine.standaloneHeldOutBaseline[0]!.backend = 'engine'
    refused(engine, `${first}.backend`)
    const development = complete()
    development.standaloneHeldOutBaseline[0]!.split = 'development'
    refused(development, `${first}.split`)
  })

  it('refuses a duplicate suite and adapter', () => {
    const value = complete()
    value.standaloneHeldOutBaseline.push({ ...value.standaloneHeldOutBaseline[0]! })
    refused(value, `standaloneHeldOutBaseline[${value.standaloneHeldOutBaseline.length - 1}]`)
  })

  it('refuses another trial count than the freeze record, and a suite outside the backend comparison', () => {
    const trials = complete()
    trials.standaloneHeldOutBaseline[0] = {
      ...measured(BACKEND_COMPARISON_SUITES[0]!, 'held-out', 'claude-code', 1),
      heldOutDigest: DIGESTS[BACKEND_COMPARISON_SUITES[0]!]
    }
    refused(trials, `${first}.trialsPerTask`)
    const layerP = complete()
    layerP.standaloneHeldOutBaseline[0] = {
      ...measured('developer-capability.l5', 'held-out', 'claude-code'),
      heldOutDigest: DIGESTS[BACKEND_COMPARISON_SUITES[0]!]
    }
    refused(layerP, `${first}.suite`)
  })

  it('refuses a backend-comparison suite the digest map does not name, naming the suite', () => {
    const suite = BACKEND_COMPARISON_SUITES[0]!
    const { [suite]: _, ...without } = DIGESTS
    expect(validate(complete(), without)).toMatchObject({
      ok: false,
      refusal: { path: `${first}.suite`, detail: expect.stringContaining(suite) }
    })
  })

  it('reads each suite digest from the pinned held-out files, for every generic suite and no other', () => {
    const expected: Record<string, string> = {}
    for (const key of Object.keys(GENERIC_SUITE_IDS) as Array<keyof typeof GENERIC_SUITE_IDS>) {
      // The held-out read path names the one approval it opens with, without opening the file.
      let pinned: string | undefined
      try {
        heldOutCases(key, '', () => {
          throw new Error('the held-out file was opened')
        })
      } catch (error) {
        pinned = /approval ([0-9a-f]{64})/.exec(String(error))?.[1]
      }
      expect(pinned).toBeDefined()
      expect(Object.values(DERIVED_FILE_DIGESTS).map((family): string => family.heldOut)).toContain(pinned as string)
      expected[GENERIC_SUITE_IDS[key].split('@')[0]!] = pinned as string
    }
    expect(heldOutDigestsBySuite()).toEqual(expected)
    // Every backend-comparison suite has a pinned digest, so the committed record's baseline can be checked.
    for (const suite of BACKEND_COMPARISON_SUITES) expect(heldOutDigestsBySuite()[suite]).toBeDefined()
  })
})

describe('the paired development pilot', () => {
  const suite = BACKEND_COMPARISON_SUITES[1]!
  const pilot = () => {
    const value = complete()
    value.developmentRuns.push(
      measured(suite, 'development', 'claude-code'),
      measured(suite, 'development', 'claude-code', 3, 'engine'),
      measured(suite, 'development', 'codex', 3, 'engine')
    )
    return value
  }
  const last = (value: ReturnType<typeof complete>) => value.developmentRuns.length - 1

  it('accepts a standalone and an Engine result of one backend-comparison suite and adapter', () =>
    expect(validate(pilot()).ok).toBe(true))

  it('refuses a duplicate suite, adapter and backend', () => {
    const value = pilot()
    value.developmentRuns.push(measured(suite, 'development', 'claude-code', 3, 'engine'))
    expect(validate(value)).toMatchObject({ ok: false, refusal: { path: `developmentRuns[${last(value)}]` } })
  })

  it('refuses a pilot pair whose runs differ in task set', () => {
    const value = pilot()
    const engine = value.developmentRuns.length - 2
    value.developmentRuns[engine]!.tasks = [{ taskId: 'another-task', successes: 2, trials: 3 }]
    expect(validate(value)).toMatchObject({ ok: false, refusal: { path: `developmentRuns[${engine}].tasks` } })
  })

  it('refuses a pilot pair whose runs differ in trial count', () => {
    const value = pilot()
    const engine = value.developmentRuns.length - 2
    value.developmentRuns[engine] = measured(suite, 'development', 'claude-code', 2, 'engine')
    expect(validate(value)).toMatchObject({
      ok: false,
      refusal: { path: `developmentRuns[${engine}].trialsPerTask` }
    })
  })

  it('refuses an Engine development result of a step-one suite', () => {
    const value = complete()
    value.developmentRuns.push(measured(STEP_ONE_SUITES[0]!, 'development', 'codex', 3, 'engine'))
    expect(validate(value)).toMatchObject({
      ok: false,
      refusal: { path: `developmentRuns[${last(value)}].backend` }
    })
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

  it('is accepted by the validator against the pinned held-out digests', () =>
    expect(validateFreezeRecord(record, heldOutDigestsBySuite()).ok).toBe(true))

  it('holds practice runs only, and no comparison parameters or scored result', () => {
    expect('comparisonParameters' in record).toBe(false)
    expect(record.developmentRuns).toEqual([])
    expect(record.standaloneHeldOutBaseline).toEqual([])
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
