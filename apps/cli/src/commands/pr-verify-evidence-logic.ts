/**
 * Pure comparison logic for `vinaya pr verify-evidence`.
 *
 * `evidence-fresh` closes fabrication for Group A by recomputing the diff stat
 * and exact-comparing it. It cannot do the same for Group B — its own docstring
 * says so — because Group B IS a `vinaya check --all --diff-only` run, and
 * `evidence-fresh` is itself registered in `coreCheckRegistry()`. A check that
 * regenerated the block would run the suite that contains it. That recursion is
 * why Group B was left attested, and the constraint is real.
 *
 * This module is the way out that does not recurse: regenerate the report OUTSIDE
 * the registry, then compare. Nothing here runs a check; the caller supplies both
 * the published region and a freshly generated one.
 *
 * The comparison is set-equality over normalised lines, not a byte diff. Three
 * sources of false difference were observed comparing a real pull request
 * (`#304`) against its own regeneration at its own head, and every one of them
 * would have made a byte diff useless:
 *
 *   1. Absolute paths — regenerated warnings embed the checkout root, which
 *      differs per machine and per worktree.
 *   2. Line order — a `workspace-escape` warning changed position between two
 *      runs at the same head.
 *   3. `AEG:TOKENS` appends by design, so whole-body comparison always differs.
 *      Handled by the caller extracting the evidence region only.
 *
 * A pure reordering is therefore reported as a match. That is deliberate: a
 * reordered warning set is not a fabrication, and flagging it would train the
 * reader to ignore this tool — the failure mode `body-bare-digits`' own docstring
 * warns about for over-eager gates.
 */

export type EvidenceVerdict =
  | { status: 'match' }
  | { status: 'no-block' }
  /**
   * A pair exists but sits inside a collapsed `<details>` block, where
   * `body-bare-digits` blanks every digit regardless. Nothing can verify what
   * such a block claims, and "unverifiable" must not be reported as "absent" —
   * the same three-way distinction `resolveAnchoredRegion` draws.
   */
  | { status: 'hidden' }
  | {
      status: 'differs'
      missing: string[]
      unexpected: string[]
      /**
       * Set when the published block also records a different merge-base.
       * REPORTED ALONGSIDE the content difference, never instead of it.
       *
       * An earlier revision returned base drift as its own verdict, computed
       * BEFORE any content comparison, and rendered "This is drift, NOT a
       * fabrication signal". The base is read from a line no gate verifies —
       * `evidence-fresh` compares only the `Head:` line, the numstat fence and
       * the `Summary:` line — so one planted `git diff <a>...<b> --numstat`
       * anywhere in the region bought an exoneration asserted after comparing
       * nothing. Content is now always compared, and drift is context.
       */
      baseDrift?: { publishedBase: string; currentBase: string }
    }

/**
 * The merge-base the published block was generated against, read back from the
 * Group A command line `renderGroupA` emits.
 *
 * Anchored to line start and to that exact shape. An unanchored first-match
 * scan let one planted `git diff <a>...<b> --numstat` line, valid anywhere in
 * the region including prose, decide the verdict — and the line is checked by
 * no gate, since `evidence-fresh` compares only the `Head:` line, the numstat
 * fence and the `Summary:` line.
 */
export function publishedMergeBase(region: string): string | null {
  // `[ \t]*` rather than `\s*`: with `\s` (which matches newlines) and the `m`
  // flag, the leading and trailing quantifiers overlap across lines and the
  // match goes quadratic — measured at 3.5s on a 65 KB body, and this runs
  // twice per invocation over attacker-authored text.
  const m = region.match(/^[ \t]*`git diff ([0-9a-f]{7,40})\.\.\.[0-9a-f]{7,40} --numstat`[ \t]*$/m)
  return m ? (m[1] as string) : null
}

/**
 * Repo-relative, trimmed, blank-free lines.
 *
 * `repoRoot` is stripped wherever it appears, not only at line start: the
 * observed warnings embed it mid-line, after `warning: `. A trailing separator
 * is tolerated so both `/path/to/repo` and `/path/to/repo/` behave the same.
 */
export function normaliseLines(region: string, repoRoot: string): string[] {
  const root = repoRoot.replace(/\/+$/, '')
  const out: string[] = []
  for (const raw of region.split('\n')) {
    // Two passes, because the published block and the fresh one are often
    // generated on DIFFERENT machines — CI and a laptop — and only the local
    // root is known here.
    //
    // The second pass is anchored HARD, and the anchoring is the whole safety
    // property. An earlier revision matched any interior segment sitting before
    // a known directory name, which collapsed two genuinely different in-repo
    // files onto one line — `packages/sources/tests/a.spec.ts` and
    // `packages/aeg-core/tests/a.spec.ts` both became `packagestests/a.spec.ts`
    // — and a body containing both then compared MATCH. That is the exact
    // false-MATCH class this command refuses a dirty worktree to prevent, and
    // it was reachable from pull-request text alone.
    //
    // So: only an ABSOLUTE path, only at a token boundary (line start or after
    // whitespace), and only immediately before a real top-level entry of this
    // repository. `tests` is deliberately absent from that list — it is not a
    // top-level directory here, and including it is what made the match
    // interior. A relative path is never rewritten.
    const localStripped = root ? raw.split(`${root}/`).join('').split(root).join('') : raw
    const stripped = localStripped.replace(
      /(^|\s)\/\S*?\/(?=(?:apps|packages|aeg-root|scripts|\.changeset|\.vinaya|\.github)\/)/g,
      '$1'
    )
    // C0 controls and DEL are removed before anything is echoed. These lines
    // come from a pull-request body, which in an adopter repo is written by
    // whoever opened it; an ESC/CR sequence can otherwise repaint a terminal
    // or an ANSI-rendering CI log and forge this tool's own MATCH text over
    // its DIFFERS header. Stripping here rather than at render time keeps the
    // comparison and the output reading the same bytes.
    // C0 and DEL, plus the vectors a C0-only strip leaves behind: U+0080-U+009F
    // (C1, including U+009B CSI — an alternate escape introducer), U+0085 /
    // U+2028 / U+2029 (Unicode line terminators, which can split one line into
    // two in a renderer), and U+202A-U+202E / U+2066-U+2069 (bidi overrides,
    // which reorder displayed text without changing bytes). All of these reach
    // a terminal or an ANSI-rendering CI log through the rendered verdict.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    const line = stripped.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ').trim()
    if (line) out.push(line)
  }
  return out
}

