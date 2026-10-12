// The evaluation harness's estimators, each checked against values computed
// by hand in the comment beside the assertion.
import { describe, expect, it } from 'bun:test'
import type { Quarantine, TaskTally } from '../../src/lib/dev-review-eval/contracts'
import {
  BOOTSTRAP_METHODS,
  type Estimate,
  pairedComparison,
  pairedRegressions,
  passHatK,
  passHatKForTask,
  quantile,
  type Resampling,
  resampleIndices,
  seededUniform,
  separateQuarantined,
  suiteMean,
  tallyTask
} from '../../src/lib/dev-review-eval/estimators'

const t = (taskId: string, successes: number, trials: number): TaskTally => ({ taskId, successes, trials })

function value<T>(estimate: Estimate<T>): T {
  if (!estimate.ok) throw new Error(`refused: ${estimate.refusal.code} — ${estimate.refusal.detail}`)
  return estimate.value
}

function refusal<T>(estimate: Estimate<T>): string {
  if (estimate.ok) throw new Error('expected a refusal')
  return estimate.refusal.code
}

describe('tallyTask', () => {
  it('counts successes c out of n trials', () => {
    expect(value(tallyTask('a', ['pass', 'fail', 'pass']))).toEqual(t('a', 2, 3))
  })

  it('refuses an unadjudicated unknown verdict and an empty trial list', () => {
    expect(refusal(tallyTask('a', ['pass', 'unknown']))).toBe('unadjudicated_unknown')
    expect(refusal(tallyTask('a', []))).toBe('bad_tally')
  })
})

describe('pass^k', () => {
  // Tasks (c, n) = (3, 3), (2, 3), (1, 3).
  const tallies = [t('a', 3, 3), t('b', 2, 3), t('c', 1, 3)]

  it('is C(c, k) / C(n, k) per task', () => {
    // C(2,2)/C(3,2) = 1/3; C(1,2)/C(3,2) = 0; C(3,3)/C(3,3) = 1; C(4,2)/C(5,2) = 6/10.
    expect(passHatKForTask(t('b', 2, 3), 2)).toBeCloseTo(1 / 3, 12)
    expect(passHatKForTask(t('c', 1, 3), 2)).toBe(0)
    expect(passHatKForTask(t('a', 3, 3), 3)).toBe(1)
    expect(passHatKForTask(t('d', 4, 5), 2)).toBeCloseTo(0.6, 12)
  })

  it('averages over tasks', () => {
    // k = 1: (1 + 2/3 + 1/3) / 3 = 2/3.  k = 2: (1 + 1/3 + 0) / 3 = 4/9.  k = 3: (1 + 0 + 0) / 3 = 1/3.
    expect(value(passHatK(tallies, 1))).toBeCloseTo(2 / 3, 12)
    expect(value(passHatK(tallies, 2))).toBeCloseTo(4 / 9, 12)
    expect(value(passHatK(tallies, 3))).toBeCloseTo(1 / 3, 12)
  })

  it('is refused when any task ran fewer than k trials', () => {
    expect(refusal(passHatK([t('a', 2, 2), t('b', 3, 3)], 3))).toBe('trials_below_k')
  })

  it('is refused for a k that is not a positive integer, and for malformed tallies', () => {
    expect(refusal(passHatK(tallies, 0))).toBe('bad_k')
    expect(refusal(passHatK(tallies, 1.5))).toBe('bad_k')
    expect(refusal(passHatK([], 1))).toBe('no_tasks')
    expect(refusal(passHatK([t('a', 4, 3)], 1))).toBe('bad_tally')
    expect(refusal(passHatK([t('a', 1, 3), t('a', 1, 3)], 1))).toBe('duplicate_task')
  })
})

describe('seeded resampling', () => {
  it('reproduces the published Mulberry32 sequence for seed 1', () => {
    const u = seededUniform(1)
    expect([u(), u(), u()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522])
  })

  it('draws the same indices for the same seed and different ones for another', () => {
    expect(resampleIndices(7, 2, 4)).toEqual([
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 0]
    ])
    expect(resampleIndices(7, 4, 3)).toEqual([
      [0, 0, 3, 2],
      [2, 1, 1, 0],
      [2, 2, 1, 0]
    ])
    expect(resampleIndices(7, 4, 50)).toEqual(resampleIndices(7, 4, 50))
    expect(resampleIndices(8, 4, 50)).not.toEqual(resampleIndices(7, 4, 50))
  })

  it('takes quantiles by linear interpolation between order statistics', () => {
    // Sorted [0, 0, 0.5, 1]: position 3 · 0.75 = 2.25 → 0.5 + 0.25 · 0.5 = 0.625.
    expect(quantile([1, 0, 0.5, 0], 0.75)).toBe(0.625)
    expect(quantile([1, 0, 0.5, 0], 0)).toBe(0)
    expect(quantile([1, 0, 0.5, 0], 1)).toBe(1)
  })
})

