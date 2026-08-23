/**
 * The one-line summary of Group A's numstat: how many files, how many lines.
 *
 * Derived, never typed — which is the entire point. A PR body that restates
 * "five files changed" in prose has a second copy of a fact whose first copy
 * sits feet below it, regenerated on every write, and the prose copy loses
 * that race every time. Measured on atta-labs/vinaya#185: the file count went
 * stale three times and the pasted `--stat` twice, each time because a commit
 * landed after the sentence was written. Putting the summary INSIDE the block
 * removes the reason to write the sentence at all.
 *
 * Binary files report `-` for both counts in `--numstat`; they count toward
 * the file total and contribute nothing to the line totals.
 *
 * The grammar is this function's own, not `git diff --shortstat`'s: it always
 * emits all three clauses and appends a binary count, where `--shortstat`
 * omits zero clauses, prints nothing at all for an empty diff, and has no
 * binary suffix. A fixed shape is what lets `evidence-fresh` recompute the
 * line and byte-compare it.
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
 * Exported because `body-bare-digits` exempts this line and `evidence-fresh`
 * verifies it, and those two must describe the SAME set of lines. When the
 * exemption was written independently it was broader — case-insensitive, any
 * leading whitespace, every occurrence — while the verifier matched only the
 * first, column-0, case-sensitive one. A lowercase `summary: 900 files
 * changed…`, an indented one, or a second one after the honest one was
 * therefore exempt from the digit check and never compared against anything.
 * A shared constant is necessary but was not sufficient: the two sides also
 * have to read the same TEXT. `body-bare-digits` blanks fenced and `<details>`
 * content before looking for the summary, so while `evidence-fresh` matched the
 * raw region the two disagreed about which line came "first" — a `Summary:`
 * inside the Group B fence was verified while a fabricated one in prose was
 * exempted. `firstScannableSummary` in `evidence-fresh-logic.ts` calls the very
 * same `maskCode`/`maskDetailsBlocks` the other side calls, rather than
 * reckoning those spans itself — a local re-implementation closed backtick
 * fences and `<details>` and still left tilde fences, three-space-indented
 * fences and CRLF open, each a separate spelling of one hole. Sharing the
 * constant AND the substrate is what makes "exempt because it is verified"
 * true rather than merely intended.
 */
export const EVIDENCE_SUMMARY_PREFIX = 'Summary: '

/** Matches the first emitted `Summary:` line in a region, capturing its value. */
export const EVIDENCE_SUMMARY_LINE = /^Summary: (.+)$/m
