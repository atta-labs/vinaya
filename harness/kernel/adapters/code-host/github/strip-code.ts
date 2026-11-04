/**
 * CommonMark code recognition for forge bodies — "the body, minus its
 * examples". Pure — no `fs`, no `gh`/`git`.
 *
 * **Why it lives here and not in `@attalabs/aeg-core`.** It was written there
 * (`anchored-region.ts`, in an earlier consolidation pass), and `aeg-core` is still where `anchoredRegion`
 * and every anchored-field consumer live — `anchored-region.ts` re-exports
 * `stripCode` so those call sites are unchanged. But the grammar itself had to
 * come down one layer: `list-tasks.ts`'s `projectFieldFromBody` reads the same
 * body and must ignore fenced examples the same way, and `aeg-core` already
 * depends on this package (`issue-validation.ts` imports `projectsFromBody`),
 * so importing upward would close a cycle. Duplicating the scanners here would
 * be worse still — two code-recognition grammars for one body is the exact
 * defect class that consolidation removed. Moving them down is the only shape that leaves
 * **one** implementation with the dependency arrow pointing the way it already
 * points. This package is the repo's pure forge-body parsing layer
 * (`parse-rationale-deps.ts`, `list-tasks.ts`), which is what this grammar is.
 */

/**
 * Replaces fenced code blocks, indented code blocks, and inline code spans with
 * same-length filler so marker *positions* can be searched code-blind while
 * every index still maps 1:1 onto the original body (the returned region is
 * always sliced from the original, never from the mask).
 *
 * **This is the same code recognition as `stripCode`, and must stay so.** It ran
 * on the naive `` /```[\s\S]*?```/g `` + single-backtick regexes long after
 * `stripCode` was hardened off them, 27 lines below in this same file — so a
 * decoy `AEG:CLOSES` anchor inside a tilde fence, a ≥4-backtick fence, or a
 * double-backtick span was invisible to the mask, won `anchoredRegion`, and
 * `extractClosesReferences`/`extractIssue` then resolved a *wrong* Issue number
 * (caught in review). That is worse than the strandings that fix exists for: the
 * post-merge Archivist reads `extractIssue` to explicitly close the Issue, so
 * the failure mode is closing an unrelated Issue, not failing to close one. The
 * two functions differ **only** in what they emit for a code line — filler here,
 * nothing in `stripCode` — which is why both delegate to the same scanners
 * rather than each carrying a copy of the grammar. A divergence between them is
 * a bug by construction, not a style difference.
 *
 * Unlike `stripCode`, this one **must not normalise line endings**: doing so
 * would change the body's length and break the 1:1 index mapping that is this
 * function's entire purpose. The fence patterns therefore tolerate a trailing
 * `\r` themselves, and the filler covers it (a masked `\r` becomes a space —
 * same length, and the mask is never read as text, only searched for marker
 * positions).
 */
export function maskCode(body: string): string {
  const fill = (line: string) => ' '.repeat(line.length)
  const blocksMasked = maskIndentedCode(maskFencedCode(body, fill), fill)
  return blocksMasked
    .split('\n')
    .map((line) => replaceInlineSpans(line, (span) => ' '.repeat(span.length)))
    .join('\n')
}

/** A `<details ...>` opening tag (not the self-closed `<details/>` shape — not in real use here). */
const DETAILS_OPEN = /<details\b[^>]*>/gi
/** A `</details>` closing tag, tolerant of interior whitespace. */
const DETAILS_CLOSE = /<\/details\s*>/gi

