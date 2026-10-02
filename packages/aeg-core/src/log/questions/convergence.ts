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
 * - `changeSizeBands` (q10) bands the converging round's own files changed,
 *   reporting a band under the sample floor as insufficient rather than as
 *   a figure.
 * - `confidenceVsOutcome` (the confidence comparison) reads the developer's
 *   stated confidence from the second round on, beside whether that round's
 *   reviewers approved — round one is never asked and never appears.
 *
 * None of the four scores a choice as having caused an outcome; each
 * reports what the loop recorded.
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, DatasetRow, Measured } from '../sync'
import type { RoundsToGreen } from './completion'
import {
  booleanField,
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

// ---------------------------------------------------------------------------
// Question 10 — what change size converges?

/** The fixed size bands (Decisions, reversible): files changed at most 3, 4 to 10, or 11 or more. */
export type ChangeSizeBand = 'at most 3' | '4 to 10' | '11 or more'

const CHANGE_SIZE_BANDS: readonly ChangeSizeBand[] = ['at most 3', '4 to 10', '11 or more']
/** Five units is the floor for a figure (Decisions, reversible). */
const SIZE_BAND_FLOOR = 5

function bandOf(filesChanged: number): ChangeSizeBand {
  if (filesChanged <= 3) return 'at most 3'
  if (filesChanged <= 10) return '4 to 10'
  return '11 or more'
}

export type SizeBandOutcome =
  | { band: ChangeSizeBand; units: number; sample: 'insufficient' }
  | {
      band: ChangeSizeBand
      units: number
      sample: 'sufficient'
      /** The converging round's own insertions, ascending, one per unit in the band. */
      insertions: number[]
      /** The converging round's own deletions, the same way. */
      deletions: number[]
      roundsToGreen: RoundsToGreen[]
      timeToGreenMs: Measured<number[]>
    }

export type ChangeSizeAnswer = {
  /** All three bands, fixed, ascending — `'insufficient'` where the sample is too thin for a figure, never silently dropped. */
  bands: SizeBandOutcome[]
  coverage: Coverage
}

type GreenUnit = {
  round: number
  filesChanged: number
  insertions: number
  deletions: number
  timeToGreenMs: number | null
}

/** This unit's converging round — the `round_ended` line whose own round is the one `stop_condition_met` named green — or `null` when the unit never went green or that round's size was never stated. */
function greenUnitOf(unitRows: readonly DatasetRow[]): GreenUnit | null {
  const stop = unitRows.find((r) => r.event === 'stop_condition_met' && textField(r, 'condition') === 'green')
  if (stop === undefined) return null
  const round = numberField(stop, 'round')
  if (round === null) return null
  const roundEnded = unitRows.find(
    (r) => r.event === 'round_ended' && numberField(r, 'round') === round && textField(r, 'outcome') === 'green'
  )
  if (roundEnded === undefined) return null
  const filesChanged = numberField(roundEnded, 'files_changed')
  const insertions = numberField(roundEnded, 'insertions')
  const deletions = numberField(roundEnded, 'deletions')
  if (filesChanged === null || insertions === null || deletions === null) return null
  const finalized = unitRows.find((r) => r.event === 'journal_finalized')
  const timeToGreenMs = finalized === undefined ? null : numberField(finalized, 'time_to_green_ms')
  return { round, filesChanged, insertions, deletions, timeToGreenMs }
}

/** Question 10: the converging round's own change size, banded, against the rounds and time it took to get there. */
export function changeSizeBands(dataset: Dataset): ChangeSizeAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, LOOP_KINDS)
  const unknowns: UnknownFigure[] = []

  const greenUnits: GreenUnit[] = []
  for (const [, unitRows] of groupBy(used.withUnit, (row) => row.workRef)) {
    const greenUnit = greenUnitOf(unitRows)
    if (greenUnit !== null) greenUnits.push(greenUnit)
  }

  const bands: SizeBandOutcome[] = CHANGE_SIZE_BANDS.map((band) => {
    const members = greenUnits.filter((u) => bandOf(u.filesChanged) === band)
    if (members.length < SIZE_BAND_FLOOR) {
      if (members.length > 0)
        unknowns.push({
          figure: band,
          reason: `only ${members.length} unit(s) converged in this band, fewer than the ${SIZE_BAND_FLOOR}-unit floor for a figure`
        })
      return { band, units: members.length, sample: 'insufficient' as const }
    }

    const rounds = new Map<number, number>()
    for (const m of members) rounds.set(m.round, (rounds.get(m.round) ?? 0) + 1)
    const times = members.flatMap((m) => (m.timeToGreenMs === null ? [] : [m.timeToGreenMs])).sort((a, b) => a - b)

    let timeToGreenMs: Measured<number[]>
    if (times.length === 0) {
      timeToGreenMs = unknownBecause('no unit in this band recorded a time to green')
    } else {
      timeToGreenMs = known(times)
      if (times.length < members.length)
        unknowns.push({
          figure: `${band}.timeToGreenMs`,
          reason: `${members.length - times.length} of ${members.length} units in this band recorded no time to green`
        })
    }
    if (!timeToGreenMs.known) unknowns.push({ figure: `${band}.timeToGreenMs`, reason: timeToGreenMs.reason })

    return {
      band,
      units: members.length,
      sample: 'sufficient' as const,
      insertions: members.map((m) => m.insertions).sort((a, b) => a - b),
      deletions: members.map((m) => m.deletions).sort((a, b) => a - b),
      roundsToGreen: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => ({ rounds: r, units: n })),
      timeToGreenMs
    }
  })

  return { bands, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}

