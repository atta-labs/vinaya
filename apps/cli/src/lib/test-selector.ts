/**
 * Resolves, through the real import graph, which test files a set of changed
 * files could affect. Never a folder heuristic: a changed file selects a test
 * only when that test's own transitive import closure actually reaches it, so
 * a change in one file of a large directory never drags in every sibling test
 * that happens to share its folder.
 *
 * Deliberately regex-based, not a full TypeScript compiler pass — the same
 * extraction shape `apps/cli/tests/import-boundary.test.ts` already proved out
 * for this exact codebase (`from`-clauses, bare `import '<spec>'`, and dynamic
 * `import(...)`). A full type-checker resolution would be strictly more correct
 * but far too slow to run at push time on every commit; this stays a
 * static-text scan specifically so it can meet the push-time budget.
 *
 * ## Cross-package resolution — named exports, with conservative fallback
 *
 * A relative import resolves to a real file within the same package (the only
 * place a relative specifier can point). A bare `@scope/name` specifier that
 * matches another workspace package is resolved THROUGH THAT PACKAGE'S EXPORTED
 * NAMES, not treated as a dependency on the whole package: `import { foo } from
 * '@scope/pkg'` depends only on the files traversed to resolve `foo` — the
 * package's declared entrypoint, every re-export hop, and the file that
 * actually defines `foo` — never on `@scope/pkg`'s other, unrelated files. So a
 * change inside `packages/pkg` selects a consuming test only when the changed
 * file lies on the resolution path of a name that test actually imports.
 *
 * The resolution path is split into two edge kinds so precision and never-miss
 * both hold:
 *   - the DEFINING file(s) become ordinary traversable graph nodes, so the
 *     definition's own transitive relative dependencies are walked exactly like
 *     any in-package import (a change to a helper the definition imports still
 *     selects the test);
 *   - each RE-EXPORT HOP file (the entrypoint barrel and any intermediate
 *     re-export module) becomes a change-detection-only marker (`touch:`): a
 *     change to the barrel or a hop selects the test, but the barrel's OTHER
 *     re-exports are never traversed, which is exactly what keeps a barrel edit
 *     from reintroducing whole-package selection. A hop's OWN module-scope
 *     imports (a barrel's `import './register'` side effect, or an
 *     `import { helper } from './helper'` it uses in module code) ARE surfaced
 *     as traversable edges, since that code runs on every import through the hop
 *     — so a change to a hop's own dependency still selects the test. A hop's own
 *     module-scope import of ANOTHER workspace package is resolved through that
 *     package's exported names by these same two rules, so a barrel that uses one
 *     name from a sibling package does not drag that whole package back in.
 *
 * A NON-source change inside a package (its `package.json`, `tsconfig.json`, or a
 * non-`.ts` asset) is not a graph node, so a precisely-resolved importer also
 * carries a `pkgmeta:<pkg>` marker that fires only on such a change — editing
 * `exports`/`main` re-points what every consumer resolves to, and this keeps that
 * caught without reintroducing whole-package selection on ordinary source edits.
 * One such marker is carried for EVERY package on the resolution path, not only
 * the directly-imported one: when a name is re-exported across a package
 * boundary, the intermediate package's manifest re-points the resolution just as
 * the direct one's does.
 *
 * ## Residual over-selection this design accepts
 *
 * A re-export hop is one `touch:` marker for the WHOLE FILE, not per exported
 * name, so editing any line of a barrel — including a sibling `export { other }
 * from './other'` line that the importer's own name never resolves through —
 * selects every test that resolved any name through that barrel. Narrowing a
 * `touch:` marker to the specific re-export line would need line-level change
 * attribution this static scan does not have; over-selecting on a barrel edit is
 * the deliberate trade, and barrel edits are rare next to ordinary source edits.
 * The same holds for `pkgmeta:`: it fires on ANY non-source change in a package
 * on the path, including a `README.md` that re-points nothing.
 *
 * ## Conservative fallback — over-select, never omit
 *
 * The refinement can only ever REMOVE the whole-package edge when it can PROVE
 * a name maps to specific files. Every shape it cannot prove safe retains the
 * original whole-package dependency (`external:<pkg>`), so the selector may
 * over-select but never omits a truly affected test. Shapes that fall back:
 * namespace imports (`import * as ns`), default imports, side-effect imports
 * (`import '@scope/pkg'`), dynamic imports (`import('@scope/pkg')`), `export *`
 * re-exports, an empty or unparseable named list (`import {}`, or a brace list
 * carrying a stray token) which narrows to nothing yet still runs the module, a
 * requested name with no provable single origin (unknown, ambiguous across
 * multiple `export *` sources, cyclic, or re-exported across a package boundary
 * that itself will not resolve), a package whose entrypoint/subpath cannot be
 * derived from its manifest, and any specifier a single file imports under more
 * than one shape at once. Aliases (`import { a as b }`) and `type` imports are
 * mapped by their EXPORTED (origin) name, never the local alias, so they resolve
 * precisely rather than falling back.
 *
 * The same rule governs an `exports` CONDITIONS object: the runtime picks a
 * target by which condition is active, which a static scan cannot know, so a
 * conditions object is honoured only when every runtime condition it declares
 * lands on the SAME source file. Declare two different runtime targets and the
 * choice is unprovable, so the subpath stays unmapped and every bare import of it
 * keeps the whole-package edge. `types`/`typings` are excluded outright — a
 * declaration file is what type-checking loads, never what runs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { globToRegex } from '@attalabs/aeg-core'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage'])

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
// `from` at all, which measured 63 ms → 346 ms across this repo's sources — paid
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

/** Every regular file under `root`, skipping `SKIP_DIRS` — absolute paths. */
export function walkFiles(root: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(root, entry)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(abs)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      out.push(...walkFiles(abs))
    } else {
      out.push(abs)
    }
  }
  return out
}