/**
 * Compares a published region against a freshly generated one.
 *
 * `missing` — present in the regeneration, absent from what was published. This
 * is the fabrication signal: the real run produced findings the published block
 * does not show.
 *
 * `unexpected` — published but not reproducible. Either the block is stale
 * (generated at an older head) or lines were added by hand.
 *
 * Multiplicity is preserved: two identical warning lines that became one is a
 * real difference, so this counts occurrences rather than comparing sets of
 * distinct strings.
 */
export function compareEvidence(
  published: { region: string } | 'hidden' | null,
  freshRegion: string,
  repoRoot: string
): EvidenceVerdict {
  if (published === null) return { status: 'no-block' }
  if (published === 'hidden') return { status: 'hidden' }

  const publishedLines = normaliseLines(published.region, repoRoot)
  const freshLines = normaliseLines(freshRegion, repoRoot)

  const missing = subtractOnce(freshLines, publishedLines)
  const unexpected = subtractOnce(publishedLines, freshLines)

  if (missing.length === 0 && unexpected.length === 0) return { status: 'match' }

  // Drift is attached to the difference, never substituted for it. Whether the
  // base moved changes what the reader should DO — rebase, then regenerate —
  // but it can never license a claim that the content was honest, because that
  // claim would rest on a comparison this function did run and did not pass.
  const publishedBase = publishedMergeBase(published.region)
  const currentBase = publishedMergeBase(freshRegion)
  const baseDrift =
    publishedBase && currentBase && publishedBase !== currentBase ? { publishedBase, currentBase } : undefined

  return baseDrift ? { status: 'differs', missing, unexpected, baseDrift } : { status: 'differs', missing, unexpected }
}

/** Every element of `a` not cancelled by an equal element of `b`, one for one. */
function subtractOnce(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>()
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1)
  const out: string[] = []
  for (const line of a) {
    const n = counts.get(line) ?? 0
    if (n > 0) counts.set(line, n - 1)
    else out.push(line)
  }
  return out
}

/** Human-readable report. Exported so the bin stays a thin I/O shim. */
export function renderVerdict(verdict: EvidenceVerdict): string {
  if (verdict.status === 'match') {
    return 'pr verify-evidence: MATCH — every line of the published AEG:EVIDENCE region is reproduced by a fresh run at this head, and vice versa (compared as a multiset of repo-relative, control-stripped lines: order and whitespace are not compared).'
  }
  if (verdict.status === 'no-block') {
    return 'pr verify-evidence: NO BLOCK — this pull request body carries no AEG:EVIDENCE anchors. Run `vinaya pr report --write <body-file>` to generate one.'
  }
  if (verdict.status === 'hidden') {
    return [
      'pr verify-evidence: HIDDEN — the AEG:EVIDENCE pair sits inside a collapsed `<details>` block.',
      '`body-bare-digits` blanks every digit in there, so nothing can verify what it claims. Move the block out of `<details>` and regenerate it with `vinaya pr report --write <body-file>`.'
    ].join('\n')
  }
  const lines = ['pr verify-evidence: DIFFERS — the published AEG:EVIDENCE region does not reproduce at this head.']
  if (verdict.baseDrift) {
    lines.push(
      '',
      `The published block also records a different merge-base (${verdict.baseDrift.publishedBase}) than the one resolving now (${verdict.baseDrift.currentBase}).`,
      'That explains SOME differences — the gates ran over a different diff — but it is not on its own evidence the content was honest, and the differing lines are still listed below. Rebase or regenerate, then re-run this command to compare at a shared base.'
    )
  } else {
    lines.push(
      'No merge-base difference was detected — either the base is unchanged, or one side carries no readable Group A command line to compare. Drift therefore does not account for this difference.'
    )
  }
  lines.push('', 'Regenerate with `vinaya pr report --write <body-file>` and push.')
  if (verdict.missing.length > 0) {
    lines.push('', `Present in a fresh run, absent from the published block (${verdict.missing.length}):`)
    for (const line of verdict.missing) lines.push(`  + ${line}`)
  }
  if (verdict.unexpected.length > 0) {
    lines.push('', `Published but not reproducible (${verdict.unexpected.length}):`)
    for (const line of verdict.unexpected) lines.push(`  - ${line}`)
  }
  return lines.join('\n')
}

import type { SurfaceExemption } from '../lib/surface-exemption'

// Not a command — colocated lib code (see apps/cli/tests/surface-index.test.ts's
// orphan-file check). Retires by moving to apps/cli/src/lib/ in the next task
// touching pr-verify-evidence.
export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'pr-verify-evidence-logic.ts': { date: '2026-09-05', callsToday: 0, retiresVia: 'apps/cli/src/lib/' }
}
