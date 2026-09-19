/**
 * Quoted-command staleness. Pure — no `fs`, no `git`/`gh`.
 *
 * **The defect this closes.** A doc quotes a command, config line, or file
 * content verbatim, in backticks, as a statement of present fact — "what
 * runs today: `X`". When a diff changes the thing being quoted, the
 * quotation goes stale and nothing notices: the doc changed nothing, the
 * code is correct, every existing gate passes. Measured, live: a CI
 * invocation was pinned to a version in one PR; `aeg-root/enforcement.md`
 * quoted the pre-pin form verbatim as "what runs today"; all 17 registered
 * checks passed, `doctor` reported healthy, security passed. A code-review
 * agent found it after roughly half an hour of independent re-derivation.
 * The fix was one line — the detection took a review round.
 *
 * **Marker-based, not inferred — the Principal's explicit decision
 * (2026-08-30).** The Issue leaves the claim-vs-instruction distinction
 * open and calls it "the real work"; it is now settled: a doc opts a span
 * in with a citation marker naming the file it quotes. An adopter-facing
 * `npx @attalabs/vinaya init` in a README is instruction, correctly
 * unpinned — inferring over command-looking spans would flag it, which is
 * the exact false-positive that gets a gate disabled. This module
 * implements NO inference and NO heuristic fallback for an unmarked span;
 * only annotated quotes are ever evaluated. Coverage grows only as docs
 * adopt the marker — that cost is understood and accepted.
 *
 * **The marker grammar.** Two-line (or inline) HTML-comment pair, the same
 * invisible-on-render, code-blind idiom `anchored-region.ts` uses for the
 * six PR/Issue-body gate-read fields — reused for its masking discipline
 * (`maskCode`, imported below) rather than re-implemented, though this is a
 * DIFFERENT field kind from `anchored-region.ts`'s closed `AnchorField`
 * union: `anchoredRegionBounds` parses one of six fixed field names inside a
 * forge body; this marker instead carries a free-form cited-file path
 * inline in its own START tag, inside an arbitrary doc file, so it cannot
 * reuse that function directly without widening a closed, PR-body-specific
 * type for a doc-authoring concern outside this task's surface. The shape:
 *
 *     <!-- AEG:QUOTES-FILE:START:<repo-relative-path> -->
 *     `<quoted text>`
 *     <!-- AEG:QUOTES-FILE:END -->
 *
 * Both markers may sit on their own lines or inline within a prose
 * sentence (the real annotation this task ships wraps an inline backtick
 * span mid-paragraph). Recognition rules mirror `anchored-region.ts`
 * exactly: markers inside a fenced/indented code block or inline code span
 * do not count (an authoring example showing the marker syntax itself,
 * fenced, is never mistaken for a real one); a `START` with no following
 * `END` is not an anchor at all; multiple pairs in one file are scanned
 * left to right, each `START` paired with the next `END` after it.
 *
 * **The quoted text.** The content between the markers, trimmed, with one
 * layer of wrapping stripped: a single-backtick inline span, a fenced block
 * (backtick or tilde), or neither (bare text) — whichever the author used.
 * That literal string is the predicate's subject: it either occurs verbatim
 * in the cited file's content, or it does not. No normalization beyond
 * that — a doc that means to tolerate whitespace/formatting drift is not
 * this check's problem to solve.
 *
 * **The predicate.** Decidable, per the Issue: a quoted command either
 * appears in the file it claims to quote, or it does not. `findCitedQuotes`
 * discovers every marked span in the governed-doc corpus (the same
 * `classifyProseFile` scoping `reader-resolvable-prose.ts` sweeps —
 * `ships`/`reader-facing`, never `internal` — reused rather than a second
 * notion of "governed doc"); `evaluateCitedQuotes` then checks each against
 * the cited file's actual content, which the caller supplies (the bin reads
 * it — this module never touches disk). A finding names both sides: what
 * the doc claims (the quoted text) and which file it cited that no longer
 * (or never did) contain it verbatim.
 */

import { maskCode } from '@attalabs/aeg-forge-state/strip-code'
import { classifyProseFile, type ProseFileClass } from './reader-resolvable-prose'

