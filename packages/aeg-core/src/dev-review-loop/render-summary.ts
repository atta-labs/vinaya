/**
 * `renderSummary(journal)` — the publication comment (dev-review-loop-v1
 * task 4, `#414`, O4). One markdown table, rows per round, counts and the
 * outcome only — no finding prose, and no line either verdict extractor
 * (`../verdict-extraction`) would read as a real verdict: no `VERDICT:`,
 * `Judged head:`, or `Objectives version:` label anywhere in the output.
 */

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
  const header = `| round | ${SEVERITY_COLUMNS.join(' | ')} | confidence | outcome |`
  const divider = `| --- | ${SEVERITY_COLUMNS.map(() => '---').join(' | ')} | --- | --- |`
  const rows = journal.rounds.map(row)
  return [header, divider, ...rows].join('\n')
}