/** Resolves a module base path against `knownFiles` — tries the bare path, each `SOURCE_EXTENSIONS` suffix, and an `index.<ext>` inside it as a directory, the same resolution order Node/bundlers use. `null` when nothing matches. */
function resolveFileCandidate(base: string, knownFiles: Set<string>): string | null {
  if (knownFiles.has(base)) return base
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
  /** `package.json`'s own `name`, e.g. `@attalabs/aeg-core`. */
  name: string
  /**
   * Whether this package's own declared `test` script actually runs under
   * `bun test` — the one runner this hook's `pre-push-select-tests.ts` caller
   * invokes on whatever this function selects. A package whose real `test`
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
  // it is never a changed file in this repo, so it constrains nothing.
  const add = (subpath: string, value: unknown): void => {
    const files = new Set<string>()
    for (const target of declaredTargets(value)) {
      if (!target.startsWith('.')) continue
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

/** Reads `<repoRoot>/package.json`'s `workspaces` globs (`apps/*`, `packages/*` shape only — no other glob forms are in use in this repo) and returns every member with a real `package.json`. */
export function discoverWorkspacePackages(repoRoot: string): WorkspacePackage[] {
  const rootPkgPath = join(repoRoot, 'package.json')
  let workspaces: string[] = []
  try {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as { workspaces?: string[] }
    workspaces = rootPkg.workspaces ?? []
  } catch {
    return []
  }
  const out: WorkspacePackage[] = []
  for (const glob of workspaces) {
    const m = /^([^*]+)\*$/.exec(glob)
    if (!m) continue
    const parentDir = join(repoRoot, (m[1] as string).replace(/\/$/, ''))
    let entries: string[]
    try {
      entries = readdirSync(parentDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(parentDir, entry)
      const pkgPath = join(dir, 'package.json')
      let pkg: PackageManifest
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageManifest
      } catch {
        continue
      }
      if (!pkg.name) continue
      const sourceFiles = walkFiles(dir).filter((f) => SOURCE_EXTENSIONS.includes(extname(f)))
      const knownFiles = new Set(sourceFiles)
      out.push({
        dir,
        name: pkg.name,
        bunTestCompatible: isBunTestScript(pkg.scripts?.test),
        entrypoints: deriveEntrypoints(dir, pkg, knownFiles),
        sourceFiles
      })
    }
  }
  return out
}

/** True for a `*.test.<ext>` file, the only shape this repo's own test files use (matches `ci-shards.test.ts`'s own convention). */
export function isTestFile(path: string): boolean {
  const withoutExt = path.slice(0, -extname(path).length)
  return withoutExt.endsWith('.test')
}

// ── Edge markers ────────────────────────────────────────────────────────────

/** A resolved forward dependency of a file — a real graph node, a change-only re-export-hop marker, a whole-package fallback, or a package-manifest marker. */
const TOUCH_PREFIX = 'touch:'
const EXTERNAL_PREFIX = 'external:'
// A precisely-resolved importer carries `pkgmeta:<pkg>` so a change to a NON-source
// file in that package (its `package.json`, `tsconfig.json`, a non-`.ts` asset)
// still selects it: such a file is not a graph node, so the resolved file edges
// alone would miss it, yet editing `exports`/`main` re-points what the importer
// resolves to. It fires only on non-source changes; a source change is caught
// precisely by the real file edge, so precision on ordinary edits is preserved.
const PKGMETA_PREFIX = 'pkgmeta:'

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
function makeSourceReader(): (file: string) => string {
  const cache = new Map<string, string>()
  return (file: string): string => {
    let cached = cache.get(file)
    if (cached === undefined) {
      try {
        cached = readFileSync(file, 'utf8')
      } catch {
        cached = ''
      }
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

// ── Selection ───────────────────────────────────────────────────────────────

export type SelectionResult = {
  /** Absolute paths of every `*.test.*` file selected, across every affected package. */
  selected: string[]
  /** Total `*.test.*` files scanned across every affected package — the denominator for "N of M". */
  totalTestFiles: number
}

export type SelectionOptions = {
  /**
   * Glob patterns (matched against a test file's repo-root-relative path,
   * `globToRegex`'s own grammar) naming test files whose own INPUT is the
   * repository itself — a rule about the repo's own generated/managed state,
   * which no import ever names. Reachability can never select one of these on
   * the merits; they run on every push regardless.
   */
  alwaysRun?: readonly string[]
  /**
   * Repo-root-relative or absolute paths of files added or renamed in this diff
   * (`addedOrRenamedFilesSinceRemoteBase`). A brand-new or renamed test file has
   * nothing importing it yet, so it can never satisfy reachability on its own
   * first push — every one of these that IS a test file is selected
   * unconditionally.
   */
  addedOrRenamed?: readonly string[]
}

/**
 * The whole pipeline: given the changed files (repo-root-relative or absolute,
 * either works) and the repo root, builds one global forward-import graph across
 * every workspace package, resolving relative imports to files and bare
 * workspace-package imports through the target package's exported names, and
 * returns every test file — in ANY package — whose transitive import closure
 * reaches a changed file (directly, through a resolved named export, or through
 * the whole-package fallback for an unresolved import shape), plus every test
 * file `options.alwaysRun` names or that `options.addedOrRenamed` itself is.
 */
export function selectAffectedTestFiles(
  repoRoot: string,
  changedFiles: string[],
  options: SelectionOptions = {}
): SelectionResult {
  const packages = discoverWorkspacePackages(repoRoot)
  const absChanged = new Set(changedFiles.map((f) => (isAbsolute(f) ? f : join(repoRoot, f))))
  const alwaysRunRegexes = (options.alwaysRun ?? []).map(globToRegex)
  const addedOrRenamed = new Set((options.addedOrRenamed ?? []).map((f) => (isAbsolute(f) ? f : join(repoRoot, f))))

  const readSource = makeSourceReader()
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

  // Which packages have a changed file directly inside them (the set a coarse
  // `external:<pkg>` edge matches), and which of those changed a NON-source file
  // — a `package.json`/`tsconfig.json`/asset that is not a graph node and so is
  // invisible to a precisely-resolved importer's file edges (`pkgmeta:` covers it).
  const changedPackageNames = new Set<string>()
  const nonSourceChangedPackages = new Set<string>()
  for (const pkg of packages) {
    for (const f of absChanged) {
      if (!f.startsWith(`${pkg.dir}/`)) continue
      changedPackageNames.add(pkg.name)
      if (!allSourceFiles.has(f)) nonSourceChangedPackages.add(pkg.name)
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

  // Build the global forward edge map.
  const edges = new Map<string, string[]>()
  for (const pkg of packages) {
    const knownFiles = pkgKnownFiles.get(pkg) as Set<string>
    for (const file of pkgFiles.get(pkg) as string[]) {
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

      edges.set(file, deps)
    }
  }

  const anythingChanged = absChanged.size > 0 || changedPackageNames.size > 0
  const selected: string[] = []
  let totalTestFiles = 0

  for (const pkg of packages) {
    const testFiles = (pkgFiles.get(pkg) as string[]).filter(isTestFile)
    totalTestFiles += testFiles.length
    // A non-bun-test-compatible package (e.g. a vitest-only package) never has
    // one of its OWN files pushed into `selected` — even a forced one, kept
    // symmetric with the reachability path.
    if (!pkg.bunTestCompatible) continue

    for (const test of testFiles) {
      const forced = alwaysRunRegexes.some((re) => re.test(test.slice(repoRoot.length + 1))) || addedOrRenamed.has(test)
      if (
        forced ||
        (anythingChanged &&
          reaches(test, edges, absChanged, changedPackageNames, nonSourceChangedPackages, fileToPackage))
      ) {
        selected.push(test)
      }
    }
  }

  return { selected, totalTestFiles }
}

/**
 * DFS from `start` over the forward edge graph — true the moment it reaches a
 * changed file (a real node or a `touch:` re-export-hop marker), a coarse
 * `external:<pkg>` edge naming a changed package, or a `pkgmeta:<pkg>` edge whose
 * package had a NON-source (manifest/asset) change. A `touch:` marker is checked
 * but never traversed, so a re-exporting barrel's OTHER exports never fan out.
 * An `external:`/`pkgmeta:` edge naming the edge-owning file's OWN package is
 * ignored — a file "importing its own package" would otherwise coarsely select on
 * any same-package change, exactly the folder-shaped over-selection this rules out.
 */
function reaches(
  start: string,
  edges: Map<string, string[]>,
  changedFiles: Set<string>,
  changedPackages: Set<string>,
  nonSourceChangedPackages: Set<string>,
  fileToPackage: Map<string, string>
): boolean {
  const visited = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (visited.has(current)) continue
    visited.add(current)
    if (changedFiles.has(current)) return true
    for (const dep of edges.get(current) ?? []) {
      if (dep.startsWith(TOUCH_PREFIX)) {
        if (changedFiles.has(dep.slice(TOUCH_PREFIX.length))) return true
        continue
      }
      if (dep.startsWith(EXTERNAL_PREFIX)) {
        const specifier = dep.slice(EXTERNAL_PREFIX.length)
        if (changedPackages.has(specifier) && specifier !== fileToPackage.get(current)) return true
        continue
      }
      if (dep.startsWith(PKGMETA_PREFIX)) {
        const pkg = dep.slice(PKGMETA_PREFIX.length)
        if (nonSourceChangedPackages.has(pkg) && pkg !== fileToPackage.get(current)) return true
        continue
      }
      if (!visited.has(dep)) stack.push(dep)
    }
  }
  return false
}