describe('suiteMean', () => {
  // Rates [0, 1]; seed 7, 4 resamples draw [0,0] [1,1] [1,0] [0,0] → resampled
  // means [0, 1, 0.5, 0], sorted [0, 0, 0.5, 1]. Confidence 0.5 → α/2 = 0.25:
  // q(0.25) at position 0.75 = 0; q(0.75) at position 2.25 = 0.625. Mean 0.5.
  const twoTasks = [t('a', 0, 2), t('b', 2, 2)]
  const base = { seed: 7, resamples: 4, confidence: 0.5 }

  it('percentile method: [q(α/2), q(1 − α/2)]', () => {
    const result = value(suiteMean(twoTasks, { ...base, method: 'percentile' }))
    expect(result.mean).toBe(0.5)
    expect(result.taskCount).toBe(2)
    expect(result.interval).toEqual({ lower: 0, upper: 0.625 })
    expect(result.resampling).toEqual({ ...base, method: 'percentile' })
  })

  it('basic method: [2θ̂ − q(1 − α/2), 2θ̂ − q(α/2)]', () => {
    // [1 − 0.625, 1 − 0] = [0.375, 1].
    const result = value(suiteMean(twoTasks, { ...base, method: 'basic' }))
    expect(result.interval).toEqual({ lower: 0.375, upper: 1 })
  })

  it('a 95% percentile interval on four tasks', () => {
    // Rates [1, 0.5, 0, 1/3]; seed 7, 3 resamples draw [0,0,3,2] [2,1,1,0] [2,2,1,0]:
    // means (1+1+1/3+0)/4 = 7/12, (0+.5+.5+1)/4 = 0.5, (0+0+.5+1)/4 = 0.375.
    // Sorted [0.375, 0.5, 7/12]; q(0.025) at 0.05 = 0.38125; q(0.975) at 1.95 = 0.5 + 0.95/12.
    const fourTasks = [t('a', 3, 3), t('b', 1, 2), t('c', 0, 3), t('d', 1, 3)]
    const result = value(suiteMean(fourTasks, { method: 'percentile', seed: 7, resamples: 3, confidence: 0.95 }))
    expect(result.mean).toBeCloseTo((1 + 0.5 + 0 + 1 / 3) / 4, 12)
    expect(result.interval.lower).toBeCloseTo(0.38125, 12)
    expect(result.interval.upper).toBeCloseTo(0.5 + 0.95 / 12, 12)
  })

  it('every supported method is deterministic for equal inputs', () => {
    const tallies = [t('a', 3, 3), t('b', 1, 3), t('c', 0, 3), t('d', 2, 3), t('e', 3, 3)]
    for (const method of BOOTSTRAP_METHODS) {
      const r: Resampling = { method, seed: 2026, resamples: 1000, confidence: 0.95 }
      expect(suiteMean(tallies, r)).toEqual(suiteMean(tallies, r))
    }
  })

  it('a suite where every task scores the same has a degenerate interval under every method', () => {
    for (const method of BOOTSTRAP_METHODS) {
      const result = value(
        suiteMean([t('a', 2, 3), t('b', 2, 3)], { method, seed: 3, resamples: 20, confidence: 0.95 })
      )
      expect(result.interval.lower).toBeCloseTo(2 / 3, 12)
      expect(result.interval.upper).toBeCloseTo(2 / 3, 12)
    }
  })

  it('refuses an unknown method and malformed seed, resample count or confidence', () => {
    const tallies = [t('a', 1, 2)]
    const ok: Resampling = { method: 'percentile', seed: 1, resamples: 10, confidence: 0.95 }
    expect(refusal(suiteMean(tallies, { ...ok, method: 'bca' as Resampling['method'] }))).toBe('unknown_method')
    expect(refusal(suiteMean(tallies, { ...ok, seed: -1 }))).toBe('bad_resampling')
    expect(refusal(suiteMean(tallies, { ...ok, seed: 1.5 }))).toBe('bad_resampling')
    expect(refusal(suiteMean(tallies, { ...ok, seed: 2 ** 32 }))).toBe('bad_resampling')
    expect(refusal(suiteMean(tallies, { ...ok, resamples: 0 }))).toBe('bad_resampling')
    expect(refusal(suiteMean(tallies, { ...ok, confidence: 1 }))).toBe('bad_resampling')
    expect(refusal(suiteMean(tallies, { ...ok, confidence: 0 }))).toBe('bad_resampling')
  })
})

