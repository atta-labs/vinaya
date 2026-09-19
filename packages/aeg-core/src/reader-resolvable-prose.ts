/**
 * Reader-resolvable prose — classes 1 and 2 of a three-class analysis of
 * "words a reader cannot resolve." Class 3 (register/slop — padding adjectives, first person,
 * narrating the work episode) is NOT here; it stays with the review role,
 * per the measurement below.
 *
 * **The measurement that disqualifies a phrase blacklist.** A phrase
 * blacklist tested against the real corpus (all of `aeg-root` plus 1,157
 * TypeScript files) scored 14 hits, 14 false positives, 0 true positives —
 * "a review was *requested*"; "could *this change* leak a secret"; "*I have*
 * X, Y, Z" inside a quoted example. The fix is not tuning the word list; it
 * is asking a different question:
 *
 *   - Class 1 (references): not "does this phrase appear" but "does this
 *     doctrine cite a forge number or tranche slug the reader has no forge to
 *     resolve." Reuses the same two pattern shapes proven in
 *     `retired-vocabulary.test.ts` (`FORGE_NUMBER_PATTERN`,
 *     `TRANCHE_SLUG_VN_PATTERN`, and the legacy-slug list derived — not
 *     guessed — from `aeg-root/tranches/completed/*.md` filenames), scoped to
 *     the reader-facing surfaces instead of banned repo-wide (the same digit
 *     shape is this product's own live `Closes #N`/PR-number grammar
 *     elsewhere, so a repo-wide ban would flag the mechanism, not the
 *     citation habit).
 *   - Class 2 (vocabulary): not "is this word forbidden" but "does this
 *     reader-facing file use a coined term while neither defining it inline
 *     nor linking a definition." The term list is derived from
 *     `aeg-root/glossary.md`'s own entry headings — never hard-coded — so it
 *     cannot drift the first time an entry is added.
 *
 * Zero I/O: every input (file paths + contents, the glossary's term list, the
 * legacy-slug list) is read by the adapter and passed in. POSIX-ERE-safe
 * patterns only — no `\d`/`\w`/`\s`/lookaheads, and no `\b` relied on after a
 * non-word character (the exact regression class `retired-vocabulary.test.ts`
 * already paid for) — even though these patterns run through native
 * `RegExp`, not `grep -E`, keeping them portable to either.
 */

export type ProseFileClass = 'ships' | 'reader-facing' | 'internal' | 'product' | 'spec'

export type ProseSourceFile = { path: string; content: string }

export type ProseFinding = {
  file: string
  line: number
  message: string
  blocking: boolean
}

/**
 * Path prefixes under which a tranche-slug citation in product code is a
 * blocking finding — copied verbatim (aeg-root dropped) from the scope list
 * `retired-vocabulary.test.ts`'s `PATTERN_SCOPE[TRANCHE_SLUG_VN_PATTERN]` used
 * to grep directly; that suite no longer greps these paths itself
 * (`prose-product-scope.test.ts` pins this list against drift instead).
 */
export const PRODUCT_SLUG_SCOPE: readonly string[] = [
  'apps/cli/src',
  '.github/workflows',
  '.vinaya',
  'apps/cli/README.md',
  'packages/sources/README.md'
]

