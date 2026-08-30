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

const EVIDENCE_START = '<!-- AEG:EVIDENCE:START -->'
const EVIDENCE_END = '<!-- AEG:EVIDENCE:END -->'

export type EvidenceVerdict =
  | { status: 'match' }
  | { status: 'no-block' }
  | { status: 'differs'; missing: string[]; unexpected: string[] }

/**
 * The text between the anchors, or `null` when the body carries no block.
 * Anchors are matched literally: a fenced or quoted mention inside prose is not
 * an anchor, and must not be treated as one.
 */
export function extractEvidenceRegion(body: string): string | null {
  const start = body.indexOf(EVIDENCE_START)
  if (start === -1) return null
  const end = body.indexOf(EVIDENCE_END, start + EVIDENCE_START.length)
  if (end === -1) return null
  return body.slice(start + EVIDENCE_START.length, end)
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
    const line = (root ? raw.split(`${root}/`).join('').split(root).join('') : raw).trim()
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
  publishedRegion: string | null,
  freshRegion: string,
  repoRoot: string
): EvidenceVerdict {
  if (publishedRegion === null) return { status: 'no-block' }

  const published = normaliseLines(publishedRegion, repoRoot)
  const fresh = normaliseLines(freshRegion, repoRoot)

  const missing = subtractOnce(fresh, published)
  const unexpected = subtractOnce(published, fresh)

  if (missing.length === 0 && unexpected.length === 0) return { status: 'match' }
  return { status: 'differs', missing, unexpected }
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
    return 'pr verify-evidence: MATCH — the published AEG:EVIDENCE region reproduces exactly at this head.'
  }
  if (verdict.status === 'no-block') {
    return 'pr verify-evidence: NO BLOCK — this pull request body carries no AEG:EVIDENCE anchors. Run `vinaya pr report --write <body-file>` to generate one.'
  }
  const lines = [
    'pr verify-evidence: DIFFERS — the published AEG:EVIDENCE region does not reproduce at this head.',
    'It was hand-edited, or generated against a different head. Regenerate with `vinaya pr report --write <body-file>` and push.'
  ]
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
