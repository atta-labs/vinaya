/**
 * Shared code-reviewer / security-review verdict extraction (aeg-review-gate-v1
 * task 1, #474). Originally private to `archive-task.ts`'s post-merge
 * provenance assembly (advisory-only, DANGLING on a missing/unclear verdict).
 * Extracted so the pre-merge `review-gate.ts` blocking check calls the
 * IDENTICAL regex/parsing logic — a future drift between two copies of the
 * same pattern would silently reopen the gap this task exists to close (one
 * implementation per fact, §11 constraint). Pure — no `fs`, no `fetch`.
 *
 * Picks the MOST RECENT comment carrying a clear value, not the first comment
 * merely matching the pattern (aeg-review-gate-v1 task 1 fix — the original
 * single-comment `.find()` broke on real multi-comment PRs: a REQUEST_CHANGES
 * verdict followed by fixes and a later clean APPROVE).
 *
 * Line-anchored `VERDICT:` marker only — NOT a bare word search anywhere in
 * the comment (aeg-review-gate-v1 task 1 follow-up, security-review FAIL
 * finding, confirmed by direct execution: the old bare `\b(PASS|FAIL)\b`
 * pattern matched the post-merge Archivist's own auto-generated DANGLING
 * placeholder text — "no security-review pass was run before merge —
 * DANGLING, see below" — as a clean PASS, since it contains the standalone
 * word "pass". Same risk in reverse for "APPROVE" inside ordinary prose,
 * e.g. "I do NOT approve of that design"). `^\s*VERDICT:\s*<value>\b`,
 * multiline, is the real subagent contract (`roles/reviewer.md`/
 * `roles/security.md`'s own VERDICT block, which `.claude/agents/
 * code-reviewer.md`/`security-reviewer.md` require verbatim) — tightening
 * to it closes the gap without inventing a new convention.
 *
 * The VALUE is windowed to the comment's first THREE lines only
 * (review-convergence-v1 task 2, round 4, `#392`) — never a line anywhere
 * else in the body. Every shape this package's own callers render puts the
 * `VERDICT:`/`ESCALATE:` line first and `Judged head:` third; a
 * caller-supplied field (findings, conformance prose, a summary) never
 * renders before line 5. Restricting the read window closes a
 * caller-controlled-text injection route without narrowing what any real
 * render needs matched.
 *
 * The CANDIDATE SET stays whole-body (review-convergence-v1 task 2, round 5,
 * `#392`) — round 4 windowed where a verdict's value is read, not which
 * comments count as a candidate at all. A comment whose only VERDICT-shaped
 * line sits outside its first three lines is still the most recent
 * candidate if it is the most recent comment; it reads as DANGLING rather
 * than being skipped, so it correctly shadows an earlier clean verdict
 * instead of silently letting the earlier one win.
 *
 * The anchor tolerates a leading markdown EMPHASIS run — one to three `*` or
 * `_`, immediately abutting the token — so `**VERDICT: APPROVE**` and
 * `_VERDICT: APPROVE_` match (PR #636: the reviewer subagent emitted the
 * bolded form and the gate read the PR as carrying no code-review verdict at
 * all). The spec still mandates the bare line; this only stops an agent's
 * markdown drift from silently DANGLING a real verdict.
 *
 * Emphasis ONLY — the following are deliberately NOT tolerated, because each
 * is a way for prose to *mention* a verdict rather than *cast* one, and this
 * gate blocks merges (#639 review, findings 1/3/5):
 *   `> VERDICT: APPROVE`   blockquote — GitHub's quote-reply syntax. A
 *                          Developer quoting the reviewer's earlier text
 *                          would otherwise become the PR's own verdict, and
 *                          most-recent-hit-wins means the quote beats a live
 *                          REQUEST CHANGES. Fail-open and silent.
 *   `* VERDICT: APPROVE`   list item — the space is what distinguishes it
 *                          from emphasis; a bullet is prose context. `-` and
 *                          `1.` never matched, so `*` must not either.
 *   `# VERDICT: APPROVE`   heading — same mention-not-cast reasoning.
 *   `` `VERDICT: APPROVE` ``  code span — decided, not overlooked. A
 *                          backticked marker is exactly how the role docs
 *                          and this comment WRITE about the contract, so
 *                          tolerating it would match prose describing the
 *                          rule. If a real agent ever emits the backticked
 *                          form, fix the agent: it fails loud (DANGLING),
 *                          which is the safe direction.
 *
 * The value-side boundary is `(?![A-Za-z0-9])`, not `\b`: `_` is a word
 * character, so `\b` after the captured value would reject the closing `_` of
 * `_VERDICT: APPROVE_` while accepting the `*` of the bolded form — the class
 * and the claim would disagree. It still rejects `APPROVED`/`PASSED`.
 *
 * What is NOT loosened is the requirement that a literal `VERDICT:` token be
 * present — ordinary prose and the Archivist's own DANGLING placeholder still
 * miss.
 *
 * No separate "marker present but value unclear" branch: a generic
 * `VERDICT:`-prefix-only marker would itself cross-contaminate the two
 * extractors (a security reviewer's own `VERDICT: PASS` line would loosely
 * match the code-review marker too, misreporting "code-reviewer comment
 * found but unclear" for a comment that was never a code review at all).
 * Anything that doesn't match the exact value pattern reads as "missing",
 * identical to no comment existing — which is also what the DANGLING
 * placeholder case above requires.
 *
 * Reviewed-commit binding (#73, a duplicate of #71 closes this one). The
 * winning comment (the one whose `VERDICT:` line matched) is also searched
 * for a `Judged head: <sha>` line — the exact phrase reviewers on
 * atta-labs/attalabs#664 were already hand-typing before this existed as a
 * mechanism, formalized rather than invented. Same anchor discipline as
 * `VERDICT:` itself: line-start, optional leading emphasis run, no
 * blockquote/list-item/heading/code-span tolerance — a sha mentioned in
 * ordinary prose ("see 8365ca57 for context") is a mention, not a binding,
 * and must not parse as one. Accepts both the abbreviated (7-char) and full
 * (40-char) hex forms; `review-gate.ts` does the prefix comparison against
 * the PR's actual head. Searched only within the SAME comment body that
 * produced the winning verdict — a sha mentioned in a different comment is
 * not this verdict's binding.
 */

