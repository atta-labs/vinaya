/**
 * Questions 8, 9 and 10, and the confidence comparison
 * (`apps/cli/specs/log-sync.md`, "The questions") — four queries about how,
 * and under what conditions, a unit of work converges. Each reads the
 * review loop's own records rather than inventing a signal the Log never
 * states. This file starts with `recurringFindings` (q8), which reads a
 * finding's recurrence from the loop's own `findings_compared` comparison
 * between rounds, never from a finding's identifier alone — an identifier
 * is stable only inside one round's report (`schema.ts`, the finding
 * schema).
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, DatasetRow, Measured } from '../sync'
import {
  buildCoverage,
  compareText,
  groupBy,
  numberField,
  objectArrayField,
  rowsOfKinds,
  stringArrayField,
  textOf,
  trustedRows
} from './common'
import type { Coverage, UnknownFigure } from './common'

const LOOP_KINDS = ['dev_review_loop']

// ---------------------------------------------------------------------------
// Question 8 — which findings recur?

export type RecurringFinding = {
  unit: string
  round: number
  id: string
  /** The severity `verdicts_read` recorded for this finding at this round. Unknown when that round's `verdicts_read` names no such finding. */
  severity: Measured<string>
  /** The `policy_treatment` recorded alongside it, the same way. A finding carries only a severity and a treatment — any other class reads unknown rather than being invented. */
  treatment: Measured<string>
}

export type RecurringFindingsAnswer = {
  /** Ascending by unit, then round, then id. */
  findings: RecurringFinding[]
  coverage: Coverage
}

/** The findings `verdicts_read` recorded for this unit's rows at `round`, or `[]` when no such line exists. */
function findingsReadAt(unitRows: readonly DatasetRow[], round: number) {
  const row = unitRows.find((r) => r.event === 'verdicts_read' && numberField(r, 'round') === round)
  return row === undefined ? [] : objectArrayField(row, 'findings')
}

/** Question 8: the finding identities the loop's own round comparison named recurring, with the severity and treatment that round's verdicts read for them. */
export function recurringFindings(dataset: Dataset): RecurringFindingsAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, LOOP_KINDS)
  const unknowns: UnknownFigure[] = []

  const findings: RecurringFinding[] = []
  for (const [unit, unitRows] of groupBy(used.withUnit, (row) => row.workRef)) {
    for (const comparison of unitRows.filter((row) => row.event === 'findings_compared')) {
      const round = numberField(comparison, 'round')
      if (round === null) continue
      const recurring = stringArrayField(comparison, 'recurring')
      if (recurring.length === 0) continue
      const readFindings = findingsReadAt(unitRows, round)
      for (const id of recurring) {
        const entry = readFindings.find((f) => textOf(f, 'id') === id)
        let severity: Measured<string>
        let treatment: Measured<string>
        if (entry === undefined) {
          const reason = `round ${round}'s verdicts_read of unit ${unit} names no finding ${id}`
          severity = unknownBecause(reason)
          treatment = unknownBecause(reason)
        } else {
          const severityValue = textOf(entry, 'severity')
          const treatmentValue = textOf(entry, 'policy_treatment')
          severity =
            severityValue === null
              ? unknownBecause(`finding ${id} at round ${round} of unit ${unit} states no severity`)
              : known(severityValue)
          treatment =
            treatmentValue === null
              ? unknownBecause(`finding ${id} at round ${round} of unit ${unit} states no policy treatment`)
              : known(treatmentValue)
        }
        if (!severity.known) unknowns.push({ figure: `${unit}.${round}.${id}.severity`, reason: severity.reason })
        if (!treatment.known) unknowns.push({ figure: `${unit}.${round}.${id}.treatment`, reason: treatment.reason })
        findings.push({ unit, round, id, severity, treatment })
      }
    }
  }
  findings.sort((a, b) => compareText(a.unit, b.unit) || a.round - b.round || compareText(a.id, b.id))

  return { findings, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
