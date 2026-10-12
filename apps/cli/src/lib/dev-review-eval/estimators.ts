/**
 * The pure estimators a harness report shows, per the evaluation program's §8
 * (`apps/cli/specs/dev-review-evaluation-program.md`); this module's own
 * specification is `apps/cli/specs/evals.md`.
 *
 * Every function is pure: same inputs, same output. Each randomised estimator
 * takes its interval method, seed and resample count as explicit inputs — no
 * default method, seed, resample count or threshold is built in, because the
 * evaluation program freezes those values in a later milestone. Paired
 * comparison here is an estimate only; deciding acceptance is not this
 * module's job.
 */

import type { Interval, Quarantine, ResamplingRecord, TaskTally } from './contracts'

// ── Refusals ────────────────────────────────────────────────────────────────

export type EstimatorRefusalCode =
  | 'no_tasks'
  | 'bad_tally'
  | 'duplicate_task'
  | 'unadjudicated_unknown'
  | 'bad_k'
  | 'trials_below_k'
  | 'bad_resampling'
  | 'unknown_method'
  | 'task_sets_differ'
  | 'trial_counts_differ'
  | 'quarantine_unknown_task'

export interface EstimatorRefusal {
  code: EstimatorRefusalCode
  detail: string
}

export type Estimate<T> = { ok: true; value: T } | { ok: false; refusal: EstimatorRefusal }

function refused<T>(code: EstimatorRefusalCode, detail: string): Estimate<T> {
  return { ok: false, refusal: { code, detail } }
}

// ── Per-task tally ──────────────────────────────────────────────────────────

/**
 * Counts one task's successes c out of n trials from its trial verdicts. An
 * `unknown` verdict must be adjudicated to pass or fail before it is counted,
 * so the tally refuses one.
 */
export function tallyTask(taskId: string, verdicts: readonly ('pass' | 'fail' | 'unknown')[]): Estimate<TaskTally> {
  if (verdicts.length === 0) return refused('bad_tally', `task ${taskId} has no trials`)
  if (verdicts.includes('unknown')) {
    return refused('unadjudicated_unknown', `task ${taskId} has an unknown verdict awaiting adjudication`)
  }
  return {
    ok: true,
    value: { taskId, successes: verdicts.filter((v) => v === 'pass').length, trials: verdicts.length }
  }
}

function checkTallies(tallies: readonly TaskTally[]): EstimatorRefusal | null {
  if (tallies.length === 0) return { code: 'no_tasks', detail: 'at least one task is required' }
  const seen = new Set<string>()
  for (const t of tallies) {
    if (seen.has(t.taskId)) return { code: 'duplicate_task', detail: `task ${t.taskId} appears more than once` }
    seen.add(t.taskId)
    const valid =
      Number.isInteger(t.successes) &&
      Number.isInteger(t.trials) &&
      t.trials >= 1 &&
      t.successes >= 0 &&
      t.successes <= t.trials
    if (!valid) {
      return { code: 'bad_tally', detail: `task ${t.taskId} has ${t.successes} successes out of ${t.trials} trials` }
    }
  }
  return null
}

/** Per-task success rate c / n. */
export function successRate(t: TaskTally): number {
  return t.successes / t.trials
}

// ── pass^k ──────────────────────────────────────────────────────────────────

/**
 * Unbiased per-task estimate of the probability that all k of k trials
 * succeed: C(c, k) / C(n, k), computed as the product of (c − i) / (n − i)
 * for i = 0..k−1 so no binomial coefficient is ever materialised. It is 0
 * whenever c < k.
 */
export function passHatKForTask(t: TaskTally, k: number): number {
  let value = 1
  for (let i = 0; i < k; i++) value *= (t.successes - i) / (t.trials - i)
  return Math.max(0, value)
}

/**
 * pass^k averaged over tasks. Refused when k is not a positive integer or any
 * task ran fewer than k trials (the estimator requires n ≥ k).
 */
export function passHatK(tallies: readonly TaskTally[], k: number): Estimate<number> {
  const bad = checkTallies(tallies)
  if (bad !== null) return { ok: false, refusal: bad }
  if (!Number.isInteger(k) || k < 1) return refused('bad_k', `k must be a positive integer, got ${k}`)
  const short = tallies.find((t) => t.trials < k)
  if (short !== undefined) {
    return refused('trials_below_k', `task ${short.taskId} ran ${short.trials} trials, fewer than k = ${k}`)
  }
  return { ok: true, value: mean(tallies.map((t) => passHatKForTask(t, k))) }
}

// ── Seeded resampling ───────────────────────────────────────────────────────