// `maskCode` (index-preserving) is imported directly from the `./strip-code`
// subpath — the same narrow front door `anchored-region.ts` uses, per that
// package's own barrel comment ("reachable through the `./strip-code`
// subpath for the two callers that need them"). Not through
// `anchored-region.ts`'s re-export: that file's own `anchoredRegionBounds`
// is scoped to its closed seven-field `AnchorField` grammar, which this
// marker (a free-form cited-file path, not one of those seven names) cannot
// use without widening a PR-body-specific type for a doc-authoring concern
// outside this task's surface. Reusing `maskCode` itself — rather than
// writing a second masker — is the actual "do not write a second anchor
// parser" discipline this module honors.

export type QuotedCommandSourceFile = { path: string; content: string }

/** One marked span: the doc that carries it, where, what it claims, and which file it cites. */
export type CitedQuote = {
  file: string
  line: number
  quotedText: string
  citedFile: string
}

export type QuotedCommandFinding = {
  file: string
  line: number
  citedFile: string
  quotedText: string
  message: string
}

/** `aeg-root/**` by default — same default `reader-resolvable-prose.ts` uses, so a caller that doesn't override either stays consistent. */
const QUOTED_COMMAND_SHIPS_PREFIX = 'aeg-root/'

/** The two classes this check sweeps for markers — `internal` never is, matching `reader-resolvable-prose.ts`'s own (identically-valued, differently-named to avoid `symbol-collisions.test.ts`) `SWEPT_CLASSES`. */
const QUOTED_COMMAND_SWEPT_CLASSES: ReadonlySet<ProseFileClass> = new Set(['ships', 'reader-facing'])

const START_PATTERN = /<!--\s*AEG:QUOTES-FILE:START:(\S+?)\s*-->/g
const END_PATTERN = /<!--\s*AEG:QUOTES-FILE:END\s*-->/

/**
 * A marker's `citedFile` must be a plain repo-root-relative path — never
 * absolute, never carrying a `..` traversal segment. Security finding
 * (this check's own PR, round 2): an unvalidated `citedFile` turns this
 * check into a file-content oracle any doc author can drive — a crafted
 * marker naming `../../../../etc/hosts` (or any path outside the repo the
 * check process can reach) gets its content read and compared against
 * attacker-chosen `quotedText`, and the three distinguishable outcomes
 * (silent pass on an exact match, a "no longer contains" finding on a
 * miss, a "could not be read" finding when the target is absent) form a
 * working binary-search oracle over that file's real content — reproduced
 * live, three ways, including a working read of `/etc/hosts`. A path
 * failing this check is not a valid citation at all: the marker is treated
 * exactly like an unterminated START/END pair (silently not an anchor),
 * never reaching the file-read stage, so there is no signal difference
 * between "malformed marker" and "no marker" for an attacker to probe.
 */
export function isValidCitedFilePath(path: string): boolean {
  if (path.length === 0) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[A-Za-z]:[\\/]/.test(path)) return false
  return !path.split(/[\\/]+/).includes('..')
}

function quotedCommandLineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/**
 * Strips exactly one layer of wrapping from the marker's inner text: a
 * single-backtick inline span, a fenced block (backtick or tilde, with or
 * without an info string), or neither. Returns the trimmed bare text in
 * every case — this is deliberately not CommonMark-general, only the two
 * shapes an author actually writes a quoted command in.
 */