/**
 * Blanks (same-length-masks, index-preserving — this function has only one
 * mode; every caller needs positions, not shortened text) `<details>…</details>`
 * blocks — this repo's standing convention (`aeg-root/templates/pr-report-template.md`)
 * for wrapping the frozen, verbatim reference-brief copy below a PR's live
 * report, "the gates read the anchored fields above, never this block." No
 * gate needed to make that literally true until now — `body-bare-digits`
 * scans PR-body prose for bare digits, and a pasted brief is loaded with
 * dates, sizes, and example figures that are quoted history, not a live
 * claim about the PR carrying it.
 *
 * Tracks real GFM rendering, not CommonMark's own blank-line-terminated
 * "Type 6" HTML block rule: GitHub renders a `<details>` spanning blank
 * lines and nested markdown as one real collapsible element (every extant
 * PR body using the canonical form does exactly this), so this scanner
 * follows actual tag nesting depth instead of stopping at the first blank
 * line, which would under-mask and leak real reference-brief prose back
 * into the scan.
 *
 * **MUST run on `maskCode`'s OUTPUT, never the reverse** — call as
 * `maskDetailsBlocks(maskCode(body))`. A `<details>` tag quoted inside a
 * fenced block or an inline code span is already inert same-length filler
 * by the time this runs, so it can never be mistaken for a real region
 * boundary. Reversing the order reopens the exact decoy class
 * `anchoredRegionBounds` closed for the `AEG:*` anchors (caught in review): a
 * real narrative digit could sit between a quoted `` `<details>` `` and a
 * real `</details>`, and this scanner would mask it by mistake, believing a
 * real block was open when only a code-quoted example was.
 *
 * **Nesting.** A `<details>` may contain another `<details>` (valid GFM,
 * real usage in worked examples). Depth-tracked, not boolean, so an inner
 * close does not prematurely resume scanning inside a still-open outer
 * block.
 *
 * **An unterminated block fails closed, on purpose** — mirroring
 * `scanFencedCode`'s identical call for an unclosed fence
 * (`hasUnterminatedFence`'s doc comment). A `<details>` with no matching
 * `</details>` before end-of-body is exactly the shape a browser's own HTML
 * parser resolves by implicitly closing the element at end-of-document, so
 * masking to end-of-body is not a defensive guess — it matches what GitHub
 * actually renders.
 *
 * A stray, unmatched `</details>` (depth already 0) is left untouched —
 * inert text, not a region boundary; masking it would blank real prose for
 * no reason any closer justifies.
 */
export function maskDetailsBlocks(body: string): string {
  const fill = (line: string) => ' '.repeat(line.length)
  const lines = body.split('\n')
  let depth = 0

  const out = lines.map((line) => {
    const opens = line.match(DETAILS_OPEN)?.length ?? 0
    const closes = line.match(DETAILS_CLOSE)?.length ?? 0
    const maskThisLine = depth > 0 || opens > 0
    depth = Math.max(0, depth + opens - closes)
    return maskThisLine ? fill(line) : line
  })

  return out.join('\n')
}

/**
 * Removes fenced code blocks and inline code spans entirely, so example/quoted
 * text (a Test Plan's `Closes #NNN` fixture, a pasted reference brief, a
 * rationale's fenced `**Project:**` example) is never parsed as a real field.
 * This mirrors GitHub's own auto-close parser, which ignores `Closes #N` inside
 * code — a gate that strips the same way can never pass a body GitHub then
 * refuses to auto-close (a real regression, and real stranded Issues). Unlike
 * `maskCode`, indices are NOT preserved: use this when you only test/scan the
 * stripped text, `maskCode` when you must map positions back onto the original
 * body. Shared by `archive-task.ts` (provenance Issue read), `brief-validation.ts`
 * (`checkClosesN`), `coherence-checks.ts` (`extractClosesReferences`), and
 * `list-tasks.ts` (`projectFieldFromBody`) — one stripper, never a duplicated
 * regex.
 *
 * Inline spans are matched by CommonMark's rule: an opening run of N backticks
 * is closed by the next run of exactly N backticks on the same line — see
 * `replaceInlineSpans`'s own doc comment below for why a naive `` (`+)…\1 ``
 * backreference gets this wrong (it can match a shorter run against a
 * *prefix* of a longer one) and what replaced it. That correct run-matching
 * is what makes a **double**-backtick span (`` ``Closes #5`` ``) strip as one
 * unit — an earlier `` `[^`\n]*` `` form instead peeled the outer backticks
 * as two empty spans and left the inner `Closes #5` surviving as bare text (a
 * false-green: passed the gate, but GitHub, seeing a code span, refused to
 * auto-close — caught in review). Fenced blocks are stripped first (see
 * `maskFencedCode`) so a fence line is never mis-read as an inline span;
 * 4-space **indented** code blocks are stripped in between (see
 * `maskIndentedCode`).
 */
