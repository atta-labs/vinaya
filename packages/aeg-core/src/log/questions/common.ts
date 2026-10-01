/**
 * What every question over the Vinaya Log shares (`apps/cli/specs/log-sync.md`,
 * "The questions"): the rows a question may read, the coverage every answer
 * states, and small readers over a row's untyped family body. A question is a
 * pure function over a `Dataset` — no I/O, no clock — and picks its rows by
 * comparing `kind` and `event` as text, never by switching over the families.
 */

import type { Dataset, DatasetRow, JsonObject } from '../sync'

/** One figure an answer could not compute, and why. */
export type UnknownFigure = { figure: string; reason: string }

/**
 * What an answer read, so a reader can judge how far to trust it. Low-trust
 * rows are left out of every figure and counted here; a gap or a quarantined
 * line means the dataset itself is incomplete, so both are counted too.
 */
export type Coverage = {
  /** Every row the dataset holds. */
  rowsRead: number
  /** Rows written by a CLI older than the low-trust threshold, left out of every figure. */
  lowTrustLeftOut: number
  /** Trusted rows of the kinds the question reads whose unit of work is unknown, left out of every unit figure. */
  unitUnknown: number
  /** Trusted rows of the kinds the question reads, with a known unit — the rows the figures are built from. */
  rowsUsed: number
  /** Gaps the dataset records: stretches of history no figure here can cover. */
  gaps: number
  /** Lines the dataset quarantined: they produced no row. */
  quarantined: number
  /** Every figure the answer could not compute, with the reason. */
  unknowns: readonly UnknownFigure[]
}

/** The rows a question may read: the dataset's rows without the low-trust ones, which are counted. */
export function trustedRows(dataset: Dataset): { rows: DatasetRow[]; lowTrust: number } {
  const all = dataset.rows()
  const rows = all.filter((row) => row.trust !== 'low')
  return { rows, lowTrust: all.length - rows.length }
}

/** The unit of work a row belongs to: its work reference, or `null` when the line never recorded one. */
export function unitOf(row: DatasetRow): string | null {
  return row.workRef
}

/** Splits trusted rows of the wanted kinds into those with a known unit and the count without one. */
export function rowsOfKinds(
  rows: readonly DatasetRow[],
  kinds: readonly string[]
): { withUnit: Array<DatasetRow & { workRef: string }>; unitUnknown: number } {
  const withUnit: Array<DatasetRow & { workRef: string }> = []
  let unitUnknown = 0
  for (const row of rows) {
    if (!kinds.includes(row.kind)) continue
    if (row.workRef === null) unitUnknown++
    else withUnit.push({ ...row, workRef: row.workRef })
  }
  return { withUnit, unitUnknown }
}

export function buildCoverage(
  dataset: Dataset,
  lowTrust: number,
  used: { withUnit: readonly DatasetRow[]; unitUnknown: number },
  unknowns: readonly UnknownFigure[]
): Coverage {
  return {
    rowsRead: dataset.rows().length,
    lowTrustLeftOut: lowTrust,
    unitUnknown: used.unitUnknown,
    rowsUsed: used.withUnit.length,
    gaps: dataset.gaps().length,
    quarantined: dataset.quarantined().length,
    unknowns
  }
}

/** A string field of the row's family body, or `null` when absent or not a string. */
export function textField(row: DatasetRow, key: string): string | null {
  const value: unknown = row.payload[key]
  return typeof value === 'string' ? value : null
}

/** A finite number field of the row's family body, or `null` when absent, null or not a number. */
export function numberField(row: DatasetRow, key: string): number | null {
  const value: unknown = row.payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** An object field of the row's family body, or `null` when absent, null or not an object. */
export function objectField(row: DatasetRow, key: string): JsonObject | null {
  const value: unknown = row.payload[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Groups items by a key, keeping first-seen order inside each group. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const group = groups.get(k)
    if (group) group.push(item)
    else groups.set(k, [item])
  }
  return groups
}
