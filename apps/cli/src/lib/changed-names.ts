/**
 * Maps a diff to the top-level declarations it actually touched, so the test
 * selector can follow the changed NAMES rather than the changed file.
 *
 * A file-level graph answers "which tests reach this file"; on a repository
 * where a widely-imported module holds dozens of unrelated exports, that is
 * still most of the suite. The question worth answering is "which tests reach
 * something this diff CHANGED", and the difference between the two is this
 * module.
 *
 * ## What it does
 *
 * For each changed file it takes the diff's line ranges on BOTH sides — the new
 * side against the working tree's content, the old side against the base's, so
 * a deleted or renamed declaration is attributed too — and asks which top-level
 * declaration each range falls inside. A declaration's range starts at its FULL
 * start (leading trivia and doc comments included), so an edit to a function's
 * own documentation is attributed to that function rather than to nothing.
 *
 * ## Intra-file dependency closure — the part that makes it safe
 *
 * Attributing a hunk to the declaration it sits in is not enough on its own. If
 * `helper` changes and `exported` calls it, a test that imports only `exported`
 * is genuinely affected, and a selector that stopped at "the hunk touched
 * `helper`" would drop it. So every top-level declaration's references to OTHER
 * top-level names in the same file are collected, and the affected set is closed
 * backwards over them: anything that references an affected name is itself
 * affected, transitively. The reference scan is by identifier text, which
 * over-approximates (a shadowing local of the same name creates an edge that
 * isn't real) — the safe direction.
 *
 * ## When it gives up, it gives up completely
 *
 * {@link ALL_NAMES} — the whole file is affected — is the answer for every hunk
 * that cannot be attributed to exactly one declaration: module-scope executable
 * code, an `import` or `export` statement (including `export *`, which can
 * supply any name, and `export default`), a destructuring or computed binding,
 * a region that parses to nothing, and any range falling outside every
 * declaration. This is never a narrowing: it is the file-level answer, which is
 * what the selector does when it is told nothing at all.
 */
import type { TypeScriptApi } from './ts-module-graph.js'

/** The whole file is affected — every name it exports, and every test that reaches it. */
export const ALL_NAMES = 'all' as const

/** The names a diff touched in one file, or {@link ALL_NAMES} when it cannot be narrowed to names. */
export type FileAffection = ReadonlySet<string> | typeof ALL_NAMES

/** A 1-based, inclusive line range. */
export type LineRange = { start: number; end: number }

export type FileDiff = {
  /** Absolute path of the changed file. */
  file: string
  /** The file's content now, or `null` when the diff deleted it. */
  after: string | null
  /** The file's content at the diff's base, or `null` when the diff added it. */
  before: string | null
  /** Changed line ranges on the NEW side. */
  afterRanges: readonly LineRange[]
  /** Changed line ranges on the OLD side — what a deletion or a rename leaves behind. */
  beforeRanges: readonly LineRange[]
}

/** Source extensions this module can parse into declarations; anything else is answered {@link ALL_NAMES}. */
const PARSEABLE = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

/**
 * The top-level names one parsed source attributes to a set of changed line
 * ranges, or `null` when any range cannot be attributed and the whole file is
 * therefore affected.
 */