/*
 * **Call this on a WHOLE body, never on a slice of one.** Every rule here is
 * block-structural — a fence pairs with its own closer, an indented run counts
 * as code only after a blank line and outside list context — so the same text
 * strips differently depending on what precedes it. Slicing first and stripping
 * second silently changes the answer: an anchor indented inside a list item is
 * list content in the full body (kept; GitHub auto-closes it) and a bare
 * indented code block once sliced (blanked), which reintroduced a stranded
 * Issue through `extractIssue` (caught in review as a MAJOR finding). Strip, then slice — the
 * `AEG:*` markers are HTML comments and survive the strip, so region selection
 * works on stripped text, and a decoy anchor inside code never survives to be
 * sliced at all.
 */
/**
 * How `stripCode` treats **inline** code spans. Block code (fences, indented
 * blocks) is always stripped — that is the quoted-example case every caller
 * wants blinded.
 *
 * - `'strip'` (default) — spans go too, because a
 *   `` `Closes #5` `` is code to GitHub's auto-close parser and must be to this
 *   one. Every existing caller relies on it; the default never changes.
 * - `'keep'` — block-blind, span-aware. For checks whose subject *is* a path or
 *   a field value, because prose writes both in backticks by convention: a
 *   rationale saying "edits `packages/ui`" is declaring its surface, not quoting
 *   an example, and a span-blind scan of it finds nothing at all
 *   (`checkBlastRadiusScope` / `checkRationaleNamesDocs`, issue-validation.ts;
 *   `projectFieldFromBody`, list-tasks.ts). The span's delimiting backticks are
 *   left in place — no second regex exists to peel them, and every consumer
 *   either matches on path-token boundaries, for which a backtick is already a
 *   boundary character, or strips them from the value it captured.
 *
 * The knob lives here rather than in the callers so "one stripper, never a
 * duplicated regex" stays literally true: both modes run the same fence,
 * indent, and span patterns, and a future fix to any of them lands on both.
 */
export type StripCodeOptions = { inlineSpans?: 'strip' | 'keep' }

export function stripCode(body: string, options: StripCodeOptions = {}): string {
  // Normalise line endings FIRST. The line scanners below anchor per line, and
  // JS's `.`/`[ \t]` never match `\r`, so a CRLF body would open no fence at all
  // and let a fenced `Closes #N` walk free (caught in a security re-pass). Doing it
  // once here keeps every sub-stripper line-ending agnostic, rather than
  // teaching each individual regex about `\r` and missing the next one. (The
  // fence patterns tolerate a trailing `\r` anyway, for `maskCode`, which cannot
  // normalise without breaking its index mapping — belt and braces, not dead
  // code: `maskIndentedCode`'s blank-line and indent reads also want LF here.)
  const normalised = body.replace(/\r\n?/g, '\n')
  const blank = () => ''
  const blocksStripped = maskIndentedCode(maskFencedCode(normalised, blank), blank)
  if (options.inlineSpans === 'keep') return blocksStripped
  return blocksStripped
    .split('\n')
    .map((line) => replaceInlineSpans(line, () => ''))
    .join('\n')
}

/**
 * Finds and replaces CommonMark inline code spans within a single line.
 *
 * **Why not `/(`+)[^\n]*?\1/g`.** That regex's backreference matches the
 * captured backtick characters as a literal substring, not as a maximal
 * run — so a 2-backtick opener finds "its" closer inside the FIRST TWO
 * characters of any later run, including a 3-backtick run that is not a
 * valid closer at all. Per CommonMark, "a code span begins with a backtick
 * string and ends with a backtick string of equal length" — the closer must
 * itself be a backtick string (neither preceded nor followed by another
 * backtick), not merely contain the right number of backtick characters
 * somewhere inside a longer one. The regex's false-positive closer let a
 * bare digit inside a mismatched-length backtick pair mask as "code" — and
 * therefore escape `body-bare-digits`'s scan — while GitHub renders the
 * exact same text as plain, fully visible prose with literal stray
 * backticks (caught in a security re-review).
 *
 * This scans backtick runs explicitly instead: an opening run's length is
 * counted in full (so it can never be a partial run to begin with), and a
 * candidate closer only counts if ITS run is also counted in full and
 * matches the opener's length exactly. A run of the wrong length is not a
 * closer — it is skipped over as ordinary text, and the search for a valid
 * closer continues past it, exactly as real CommonMark parsers do. An
 * opener with no valid closer anywhere on the line is left as literal
 * backtick text (the same "raw backticks remain literal" fallback
 * CommonMark specifies), and the scan resumes immediately after that
 * failed run.
 */