/** A path equal to, or nested under, `prefix` — never a bare-prefix substring match (`apps/cli/srcx` must not match `apps/cli/src`). */
function isUnderOrEqual(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function isProductScopeFile(path: string): boolean {
  return PRODUCT_SLUG_SCOPE.some((prefix) => isUnderOrEqual(path, prefix))
}

/**
 * `aeg-root/**` by default — what this repo's own package carries and
 * `/docs` publishes. Every caller below takes `shipsPrefix` as its LAST,
 * defaulted parameter so an adopter whose installed doctrine tree lives
 * somewhere else can override it without breaking any existing positional call.
 */
const SHIPS_PREFIX = 'aeg-root/'

/** `<shipsPrefix>tranches/completed/` — history, never rewritten. Same exemption `retired-vocabulary.test.ts` already carries for the identical reason: an archived tranche legitimately cites the forge numbers and slugs it closed. */
function shipsArchivePrefix(shipsPrefix: string): string {
  return `${shipsPrefix}tranches/completed/`
}

/**
 * A per-product specs file (`apps/<product>/specs/**`) — issue-657, O6:
 * swept with the SAME rules `ships`/doctrine pages already carry (a spec is
 * as reader-facing as a doctrine page; a fork or an export reads it with no
 * forge to resolve a citation against, same as `aeg-root/**`). Formerly
 * classified `internal` (exempt) on the theory that "this reader has this
 * forge" — the wrong reader: a spec ships to the SAME audience doctrine
 * does, and a spec that opened with a tranche name, an Issue number, and
 * external documents as its authority reached a pull request unflagged
 * under the old exemption (found live, 2026-09-19).
 */
function isSpecFile(path: string): boolean {
  return path.startsWith('apps/') && path.includes('/specs/') && path.endsWith('.md')
}

/** Any `CLAUDE.md`, at any depth — same reasoning as specs: this reader has this forge. */
function isClaudeMdFile(path: string): boolean {
  return path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md')
}

/**
 * The file-class map, encoded as data (not a rule buried in control flow).
 * Returns `null` for anything outside all three classes — out of this
 * check's scope entirely, not merely exempt.
 *
 * `readerFacingPrefix`/`readerFacingSuffix` scope the "reader-facing" class
 * to a consumer's own reader-facing surface — this package stays generic and
 * has no attalabs-specific path baked in. The caller-supplied shape mirrors
 * the vinaya adopter's product site: a page's own body is where
 * reader-visible prose lives (JSX text, step copy); sibling component
 * directories include non-textual/decorative surfaces (e.g. canvas
 * illustrations using fictional PR numbers as flavor text) that are not
 * prose in the sense this check means, hence a suffix-scoped match rather
 * than a bare prefix.
 */
export function classifyProseFile(
  path: string,
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  shipsPrefix: string = SHIPS_PREFIX
): ProseFileClass | null {
  if (path.startsWith(shipsPrefix)) {
    return path.startsWith(shipsArchivePrefix(shipsPrefix)) ? 'internal' : 'ships'
  }
  if (path.startsWith(readerFacingPrefix) && path.endsWith(readerFacingSuffix)) {
    return 'reader-facing'
  }
  if (isClaudeMdFile(path)) return 'internal'
  if (isSpecFile(path)) return 'spec'
  if (isProductScopeFile(path)) return 'product'
  return null
}

/** The two classes this check actually sweeps — `internal` never is. */
const SWEPT_CLASSES: ReadonlySet<ProseFileClass> = new Set(['ships', 'reader-facing'])

/**
 * Strips the parts of a file that are never reader prose, per file kind — a
 * fenced/inline code example in a markdown doc, or a source comment in a
 * `.tsx` page (a page's own developer-facing comments, e.g. "same reasoning
 * as `/roadmap`", are not what a site visitor reads). Line count is
 * preserved (replacements keep their newlines) so reported line numbers stay
 * accurate against the original file.
 *
 * The `//` line-comment cut requires the marker not be immediately preceded
 * by `:` — without that, `https://vinaya.dev` on a reader-facing line reads
 * as a comment starting at its own `//`, silently blanking every word of
 * real prose that follows it on the line. No boundary check is needed on
 * the far side: unlike `//`, the character before it is never itself part
 * of the marker, so a plain capturing group (not a lookbehind) is enough.
 */
export function stripNonProse(path: string, content: string): string {
  if (path.endsWith('.md')) {
    return content
      .replace(/```.*?```/gs, (m) => m.replace(/[^\n]/g, ''))
      .replace(/`[^`\n]*`/g, (m) => m.replace(/[^\n]/g, ''))
  }
  if (path.endsWith('.tsx') || path.endsWith('.ts')) {
    return content
      .replace(/\/\*.*?\*\//gs, (m) => m.replace(/[^\n]/g, ''))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ''))
  }
  return content
}

/**
 * Product-class scrubbing: still skips fenced/inline markdown code (a slug
 * shown as a usage example in a README must not fire), but does NOT strip
 * `.ts`/`.tsx` comments the way `stripNonProse` does for `ships`/
 * `reader-facing` files — the motivating case is a tranche slug written into
 * a CLI source *comment*, which reached CI specifically because nothing
 * scanned comments in product code.
 */
function stripNonProseForProduct(path: string, content: string): string {
  return path.endsWith('.md') ? stripNonProse(path, content) : content
}

function lineAt(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++
  }
  return line
}

/** `#NNN`-shaped — a PR/Issue number cited bare, resolvable only inside this repo's own tracker. */
export const FORGE_NUMBER_PATTERN = /#[0-9]{2,4}/g

/** `example-tranche-vN`-shaped — an internal tranche slug ending `-vN`. */
export const TRANCHE_SLUG_VN_PATTERN = /[a-z][a-z-]+-v[0-9]/g

/**
 * Builds the legacy-slug pattern from the real archived-tranche filenames
 * the adapter reads (mirrors `retired-vocabulary.test.ts`'s `legacySlugs()` —
 * derived from `aeg-root/tranches/completed/*.md`, never a shape guess).
 * Returns `null` when there is nothing left for it to catch (every archived
 * slug now ends `-vN`), matching that file's "no pattern with zero positive
 * samples" rule.
 *
 * Boundary-checked like `containsWholeWord` below (character class, not
 * `\b`) so a real slug cannot match as a bare substring inside a longer,
 * unrelated token. `retired-vocabulary.test.ts`'s own copy of this pattern
 * has no such boundary; this one adds it rather than copying the gap.
 * Group 1 is the leading boundary char (or start-of-string), group 2 is the
 * slug itself, group 3 the trailing boundary char (or end-of-string) — the
 * caller reports group 2, not the whole match, so the boundary chars never
 * leak into a finding's message.
 */
export function legacySlugPattern(legacySlugs: readonly string[]): RegExp | null {
  if (legacySlugs.length === 0) return null
  const alternation = legacySlugs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return new RegExp(`(^|[^a-zA-Z0-9\\n-])(${alternation})([^a-zA-Z0-9\\n-]|$)`, 'g')
}

/**
 * Class 1 — unresolvable references. Runs the reference patterns over every
 * swept file (`ships`/`reader-facing`), skipping code-fenced/commented-out
 * non-prose first. A `product`-class file (a tranche-slug citation under
 * `PRODUCT_SLUG_SCOPE`) is checked only against `TRANCHE_SLUG_VN_PATTERN`,
 * and its finding is `blocking: true`; every other finding is `blocking: false`.
 */
export function checkUnresolvableReferences(
  files: readonly ProseSourceFile[],
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  legacySlugs: readonly string[] = [],
  shipsPrefix: string = SHIPS_PREFIX,
  specGrandfather: readonly string[] = []
): ProseFinding[] {
  const findings: ProseFinding[] = []
  const legacyPattern = legacySlugPattern(legacySlugs)
  const grandfathered = new Set(specGrandfather)
  // `group` names the capture holding the actual cited text — the plain
  // patterns have none (report the whole match), the boundary-checked
  // legacy-slug pattern reports its group 2 so the boundary chars around it
  // never leak into the finding's message.
  const patterns: { pattern: RegExp; what: string; group?: number }[] = [
    { pattern: FORGE_NUMBER_PATTERN, what: 'a forge number' },
    { pattern: TRANCHE_SLUG_VN_PATTERN, what: 'an internal tranche slug' },
    ...(legacyPattern ? [{ pattern: legacyPattern, what: 'an internal tranche slug', group: 2 }] : [])
  ]

  const productPatterns: { pattern: RegExp; what: string; group?: number }[] = [
    { pattern: TRANCHE_SLUG_VN_PATTERN, what: 'an internal tranche slug in product code' }
  ]

  for (const file of files) {
    const cls = classifyProseFile(file.path, readerFacingPrefix, readerFacingSuffix, shipsPrefix)
    if (!cls || cls === 'internal') continue
    if (cls !== 'product' && cls !== 'spec' && !SWEPT_CLASSES.has(cls)) continue
    // issue-657, O6 — a spec explicitly listed by path is grandfathered
    // stock (already failing when this sweep was extended to specs) and is
    // skipped entirely, not merely down-graded: the list shrinks as later
    // tasks rewrite each spec's prose, never grows.
    if (cls === 'spec' && grandfathered.has(file.path)) continue
    const blocking = cls === 'product' || cls === 'spec'
    const scrubbed =
      cls === 'product' ? stripNonProseForProduct(file.path, file.content) : stripNonProse(file.path, file.content)
    // A spec is checked with the SAME rules a doctrine page is (O6) — the
    // full reference pattern set, never the narrower product-code list.
    const patternsToRun = cls === 'product' ? productPatterns : patterns
    for (const { pattern, what, group } of patternsToRun) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null = pattern.exec(scrubbed)
      while (match !== null) {
        const cited = group !== undefined ? (match[group] ?? match[0]) : match[0]
        findings.push({
          file: file.path,
          line: lineAt(scrubbed, match.index),
          message: `references ${what} ("${cited}") a reader outside this repo's tracker cannot resolve`,
          blocking
        })
        match = pattern.exec(scrubbed)
      }
    }
  }
  return findings
}

/** Escapes a glossary term for use inside a hand-built, boundary-checked pattern. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whole-word (or whole-phrase), case-insensitive occurrence of `term` in
 * `text` — boundaries checked by character class rather than `\b`, per the
 * "do not rely on `\b` after a non-word character" lesson. Matches the exact
 * glossary heading only (no inflections): "briefly" must never match
 * "brief" the way a prefix match would — that exact shape (`let's` matching
 * `bullet's`) is what the disqualifying measurement caught.
 */
function containsWholeWord(text: string, term: string): boolean {
  const escaped = escapeTerm(term)
  const re = new RegExp(`(^|[^a-zA-Z])${escaped}([^a-zA-Z]|$)`, 'i')
  return re.test(text)
}

function findWholeWordLine(content: string, term: string): number | null {
  const lines = content.split('\n')
  let lineNo = 0
  for (const line of lines) {
    lineNo++
    if (containsWholeWord(line, term)) return lineNo
  }
  return null
}

/**
 * A file "defines" a term inline when it carries the same
 * `Term — definition` shape the glossary itself uses (an em-dash right after
 * the term), or links the glossary page/file directly.
 */
function definesOrLinksGlossary(content: string, term: string): boolean {
  const escaped = escapeTerm(term)
  const definesInline = new RegExp(`(^|[^a-zA-Z])${escaped}([^a-zA-Z]|$)[^\\n]{0,3}—`, 'i').test(content)
  if (definesInline) return true
  return /docs\/glossary|glossary\.md/i.test(content)
}

/**
 * Class 2 — undefined coined vocabulary. Not "is this word forbidden" — it
 * is "does this reader-facing file use a coined term while neither defining
 * it inline nor linking a definition." `glossaryTerms` is read by the
 * adapter from `aeg-root/glossary.md`'s own entry headings — never
 * hard-coded here, so the check cannot silently rot the first time an entry
 * is added.
 */
export function checkUndefinedVocabulary(
  files: readonly ProseSourceFile[],
  glossaryTerms: readonly string[],
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  shipsPrefix: string = SHIPS_PREFIX
): ProseFinding[] {
  const findings: ProseFinding[] = []

  for (const file of files) {
    const cls = classifyProseFile(file.path, readerFacingPrefix, readerFacingSuffix, shipsPrefix)
    if (!cls || !SWEPT_CLASSES.has(cls)) continue
    const scrubbed = stripNonProse(file.path, file.content)

    for (const term of glossaryTerms) {
      const line = findWholeWordLine(scrubbed, term)
      if (line === null) continue
      if (definesOrLinksGlossary(scrubbed, term)) continue
      findings.push({
        file: file.path,
        line,
        message: `uses coined term "${term}" without defining it inline or linking the glossary`,
        blocking: false
      })
    }
  }
  return findings
}

/**
 * `<slug>-vN`-shaped, source-comment class — deliberately
 * looser than `TRANCHE_SLUG_VN_PATTERN` above (which requires at least two
 * letters before the version suffix): this class's caller is a `.ts`
 * comment, not doctrine prose, so a shorter coined identifier
 * (`x-vN`) is still exactly the kind of internal citation a reader outside
 * this repo cannot resolve.
 */
export const SOURCE_COMMENT_TRANCHE_SLUG_PATTERN = /[a-z0-9]+(?:-[a-z0-9]+)*-v[0-9]+/g

/** `#NNN`-shaped, source-comment class — no upper digit-count bound (unlike `FORGE_NUMBER_PATTERN`'s `{2,4}`), since a forge's issue/PR numbering has no fixed ceiling. */
export const SOURCE_COMMENT_FORGE_NUMBER_PATTERN = /#[0-9]{2,}/g

/**
 * The inverse of `stripNonProse`'s `.ts`/`.tsx` half: keeps ONLY the text
 * inside `//` line comments and `/* *‍/` block comments, blanking code and
 * string/template-literal content (so a URL or a slug-shaped identifier
 * living in a string literal, not a comment, never reads as a citation),
 * while preserving line count so reported line numbers stay accurate.
 *
 * A real tokenizer (not `stripNonProse`'s regex-based approach) because the
 * source-comment class runs over this repo's *own* `.ts` source at `error`
 * severity — a false positive from a `//` inside a string literal
 * (`"https://…"`) would fail real pushes, not just print a warning.
 */
export function extractComments(path: string, content: string): string {
  if (!path.endsWith('.ts') && !path.endsWith('.tsx')) return content.replace(/[^\n]/g, '')

  type State = 'code' | 'line-comment' | 'block-comment' | 'single-quote' | 'double-quote' | 'template'
  let state: State = 'code'
  let out = ''
  const n = content.length
  let i = 0

  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ')

  while (i < n) {
    const c = content[i] as string
    const next = i + 1 < n ? content[i + 1] : ''

    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line-comment'
        out += c
        i++
        continue
      }
      if (c === '/' && next === '*') {
        state = 'block-comment'
        out += c
        i++
        continue
      }
      if (c === "'") {
        state = 'single-quote'
        out += blank(c)
        i++
        continue
      }
      if (c === '"') {
        state = 'double-quote'
        out += blank(c)
        i++
        continue
      }
      if (c === '`') {
        state = 'template'
        out += blank(c)
        i++
        continue
      }
      out += blank(c)
      i++
      continue
    }

    if (state === 'line-comment') {
      if (c === '\n') {
        state = 'code'
        out += '\n'
        i++
        continue
      }
      out += c
      i++
      continue
    }

    if (state === 'block-comment') {
      if (c === '*' && next === '/') {
        out += c
        out += next
        state = 'code'
        i += 2
        continue
      }
      out += c === '\n' ? '\n' : c
      i++
      continue
    }

    // single-quote / double-quote / template: blank everything, honouring a
    // backslash escape so an escaped quote/backtick never ends the literal
    // early (which would otherwise flip the scanner back to 'code' mid-string
    // and risk reading the string's remainder as real source).
    const closer = state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : '`'
    if (c === '\\') {
      out += blank(c)
      i++
      if (i < n) {
        out += blank(content[i] as string)
        i++
      }
      continue
    }
    if (c === closer) {
      state = 'code'
      out += blank(c)
      i++
      continue
    }
    out += blank(c)
    i++
  }

  return out
}

