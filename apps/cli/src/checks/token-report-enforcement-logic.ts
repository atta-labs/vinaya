/**
 * Pure decision logic for the `token-report` check. No `fs`,
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
 *
 * The no-row refusal (`entries.length === 0`) applies only when `isTaskPr`
 * is true — a task pull request never leaves the
 * ledger with a silent hole, but a non-task pull request (the changesets
 * bot's release PR, chief example) never carries a "develop" turn to
 * report at all and is not refused for a row it could never satisfy.
 */
import {
  parseTokenReportEntries,
  type LedgerRow,
  type MeteringCapability,
  type MeteringIncapableReason
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, type CheckError } from './contract'

export type TokenReportEnforcementResult = { pass: true } | { pass: false; error: CheckError }

/**
 * Every reason `resolveMeteringCapability` (`claude-code-transcript.ts`, out
 * of this task's surface) can ever emit — the closed vocabulary a row's
 * Agent/Model cell must match to count as declared-unmetered, below.
 */
const KNOWN_INCAPABLE_REASONS: readonly MeteringIncapableReason[] = [
  'no-transcript-resolved',
  'pointer-unusable',
  'transcript-unreadable',
  'transcript-empty'
]

/**
 * O2/O3 (#608): a row that HONESTLY declares itself unmetered — never a new
 * sentinel, since neither row-writer (`commands/pr.ts`'s `tokenRowForOpen`,
 * `pr-report-engine.ts`'s `collectTokensAddition`) is in this task's
 * admitted surface to change. Both already write the exact `— (<reason>)`
 * grammar in the Agent/Model cell for every incapable reason; this function
 * is the only piece that needed to change to make that existing, already
 * on-disk grammar machine-readable here too.
 *
 * A blank `Tokens in`/`Tokens out` pair next to this marker states a fact
 * the writer's own probe actually established — "declared, not metered" —
 * and is never invented; a blank pair next to anything else (a plain model
 * name, an empty cell, unexplained silence) carries no such declaration and
 * is "missing," which stays refused below. This check still does not verify
 * the reason is TRUE (same bounded honesty as everywhere else in this
 * file) — only that one of the four reasons the probe itself can ever
 * produce is the one written, never an invented figure or a hard block on
 * the sanctioned "no wiring of my own" case.
 */
function isDeclaredUnmeteredCell(agentModel: string): boolean {
  const trimmed = agentModel.trim()
  return KNOWN_INCAPABLE_REASONS.some((reason) => trimmed === `— (${reason})`)
}

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
      `"${entry.phase}") has a blank, missing, or non-numeric Tokens in/out cell with no declared-` +
      'unmetered marker in Agent/Model — shape is checked here, never whether the figure is correct. ' +
      'The Cost cell is exempt.',
    agent_recovery_prompt:
      'Replace the blank/`—`/non-numeric Tokens in/out cell with the real figure this host reports, ' +
      'or, if usage genuinely cannot be recovered, write `— (<reason>)` in Agent/Model using one of the ' +
      'reasons `resolveMeteringCapability` itself produces (e.g. `— (no-transcript-resolved)`) — never ' +
      'an invented figure — then re-run `vinaya check token-report`.'
  }
}

export function evaluateTokenReportEnforcement(
  checkName: string,
  capability: MeteringCapability,
  prBody: string,
  isTaskPr: boolean
): TokenReportEnforcementResult {
  // Empty PR_BODY is the sanctioned "no PR yet, likely a local invocation"
  // case `test-plan-gate.ts`'s identical `if (!body)` guard already
  // establishes for this exact requiresOpenPr shape — CI always sets
  // PR_BODY once a real PR exists, so an empty string here means there is
  // no PR body to evaluate at all, never a PR that shipped one blank.
  if (!prBody) return { pass: true }

  // O13 — a ledger with NO row is refused regardless of capability, but
  // ONLY on a task pull request. An incapable (operator-metered) host is a
  // legitimate reason for every cell to read `—`, never a legitimate
  // reason for the whole section to be ABSENT: `tranche-model.md` §12
  // states the operator-metered case writes `—` in the grammar, in a row —
  // "that is the sanctioned outcome, not a failure to comply" — never an
  // omission. Before this, `!capability.capable` returned `pass: true`
  // before this check ever ran, so a merged task on an incapable host
  // could carry no "## Token report" section at all and still pass
  // silently — the exact silent hole this rule closes. A non-task PR (e.g.
  // the changesets bot's release PR) never carries a "develop" turn to
  // report at all, so it can never satisfy this row — the rule scopes to
  // `isTaskPr` rather than refusing a PR that structurally cannot comply.
  const entries = parseTokenReportEntries(prBody)
  if (entries.length === 0) {
    if (!isTaskPr) return { pass: true }
    return { pass: false, error: missingSectionError(checkName) }
  }

  if (!capability.capable) return { pass: true }

  // O2/O3 (#608): a blank cell next to a declared-unmetered Agent/Model
  // marker is "not metered, declared" — accepted regardless of THIS check's
  // own capability, since that capability describes this check's own
  // resolution, never the row-writer's — and a row written earlier, in a
  // different session or process, can be honestly unmetered even when this
  // run resolves its own transcript fine.
  const badEntry = entries.find(
    (e) => (e.tokensIn === null || e.tokensOut === null) && !isDeclaredUnmeteredCell(e.agentModel)
  )
  if (badEntry) return { pass: false, error: blankCellError(checkName, badEntry) }

  return { pass: true }
}