function replaceInlineSpans(line: string, replace: (span: string) => string): string {
  let result = ''
  let i = 0
  const runLengthAt = (at: number): number => {
    let j = at
    while (j < line.length && line[j] === '`') j++
    return j - at
  }
  while (i < line.length) {
    if (line[i] !== '`') {
      result += line[i]
      i++
      continue
    }
    const openLen = runLengthAt(i)
    const openEnd = i + openLen
    let j = openEnd
    let closeEnd = -1
    while (j < line.length) {
      if (line[j] !== '`') {
        j++
        continue
      }
      const runLen = runLengthAt(j)
      if (runLen === openLen) {
        closeEnd = j + runLen
        break
      }
      j += runLen
    }
    if (closeEnd === -1) {
      result += line.slice(i, openEnd)
      i = openEnd
    } else {
      result += replace(line.slice(i, closeEnd))
      i = closeEnd
    }
  }
  return result
}

/**
 * What a scanner emits in place of one code line: `''` for `stripCode` (removal),
 * same-length filler for `maskCode` (index-preserving). The single knob the two
 * differ on — everything else about code recognition is shared.
 */
type LineFill = (line: string) => string

/**
 * An opening code fence: ≤3 leading spaces, then a run of ≥3 backticks or ≥3
 * tildes, then an info string. `[^\r\n]*` + `\r?$` rather than `.*$` so a CRLF
 * body opens a fence for `maskCode`, which cannot normalise (`stripCode`
 * normalises first, so this is redundant there and load-bearing here).
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/
/** A candidate closing fence: ≤3 leading spaces, a bare run of fence chars, nothing but whitespace after. */
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*\r?$/

/**
 * Blanks (`stripCode`) or same-length-masks (`maskCode`) CommonMark **fenced
 * code blocks**, matching a fence to its own closer
 * by character *and* run length.
 *
 * Replaces an earlier `` /```[\s\S]*?```/g `` regex that got three cases wrong
 * (caught in a security pass):
 *
 *   - **Tilde fences** (`~~~`) were not recognised at all. GFM fences with `~`
 *     exactly as with backticks.
 *   - **Runs longer than three** leaked: against a six-backtick fence the old
 *     regex matched the first three, treated the rest of the opening run as a
 *     complete empty block, and let the body walk free — the same run-length
 *     bug already fixed on the inline-span half, never carried over here.
 *   - An **info string** (```` ```js ````) was only incidentally handled.
 *
 * Per CommonMark the closing fence must use the same character and be **at
 * least as long** as the opening one; a backtick fence's info string may not
 * itself contain a backtick (that ambiguity is what makes ```` ```x``` ```` an
 * inline span, not a fence). An unclosed fence runs to end of body — as GitHub
 * also renders it, so a `Closes #N` after a stray fence is genuinely inside
 * code and must not count.
 */
function maskFencedCode(body: string, fill: LineFill): string {
  const { lines } = scanFencedCode(body)
  return lines.map(({ line, inCode }) => (inCode ? fill(line) : line)).join('\n')
}

/**
 * One pass of the fence state machine: which lines are inside a fenced block,
 * and whether the body ended while a fence was still open.
 *
 * Both facts come out of the SAME scan on purpose. `hasUnterminatedFence` is a
 * question about the fence grammar, and this file's whole reason to exist is
 * that the grammar has exactly one implementation — answering it with a
 * separate backtick-counting regex is how the two drift and how that decoy
 * class comes back.
 */
