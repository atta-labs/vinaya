/**
 * The one-line summary of Group A's numstat: how many files, how many lines.
 *
 * Derived, never typed — which is the entire point. A PR body that restates
 * "five files changed" in prose has a second copy of a fact whose first copy
 * sits feet below it, regenerated on every write, and the prose copy loses that
 * race every time. Measured live: the file count went
 * stale three times and the pasted `--stat` twice, each time because a commit
 * landed after the sentence was written. Putting the summary INSIDE the block
 * removes the reason to write the sentence at all.
 *
 * Binary files report `-` for both counts in `--numstat`; they count toward the
 * file total and contribute nothing to the line totals.
 *
 * The grammar is this function's own, not `git diff --shortstat`'s: it always
 * emits all three clauses and appends a binary count, where `--shortstat` omits
 * zero clauses, prints nothing at all for an empty diff, and has no binary
 * suffix. A fixed shape is what lets `evidence-fresh` recompute the line and
 * byte-compare it.
 */
export function summariseNumstat(numstat: string): string {
  const rows = numstat.split('\n').filter((l) => l.trim() !== '')
  let added = 0
  let deleted = 0
  let binary = 0
  for (const row of rows) {
    const [a, d] = row.split('\t')
    if (a === '-' || d === '-') {
      binary++
      continue
    }
    added += Number(a) || 0
    deleted += Number(d) || 0
  }
  const files = `${rows.length} file${rows.length === 1 ? '' : 's'} changed`
  const bin = binary > 0 ? `, ${binary} binary` : ''
  return `${files}, ${added} insertion${added === 1 ? '' : 's'}(+), ${deleted} deletion${deleted === 1 ? '' : 's'}(-)${bin}`
}

/**
 * The exact shape `buildBlockInner` emits: column 0, one space, case-sensitive.
 *
 * Shared by the writer (`pr report --write`) and the reader
 * (`check-evidence-fresh`), which must name the same line. The VALUE after this
 * prefix is emitted inside an inline code span, so `maskCode` blanks its digits
 * for `body-bare-digits` without any exemption — see `buildBlockInner`'s doc
 * for why an exemption could not have bootstrapped past a check pinned to the
 * default branch.
 *
 * A shared constant is necessary and NOT sufficient: the reader also has to
 * select from the right TEXT, which is why it does not scan for this prefix
 * itself — it calls `summaryLineIndex` (`checks/scan-context.ts`), which
 * selects on the masked view of the region from a shared `ScanContext`.
 */
export const EVIDENCE_SUMMARY_PREFIX = 'Summary: '