// ---------------------------------------------------------------------------
// The confidence comparison — does stated confidence predict review outcome?

const MIN_CONFIDENCE_ROUND = 2
const CONFIDENCE_UNAVAILABLE_REASON = "the developer's confidence was recorded unavailable"
const NO_CONFIDENCE_REASON = 'no confidence was stated this round'

export type ConfidenceOutcome = {
  unit: string
  round: number
  /** The confidence as first stated this round. Unknown when missing or explicitly recorded unavailable. */
  confidenceValue: Measured<number>
  /** Whether the confidence rule's one extra developer turn was spent before this statement. Unknown the same way. */
  extraTurnSpent: Measured<boolean>
  /** Whether this round's reviewers approved. Unknown when this round recorded no verdicts at all. */
  approved: Measured<boolean>
}

export type ConfidenceAnswer = {
  /** Ascending by unit, then round. Round 1 is never asked, so it never appears. */
  rounds: ConfidenceOutcome[]
  coverage: Coverage
}

function confidenceOf(row: DatasetRow): { value: Measured<number>; extraTurnSpent: Measured<boolean> } {
  const value = numberField(row, 'confidence_value')
  const unavailable = booleanField(row, 'confidence_unavailable') === true
  const extraTurnSpent = booleanField(row, 'extra_turn_spent')
  return {
    value:
      value !== null
        ? known(value)
        : unknownBecause(unavailable ? CONFIDENCE_UNAVAILABLE_REASON : NO_CONFIDENCE_REASON),
    extraTurnSpent: extraTurnSpent !== null ? known(extraTurnSpent) : unknownBecause(NO_CONFIDENCE_REASON)
  }
}

/** The confidence comparison: stated confidence against review outcome, by round, from the second round on. */
export function confidenceVsOutcome(dataset: Dataset): ConfidenceAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, LOOP_KINDS)
  const unknowns: UnknownFigure[] = []

  const rounds: ConfidenceOutcome[] = []
  for (const [unit, unitRows] of groupBy(used.withUnit, (row) => row.workRef)) {
    const gateReads = unitRows.filter(
      (row) => row.event === 'gate_result_read' && (numberField(row, 'round') ?? 0) >= MIN_CONFIDENCE_ROUND
    )
    for (const gateRead of gateReads) {
      const round = numberField(gateRead, 'round') as number
      const { value, extraTurnSpent } = confidenceOf(gateRead)
      const verdictsRead = unitRows.find((row) => row.event === 'verdicts_read' && numberField(row, 'round') === round)
      const approved: Measured<boolean> =
        verdictsRead === undefined
          ? unknownBecause(`no verdicts_read recorded for round ${round} of unit ${unit}`)
          : (() => {
              const allApprove = booleanField(verdictsRead, 'all_approve')
              return allApprove === null
                ? unknownBecause(`round ${round}'s verdicts_read of unit ${unit} states no all_approve`)
                : known(allApprove)
            })()

      if (!value.known) unknowns.push({ figure: `${unit}.${round}.confidenceValue`, reason: value.reason })
      if (!extraTurnSpent.known)
        unknowns.push({ figure: `${unit}.${round}.extraTurnSpent`, reason: extraTurnSpent.reason })
      if (!approved.known) unknowns.push({ figure: `${unit}.${round}.approved`, reason: approved.reason })
      rounds.push({ unit, round, confidenceValue: value, extraTurnSpent, approved })
    }
  }
  rounds.sort((a, b) => compareText(a.unit, b.unit) || a.round - b.round)

  return { rounds, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
