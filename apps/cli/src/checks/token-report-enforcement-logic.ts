/**
 * Pure decision logic for the `token-report` check (task 4, #271). No `fs`,
 * no `process.env` of its own — the caller (`check-token-report.ts`)
 * supplies the already-computed `MeteringCapability` (task 1's
 * `resolveMeteringCapability` probe run against real `fs`/`process.env`
 * deps) and the PR body.
 *
 * `roles/developer.md`'s "Token report" obligation was, until this check,
 * a rule an agent could skip — `blankTokenReportSection`
 * (`body-bare-digits-logic.ts`) only ever MASKS a `## Token report`
 * section's contents before the bare-digits scan; it never enforces that
 * the section exists or that its cells are real numbers. A PR body reading
 * `Tokens in: —` on a metering-capable host passed every existing gate.
 *
 * Enforces presence and shape ONLY, never truth: this check has no
 * transcript to recompute a figure against, and cannot recompute one
 * either. It cannot tell a real `184327` from an invented one — the same
 * bounded honesty `evidence-fresh` states for its own Group B (a stale
 * block is caught; a fabricated-but-fresh one is not). The failure
 * messages below say exactly that, so a passing run is never read as "the
 * figures are verified correct."
 *
 * `capability.capable === false` passes silently in every case — the
 * sanctioned operator-metered case (`token-collection-wired`'s own
 * `no-transcript-resolved` precedent, now generalized: ANY incapable
 * reason here means this host has nothing to check the PR body against,
 * so it isn't this check's place to demand one). Distinguishing a clean
 * incapable verdict from the probe itself failing to run is the caller's
 * job, not this module's: `check-token-report.ts`'s own doc comment
 * explains why a probe crash never reaches this function at all.
 *
 * The `Cost` cell is out of scope entirely — only `tokensIn`/`tokensOut`
 * are inspected. The shipped `report-tokens.ts` renderer always emits `—`
 * there for want of a maintained pricing table, so failing on it would
 * block every real PR.
 */
import { parseTokenReportEntries, type LedgerRow, type MeteringCapability } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError } from './contract'

export type TokenReportEnforcementResult = { pass: true } | { pass: false; error: CheckError }

function missingSectionError(checkName: string): CheckError {
  return {
    schema: CHECK_SCHEMA_VERSION,
    check: checkName,
    severity: 'error',
    message:
      'token-report: the PR body carries no "Token report" row at all — presence is checked here, ' +
      'never whether any figures reported are correct. An operator-metered host that genuinely ' +
      'cannot meter this turn still states that in a row (`tranche-model.md` §12) rather than by ' +
      'omitting the section: a merged task must never leave the ledger with a silent hole where its ' +
      'spend should be.',
    agent_recovery_prompt:
      'Paste a "## Token report" section into the PR body with at least one row (see ' +
      "roles/developer.md's token-reporting obligation) — real figures if this host exposes them, " +
      'or `—` cells if it genuinely does not, then re-run `vinaya check token-report`.'
  }
}

function blankCellError(checkName: string, entry: LedgerRow): CheckError {
  return {
    schema: CHECK_SCHEMA_VERSION,
    check: checkName,
    severity: 'error',
    message:
      `token-report: this host is metering-capable, but a "Token report" entry (phase ` +
      `"${entry.phase}") has a blank, missing, or non-numeric Tokens in/out cell — shape is checked ` +
      'here, never whether the figure is correct. The Cost cell is exempt.',
    agent_recovery_prompt:
      'Replace the blank/`—`/non-numeric Tokens in/out cell with the real figure this host reports, ' +
      'then re-run `vinaya check token-report`. Never write `—` for a reason other than the host ' +
      "genuinely exposing no usage figure at all — see roles/developer.md's token-reporting section."
  }
}

export function evaluateTokenReportEnforcement(
  checkName: string,
  capability: MeteringCapability,
  prBody: string
): TokenReportEnforcementResult {
  // Empty PR_BODY is the sanctioned "no PR yet, likely a local invocation"
  // case `test-plan-gate.ts`'s identical `if (!body)` guard already
  // establishes for this exact requiresOpenPr shape — CI always sets
  // PR_BODY once a real PR exists, so an empty string here means there is
  // no PR body to evaluate at all, never a PR that shipped one blank.
  if (!prBody) return { pass: true }

  // O13 — a ledger with NO row is refused regardless of capability. An
  // incapable (operator-metered) host is a legitimate reason for every cell
  // to read `—`, never a legitimate reason for the whole section to be
  // ABSENT: `tranche-model.md` §12 states the operator-metered case writes
  // `—` in the grammar, in a row — "that is the sanctioned outcome, not a
  // failure to comply" — never an omission. Before this, `!capability.capable`
  // returned `pass: true` before this check ever ran, so a merged task on an
  // incapable host could carry no "## Token report" section at all and still
  // pass silently — the exact silent hole this rule closes.
  const entries = parseTokenReportEntries(prBody)
  if (entries.length === 0) return { pass: false, error: missingSectionError(checkName) }

  if (!capability.capable) return { pass: true }

  const badEntry = entries.find((e) => e.tokensIn === null || e.tokensOut === null)
  if (badEntry) return { pass: false, error: blankCellError(checkName, badEntry) }

  return { pass: true }
}