/**
 * The supported bootstrap interval methods, both over tasks (the unit of
 * analysis). With θ̂ the point estimate and q(p) the p-quantile of the
 * resampled estimates (linear interpolation between order statistics):
 *
 * - `percentile` — [q(α/2), q(1 − α/2)]
 * - `basic` — [2θ̂ − q(1 − α/2), 2θ̂ − q(α/2)], clamped to the estimate's range
 */
export const BOOTSTRAP_METHODS = ['percentile', 'basic'] as const
export type BootstrapMethod = (typeof BOOTSTRAP_METHODS)[number]

/** Every input a randomised interval depends on, supplied by the caller. */
export interface Resampling {
  method: BootstrapMethod
  seed: number
  resamples: number
  confidence: number
}

function checkResampling(r: Resampling): EstimatorRefusal | null {
  if (!(BOOTSTRAP_METHODS as readonly string[]).includes(r.method)) {
    return {
      code: 'unknown_method',
      detail: `method must be one of ${BOOTSTRAP_METHODS.join(', ')}, got ${String(r.method)}`
    }
  }
  if (!Number.isInteger(r.seed) || r.seed < 0 || r.seed > 0xffffffff) {
    return { code: 'bad_resampling', detail: `seed must be an integer in [0, 2^32 − 1], got ${r.seed}` }
  }
  if (!Number.isInteger(r.resamples) || r.resamples < 1) {
    return { code: 'bad_resampling', detail: `resamples must be a positive integer, got ${r.resamples}` }
  }
  if (!(r.confidence > 0 && r.confidence < 1)) {
    return { code: 'bad_resampling', detail: `confidence must lie strictly between 0 and 1, got ${r.confidence}` }
  }
  return null
}

/**
 * Mulberry32: a 32-bit seeded generator returning floats in [0, 1). Chosen
 * because it is small enough to state exactly in the specification and gives
 * the same sequence on every runtime.
 */
export function seededUniform(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The task indices each bootstrap resample draws, with replacement: resample
 * r is `n` draws of ⌊u · n⌋ from one stream seeded by `seed`, consumed in
 * resample order.
 */
export function resampleIndices(seed: number, n: number, resamples: number): number[][] {
  const uniform = seededUniform(seed)
  const out: number[][] = []
  for (let r = 0; r < resamples; r++) {
    const draw: number[] = []
    for (let i = 0; i < n; i++) draw.push(Math.floor(uniform() * n))
    out.push(draw)
  }
  return out
}

/** The p-quantile of `values` by linear interpolation between order statistics. */
export function quantile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * p
  const lo = Math.floor(position)
  const hi = Math.ceil(position)
  const a = sorted[lo] as number
  const b = sorted[hi] as number
  return a + (b - a) * (position - lo)
}

