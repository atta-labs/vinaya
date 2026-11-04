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
  /** The id of the rule that matched. */
  rule: string
}

/**
 * The default of `proseGates.productPaths`: path prefixes under which a
 * tranche-slug citation in product code is a blocking finding — copied verbatim (aeg-root dropped) from the scope list
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

function isProductScopeFile(path: string, productPaths: readonly string[]): boolean {
  return productPaths.some((prefix) => isUnderOrEqual(path, normalizeRepoPath(prefix)))
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
 * The spec class's default file set, repository-relative: a root product
 * spec, a root context document, and every decision record under
 * `docs/adr/`. These are the durable documents a repository with no `apps/`
 * tree of its own actually keeps — a spec class that collected only
 * `apps/<product>/specs/**` never read them, so a root spec was free to
 * carry a copy of a plan (a task list, the Issue numbers behind it) that
 * went stale the moment the plan moved, which is exactly the citation this
 * class exists to refuse.
 *
 * A folder entry matches every `.md` file under it; a file entry matches
 * that one file. `README.md` is deliberately absent and must stay absent:
 * the tranche-slug pattern matches the version badge a README carries for
 * each framework it is built on, so a default that swept READMEs would
 * refuse a shape that is not a citation at all.
 */
export const DEFAULT_SPEC_PATHS: readonly string[] = ['SPEC.md', 'CONTEXT.md', 'docs/adr']

/**
 * One spec-path entry in the single spelling the class matches against: no
 * leading `./`, no trailing slash, no doubled separators. A configured entry
 * is written by hand, so `docs/adr/` and `./docs/adr` both reach here and
 * both mean the folder `docs/adr` — normalized, they match; unnormalized,
 * the prefix compare below silently answered "not a spec" and the entry
 * checked nothing at all. Every caller normalizes with THIS function so the
 * collector's paths and the classifier's entries cannot disagree about a
 * spelling.
 */
export function normalizeSpecPath(entry: string): string {
  return normalizeRepoPath(entry)
}

/**
 * A spec-class file: a per-product specs file (`apps/<product>/specs/**`),
 * or any `.md` file at — or under — one of `specPaths`' entries. Both are
 * swept with the SAME rules `ships`/doctrine pages already carry (a spec is
 * as reader-facing as a doctrine page; a fork or an export reads it with no
 * forge to resolve a citation against, same as `aeg-root/**`). The
 * `apps/<product>/specs/**` half was formerly classified `internal`
 * (exempt) on the theory that "this reader has this forge" — the wrong
 * reader: a spec ships to the SAME audience doctrine does, and a spec that
 * opened with a tranche name, an Issue number, and external documents as
 * its authority reached a pull request unflagged under the old exemption
 * (found live, 2026-09-19).
 *
 * `.md` is required of an entry-matched path so a folder entry carrying
 * non-prose files (a fixture, an image) widens the class to its markdown
 * only. Each entry is normalized before it is compared, so a hand-written
 * `docs/adr/` or `./docs/adr` names the same folder a bare `docs/adr` does.
 */