function extractQuotedText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?(?:`{3,}|~{3,})$/.exec(trimmed)
  if (fenced) return (fenced[1] ?? '').trim()
  const inline = /^`([^`]+)`$/.exec(trimmed)
  if (inline) return (inline[1] ?? '').trim()
  return trimmed
}

/**
 * Scans one file's content for `AEG:QUOTES-FILE` marker pairs. Searches
 * position-only over `stripCode`'s masked-but-length-altering output is
 * unsafe (indices would no longer map back) — so this uses `maskCode`
 * (index-preserving, same primitive `anchored-region.ts` uses) to find
 * marker positions code-blind, then slices the real inner text from the
 * original `content` at those same indices, exactly as `anchoredRegionBounds`
 * does for its own seven fields.
 */
function findQuotesInFile(path: string, content: string): CitedQuote[] {
  const masked = maskCode(content)
  const quotes: CitedQuote[] = []

  START_PATTERN.lastIndex = 0
  let start: RegExpExecArray | null = START_PATTERN.exec(masked)
  while (start !== null) {
    const citedFile = start[1] as string
    const innerStart = start.index + start[0].length
    const end = END_PATTERN.exec(masked.slice(innerStart))
    if (end === null) {
      // A START with no following END is not an anchor at all (mirrors
      // anchored-region.ts's identical rule) — resume scanning right after
      // this unterminated START rather than treating the rest of the file
      // as consumed by it.
      START_PATTERN.lastIndex = innerStart
      start = START_PATTERN.exec(masked)
      continue
    }
    const innerEnd = innerStart + end.index
    if (isValidCitedFilePath(citedFile)) {
      const quotedText = extractQuotedText(content.slice(innerStart, innerEnd))
      if (quotedText.length > 0) {
        quotes.push({ file: path, line: quotedCommandLineAt(content, innerStart), quotedText, citedFile })
      }
    }
    START_PATTERN.lastIndex = innerEnd + end[0].length
    start = START_PATTERN.exec(masked)
  }
  return quotes
}

/**
 * Every marked span across the governed-doc corpus — `files` scoped to the
 * same `ships`/`reader-facing` classes `reader-resolvable-prose.ts` sweeps
 * (never `internal`), via the identical `classifyProseFile` call, not a
 * second notion of "governed doc". Zero I/O: `files` is read by the caller.
 */
export function findCitedQuotes(
  files: readonly QuotedCommandSourceFile[],
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  shipsPrefix: string = QUOTED_COMMAND_SHIPS_PREFIX
): CitedQuote[] {
  const quotes: CitedQuote[] = []
  for (const file of files) {
    const cls = classifyProseFile(file.path, readerFacingPrefix, readerFacingSuffix, shipsPrefix)
    if (!cls || !QUOTED_COMMAND_SWEPT_CLASSES.has(cls)) continue
    quotes.push(...findQuotesInFile(file.path, file.content))
  }
  return quotes
}

/**
 * The predicate itself: does each cited quote still appear verbatim in the
 * file it claims to quote? `citedFileContents` is supplied by the caller —
 * this function does no I/O and does not care whether a cited path lies
 * inside or outside the governed-doc corpus (a workflow YAML a doc quotes
 * is neither `ships` nor `reader-facing`, and must still be checkable). A
 * cited path absent from `citedFileContents` is itself a finding (the file
 * could not be read/found), not a silent pass — collapsing "unreadable"
 * into "verified" would be the same fail-open class other checks in this
 * package document as a real, reproduced incident.
 */
export function evaluateCitedQuotes(
  citedQuotes: readonly CitedQuote[],
  citedFileContents: ReadonlyMap<string, string>
): QuotedCommandFinding[] {
  const findings: QuotedCommandFinding[] = []
  for (const quote of citedQuotes) {
    const content = citedFileContents.get(quote.citedFile)
    if (content === undefined) {
      findings.push({
        file: quote.file,
        line: quote.line,
        citedFile: quote.citedFile,
        quotedText: quote.quotedText,
        message: `${quote.file}:${quote.line} quotes "${quote.quotedText}" as citing \`${quote.citedFile}\`, but that file could not be read`
      })
      continue
    }
    if (!content.includes(quote.quotedText)) {
      findings.push({
        file: quote.file,
        line: quote.line,
        citedFile: quote.citedFile,
        quotedText: quote.quotedText,
        message: `${quote.file}:${quote.line} quotes "${quote.quotedText}" as citing \`${quote.citedFile}\`, but \`${quote.citedFile}\` no longer contains that text verbatim`
      })
    }
  }
  return findings
}

/** Runs both phases in one call: discover markers, then evaluate them against the supplied cited-file contents. */
export function checkQuotedCommandStaleness(
  files: readonly QuotedCommandSourceFile[],
  citedFileContents: ReadonlyMap<string, string>,
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  shipsPrefix: string = QUOTED_COMMAND_SHIPS_PREFIX
): QuotedCommandFinding[] {
  return evaluateCitedQuotes(
    findCitedQuotes(files, readerFacingPrefix, readerFacingSuffix, shipsPrefix),
    citedFileContents
  )
}
