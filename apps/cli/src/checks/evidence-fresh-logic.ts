/**
 * Pure comparison logic for the `evidence-fresh` check (fix/pr-report-emitter).
 * No `fs`, no `git`/`gh` — every fact this needs (the anchored region's text,
 * the PR's actual head sha, the actual recomputed `--numstat`) is supplied by
 * the caller, so this is unit-testable with plain string fixtures alone. The
 * `check-evidence-fresh.ts` bin is the thin wiring that gathers those facts
 * via `gh`/`git` and calls this.
 *
 * Scope, deliberately narrow (see `aeg-root/roles/developer.md`'s brief for
 * fix/pr-report-emitter, §6 Part 2): this closes fabrication for Group A (the
 * recomputed diff stat) by exact-comparing recomputed text against the
 * block's stored text. For Group B (the attested `vinaya check --all
 * --diff-only` run) and Group C (the attested §9 `[agent]` command list,
 * task 12, Principal ruling PR `open-1`) it checks correspondence only —
 * Group B's `Head:` sha still matches the PR's real head, Group C's stored
 * `$ <command>` lines still equal the body's own §9 list — because
 * re-running either suite here would be the recursion this same brief's
 * Part 1 rejected (Group C's own first attempt at exact re-run did exactly
 * that: deleted `dist` out from under CI's twenty-six sibling checks and
 * ran the whole test suite inside a single check's timeout). A block whose
 * Group B or Group C section was fabricated outright (never actually run)
 * is NOT detected by this function; only a STALE or MISMATCHED one is.
 */

import { EVIDENCE_SUMMARY_PREFIX, summariseNumstat } from '../lib/numstat'
import { type ResolvedRegion, summaryLineIndex } from './scan-context'

export type EvidenceCompareResult = { status: 'pass' } | { status: 'fail'; errors: string[] }

const HEAD_LINE = /^Head:\s*([0-9a-f]{7,40})\s*$/m
const FENCE = /```[^\n]*\n?([\s\S]*?)```/g

/**
 * Compares an already-located `AEG:EVIDENCE` region against the facts a
 * checker can independently derive. Assumes the caller already handled the
 * "no block" / "no PR body" / "no PR yet" / "hidden" bypasses — `resolved`
 * here is always real anchor content.
 *
 * Takes the `ResolvedRegion` rather than a bare string because the `Summary:`
 * line is selected from the region's MASKED view (`summaryLineIndex`), so a
 * `Summary:` inside the Group B fence or a `<details>` block is never the one
 * compared. Passing the pair whole is what keeps the located line and the
 * sliced text at the same offsets (Issue #189).
 *
 * `expectedGroupCCommandLines` (task 12, Principal ruling PR `open-1`) is the
 * caller's own command list read STRAIGHT OFF the body's §9 Test Plan
 * section (`agentCommandText`-stripped, never executed by this check) —
 * compared against the stored block's `$ <command>` lines, in order, WHEN
 * the block carries a third fence at all. Group C is arbitrary §9 commands,
 * not a `git` recompute: re-running it here is exactly the class of
 * recursion Group B is already exempt from (a check re-executing a full
 * test suite under sibling checks that just consumed the same `dist` — the
 * defect this ruling fixes). This is attestation, the same treatment
 * Group B gets, never a re-run and byte-compare. A body with only two
 * fences predates this group (grandfathered — not every currently open PR
 * was written after task 12 landed) and is not compared on this axis;
 * `undefined` skips the comparison outright for a caller that has not
 * computed one.
 */
export function compareEvidenceBlock(
  resolved: ResolvedRegion,
  resolvedHead: string,
  actualNumstat: string,
  expectedGroupCCommandLines?: string[]
): EvidenceCompareResult {
  const region = resolved.region
  const headMatch = region.match(HEAD_LINE)
  const fences = [...region.matchAll(FENCE)].map((m) => (m[1] ?? '').trim())

  if (!headMatch || fences.length < 1) {
    return {
      status: 'fail',
      errors: [
        'evidence-fresh: the AEG:EVIDENCE block is malformed — could not locate both a `Head:` line and a Group A fenced diff block. Re-run `vinaya pr report --write` to regenerate it.'
      ]
    }
  }

  const storedHead = headMatch[1] as string
  const storedNumstat = fences[0] as string
  const actual = actualNumstat.trim()
  const errors: string[] = []

  if (storedHead !== resolvedHead) {
    errors.push(
      `evidence-fresh: Group B is stale — the block's Head (${storedHead}) does not match the PR's real head (${resolvedHead}). Re-run `.concat(
        '`vinaya pr report --write` against the current head, commit, and push again.'
      )
    )
  }

  if (storedNumstat !== actual) {
    errors.push(
      [
        'evidence-fresh: Group A does not match a fresh recompute of `git diff --numstat` at the PR head.',
        `  block:  ${JSON.stringify(storedNumstat)}`,
        `  actual: ${JSON.stringify(actual)}`
      ].join('\n')
    )
  }

  // The `Summary:` line, compared whole — backticks included, because the
  // emitter writes the value inside an inline code span so it needs no
  // `body-bare-digits` exemption (see `buildBlockInner`'s doc for why an
  // exemption could not have bootstrapped past a default-branch-pinned check).
  //
  // Absent is fine: the line is additive, and a block without one has nothing
  // to verify. Present means compared, always — a hand-written
  // `Summary: 900 files changed, 12000 insertions(+)` fails here, and
  // unbackticked it is also a bare digit to the other check.
  const summaryIndex = summaryLineIndex(resolved.maskedRegion)
  if (summaryIndex !== null) {
    const storedSummary = resolved.region.split('\n')[summaryIndex] as string
    const expectedSummary = `${EVIDENCE_SUMMARY_PREFIX}\`${summariseNumstat(actual)}\``
    if (storedSummary !== expectedSummary) {
      errors.push(
        [
          'evidence-fresh: the Summary line does not match a fresh recompute of the diff it summarises.',
          `  block:  ${JSON.stringify(storedSummary)}`,
          `  actual: ${JSON.stringify(expectedSummary)}`
        ].join('\n')
      )
    }
  }

  // Group C (task 12, Principal ruling PR `open-1`) — attested, like
  // Group B: the stored fence's `$ <command>` lines must equal the body's
  // own §9 command list, in order. Never re-run, never byte-compared
  // against fresh output — only when BOTH sides can see it: the block
  // carries a third fence, and the caller supplied an expected list. A
  // two-fence block predates this group entirely and is never faulted for
  // lacking it.
  if (expectedGroupCCommandLines !== undefined && fences.length >= 3) {
    const storedCommands = (fences[2] as string)
      .split('\n')
      .filter((l) => l.startsWith('$ '))
      .map((l) => l.slice(2))
    const expected = expectedGroupCCommandLines
    const mismatch = storedCommands.length !== expected.length || storedCommands.some((c, i) => c !== expected[i])
    if (mismatch) {
      errors.push(
        [
          "evidence-fresh: Group C's command lines do not match the PR body's own §9 Test Plan list.",
          `  block:    ${JSON.stringify(storedCommands)}`,
          `  expected: ${JSON.stringify(expected)}`
        ].join('\n')
      )
    }
  }

  return errors.length > 0 ? { status: 'fail', errors } : { status: 'pass' }
}