function mean(values: readonly number[]): number {
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function bootstrapInterval(
  values: readonly number[],
  estimate: number,
  r: Resampling,
  min: number,
  max: number
): Interval {
  const stats = resampleIndices(r.seed, values.length, r.resamples).map((draw) =>
    mean(draw.map((i) => values[i] as number))
  )
  const alpha = 1 - r.confidence
  const qLow = quantile(stats, alpha / 2)
  const qHigh = quantile(stats, 1 - alpha / 2)
  if (r.method === 'percentile') return { lower: qLow, upper: qHigh }
  const clamp = (x: number) => Math.min(max, Math.max(min, x))
  return { lower: clamp(2 * estimate - qHigh), upper: clamp(2 * estimate - qLow) }
}

function record(r: Resampling): ResamplingRecord {
  return { method: r.method, seed: r.seed, resamples: r.resamples, confidence: r.confidence }
}

// ── Per-suite mean ──────────────────────────────────────────────────────────

export interface SuiteMean {
  taskCount: number
  mean: number
  interval: Interval
  resampling: ResamplingRecord
}

/**
 * The per-suite mean of per-task success rates, with a bootstrap interval over
 * tasks computed by the caller's method, seed, resample count and confidence.
 */
export function suiteMean(tallies: readonly TaskTally[], resampling: Resampling): Estimate<SuiteMean> {
  const bad = checkTallies(tallies) ?? checkResampling(resampling)
  if (bad !== null) return { ok: false, refusal: bad }
  const rates = tallies.map(successRate)
  const estimate = mean(rates)
  return {
    ok: true,
    value: {
      taskCount: tallies.length,
      mean: estimate,
      interval: bootstrapInterval(rates, estimate, resampling, 0, 1),
      resampling: record(resampling)
    }
  }
}

// ── Paired comparison ───────────────────────────────────────────────────────

export interface PairedEstimate {
  taskCount: number
  /** Mean per-task difference in success rate, candidate minus baseline. */
  meanDifference: number
  interval: Interval
  resampling: ResamplingRecord
  /** Tasks where the candidate succeeded on fewer trials than the baseline. */
  regressions: string[]
  /** Regressions where the baseline passed every trial and the candidate none. */
  severeRegressions: string[]
}

function pairTallies(
  baseline: readonly TaskTally[],
  candidate: readonly TaskTally[]
): { ok: true; pairs: [TaskTally, TaskTally][] } | { ok: false; refusal: EstimatorRefusal } {
  const bad = checkTallies(baseline) ?? checkTallies(candidate)
  if (bad !== null) return { ok: false, refusal: bad }
  const byId = new Map(candidate.map((t) => [t.taskId, t]))
  if (byId.size !== baseline.length || baseline.some((t) => !byId.has(t.taskId))) {
    return {
      ok: false,
      refusal: { code: 'task_sets_differ', detail: 'baseline and candidate must cover the same tasks' }
    }
  }
  const pairs: [TaskTally, TaskTally][] = []
  for (const b of baseline) {
    const c = byId.get(b.taskId) as TaskTally
    if (c.trials !== b.trials) {
      return {
        ok: false,
        refusal: {
          code: 'trial_counts_differ',
          detail: `task ${b.taskId} ran ${b.trials} baseline trials and ${c.trials} candidate trials`
        }
      }
    }
    pairs.push([b, c])
  }
  return { ok: true, pairs }
}

/**
 * Paired regressions between two conditions on the same tasks with the same
 * trial count per task, in baseline order. Reported for adjudication; never an
 * acceptance decision.
 */
export function pairedRegressions(
  baseline: readonly TaskTally[],
  candidate: readonly TaskTally[]
): Estimate<{ regressions: string[]; severeRegressions: string[] }> {
  const paired = pairTallies(baseline, candidate)
  if (!paired.ok) return paired
  const regressions: string[] = []
  const severeRegressions: string[] = []
  for (const [b, c] of paired.pairs) {
    if (c.successes < b.successes) regressions.push(b.taskId)
    if (b.successes === b.trials && c.successes === 0) severeRegressions.push(b.taskId)
  }
  return { ok: true, value: { regressions, severeRegressions } }
}

/**
 * The paired estimate: mean per-task difference (candidate minus baseline)
 * with a paired bootstrap interval over tasks, plus the paired regressions.
 */
export function pairedComparison(
  baseline: readonly TaskTally[],
  candidate: readonly TaskTally[],
  resampling: Resampling
): Estimate<PairedEstimate> {
  const paired = pairTallies(baseline, candidate)
  if (!paired.ok) return paired
  const badResampling = checkResampling(resampling)
  if (badResampling !== null) return { ok: false, refusal: badResampling }
  const differences = paired.pairs.map(([b, c]) => successRate(c) - successRate(b))
  const estimate = mean(differences)
  const flagged = pairedRegressions(baseline, candidate)
  if (!flagged.ok) return flagged
  return {
    ok: true,
    value: {
      taskCount: differences.length,
      meanDifference: estimate,
      interval: bootstrapInterval(differences, estimate, resampling, -1, 1),
      resampling: record(resampling),
      ...flagged.value
    }
  }
}

// ── Quarantine ──────────────────────────────────────────────────────────────

export interface QuarantineSplit {
  /** Tasks that feed the estimates. */
  estimated: TaskTally[]
  /** Quarantined tasks with their tallies, counted and shown apart. */
  quarantined: { quarantine: Quarantine; tally: TaskTally }[]
  quarantinedCount: number
}

/**
 * Separates quarantined tasks from the estimated ones without dropping any:
 * every input tally lands in exactly one of the two lists. A quarantine naming
 * a task with no tally is refused, so a quarantine cannot hide a task.
 */
export function separateQuarantined(
  tallies: readonly TaskTally[],
  quarantines: readonly Quarantine[]
): Estimate<QuarantineSplit> {
  const bad = checkTallies(tallies)
  if (bad !== null) return { ok: false, refusal: bad }
  const byId = new Map(tallies.map((t) => [t.taskId, t]))
  const quarantinedIds = new Set<string>()
  const quarantined: QuarantineSplit['quarantined'] = []
  for (const q of quarantines) {
    const t = byId.get(q.taskId)
    if (t === undefined)
      return refused('quarantine_unknown_task', `quarantine names task ${q.taskId}, which has no tally`)
    if (quarantinedIds.has(q.taskId)) return refused('duplicate_task', `task ${q.taskId} is quarantined more than once`)
    quarantinedIds.add(q.taskId)
    quarantined.push({ quarantine: q, tally: t })
  }
  return {
    ok: true,
    value: {
      estimated: tallies.filter((t) => !quarantinedIds.has(t.taskId)),
      quarantined,
      quarantinedCount: quarantined.length
    }
  }
}
