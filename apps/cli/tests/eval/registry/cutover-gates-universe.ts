/**
 * The cutover-gate universe, parsed from the repository mirror of the
 * evaluation program: one entry per row of the table under its "Cutover gate
 * coverage" heading, in table order. Nothing here lists a gate; a gate that is
 * not in the mirror's table is not in the universe.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROGRAM_DOCUMENT = 'apps/cli/specs/dev-review-evaluation-program.md'
export const PROGRAM_FILE = join(import.meta.dir, '../../../specs/dev-review-evaluation-program.md')
export const CUTOVER_GATES_HEADING = '12. Cutover gate coverage'

/** The Engine specification section that defines the seventeen gates. */
export const ENGINE_SPEC = {
  document: 'Tech spec — Developer-review on Atta Engine',
  revision: 17,
  section: '16.18',
  /** The repository file that states the revision; the specification itself is the Linear document above. */
  revisionStatedIn: 'apps/cli/specs/dev-review-engine-state-machine.md'
} as const

/** The statement the rows of gates 14 and 15 carry: no known-failure entry is admitted. */
export const NO_KNOWN_FAILURE_STATEMENT = 'No known-failure entry is admitted for this gate.'
/** The statement the row of gate 17 carries: the decision is the Principal's, the evidence is the suite. */
export const PRINCIPAL_DECISION_STATEMENT =
  "The decision itself stays the Principal's; its evidence is the cutover authorization suite (§6.24)."

/**
 * The module a gate whose evidence names no §6 module is filed under, chosen
 * here and not read from the table: the catalog holds no module for the
 * architecture exit test or the defect-register check, so these two gates are
 * filed under the module whose L1 suites are the nearest home for an L1 check.
 */
export const FILED_UNDER_WITHOUT_MODULE: Readonly<Record<number, string>> = { 2: '6.7', 3: '6.7' }

/** One table row. */
export interface CutoverGateEntry {
  /** The gate number, from 1. */
  number: number
  /** `gate-<n>`: the name within the `cutover-gate` kind. */
  name: string
  title: string
  /** The Evidence column's cell as written. */
  evidence: string
  /** The catalog modules the evidence names with `§6.n`, in its order; empty when it names none. */
  modules: string[]
  /** The module that owns the row: the first named, else the one the gate is filed under. */
  owner: string
  /** Every `L<n>` the evidence names, in its order. */
  layers: string[]
}

/** The table under the cutover-gate heading of the given program text, row by row. */
export function parseCutoverGateTable(program: string): CutoverGateEntry[] {
  const start = program.indexOf(`\n## ${CUTOVER_GATES_HEADING}\n`)
  if (start < 0) throw new Error(`the mirror has no "## ${CUTOVER_GATES_HEADING}" heading`)
  const end = program.indexOf('\n## ', start + 1)
  const lines = program
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
  const [header, rule, ...rows] = lines
  if (header === undefined || rule === undefined) throw new Error('the cutover-gate section holds no table')
  const columns = cells(header)
  if (JSON.stringify(columns) !== JSON.stringify(['Gate', 'Evidence'])) {
    throw new Error(`the cutover-gate table's columns changed: ${JSON.stringify(columns)}`)
  }
  return rows.map((line, index) => {
    const [gate, evidence] = cells(line) as [string, string]
    const match = /^([0-9]+) (.+)$/.exec(gate)
    if (match === null) throw new Error(`row ${index + 1} has no gate number: ${gate}`)
    const number = Number(match[1])
    const modules = [...evidence.matchAll(/§(6\.[0-9]+)/g)].map((m) => m[1] as string)
    const owner = modules[0] ?? FILED_UNDER_WITHOUT_MODULE[number]
    if (owner === undefined) throw new Error(`gate ${number} names no module and is filed under none`)
    return {
      number,
      name: `gate-${number}`,
      title: match[2] as string,
      evidence,
      modules,
      owner,
      layers: [...evidence.matchAll(/\bL([1-8])\b/g)].map((m) => `L${m[1]}`)
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
export function readCutoverGateUniverse(): CutoverGateEntry[] {
  return parseCutoverGateTable(readFileSync(PROGRAM_FILE, 'utf8'))
}
