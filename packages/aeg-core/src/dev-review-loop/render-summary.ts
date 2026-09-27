/**
 * `renderSummary(journal)` — the publication comment. One markdown table, rows per round, counts and the
 * outcome only — no finding prose, and no line either verdict extractor
 * (`../verdict-extraction`) would read as a real verdict: no `VERDICT:`,
 * `Judged head:`, or `Objectives version:` label anywhere in the output.
 */

import { SUMMARY_TABLE_HEADER } from './journal-reconstruction'
import { SEVERITY_COLUMNS, type Confidence, type Journal, type RoundRecord } from './types'

/**
 * The two non-numeric cells this table writes, named once so the parser below
 * reads the same literals the renderer wrote. They are DIFFERENT facts: the
 * loop never asked this round for a confidence at all (round 1 never is), or
 * it asked and the developer stated nothing readable.
 */
export const CONFIDENCE_NOT_ASKED_CELL = '—'
export const CONFIDENCE_ABSENT_CELL = 'absent'

/** The highest percentage this table ever records — the same ceiling `CONFIDENCE_LINE`'s own `0-100` grammar accepts, named here because the parser below refuses a row that exceeds it. */
export const CONFIDENCE_MAX_PERCENT = 100

function confidenceCell(confidence: Confidence | null): string {
  if (confidence === null) return CONFIDENCE_NOT_ASKED_CELL
  if (confidence === 'absent') return CONFIDENCE_ABSENT_CELL
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

/**
 * One round's confidence as this table records it, in three distinguishable
 * states rather than two:
 *
 *   - `asked: true` with a `percent` — the developer stated that figure;
 *   - `asked: true`, `percent: null` — the round WAS asked and the statement
 *     was missing or unreadable (the table's own `absent` cell);
 *   - `asked: false`, `percent: null` — the loop never asked this round at all
 *     (its `—` cell; round 1 is never asked), so the round has no confidence
 *     to report and a reader must not be told the developer skipped one.
 */
export type SummaryConfidenceRow = { round: number; percent: number | null; asked: boolean }

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
 *
 * This function is the boundary between pull-request comment text (which
 * anybody with write access to a fork's branch can shape) and the confidence
 * figure a tool result publishes, so the percentage is bounded HERE: a cell
 * claiming more than `CONFIDENCE_MAX_PERCENT` is dropped rather than carried
 * out of range into a caller that declares `0-100`.
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
    if (confidenceCellText === CONFIDENCE_NOT_ASKED_CELL) {
      rows.push({ round, percent: null, asked: false })
      continue
    }
    if (confidenceCellText === CONFIDENCE_ABSENT_CELL) {
      rows.push({ round, percent: null, asked: true })
      continue
    }
    const percentMatch = /^(\d{1,3})%$/.exec(confidenceCellText)
    if (!percentMatch) continue
    const percent = Number(percentMatch[1])
    if (percent > CONFIDENCE_MAX_PERCENT) continue
    rows.push({ round, percent, asked: true })
  }
  return rows
}
