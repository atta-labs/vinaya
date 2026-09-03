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
 * --diff-only` run) it checks staleness only — that the block's `Head:` sha
 * still equals the PR's real head — because re-running that suite here would
 * be the recursion this same brief's Part 1 rejected. A block whose Group B
 * section was fabricated outright (never actually run) is NOT detected by
 * this function; only a STALE one is.
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
 * `actualGroupCFenceInner` (task 12, #387) is the caller's own independently
 * recomputed Group C fence content (`renderGroupC`'s inner text, re-run from
 * the PR's own body's Test Plan command list) — compared exactly, the same
 * way Group A is, WHEN the block carries a third fence at all. A body with
 * only two fences predates this group (grandfathered — not every currently
 * open PR was written after task 12 landed) and is not compared on this
 * axis; `undefined` skips the comparison outright for a caller that has not
 * computed one.
 */
export function compareEvidenceBlock(
  resolved: ResolvedRegion,
  resolvedHead: string,
  actualNumstat: string,
  actualGroupCFenceInner?: string
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

  // Group C (task 12, #387) — compared exactly, like Group A, but only when
  // BOTH sides can see it: the block carries a third fence, and the caller
  // computed one to compare against. A two-fence block predates this group
  // entirely and is never faulted for lacking it.
  if (actualGroupCFenceInner !== undefined && fences.length >= 3) {
    const storedGroupC = fences[2] as string
    const actualGroupC = actualGroupCFenceInner.trim()
    if (storedGroupC !== actualGroupC) {
      errors.push(
        [
          'evidence-fresh: Group C does not match a fresh re-run of the Test Plan `[agent]` command list at the PR head.',
          `  block:  ${JSON.stringify(storedGroupC)}`,
          `  actual: ${JSON.stringify(actualGroupC)}`
        ].join('\n')
      )
    }
  }

  return errors.length > 0 ? { status: 'fail', errors } : { status: 'pass' }
}
