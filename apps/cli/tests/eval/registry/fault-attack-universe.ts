/**
 * The fault-and-attack universe, parsed from the repository mirror of the
 * evaluation program: one entry per row of the table under its "Fault and
 * attack coverage" heading, in table order. Nothing here lists a row; a row
 * that is not in the mirror's table is not in the universe.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVALUATION_LAYERS, type EvaluationLayer } from '../../../src/lib/dev-review-eval/contracts'

export const PROGRAM_DOCUMENT = 'apps/cli/specs/dev-review-evaluation-program.md'
export const PROGRAM_FILE = join(import.meta.dir, '../../../specs/dev-review-evaluation-program.md')
export const FAULT_ATTACK_HEADING = '13. Fault and attack coverage'

/** The table's two cutover outcomes, as the program defines them above the table. */
export const CUTOVER_OUTCOMES = { 'Must pass': 'must-pass', 'Pass or accepted': 'pass-or-accepted' } as const
export type CutoverOutcome = (typeof CUTOVER_OUTCOMES)[keyof typeof CUTOVER_OUTCOMES]

/** The statement every "must pass" row carries: no known-failure entry is admitted for it. */
export const MUST_PASS_STATEMENT = 'No known-failure entry is admitted for this row.'
/** The statement every "pass or accepted" row carries: a residual risk needs the Principal's explicit acceptance. */
export const RESIDUAL_RISK_STATEMENT =
  "A residual risk needs the Principal's explicit acceptance in the cutover authorization evidence (gate 17, §6.24)."

/** One table row, read into typed columns. */
export interface FaultAttackEntry {
  /** The row's position in the table, from 1. */
  order: number
  /** `<order, two digits>-<title slug>`: stable while the row keeps its place and wording. */
  name: string
  title: string
  /** The catalog modules the Suite column names; Operator-owned additions name their external suite instead. */
  modules: string[]
  /** The Layer column's cell as written. */
  layerCell: string
  /** Every layer the Layer column names, ranges expanded, in layer order. */
  layers: EvaluationLayer[]
  expectedOutcome: string
  cutover: CutoverOutcome
}

const SLUG_MAX = 60

/** Lowercase kebab words of a title, cut at a word boundary to at most sixty characters. */
export function slug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
  let out = ''
  for (const word of words) {
    const next = out === '' ? word : `${out}-${word}`
    if (next.length > SLUG_MAX && out !== '') break
    out = next
  }
  return out
}

/** Every `L<n>` the cell names, with `L1–L4` ranges expanded. */
export function parseLayers(cell: string): EvaluationLayer[] {
  const found = new Set<string>()
  for (const match of cell.matchAll(/L([1-8])(?:\s*[–-]\s*L([1-8]))?/g)) {
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    for (let n = from; n <= to; n++) found.add(`L${n}`)
  }
  return EVALUATION_LAYERS.filter((layer) => found.has(layer))
}

/** The table under the fault-and-attack heading of the given program text, row by row. */
export function parseFaultAttackTable(program: string): FaultAttackEntry[] {
  const start = program.indexOf(`\n## ${FAULT_ATTACK_HEADING}\n`)
  if (start < 0) throw new Error(`the mirror has no "## ${FAULT_ATTACK_HEADING}" heading`)
  const end = program.indexOf('\n## ', start + 1)
  const lines = program
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
  const [header, rule, ...tail] = lines
  if (header === undefined || rule === undefined) throw new Error('the fault-and-attack section holds no table')
  const columns = cells(header)
  const expected = ['Fault or attack', 'Suite', 'Layer', 'Expected typed outcome', 'Cutover']
  if (JSON.stringify(columns) !== JSON.stringify(expected)) {
    throw new Error(`the fault-and-attack table's columns changed: ${JSON.stringify(columns)}`)
  }
  // Revision 14 appends the Operator-owned rows under a subsection whose
  // table deliberately starts with a separator, not another header. Treat it
  // as a continuation of the canonical table.
  const rows = tail.filter((line) => !cells(line).every((cell) => /^-+$/.test(cell.replaceAll(' ', ''))))
  return rows.map((line, index) => {
    const [title, suite, layer, outcome, cutover] = cells(line) as [string, string, string, string, string]
    const order = index + 1
    const modules = [...suite.matchAll(/§(6\.[0-9]+)/g)].map((match) => match[1] as string)
    const layers = parseLayers(layer)
    if (!(cutover in CUTOVER_OUTCOMES)) throw new Error(`row ${order} has an unknown cutover outcome: ${cutover}`)
    if (layers.length === 0 || (modules.length === 0 && order <= 58)) {
      throw new Error(`row ${order} names no module or no layer`)
    }
    return {
      order,
      name: `${String(order).padStart(2, '0')}-${slug(title)}`,
      title,
      modules,
      layerCell: layer,
      layers,
      expectedOutcome: outcome,
      cutover: CUTOVER_OUTCOMES[cutover as keyof typeof CUTOVER_OUTCOMES]
    }
  })
}

function cells(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

/** The universe as the repository mirror holds it now. */
export function readFaultAttackUniverse(): FaultAttackEntry[] {
  return parseFaultAttackTable(readFileSync(PROGRAM_FILE, 'utf8'))
}
