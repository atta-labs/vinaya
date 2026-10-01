/**
 * Question 6 — which check catches most? (`apps/cli/specs/log-sync.md`,
 * "The questions".) For each check named by a `gate` `checked` line, its
 * failures and the correction time from each failure to the next `pass` of
 * that same check for the same unit of work; across the whole dataset, the
 * checks run, passed and skipped a `gate` `summary` line states. A false
 * rejection is counted only from a supplied `HumanLabel` of kind
 * `'false_rejection'` naming a unit this check failed for — never guessed
 * from a failure alone, since a gate rejection is not automatically a
 * prevented bug, and its opposite is not automatically a sound one either.
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, DatasetRow, Measured } from '../sync'
import type { Coverage, UnknownFigure } from './common'
import { buildCoverage, compareText, groupBy, numberField, rowsOfKinds, textField, trustedRows } from './common'
import { NO_LABELS_REASON, type HumanLabel } from './labels'

const CHECKS_KINDS = ['gate']

export type CheckOutcome = {
  check: string
  failures: number
  /** From each failure to the next `pass` of this check, for the same unit of work, ascending. Unknown when no failure of this check ever saw a later pass for its unit. */
  correctionTimesMs: Measured<number[]>
}

export type ChecksAnswer = {
  /** Ascending by check name. */
  checks: CheckOutcome[]
  /** Checks run, summed from every `gate` `summary` line's own count. */
  ran: number
  /** Checks passed, the same way. */
  passed: number
  /** Checks skipped, the same way. */
  skipped: number
  /** A `'false_rejection'` label naming a unit this check failed for, counted; unknown with `'no labels recorded'` when no label was supplied at all. */
  falseRejections: Measured<number>
  coverage: Coverage
}

type CheckedEvent = { time: number; unit: string; outcome: string | null }

function timeOf(row: DatasetRow): number {
  return Date.parse(row.time)
}

/**
 * The correction times from the first failure of a run to the next pass of
 * the same check, for one unit, ascending — and how many failures saw none.
 * A run of consecutive failures before a pass is one episode, corrected
 * once, from its first failure — a later failure in the same open episode
 * never restarts the clock or counts as its own uncorrected failure.
 */
function correctionsOf(events: readonly CheckedEvent[]): { times: number[]; uncorrected: number } {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  const times: number[] = []
  let uncorrected = 0
  let episodeStart: number | null = null
  let episodeFailures = 0
  for (const event of sorted) {
    if (event.outcome === 'fail') {
      if (episodeStart === null) episodeStart = event.time
      episodeFailures++
    } else if (event.outcome === 'pass' && episodeStart !== null) {
      times.push(event.time - episodeStart)
      episodeStart = null
      episodeFailures = 0
    }
  }
  if (episodeStart !== null) uncorrected += episodeFailures
  return { times: times.sort((a, b) => a - b), uncorrected }
}

/** Merges each unit's own corrections into one list for the check — an episode never crosses units. */
function correctionsAcrossUnits(events: readonly CheckedEvent[]): { times: number[]; uncorrected: number } {
  const times: number[] = []
  let uncorrected = 0
  for (const unitEvents of groupBy(events, (e) => e.unit).values()) {
    const result = correctionsOf(unitEvents)
    times.push(...result.times)
    uncorrected += result.uncorrected
  }
  return { times: times.sort((a, b) => a - b), uncorrected }
}

function outcomeOf(check: string, events: readonly CheckedEvent[], unknowns: UnknownFigure[]): CheckOutcome {
  const failures = events.filter((e) => e.outcome === 'fail').length
  const { times, uncorrected } = correctionsAcrossUnits(events)
  let correctionTimesMs: Measured<number[]>
  if (failures === 0) {
    correctionTimesMs = unknownBecause(`no failure of ${check} was recorded`)
  } else if (times.length === 0) {
    correctionTimesMs = unknownBecause(`no failure of ${check} was followed by a pass of the same unit`)
  } else {
    correctionTimesMs = known(times)
    if (uncorrected > 0)
      unknowns.push({
        figure: `${check}.correctionTimesMs`,
        reason: `${uncorrected} of ${failures} failures of ${check} were never followed by a pass of the same unit`
      })
  }
  if (!correctionTimesMs.known)
    unknowns.push({ figure: `${check}.correctionTimesMs`, reason: correctionTimesMs.reason })
  return { check, failures, correctionTimesMs }
}

/** Question 6: failures and correction time by check, and the summary totals across every check run. */
export function checkOutcomes(dataset: Dataset, labels: readonly HumanLabel[] = []): ChecksAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, CHECKS_KINDS)
  const unknowns: UnknownFigure[] = []

  const checkedRows = used.withUnit.filter((row) => row.event === 'checked')
  const summaryRows = used.withUnit.filter((row) => row.event === 'summary')

  const byCheck = groupBy(checkedRows, (row) => textField(row, 'check') ?? '')
  const checks = [...byCheck.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([check, group]) =>
      outcomeOf(
        check,
        group.map((row) => ({ time: timeOf(row), unit: row.workRef as string, outcome: textField(row, 'outcome') })),
        unknowns
      )
    )

  const ran = summaryRows.reduce((sum, row) => sum + (numberField(row, 'ran') ?? 0), 0)
  const passed = summaryRows.reduce((sum, row) => sum + (numberField(row, 'passed') ?? 0), 0)
  const skipped = summaryRows.reduce((sum, row) => sum + (numberField(row, 'skipped') ?? 0), 0)

  const failedUnits = new Set<string>()
  for (const row of checkedRows) if (textField(row, 'outcome') === 'fail') failedUnits.add(row.workRef as string)

  let falseRejections: Measured<number>
  if (labels.length === 0) {
    falseRejections = unknownBecause(NO_LABELS_REASON)
    unknowns.push({ figure: 'falseRejections', reason: NO_LABELS_REASON })
  } else {
    falseRejections = known(
      labels.filter((label) => label.kind === 'false_rejection' && failedUnits.has(label.unit)).length
    )
  }

  return { checks, ran, passed, skipped, falseRejections, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