describe('paired comparison', () => {
  // Baseline (c of 3): a 3, b 1, c 2, d 2.  Candidate: a 0, b 2, c 1, d 2.
  // Regressions (candidate < baseline): a, c.  Severe (baseline 3/3, candidate 0/3): a.
  // Differences: −1, +1/3, −1/3, 0 → mean −1/4.
  const baseline = [t('a', 3, 3), t('b', 1, 3), t('c', 2, 3), t('d', 2, 3)]
  const candidate = [t('d', 2, 3), t('c', 1, 3), t('b', 2, 3), t('a', 0, 3)]

  it('flags paired regressions and severe paired regressions', () => {
    expect(value(pairedRegressions(baseline, candidate))).toEqual({ regressions: ['a', 'c'], severeRegressions: ['a'] })
  })

  it('a candidate failing every trial where the baseline also failed one is not severe', () => {
    expect(value(pairedRegressions([t('a', 2, 3)], [t('a', 0, 3)]))).toEqual({
      regressions: ['a'],
      severeRegressions: []
    })
  })

  it('estimates the mean paired difference with a paired bootstrap interval', () => {
    // Differences [−1, 1/3, −1/3, 0]; seed 7, 3 resamples draw [0,0,3,2] [2,1,1,0] [2,2,1,0]:
    // means (−1−1+0−1/3)/4 = −7/12, (−1/3+1/3+1/3−1)/4 = −1/6, (−1/3−1/3+1/3−1)/4 = −1/3.
    // Sorted [−7/12, −1/3, −1/6]; confidence 0.5: q(0.25) at 0.5 = −11/24, q(0.75) at 1.5 = −1/4.
    const r: Resampling = { method: 'percentile', seed: 7, resamples: 3, confidence: 0.5 }
    const result = value(pairedComparison(baseline, candidate, r))
    expect(result.meanDifference).toBeCloseTo(-0.25, 12)
    expect(result.interval.lower).toBeCloseTo(-11 / 24, 12)
    expect(result.interval.upper).toBeCloseTo(-1 / 4, 12)
    expect(result.regressions).toEqual(['a', 'c'])
    expect(result.severeRegressions).toEqual(['a'])
    // Basic: [2·(−1/4) + 1/4, 2·(−1/4) + 11/24] = [−1/4, −1/24].
    const basic = value(pairedComparison(baseline, candidate, { ...r, method: 'basic' }))
    expect(basic.interval.lower).toBeCloseTo(-1 / 4, 12)
    expect(basic.interval.upper).toBeCloseTo(-1 / 24, 12)
  })

  it('refuses different task sets and different trial counts', () => {
    expect(refusal(pairedRegressions(baseline, candidate.slice(1)))).toBe('task_sets_differ')
    expect(refusal(pairedRegressions([t('a', 1, 3)], [t('b', 1, 3)]))).toBe('task_sets_differ')
    expect(refusal(pairedRegressions([t('a', 1, 3)], [t('a', 1, 4)]))).toBe('trial_counts_differ')
    const r: Resampling = { method: 'basic', seed: 1, resamples: 5, confidence: 0.95 }
    expect(refusal(pairedComparison([t('a', 1, 3)], [t('a', 1, 4)], r))).toBe('trial_counts_differ')
  })
})

describe('quarantine', () => {
  const q = (taskId: string): Quarantine => ({
    taskId,
    cause: 'broken-grader',
    reason: 'grader compared against a stale fixture',
    reasonVersion: 1,
    adjudicationDigest: 'a'.repeat(64)
  })

  it('counts quarantined tasks separately and drops none', () => {
    const tallies = [t('a', 0, 3), t('b', 2, 3), t('c', 0, 3)]
    const split = value(separateQuarantined(tallies, [q('c')]))
    expect(split.estimated).toEqual([t('a', 0, 3), t('b', 2, 3)])
    expect(split.quarantinedCount).toBe(1)
    expect(split.quarantined).toEqual([{ quarantine: q('c'), tally: t('c', 0, 3) }])
    expect(split.estimated.length + split.quarantinedCount).toBe(tallies.length)
  })

  it('refuses a quarantine naming a task with no tally, or one task quarantined twice', () => {
    expect(refusal(separateQuarantined([t('a', 0, 3)], [q('z')]))).toBe('quarantine_unknown_task')
    expect(refusal(separateQuarantined([t('a', 0, 3)], [q('a'), q('a')]))).toBe('duplicate_task')
  })
})
