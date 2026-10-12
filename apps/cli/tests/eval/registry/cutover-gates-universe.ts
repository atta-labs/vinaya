// The cutover-gate universe, derived from the repository mirror of the
// evaluation program: the table under its cutover-gate coverage heading is the
// only list of gates, so nothing here names one. The shard's checks that a
// completeness comparison cannot make — number order, the evidence each gate
// names, the statements gates 14, 15 and 17 must carry — live here too.
import { readFileSync } from 'node:fs'

export const COVERAGE_HEADING = '12. Cutover gate coverage'

export interface CoverageGate {
  number: number
  title: string
  evidence: string
}

/** The gates of the coverage table, in table order, read from the mirror's text. */
export function parseCoverageTable(markdown: string): CoverageGate[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.replace(/^#+ /, '') === COVERAGE_HEADING && line.startsWith('#'))
  if (start === -1) throw new Error(`the mirror has no heading "${COVERAGE_HEADING}"`)
  const gates: CoverageGate[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break
    const cells = line.match(/^\|\s*(\d+) (.+?)\s*\|\s*(.+?)\s*\|\s*$/)
    if (cells === null) continue
    gates.push({ number: Number(cells[1]), title: cells[2] as string, evidence: cells[3] as string })
  }
  if (gates.length === 0) throw new Error(`the table under "${COVERAGE_HEADING}" has no gate row`)
  return gates
}

export function readCoverageTable(mirrorFile: string): CoverageGate[] {
  return parseCoverageTable(readFileSync(mirrorFile, 'utf8'))
}

/** The gate universe: each gate's number, as the name within kind `gate`. */
export function gateUniverse(gates: readonly CoverageGate[]): string[] {
  return gates.map((gate) => String(gate.number))
}

type Row = Record<string, unknown>

/**
 * What the shard must hold beyond completeness, as one message per breach:
 * the rows in number order, each row's evidence equal to the table's, no
 * empty field among the fields a row adds to the ten, and the statements
 * the evaluation program makes of gates 14, 15 and 17.
 */
export function checkGateRows(rows: readonly Row[], gates: readonly CoverageGate[]): string[] {
  const problems: string[] = []
  const numbers = rows.map((row) => Number(String(row.id).split(':')[1]))
  if (numbers.some((n, i) => i > 0 && n <= (numbers[i - 1] as number))) {
    problems.push(`rows are not in ascending gate-number order: ${numbers.join(', ')}`)
  }
  const byNumber = new Map(rows.map((row) => [Number(String(row.id).split(':')[1]), row]))
  for (const gate of gates) {
    const row = byNumber.get(gate.number)
    if (row === undefined) continue
    if (row.evidence !== gate.evidence) {
      problems.push(
        `gate ${gate.number} names evidence ${JSON.stringify(row.evidence)}, the table names ${JSON.stringify(gate.evidence)}`
      )
    }
    for (const key of ['evidence', 'engineSource']) {
      const value = row[key]
      const empty =
        value === undefined ||
        (typeof value === 'string' && value.trim() === '') ||
        (typeof value === 'object' &&
          value !== null &&
          Object.values(value).some((v) => typeof v === 'string' && v.trim() === ''))
      if (empty) problems.push(`gate ${gate.number} has an empty ${key}`)
    }
  }
  const said = (n: number, key: string, needle: string) =>
    String(byNumber.get(n)?.[key] ?? '')
      .toLowerCase()
      .includes(needle)
  for (const n of [14, 15]) {
    if (
      !said(n, 'contract', 'no known-failure entry is admitted') ||
      !said(n, 'decisionRule', 'no known-failure entry is admitted')
    ) {
      problems.push(`gate ${n} does not state that no known-failure entry is admitted`)
    }
  }
  if (
    !said(17, 'contract', "the decision itself stays the principal's") ||
    !said(17, 'contract', 'cutover authorization')
  ) {
    problems.push(
      "gate 17 does not state that the decision stays the Principal's and its evidence is the cutover authorization suite"
    )
  }
  return problems
}
