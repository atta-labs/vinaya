/**
 * Questions 8, 9 and 10, and the confidence comparison
 * (`apps/cli/specs/log-sync.md`, "The questions") — four queries about how,
 * and under what conditions, a unit of work converges. Each reads the
 * review loop's own records rather than inventing a signal the Log never
 * states.
 *
 * - `recurringFindings` (q8) reads a finding's recurrence from the loop's
 *   own `findings_compared` comparison between rounds, never from a
 *   finding's identifier alone — an identifier is stable only inside one
 *   round's report (`schema.ts`, the finding schema).
 * - `outcomesByInstructionVersion` (q9) groups by the doctrine a line's own
 *   header names, reporting outcomes beside it — never a cause.
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, DatasetRow, Measured } from '../sync'
import type { RoundsToGreen } from './completion'
import {
  buildCoverage,
  compareText,
  groupBy,
  numberField,
  objectArrayField,
  objectField,
  rowsOfKinds,
  stringArrayField,
  textField,
  textOf,
  trustedRows
} from './common'
import type { Coverage, UnknownFigure } from './common'

const LOOP_KINDS = ['dev_review_loop']
const LOOP_AND_DISPATCH_KINDS = ['dev_review_loop', 'dispatch']

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

// ---------------------------------------------------------------------------
// Question 9 — is the instruction version the problem?

export type VersionOutcome = {
  /** The doctrine a unit's own lines name. */
  version: string
  /** The way-of-working versions (`flowVersion`) at least one of this version's units names, ascending; `[]` when none named one. */
  flowVersions: string[]
  /** The units of work behind this figure. */
  units: number
  /** Of those, units whose loop recorded the escalated stop condition. */
  escalated: number
  /** The round each green unit went green in, counted, ascending by rounds. */
  roundsToGreen: RoundsToGreen[]
  /** Objectives a recorded verdict marked unmet, summed across this version's units; unknown when none of them ever recorded a verdict at all. */
  unmetObjectives: Measured<number>
}

export type OutcomesByVersionAnswer = {
  /** Ascending by version. */
  versions: VersionOutcome[]
  coverage: Coverage
}

type VersionUnitFacts = {
  versions: Set<string>
  flowVersions: Set<string>
  greenRound: number | null
  escalated: boolean
  /** One entry per recorded verdict, each the `met` flags its objectives stated. */
  verdictObjectives: boolean[][]
}

function versionFactsOf(rows: readonly DatasetRow[]): VersionUnitFacts {
  const facts: VersionUnitFacts = {
    versions: new Set(),
    flowVersions: new Set(),
    greenRound: null,
    escalated: false,
    verdictObjectives: []
  }
  for (const row of rows) {
    facts.versions.add(row.doctrine)
    if (row.flowVersion !== null) facts.flowVersions.add(row.flowVersion)
    if (row.kind === 'dev_review_loop' && row.event === 'stop_condition_met') {
      const condition = textField(row, 'condition')
      if (condition === 'green') facts.greenRound = numberField(row, 'round')
      if (condition === 'escalated') facts.escalated = true
    } else if (row.kind === 'dispatch' && row.event === 'outcome_received') {
      const outcome = objectField(row, 'outcome')
      if (outcome !== null && outcome.type === 'verdict') {
        const objectives = Array.isArray(outcome.objectives) ? outcome.objectives : []
        facts.verdictObjectives.push(
          objectives
            .filter(
              (o): o is { met: boolean } =>
                typeof o === 'object' && o !== null && typeof (o as { met?: unknown }).met === 'boolean'
            )
            .map((o) => o.met)
        )
      }
    }
  }
  return facts
}

/** Question 9: outcomes, by the instruction version a unit's own lines name. */
export function outcomesByInstructionVersion(dataset: Dataset): OutcomesByVersionAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, LOOP_AND_DISPATCH_KINDS)
  const unknowns: UnknownFigure[] = []

  const perVersion = new Map<string, VersionUnitFacts[]>()
  for (const [, unitRows] of groupBy(used.withUnit, (row) => row.workRef)) {
    const facts = versionFactsOf(unitRows)
    for (const version of facts.versions) {
      const group = perVersion.get(version) ?? []
      group.push(facts)
      perVersion.set(version, group)
    }
  }

  const versions: VersionOutcome[] = [...perVersion.keys()].sort(compareText).map((version) => {
    const group = perVersion.get(version) as VersionUnitFacts[]
    const flowVersions = new Set<string>()
    for (const facts of group) for (const flowVersion of facts.flowVersions) flowVersions.add(flowVersion)

    const greens = group.filter((f) => f.greenRound !== null)
    const rounds = new Map<number, number>()
    for (const f of greens) rounds.set(f.greenRound as number, (rounds.get(f.greenRound as number) ?? 0) + 1)

    const verdicts = group.flatMap((f) => f.verdictObjectives)
    let unmetObjectives: Measured<number>
    if (verdicts.length === 0) {
      const reason = `no verdict was recorded for version ${version}'s units`
      unmetObjectives = unknownBecause(reason)
      unknowns.push({ figure: `${version}.unmetObjectives`, reason })
    } else {
      unmetObjectives = known(verdicts.reduce((sum, objectives) => sum + objectives.filter((met) => !met).length, 0))
    }

    return {
      version,
      flowVersions: [...flowVersions].sort(compareText),
      units: group.length,
      escalated: group.filter((f) => f.escalated).length,
      roundsToGreen: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => ({ rounds: r, units: n })),
      unmetObjectives
    }
  })

  return { versions, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
