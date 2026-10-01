/**
 * Question 7 — are checks deterministic? (`apps/cli/specs/log-sync.md`,
 * "The questions".) As far as this data can ever say: a run records a
 * passing check only in its `summary` line, never a `checked` line
 * (`apps/cli/specs/log-sync.md`, the `gate` schema's own comment), so a pass
 * and a fail of the same input can never be seen together and determinism
 * cannot be established from the Log alone — this query reports that as
 * unknown, with the reason, rather than guessing from the failures alone.
 * What it can state: every failing check, by its check version, input
 * fingerprint and commit. A fingerprint hashes a check's environment and
 * changed files, not file contents, so the same fingerprint failing at two
 * different commits is never, by itself, evidence of non-determinism. A
 * failure with no commit recorded is unknown, never treated as deterministic
 * or not.
 */

import { unknownBecause } from '../sync'
import type { Dataset, Measured } from '../sync'
import type { Coverage, UnknownFigure } from './common'
import { buildCoverage, compareText, rowsOfKinds, textField, trustedRows } from './common'

const DETERMINISM_KINDS = ['gate']

const NO_COMMIT_REASON = 'no commit recorded for this event'
const DETERMINISM_REASON =
  'a passing check is recorded only in a run summary, so a pass and a fail of the same input cannot be seen together'

export type FailureRecord = {
  check: string
  checkVersion: string | null
  inputFingerprint: string | null
  commit: Measured<string>
}

export type DeterminismAnswer = {
  /** Every check failure the dataset recorded, ascending by check, then time. */
  failures: FailureRecord[]
  /** Always unknown: the Log never holds a pass and a fail of the same input together. */
  determinism: Measured<never>
  coverage: Coverage
}

/** Question 7: the failing checks, by check version, input fingerprint and commit — determinism itself stays unknown. */
export function determinism(dataset: Dataset): DeterminismAnswer {
  const { rows, lowTrust } = trustedRows(dataset)
  const used = rowsOfKinds(rows, DETERMINISM_KINDS)
  const unknowns: UnknownFigure[] = []

  const failures: FailureRecord[] = used.withUnit
    .filter((row) => row.event === 'checked' && textField(row, 'outcome') === 'fail')
    .sort(
      (a, b) => compareText(textField(a, 'check') ?? '', textField(b, 'check') ?? '') || compareText(a.time, b.time)
    )
    .map((row) => ({
      check: textField(row, 'check') ?? '',
      checkVersion: textField(row, 'check_version'),
      inputFingerprint: textField(row, 'input_fingerprint'),
      commit: row.commit === null ? unknownBecause(NO_COMMIT_REASON) : { known: true, value: row.commit }
    }))

  const determinismFigure: Measured<never> = unknownBecause(DETERMINISM_REASON)
  unknowns.push({ figure: 'determinism', reason: DETERMINISM_REASON })

  return { failures, determinism: determinismFigure, coverage: buildCoverage(dataset, lowTrust, used, unknowns) }
}