function isSpecFile(path: string, specPaths: readonly string[]): boolean {
  if (path.startsWith('apps/') && path.includes('/specs/') && path.endsWith('.md')) return true
  if (!path.endsWith('.md')) return false
  return specPaths.some((entry) => isUnderOrEqual(path, normalizeSpecPath(entry)))
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
 *
 * `specPaths` is the spec class's own repository-relative file set beyond
 * `apps/<product>/specs/**` — `DEFAULT_SPEC_PATHS` when the caller says
 * nothing, so a repository that configures nothing still has its root spec,
 * root context document and decision records read. A caller adding
 * configured paths passes the defaults alongside them; this parameter is the
 * whole set, never a delta.
 *
 * `productPaths` is the product class's file set — `PRODUCT_SLUG_SCOPE`
 * unless `proseGates.productPaths` replaces it.
 */
export function classifyProseFile(
  path: string,
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  shipsPrefix: string = SHIPS_PREFIX,
  specPaths: readonly string[] = DEFAULT_SPEC_PATHS,
  productPaths: readonly string[] = PRODUCT_SLUG_SCOPE
): ProseFileClass | null {
  if (path.startsWith(shipsPrefix)) {
    return path.startsWith(shipsArchivePrefix(shipsPrefix)) ? 'internal' : 'ships'
  }
  if (path.startsWith(readerFacingPrefix) && path.endsWith(readerFacingSuffix)) {
    return 'reader-facing'
  }
  if (isClaudeMdFile(path)) return 'internal'
  if (isSpecFile(path, specPaths)) return 'spec'
  if (isProductScopeFile(path, productPaths)) return 'product'
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
import {
  DEFAULT_PROSE_RULE_SET,
  normalizeRepoPath,
  type ProseRuleSet,
  type ResolvedProseRule,
  ruleReads,
  rulesForGroup,
  rulesInScope
} from './prose-rules'

const readerRules = rulesForGroup('reader-resolvable')
const readerPattern = (id: string, scope = 'prose'): RegExp => {
  const pattern = readerRules.find((rule) => rule.id === id)?.patterns[scope]
  if (!(pattern instanceof RegExp)) throw new Error(`default prose rule ${id} has no ${scope} pattern`)
  return pattern
}

export const FORGE_NUMBER_PATTERN = readerPattern('forge-number')

/** `example-tranche-vN`-shaped — an internal tranche slug ending `-vN`. */
export const TRANCHE_SLUG_VN_PATTERN = readerPattern('tranche-slug')

/**
 * `task 4`/`tasks 12`/`task #4`-shaped — a task's number out of a plan, which
 * only that plan's own tracker resolves, and which moves the moment the plan
 * is renumbered. The shape a durable document copies when it repeats a plan
 * it should have pointed at instead, so it is checked wherever a spec is.
 *
 * Deliberately narrow: the word `task` or `tasks` immediately followed by a
 * number. A document's own numbered structure — "Section 3", "step 2", "Part
 * 1" — is not a citation and never matches, and neither does a longer word
 * that merely contains these letters (`multitasking 2`), since the leading
 * boundary rejects a preceding letter, digit or hyphen. Case-insensitive, so
 * a heading (`## Task 4`) is caught alongside mid-sentence prose. Group 1 is
 * the leading boundary character (or start-of-string) and group 2 the
 * citation itself — the caller reports group 2, so the boundary character
 * never leaks into a finding's message.
 */
export const TASK_NUMBER_PATTERN = readerPattern('task-number')

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
/**
 * The spec class's exemption. The array form lists paths skipped entirely; the
 * object form maps each listed path to the most findings that file may carry —
 * a file above its number fails, at or below it passes, and the number is
 * lowered as the file is rewritten.
 */
export type SpecGrandfather = readonly string[] | Readonly<Record<string, number>>

/** Every listed path in either form, in the order written. */
export function specGrandfatherPaths(specGrandfather: SpecGrandfather): string[] {
  return Array.isArray(specGrandfather) ? [...specGrandfather] : Object.keys(specGrandfather)
}

/**
 * Options every sweep below accepts as its last parameter. `rules` is the
 * resolved rule set (`resolveProseRules`) — the shipped defaults unless the
 * repository configured `proseGates.rules`; `productPaths` replaces
 * `PRODUCT_SLUG_SCOPE` as the product class's file set.
 */
export type ProseSweepOptions = {
  rules?: ProseRuleSet
  productPaths?: readonly string[]
}

/** The file classes the reference sweep reads, each the scope of the same name. */
const REFERENCE_CLASSES: ReadonlySet<ProseFileClass> = new Set(['ships', 'reader-facing', 'product', 'spec'])

/** The reference rules for one file class, in run order: every pattern rule whose scopes name the class, plus the built-in legacy-slug rule. */
function referenceRulesFor(set: ProseRuleSet, cls: ProseFileClass): readonly ResolvedProseRule[] {
  return rulesInScope(set, cls).filter((rule) => rule.group === 'reader-resolvable' && rule.id !== 'coined-term')
}

/**
 * Every match of `pattern` in `text`, with the cited text and its offset. A
 * configured pattern that matches the empty string advances past it and
 * reports nothing, so a careless rule can never loop forever.
 */
function citations(pattern: RegExp, text: string, group?: number): { cited: string; index: number }[] {
  const out: { cited: string; index: number }[] = []
  const re = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)
  re.lastIndex = 0
  let match: RegExpExecArray | null = re.exec(text)
  while (match !== null) {
    if (match[0] === '') {
      re.lastIndex++
    } else {
      const cited = group !== undefined ? (match[group] ?? match[0]) : match[0]
      // The cited text's own offset, not the whole match's — see the line
      // computation in `checkUnresolvableReferences`.
      out.push({ cited, index: match.index + match[0].indexOf(cited) })
    }
    match = re.exec(text)
  }
  re.lastIndex = 0
  return out
}

/** A custom rule's finding text: its own id, the matched text, and its message. */
function customMessage(rule: ResolvedProseRule, cited: string): string {
  return `${rule.id}: ${rule.message} ("${cited}")`
}

export function checkUnresolvableReferences(
  files: readonly ProseSourceFile[],
  readerFacingPrefix: string,
  readerFacingSuffix: string,
  legacySlugs: readonly string[] = [],
  shipsPrefix: string = SHIPS_PREFIX,
  specGrandfather: SpecGrandfather = [],
  specPaths: readonly string[] = DEFAULT_SPEC_PATHS,
  options: ProseSweepOptions = {}
): ProseFinding[] {
  const set = options.rules ?? DEFAULT_PROSE_RULE_SET
  const productPaths = options.productPaths ?? PRODUCT_SLUG_SCOPE
  const findings: ProseFinding[] = []
  const legacyPattern = legacySlugPattern(legacySlugs)
  const grandfatheredWhole = new Set(Array.isArray(specGrandfather) ? (specGrandfather as readonly string[]) : [])
  const limits = new Map<string, number>(
    Array.isArray(specGrandfather) ? [] : Object.entries(specGrandfather as Readonly<Record<string, number>>)
  )

  // Which rules run in which class is the rule set's `scopes`: by default a
  // doctrine page and a reader-facing page carry the forge-number,
  // tranche-slug and legacy-slug rules; product code carries the
  // tranche-slug rule alone; a spec carries all of those plus the
  // task-number rule, since a durable document that copies a plan's task
  // numbers goes stale the moment the plan is renumbered. The doctrine pages
  // are deliberately left out of the task-number rule — their own
  // report-only sweep names a much larger standing backlog, and a rule that
  // blocks belongs where it can be satisfied file by file.
  for (const file of files) {
    const cls = classifyProseFile(
      file.path,
      readerFacingPrefix,
      readerFacingSuffix,
      shipsPrefix,
      specPaths,
      productPaths
    )
    if (!cls || !REFERENCE_CLASSES.has(cls)) continue
    // A spec explicitly listed by path is grandfathered stock (already
    // failing when this sweep was extended to specs) and is skipped
    // entirely, not merely down-graded: the list shrinks as each spec's
    // prose is rewritten to state its facts plainly, never grows. The list
    // is matched against every spec-class file, so it exempts a default path
    // (a root spec, a decision record) exactly as it exempts a
    // per-product one — one exemption for the class, not one per path
    // source. A path listed with a number is not skipped: its findings are
    // counted below and reported only once they exceed that number.
    if (cls === 'spec' && grandfatheredWhole.has(file.path)) continue
    const scrubbed =
      cls === 'product' ? stripNonProseForProduct(file.path, file.content) : stripNonProse(file.path, file.content)
    const fileFindings: ProseFinding[] = []
    for (const rule of referenceRulesFor(set, cls)) {
      if (!ruleReads(set, rule, file.path)) continue
      const pattern = !rule.custom && rule.id === 'legacy-batch-name' ? legacyPattern : rule.patternFor(cls)
      if (!pattern) continue
      const blocking = rule.severity[cls] === 'error'
      // A product-code finding names its class in its own message.
      const what = cls === 'product' ? `${rule.message} in product code` : rule.message
      for (const { cited, index } of citations(pattern, scrubbed, rule.custom ? undefined : rule.reportGroup)) {
        // The line is the CITED text's own line, not the whole match's. A
        // boundary-checked pattern consumes the character before the
        // citation, and where that character is the newline ending the
        // previous line — a citation that opens a line — the match begins on
        // the previous line and a finding sent the reader there instead.
        fileFindings.push({
          file: file.path,
          line: lineAt(scrubbed, index),
          message: rule.custom
            ? customMessage(rule, cited)
            : `references ${what} ("${cited}") a reader outside this repo's tracker cannot resolve`,
          blocking,
          rule: rule.id
        })
      }
    }
    const limit = cls === 'spec' ? limits.get(file.path) : undefined
    if (limit !== undefined) {
      if (fileFindings.length <= limit) continue
      // Every finding of the over-limit file carries the count and the limit,
      // so whichever ones a diff-scoped run prints still name both.
      for (const f of fileFindings) {
        f.message += `; ${file.path} carries ${fileFindings.length} such findings, over its proseGates.specGrandfather limit of ${limit}`
      }
    }
    findings.push(...fileFindings)
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
  shipsPrefix: string = SHIPS_PREFIX,
  options: ProseSweepOptions = {}
): ProseFinding[] {
  const findings: ProseFinding[] = []
  const set = options.rules ?? DEFAULT_PROSE_RULE_SET
  // The built-in coined-term rule: switched off, it is absent from the set;
  // narrowed, it reads only the classes its scopes still name.
  const rule = set.rules.find((r) => !r.custom && r.id === 'coined-term')
  if (!rule) return findings

  for (const file of files) {
    const cls = classifyProseFile(
      file.path,
      readerFacingPrefix,
      readerFacingSuffix,
      shipsPrefix,
      DEFAULT_SPEC_PATHS,
      options.productPaths
    )
    if (!cls || !SWEPT_CLASSES.has(cls) || !rule.scopes.includes(cls)) continue
    if (!ruleReads(set, rule, file.path)) continue
    const scrubbed = stripNonProse(file.path, file.content)

    for (const term of glossaryTerms) {
      const line = findWholeWordLine(scrubbed, term)
      if (line === null) continue
      if (definesOrLinksGlossary(scrubbed, term)) continue
      findings.push({
        file: file.path,
        line,
        message: `uses coined term "${term}" without defining it inline or linking the glossary`,
        blocking: rule.severity[cls] === 'error',
        rule: rule.id
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
export const SOURCE_COMMENT_TRANCHE_SLUG_PATTERN = readerPattern('source-comment-tranche-slug', 'comment')

/** `#NNN`-shaped, source-comment class — no upper digit-count bound (unlike `FORGE_NUMBER_PATTERN`'s `{2,4}`), since a forge's issue/PR numbering has no fixed ceiling. */
export const SOURCE_COMMENT_FORGE_NUMBER_PATTERN = readerPattern('source-comment-forge-number', 'comment')

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
  allowlist: readonly string[] = [],
  options: ProseSweepOptions = {}
): ProseFinding[] {
  const findings: ProseFinding[] = []
  const allowed = new Set(allowlist)
  const set = options.rules ?? DEFAULT_PROSE_RULE_SET
  const rules = rulesInScope(set, 'source-comment').filter((rule) => rule.group === 'reader-resolvable')

  for (const file of files) {
    if (!file.path.endsWith('.ts')) continue
    if (allowed.has(file.path)) continue
    const comments = extractComments(file.path, file.content)
    for (const rule of rules) {
      if (!ruleReads(set, rule, file.path)) continue
      const pattern = rule.patternFor('source-comment')
      if (!pattern) continue
      for (const { cited, index } of citations(pattern, comments)) {
        findings.push({
          file: file.path,
          line: lineAt(comments, index),
          message: rule.custom
            ? customMessage(rule, cited)
            : `comment cites ${rule.message} ("${cited}") a reader outside this repo's tracker cannot resolve`,
          blocking: rule.severity['source-comment'] === 'error',
          rule: rule.id
        })
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
  specGrandfather: SpecGrandfather = [],
  specPaths: readonly string[] = DEFAULT_SPEC_PATHS,
  options: ProseSweepOptions = {}
): ProseFinding[] {
  return [
    ...checkUnresolvableReferences(
      files,
      readerFacingPrefix,
      readerFacingSuffix,
      legacySlugs,
      shipsPrefix,
      specGrandfather,
      specPaths,
      options
    ),
    ...checkUndefinedVocabulary(files, glossaryTerms, readerFacingPrefix, readerFacingSuffix, shipsPrefix, options)
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
