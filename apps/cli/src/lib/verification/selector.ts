/**
 * Resolves, through the real import graph, which tests a change could affect.
 * Never a folder heuristic: a changed file selects a test only when that
 * test's own transitive import closure actually reaches a USE of something the
 * change touched, so a change in one file of a large directory never drags in
 * every sibling test that happens to share its folder.
 *
 * Two entrypoints share every mechanism below:
 *
 * - {@link selectTests} — the immutable selection: a repository reader, two
 *   committed revisions, the validated inventory and an explicit policy in; a
 *   reproducible plan out. Every file it reads comes from one of the two
 *   revisions through the reader, never from a checkout.
 * - {@link selectAffectedFiles} — the file-list selection over one tree (a
 *   checkout on disk, or a revision's snapshot), the shape every existing
 *   caller reads.
 *
 * ## Resolution is the TypeScript compiler's
 *
 * Module resolution, named-import alias resolution to the defining file,
 * re-export chains and bare workspace-package specifiers all come from the
 * compiler API — see `compiler-graph.ts`, which also explains how the compiler
 * gets here without becoming a shipped runtime dependency. The text scan below
 * (`extractImportRecords` and everything it feeds) is the FALLBACK for a
 * repository with no `typescript` to resolve: a strict over-approximation of
 * the compiler's answer, never a narrower one.
 *
 * A regular expression can read the specifier `'./demo.js'`; it cannot know
 * that the file on disk is `demo.ts`. A selector that drops edges does not
 * over-select; it silently under-selects, and its reported reductions are lost
 * edges wearing precision's clothes.
 *
 * ## Selection follows the changed NAMES, not the changed file
 *
 * A diff is mapped to the top-level declarations its hunks touch
 * (`changed-names.ts`), and a test is selected when its closure reaches a use of
 * one of THOSE names. A hunk that cannot be attributed to a single declaration —
 * module-scope code, an import statement, an `export *`, a computed name, an
 * unparseable region — makes the whole file affected, which is the file-level
 * answer. The default for a caller that computes no names at all is also the
 * file-level answer: narrowing is always something the selector must EARN.
 *
 * ## Cross-package resolution — named exports, with conservative fallback
 *
 * A bare `@scope/name` specifier that matches another workspace package is
 * resolved THROUGH THAT PACKAGE'S EXPORTED NAMES, not treated as a dependency on
 * the whole package: `import { foo } from '@scope/pkg'` depends only on the
 * files traversed to resolve `foo` — the package's declared entrypoint, every
 * re-export hop, and the file that actually defines `foo` — never on
 * `@scope/pkg`'s other, unrelated files. The entrypoint comes from the package's
 * own manifest (`exports`/`main`, conditions included), handed to the compiler
 * as `paths`, so the graph never depends on how an installer laid out
 * `node_modules`.
 *
 * Every file on that path becomes a name-level edge: a change to it selects only
 * when the change touched the name this importer resolved through. A NON-source
 * change inside a package (its `package.json`, `tsconfig.json`, or a non-`.ts`
 * asset) is not a graph node at all, so a precisely-resolved importer also
 * carries a `pkgmeta:<pkg>` marker that fires only on such a change — editing
 * `exports`/`main` re-points what every consumer resolves to. One such marker is
 * carried for EVERY package on the resolution path, not only the
 * directly-imported one.
 *
 * ## Tests that read the repository rather than importing it
 *
 * An import edge cannot reach a test whose input is the repository TREE — one
 * that walks source files from disk and asserts something about all of them.
 * `scanner-inputs.ts` classifies these from their own source and the selector
 * gives each a `scan:` edge over the directory it actually walks. That edge
 * selects on ANY change under the roots, so a depth-one selection withholds it
 * and keeps instead each scanner's declared trigger: the kind of change the
 * test judges.
 *
 * ## Tests that spawn a program as a fresh subprocess
 *
 * The same gap, one class further removed: a test that runs a program's
 * entrypoint as a subprocess names no import of the code it exercises.
 * `spawn-inputs.ts` classifies these from their own source and the selector
 * gives each a synthetic `all:`-prefixed edge to the entrypoint FILE itself, so
 * the entrypoint's own already-computed real import edges do the rest. A spawn
 * shape the classifier cannot read as precisely falls back to a `scan:` edge
 * over the entrypoint's own source directory — never silence.
 *
 * ## Conservative fallback — over-select, never omit
 *
 * The refinement can only ever REMOVE the whole-package edge when it can PROVE a
 * name maps to specific files. Every shape it cannot prove safe retains the
 * whole-package dependency (`external:<pkg>`), so the selector may over-select
 * but never omits a truly affected test. Shapes that fall back: namespace
 * imports (`import * as ns`), default imports, side-effect imports, dynamic
 * imports, `export *` re-exports, `import x = require(...)`, a name whose alias
 * chain does not terminate in a declaration, a name supplied ambiguously by more
 * than one `export *` source, and a package whose entrypoint/subpath cannot be
 * derived from its manifest. Aliases (`import { a as b }`) and `type` imports are
 * mapped by their EXPORTED (origin) name, never the local alias, so they resolve
 * precisely rather than falling back.
 *
 * The same rule governs an `exports` CONDITIONS object: the runtime picks a
 * target by which condition is active, which no static analysis can know, so a
 * conditions object is honoured only when every runtime condition it declares
 * lands on the SAME source file. `types`/`typings` are excluded outright — a
 * declaration file is what type-checking loads, never what runs.
 *
 * ## Residual over-selection this design accepts
 *
 * Traversing into a name's defining file walks that FILE's imports, not the
 * declaration's own — so a change to a helper only a sibling declaration uses
 * still selects. The wider answer is the safe one and this keeps it.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { affectedNames as attributeNames, type FileDiff, lineDiffRanges } from './changed-names.js'
import {
  ALL_PREFIX,
  buildCompilerGraph,
  EXTERNAL_PREFIX,
  loadLibraryTypeScript,
  loadTypeScript,
  NAME_PREFIX,
  NAME_SEPARATOR,
  OWN_PREFIX,
  PKGMETA_PREFIX,
  SCAN_PREFIX,
  type SourceHost,
  TOUCH_PREFIX,
  type TypeScriptApi
} from './compiler-graph.js'
import {
  changedInputReaders,
  diffTestIdentities,
  edgeCovers,
  stableHash,
  stableJson,
  validateInventory
} from './inventory.js'
import { globToRegex, inputCovers, underDeclaredRoot } from './path-pattern.js'
import { type ScannerDeclaration, scannedRootsOf, scannerTriggered } from './scanner-inputs.js'
import { type SpawnProgram, spawnEdgeOf } from './spawn-inputs.js'
import type {
  FallbackScope,
  InventoryView,
  PlannedChange,
  PlannedObligation,
  PlannedTest,
  PlanReason,
  RepositoryReader,
  SelectionPlan,
  SelectionPolicy,
  SelectTestsInput,
  SuiteConfiguration
} from './types.js'

// ── Trees ───────────────────────────────────────────────────────────────────

/**
 * The files one selection reads, under one absolute root: a checkout on disk
 * ({@link diskTree}) or a committed revision's snapshot ({@link revisionTree}).
 * Every path is absolute.
 */
export type SourceTree = {
  root: string
  /** A directory's entry names, or `null` when it is not a readable directory. */
  readDir(path: string): string[] | null
  /** Whether a path is a directory, anything else that exists, or nothing. */
  kind(path: string): 'directory' | 'file' | null
  /** A file's text, or `null` when it cannot be read. */
  readFile(path: string): string | null
  /** The compiler's view of the same files; absent, the compiler reads the disk. */
  host?: SourceHost
}

/** The disk under `root`, read exactly as a checkout is read — symbolic links followed, nothing cached. */
export function diskTree(root: string): SourceTree {
  return {
    root,
    readDir: (path) => {
      try {
        return readdirSync(path)
      } catch {
        return null
      }
    },
    kind: (path) => {
      try {
        return statSync(path).isDirectory() ? 'directory' : 'file'
      } catch {
        return null
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    }
  }
}

/**
 * One committed revision's files as a tree under the virtual `root`, read only
 * through `repo` for exactly `revision`. Nothing on disk under `root` is ever
 * consulted — the root is a name, not a place — and the compiler is given the
 * same view, so a checkout's state cannot reach the selection.
 */
export function revisionTree(
  repo: RepositoryReader,
  revision: string,
  files: readonly string[],
  root: string
): SourceTree {
  const fileSet = new Set(files)
  const children = new Map<string, Set<string>>()
  children.set('', new Set())
  for (const file of files) {
    const parts = file.split('/')
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      const set = children.get(parent) ?? new Set<string>()
      children.set(parent, set)
      set.add(parts[i] as string)
    }
  }
  const relative = (path: string): string | null =>
    path === root ? '' : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
  const cache = new Map<string, string | null>()
  const readFile = (path: string): string | null => {
    const rel = relative(path)
    if (rel === null || !fileSet.has(rel)) return null
    if (!cache.has(rel)) cache.set(rel, repo.read(revision, rel))
    return cache.get(rel) ?? null
  }
  const isDir = (path: string): boolean => {
    const rel = relative(path)
    return rel !== null && children.has(rel) && !fileSet.has(rel)
  }
  return {
    root,
    readDir: (path) => {
      const rel = relative(path)
      if (rel === null || !isDir(path)) return null
      return [...(children.get(rel) ?? [])].sort()
    },
    kind: (path) => {
      const rel = relative(path)
      if (rel === null) return null
      if (fileSet.has(rel)) return 'file'
      return children.has(rel) ? 'directory' : null
    },
    readFile,
    host: {
      fileExists: (path) => {
        const rel = relative(path)
        return rel !== null && fileSet.has(rel)
      },
      readFile: (path) => readFile(path) ?? undefined,
      directoryExists: isDir,
      getDirectories: (path) => {
        const rel = relative(path)
        if (rel === null || !isDir(path)) return []
        return [...(children.get(rel) ?? [])].filter((name) => isDir(join(path, name))).sort()
      }
    }
  }
}

// ── Repository readers ──────────────────────────────────────────────────────

/** An in-memory repository: each revision a map of repository-relative path to text. For fixtures and tests. */
export function memoryRepository(
  revisions: Readonly<Record<string, Readonly<Record<string, string>>>>
): RepositoryReader {
  const files = (revision: string): Readonly<Record<string, string>> => {
    const tree = revisions[revision]
    if (!tree) throw new Error(`revision ${revision} is not in this repository`)
    return tree
  }
  return {
    list: (revision) => Object.keys(files(revision)).sort(),
    read: (revision, path) => files(revision)[path] ?? null,
    identity: (revision, path) => {
      const text = files(revision)[path]
      return text === undefined ? null : createHash('sha256').update(text).digest('hex')
    }
  }
}

/** Blobs larger than this are not loaded in the one batch read; reading one answers `null`, which selection treats as unreadable. */
const MAX_BATCH_BLOB_BYTES = 4 << 20

/**
 * A git repository's committed objects, read by object id and nothing else:
 * `git ls-tree` lists a revision, `git cat-file --batch` reads its blobs in
 * one process. No working tree, index, branch or remote is consulted, so the
 * answer for a revision never depends on the checkout around it.
 *
 * `revision` must name a commit; pass resolved commit ids for a reproducible
 * plan, since a branch name or `HEAD` moves. Git's own repository-locating
 * environment (`GIT_DIR` and friends) is the caller's to set or clear.
 */
export function gitRepository(repoRoot: string): RepositoryReader {
  const git = (args: string[], input?: string): Buffer =>
    execFileSync('git', args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1 << 30,
      ...(input !== undefined ? { input } : {})
    })
  const listings = new Map<string, Map<string, { id: string; size: number }>>()
  const blobs = new Map<string, Buffer | null>()
  const listing = (revision: string): Map<string, { id: string; size: number }> => {
    let entries = listings.get(revision)
    if (!entries) {
      entries = new Map()
      const out = git(['ls-tree', '-r', '-z', '-l', '--full-tree', `${revision}^{commit}`]).toString('utf8')
      for (const record of out.split('\0')) {
        if (!record) continue
        const tab = record.indexOf('\t')
        const [, type, id, size] = record.slice(0, tab).split(/\s+/)
        if (type !== 'blob') continue
        entries.set(record.slice(tab + 1), { id: id as string, size: Number(size) })
      }
      listings.set(revision, entries)
    }
    return entries
  }
  const loadBatch = (revision: string): void => {
    const wanted = [
      ...new Set([...listing(revision).values()].filter((e) => e.size <= MAX_BATCH_BLOB_BYTES).map((e) => e.id))
    ].filter((id) => !blobs.has(id))
    if (wanted.length === 0) return
    const out = git(['cat-file', '--batch'], `${wanted.join('\n')}\n`)
    let at = 0
    while (at < out.length) {
      const eol = out.indexOf(0x0a, at)
      if (eol < 0) break
      const [id, type, size] = out.subarray(at, eol).toString('utf8').split(' ')
      if (type === 'missing' || size === undefined) {
        blobs.set(id as string, null)
        at = eol + 1
        continue
      }
      const length = Number(size)
      blobs.set(id as string, out.subarray(eol + 1, eol + 1 + length))
      at = eol + 1 + length + 1
    }
  }
  return {
    list: (revision) => [...listing(revision).keys()].sort(),
    identity: (revision, path) => listing(revision).get(path)?.id ?? null,
    read: (revision, path) => {
      const entry = listing(revision).get(path)
      if (!entry) return null
      if (!blobs.has(entry.id)) loadBatch(revision)
      return blobs.get(entry.id)?.toString('utf8') ?? null
    }
  }
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage'])

