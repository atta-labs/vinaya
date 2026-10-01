/**
 * Question 4 — where does the time go? (`apps/cli/specs/log-sync.md`, "The
 * questions".) For each unit of work, the time spent developing, reviewing,
 * checking and waiting. Work overlaps, so each duration is reported twice:
 * summed over every interval, and as the length of the union of the intervals
 * — the time that passed on the clock.
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, DatasetRow, Measured } from '../sync'
import type { Coverage, UnknownFigure } from './common'
import { buildCoverage, compareText, groupBy, numberField, rowsOfKinds, textField, trustedRows } from './common'

export type Span = {
  /** The length of every interval added together. Concurrent work counts once per interval. */
  summedMs: number
  /** The length of the union of the intervals: time on the clock, overlap counted once. */
  elapsedMs: number
  /** Intervals that are in `summedMs` and `elapsedMs`. */
  intervals: number
  /** Intervals that never ended or carried no duration, so they are in neither figure. */
  incomplete: number
}

export type UnitTime = {
  unit: string
  /** A developer dispatch, from its `dispatched` line to the line that ended it. */
  develop: Measured<Span>
  /** A code-reviewer or security dispatch, the same way. */
  review: Measured<Span>
  /** A check run: the run's own total time, ending at the run's `summary` line. */
  check: Measured<Span>
  /** A pause, from the line that paused the loop to the line that resumed or cancelled it. */
  wait: Measured<Span>
}

export type TimeAnswer = {
  /** Ascending by unit. */
  units: UnitTime[]
  coverage: Coverage
}

const TIME_KINDS = ['dispatch', 'gate', 'dev_review_loop']
const CATEGORIES = ['develop', 'review', 'check', 'wait'] as const
type Category = (typeof CATEGORIES)[number]

type Interval = { start: number; end: number }
type Intervals = { done: Interval[]; incomplete: number }

const REVIEWERS = ['code-reviewer', 'security']
/** Why a category has no figure: nothing recorded, or only intervals that cannot be measured. */
const NOTHING: Record<Category, string> = {
  develop: 'no developer dispatch recorded for this unit',
  review: 'no reviewer dispatch recorded for this unit',
  check: 'no check run recorded a duration for this unit',
  wait: 'no pause recorded for this unit'
}
const UNMEASURABLE: Record<Category, (n: number) => string> = {
  develop: (n) => `${n} developer dispatch${n === 1 ? ' has' : 'es have'} no outcome line`,
  review: (n) => `${n} reviewer dispatch${n === 1 ? ' has' : 'es have'} no outcome line`,
  check: (n) => `${n} check run${n === 1 ? ' records' : 's record'} no duration`,
  wait: (n) => `${n} pause${n === 1 ? ' was' : 's were'} never resumed or cancelled`
}

function instant(row: DatasetRow): number {
  return Date.parse(row.time)
}

function categoryOfRole(role: string | null): Category | null {
  if (role === 'developer') return 'develop'
  if (role !== null && REVIEWERS.includes(role)) return 'review'
  return null
}

function intervalsOf(rows: readonly DatasetRow[]): Record<Category, Intervals> {
  const out: Record<Category, Intervals> = {
    develop: { done: [], incomplete: 0 },
    review: { done: [], incomplete: 0 },
    check: { done: [], incomplete: 0 },
    wait: { done: [], incomplete: 0 }
  }
  const open = new Map<string, { category: Category; start: number }>()
  let paused: number | null = null
  for (const row of rows) {
    const at = instant(row)
    if (row.kind === 'dispatch') {
      const effect = textField(row, 'effect_id') ?? row.identity
      if (row.event === 'dispatched') {
        const category = categoryOfRole(textField(row, 'target_role'))
        if (category !== null) open.set(effect, { category, start: at })
      } else if (row.event === 'outcome_received' || row.event === 'dispatch_failed') {
        const started = open.get(effect)
        if (started === undefined) {
          const category = categoryOfRole(textField(row, 'target_role'))
          if (category !== null) out[category].incomplete++
        } else {
          out[started.category].done.push({ start: started.start, end: at })
          open.delete(effect)
        }
      }
    } else if (row.kind === 'gate' && row.event === 'summary') {
      const duration = numberField(row, 'duration_ms')
      if (duration === null) out.check.incomplete++
      else out.check.done.push({ start: at - duration, end: at })
    } else if (row.kind === 'dev_review_loop') {
      if (row.event === 'paused') {
        if (paused === null) paused = at
      } else if ((row.event === 'resumed' || row.event === 'cancelled') && paused !== null) {
        out.wait.done.push({ start: paused, end: at })
        paused = null
      }
    }
  }
  for (const { category } of open.values()) out[category].incomplete++
  if (paused !== null) out.wait.incomplete++
  return out
}

/** The length of the union of the intervals: overlapping and touching stretches are counted once. */
function unionMs(intervals: readonly Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)
  let total = 0
  let reach: Interval | null = null
  for (const interval of sorted) {
    if (reach === null || interval.start > reach.end) {
      if (reach !== null) total += reach.end - reach.start
      reach = { ...interval }
    } else if (interval.end > reach.end) {
      reach.end = interval.end
    }
  }
  return reach === null ? total : total + (reach.end - reach.start)
}

function spanOf(category: Category, { done, incomplete }: Intervals): Measured<Span> {
  if (done.length === 0) return unknownBecause(incomplete > 0 ? UNMEASURABLE[category](incomplete) : NOTHING[category])
  return known({
    summedMs: done.reduce((sum, interval) => sum + (interval.end - interval.start), 0),
    elapsedMs: unionMs(done),
    intervals: done.length,
    incomplete
  })
}

/** Question 4: the develop, review, check and wait durations of each unit of work. */
export function timeByUnit(dataset: Dataset): TimeAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, TIME_KINDS)
  const unknowns: UnknownFigure[] = []

  const units = [...groupBy(used.withUnit, (row) => row.workRef)]
    .sort(([a], [b]) => compareText(a, b))
    .map(([unit, unitRows]): UnitTime => {
      const found = intervalsOf(unitRows)
      const measured = Object.fromEntries(CATEGORIES.map((c) => [c, spanOf(c, found[c])])) as Record<
        Category,
        Measured<Span>
      >
      for (const category of CATEGORIES) {
        const span = measured[category]
        if (!span.known) unknowns.push({ figure: `unit ${unit}.${category}`, reason: span.reason })
      }
      return { unit, ...measured }
    })

  return { units, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
