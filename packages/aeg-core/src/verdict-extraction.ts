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
 * AEG:CLAIM: packages/aeg-core/src/verdict-extraction.ts contains:function firstFiveLines(comment: string): string {
 * The VALUE is windowed to the comment's first FIVE lines only
 * (review-convergence-v1 task 2, round 4, `#392`; widened by dev-review-loop-v1
 * task 2, `#412`, when `Objectives version:` became a third head line) —
 * never a line anywhere else in the body. Every shape this package's own
 * callers render puts the `VERDICT:`/`ESCALATE:` line first and `Judged
 * head:` third; `Objectives version:` fifth WHEN it renders at all (it is
 * omitted pre-cutover — a `null` objectives version). The precise guarantee
 * is narrower than "no caller content in the window": a caller-supplied
 * VALUE can appear inside the window, appended after a fixed, renderer-owned
 * label on the same line — code-review's `BRIEF CONFORMANCE: <value>` can
 * land on line 5 itself (pre-cutover, no scope evidence). In every shape
 * EXCEPT ONE, that label is what forecloses the value from ever reading as
 * `VERDICT:`/`Judged head:`/`Objectives version:`, regardless of which line
 * number it lands on. The one exception is `renderEscalationComment`'s
 * `input.summary`: pre-cutover, it becomes line 5 outright, with no label
 * ahead of it at all — a summary whose own first line happened to read
 * `VERDICT: APPROVE` would extract as a real verdict through this exact
 * window. Construction alone does not close that case; `review-post.ts`'s
 * `checkRenderedComment` does, mechanically, by re-running these same
 * extractors over the rendered text before any post and refusing an
 * escalation that re-parses as either verdict. Restricting the read window
 * to lines 1-5 closes a caller-controlled-text injection route without
 * narrowing what any real render needs matched; it is this module's own
 * contribution, not a claim that no render can still collide.
 *
 * AEG:CLAIM: packages/aeg-core/src/verdict-extraction.ts contains:function firstFiveLines(comment: string): string {
 * The CANDIDATE SET stays whole-body (review-convergence-v1 task 2, round 5,
 * `#392`) — round 4 windowed where a verdict's value is read, not which
 * comments count as a candidate at all. A comment whose only VERDICT-shaped
 * line sits outside its first five lines is still the most recent
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
 *
 * Ruling-freshness binding (`review-validity-v1` task 3, `#477`, O1). A
 * fifth field, `rulingOrdinal`, is read from the SAME winning comment via
 * `extractRulingOrdinal`/`firstSevenLines` — its OWN window, not
 * `firstFiveLines` widened in place (see that function's doc comment for
 * why: an out-of-surface `AEG:CLAIM` in `packages/sources` pins
 * `firstFiveLines`'s exact signature). `null` means no `Ruling ordinal:`
 * line at all — the pre-cutover stock — never confused with a rendered
 * `0`, which means a post-cutover verdict cast when the PR carried no
 * ruling yet.
 */

const HEAD_SHA_PATTERN = /^[ \t]*(?:\*{1,3}|_{1,3})?Judged head:\s*([0-9a-f]{7,40})(?![A-Za-z0-9])/im

/**
 * dev-review-loop-v1 task 2 (`#412`, O2): the render grows a third head
 * line — `Objectives version: <hash>` on line 5, blank line 6 — ONLY when a
 * non-null version exists; pre-cutover PRs omit it, and line 5 is then free
 * for the next fixed label instead (code-review's `BRIEF CONFORMANCE:`),
 * whose value can be the earliest caller-supplied text `renderCodeReviewComment`
 * itself ever puts on the wire. Same anchor discipline as `VERDICT:`/
 * `Judged head:`: line-start, optional leading emphasis run, no
 * blockquote/list-item/heading/code-span tolerance. The value is a sha256
 * hex string (64 hex chars, `objectivesOf`'s built form), never the loop
 * spec's superseded `number`.
 */
const OBJECTIVES_VERSION_PATTERN = /^[ \t]*(?:\*{1,3}|_{1,3})?Objectives version:\s*([0-9a-f]{64})(?![A-Za-z0-9])/im

/**
 * review-validity-v1 task 3 (`#477`, O1): a fourth head line, `Ruling
 * ordinal: <k>`, renders UNCONDITIONALLY on every post-cutover verdict —
 * `0` when no principal ruling existed on the PR at cast time, never
 * omitted the way `Objectives version:` is pre-cutover. Read from its OWN
 * wider window (`firstSevenLines`, below), never from `firstFiveLines`:
 * `packages/sources` carries an `AEG:CLAIM` binding on `firstFiveLines`'s
 * exact signature that this task's declared Surface excludes, so that
 * function's name, body, and 5-line reach stay byte-identical — widening
 * it in place would silently break that out-of-surface claim. The value is
 * a decimal ordinal (the marker's own `<pr>-<k>`, `k` monotone by
 * construction in `vinaya pr rule`), never a hash.
 */
const RULING_ORDINAL_PATTERN = /^[ \t]*(?:\*{1,3}|_{1,3})?Ruling ordinal:\s*(\d+)(?!\d)/im

/**
 * `review-validity-v1` task 4 (`#478`, O1): a fifth head line, `Brief hash:
 * <sha256>`, renders UNCONDITIONALLY on every post-cutover verdict right
 * after `Ruling ordinal:` — the frozen brief's own hash at dispatch time.
 * `null` means no such line at all — legacy stock from before this task, or
 * a rendered `(none)` placeholder when no frozen brief was resolvable for
 * that task/PR at cast time (never confused with a real 64-hex-char hash).
 * Read from its own wider window (`firstElevenLines`, below), same reasoning
 * as `RULING_ORDINAL_PATTERN`'s own `firstSevenLines`.
 */
const BRIEF_HASH_PATTERN = /^[ \t]*(?:\*{1,3}|_{1,3})?Brief hash:\s*([0-9a-f]{64})(?![A-Za-z0-9])/im

/**
 * `review-validity-v1` task 4 (`#478`, O5): a sixth head line, `Policy
 * digest: <sha256>`, renders UNCONDITIONALLY right after `Brief hash:` —
 * the effective review policy's digest at cast time. `null` means no such
 * line at all — legacy stock from before this task, or a stripped/malformed
 * line. Unlike the other fields this package extracts, a `null` echo here
 * is NEVER grandfathered (round 4 security MEDIUM): a policy is always
 * resolvable, so there is no genuine "nothing to bind against" case on the
 * current side to key forgiveness on the way brief-hash/objectives/ruling
 * each have — `review-input-manifest.ts`'s `isBoundToPolicy` requires an
 * exact digest match unconditionally.
 */
const POLICY_DIGEST_PATTERN = /^[ \t]*(?:\*{1,3}|_{1,3})?Policy digest:\s*([0-9a-f]{64})(?![A-Za-z0-9])/im

/**
 * AEG:CLAIM: packages/aeg-core/src/verdict-extraction.ts contains:function firstFiveLines(comment: string): string {
 * AEG:CLAIM: apps/cli/src/commands/review-post.ts contains:export function renderEscalationComment(input: EscalationInput): string {
 * AEG:CLAIM: apps/cli/src/commands/review-post.ts contains:export function checkRenderedComment(body: string, expectation: RenderExpectation): RenderCheckResult {
 * Round-4 ruling on `#392`, widened by dev-review-loop-v1 task 2 (`#412`):
 * all three markers are read from a comment's first FIVE lines only, never
 * anywhere else in the body. Every shape this package itself renders
 * (`review-post.ts`'s `renderCodeReviewComment`/`renderSecurityComment`/
 * `renderEscalationComment`) puts `VERDICT:`/`ESCALATE:` on line 1 and
 * `Judged head:` on line 3; `Objectives version:` lands on line 5 only when
 * non-null (pre-cutover PRs omit it). A caller-supplied field (findings,
 * conformance prose, scope) in `renderCodeReviewComment`/`renderSecurityComment`
 * never OPENS one of the first five lines — it can only ever appear appended
 * after a fixed, renderer-owned label already on that line, and code-review's
 * `BRIEF CONFORMANCE:` value can be that as early as line 5 itself
 * (pre-cutover, no scope evidence), not a fixed "line 6" or "line 7" floor.
 * `renderEscalationComment`'s `summary` is the one field this does NOT hold
 * for: pre-cutover, it IS line 5, unprefixed — construction alone does not
 * keep it out of the window, `checkRenderedComment`'s runtime self-check
 * does (see this file's module comment). Restricting the window to lines
 * 1–5 costs no real render anything: it is a strictly narrower read than
 * "anywhere in the body," and it closes the class of defect that motivated
 * this ruling — a caller-supplied field that smuggled a raw newline
 * followed by a `VERDICT:`-, `Judged head:`-, or `Objectives
 * version:`-shaped line could previously inject a structural line from
 * outside the command's own skeleton; that line can now never be read as
 * one.
 */
function firstFiveLines(comment: string): string {
  return comment.split('\n').slice(0, 5).join('\n')
}

function extractHeadSha(comment: string): string | null {
  const m = firstFiveLines(comment).match(HEAD_SHA_PATTERN)
  return m ? (m[1] as string).toLowerCase() : null
}

function extractObjectivesVersion(comment: string): string | null {
  const m = firstFiveLines(comment).match(OBJECTIVES_VERSION_PATTERN)
  return m ? (m[1] as string).toLowerCase() : null
}

/**
 * `review-validity-v1` task 3 (`#477`, O1): its own 7-line window, wider
 * than `firstFiveLines` by exactly the two lines `Ruling ordinal:` and its
 * preceding blank line add when `Objectives version:` also renders (worst
 * case: line 7). `null` means no `Ruling ordinal:` line at all — the
 * pre-cutover stock this task's Traps require staying bound whenever the
 * PR itself carries no ruling (`review-gate.ts`'s `isBoundToRulings`), not
 * `0` — `0` is only ever the RENDERED explicit value on a post-cutover
 * verdict.
 */
function firstSevenLines(comment: string): string {
  return comment.split('\n').slice(0, 7).join('\n')
}

function extractRulingOrdinal(comment: string): number | null {
  const m = firstSevenLines(comment).match(RULING_ORDINAL_PATTERN)
  return m ? Number.parseInt(m[1] as string, 10) : null
}

/**
 * `review-validity-v1` task 4 (`#478`, O1): its own 11-line window — worst
 * case, `Objectives version:`/blank (lines 5-6), `Ruling ordinal:`/blank
 * (7-8), `Brief hash:`/blank (9-10) all render ahead of `Policy digest:`,
 * which then lands on line 11. `null` means no `Brief hash:`/`Policy
 * digest:` line at all within that window.
 */
function firstElevenLines(comment: string): string {
  return comment.split('\n').slice(0, 11).join('\n')
}

function extractBriefHash(comment: string): string | null {
  const m = firstElevenLines(comment).match(BRIEF_HASH_PATTERN)
  return m ? (m[1] as string).toLowerCase() : null
}

function extractPolicyDigest(comment: string): string | null {
  const m = firstElevenLines(comment).match(POLICY_DIGEST_PATTERN)
  return m ? (m[1] as string).toLowerCase() : null
}

/**
 * `review-validity-v1` task 8 (`#506`, O2/O3): the FINDINGS block's own
 * severities, read from the WHOLE comment body — never `firstFiveLines`'s
 * window, since `renderFindingsSection` (`review-post.ts`) always renders
 * the findings list well past line five. This is what lets the merge gate
 * (`checkReviewGate`) and the loop's publication self-check evaluate the
 * SAME findings a reviewer's own `VERDICT:` line claims to summarize,
 * against repository policy, rather than trusting that line alone — a
 * reviewer's own `APPROVE` never overrides the evaluator (O3).
 *
 * `renderFindingsSection`'s exact numbered-bracket form —
 * `<n>. [SEVERITY] file:line — description` — is the only shape read here;
 * "None." (the empty-findings render) matches nothing, correctly yielding
 * `[]`. A hand-typed comment that never went through that renderer simply
 * contributes no severities, the same fail-safe direction `extractVerdict`
 * already takes for anything outside its own known shapes.
 *
 * Location is captured too (`doctrine-fixes-v1` task 1, `#543`, O5) — non-
 * greedy up to the ` — ` separator, so a location containing its own space
 * (`PR body`) is still captured whole rather than truncated at the first
 * space — this is what lets `evaluateReviewFindings`'s prose cap apply to a
 * re-parsed, hand-posted comment exactly as it does to a freshly-derived
 * finding, so the gate and the loop never disagree about a body/comment/
 * role-file finding either.
 */
const FINDING_SEVERITY_LINE = /^\d+\.\s+\[([A-Z][A-Z]*)\]\s+(.+?)\s+—/gm

function extractFindingSeverities(comment: string): { severity: string; location: string }[] {
  return [...comment.matchAll(FINDING_SEVERITY_LINE)].map((m) => ({
    severity: m[1] as string,
    location: m[2] as string
  }))
}

/**
 * AEG:CLAIM: packages/aeg-core/src/verdict-extraction.ts contains:function firstFiveLines(comment: string): string {
 * `headSha` is `null` in two distinct situations that both mean "cannot
 * confirm this verdict covers the current head": no verdict comment matched
 * at all (`danglingNote` is also set), or a verdict comment matched but
 * carried no `Judged head:` line (`danglingNote` is `null` — the verdict
 * itself is real, only the binding is missing). `review-gate.ts` treats both
 * as unbound; only their `danglingNote`/`value` differ. `objectivesVersion`
 * follows the same null-means-unbound rule (dev-review-loop-v1 task 2,
 * `#412`, O2): no version line in the winning comment's first five lines
 * reads as `null`, identical in shape to a missing `Judged head:` line.
 */
export type VerdictExtraction = {
  value: string
  headSha: string | null
  objectivesVersion: string | null
  /** `null` on the pre-cutover stock (no `Ruling ordinal:` line at all) — never conflated with a rendered `0` (`review-validity-v1` task 3, `#477`, O1). */
  rulingOrdinal: number | null
  /** `null` when no `Brief hash:` line was found (`review-validity-v1` task 4, `#478`, O1) — legacy stock, or no frozen brief resolvable at cast time. */
  briefHash: string | null
  /** `null` when no `Policy digest:` line was found (`review-validity-v1` task 4, `#478`, O5) — legacy stock only; every comment rendered from this task forward carries it unconditionally. */
  policyDigest: string | null
  /** The winning comment's own FINDINGS block severities and locations, whole-body read (`review-validity-v1` task 8, `#506`, O2/O3; location added `#543` O5) — `[]` on a DANGLING extraction (`danglingNote` set) or a comment with no findings at all. */
  findingSeverities: { severity: string; location: string }[]
  danglingNote: string | null
}

/**
 * AEG:CLAIM: packages/aeg-core/src/verdict-extraction.ts contains:function firstFiveLines(comment: string): string {
 * Round 5 (`#392`): the candidate set — which comments even ATTEMPTED a
 * verdict — is a whole-body test, the pre-round-4 pattern. Only the VALUE is
 * read from the first five lines (round 4, widened by task 2 `#412`). Round
 * 4's own change built `clearHits` from the windowed text directly, which
 * made a comment whose marker sits below the window vanish from
 * consideration entirely rather than counting as present-but-unclear —
 * "most recent clear hit wins" then silently fell through to an OLDER
 * comment, so a later blocking verdict that happened to render past the
 * window let an earlier clean pass win. Here, the most recent CANDIDATE is
 * picked first; only then is its value read from its own first five lines.
 * A candidate whose window carries no value is DANGLING — never skipped in
 * favour of an earlier one — so a later unclear comment still shadows an
 * earlier clean verdict, the fail-closed direction every other branch of
 * this function already takes.
 */
function extractVerdict(comments: string[], valuePattern: RegExp, missingLabel: string): VerdictExtraction {
  const candidates = comments.filter((c) => valuePattern.test(c))
  if (candidates.length === 0) {
    return {
      value: `no ${missingLabel} pass was run before merge — DANGLING, see below`,
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: `no ${missingLabel} verdict comment found on this PR`
    }
  }

  const latest = candidates[candidates.length - 1] as string
  const m = firstFiveLines(latest).match(valuePattern)
  if (!m) {
    // AEG:CLAIM: packages/aeg-core/src/verdict-extraction.ts contains:function firstFiveLines(comment: string): string {
    return {
      value: `the most recent ${missingLabel} comment's VERDICT line is not within its first five lines — DANGLING, see below`,
      headSha: null,
      objectivesVersion: null,
      rulingOrdinal: null,
      briefHash: null,
      policyDigest: null,
      findingSeverities: [],
      danglingNote: `the most recent ${missingLabel} verdict comment carries a VERDICT-shaped line outside the first-five-line read window`
    }
  }

  return {
    value: (m[1] as string).toUpperCase().replace(/[_-]/g, ' '),
    headSha: extractHeadSha(latest),
    objectivesVersion: extractObjectivesVersion(latest),
    rulingOrdinal: extractRulingOrdinal(latest),
    briefHash: extractBriefHash(latest),
    policyDigest: extractPolicyDigest(latest),
    findingSeverities: extractFindingSeverities(latest),
    danglingNote: null
  }
}

/**
 * The line-anchored `VERDICT:` marker prefix both value patterns below open
 * with — exported standalone, unchanged, character for character (a move,
 * not a rewrite: `#525` Stop-and-escalate; neither pattern below is edited)
 * so a second consumer can build the identical presence-only test without
 * hand-copying a third literal of the same fact. The generated review-gate
 * pre-check job (`apps/cli/src/lib/artifacts.ts`, task-run-v1 16/18, `#525`
 * O2) is that consumer: it runs before any checkout, so it cannot import
 * this module at workflow run time, and instead imports this source string
 * at CLI-generation time to build its own jq `test()` regex.
 */
export const VERDICT_MARKER_SOURCE = '^[ \\t]*(?:\\*{1,3}|_{1,3})?VERDICT:'

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
