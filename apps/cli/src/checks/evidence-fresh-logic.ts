/**
 * Pure comparison logic for the `evidence-fresh` check (fix/pr-report-emitter).
 * No `fs`, no `git`/`gh` — every fact this needs (the anchored region's text,
 * the PR's actual head sha, the actual recomputed `--numstat`) is supplied by
 * the caller, so this is unit-testable with plain string fixtures alone. The
 * `check-evidence-fresh.ts` bin is the thin wiring that gathers those facts
 * via `gh`/`git` and calls this.
 *
 * One caveat on the text compared: the region reaches this function already
 * normalised (zero-width stripped, named entities decoded), because it has to
 * be the same text `body-bare-digits` scanned. Group A is byte-compared against
 * verbatim `git` output, so a path containing a named-entity sequence would be
 * decoded on one side and not the other. That needs a filename like
 * `a&amp;lt;b`, so it is a documented edge rather than a live risk, and it
 * fails closed.
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

import { maskCode, maskDetailsBlocks } from '@attalabs/aeg-forge-state/strip-code'
import { EVIDENCE_SUMMARY_PREFIX, summariseNumstat } from '../lib/numstat'

export type EvidenceCompareResult = { status: 'pass' } | { status: 'fail'; errors: string[] }

const HEAD_LINE = /^Head:\s*([0-9a-f]{7,40})\s*$/m
const FENCE = /```[^\n]*\n?([\s\S]*?)```/g

/**
 * The first `Summary:` line that `body-bare-digits` would exempt — which is the
 * first one that survives the SAME masking that check applies, not simply the
 * first one in the text.
 *
 * The distinction is the whole finding. `body-bare-digits` runs `maskCode` and
 * `maskDetailsBlocks` before it ever looks for the summary, so a `Summary:`
 * line hidden inside a fence or a `<details>` block is invisible to it and the
 * next one — in prose — becomes the line it exempts. While this side matched
 * the raw region, the two disagreed about which line "first" meant: the hidden
 * one was verified while a fabricated prose line was exempted, scoring zero
 * violations AND a passing `evidence-fresh` on a false headline figure.
 *
 * Reusing the very functions the other side calls is the point. A local
 * re-implementation closed backtick fences and `<details>` and still left tilde
 * fences, three-space-indented fences and CRLF open — each a separate spelling
 * of the same hole. `maskCode` blanks with same-length spaces, so a line index
 * in the masked text addresses the same line in the raw text, and the value
 * compared is the real one.
 *
 * `maskedRegion` matters because masking is CONTEXT-SENSITIVE. `body-bare-digits`
 * masks the whole body and slices the region out of the result; masking the
 * region alone is not the same operation. A `<details>` pair wrapping the
 * region — one tag above the START anchor, one below the END — is invisible
 * from inside the region, so this side saw no masking and read the honest
 * line while the other side saw the entire region blanked. The bin passes the
 * body-masked slice; the fallback is for callers holding a region alone, where
 * no straddling context exists to miss.
 */
export function firstScannableSummary(region: string, maskedRegion?: string): string | null {
  const raw = region.split('\n')
  const masked = (maskedRegion ?? maskDetailsBlocks(maskCode(region))).split('\n')
  for (let i = 0; i < masked.length; i++) {
    if ((masked[i] as string).startsWith(EVIDENCE_SUMMARY_PREFIX)) {
      return (raw[i] as string).slice(EVIDENCE_SUMMARY_PREFIX.length).trimEnd()
    }
  }
  return null
}

/**
 * Compares an already-located `AEG:EVIDENCE` region against the facts a
 * checker can independently derive. Assumes the caller already handled the
 * "no block" / "no PR body" / "no PR yet" bypasses — `region` here is always
 * real anchor content.
 */
export function compareEvidenceBlock(
  region: string,
  resolvedHead: string,
  actualNumstat: string,
  maskedRegion?: string
): EvidenceCompareResult {
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

  // The `Summary:` line is derived from the same numstat, so it is checkable
  // rather than attested — and it must be, or the block's headline figure
  // would be its only unverified claim. Absent is fine: bodies written before
  // the emitter produced this line are still valid.
  const stored = firstScannableSummary(region, maskedRegion)
  if (stored !== null) {
    const expected = summariseNumstat(actual)
    if (stored !== expected) {
      errors.push(
        [
          "evidence-fresh: the block's `Summary:` line does not match its own numstat.",
          `  block:  ${JSON.stringify(stored)}`,
          `  actual: ${JSON.stringify(expected)}`
        ].join('\n')
      )
    }
  }

  return errors.length > 0 ? { status: 'fail', errors } : { status: 'pass' }
}