const HEAD_SHA_PATTERN = /^[ \t]*(?:\*{1,3}|_{1,3})?Judged head:\s*([0-9a-f]{7,40})(?![A-Za-z0-9])/im

/**
 * Round-4 ruling on `#392`: both markers are read from a comment's first
 * THREE lines only, never anywhere else in the body. Every shape this
 * package itself renders (`review-post.ts`'s `renderCodeReviewComment`/
 * `renderSecurityComment`/`renderEscalationComment`) puts `VERDICT:`/
 * `ESCALATE:` on line 1 and `Judged head:` on line 3 — every caller-supplied
 * field (findings, conformance prose, scope, a summary) renders strictly
 * after that, starting at line 5 at the earliest. Restricting the window to
 * lines 1–3 costs no real render anything: it is a strictly narrower read
 * than "anywhere in the body," and it closes the class of defect that
 * motivated this ruling — a caller-supplied field that smuggled a raw
 * newline followed by a `VERDICT:`- or `Judged head:`-shaped line could
 * previously inject a structural line from outside the command's own
 * three-line skeleton; that line can now never be read as one.
 */
function firstThreeLines(comment: string): string {
  return comment.split('\n').slice(0, 3).join('\n')
}

function extractHeadSha(comment: string): string | null {
  const m = firstThreeLines(comment).match(HEAD_SHA_PATTERN)
  return m ? (m[1] as string).toLowerCase() : null
}

/**
 * `headSha` is `null` in two distinct situations that both mean "cannot
 * confirm this verdict covers the current head": no verdict comment matched
 * at all (`danglingNote` is also set), or a verdict comment matched but
 * carried no `Judged head:` line (`danglingNote` is `null` — the verdict
 * itself is real, only the binding is missing). `review-gate.ts` treats both
 * as unbound; only their `danglingNote`/`value` differ.
 */
export type VerdictExtraction = { value: string; headSha: string | null; danglingNote: string | null }

/**
 * Round 5 (`#392`): the candidate set — which comments even ATTEMPTED a
 * verdict — is a whole-body test, the pre-round-4 pattern. Only the VALUE is
 * read from the first three lines (round 4, kept). Round 4's own change
 * built `clearHits` from the windowed text directly, which made a comment
 * whose marker sits below line 3 vanish from consideration entirely rather
 * than counting as present-but-unclear — "most recent clear hit wins" then
 * silently fell through to an OLDER comment, so a later blocking verdict
 * that happened to render past line 3 let an earlier clean pass win. Here,
 * the most recent CANDIDATE is picked first; only then is its value read
 * from its own first three lines. A candidate whose window carries no value
 * is DANGLING — never skipped in favour of an earlier one — so a later
 * unclear comment still shadows an earlier clean verdict, the fail-closed
 * direction every other branch of this function already takes.
 */
function extractVerdict(comments: string[], valuePattern: RegExp, missingLabel: string): VerdictExtraction {
  const candidates = comments.filter((c) => valuePattern.test(c))
  if (candidates.length === 0) {
    return {
      value: `no ${missingLabel} pass was run before merge — DANGLING, see below`,
      headSha: null,
      danglingNote: `no ${missingLabel} verdict comment found on this PR`
    }
  }

  const latest = candidates[candidates.length - 1] as string
  const m = firstThreeLines(latest).match(valuePattern)
  if (!m) {
    return {
      value: `the most recent ${missingLabel} comment's VERDICT line is not within its first three lines — DANGLING, see below`,
      headSha: null,
      danglingNote: `the most recent ${missingLabel} verdict comment carries a VERDICT-shaped line outside the first-three-line read window`
    }
  }

  return {
    value: (m[1] as string).toUpperCase().replace(/[_-]/g, ' '),
    headSha: extractHeadSha(latest),
    danglingNote: null
  }
}

/** `value` is `APPROVE`, `REQUEST CHANGES`, `LGTM`, or a DANGLING placeholder string. */
export function extractCodeReviewVerdict(comments: string[]): VerdictExtraction {
  return extractVerdict(
    comments,
    /^[ \t]*(?:\*{1,3}|_{1,3})?VERDICT:\s*(APPROVE|REQUEST[ _-]?CHANGES|LGTM)(?![A-Za-z0-9])/im,
    'code-reviewer'
  )
}

/** `value` is `PASS`, `FAIL`, or a DANGLING placeholder string. */
export function extractSecurityReviewVerdict(comments: string[]): VerdictExtraction {
  return extractVerdict(
    comments,
    /^[ \t]*(?:\*{1,3}|_{1,3})?VERDICT:\s*(PASS|FAIL)(?![A-Za-z0-9])/im,
    'security-review'
  )
}
