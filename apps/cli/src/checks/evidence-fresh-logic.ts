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
 * task 12, Principal rulings PR `open-1`/`open-2`) it checks correspondence
 * only — Group B's `Head:` sha still matches the PR's real head, Group C's
 * stored `#### C<n>: \`<command>\`` HEADING lines still equal the body's own
 * §9 list, in order — because re-running either suite here would be the
 * recursion this same brief's Part 1 rejected (Group C's own first attempt
 * at exact re-run did exactly that: deleted `dist` out from under CI's
 * twenty-six sibling checks and ran the whole test suite inside a single
 * check's timeout). Headings, not fence contents: a command's own output can
 * contain a line shaped like whatever delimiter a fence-content scan would
 * use (`bun run test` prints its own `$ turbo test` progress line), so only
 * a heading — which no command's OUTPUT can forge — is ever a command
 * boundary. A block whose Group B or Group C section was fabricated
 * outright (never actually run) is NOT detected by this function; only a
 * STALE or MISMATCHED one is.
 *
 * Group B's `Head:` comparison (`#497`) accepts a stored sha that differs
 * from the PR's real head when the caller's `patchIdOf` reports the same
 * patch identity for both — the identical rule `check-review-gate.ts` binds
 * a verdict by. A rebase, a merge from the base, or a whitespace-only push
 * changes the sha without changing the patch and must not void the block.
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
 * `expectedGroupCCommandLines` (task 12, Principal rulings PR
 * `open-1`/`open-2`) is the caller's own command list read STRAIGHT OFF the
 * body's §9 Test Plan section (`agentCommandText`-stripped, never executed
 * by this check) — compared against the stored block's `#### C<n>:
 * \`<command>\`` heading lines, in order, WHEN the region carries a
 * `### Group C` heading at all. Group C is arbitrary §9 commands, not a
 * `git` recompute: re-running it here is exactly the class of recursion
 * Group B is already exempt from (a check re-executing a full test suite
 * under sibling checks that just consumed the same `dist` — the defect
 * `open-1` fixed). This is attestation, the same treatment Group B gets,
 * never a re-run and byte-compare — and, since `open-2`, never a scan of a
 * fence's own contents either, since a command's real output can itself
 * contain a line shaped like a delimiter. A body with no `### Group C`
 * heading predates this group (grandfathered — not every currently open PR
 * was written after task 12 landed) and is not compared on this axis;
 * `undefined` skips the comparison outright for a caller that has not
 * computed one.
 */
export function compareEvidenceBlock(
  resolved: ResolvedRegion,
  resolvedHead: string,
  actualNumstat: string,
  expectedGroupCCommandLines?: string[],
  patchIdOf?: (sha: string) => string | null
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
    // A verdict binds to a PATCH, not a sha (`check-review-gate.ts`'s own
    // `patchIdOf` binding) — the freshness check binds by the identical
    // rule (`#497`). A clean rebase, a merge from the base, or a
    // whitespace-only push changes the sha without changing the patch, and
    // must keep this block green. `patchIdOf` is supplied by the caller
    // (`check-evidence-fresh.ts`), never computed here — this module stays
    // `fs`/`git`-free. `null` from either side means "cannot answer" and is
    // never treated as a match.
    let samePatch = false
    if (patchIdOf) {
      const storedPatchId = patchIdOf(storedHead)
      const resolvedPatchId = patchIdOf(resolvedHead)
      samePatch = storedPatchId !== null && resolvedPatchId !== null && storedPatchId === resolvedPatchId
    }
    if (!samePatch) {
      const patchNote = patchIdOf ? ', and the patch changed' : ''
      errors.push(
        `evidence-fresh: Group B is stale — the block's Head (${storedHead}) does not match the PR's real head (${resolvedHead})${patchNote}. Re-run \`vinaya pr report --write\` against the current head, commit, and push again.`
      )
    }
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

  // Group C (task 12, Principal ruling PR `open-1`/`open-2`) — attested,
  // like Group B: the stored `#### C<n>: \`<command>\`` HEADING lines must
  // equal the body's own §9 command list, in order. Never re-run, never
  // byte-compared against fresh output, and — since `open-2` — never read
  // out of a fence's own contents either: a command's real output can
  // itself contain a line shaped like a delimiter (`bun run test` prints
  // its own `$ turbo test` progress line — and, discovered while adding
  // this fix's own mutation-proof test, even a line shaped exactly like a
  // `#### C<n>:` heading is possible inside a command's OUTPUT, not just
  // its actual next command).
  //
  // A heading-line-shaped decoy living INSIDE a fence is what this closes:
  // `resolved.maskedRegion` — the same index-preserving `maskCode` view
  // `summaryLineIndex` above already relies on — blanks every fenced span,
  // so a decoy line loses its `#### C<n>:` PREFIX there (that prefix carries
  // no backticks and survives masking untouched) exactly when it sits
  // inside a fence; a genuine heading, which always sits between fences,
  // keeps its prefix either way. Detection therefore reads the MASKED
  // line's prefix, never the raw one — but the command name itself is
  // backtick-wrapped, and `maskCode` ALSO blanks single-backtick inline
  // spans, so the command text is extracted from the RAW line at that same
  // index instead (masking is index-preserving line-for-line: splitting
  // both views on `\n` gives arrays the same length, in step).
  const hasGroupCSection = /^### Group C — Test Plan commands/m.test(resolved.maskedRegion)
  if (expectedGroupCCommandLines !== undefined && hasGroupCSection) {
    const HEADING_PREFIX = /^####\s+C\d+:/
    const COMMAND_HEADING_LINE = /^####\s+C\d+:\s+`(.*)`\s*$/
    const maskedLines = resolved.maskedRegion.split('\n')
    const rawLines = region.split('\n')
    const storedCommands: string[] = []
    for (let i = 0; i < maskedLines.length; i++) {
      if (!HEADING_PREFIX.test(maskedLines[i] as string)) continue
      const match = COMMAND_HEADING_LINE.exec(rawLines[i] as string)
      if (match) storedCommands.push(match[1] as string)
    }
    const expected = expectedGroupCCommandLines
    const mismatch = storedCommands.length !== expected.length || storedCommands.some((c, i) => c !== expected[i])
    if (mismatch) {
      errors.push(
        [
          "evidence-fresh: Group C's command headings do not match the PR body's own §9 Test Plan list.",
          `  block:    ${JSON.stringify(storedCommands)}`,
          `  expected: ${JSON.stringify(expected)}`
        ].join('\n')
      )
    }
  }

  return errors.length > 0 ? { status: 'fail', errors } : { status: 'pass' }
}
