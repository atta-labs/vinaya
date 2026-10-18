// The evaluation harness's port contracts: each validator accepts a well-formed
// value and refuses each malformed shape with a typed reason naming the field.
import { describe, expect, it } from 'bun:test'
import {
  type ContractRefusalCode,
  createSuite,
  type Trial,
  trialVerdict,
  type Validated,
  validateGraderIdentity,
  validateGraderResult,
  validateReport,
  validateSuite,
  validateSuiteRevision,
  validateTask,
  validateTaskTally,
  validateTrial,
  validateTrialSet
} from '../../src/lib/dev-review-eval/contracts'
import { GENERIC_GRADERS } from '../../src/lib/dev-review-eval/generic-graders'
import { GRADERS as DEVELOPER_CAPABILITY_GRADERS } from './developer-capability-suite'
import { REVIEW_QUALITY_GRADER } from './reviewer-quality-suite'
import { STATE_GRADER, TRACE_GRADER } from './tool-selection-suite'

const D = (c: string) => c.repeat(64)
const COMMIT = 'c'.repeat(40)

const codeGrader = { kind: 'code', layer: 'G', id: 'hidden-tests', version: '1', logicDigest: D('1') }
const modelGrader = {
  kind: 'model',
  layer: 'P',
  id: 'finding-matches-defect',
  version: '2',
  adapterVersion: '0.4.0',
  cliVersion: '2.1.0',
  model: 'grader-model',
  promptDigest: D('2'),
  outputSchemaDigest: D('3'),
  calibrationCorpusDigest: D('4')
}

function validTask(): Record<string, unknown> {
  return {
    id: 'fix-parser',
    kind: 'coding',
    inputs: {
      repositoryCommit: COMMIT,
      briefDigest: D('5'),
      stagedInputDigests: { 'issue-body': D('6') },
      scriptedEnvironmentDigest: null
    },
    environmentBuilder: { id: 'isolated-clone', version: '1' },
    referenceSolution: { digest: D('7') },
    graders: [codeGrader, modelGrader],
    pinning: {
      repositoryCommit: COMMIT,
      briefDigest: D('5'),
      stagedInputDigests: { 'issue-body': D('6') },
      referenceSolutionDigest: D('7'),
      expectedOutcomeDigest: D('8'),
      graders: [modelGrader, codeGrader]
    }
  }
}

function validTrial(n = 1): Record<string, unknown> {
  return {
    id: `fix-parser.standalone.${n}`,
    taskId: 'fix-parser',
    condition: 'standalone',
    attempt: n,
    scope: { kind: 'whole' },
    isolation: {
      workspaceId: `ws-${n}`,
      vendorHomeId: `home-${n}`,
      checkpointerId: `ckpt-${n}`,
      logDestinationId: `log-${n}`
    },
    outcome: {
      kind: 'graded',
      outcomeDigest: D('9'),
      grades: [
        { grader: codeGrader, result: { verdict: 'pass' } },
        { grader: modelGrader, result: { verdict: 'unknown', reason: 'wording differs' } }
      ]
    },
    transcriptDigests: [D('a')]
  }
}

function validSuite(): Record<string, unknown> {
  return {
    name: 'developer-capability',
    version: 1,
    layer: 'L5',
    kind: 'capability',
    splits: { development: ['fix-parser', 'add-flag'], heldOut: ['rename-module'] }
  }
}

const resampling = { method: 'percentile', seed: 7, resamples: 1000, confidence: 0.95 }

function validReport(): Record<string, unknown> {
  return {
    suite: { name: 'developer-capability', version: 1 },
    split: 'development',
    conditions: [
      {
        condition: 'standalone',
        tasks: [
          { taskId: 'fix-parser', successes: 3, trials: 3 },
          { taskId: 'add-flag', successes: 1, trials: 3 }
        ],
        mean: 2 / 3,
        interval: { lower: 1 / 3, upper: 1 },
        resampling,
        passHatK: [{ k: 3, value: 0.5 }]
      },
      {
        condition: 'engine',
        tasks: [
          { taskId: 'fix-parser', successes: 0, trials: 3 },
          { taskId: 'add-flag', successes: 1, trials: 3 }
        ],
        mean: 1 / 6,
        interval: { lower: 0, upper: 1 / 3 },
        resampling,
        passHatK: []
      }
    ],
    paired: {
      baseline: 'standalone',
      candidate: 'engine',
      meanDifference: -0.5,
      interval: { lower: -1, upper: 0 },
      resampling,
      regressions: ['fix-parser'],
      severeRegressions: ['fix-parser']
    },
    quarantined: [
      {
        taskId: 'rename-module',
        cause: 'broken-task',
        reason: 'reference solution fails its own tests',
        reasonVersion: 1,
        adjudicationDigest: D('b')
      }
    ],
    transcriptDigests: [D('c')]
  }
}

