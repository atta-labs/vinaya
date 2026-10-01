/**
 * Question 3 — what does a unit of work cost? (`apps/cli/specs/log-sync.md`,
 * "The questions".) Usage by unit of work and by role, retries and failed
 * attempts included. A cumulative observation is a running total, so only the
 * last one per run and model stands for it; delta observations are additions;
 * the two are never added to each other. A figure any contributing
 * observation does not state is unknown, never zero.
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, DatasetRow, Measured } from '../sync'
import type { Coverage, UnknownFigure } from './common'
import { buildCoverage, compareText, groupBy, objectField, rowsOfKinds, textField, trustedRows } from './common'

export type UsageTotals = {
  input: Measured<number>
  output: Measured<number>
  cache: Measured<number>
}

export type RoleUsage = UsageTotals & {
  role: string
  /** The usage figures counted into the totals: one per delta observation, one per run and model for cumulative ones, one per attempt. */
  observations: number
}

export type UnitUsage = UsageTotals & {
  unit: string
  observations: number
  /** Ascending by role. */
  roles: RoleUsage[]
}

export type UsageAnswer = {
  /** Ascending by unit. */
  units: UnitUsage[]
  /** The same totals by role across every unit, ascending by role. */
  roles: RoleUsage[]
  coverage: Coverage
}

const KINDS = ['usage', 'dispatch', 'role_attempt']
const FIELDS = ['input', 'output', 'cache'] as const
type Field = (typeof FIELDS)[number]

/** One usage figure that stands in the totals: a number per unit, or `null` where the record states none. */
type Term = { unit: string; role: string } & Record<Field, number | null>

function amount(units: Record<string, unknown> | null, field: Field): number | null {
  const value = units?.[field]
  return typeof value === 'number' ? value : null
}

function termOf(unit: string, role: string, units: Record<string, unknown> | null): Term {
  return { unit, role, input: amount(units, 'input'), output: amount(units, 'output'), cache: amount(units, 'cache') }
}

function isKnown(term: Term): boolean {
  return FIELDS.some((field) => term[field] !== null)
}

/** The terms the dataset's usage records stand for, in the order they were first seen. */
function termsOf(rows: readonly DatasetRow[]): Term[] {
  const terms = new Map<string, Term>()
  let deltas = 0
  for (const row of rows) {
    const unit = row.workRef as string
    if (row.kind === 'usage' && row.event === 'observed') {
      const term = termOf(unit, row.role, objectField(row, 'units'))
      if (textField(row, 'semantics') === 'cumulative') {
        // A running total: the last observation per run and model stands for all of them.
        const key = JSON.stringify(['cumulative', unit, row.role, row.runId, textField(row, 'model')])
        terms.delete(key)
        terms.set(key, term)
      } else {
        terms.set(JSON.stringify(['delta', deltas++]), term)
      }
    } else if (
      (row.kind === 'dispatch' && (row.event === 'outcome_received' || row.event === 'dispatch_failed')) ||
      (row.kind === 'role_attempt' && row.event === 'attempted')
    ) {
      // A dispatch and the role attempt it ran share an effect id: one attempt is one figure, taken from whichever line states it.
      // Neither record carries a cache count, so a cache figure that is not stated stays unknown.
      const role = row.kind === 'dispatch' ? (textField(row, 'target_role') ?? row.role) : row.role
      const term = termOf(unit, role, objectField(row, 'usage'))
      const key = JSON.stringify(['attempt', unit, textField(row, 'effect_id') ?? row.identity])
      const held = terms.get(key)
      if (held === undefined || (!isKnown(held) && isKnown(term))) terms.set(key, term)
    }
  }
  return [...terms.values()]
}

function totalOf(terms: readonly Term[], field: Field): Measured<number> {
  const missing = terms.filter((term) => term[field] === null).length
  if (missing > 0) return unknownBecause(`${missing} of ${terms.length} observations record no ${field}`)
  return known(terms.reduce((sum, term) => sum + (term[field] as number), 0))
}

function totalsOf(terms: readonly Term[]): UsageTotals {
  return { input: totalOf(terms, 'input'), output: totalOf(terms, 'output'), cache: totalOf(terms, 'cache') }
}

function noteUnknowns(unknowns: UnknownFigure[], name: string, totals: UsageTotals): void {
  for (const field of FIELDS) {
    const total = totals[field]
    if (!total.known) unknowns.push({ figure: `${name}.${field}`, reason: total.reason })
  }
}

function byRole(terms: readonly Term[], name: (role: string) => string, unknowns: UnknownFigure[]): RoleUsage[] {
  return [...groupBy(terms, (term) => term.role)]
    .sort(([a], [b]) => compareText(a, b))
    .map(([role, group]) => {
      const totals = totalsOf(group)
      noteUnknowns(unknowns, name(role), totals)
      return { role, observations: group.length, ...totals }
    })
}

/** Question 3: usage by unit of work and by role. */
export function usageByUnitAndRole(dataset: Dataset): UsageAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, KINDS)
  const terms = termsOf(used.withUnit)
  const unknowns: UnknownFigure[] = []

  const units = [...groupBy(terms, (term) => term.unit)]
    .sort(([a], [b]) => compareText(a, b))
    .map(([unit, group]): UnitUsage => {
      const roles = byRole(group, (role) => `unit ${unit} ${role}`, unknowns)
      const totals = totalsOf(group)
      noteUnknowns(unknowns, `unit ${unit}`, totals)
      return { unit, observations: group.length, ...totals, roles }
    })

  const roles = byRole(terms, (role) => `role ${role}`, unknowns)
  return { units, roles, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
