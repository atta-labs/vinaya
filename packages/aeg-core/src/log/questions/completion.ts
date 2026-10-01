/**
 * Question 1 — does a cheaper model finish? (`apps/cli/specs/log-sync.md`,
 * "The questions".) For each model, the units of work it was part of and how
 * they ended. The answer is descriptive: it counts what the loop recorded and
 * never says one model caused a better outcome.
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, DatasetRow, Measured } from '../sync'
import type { Coverage, UnknownFigure } from './common'
import { buildCoverage, compareText, groupBy, numberField, rowsOfKinds, textField, trustedRows } from './common'

/** How many units of work reached green in a given number of rounds. */
export type RoundsToGreen = { rounds: number; units: number }

export type ModelCompletion = {
  model: string
  /** Units of work in which a dispatch or role attempt names this model. A unit that used two models counts under both. */
  started: number
  /** Of those, units whose loop recorded the green stop condition. */
  green: number
  /** Of those, units whose loop paused at least once. A unit can be both paused and green. */
  paused: number
  /** Of those, units whose loop recorded the escalated stop condition. */
  escalated: number
  /** The round each green unit went green in, counted, ascending by rounds. */
  roundsToGreen: RoundsToGreen[]
  /** The loop's own time to green for each green unit that recorded one, ascending. Unknown when no green unit did. */
  timeToGreenMs: Measured<number[]>
}

export type CompletionAnswer = {
  /** Ascending by model name. */
  models: ModelCompletion[]
  coverage: Coverage
}

const KINDS = ['dispatch', 'role_attempt', 'dev_review_loop']

type UnitFacts = {
  models: Set<string>
  greenRound: number | null
  green: boolean
  paused: boolean
  escalated: boolean
  timeToGreenMs: number | null
}

function factsOf(rows: readonly DatasetRow[]): UnitFacts {
  const facts: UnitFacts = {
    models: new Set(),
    green: false,
    greenRound: null,
    paused: false,
    escalated: false,
    timeToGreenMs: null
  }
  for (const row of rows) {
    if (row.kind === 'dispatch' || row.kind === 'role_attempt') {
      const model = textField(row, 'model')
      if (model !== null) facts.models.add(model)
    } else if (row.kind === 'dev_review_loop') {
      if (row.event === 'stop_condition_met') {
        const condition = textField(row, 'condition')
        if (condition === 'green') {
          facts.green = true
          facts.greenRound = numberField(row, 'round')
        }
        if (condition === 'escalated') facts.escalated = true
      } else if (row.event === 'paused') {
        facts.paused = true
      } else if (row.event === 'journal_finalized') {
        // The last journal stands: a loop resumed after a pause finalizes again.
        facts.timeToGreenMs = numberField(row, 'time_to_green_ms')
      }
    }
  }
  return facts
}

/** Question 1: completion, rounds to green and time to green, by model. */
export function completionByModel(dataset: Dataset): CompletionAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, KINDS)
  const unknowns: UnknownFigure[] = []

  const perModel = new Map<string, { started: number; units: UnitFacts[] }>()
  for (const [unit, unitRows] of groupBy(used.withUnit, (row) => row.workRef)) {
    const facts = factsOf(unitRows)
    if (facts.models.size === 0) {
      unknowns.push({ figure: `unit ${unit}`, reason: 'no dispatch or role attempt of this unit names a model' })
      continue
    }
    for (const model of facts.models) {
      const entry = perModel.get(model) ?? { started: 0, units: [] }
      entry.started++
      entry.units.push(facts)
      perModel.set(model, entry)
    }
  }

  const models: ModelCompletion[] = [...perModel.keys()].sort(compareText).map((model) => {
    const { started, units } = perModel.get(model) as { started: number; units: UnitFacts[] }
    const greens = units.filter((u) => u.green)
    const rounds = new Map<number, number>()
    for (const u of greens) if (u.greenRound !== null) rounds.set(u.greenRound, (rounds.get(u.greenRound) ?? 0) + 1)
    const samples = greens.flatMap((u) => (u.timeToGreenMs === null ? [] : [u.timeToGreenMs])).sort((a, b) => a - b)

    let timeToGreenMs: Measured<number[]>
    if (greens.length === 0) {
      timeToGreenMs = unknownBecause('no unit of work finished green')
    } else if (samples.length === 0) {
      timeToGreenMs = unknownBecause('no green unit recorded a time to green')
    } else {
      timeToGreenMs = known(samples)
      if (samples.length < greens.length) {
        unknowns.push({
          figure: `${model}.timeToGreenMs`,
          reason: `${greens.length - samples.length} of ${greens.length} green units recorded no time to green`
        })
      }
    }
    if (!timeToGreenMs.known) unknowns.push({ figure: `${model}.timeToGreenMs`, reason: timeToGreenMs.reason })

    return {
      model,
      started,
      green: greens.length,
      paused: units.filter((u) => u.paused).length,
      escalated: units.filter((u) => u.escalated).length,
      roundsToGreen: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => ({ rounds: r, units: n })),
      timeToGreenMs
    }
  })

  return { models, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