/** A deep copy of `base` with the value at a dotted path replaced (or deleted with `undefined`). */
function withPath(base: Record<string, unknown>, path: string, next: unknown): Record<string, unknown> {
  const copy = structuredClone(base)
  const keys = path.split('.')
  let cursor: Record<string, unknown> = copy
  for (const key of keys.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>
  const last = keys[keys.length - 1] as string
  if (next === undefined) delete cursor[last]
  else cursor[last] = next
  return copy
}

function refused<T>(result: Validated<T>): { code: ContractRefusalCode; path: string } {
  if (result.ok) throw new Error('expected a refusal')
  return { code: result.refusal.code, path: result.refusal.path }
}

describe('Grader contract', () => {
  it('accepts pinned code and model grader identities', () => {
    expect(validateGraderIdentity(codeGrader).ok).toBe(true)
    expect(validateGraderIdentity(modelGrader).ok).toBe(true)
  })

  it('refuses a model grader missing any pinned element', () => {
    for (const key of [
      'adapterVersion',
      'cliVersion',
      'model',
      'promptDigest',
      'outputSchemaDigest',
      'calibrationCorpusDigest'
    ]) {
      expect(refused(validateGraderIdentity(withPath(modelGrader, key, undefined)))).toEqual({
        code: 'missing_field',
        path: key
      })
    }
    expect(refused(validateGraderIdentity({ ...modelGrader, promptDigest: 'abc' }))).toEqual({
      code: 'bad_digest',
      path: 'promptDigest'
    })
    expect(refused(validateGraderIdentity({ ...codeGrader, kind: 'human' }))).toEqual({
      code: 'unknown_value',
      path: 'kind'
    })
  })

  it('refuses a code or model grader that declares no layer, or a layer other than G or P', () => {
    for (const grader of [codeGrader, modelGrader]) {
      expect(refused(validateGraderIdentity(withPath(grader, 'layer', undefined)))).toEqual({
        code: 'missing_field',
        path: 'layer'
      })
      expect(refused(validateGraderIdentity({ ...grader, layer: 'L5' }))).toEqual({
        code: 'unknown_value',
        path: 'layer'
      })
    }
  })

  it('tags every existing suite grader with layer P and every generic grader with layer G', () => {
    const existing = [...DEVELOPER_CAPABILITY_GRADERS, REVIEW_QUALITY_GRADER, TRACE_GRADER, STATE_GRADER]
    for (const identity of existing) {
      expect({ id: identity.id, layer: identity.layer }).toEqual({ id: identity.id, layer: 'P' })
      expect(validateGraderIdentity(identity).ok).toBe(true)
    }
    for (const { identity } of GENERIC_GRADERS) {
      expect({ id: identity.id, layer: identity.layer }).toEqual({ id: identity.id, layer: 'G' })
      expect(validateGraderIdentity(identity).ok).toBe(true)
    }
  })

  it('returns pass, fail or — for a model grader only — unknown with a reason', () => {
    expect(validateGraderResult({ grader: codeGrader, result: { verdict: 'pass' } }).ok).toBe(true)
    expect(validateGraderResult({ grader: codeGrader, result: { verdict: 'fail', reason: 'test x failed' } }).ok).toBe(
      true
    )
    expect(validateGraderResult({ grader: modelGrader, result: { verdict: 'unknown', reason: 'ambiguous' } }).ok).toBe(
      true
    )
    expect(refused(validateGraderResult({ grader: codeGrader, result: { verdict: 'unknown', reason: 'x' } }))).toEqual({
      code: 'unknown_from_code_grader',
      path: 'result.verdict'
    })
    expect(refused(validateGraderResult({ grader: modelGrader, result: { verdict: 'unknown' } }))).toEqual({
      code: 'reason_required',
      path: 'result.reason'
    })
    expect(refused(validateGraderResult({ grader: codeGrader, result: { verdict: 'maybe' } }))).toEqual({
      code: 'unknown_value',
      path: 'result.verdict'
    })
  })
})

describe('Task contract', () => {
  it('accepts a task with fixed inputs, environment builder, reference solution, graders and pinning record', () => {
    const result = validateTask(validTask())
    expect(result.ok).toBe(true)
  })

  it('accepts a non-coding task without a reference solution', () => {
    let task = withPath(validTask(), 'kind', 'non-coding')
    task = withPath(task, 'referenceSolution', null)
    task = withPath(task, 'pinning.referenceSolutionDigest', null)
    expect(validateTask(task).ok).toBe(true)
  })

  it('refuses each malformed shape with a typed reason', () => {
    const cases: [string, unknown, ContractRefusalCode][] = [
      ['id', 'Fix Parser', 'bad_name'],
      ['kind', 'other', 'unknown_value'],
      ['inputs.repositoryCommit', 'main', 'bad_commit'],
      ['inputs.briefDigest', undefined, 'missing_field'],
      ['inputs.stagedInputDigests', [], 'not_object'],
      ['environmentBuilder', 'clone', 'not_object'],
      ['referenceSolution', null, 'reference_solution_required'],
      ['graders', [], 'empty'],
      ['graders', [codeGrader, codeGrader], 'duplicate'],
      ['pinning.repositoryCommit', 'd'.repeat(40), 'inconsistent'],
      ['pinning.briefDigest', D('e'), 'inconsistent'],
      ['pinning.stagedInputDigests', {}, 'inconsistent'],
      ['pinning.referenceSolutionDigest', D('e'), 'inconsistent'],
      ['pinning.expectedOutcomeDigest', 'x', 'bad_digest'],
      ['pinning.graders', [codeGrader, { ...modelGrader, model: 'other' }], 'grader_not_pinned'],
      ['pinning.graders', [codeGrader, modelGrader, { ...codeGrader, id: 'extra' }], 'inconsistent']
    ]
    for (const [path, next, code] of cases) {
      const result = validateTask(withPath(validTask(), path, next))
      expect({ path, code: refused(result).code }).toEqual({ path, code })
    }
  })

  it('refuses a value that is not an object at all', () => {
    expect(refused(validateTask(null))).toEqual({ code: 'not_object', path: '' })
  })
})

describe('Trial contract', () => {
  it('accepts one isolated execution with its outcome and transcript references', () => {
    expect(validateTrial(validTrial()).ok).toBe(true)
    expect(validateTrial(withPath(validTrial(), 'outcome', { kind: 'errored', reason: 'agent timed out' })).ok).toBe(
      true
    )
  })

  it('leaves room for a node alone or a section by partial execution', () => {
    expect(validateTrial(withPath(validTrial(), 'scope', { kind: 'node', node: 'review' })).ok).toBe(true)
    expect(validateTrial(withPath(validTrial(), 'scope', { kind: 'section', fromNode: 'a', toNode: 'b' })).ok).toBe(
      true
    )
    expect(refused(validateTrial(withPath(validTrial(), 'scope', { kind: 'section', fromNode: 'a' })))).toEqual({
      code: 'missing_field',
      path: 'scope.toNode'
    })
  })

  it('refuses each malformed shape with a typed reason', () => {
    const cases: [string, unknown, ContractRefusalCode][] = [
      ['attempt', 0, 'out_of_range'],
      ['attempt', 1.5, 'wrong_type'],
      ['isolation.checkpointerId', undefined, 'missing_field'],
      ['outcome.kind', 'done', 'unknown_value'],
      ['outcome.grades', [], 'empty'],
      ['outcome.outcomeDigest', 'x', 'bad_digest'],
      ['transcriptDigests', [D('a'), D('a')], 'duplicate'],
      ['transcriptDigests', 'x', 'wrong_type']
    ]
    for (const [path, next, code] of cases) {
      expect({ path, code: refused(validateTrial(withPath(validTrial(), path, next))).code }).toEqual({ path, code })
    }
  })

  it('a trial set refuses a shared isolation identity and a repeated attempt', () => {
    expect(validateTrialSet([validTrial(1), validTrial(2)]).ok).toBe(true)
    const shared = withPath(validTrial(2), 'isolation.checkpointerId', 'ckpt-1')
    expect(refused(validateTrialSet([validTrial(1), shared]))).toEqual({
      code: 'shared_isolation',
      path: 'trials.isolation.checkpointerId'
    })
    const repeated = withPath(validTrial(2), 'attempt', 1)
    expect(refused(validateTrialSet([validTrial(1), repeated])).code).toBe('duplicate')
  })

  it('a trial passes only when every grade passes; unknown awaits adjudication', () => {
    const base = validateTrial(validTrial())
    if (!base.ok) throw new Error('fixture invalid')
    const trial: Trial = base.value
    expect(trialVerdict(trial)).toBe('unknown')
    const grades = trial.outcome.kind === 'graded' ? trial.outcome.grades : []
    const allPass: Trial = {
      ...trial,
      outcome: {
        kind: 'graded',
        outcomeDigest: D('9'),
        grades: grades.map((g) => ({ ...g, result: { verdict: 'pass' } }))
      }
    }
    expect(trialVerdict(allPass)).toBe('pass')
    const oneFail: Trial = {
      ...trial,
      outcome: {
        kind: 'graded',
        outcomeDigest: D('9'),
        grades: grades.map((g, i) => (i === 0 ? { ...g, result: { verdict: 'fail', reason: 'x' } } : g))
      }
    }
    expect(trialVerdict(oneFail)).toBe('fail')
    expect(trialVerdict({ ...trial, outcome: { kind: 'errored', reason: 'crashed' } })).toBe('fail')
  })
})

describe('Suite contract', () => {
  it('accepts a named, versioned suite with layer, kind and fixed splits', () => {
    expect(validateSuite(validSuite()).ok).toBe(true)
  })

  it('refuses each malformed shape with a typed reason', () => {
    const cases: [string, unknown, ContractRefusalCode][] = [
      ['name', 'Developer Capability', 'bad_name'],
      ['version', 0, 'out_of_range'],
      ['layer', 'L9', 'unknown_value'],
      ['kind', 'smoke', 'unknown_value'],
      ['splits.heldOut', ['fix-parser'], 'splits_overlap'],
      ['splits.development', ['add-flag', 'add-flag'], 'duplicate'],
      ['splits', { development: [], heldOut: [] }, 'empty']
    ]
    for (const [path, next, code] of cases) {
      expect({ path, code: refused(validateSuite(withPath(validSuite(), path, next))).code }).toEqual({ path, code })
    }
  })

  it('splits are fixed at creation: frozen, and a same-version revision may not move them', () => {
    const created = createSuite(validSuite())
    if (!created.ok) throw new Error('fixture invalid')
    expect(Object.isFrozen(created.value)).toBe(true)
    expect(Object.isFrozen(created.value.splits.heldOut)).toBe(true)
    expect(() => (created.value.splits.heldOut as string[]).push('leak')).toThrow()

    const reordered = withPath(validSuite(), 'splits.development', ['add-flag', 'fix-parser'])
    expect(validateSuiteRevision(created.value, reordered).ok).toBe(true)
    const moved = withPath(validSuite(), 'splits', {
      development: ['fix-parser'],
      heldOut: ['rename-module', 'add-flag']
    })
    expect(refused(validateSuiteRevision(created.value, moved))).toEqual({ code: 'splits_changed', path: 'splits' })
    expect(validateSuiteRevision(created.value, withPath(moved, 'version', 2)).ok).toBe(true)
  })
})

describe('Report contract', () => {
  it('accepts per-task and per-suite estimates, a paired comparison, quarantines and transcript references', () => {
    expect(validateReport(validReport()).ok).toBe(true)
    expect(validateReport(withPath(validReport(), 'paired', null)).ok).toBe(true)
  })

  it('refuses each malformed shape with a typed reason', () => {
    const cases: [string, unknown, ContractRefusalCode][] = [
      ['split', 'test', 'unknown_value'],
      ['conditions', [], 'empty'],
      ['conditions.0.tasks.0.successes', 4, 'out_of_range'],
      ['conditions.0.mean', 1.5, 'out_of_range'],
      ['conditions.0.interval', { lower: 0.8, upper: 1 }, 'inconsistent'],
      ['conditions.0.passHatK', [{ k: 4, value: 0.1 }], 'out_of_range'],
      ['conditions.0.resampling.seed', -1, 'out_of_range'],
      ['conditions.0.resampling.confidence', 1, 'out_of_range'],
      ['paired.candidate', 'missing', 'inconsistent'],
      ['paired.candidate', 'standalone', 'inconsistent'],
      ['paired.severeRegressions', ['add-flag'], 'inconsistent'],
      ['paired.interval', { lower: -0.4, upper: 0 }, 'inconsistent'],
      ['quarantined.0.taskId', 'fix-parser', 'inconsistent'],
      ['quarantined.0.cause', 'flaky', 'unknown_value'],
      ['transcriptDigests', ['x'], 'bad_digest']
    ]
    for (const [path, next, code] of cases) {
      expect({ path, code: refused(validateReport(withPath(validReport(), path, next))).code }).toEqual({ path, code })
    }
  })

  it('a task tally refuses more successes than trials', () => {
    expect(validateTaskTally({ taskId: 'a', successes: 2, trials: 3 }).ok).toBe(true)
    expect(refused(validateTaskTally({ taskId: 'a', successes: 4, trials: 3 }))).toEqual({
      code: 'out_of_range',
      path: 'successes'
    })
  })
})
