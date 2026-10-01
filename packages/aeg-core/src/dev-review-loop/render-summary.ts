/**
 * `renderPublishedMarker(journal, head)` — the publication comment. A single
 * HTML comment line, invisible on the pull request, carrying what the loop's
 * own readers need: that the loop published, the head it published, and each
 * round's confidence. The round table is not posted — the Vinaya Log is the
 * record of each round's findings and outcome. The line carries no `VERDICT:`,
 * `Judged head:`, or `Objectives version:` label, so neither verdict extractor
 * (`../verdict-extraction`) can read it as a real verdict.
 */

import { PUBLISHED_MARKER_LINE } from './journal-reconstruction'
import type { Confidence, Journal } from './types'

/** The cell a round the loop never asked for a confidence at all (round 1 never is) writes. */
export const CONFIDENCE_NOT_ASKED_CELL = '-'
/** The cell a round that was asked, with no readable statement, writes. */
export const CONFIDENCE_ABSENT_CELL = 'absent'

/** The highest percentage the marker ever records — the same ceiling `CONFIDENCE_LINE`'s own `0-100` grammar accepts, named here because the parser below refuses a figure that exceeds it. */
export const CONFIDENCE_MAX_PERCENT = 100

function confidenceCell(confidence: Confidence | null): string {
  if (confidence === null) return CONFIDENCE_NOT_ASKED_CELL
  if (confidence === 'absent') return CONFIDENCE_ABSENT_CELL
  return String(confidence.value)
}

/**
 * The published marker: `<!-- aeg:loop:published head=<sha> confidence=1:-,2:80,3:absent -->`.
 * Each round contributes `<round>:<cell>` — a percentage, `absent` (asked, no
 * readable statement) or `-` (never asked).
 */
export function renderPublishedMarker(journal: Journal, head: string): string {
  const confidence = journal.rounds.map((record) => `${record.round}:${confidenceCell(record.confidence)}`).join(',')
  return `<!-- aeg:loop:published head=${head} confidence=${confidence} -->`
}

/**
 * One round's confidence as the marker records it, in three distinguishable
 * states rather than two:
 *
 *   - `asked: true` with a `percent` — the developer stated that figure;
 *   - `asked: true`, `percent: null` — the round WAS asked and the statement
 *     was missing or unreadable (the `absent` cell);
 *   - `asked: false`, `percent: null` — the loop never asked this round at all
 *     (the `-` cell; round 1 is never asked), so a reader must not be told the
 *     developer skipped a statement.
 */
export type SummaryConfidenceRow = { round: number; percent: number | null; asked: boolean }

/**
 * The inverse of `renderPublishedMarker` — the confidence entries read back out
 * of a posted marker. Kept beside the renderer so the entry shape is written
 * down once.
 *
 * This is the boundary between pull-request comment text (which anybody with
 * write access to a fork's branch can shape) and the confidence figure a tool
 * result publishes, so the percentage is bounded HERE: an entry claiming more
 * than `CONFIDENCE_MAX_PERCENT` is dropped rather than carried out of range. A
 * comment with no marker line, and any entry not shaped `<round>:<cell>`,
 * yields no row at all rather than a guess.
 */
export function parseSummaryConfidenceRows(body: string): SummaryConfidenceRow[] {
  const rows: SummaryConfidenceRow[] = []
  for (const line of body.split('\n')) {
    const match = PUBLISHED_MARKER_LINE.exec(line.trim())
    if (!match) continue
    for (const entry of (match[2] as string).split(',')) {
      const [roundText, cell] = entry.split(':')
      const round = Number(roundText)
      if (!Number.isInteger(round) || round <= 0 || cell === undefined) continue
      if (cell === CONFIDENCE_NOT_ASKED_CELL) {
        rows.push({ round, percent: null, asked: false })
      } else if (cell === CONFIDENCE_ABSENT_CELL) {
        rows.push({ round, percent: null, asked: true })
      } else if (/^\d{1,3}$/.test(cell) && Number(cell) <= CONFIDENCE_MAX_PERCENT) {
        rows.push({ round, percent: Number(cell), asked: true })
      }
    }
  }
  return rows
}