/**
 * The source-comment class — scans comment lines of `.ts`
 * files for a tranche-slug or forge-number citation. Unlike the `product`
 * class above (a fixed, aeg-core-internal `PRODUCT_SLUG_SCOPE`), the file
 * SET here is entirely the caller's choice: the bin resolves
 * `proseGates.sourceComments.globs` into concrete files and passes them in,
 * so this stays zero-I/O and adopter-configurable rather than hardcoded to
 * this repo's own trees. `allowlist` is a set of exact repo-relative file
 * paths a caller has decided deliberately/legitimately cite a slug or
 * number in a comment (e.g. a test fixture pinning a historical tranche
 * name) — skipped entirely, not merely down-graded.
 */
export function checkSourceComments(
  files: readonly ProseSourceFile[],
  allowlist: readonly string[] = []
): ProseFinding[] {
  const findings: ProseFinding[] = []
  const allowed = new Set(allowlist)
  const patterns: { pattern: RegExp; what: string }[] = [
    { pattern: SOURCE_COMMENT_TRANCHE_SLUG_PATTERN, what: 'a tranche-slug citation' },
    { pattern: SOURCE_COMMENT_FORGE_NUMBER_PATTERN, what: 'a forge-number citation' }
  ]

  for (const file of files) {
    if (!file.path.endsWith('.ts')) continue
    if (allowed.has(file.path)) continue
    const comments = extractComments(file.path, file.content)
    for (const { pattern, what } of patterns) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null = pattern.exec(comments)
      while (match !== null) {
        findings.push({
          file: file.path,
          line: lineAt(comments, match.index),
          message: `comment cites ${what} ("${match[0]}") a reader outside this repo's tracker cannot resolve`,
          blocking: false
        })
        match = pattern.exec(comments)
      }
    }
  }
  return findings
}

/** Runs both mechanizable classes over the given files in one pass. */
export function checkReaderResolvableProse(
  files: readonly ProseSourceFile[],
  glossaryTerms: readonly string[],
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  legacySlugs: readonly string[] = [],
  shipsPrefix: string = SHIPS_PREFIX,
  specGrandfather: readonly string[] = []
): ProseFinding[] {
  return [
    ...checkUnresolvableReferences(
      files,
      readerFacingPrefix,
      readerFacingSuffix,
      legacySlugs,
      shipsPrefix,
      specGrandfather
    ),
    ...checkUndefinedVocabulary(files, glossaryTerms, readerFacingPrefix, readerFacingSuffix, shipsPrefix)
  ]
}

/** Parses `aeg-root/glossary.md`'s `**Term** — definition` entry headings into a bare term list. */
export function parseGlossaryTerms(glossaryContent: string): string[] {
  const terms: string[] = []
  const re = /^\*\*(.+?)\*\* —/gm
  let match: RegExpExecArray | null = re.exec(glossaryContent)
  while (match !== null) {
    if (match[1] !== undefined) terms.push(match[1])
    match = re.exec(glossaryContent)
  }
  return terms
}