function namesForRanges(
  ts: TypeScriptApi,
  fileName: string,
  source: string,
  ranges: readonly LineRange[]
): Set<string> | null {
  if (ranges.length === 0) return new Set()
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true)
  const lineOf = (pos: number): number => sourceFile.getLineAndCharacterOfPosition(pos).line + 1

  /** Every top-level declaration, with the line span it owns and the name it declares. A `null` name is a statement no hunk can be attributed to. */
  const declarations: Array<{ name: string | null; start: number; end: number; node: import('typescript').Node }> = []
  /**
   * Where a declaration's OWN text begins: its first leading comment when it has
   * one (a doc comment is part of the declaration for attribution — editing it
   * is editing that declaration), otherwise the declaration itself. Deliberately
   * not `getFullStart()`, which reaches back to the previous statement's end and
   * would make the blank line after `a` belong to `b` as well.
   */
  const declarationStart = (statement: import('typescript').Node): number => {
    const comments = ts.getLeadingCommentRanges(source, statement.getFullStart())
    return comments && comments.length > 0 ? (comments[0] as { pos: number }).pos : statement.getStart(sourceFile)
  }
  for (const statement of sourceFile.statements) {
    const span = { start: lineOf(declarationStart(statement)), end: lineOf(statement.getEnd()) }
    // A variable statement can declare several names at once; each is its own
    // declaration for attribution, and a destructuring pattern declares none
    // this can name.
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        declarations.push({
          name: ts.isIdentifier(declaration.name) ? declaration.name.text : null,
          ...span,
          node: statement
        })
      }
      continue
    }
    const named =
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    const name = named && statement.name && ts.isIdentifier(statement.name) ? statement.name.text : null
    declarations.push({ name, ...span, node: statement })
  }

  const topLevelNames = new Set(declarations.map((d) => d.name).filter((n): n is string => n !== null))

  const seeded = new Set<string>()
  for (const range of ranges) {
    // A zero-width range (git's `+0` / `-0` count on a pure insertion or
    // deletion) has no content on this side; the other side carries it.
    if (range.end < range.start) continue
    const overlapping = declarations.filter((d) => d.start <= range.end && range.start <= d.end)
    // No declaration owns this range (a hunk past the last statement, or in a
    // file that parsed to nothing), or one that owns it declares no name this
    // can follow — either way the file is wholly affected.
    if (overlapping.length === 0) return null
    for (const d of overlapping) {
      if (d.name === null) return null
      seeded.add(d.name)
    }
  }

  // Close backwards over intra-file references: anything that uses an affected
  // name is affected too.
  const references = new Map<string, Set<string>>()
  for (const d of declarations) {
    if (d.name === null) continue
    const used = references.get(d.name) ?? new Set<string>()
    const visit = (node: import('typescript').Node): void => {
      if (ts.isIdentifier(node) && node.text !== d.name && topLevelNames.has(node.text)) used.add(node.text)
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(d.node, visit)
    references.set(d.name, used)
  }
  const affected = new Set(seeded)
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, used] of references) {
      if (affected.has(name)) continue
      for (const u of used) {
        if (!affected.has(u)) continue
        affected.add(name)
        grew = true
        break
      }
    }
  }
  return affected
}

/**
 * The exported names one file's diff affects — the union of what its new-side
 * and old-side ranges attribute, or {@link ALL_NAMES} the moment either side
 * cannot be attributed.
 */
export function affectedNamesForFile(ts: TypeScriptApi, diff: FileDiff): FileAffection {
  if (!PARSEABLE.some((ext) => diff.file.endsWith(ext))) return ALL_NAMES
  const names = new Set<string>()
  for (const [source, ranges] of [
    [diff.after, diff.afterRanges],
    [diff.before, diff.beforeRanges]
  ] as const) {
    if (source === null) {
      // A side with no content contributes nothing — an added file has no old
      // side, a deleted one has no new side — but a range claimed on a side
      // that does not exist is unattributable.
      if (ranges.some((r) => r.end >= r.start)) return ALL_NAMES
      continue
    }
    let attributed: Set<string> | null
    try {
      attributed = namesForRanges(ts, diff.file, source, ranges)
    } catch {
      attributed = null // an unparseable region is exactly the case that must widen, not narrow.
    }
    if (attributed === null) return ALL_NAMES
    for (const n of attributed) names.add(n)
  }
  return names
}

/** {@link affectedNamesForFile} over a whole diff, keyed by absolute file path — the shape the selector's `affectedNames` option takes. */
export function affectedNames(ts: TypeScriptApi, diffs: readonly FileDiff[]): Map<string, FileAffection> {
  const out = new Map<string, FileAffection>()
  for (const diff of diffs) out.set(diff.file, affectedNamesForFile(ts, diff))
  return out
}

/**
 * Parses `git diff -U0` unified-diff line ranges out of a single file's patch
 * text. `@@ -a,b +c,d @@` — `b`/`d` default to 1 when omitted, and a count of
 * `0` marks a side with no content there (a pure insertion or deletion), which
 * is represented as an empty range rather than dropped, so the caller can tell
 * "nothing on this side" from "no hunks at all".
 */
export function parseHunkRanges(patch: string): { beforeRanges: LineRange[]; afterRanges: LineRange[] } {
  const beforeRanges: LineRange[] = []
  const afterRanges: LineRange[] = []
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  for (let m = header.exec(patch); m !== null; m = header.exec(patch)) {
    const oldStart = Number(m[1])
    const oldCount = m[2] === undefined ? 1 : Number(m[2])
    const newStart = Number(m[3])
    const newCount = m[4] === undefined ? 1 : Number(m[4])
    beforeRanges.push({ start: oldStart, end: oldStart + oldCount - 1 })
    afterRanges.push({ start: newStart, end: newStart + newCount - 1 })
  }
  return { beforeRanges, afterRanges }
}
