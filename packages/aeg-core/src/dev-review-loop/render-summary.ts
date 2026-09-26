/**
 * `renderSummary(journal)` — the publication comment. One markdown table, rows per round, counts and the
 * outcome only — no finding prose, and no line either verdict extractor
 * (`../verdict-extraction`) would read as a real verdict: no `VERDICT:`,
 * `Judged head:`, or `Objectives version:` label anywhere in the output.
 */

import { SUMMARY_TABLE_HEADER } from './journal-reconstruction'
import { SEVERITY_COLUMNS, type Confidence, type Journal, type RoundRecord } from './types'

function confidenceCell(confidence: Confidence | null): string {
  if (confidence === null) return '—'
  if (confidence === 'absent') return 'absent'
  return `${confidence.value}%`
}

function row(record: RoundRecord): string {
  const counts = SEVERITY_COLUMNS.map((key) => String(record.countsBySeverity[key] ?? 0))
  return `| ${record.round} | ${counts.join(' | ')} | ${confidenceCell(record.confidence)} | ${record.outcome} |`
}

export function renderSummary(journal: Journal): string {
  const header = SUMMARY_TABLE_HEADER
  const divider = `| --- | ${SEVERITY_COLUMNS.map(() => '---').join(' | ')} | --- | --- |`
  const rows = journal.rounds.map(row)
  return [header, divider, ...rows].join('\n')
}

/** One round's confidence as this table records it: the stated percentage, or `null` for a round whose developer stated none (`absent`, or the `—` a round the loop never asked leaves). */
export type SummaryConfidenceRow = { round: number; percent: number | null }

/**
 * The inverse of `row` above — the confidence column read back out of a
 * posted summary table. Kept here, beside the renderer, so the column's
 * position is written down once: a reader elsewhere would have to hand-copy
 * the table's shape and would drift the first time a column moved.
 *
 * Only rows this renderer could have produced are read: a leading round
 * number, then one cell per severity column, then the confidence cell, then
 * the outcome. Anything else in the comment — prose above or below the table,
 * a differently-shaped table — yields no row at all rather than a guess.
 */
export function parseSummaryConfidenceRows(body: string): SummaryConfidenceRow[] {
  const cellCount = SEVERITY_COLUMNS.length + 3
  const rows: SummaryConfidenceRow[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue
    const cells = trimmed.slice(1, -1).split('|')
    if (cells.length !== cellCount) continue
    const round = Number((cells[0] as string).trim())
    if (!Number.isInteger(round) || round <= 0) continue
    const confidenceCellText = (cells[cellCount - 2] as string).trim()
    const percentMatch = /^(\d{1,3})%$/.exec(confidenceCellText)
    rows.push({ round, percent: percentMatch ? Number(percentMatch[1]) : null })
  }
  return rows
}