/**
 * The TypeScript output extension a specifier may be WRITTEN with, mapped to the
 * source extensions that actually compile to it. ESM requires a real extension on
 * a relative specifier, and TypeScript's answer is that you write the extension
 * the EMIT will have (`./demo.js`) while the file on disk is `./demo.ts` — so in
 * a repository written that way, resolving a specifier by "the literal path,
 * then the path plus each source extension" finds nothing at all: `demo.js` is
 * not a file, and `demo.js.ts` is not either. Every such edge would be silently
 * absent from the graph, and a change to `demo.ts` would select no test that
 * imports it by name.
 *
 * The mapping is TypeScript's own (`.js` may be `.ts`/`.tsx`, `.jsx` is `.tsx`,
 * and the single-format `.mjs`/`.cjs` map only to their matching `.mts`/`.cts`),
 * and it is tried only AFTER the literal path, so a real `.js` file sitting next
 * to a `.ts` of the same name still resolves to itself exactly as Node would.
 */
const OUTPUT_TO_SOURCE_EXTENSIONS = new Map<string, readonly string[]>([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']]
])

// A `from`-clause on an `import` or `export`, capturing the keyword (group 1),
// the clause text between it and `from` (group 2), and the specifier (group 4).
// `\b\s*` after the keyword tolerates a whitespace-free clause (`export{a}from'x'`)
// so such a shape still yields a record — the selector must degrade a shape it
// cannot fully read to the coarse edge, never to silence. `[^'"]*?` spans newlines
// (a negated class matches `\n`), so a multi-line `{ a,\n b }` clause parses; it
// can never cross a string literal because quotes are excluded.
const FROM_CLAUSE_RE = /^\s*(import|export)\b\s*([^'"]*?)\bfrom\s*(['"])([^'"]+)\3/gm
// The one clause shape the scan above cannot read: a brace list carrying a STRING
// export name (`import { "a-b" as ab } from 'x'`, legal since ES2022). Excluding
// quotes there dropped the whole statement — silence, not a fallback, and with it
// the specifier's graph edge.
//
// It gets its own bounded regex rather than a relaxed clause class in
// FROM_CLAUSE_RE, for two reasons. Correctness: admitting quotes into that lazy
// scan lets `export const A = 'x'` run past the string and swallow a real named
// import on the line below, coarsening it. Cost: the alternation needed to admit
// them only inside braces backtracks over every `export` statement that has no
// `from` at all, which measured 63 ms → 346 ms across a large repository's sources — paid
// on every push. So this twin admits quotes only inside ONE brace list that
// `from` must immediately follow: an optional `type`, an optional default
// binding, one `{…}`, then the specifier. A list like that parses to a
// non-identifier entry, so the importer still keeps the coarse edge — but the
// record, and the edge, exist.
const QUOTED_LIST_CLAUSE_RE =
  /^\s*(import|export)\b\s*((?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^{}]*\})\s*from\s*(['"])([^'"]+)\3/gm
// A side-effect import `import '<spec>'` — the quote immediately after `import`
// distinguishes it from `import { … } from '<spec>'`.
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*(['"])([^'"]+)\1/gm
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g
// `import x = require('<spec>')`, and its `export import` form. This shape has
// no `from` keyword, no quote directly after `import`, and no `import(` call,
// so not one of the scans above can see it — and a shape this scan cannot see
// contributes no edge at all, which is SILENCE, not the coarse fallback every
// other unreadable shape degrades to. The compiler graph already treats it
// coarsely (`ts-module-graph.ts`'s `ImportEqualsDeclaration` branch); this is
// the same treatment for the text-scan graph, which is the one a repository
// with no `typescript` installed actually runs.
const IMPORT_EQUALS_REQUIRE_RE =
  /^\s*(?:export\s+)?import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*(['"])([^'"]+)\1\s*\)/gm
// Line and block comments, stripped from a brace list before it is split on
// commas so `import { a, /* keep */ b }` and a trailing `// note` resolve rather
// than dropping every name the comment abuts.
const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g

export type ImportRecord =
  /** `import { a, b as c } from 'x'` / `export { a } from 'x'` — origin names. `clean` is false when the brace list was empty or carried an entry that is not a bare identifier, so the importer must fall back to the whole-package edge rather than narrow to the parsed subset. */
  | { kind: 'named'; specifier: string; names: string[]; clean: boolean }
  /** `import * as ns from 'x'` — the whole module namespace. */
  | { kind: 'namespace'; specifier: string }
  /** `import def from 'x'` (or `def, { … }`) — a default binding is involved. */
  | { kind: 'default'; specifier: string }
  /** `export * from 'x'` — re-exports everything. */
  | { kind: 'star'; specifier: string }
  /** `import 'x'` — run for side effects only. */
  | { kind: 'side-effect'; specifier: string }
  /** `import('x')` — a dynamic specifier. */
  | { kind: 'dynamic'; specifier: string }

/**
 * Splits a `{ a, b as c, type d }` list into its EXPORTED (origin) names — the
 * alias and any `type` keyword dropped, since the origin name is what a target
 * package's export map is keyed by. `clean` reports whether EVERY entry parsed to
 * a bare identifier: an empty list (`{}`) or any entry that does not (a stray
 * token, an unstripped comment fragment) makes it false so the caller can keep
 * the coarse edge instead of silently narrowing to the names it happened to read.
 */
function parseNamedList(inside: string): { names: string[]; clean: boolean } {
  const names: string[] = []
  let clean = true
  const entries = inside
    .replace(COMMENT_RE, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (entries.length === 0) clean = false // `import {} from 'x'` — nothing named, but the module still runs.
  for (const raw of entries) {
    const entry = raw.replace(/^type\s+/, '')
    // `a as b` → origin is `a`; a bare `a` → origin is `a`.
    const origin = (entry.split(/\s+as\s+/)[0] as string).trim()
    if (/^[A-Za-z_$][\w$]*$/.test(origin)) names.push(origin)
    else clean = false
  }
  return { names, clean }
}

/** Classifies a `from`-clause into an {@link ImportRecord} kind for `specifier`. */
function classifyFromClause(clause: string, specifier: string): ImportRecord {
  const c = clause.trim().replace(/^type\s+/, '')
  if (c.startsWith('*')) {
    // `* as ns` (namespace import) or a bare `*` (star re-export).
    return /^\*\s+as\s+/.test(c) ? { kind: 'namespace', specifier } : { kind: 'star', specifier }
  }
  if (c.startsWith('{')) {
    const { names, clean } = parseNamedList(c.slice(1, c.lastIndexOf('}')))
    return { kind: 'named', specifier, names, clean }
  }
  // Anything else begins with a default binding (`def` or `def, { … }` or
  // `def, * as ns`) — a default export is never provably mapped, so coarse.
  return { kind: 'default', specifier }
}

function collectRecords(source: string, includeExportFrom: boolean): ImportRecord[] {
  const records: ImportRecord[] = []
  FROM_CLAUSE_RE.lastIndex = 0
  for (let m = FROM_CLAUSE_RE.exec(source); m !== null; m = FROM_CLAUSE_RE.exec(source)) {
    if (!includeExportFrom && m[1] !== 'import') continue
    records.push(classifyFromClause(m[2] as string, m[4] as string))
  }
  QUOTED_LIST_CLAUSE_RE.lastIndex = 0
  for (let m = QUOTED_LIST_CLAUSE_RE.exec(source); m !== null; m = QUOTED_LIST_CLAUSE_RE.exec(source)) {
    // Only the statements the scan above skipped: without a quote in the clause
    // it already produced this record, and a duplicate buys nothing.
    if (!/['"]/.test(m[2] as string)) continue
    if (!includeExportFrom && m[1] !== 'import') continue
    records.push(classifyFromClause(m[2] as string, m[4] as string))
  }
  SIDE_EFFECT_IMPORT_RE.lastIndex = 0
  for (let m = SIDE_EFFECT_IMPORT_RE.exec(source); m !== null; m = SIDE_EFFECT_IMPORT_RE.exec(source)) {
    records.push({ kind: 'side-effect', specifier: m[2] as string })
  }
  DYNAMIC_IMPORT_RE.lastIndex = 0
  for (let m = DYNAMIC_IMPORT_RE.exec(source); m !== null; m = DYNAMIC_IMPORT_RE.exec(source)) {
    records.push({ kind: 'dynamic', specifier: m[2] as string })
  }
  // A whole-module binding, so it is classified as a namespace — never a named
  // list, and therefore always the coarse edge. It is emitted regardless of
  // `includeExportFrom`: even the `export import` form runs the target module
  // on every import through this file, so a re-export hop owes it too.
  IMPORT_EQUALS_REQUIRE_RE.lastIndex = 0
  for (let m = IMPORT_EQUALS_REQUIRE_RE.exec(source); m !== null; m = IMPORT_EQUALS_REQUIRE_RE.exec(source)) {
    records.push({ kind: 'namespace', specifier: m[2] as string })
  }
  return records
}

/** Every import/export edge a source file declares, classified by shape. Order-preserving; the same specifier may appear more than once. */
export function extractImportRecords(source: string): ImportRecord[] {
  return collectRecords(source, true)
}

/**
 * The edges a source file pulls into its OWN module scope — every `import`, side
 * effect and dynamic specifier, with `export … from` deliberately EXCLUDED. This
 * is what a re-export hop contributes to the graph beyond the one re-export an
 * importer resolved through it: the hop's own module code runs on every import
 * through it, while its other re-exports must stay untraversed or the barrel
 * fans back out to its whole package. Shares {@link FROM_CLAUSE_RE} with
 * {@link extractImportRecords} rather than a narrower binding parser, so a clause
 * shape the binding parser cannot read (`import def, { a } from 'x'`,
 * `import{a}from'x'`) still yields the hop's dependency edge instead of silence.
 */
export function extractOwnImportRecords(source: string): ImportRecord[] {
  return collectRecords(source, false)
}

/** The distinct import specifiers a source file references — every `from`-clause, side-effect and dynamic import. Kept as the thin, shape-agnostic view over {@link extractImportRecords} (which the graph builder uses directly); exported for tests and any future caller that needs specifiers without their import shape. */
export function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  for (const record of extractImportRecords(source)) specifiers.add(record.specifier)
  return [...specifiers]
}

/** Every regular file under `root` in `tree`, skipping `SKIP_DIRS` — absolute paths. */
export function walkTree(tree: SourceTree, root: string): string[] {
  const out: string[] = []
  const entries = tree.readDir(root)
  if (entries === null) return out
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(root, entry)
    const kind = tree.kind(abs)
    if (kind === null) continue
    if (kind === 'directory') {
      out.push(...walkTree(tree, abs))
    } else {
      out.push(abs)
    }
  }
  return out
}

/** Resolves a module base path against `knownFiles` — tries the bare path, the TypeScript SOURCE of a written output extension ({@link OUTPUT_TO_SOURCE_EXTENSIONS}), each `SOURCE_EXTENSIONS` suffix, and an `index.<ext>` inside it as a directory, the same resolution order Node/TypeScript/bundlers use. `null` when nothing matches. */
function resolveFileCandidate(base: string, knownFiles: Set<string>): string | null {
  if (knownFiles.has(base)) return base
  const written = extname(base)
  for (const ext of OUTPUT_TO_SOURCE_EXTENSIONS.get(written) ?? []) {
    const source = base.slice(0, -written.length) + ext
    if (knownFiles.has(source)) return source
  }
  for (const ext of SOURCE_EXTENSIONS) {
    if (knownFiles.has(base + ext)) return base + ext
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const indexed = join(base, `index${ext}`)
    if (knownFiles.has(indexed)) return indexed
  }
  return null
}

/**
 * Resolves a relative specifier from `fromFile` against the real files in
 * `knownFiles` (a package's own file set). `null` when nothing matches (an
 * untraceable import — a JSON file, a CSS module, a package that isn't this one
 * — is not a resolution failure worth halting the selector over).
 */
export function resolveRelativeImport(fromFile: string, specifier: string, knownFiles: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null
  return resolveFileCandidate(resolve(dirname(fromFile), specifier), knownFiles)
}

export type WorkspacePackage = {
  /** Absolute directory. */
  dir: string
  /** `package.json`'s own `name`, e.g. `@scope/core`. */
  name: string
  /**
   * Whether this package's own declared `test` script actually runs under
   * `bun test` — the one runner a {@link SelectionResult.selected} caller
   * invokes on whatever is selected. A package whose real `test`
   * script is something else (`vitest run`, most commonly — real `vi.mock`
   * support `bun:test`'s own compat shim does not provide) is never
   * bun-test-compatible: selecting one of its files here would hand the hook a
   * file it cannot correctly execute regardless of which lines changed, a tool
   * mismatch no import-graph refinement fixes. A package with no declared
   * `test` script at all is trivially compatible — it has nothing this selector
   * could mis-select.
   */
  bunTestCompatible: boolean
  /**
   * The native runner this package's own declared `test` script invokes, read
   * from the script text: `bun` (`bun test`), `vitest`, `other` for any other
   * command, `none` when no `test` script is declared. Only a `bun` or `none`
   * package's tests ever reach {@link SelectionResult.selected}; a caller
   * that asks for the others gets them, runner named, in
   * {@link SelectionResult.native}.
   */
  testRunner?: TestRunner
  /**
   * `exports`/`main` subpath → absolute entrypoint source file, e.g. `.` →
   * `<dir>/src/index.ts` and `./docs` → `<dir>/src/docs/index.ts`. Derived
   * purely from the package manifest (never a folder guess); a package with
   * neither field, or a subpath that resolves to no real source file, is simply
   * absent from the map, which makes every bare import of it fall back to the
   * whole-package edge.
   */
  entrypoints: Map<string, string>
  /** Absolute paths of this package's own source files (`SOURCE_EXTENSIONS`), walked once here so the selector reuses them rather than re-walking every package directory at push time. */
  sourceFiles: string[]
}

function isBunTestScript(script: string | undefined): boolean {
  if (!script) return true
  return /(^|[\s;&|])bun\s+test\b/.test(script)
}

/** A package's native test runner, as {@link WorkspacePackage.testRunner} names it. */
export type TestRunner = 'bun' | 'vitest' | 'other' | 'none'

/** Reads the native runner a `test` script invokes ({@link WorkspacePackage.testRunner}). */
export function testRunnerOf(script: string | undefined): TestRunner {
  if (!script) return 'none'
  if (isBunTestScript(script)) return 'bun'
  if (/(^|[\s;&|])vitest(\s|$)/.test(script)) return 'vitest'
  return 'other'
}

type PackageManifest = {
  name?: string
  main?: string
  exports?: string | Record<string, unknown>
  scripts?: { test?: string }
}

/** `exports` conditions that select a TYPE-ONLY target — never what the runtime executes, so never an entrypoint this selector resolves names into. */
const TYPE_ONLY_CONDITIONS = new Set(['types', 'typings'])

/**
 * Every target an `exports` entry could hand the runtime, in the order the
 * manifest declares them. A bare string is its own only target; a conditions
 * object contributes each of its non-type-only branches, nested objects and
 * fallback arrays walked in their own declaration order.
 */
function declaredTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (!value || typeof value !== 'object') return out
  for (const [key, cond] of Object.entries(value as Record<string, unknown>)) {
    if (TYPE_ONLY_CONDITIONS.has(key)) continue
    declaredTargets(cond, out)
  }
  return out
}

/** Reads a package manifest's `exports`/`main` and resolves each subpath to a real source file under `dir`, keyed by its subpath (`.` for the package root). */
function deriveEntrypoints(dir: string, pkg: PackageManifest, knownFiles: Set<string>): Map<string, string> {
  const out = new Map<string, string>()
  // Which branch of a conditions object the runtime takes depends on which
  // condition is ACTIVE there (`import` vs `require`, `node` vs `browser`) — a
  // fact no static text scan can know. So rather than guessing with a fixed
  // preference order, every declared runtime target is resolved and the subpath
  // is mapped only when they all land on the SAME source file: one file is the
  // provable answer whichever condition wins. Two different files is an
  // unprovable choice, so the subpath is left unmapped and every bare import of
  // it keeps the conservative whole-package edge. A target that resolves to no
  // source file at all (a built `./dist/index.js`) is simply not a candidate —
  // it is never a changed file in the repository, so it constrains nothing.
  const add = (subpath: string, value: unknown): void => {
    const files = new Set<string>()
    for (const target of declaredTargets(value)) {
      // A target re-pointing at ANOTHER package (`{ import: '@scope/other' }`)
      // is not a path under `dir` to resolve, and the runtime may well take it —
      // so it makes the whole subpath unprovable rather than ceding the choice
      // to whichever sibling target happens to be relative.
      if (!target.startsWith('.')) return
      const resolved = resolveFileCandidate(resolve(dir, target), knownFiles)
      if (resolved) files.add(resolved)
    }
    if (files.size === 1) out.set(subpath, files.values().next().value as string)
  }
  if (typeof pkg.exports === 'string') {
    add('.', pkg.exports)
  } else if (pkg.exports && typeof pkg.exports === 'object') {
    for (const [subpath, value] of Object.entries(pkg.exports)) {
      if (subpath.startsWith('.')) add(subpath, value)
    }
  }
  if (!out.has('.') && pkg.main) add('.', pkg.main)
  return out
}

/**
 * The root manifest's `workspaces` entries — the array form, or the `packages`
 * array of the object form — or `null` when the manifest is missing or not
 * JSON.
 */
export function readWorkspacePatterns(tree: SourceTree): string[] | null {
  try {
    const rootPkg = JSON.parse(tree.readFile(join(tree.root, 'package.json')) ?? '') as {
      workspaces?: string[] | { packages?: string[] }
    }
    const declared = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages ?? [])
    return declared.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return null
  }
}

/** One workspace-pattern segment as a matcher: `*` inside a segment matches any run of characters except `/`. */
function segmentMatcher(segment: string): (entry: string) => boolean {
  if (!segment.includes('*')) return (entry) => entry === segment
  const re = new RegExp(`^${segment.split('*').map(escapeForRegex).join('[^/]*')}$`)
  return (entry) => re.test(entry)
}

function escapeForRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Expands workspace patterns to the repository-relative directories they
 * name, in declaration order and each once: a literal directory (`harness`),
 * a glob in the last segment (`apps/*`) or in any segment
 * (`harness/processes/*`). A `!`-prefixed pattern removes what it matches. A
 * `**` segment is never expanded: the directories it would name stay absent,
 * so nothing under them is modeled and every path there keeps the
 * conservative answer.
 */
export function expandWorkspacePatterns(tree: SourceTree, patterns: readonly string[]): string[] {
  const expand = (pattern: string): string[] => {
    const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/').filter(Boolean)
    if (segments.length === 0 || segments.includes('**')) return []
    let dirs = ['']
    for (const segment of segments) {
      const matches = segmentMatcher(segment)
      const next: string[] = []
      for (const dir of dirs) {
        if (!segment.includes('*')) {
          next.push(dir ? `${dir}/${segment}` : segment)
          continue
        }
        const entries = tree.readDir(join(tree.root, dir))
        if (entries === null) continue
        for (const entry of [...entries].sort()) {
          if (SKIP_DIRS.has(entry) || !matches(entry)) continue
          const child = dir ? `${dir}/${entry}` : entry
          if (tree.kind(join(tree.root, child)) === 'directory') next.push(child)
        }
      }
      dirs = next
    }
    return dirs
  }
  const out: string[] = []
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      const removed = new Set(expand(pattern.slice(1)))
      for (let i = out.length - 1; i >= 0; i--) if (removed.has(out[i] as string)) out.splice(i, 1)
      continue
    }
    for (const dir of expand(pattern)) if (!out.includes(dir)) out.push(dir)
  }
  return out
}

/**
 * The repository-relative directories of every workspace member with a real,
 * named `package.json`, found from the root manifest's own `workspaces`
 * entries ({@link expandWorkspacePatterns}) — never a fixed list of folders,
 * so a member moved under a new parent (`harness/kernel`,
 * `harness/processes/<name>`) is found the moment the manifest names it.
 */
export function discoverWorkspaceDirs(tree: SourceTree): string[] {
  const patterns = readWorkspacePatterns(tree)
  if (!patterns) return []
  return expandWorkspacePatterns(tree, patterns).filter((dir) => {
    try {
      const pkg = JSON.parse(tree.readFile(join(tree.root, dir, 'package.json')) ?? '') as PackageManifest
      return typeof pkg.name === 'string' && pkg.name.length > 0
    } catch {
      return false
    }
  })
}

/**
 * Reads the tree root's `package.json` `workspaces` entries and returns every
 * member with a real `package.json` ({@link discoverWorkspaceDirs}). A member
 * nested inside another (`harness/kernel` inside `harness`) owns its own
 * files: they are left out of the enclosing member's `sourceFiles`, so no file
 * belongs to two packages.
 */
export function discoverWorkspacePackages(tree: SourceTree): WorkspacePackage[] {
  const dirs = discoverWorkspaceDirs(tree).map((dir) => join(tree.root, dir))
  const out: WorkspacePackage[] = []
  for (const dir of dirs) {
    let pkg: PackageManifest
    try {
      pkg = JSON.parse(tree.readFile(join(dir, 'package.json')) ?? '') as PackageManifest
    } catch {
      continue
    }
    if (!pkg.name) continue
    const nested = dirs.filter((other) => other !== dir && other.startsWith(`${dir}/`))
    const sourceFiles = walkTree(tree, dir).filter(
      (f) => SOURCE_EXTENSIONS.includes(extname(f)) && !nested.some((other) => f.startsWith(`${other}/`))
    )
    const knownFiles = new Set(sourceFiles)
    out.push({
      dir,
      name: pkg.name,
      bunTestCompatible: isBunTestScript(pkg.scripts?.test),
      testRunner: testRunnerOf(pkg.scripts?.test),
      entrypoints: deriveEntrypoints(dir, pkg, knownFiles),
      sourceFiles
    })
  }
  return out
}

/** True for a `*.test.<ext>` file — the shape the legacy file-list selection treats as a test; inventory-driven selection takes its tests from the inventory instead. */
export function isTestFile(path: string): boolean {
  const withoutExt = path.slice(0, -extname(path).length)
  return withoutExt.endsWith('.test')
}

// ── Edge markers ────────────────────────────────────────────────────────────

/**
 * A node key in the selection graph. Six shapes, and the whole never-miss
 * argument is which of them CHECK (can select) and which TRAVERSE (walk on):
 *
 * - `all:<file>` — the whole module. Checks: any change to `<file>` selects.
 *   Traverses: every edge the file has, including what it re-exports. This is
 *   what a coarse shape (namespace, default, `export *`, side-effect, dynamic)
 *   degrades to, and what a test file itself starts from.
 * - `own:<file>` — the module's OWN scope: the edges it `import`s, never the
 *   ones it merely re-exports. Traverses only; never checks, because whatever
 *   reached it already emitted the `name:` key that says WHICH of its exports
 *   is in play. Keeping re-exports out of this is what stops a barrel reached
 *   for one name from fanning out to everything else it forwards.
 * - `name:<file>#<n>` — a use of `<file>`'s exported name `<n>`. Checks against
 *   the changed names (see {@link SelectionOptions.affectedNames}); never
 *   traverses — the matching `own:<file>` does that.
 * - `touch:<file>` — a change-only marker for a file on a resolution path the
 *   text-scan graph proved without a name. Checks any change; never traverses.
 * - `external:<pkg>` — the coarse whole-package edge: any change anywhere in
 *   `<pkg>` selects. The fallback of last resort, and never wrong, only wide.
 * - `pkgmeta:<pkg>` — fires only on a NON-source change in `<pkg>` (its
 *   `package.json`, `tsconfig.json`, an asset). Such a file is not a graph
 *   node, so a precisely-resolved importer's file edges would miss it, yet
 *   editing `exports`/`main` re-points what that importer resolves to.
 *
 * - `scan:<dir>` — a test whose INPUT is the repository tree under `<dir>`,
 *   read from disk rather than imported (`repo-scanner-tests.ts`). Checks any
 *   change to a file under that prefix; never traverses. No import edge can
 *   reach such a test's real inputs, so without this it is selectable only by
 *   configuration.
 *
 * `external:`/`pkgmeta:` naming the edge-owning file's OWN package are ignored:
 * a file "importing its own package" would otherwise select on any same-package
 * change, exactly the folder-shaped over-selection this design rules out.
 */
type NodeKey = string

// ── The workspace export graph ──────────────────────────────────────────────

/**
 * One source file's export surface, parsed once and cached. Re-export sources
 * are kept as raw specifiers (relative OR bare workspace-package) — resolution
 * to a real file is deferred to {@link resolveExportedName}, which follows a
 * bare specifier into the OTHER package's entrypoint, so a name re-exported
 * across a package boundary resolves to its true origin rather than falling
 * back to coarse. This keeps the table pure and cacheable per file.
 */
type ExportTable = {
  /** Names defined AND exported directly in this file (`export function x`, …). */
  directDefs: Set<string>
  /** `export { a, b as c }` with no `from` — exported name → local binding name. */
  localReexports: Map<string, string>
  /** `export { a as b } from 'x'` — exported name → { specifier, importedName }. */
  namedReexports: Map<string, { specifier: string; importedName: string }>
  /** `export * from 'x'` — re-export source specifiers. */
  starReexports: string[]
  /** `export * as ns from 'x'` — the namespace binding names it introduces. */
  starAsNames: Set<string>
  /** Top-level imports, so an `export { name }` that re-exports an import can be traced: local name → { specifier, importedName }. `importedName` is `*`/`default` for namespace/default imports. */
  imports: Map<string, { specifier: string; importedName: string }>
  /** Every edge this file pulls into its OWN module scope, with its import SHAPE — {@link extractOwnImportRecords}. A re-export HOP is a check-only marker whose module still runs on import, so these are what a hop contributes to the graph beyond the one re-export the importer resolved through it. The shape is kept (not just the specifier) so a hop's bare workspace import resolves through exported names like any other, rather than dragging in the whole target package. */
  ownImports: ImportRecord[]
}

const EXPORT_DEF_RE =
  /^\s*export\s+(?:declare\s+)?(default\s+)?(?:async\s+)?(?:abstract\s+)?(const\s+enum|function\*?|const|let|var|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_DEFAULT_RE = /^\s*export\s+default\b/m
const EXPORT_BRACE_RE = /^\s*export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*(['"])([^'"]+)\2)?/gm
const EXPORT_STAR_RE = /^\s*export\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*(['"])([^'"]+)\2/gm
const IMPORT_BINDING_RE =
  /^\s*import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))\s+from\s*(['"])([^'"]+)\4/gm

/** Parses one file's exported/imported bindings into an {@link ExportTable}. Re-export/import sources are kept as raw specifiers; the resolver resolves them (relative or bare) against the workspace. */
function parseExportTable(source: string): ExportTable {
  const directDefs = new Set<string>()
  const localReexports = new Map<string, string>()
  const namedReexports = new Map<string, { specifier: string; importedName: string }>()
  const starReexports: string[] = []
  const starAsNames = new Set<string>()
  const imports = new Map<string, { specifier: string; importedName: string }>()
  const ownImports = extractOwnImportRecords(source)

  EXPORT_DEF_RE.lastIndex = 0
  for (let m = EXPORT_DEF_RE.exec(source); m !== null; m = EXPORT_DEF_RE.exec(source)) {
    if (m[1]) continue // `export default function foo` — the export is default, not `foo`.
    directDefs.add(m[3] as string)
  }
  if (EXPORT_DEFAULT_RE.test(source)) directDefs.add('default')

  EXPORT_BRACE_RE.lastIndex = 0
  for (let m = EXPORT_BRACE_RE.exec(source); m !== null; m = EXPORT_BRACE_RE.exec(source)) {
    const specifier = m[3]
    for (const raw of (m[1] as string).split(',')) {
      const entry = raw.trim().replace(/^type\s+/, '')
      if (entry.length === 0) continue
      const parts = entry.split(/\s+as\s+/)
      const origin = (parts[0] as string).trim()
      const exported = (parts[1] ?? (parts[0] as string)).trim()
      if (!/^[A-Za-z_$][\w$]*$/.test(origin) || !/^[A-Za-z_$][\w$]*$/.test(exported)) continue
      if (specifier) {
        namedReexports.set(exported, { specifier, importedName: origin }) // `export { origin as exported } from 'x'`.
      } else {
        localReexports.set(exported, origin)
      }
    }
  }

  EXPORT_STAR_RE.lastIndex = 0
  for (let m = EXPORT_STAR_RE.exec(source); m !== null; m = EXPORT_STAR_RE.exec(source)) {
    if (m[1]) starAsNames.add(m[1])
    else starReexports.push(m[3] as string)
  }

  // Local BINDING names, which the tolerant clause scan above deliberately does
  // not parse. A shape this narrower regex cannot read costs only the ability to
  // trace `export { local }` back through an import — which falls back to coarse,
  // never to a dropped edge, because `ownImports` already carries the specifier.
  IMPORT_BINDING_RE.lastIndex = 0
  for (let m = IMPORT_BINDING_RE.exec(source); m !== null; m = IMPORT_BINDING_RE.exec(source)) {
    const specifier = m[5] as string
    if (m[1] !== undefined) {
      for (const raw of m[1].split(',')) {
        const entry = raw.trim().replace(/^type\s+/, '')
        if (entry.length === 0) continue
        const parts = entry.split(/\s+as\s+/)
        const origin = (parts[0] as string).trim()
        const local = (parts[1] ?? (parts[0] as string)).trim()
        if (/^[A-Za-z_$][\w$]*$/.test(local)) imports.set(local, { specifier, importedName: origin })
      }
    } else if (m[2] !== undefined) {
      imports.set(m[2], { specifier, importedName: '*' })
    } else if (m[3] !== undefined) {
      imports.set(m[3], { specifier, importedName: 'default' })
    }
  }

  return { directDefs, localReexports, namedReexports, starReexports, starAsNames, imports, ownImports }
}

/**
 * The outcome of resolving one exported name through a package's export graph.
 * When `resolved`: `touched` is every re-export hop file on the successful path
 * (entrypoint + intermediates), recorded as check-only markers; `definers` is
 * the file(s) that actually define the name, recorded as traversable nodes; and
 * `hopDeps` is every file a hop imports for its OWN module scope (a barrel's
 * `import './register'` or `import { helper } from './helper'`), which runs on
 * every import through that hop and so must select on change — traversable too.
 * All three empty and meaningless when unresolved.
 */
type NameResolution =
  | { resolved: true; touched: Set<string>; definers: Set<string>; hopDeps: Set<string> }
  | { resolved: false }

const UNRESOLVED: NameResolution = { resolved: false }

/** Reads and caches file contents; missing/unreadable files read as empty. */
function makeSourceReader(tree: SourceTree): (file: string) => string {
  const cache = new Map<string, string>()
  return (file: string): string => {
    let cached = cache.get(file)
    if (cached === undefined) {
      cached = tree.readFile(file) ?? ''
      cache.set(file, cached)
    }
    return cached
  }
}

/**
 * The shared workspace context a name resolution needs: how to read/parse a
 * file (cached) and how to turn a re-export specifier into a real file — whether
 * relative (within the source file's own package) or a bare workspace-package
 * import (into that package's declared entrypoint). Built once per selection.
 */
type GraphContext = {
  readSource: (file: string) => string
  tableCache: Map<string, ExportTable>
  resultCache: Map<string, NameResolution>
  /** The package directory (longest matching prefix) that owns an absolute file, or null for a file in no workspace package. */
  packageDirOf: (file: string) => string | null
  /** A package directory's own source-file set, for relative resolution. */
  knownFilesByPkgDir: Map<string, Set<string>>
  /** A bare specifier to the workspace package it names plus the entrypoint file for its subpath (`entry` null when the manifest maps no such subpath). `null` for a third-party specifier no workspace package owns. */
  packageOfBareSpecifier: (specifier: string) => { name: string; entry: string | null } | null
}

/** Resolves a re-export/import specifier from `fromFile` to a real source file: a relative specifier against `fromFile`'s own package, a bare specifier to the matching workspace package's entrypoint. `null` when it points nowhere resolvable. */
function resolveSpecifierToFile(ctx: GraphContext, fromFile: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    const pkgDir = ctx.packageDirOf(fromFile)
    const knownFiles = pkgDir ? ctx.knownFilesByPkgDir.get(pkgDir) : undefined
    return knownFiles ? resolveRelativeImport(fromFile, specifier, knownFiles) : null
  }
  return ctx.packageOfBareSpecifier(specifier)?.entry ?? null
}

/**
 * Resolves an exported `name` to the files that define it, following named and
 * unambiguous `export *` re-exports through the graph — ACROSS package
 * boundaries, so a name re-exported from another workspace package resolves to
 * its true origin. Returns {@link UNRESOLVED} — the caller's signal to keep the
 * whole-package edge — for a namespace, a default, an unknown name, an
 * ambiguous name (more than one `export *` origin), a cycle, or a re-export
 * whose source cannot be resolved to a single file.
 */
function resolveExportedName(ctx: GraphContext, file: string, name: string, stack: Set<string>): NameResolution {
  const cacheKey = `${file} ${name}`
  const cached = ctx.resultCache.get(cacheKey)
  if (cached) return cached
  if (stack.has(file)) return UNRESOLVED // cyclic re-export — fall back to coarse.

  let table = ctx.tableCache.get(file)
  if (!table) {
    table = parseExportTable(ctx.readSource(file))
    ctx.tableCache.set(file, table)
  }

  stack.add(file)
  const result = resolveThroughTable(ctx, file, name, table, stack)
  stack.delete(file)
  ctx.resultCache.set(cacheKey, result)
  return result
}

/**
 * Resolves every `name` a re-export hop imports from another package's `entry`
 * into selection-graph edge strings — `touch:` per hop on the path, a plain path
 * per definer, plus whatever nested hop deps those carried. `null` the moment any
 * one name will not resolve, which is the caller's signal to fall back coarsely
 * for the whole specifier rather than keep the subset that happened to resolve.
 */
function resolveHopNames(ctx: GraphContext, entry: string, names: string[], stack: Set<string>): string[] | null {
  // No names is no proof, not a proof of nothing: returning an empty edge list
  // here would drop the specifier silently. (`clean` already implies a non-empty
  // list, so this guards the invariant rather than a reachable state.)
  if (names.length === 0) return null
  const deps: string[] = []
  for (const name of names) {
    const sub = resolveExportedName(ctx, entry, name, stack)
    if (!sub.resolved) return null
    for (const t of sub.touched) deps.push(`${TOUCH_PREFIX}${t}`)
    for (const d of sub.definers) deps.push(d)
    for (const h of sub.hopDeps) deps.push(h)
  }
  return deps
}

function resolveThroughTable(
  ctx: GraphContext,
  file: string,
  name: string,
  table: ExportTable,
  stack: Set<string>
): NameResolution {
  const recurse = (specifier: string, nextName: string): NameResolution => {
    const target = resolveSpecifierToFile(ctx, file, specifier)
    return target ? resolveExportedName(ctx, target, nextName, stack) : UNRESOLVED
  }

  // A name defined right here. `file` is the definer — a traversable node whose
  // own imports the caller already walks — so it contributes no hop deps.
  if (name !== 'default' && table.directDefs.has(name)) {
    return { resolved: true, touched: new Set([file]), definers: new Set([file]), hopDeps: new Set() }
  }

  // Everything this re-export hop pulls into its own module scope, which runs on
  // any import through the hop and so must select on change. Yields edge strings
  // in the same vocabulary the selection graph speaks (a plain path, `touch:`,
  // `external:`), so the caller can forward them verbatim.
  //
  // A relative specifier is a plain traversable file. A BARE specifier into
  // another workspace package is resolved through that package's exported names
  // by the same two rules the top-level importer uses — a `touch:` marker per
  // re-export hop, a traversable node per definer — so a barrel that imports one
  // name from a sibling package does not drag that sibling's whole graph in
  // behind it. Two conservative fallbacks, in narrowing order: a shape that
  // cannot be proved (namespace, default, unclean list, an unresolvable name)
  // falls back to the target's ENTRYPOINT as a traversable node, since everything
  // such a specifier can expose is reachable from there; a package whose subpath
  // the manifest does not map at all falls back to the coarse `external:` edge,
  // the only edge left that still names it.
  const ownHopDeps = (): Set<string> => {
    const out = new Set<string>()
    for (const record of table.ownImports) {
      if (record.specifier.startsWith('.')) {
        const resolved = resolveSpecifierToFile(ctx, file, record.specifier)
        if (resolved) out.add(resolved)
        continue
      }
      const pkg = ctx.packageOfBareSpecifier(record.specifier)
      if (!pkg) continue // a third-party dependency — never a changed workspace file.
      if (!pkg.entry) {
        out.add(`${EXTERNAL_PREFIX}${pkg.name}`)
        continue
      }
      const entry = pkg.entry
      const precise = record.kind === 'named' && record.clean ? resolveHopNames(ctx, entry, record.names, stack) : null
      if (precise) for (const dep of precise) out.add(dep)
      else out.add(entry)
    }
    return out
  }

  // `export { local as name }` with no `from` — trace `local` to a definition
  // or an import; anything else (a def we couldn't parse, a namespace or default
  // binding) is coarse.
  const local = table.localReexports.get(name)
  if (local !== undefined) {
    if (table.directDefs.has(local)) {
      return { resolved: true, touched: new Set([file]), definers: new Set([file]), hopDeps: new Set() }
    }
    const imp = table.imports.get(local)
    if (imp && imp.importedName !== '*' && imp.importedName !== 'default') {
      const sub = recurse(imp.specifier, imp.importedName)
      if (!sub.resolved) return UNRESOLVED
      return {
        resolved: true,
        touched: new Set([file, ...sub.touched]),
        definers: sub.definers,
        hopDeps: new Set([...ownHopDeps(), ...sub.hopDeps])
      }
    }
    return UNRESOLVED
  }

  if (table.starAsNames.has(name)) return UNRESOLVED // `export * as name` is a namespace.

  // Gather every origin that can supply the name: one explicit `export { name }
  // from 'x'`, plus each `export * from 'y'` that resolves it. More than one is
  // ambiguous; exactly one is precise; none means the name is unknown here.
  const origins: Extract<NameResolution, { resolved: true }>[] = []
  const named = table.namedReexports.get(name)
  if (named) {
    const sub = recurse(named.specifier, named.importedName)
    if (sub.resolved) origins.push(sub)
    else return UNRESOLVED // an explicit re-export target that itself won't resolve — coarse, not silently dropped.
  }
  for (const specifier of table.starReexports) {
    const sub = recurse(specifier, name)
    if (sub.resolved) origins.push(sub)
    if (origins.length > 1) return UNRESOLVED
  }
  if (origins.length !== 1) return UNRESOLVED
  const only = origins[0] as Extract<NameResolution, { resolved: true }>
  return {
    resolved: true,
    touched: new Set([file, ...only.touched]),
    definers: only.definers,
    hopDeps: new Set([...ownHopDeps(), ...only.hopDeps])
  }
}

// ── The selection graph ─────────────────────────────────────────────────────

export type SelectionResult = {
  /** Absolute paths of every `*.test.*` file selected, across every affected package. */
  selected: string[]
  /** Total `*.test.*` files scanned across every affected package — the denominator for "N of M". */
  totalTestFiles: number
  /** Which graph answered: the TypeScript compiler, or the text-scan fallback for a repository with no `typescript` to resolve. */
  resolver: 'compiler' | 'text-scan'
  /** Milliseconds the compiler program build took, `0` under the text scan — reported separately because it dominates selector runtime. */
  programMs: number
  /**
   * Why each test in {@link selected} was selected, one entry per selected
   * file, in the same order — a separate output, so a caller of the file list
   * reads exactly what it always read.
   */
  explanations: SelectionExplanation[]
  /**
   * Tests of packages whose native runner is not `bun test` that this diff
   * selects, each with its runner — filled only under
   * `nativeRunners: 'expose'`, otherwise empty. Never part of
   * {@link selected}: a `bun test` caller never receives a file another
   * runner owns.
   */
  native: { test: string; runner: TestRunner }[]
}

/**
 * The kind of reason a test was selected:
 *
 * - `direct-dependency` — the test file itself changed, was added or
 *   renamed, or one of its own imports reaches the change.
 * - `transitive-dependency` — the change is reached through a file the test
 *   imports only indirectly.
 * - `declared-input` — a non-import input reached it: a scanned folder, a
 *   scanner's declared trigger, a package's manifest, or a configuration file.
 * - `always-run` — `alwaysRun` names it, whatever changed.
 * - `conservative-fallback` — an import shape the graph cannot narrow kept
 *   the whole-package edge, and the change is somewhere in that package.
 */
export type SelectionReasonKind =
  | 'direct-dependency'
  | 'transitive-dependency'
  | 'declared-input'
  | 'always-run'
  | 'conservative-fallback'

/** One selected test's reason, machine-readable. Paths are repository-relative. */
export type SelectionExplanation = {
  test: string
  kind: SelectionReasonKind
  /** What fired, in words: the edge, glob or declaration. */
  detail: string
  /** The changed path, scanned root, package or glob the reason points at. */
  via: string
}

/**
 * A configuration file a package's tests read without importing it. Under the
 * transitive walk its change selects every test of the package that owns
 * `ownerFile`; under depth one, only that package's tests whose own direct
 * edges reach `loader`, the module that reads the file.
 */
export type ConfigInput = {
  /** Repository-relative path of the configuration file. */
  path: string
  /** How a reason names it, e.g. `the root configuration file`. */
  label: string
  /** Repository-relative file inside the package whose tests read it. */
  ownerFile: string
  /** Repository-relative module that loads it. */
  loader: string
}

/** What the graph is built with. */
type GraphOptions = {
  /** The compiler, for the graph, the tree scanners and the spawn classifier; `null` when there is none. */
  typescript: TypeScriptApi | null
  resolver?: 'compiler' | 'text-scan'
  repoTreeScanners: 'select' | 'ignore'
  spawnDetection: 'select' | 'ignore'
  /** Entrypoints repository-relative. */
  spawnPrograms: readonly SpawnProgram[]
  /** Which absolute files are tests, for the scanner and spawn classifiers. */
  isTest: (file: string) => boolean
  /** Also model the source files no workspace package owns. */
  includeUnpackaged?: boolean
  /** Further edges, by test file (absolute) — inputs a test runs that it does not import. */
  extraEdges?: ReadonlyMap<string, readonly NodeKey[]>
}

/** One tree's selection graph: its packages, its files, and every node's forward edges. */
type SelectionGraph = {
  tree: SourceTree
  packages: WorkspacePackage[]
  pkgFiles: Map<WorkspacePackage, string[]>
  fileToPackage: Map<string, string>
  allSourceFiles: Set<string>
  edges: Map<NodeKey, NodeKey[]>
  readSource: (file: string) => string
  /** The graph's own compiler, `null` under the text scan. */
  graphTypescript: TypeScriptApi | null
  programMs: number
}

/**
 * Builds one tree's forward-import graph across every workspace package,
 * resolving relative imports to files and bare workspace-package imports
 * through the target package's exported names, then adds the tree-scanner,
 * spawn and caller-supplied edges.
 */
function buildSelectionGraph(tree: SourceTree, options: GraphOptions): SelectionGraph {
  const repoRoot = tree.root
  const packages = discoverWorkspacePackages(tree)
  const readSource = makeSourceReader(tree)
  const tableCache = new Map<string, ExportTable>()
  const resultCache = new Map<string, NameResolution>()

  // Per-package file inventory (reusing the walk `discoverWorkspacePackages`
  // already did, not a second one), plus the map from any source file to its
  // package for the own-package guard on fallback edges.
  const pkgFiles = new Map<WorkspacePackage, string[]>()
  const pkgKnownFiles = new Map<WorkspacePackage, Set<string>>()
  const fileToPackage = new Map<string, string>()
  const allSourceFiles = new Set<string>()
  for (const pkg of packages) {
    const files = pkg.sourceFiles
    pkgFiles.set(pkg, files)
    pkgKnownFiles.set(pkg, new Set(files))
    for (const f of files) {
      fileToPackage.set(f, pkg.name)
      allSourceFiles.add(f)
    }
  }
  // Source files no package owns — a repository's own scripts and root tests —
  // are graph nodes in no package when the caller asks for them.
  const unpackaged: string[] = []
  if (options.includeUnpackaged) {
    const pkgDirs = packages.map((p) => p.dir)
    for (const f of walkTree(tree, repoRoot))
      if (SOURCE_EXTENSIONS.includes(extname(f)) && !pkgDirs.some((d) => f.startsWith(`${d}/`))) {
        unpackaged.push(f)
        allSourceFiles.add(f)
      }
  }

  // Resolve a bare specifier to its target package + subpath, longest name first
  // so a nested package name never shadows a longer, more specific match.
  const matchPackage = (specifier: string): { pkg: WorkspacePackage; subpath: string } | null => {
    let best: { pkg: WorkspacePackage; subpath: string } | null = null
    for (const pkg of packages) {
      if (specifier === pkg.name) {
        if (!best || pkg.name.length > best.pkg.name.length) best = { pkg, subpath: '.' }
      } else if (specifier.startsWith(`${pkg.name}/`)) {
        if (!best || pkg.name.length > best.pkg.name.length) {
          best = { pkg, subpath: `.${specifier.slice(pkg.name.length)}` }
        }
      }
    }
    return best
  }

  // The export-resolution context: relative specifiers resolve within a file's
  // own package; a bare specifier resolves to the matching package's entrypoint,
  // which is what lets a name re-exported across a package boundary resolve to
  // its true origin instead of falling back to coarse.
  const knownFilesByPkgDir = new Map(packages.map((p) => [p.dir, pkgKnownFiles.get(p) as Set<string>]))
  const sortedPkgDirs = packages.map((p) => p.dir).sort((a, b) => b.length - a.length)
  const ctx: GraphContext = {
    readSource,
    tableCache,
    resultCache,
    knownFilesByPkgDir,
    packageDirOf: (file) => sortedPkgDirs.find((d) => file.startsWith(`${d}/`)) ?? null,
    packageOfBareSpecifier: (specifier) => {
      const m = matchPackage(specifier)
      return m ? { name: m.pkg.name, entry: m.pkg.entrypoints.get(m.subpath) ?? null } : null
    }
  }

  // Build the global forward edge map. The compiler resolves what it can (the
  // ordinary case — the repository under analysis has `typescript`); the text
  // scan below is the fallback for a repository that does not, and is a strict
  // over-approximation, so never-miss holds either way. `resolver` forces only
  // the graph back to the text scan, so the scan rule holds under both graphs
  // and the text-scan selection stays a superset of the compiler's.
  const typescript = options.typescript
  const graphTypescript = options.resolver === 'text-scan' ? null : typescript
  const edges = new Map<NodeKey, NodeKey[]>()
  let programMs = 0
  if (graphTypescript) {
    // Bare workspace specifiers, resolved from each package's OWN manifest
    // (`deriveEntrypoints`' `exports`/`main` rules, conditions included) and
    // handed to the compiler as `paths`, so the graph never depends on how an
    // installer happened to lay out `node_modules`.
    const entrypoints = new Map<string, string>()
    for (const pkg of packages) {
      for (const [subpath, entry] of pkg.entrypoints) {
        entrypoints.set(subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`, entry)
      }
    }
    const graph = buildCompilerGraph(graphTypescript, {
      repoRoot,
      files: [...allSourceFiles],
      packageOfFile: (f) => fileToPackage.get(f) ?? null,
      packageOfBareSpecifier: (specifier) => matchPackage(specifier)?.pkg.name ?? null,
      entrypoints,
      ...(tree.host ? { host: tree.host } : {})
    })
    for (const [node, deps] of graph.edges) edges.set(node, deps)
    programMs = graph.programMs
  } else {
    for (const pkg of packages) textScanEdges(pkgFiles.get(pkg) as string[], pkgKnownFiles.get(pkg) as Set<string>)
    if (unpackaged.length > 0) textScanEdges(unpackaged, allSourceFiles)
  }

  /**
   * The pre-compiler graph, kept as the fallback for a repository with no
   * `typescript` to resolve: the same import/export records read by regular
   * expression, with re-export hops as `touch:` markers and every unprovable
   * shape as the coarse whole-package edge. Its node keys are normalized into
   * the vocabulary {@link NodeKey} describes, with no `own:`/`all:` split —
   * a text scan cannot tell a hop's own module scope from what it forwards, so
   * both keys carry the same, wider list.
   */
  function textScanEdges(files: readonly string[], knownFiles: Set<string>): void {
    for (const file of files) {
      const deps: string[] = []
      const coarsePackages = new Set<string>()
      const resolvedNamed = new Map<string, { touched: Set<string>; definers: Set<string>; hopDeps: Set<string> }>()

      for (const record of extractImportRecords(readSource(file))) {
        const specifier = record.specifier
        if (specifier.startsWith('.')) {
          const resolved = resolveRelativeImport(file, specifier, knownFiles)
          if (resolved) deps.push(resolved)
          continue
        }
        const match = matchPackage(specifier)
        if (!match) continue // a third-party dependency — never a changed workspace file.
        if (coarsePackages.has(match.pkg.name)) continue // already coarse for this package.

        const entry = match.pkg.entrypoints.get(match.subpath)
        // A named import whose brace list did not parse cleanly (empty `{}`, or an
        // entry that is not a bare identifier) is an unprovable shape: keep the
        // whole-package edge rather than narrow to the names that happened to read.
        if (record.kind !== 'named' || !record.clean || !entry) {
          // namespace / default / star / side-effect / dynamic / unclean-named, or
          // an entrypoint we cannot derive — retain the whole-package edge.
          coarsePackages.add(match.pkg.name)
          continue
        }
        let acc = resolvedNamed.get(match.pkg.name)
        for (const name of record.names) {
          const resolution = resolveExportedName(ctx, entry, name, new Set())
          if (!resolution.resolved) {
            coarsePackages.add(match.pkg.name)
            acc = undefined
            resolvedNamed.delete(match.pkg.name)
            break
          }
          if (!acc) {
            acc = { touched: new Set(), definers: new Set(), hopDeps: new Set() }
            resolvedNamed.set(match.pkg.name, acc)
          }
          for (const t of resolution.touched) acc.touched.add(t)
          for (const d of resolution.definers) acc.definers.add(d)
          for (const h of resolution.hopDeps) acc.hopDeps.add(h)
        }
      }

      // A specifier that ever fell back to coarse wins over any symbol-aware
      // edge for the SAME package, so a mixed import shape is never narrowed.
      for (const [name, acc] of resolvedNamed) {
        if (coarsePackages.has(name)) continue
        // A `pkgmeta:` marker per package that CONTRIBUTED a file to this
        // resolution, not just the one named in the specifier: when a name is
        // re-exported across a package boundary, the intermediate package's
        // manifest re-points this importer's resolution exactly as the direct
        // package's does, and its non-source files are no more graph nodes than
        // the direct package's are.
        const metaPackages = new Set([name])
        for (const f of [...acc.touched, ...acc.definers, ...acc.hopDeps]) {
          const owner = fileToPackage.get(f) // undefined for a `touch:`/`external:` marker, which owns no file.
          if (owner) metaPackages.add(owner)
        }
        for (const p of metaPackages) deps.push(`${PKGMETA_PREFIX}${p}`)
        for (const t of acc.touched) if (t !== file) deps.push(`${TOUCH_PREFIX}${t}`)
        for (const d of acc.definers) deps.push(d)
        for (const h of acc.hopDeps) deps.push(h)
      }
      for (const name of coarsePackages) deps.push(`${EXTERNAL_PREFIX}${name}`)

      // A bare path in this builder's vocabulary is a traversable, any-change
      // node — `all:` in the shared one.
      const keys = deps.map((d) => (/^(?:touch|external|pkgmeta):/.test(d) ? d : `${ALL_PREFIX}${d}`))
      edges.set(`${ALL_PREFIX}${file}`, keys)
      edges.set(`${OWN_PREFIX}${file}`, keys)
    }
  }

  // Tests whose input is the repository TREE, not their own imports. Their
  // `scan:` edges are added to the graph here rather than to a configured list,
  // so the rule travels with the selector into every repository that uses it.
  if (typescript && options.repoTreeScanners !== 'ignore') {
    for (const file of allSourceFiles) {
      if (!options.isTest(file)) continue
      const roots = scannedRootsOf(typescript, file, readSource(file), repoRoot)
      if (roots.length === 0) continue
      const key = `${ALL_PREFIX}${file}`
      edges.set(key, [...(edges.get(key) ?? []), ...roots.map((r) => `${SCAN_PREFIX}${r}`)])
    }
  }

  // Tests that spawn a program as a fresh subprocess, not through their own
  // imports either. A precisely-classified spawn gets one synthetic edge
  // straight to the entrypoint's own `all:` node — the entrypoint's real,
  // already-computed edges (built above, by whichever graph answered) do the
  // rest. A spawn shape the classifier cannot read as precisely earns the
  // coarse `scan:` edge over the entrypoint's own source directory instead —
  // the whole-package edge for this file, never silence.
  if (typescript && options.spawnDetection !== 'ignore') {
    for (const program of options.spawnPrograms) {
      const entrypoint = join(repoRoot, program.entrypoint)
      const entrypointSourceRoot = dirname(entrypoint)
      for (const file of allSourceFiles) {
        if (!options.isTest(file)) continue
        const classification = spawnEdgeOf(typescript, file, readSource(file), repoRoot, {
          binary: program.binary,
          entrypoint
        })
        if (!classification) continue
        const key = `${ALL_PREFIX}${file}`
        const edge =
          classification === 'entrypoint' ? `${ALL_PREFIX}${entrypoint}` : `${SCAN_PREFIX}${entrypointSourceRoot}`
        edges.set(key, [...(edges.get(key) ?? []), edge])
      }
    }
  }

  for (const [file, extra] of options.extraEdges ?? []) {
    const key = `${ALL_PREFIX}${file}`
    edges.set(key, [...(edges.get(key) ?? []), ...extra])
  }

  return {
    tree,
    packages,
    pkgFiles,
    fileToPackage,
    allSourceFiles,
    edges,
    readSource,
    graphTypescript,
    programMs
  }
}

/** The change facts one graph walks against: `changed` absolute paths in the graph's tree, names keyed absolute or root-relative. */
function changeFactsFor(
  graph: SelectionGraph,
  changed: ReadonlySet<string>,
  affectedNames: ReadonlyMap<string, ReadonlySet<string> | 'all'>
): ChangeFacts {
  const repoRoot = graph.tree.root
  // Which packages have a changed file directly inside them (the set a coarse
  // `external:<pkg>` edge matches), and which of those changed a NON-source file
  // — a `package.json`/`tsconfig.json`/asset that is not a graph node and so is
  // invisible to a precisely-resolved importer's file edges (`pkgmeta:` covers it).
  const changedPackageNames = new Set<string>()
  const nonSourceChangedPackages = new Set<string>()
  for (const pkg of graph.packages) {
    for (const f of changed) {
      if (!f.startsWith(`${pkg.dir}/`)) continue
      changedPackageNames.add(pkg.name)
      if (!graph.allSourceFiles.has(f)) nonSourceChangedPackages.add(pkg.name)
    }
  }
  // A changed file with no name-level information is WHOLLY changed: every one
  // of its exports is affected. That is the file-level answer, and it is what
  // every caller that does not (or cannot) compute changed names gets.
  return {
    files: changed,
    packages: changedPackageNames,
    nonSourcePackages: nonSourceChangedPackages,
    packageOfFile: (f) => graph.fileToPackage.get(f) ?? null,
    affects: (file, name) => {
      const affected =
        affectedNames.get(file) ?? affectedNames.get(file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file)
      return affected === undefined || affected === 'all' || affected.has(name)
    }
  }
}

// ── The file-list selection ─────────────────────────────────────────────────

export type FileSelectionOptions = {
  /**
   * Glob patterns (matched against a test file's root-relative path,
   * `globToRegex`'s grammar) naming test files that run whatever changed —
   * policy, never a dependency.
   */
  alwaysRun?: readonly string[]
  /**
   * Root-relative or absolute paths of files added or renamed in this diff. A
   * brand-new or renamed test file has nothing importing it yet, so every one
   * of these that IS a test file is selected unconditionally.
   */
  addedOrRenamed?: readonly string[]
  /**
   * Root-relative or absolute paths of files removed in this diff — a
   * deletion, or the old path of a rename. Read only by `tree-shape` and
   * `listed-files` scanner declarations.
   */
  removed?: readonly string[]
  /**
   * Per changed file (absolute or root-relative), the 1-based, inclusive
   * line ranges the diff touched on its new side. Read only by a
   * `process-start` scanner declaration. A changed file absent from this map
   * counts as touched everywhere — the wider, safe answer.
   */
  changedRanges?: ReadonlyMap<string, readonly { start: number; end: number }[]>
  /** The folder-scanning tests and the kind of change each judges. None by default. */
  scannerDeclarations?: readonly ScannerDeclaration[]
  /**
   * Per changed file (absolute or root-relative), the exported names this
   * diff actually touched — or `'all'`. A changed file ABSENT from this map is
   * wholly affected: the default is always the file-level answer.
   */
  affectedNames?: ReadonlyMap<string, ReadonlySet<string> | 'all'>
  /** Whether tests whose input is the tree get their `scan:` edges; defaults by `depth`. */
  repoTreeScanners?: 'select' | 'ignore'
  /** Forces the text-scan graph instead of the compiler one. */
  resolver?: 'compiler' | 'text-scan'
  /** Whether a test that spawns one of `spawnPrograms` gets its synthetic edge; defaults by `depth`. */
  spawnDetection?: 'select' | 'ignore'
  /** Programs whose spawn by a test is followed into the entrypoint's imports. None by default. */
  spawnPrograms?: readonly SpawnProgram[]
  /** Configuration files tests read without importing them. None by default. */
  configInputs?: readonly ConfigInput[]
  /** `'transitive'` (the default) or `'one'` — see {@link SelectionPolicy.depth}. */
  depth?: 'one' | 'transitive'
  /** Whether tests of a package whose native runner is not `bun test` are reported in {@link SelectionResult.native}. */
  nativeRunners?: 'exclude' | 'expose'
  /** The compiler; absent, resolved from the tree's root and then this library's installation; `null` forces none. */
  typescript?: TypeScriptApi | null
}

/**
 * Every `*.test.*` file — in ANY package of `tree` — whose transitive import
 * closure reaches a changed file (directly, through a resolved named export,
 * or through the whole-package fallback for an unresolved import shape), plus
 * every test `alwaysRun` names, every added or renamed test, every
 * folder-scanning test whose declared trigger the diff is, and the tests a
 * changed configuration input reaches.
 */
export function selectAffectedFiles(
  tree: SourceTree,
  changedFiles: readonly string[],
  options: FileSelectionOptions = {}
): SelectionResult {
  const repoRoot = tree.root
  const absChanged = new Set(changedFiles.map((f) => (isAbsolute(f) ? f : join(repoRoot, f))))
  const alwaysRunRegexes = (options.alwaysRun ?? []).map(globToRegex)
  const addedOrRenamed = new Set((options.addedOrRenamed ?? []).map((f) => (isAbsolute(f) ? f : join(repoRoot, f))))

  // `depth: 'one'` defaults these two categories to `'ignore'` unless a caller
  // names an explicit value: a tree-scanner or a spawn test earns its edge from
  // what it IS, not from what it imports, so no depth bound can narrow it —
  // leaving either on at depth one would select every one of them on ANY
  // matching change. A scanner's declared trigger (below) still selects it here
  // for its own kind of change.
  const depthOneDefault = options.depth === 'one' ? 'ignore' : 'select'
  const typescript = options.typescript === undefined ? loadTypeScript(repoRoot) : options.typescript
  const graph = buildSelectionGraph(tree, {
    typescript,
    ...(options.resolver ? { resolver: options.resolver } : {}),
    repoTreeScanners: options.repoTreeScanners ?? depthOneDefault,
    spawnDetection: options.spawnDetection ?? depthOneDefault,
    spawnPrograms: options.spawnPrograms ?? [],
    isTest: isTestFile
  })
  const { packages, pkgFiles, edges, readSource } = graph
  const changeFacts = changeFactsFor(graph, absChanged, options.affectedNames ?? new Map())

  // A configuration file, changed. It is an input to every command the owning
  // package's tests start, and no test imports it, so reachability can never
  // select one of them on the merits: it is not a graph node at all, and a
  // `pkgmeta:` edge only ever covers a non-source file INSIDE a package. Under
  // the transitive walk the whole owning package's suite is the answer; under
  // `depth: 'one'` it narrows to that package's tests whose own direct edges
  // reach the configuration's loader module.
  const configs = (options.configInputs ?? [])
    .filter((config) => absChanged.has(join(repoRoot, config.path)))
    .map((config) => {
      const owner = join(repoRoot, config.ownerFile)
      return {
        config,
        pkg: packages.find((pkg) => owner.startsWith(`${pkg.dir}/`)) ?? null,
        loaderFacts: {
          files: new Set([join(repoRoot, config.loader)]),
          packages: new Set<string>(),
          nonSourcePackages: new Set<string>(),
          packageOfFile: changeFacts.packageOfFile,
          affects: () => true
        } satisfies ChangeFacts
      }
    })

  // Folder-scanning tests whose declared kind of change this diff is. Read
  // from the declarations, not from the scan edges above, so a depth-one
  // selection — which withholds those edges because they fire on any change
  // under a scanner's roots — still runs a scanner on the one change it judges.
  const relative = (f: string): string => (isAbsolute(f) ? f.slice(repoRoot.length + 1) : f)
  const changedRanges = new Map(
    [...(options.changedRanges ?? new Map())].map(([f, ranges]) => [isAbsolute(f) ? f : join(repoRoot, f), ranges])
  )
  const triggeredScanners = new Set<string>()
  for (const declaration of options.scannerDeclarations ?? []) {
    const triggered = scannerTriggered(declaration, {
      changed: [...absChanged].map(relative),
      added: [...addedOrRenamed].map(relative),
      removed: (options.removed ?? []).map(relative),
      read: (path) => readSource(join(repoRoot, path)),
      ranges: (path) => changedRanges.get(join(repoRoot, path)),
      typescript
    })
    if (triggered) triggeredScanners.add(join(repoRoot, declaration.test))
  }

  const anythingChanged = absChanged.size > 0 || changeFacts.packages.size > 0
  const selected: string[] = []
  const explanations: SelectionExplanation[] = []
  const native: SelectionResult['native'] = []
  let totalTestFiles = 0

  // Why a test is selected, or `null` when it is not. The forced reasons are
  // tried in a fixed order, and the walk only after them.
  const reasonFor = (
    pkg: WorkspacePackage,
    test: string,
    maxDepth: number
  ): Omit<SelectionExplanation, 'test'> | null => {
    const rel = test.slice(repoRoot.length + 1)
    const glob = (options.alwaysRun ?? []).find((_, i) => alwaysRunRegexes[i]?.test(rel))
    if (glob !== undefined) return { kind: 'always-run', detail: 'alwaysRun names this test', via: glob }
    if (addedOrRenamed.has(test))
      return { kind: 'direct-dependency', detail: 'the test file itself was added or renamed', via: rel }
    if (triggeredScanners.has(test))
      return { kind: 'declared-input', detail: "the diff is this folder-scanning test's declared trigger", via: rel }
    for (const { config, pkg: owner, loaderFacts } of configs) {
      if (pkg !== owner) continue
      if (options.depth !== 'one')
        return { kind: 'declared-input', detail: `${config.label} changed`, via: config.path }
      if (reaches(`${ALL_PREFIX}${test}`, edges, loaderFacts, 1))
        return {
          kind: 'declared-input',
          detail: `${config.label} changed and this test reaches its loader`,
          via: config.path
        }
    }
    if (!anythingChanged) return null
    const reach = reaches(`${ALL_PREFIX}${test}`, edges, changeFacts, maxDepth)
    return reach
      ? { ...reach, via: reach.via.startsWith(`${repoRoot}/`) ? reach.via.slice(repoRoot.length + 1) : reach.via }
      : null
  }

  for (const pkg of packages) {
    const testFiles = (pkgFiles.get(pkg) as string[]).filter(isTestFile)
    totalTestFiles += testFiles.length
    const maxDepth = options.depth === 'one' ? 1 : Number.POSITIVE_INFINITY
    // A non-bun-test-compatible package (e.g. a vitest-only package) never has
    // one of its OWN files pushed into `selected` — even a forced one, kept
    // symmetric with the reachability path. A caller that asked for them
    // gets them in `native`, with the runner that owns them.
    if (!pkg.bunTestCompatible) {
      if (options.nativeRunners !== 'expose') continue
      const runner = pkg.testRunner ?? 'other'
      for (const test of testFiles) if (reasonFor(pkg, test, maxDepth)) native.push({ test, runner })
      continue
    }

    for (const test of testFiles) {
      const reason = reasonFor(pkg, test, maxDepth)
      if (!reason) continue
      selected.push(test)
      explanations.push({ test: test.slice(repoRoot.length + 1), ...reason })
    }
  }

  return {
    selected,
    totalTestFiles,
    resolver: graph.graphTypescript ? 'compiler' : 'text-scan',
    programMs: graph.programMs,
    explanations,
    native
  }
}

/**
 * Everything the walk needs to know about this diff: which files changed, which
 * packages they sit in, which of those changed a NON-source file, and — the
 * name-level half — whether a given exported name of a given changed file is
 * one the diff actually touched.
 */
type ChangeFacts = {
  files: ReadonlySet<string>
  packages: ReadonlySet<string>
  nonSourcePackages: ReadonlySet<string>
  packageOfFile: (file: string) => string | null
  /** True when `name`, exported by the changed file `file`, is affected by this diff — and always true for a file whose changed names are unknown, which is the file-level answer. */
  affects: (file: string, name: string) => boolean
}

/**
 * DFS from `start` over the forward edge graph, in the node vocabulary
 * {@link NodeKey} documents — true the moment it reaches a changed file through
 * a node that CHECKS. `own:`, `name:`, `touch:`, `external:` and `pkgmeta:` all
 * exist to make that reachability narrower than "any path to the file": a hop
 * reached for one name never fans out to the rest of what it forwards, and a
 * use of one exported name never selects on a change to a sibling name.
 *
 * `maxDepth` bounds how many TRAVERSABLE pushes (`all:`/`own:` nodes queued for
 * later expansion) the walk may make past `start` itself — `start`'s own direct
 * edges are depth `0` and always examined regardless of `maxDepth`. A node
 * popped at `depth === maxDepth` still has its own self-check run (is IT the
 * changed file?) but its edges are never iterated, so nothing past it is
 * reachable. `Number.POSITIVE_INFINITY` never trips that gate.
 *
 * The answer is the first hit's reason, or `null` when nothing is reached. A
 * hit among the test's own direct edges, or on a file it imports directly, is
 * a direct dependency; one further away is transitive.
 */
function reaches(
  start: NodeKey,
  edges: Map<NodeKey, NodeKey[]>,
  changed: ChangeFacts,
  maxDepth: number = Number.POSITIVE_INFINITY
): { kind: SelectionReasonKind; detail: string; via: string } | null {
  const visited = new Set<NodeKey>()
  const stack: Array<[NodeKey, number]> = [[start, 0]]
  const importKind = (depth: number): SelectionReasonKind =>
    depth === 0 ? 'direct-dependency' : 'transitive-dependency'
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [NodeKey, number]
    if (visited.has(current)) continue
    visited.add(current)
    // `all:<file>` is the only node that checks on its own: it says the whole
    // module is in play. `own:<file>` deliberately does not — whatever reached
    // it already emitted the `name:` key that says which export is in play.
    const currentFile = current.startsWith(ALL_PREFIX)
      ? current.slice(ALL_PREFIX.length)
      : current.startsWith(OWN_PREFIX)
        ? current.slice(OWN_PREFIX.length)
        : null
    if (current.startsWith(ALL_PREFIX) && currentFile && changed.files.has(currentFile))
      return {
        kind: importKind(Math.max(0, depth - 1)),
        detail: depth === 0 ? 'the test file itself changed' : 'imports the changed file',
        via: currentFile
      }
    if (depth >= maxDepth) continue
    const ownPackage = currentFile ? changed.packageOfFile(currentFile) : null
    for (const dep of edges.get(current) ?? []) {
      if (dep.startsWith(NAME_PREFIX)) {
        const body = dep.slice(NAME_PREFIX.length)
        const cut = body.lastIndexOf(NAME_SEPARATOR)
        const file = body.slice(0, cut)
        if (changed.files.has(file) && changed.affects(file, body.slice(cut + 1)))
          return { kind: importKind(depth), detail: `uses the changed name ${body.slice(cut + 1)}`, via: file }
        continue
      }
      if (dep.startsWith(TOUCH_PREFIX)) {
        const file = dep.slice(TOUCH_PREFIX.length)
        if (changed.files.has(file))
          return { kind: importKind(depth), detail: 'resolves through the changed file', via: file }
        continue
      }
      if (dep.startsWith(SCAN_PREFIX)) {
        const root = dep.slice(SCAN_PREFIX.length)
        for (const f of changed.files)
          if (f === root || f.startsWith(`${root}/`))
            return { kind: 'declared-input', detail: `reads the folder ${root} from disk`, via: f }
        continue
      }
      if (dep.startsWith(EXTERNAL_PREFIX)) {
        const pkg = dep.slice(EXTERNAL_PREFIX.length)
        if (changed.packages.has(pkg) && pkg !== ownPackage)
          return {
            kind: 'conservative-fallback',
            detail: 'an import shape the graph cannot narrow keeps the whole-package edge',
            via: pkg
          }
        continue
      }
      if (dep.startsWith(PKGMETA_PREFIX)) {
        const pkg = dep.slice(PKGMETA_PREFIX.length)
        if (changed.nonSourcePackages.has(pkg) && pkg !== ownPackage)
          return {
            kind: 'declared-input',
            detail: 'a non-source file of a package it resolves through changed',
            via: pkg
          }
        continue
      }
      if (!visited.has(dep)) stack.push([dep, depth + 1])
    }
  }
  return null
}

// ── The immutable selection ─────────────────────────────────────────────────

/** The selection engine's own version, part of every plan's reproduction context. */
export const SELECTION_ENGINE = 'test-selection@1'

/** Where each revision's snapshot is rooted. A name, not a place: nothing on disk under it is ever read. */
const SNAPSHOT_ROOT = { base: '/selection-snapshot/base', head: '/selection-snapshot/head' } as const

/** Thrown when a selection cannot be computed for the requested revisions — never answered with an empty plan. */
export class SelectionInputError extends Error {
  constructor(readonly problems: readonly { path: string; detail: string }[]) {
    super(`the selection inputs do not hold:\n${problems.map((p) => `  ${p.path}: ${p.detail}`).join('\n')}`)
  }
}

/** Every test a plan asks to run: the required tests, every fallback scope's tests and every obligation's, once each, sorted. */
export function plannedTests(plan: SelectionPlan): string[] {
  return [
    ...new Set([
      ...plan.required.map((t) => t.test),
      ...plan.fallbacks.flatMap((f) => f.tests),
      ...plan.obligations.map((o) => o.test)
    ])
  ].sort()
}

/**
 * The tests a change between two committed revisions requires, with every
 * reason, every named fallback scope, every obligation the policy adds, and
 * the context that reproduces it.
 *
 * Read-only and immutable: every file comes from `repo` for exactly `base` or
 * `head`; the compiler reads the same snapshot; nothing is executed, written or
 * fetched. The head graph and the base graph are both walked, so an edge the
 * head removed still selects; the inventory's input edges are looked up on
 * both views, so a deleted input still names its readers. A changed path no
 * graph node, declared input, scanner or test accounts for is selected through
 * a named fallback scope over every test, and so is every path when the base's
 * inventory is unmodeled — a plan is never empty without saying why.
 *
 * Throws {@link SelectionInputError} when the inventory does not validate, was
 * built for other revisions, or a revision cannot be listed.
 */
export function selectTests(input: SelectTestsInput): SelectionPlan {
  const started = performance.now()
  const { repo, base, head, inventory, policy } = input
  const problems: { path: string; detail: string }[] = []
  if (typeof base !== 'string' || base.length === 0) problems.push({ path: 'base', detail: 'no base revision' })
  if (typeof head !== 'string' || head.length === 0) problems.push({ path: 'head', detail: 'no head revision' })
  for (const p of validateInventory(inventory)) problems.push({ path: p.path, detail: `${p.code}: ${p.detail}` })
  if (inventory.head && inventory.head.revision !== head)
    problems.push({ path: 'head', detail: `the head view was built for ${inventory.head.revision}, not ${head}` })
  if (inventory.base && inventory.base.revision !== base)
    problems.push({ path: 'base', detail: `the base view was built for ${inventory.base.revision}, not ${base}` })
  if (policy.depth !== 'one' && policy.depth !== 'transitive')
    problems.push({ path: 'policy', detail: 'depth is neither one nor transitive' })
  if (problems.length > 0) throw new SelectionInputError(problems)
  const list = (revision: string): readonly string[] => {
    try {
      return repo.list(revision)
    } catch (err) {
      throw new SelectionInputError([
        { path: revision, detail: `the revision cannot be listed: ${(err as Error).message}` }
      ])
    }
  }
  const headFiles = list(head)
  const baseFiles = list(base)
  const headView = inventory.head
  const baseView = inventory.base
  const baseReliable = Boolean(baseView?.modeled) && baseView?.problems.length === 0

  // ── What changed, from the two listings alone.
  const headSet = new Set(headFiles)
  const baseSet = new Set(baseFiles)
  const contentKey = (revision: string, path: string): string | null => {
    const id = repo.identity?.(revision, path)
    if (id) return id
    const text = repo.read(revision, path)
    return text === null ? null : createHash('sha256').update(text).digest('hex')
  }
  const modified = headFiles.filter((p) => baseSet.has(p) && contentKey(base, p) !== contentKey(head, p)).sort()
  const addedPaths = headFiles.filter((p) => !baseSet.has(p)).sort()
  const deletedPaths = baseFiles.filter((p) => !headSet.has(p)).sort()
  // A rename is an exact one: a deleted path whose content an added path holds, paired in path order.
  const renames = new Map<string, string>()
  const deletedByContent = new Map<string, string[]>()
  for (const path of deletedPaths) {
    const key = contentKey(base, path)
    if (key) deletedByContent.set(key, [...(deletedByContent.get(key) ?? []), path])
  }
  for (const path of addedPaths) {
    const key = contentKey(head, path)
    const from = key ? deletedByContent.get(key)?.shift() : undefined
    if (from) renames.set(from, path)
  }
  const renamedTo = new Set(renames.values())
  const added = addedPaths.filter((p) => !renamedTo.has(p))
  const deleted = deletedPaths.filter((p) => !renames.has(p))
  const changes: PlannedChange[] = [
    ...modified.map((path): PlannedChange => ({ path, status: 'modified', accountedBy: [] })),
    ...added.map((path): PlannedChange => ({ path, status: 'added', accountedBy: [] })),
    ...deleted.map((path): PlannedChange => ({ path, status: 'deleted', accountedBy: [] })),
    ...[...renames].map(([from, path]): PlannedChange => ({ path, from, status: 'renamed', accountedBy: [] }))
  ].sort((a, b) => a.path.localeCompare(b.path) || (a.from ?? '').localeCompare(b.from ?? ''))
  /** Every changed path at the head, and every changed path at the base. */
  const headChanged = [...modified, ...added, ...renames.values()]
  const baseChanged = [...modified, ...deleted, ...renames.keys()]
  const allChanged = new Set([...headChanged, ...baseChanged])

  // ── The compiler, and the changed names it reads.
  const typescript = policy.typescript === undefined ? loadLibraryTypeScript() : policy.typescript
  const resolver: 'compiler' | 'text-scan' = typescript && policy.resolver !== 'text-scan' ? 'compiler' : 'text-scan'
  const unreadable = new Set<string>()
  const textAt = (revision: string, path: string): string | null => {
    const text = repo.read(revision, path)
    if (text === null) unreadable.add(path)
    return text
  }
  const diffs: FileDiff[] = []
  const afterRanges = new Map<string, readonly { start: number; end: number }[]>()
  for (const path of modified) {
    const before = textAt(base, path)
    const after = textAt(head, path)
    if (before === null || after === null) continue
    const ranges = lineDiffRanges(before, after)
    afterRanges.set(path, ranges.afterRanges)
    diffs.push({ file: path, before, after, ...ranges })
  }
  for (const path of added) textAt(head, path)
  for (const path of deleted) textAt(base, path)
  // Added, deleted and renamed files are wholly affected — absent from the map is the file-level answer.
  const names = typescript ? attributeNames(typescript, diffs) : new Map<string, ReadonlySet<string> | 'all'>()

  // ── Both graphs.
  const dataFolders = policy.dataFolders ?? ['fixtures']
  const isData = (path: string): boolean =>
    path
      .split('/')
      .slice(0, -1)
      .some((segment) => dataFolders.includes(segment))
  const scanEdges = policy.depth === 'one' ? 'ignore' : 'select'
  const maxDepth = policy.depth === 'one' ? 1 : Number.POSITIVE_INFINITY
  const headTests = new Map(headView.tests.map((t) => [t.id, t]))
  const reasons = new Map<string, PlanReason[]>()
  const addReason = (test: string, reason: PlanReason) => {
    if (!headTests.has(test)) return
    reasons.set(test, [...(reasons.get(test) ?? []), reason])
  }
  const accounted = new Map<string, Set<string>>([...allChanged].map((p) => [p, new Set<string>()]))
  const account = (path: string, by: string) => accounted.get(path)?.add(by)
  let programMs = 0

  const walk = (
    side: 'base' | 'head',
    revision: string,
    files: readonly string[],
    changed: readonly string[],
    tests: readonly string[],
    view: InventoryView | null
  ) => {
    const root = SNAPSHOT_ROOT[side]
    const tree = revisionTree(repo, revision, files, root)
    const testAbs = new Set(tests.map((t) => join(root, t)))
    // A preload or a spawned program runs its own imports for every test that
    // reads it, so its readers get an edge into its graph.
    const extraEdges = new Map<string, NodeKey[]>()
    for (const edge of view?.edges ?? []) {
      if ((edge.kind !== 'preload' && edge.kind !== 'spawn') || edge.readerKind !== 'code') continue
      if (edge.input.endsWith('/') || !SOURCE_EXTENSIONS.includes(extname(edge.input))) continue
      for (const reader of edge.readers) {
        const key = join(root, reader)
        extraEdges.set(key, [...(extraEdges.get(key) ?? []), `${ALL_PREFIX}${join(root, edge.input)}`])
      }
    }
    const graph = buildSelectionGraph(tree, {
      typescript,
      resolver,
      repoTreeScanners: scanEdges,
      spawnDetection: scanEdges,
      spawnPrograms: policy.spawnPrograms ?? [],
      isTest: (file) => testAbs.has(file),
      includeUnpackaged: true,
      extraEdges
    })
    programMs += graph.programMs
    // The graph accounts for a changed path only when some test's closure
    // reaches it: a source file no test imports may still be run another way
    // (a program a test starts without declaring it), so it is not modeled.
    const reached = closureOf(
      graph,
      [...testAbs].map((t) => `${ALL_PREFIX}${t}`)
    )
    for (const path of changed) {
      const abs = join(root, path)
      if (isData(path)) continue
      const owner = graph.fileToPackage.get(abs)
      if (graph.allSourceFiles.has(abs) && (reached.files.has(abs) || (owner && reached.packages.has(owner))))
        account(path, 'graph')
      else if (reached.scanRoots.some((r) => abs === r || abs.startsWith(`${r}/`))) account(path, 'graph-scan')
    }
    const facts = changeFactsFor(graph, new Set(changed.map((p) => join(root, p))), names)
    if (facts.files.size === 0 && facts.packages.size === 0) return
    for (const test of tests) {
      const hit = reaches(`${ALL_PREFIX}${join(root, test)}`, graph.edges, facts, maxDepth)
      if (!hit) continue
      const target = side === 'base' ? (renames.get(test) ?? test) : test
      addReason(target, {
        kind: hit.kind === 'always-run' ? 'declared-input' : hit.kind,
        detail: hit.detail,
        via: hit.via.startsWith(`${root}/`) ? hit.via.slice(root.length + 1) : hit.via,
        revision: side
      })
    }
  }
  walk(
    'head',
    head,
    headFiles,
    headChanged,
    headView.tests.map((t) => t.id),
    headView
  )
  const baseTests = baseReliable
    ? (baseView as InventoryView).tests.map((t) => t.id)
    : headView.tests.map((t) => t.id).filter((id) => baseSet.has(id))
  walk('base', base, baseFiles, baseChanged, baseTests, baseReliable ? baseView : null)

  // ── Added and renamed tests have nothing importing them yet.
  for (const path of [...added, ...renames.values()])
    if (headTests.has(path))
      addReason(path, {
        kind: 'direct-dependency',
        detail: 'the test file itself was added or renamed',
        via: path,
        revision: 'head'
      })
  for (const path of allChanged)
    if (headTests.has(path) || (baseReliable && (baseView as InventoryView).tests.some((t) => t.id === path)))
      account(path, 'test')

  // ── Folder-scanning tests, by their declared kind of change.
  const scanners = policy.scanners ?? []
  for (const declaration of scanners) {
    for (const path of allChanged)
      if (declaration.roots.some((root) => underDeclaredRoot(path, root))) account(path, `scanner:${declaration.test}`)
    const triggered = scannerTriggered(declaration, {
      changed: headChanged,
      added: [...added, ...renames.values()],
      removed: [...deleted, ...renames.keys()],
      read: (path) => repo.read(head, path),
      ranges: (path) => afterRanges.get(path),
      typescript
    })
    if (triggered)
      addReason(declaration.test, {
        kind: 'declared-input',
        detail: "the diff is this folder-scanning test's declared trigger",
        via: declaration.test,
        revision: 'head'
      })
  }

  // ── The inventory's input edges, on both views.
  const withoutScans = (view: InventoryView): InventoryView =>
    policy.depth === 'one' ? { ...view, edges: view.edges.filter((e) => e.kind !== 'scan') } : view
  const headInputs = withoutScans(headView)
  const baseInputs = baseView ? (baseReliable ? withoutScans(baseView) : { ...baseView, modeled: false }) : null
  const fallbackScopes = new Map<string, { reason: string; paths: Set<string> }>()
  const fallback = (id: string, reason: string, path: string) => {
    const scope = fallbackScopes.get(id) ?? { reason, paths: new Set<string>() }
    fallbackScopes.set(id, scope)
    scope.paths.add(path)
    account(path, `fallback:${id}`)
  }
  const engaged = new Map<
    string,
    { id: string; kind: SelectionPlan['policies'][number]['kind']; duty: string; via: Set<string> }
  >()
  for (const change of changes) {
    const from = change.from ?? change.path
    const before = change.status === 'added' ? null : repo.read(base, from)
    const after = change.status === 'deleted' ? null : repo.read(head, change.path)
    for (const edge of headInputs.edges) if (edgeCovers(edge, change.path)) account(change.path, `input:${edge.source}`)
    if (baseInputs?.modeled)
      for (const edge of baseInputs.edges) if (edgeCovers(edge, from)) account(change.path, `input:${edge.source}`)
    const impact = changedInputReaders(
      baseInputs,
      headInputs,
      { path: change.path, ...(change.from ? { from } : {}), before, after },
      policy.parsers ?? {}
    )
    for (const reader of impact.readers)
      addReason(renames.get(reader.test) ?? reader.test, {
        kind: 'declared-input',
        detail: `a ${reader.readerKind} reader (${reader.edge}): ${reader.reason}`,
        via: change.path,
        revision: 'head'
      })
    for (const p of impact.policies) {
      const entry = engaged.get(p.id) ?? { ...p, via: new Set<string>() }
      engaged.set(p.id, entry)
      entry.via.add(change.path)
    }
    for (const view of [baseInputs, headInputs])
      for (const scope of view?.unknowns ?? [])
        if (scope.scope === '.' || inputCovers(scope.scope, change.path) || inputCovers(scope.scope, from))
          fallback(`unknown:${scope.scope}`, scope.reason, change.path)
    if (!baseReliable)
      fallback(
        'base-unmodeled',
        'the base revision has no valid inventory, so what read these paths there is unknown',
        change.path
      )
  }
  for (const path of unreadable) fallback('unreadable', 'the path is listed but could not be read', path)
  for (const change of changes) {
    for (const path of [change.path, ...(change.from ? [change.from] : [])])
      for (const by of accounted.get(path) ?? []) if (!change.accountedBy.includes(by)) change.accountedBy.push(by)
    if (change.accountedBy.length === 0) {
      fallback(
        'unattributed',
        'no graph node, declared input, folder-scanning test or test identity accounts for the path',
        change.path
      )
      change.accountedBy.push('fallback:unattributed')
    }
    change.accountedBy.sort()
  }

  // ── Obligations: additions the consumer states, never dependencies.
  const obligations: PlannedObligation[] = []
  for (const obligation of policy.obligations ?? []) {
    const globs = (obligation.tests ?? []).map(globToRegex)
    for (const test of headView.tests)
      if (globs.some((re) => re.test(test.id)) || (obligation.suites ?? []).includes(test.suite))
        obligations.push({
          test: test.id,
          suite: test.suite,
          runner: test.runner,
          obligation: obligation.id,
          kind: obligation.kind,
          reason: obligation.reason
        })
  }
  obligations.sort((a, b) => a.obligation.localeCompare(b.obligation) || a.test.localeCompare(b.test))

  const allTests = headView.tests.map((t) => t.id).sort()
  const fallbacks: FallbackScope[] = [...fallbackScopes]
    .map(([id, scope]) => ({ id, reason: scope.reason, paths: [...scope.paths].sort(), tests: allTests }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const required: PlannedTest[] = [...reasons]
    .map(([test, list]) => {
      const identity = headTests.get(test) as InventoryView['tests'][number]
      const unique = [...new Map(list.map((r) => [stableJson(r), r])).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, r]) => r)
      return { test, suite: identity.suite, runner: identity.runner, reasons: unique }
    })
    .sort((a, b) => a.test.localeCompare(b.test))

  const testIdentityDiff: ReturnType<typeof diffTestIdentities> = baseReliable
    ? diffTestIdentities(baseView as InventoryView, headView, renames)
    : { added: [], removed: [], renamed: [] }
  const planned = new Set([
    ...required.map((t) => t.test),
    ...fallbacks.flatMap((f) => f.tests),
    ...obligations.map((o) => o.test)
  ])
  const suitesPlanned = new Set(headView.tests.filter((t) => planned.has(t.id)).map((t) => t.suite))
  const configurations: SuiteConfiguration[] = headView.suites
    .filter((s) => suitesPlanned.has(s.id))
    .map(({ id, runner, cwd, preload, environment, configFiles }) => ({
      id,
      runner,
      cwd,
      preload,
      environment,
      configFiles
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  const semantic = {
    schema: 'test-selection-plan' as const,
    schemaVersion: 1 as const,
    context: {
      base,
      head,
      inventory: {
        head: { contextIdentity: headView.contextIdentity, graphIdentity: headView.graphIdentity },
        base: baseView
          ? { contextIdentity: baseView.contextIdentity, graphIdentity: baseView.graphIdentity, modeled: baseReliable }
          : null
      },
      policy: stableHash({
        depth: policy.depth,
        scanners: policy.scanners ?? [],
        spawnPrograms: policy.spawnPrograms ?? [],
        dataFolders,
        obligations: policy.obligations ?? [],
        parsers: Object.keys(policy.parsers ?? {}).sort(),
        resolver: policy.resolver ?? null
      }),
      resolver,
      compiler: resolver === 'compiler' && typescript ? typescript.version : null,
      engine: SELECTION_ENGINE
    },
    changes,
    required,
    fallbacks,
    obligations,
    policies: [...engaged.values()]
      .map((p) => ({ id: p.id, kind: p.kind, duty: p.duty, via: [...p.via].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    removedTests: testIdentityDiff.removed,
    renamedTests: testIdentityDiff.renamed.sort((a, b) => a.from.localeCompare(b.from)),
    configurations
  }
  return {
    ...semantic,
    identity: stableHash(semantic),
    profile: { programMs, totalMs: performance.now() - started }
  }
}

/**
 * Everything the walk could ever reach from `starts`, whatever changed: the
 * files on any traversable or checking node, the packages a coarse
 * whole-package edge names, and the folders a scan edge reads.
 */
function closureOf(
  graph: SelectionGraph,
  starts: readonly NodeKey[]
): { files: Set<string>; packages: Set<string>; scanRoots: string[] } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const scanRoots = new Set<string>()
  const visited = new Set<NodeKey>()
  const stack = [...starts]
  while (stack.length > 0) {
    const current = stack.pop() as NodeKey
    if (visited.has(current)) continue
    visited.add(current)
    if (current.startsWith(ALL_PREFIX)) files.add(current.slice(ALL_PREFIX.length))
    else if (current.startsWith(OWN_PREFIX)) files.add(current.slice(OWN_PREFIX.length))
    for (const dep of graph.edges.get(current) ?? []) {
      if (dep.startsWith(NAME_PREFIX)) {
        const body = dep.slice(NAME_PREFIX.length)
        files.add(body.slice(0, body.lastIndexOf(NAME_SEPARATOR)))
      } else if (dep.startsWith(TOUCH_PREFIX)) files.add(dep.slice(TOUCH_PREFIX.length))
      else if (dep.startsWith(EXTERNAL_PREFIX)) packages.add(dep.slice(EXTERNAL_PREFIX.length))
      else if (dep.startsWith(SCAN_PREFIX)) scanRoots.add(dep.slice(SCAN_PREFIX.length))
      else if (!dep.startsWith(PKGMETA_PREFIX) && !visited.has(dep)) stack.push(dep)
    }
  }
  return { files, packages, scanRoots: [...scanRoots] }
}
