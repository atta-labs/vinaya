/**
 * Question 5 — does the product catch anything? (`apps/cli/specs/log-sync.md`,
 * "The questions".) The recorded catches — a check failure (`gate` `checked`
 * with `outcome: 'fail'`) and a review finding later resolved (a finding id
 * named in a `findings_compared` line's `resolved` list) — and the observable
 * escapes, which this task's boundary is explicit the Log never records on
 * its own: a gate rejection is not automatically a prevented bug, and no
 * recorded escape is not proof of zero escapes. An escape is counted only
 * from a supplied `HumanLabel` of kind `'reversal'` or `'incident'` — never
 * from a `'false_rejection'` label, which names the opposite case — and
 * reads unknown, never zero, when no label was supplied at all.
 */

import { known, unknownBecause } from '../sync'
import type { Dataset, Measured } from '../sync'
import type { Coverage, UnknownFigure } from './common'
import { buildCoverage, rowsOfKinds, stringArrayField, textField, trustedRows } from './common'
import { NO_LABELS_REASON, type HumanLabel } from './labels'

export type CatchesAnswer = {
  /** `gate` `checked` lines whose outcome is `'fail'`. */
  checkFailures: number
  /** Finding ids named in a `findings_compared` line's `resolved` list. */
  findingsResolved: number
  /** `checkFailures + findingsResolved`. */
  catches: number
  /** A `'reversal'` or `'incident'` label, counted; unknown with `'no labels recorded'` when no label was supplied at all. */
  escapes: Measured<number>
  coverage: Coverage
}

const CATCHES_KINDS = ['gate', 'dev_review_loop']

/** Question 5: the catches the Log recorded, and the escapes a supplied label can name. */
export function catchesAndEscapes(dataset: Dataset, labels: readonly HumanLabel[] = []): CatchesAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, CATCHES_KINDS)
  const unknowns: UnknownFigure[] = []

  let checkFailures = 0
  let findingsResolved = 0
  for (const row of used.withUnit) {
    if (row.kind === 'gate' && row.event === 'checked' && textField(row, 'outcome') === 'fail') checkFailures++
    else if (row.kind === 'dev_review_loop' && row.event === 'findings_compared')
      findingsResolved += stringArrayField(row, 'resolved').length
  }

  let escapes: Measured<number>
  if (labels.length === 0) {
    escapes = unknownBecause(NO_LABELS_REASON)
    unknowns.push({ figure: 'escapes', reason: NO_LABELS_REASON })
  } else {
    escapes = known(labels.filter((label) => label.kind === 'reversal' || label.kind === 'incident').length)
  }

  return {
    checkFailures,
    findingsResolved,
    catches: checkFailures + findingsResolved,
    escapes,
    coverage: buildCoverage(dataset, lowTrust, used, unknowns)
  }
}