function scanFencedCode(body: string): { lines: Array<{ line: string; inCode: boolean }>; unterminated: boolean } {
  let fenceChar: string | null = null
  let fenceLen = 0

  const lines = body.split('\n').map((line) => {
    if (fenceChar === null) {
      const open = line.match(FENCE_OPEN)
      if (!open) return { line, inCode: false }
      const marker = open[1] as string
      // A backtick fence's info string cannot contain a backtick.
      if (marker[0] === '`' && (open[2] as string).includes('`')) return { line, inCode: false }
      fenceChar = marker[0] as string
      fenceLen = marker.length
      return { line, inCode: true }
    }
    const close = line.match(FENCE_CLOSE)
    if (close && (close[1] as string)[0] === fenceChar && (close[1] as string).length >= fenceLen) {
      fenceChar = null
      fenceLen = 0
    }
    return { line, inCode: true }
  })

  return { lines, unterminated: fenceChar !== null }
}

/**
 * Did the body end with a fence still open?
 *
 * An unterminated fence runs to end of body — CommonMark says so and GitHub
 * renders it that way, so `stripCode` blanking everything after it is correct,
 * not a bug. What is a bug is a caller reading that blanked tail as "the field
 * is absent": from the stray fence onward the reader is **blind**, and a body's
 * conventional foot fields are exactly what live down there.
 *
 * Callers that must distinguish "absent" from "unreadable" ask this first. See
 * `projectFieldFromBody` (`list-tasks.ts`), where treating a swallowed
 * `Project:` line as absent handed a registry gate a pass on a body the
 * previous, fence-blind parser refused.
 *
 * Line endings are normalised exactly as `stripCode` normalises them, so the
 * answer matches the strip the caller is about to distrust.
 */
export function hasUnterminatedFence(body: string): boolean {
  return scanFencedCode(body.replace(/\r\n?/g, '\n')).unterminated
}

/** A list marker (`-`, `*`, `+`, `1.`, `1)`) indented 0–3 spaces — opens list context. */
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/

/** Leading-whitespace width, counting a tab as 4 columns (CommonMark tab stop). */
function indentWidth(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4
    else break
  }
  return width
}

/**
 * Blanks (`stripCode`) or same-length-masks (`maskCode`) CommonMark **indented
 * code blocks** (a run of ≥4-column-indented lines
 * that begins after a blank line), so an indented `Closes #N` is ignored exactly
 * as GitHub's auto-close parser ignores it.
 *
 * Deliberately conservative — it is far worse to blank a *legitimately bare*
 * `Closes` (a false-red, and the brief's explicit over-strip stop condition)
 * than to miss an unusual indented one. Two guards enforce that asymmetry:
 *
 *   - **Must follow a blank line.** An indented code block cannot interrupt a
 *     paragraph, so an indented continuation line of running prose is never
 *     touched.
 *   - **Never inside a list.** Within a list item, 4-space indentation is the
 *     item's own content indent, not code — `- item` + blank + `    Closes #5`
 *     is a list paragraph GitHub *would* auto-close. List context opens on a
 *     list marker and closes on the next column-0 non-blank line. The cost is
 *     that a genuine indented code block nested inside a list is left unstripped
 *     (a false-green in that rare shape) — the safe direction of the trade.
 */
function maskIndentedCode(body: string, fill: LineFill): string {
  const lines = body.split('\n')
  let inList = false
  let inCode = false
  let prevBlank = true // start-of-body behaves like "preceded by a blank line"

  const out = lines.map((line) => {
    if (line.trim() === '') {
      prevBlank = true
      return line // a blank line neither opens nor closes a code run
    }
    const indent = indentWidth(line)

    if (indent >= 4 && (inCode || (prevBlank && !inList))) {
      inCode = true
      prevBlank = false
      return fill(line) // blank/mask the code line, keeping line count stable
    }

    inCode = false
    if (indent < 4 && LIST_MARKER.test(line)) inList = true
    else if (indent === 0) inList = false
    prevBlank = false
    return line
  })

  return out.join('\n')
}
