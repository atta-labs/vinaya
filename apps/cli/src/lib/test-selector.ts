/**
 * Resolves, through the real import graph, which test
 * files a set of changed files could affect. Never a folder heuristic: a
 * changed file selects a test only when that test's own transitive import
 * closure actually reaches it, so a change in one file of a large directory
 * never drags in every sibling test that happens to share its folder.
 *
 * Deliberately regex-based, not a full TypeScript compiler pass — the same
 * extraction shape `apps/cli/tests/import-boundary.test.ts` already proved
 * out for this exact codebase (`from`-clauses, bare `import '<spec>'`, and
 * dynamic `import(...)`). A full type-checker resolution would be strictly
 * more correct but far too slow to run at push time on every commit; this
 * stays a static-text scan specifically so it can meet O6's own "measured
 * budget" requirement.
 *
 * Cross-package: a relative import resolves to a real file within the same
 * package (the only place a relative specifier can point). A bare
 * `@scope/name` specifier that matches another workspace package is treated
 * as depending on THAT WHOLE PACKAGE — the coarsest granularity a bare
 * specifier can honestly support without full type resolution — so a
 * changed file inside `packages/foo` affects every test, in every package,
 * that imports `@scope/foo` anywhere, not just the files that import the
 * one specific export that changed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { globToRegex } from '@attalabs/aeg-core'

const FROM_CLAUSE_RE = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*(['"])([^'"]+)\1/gm
const BARE_IMPORT_RE = /^\s*import\s*(['"])([^'"]+)\1/gm
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'coverage'])

export function extractImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>()
  for (const re of [FROM_CLAUSE_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0
    let match = re.exec(source)
    while (match !== null) {
      specifiers.add(match[2] as string)
      match = re.exec(source)
    }
  }
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

/**
 * Resolves a relative specifier from `fromFile` against the real files in
 * `knownFiles` (a package's own file set) — tries the bare path, each
 * `SOURCE_EXTENSIONS` suffix, and an `index.<ext>` inside it as a directory,
 * the same resolution order Node/bundlers use. `null` when nothing matches
 * (an untraceable import — a JSON file, a CSS module, a package that isn't
 * this one — is not a resolution failure worth halting the selector over).
 */
export function resolveRelativeImport(fromFile: string, specifier: string, knownFiles: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
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

export type WorkspacePackage = {
  /** Absolute directory. */
  dir: string
  /** `package.json`'s own `name`, e.g. `@attalabs/aeg-core`. */
  name: string
  /**
   * Whether this package's own declared `test` script actually runs under
   * `bun test` — the one runner this hook's `pre-push-select-tests.ts`
   * caller invokes on whatever this function selects. A package whose real
   * `test` script is something else (`vitest run`, most commonly — real
   * `vi.mock` support `bun:test`'s own compat shim does not provide) is
   * never bun-test-compatible: selecting one of its files here would hand
   * the hook a file it cannot correctly execute regardless of which lines
   * changed, a tool mismatch no import-graph refinement fixes. A package
   * with no declared `test` script at all is trivially compatible — it has
   * nothing this selector could mis-select.
   */
  bunTestCompatible: boolean
}

function isBunTestScript(script: string | undefined): boolean {
  if (!script) return true
  return /(^|[\s;&|])bun\s+test\b/.test(script)
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
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; scripts?: { test?: string } }
        if (pkg.name) out.push({ dir, name: pkg.name, bunTestCompatible: isBunTestScript(pkg.scripts?.test) })
      } catch {}
    }
  }
  return out
}

/** True for a `*.test.<ext>` file, the only shape this repo's own test files use (matches `ci-shards.test.ts`'s own convention). */
export function isTestFile(path: string): boolean {
  const withoutExt = path.slice(0, -extname(path).length)
  return withoutExt.endsWith('.test')
}

/**
 * Builds one package's own forward dependency graph: absolute file path to
 * the absolute paths of every relative import it resolves — external/bare
 * specifiers are recorded too, prefixed so they never collide with a real
 * path, letting the caller detect "this file imports package X" without a
 * second pass.
 */
function buildFileGraph(pkgDir: string): { files: string[]; edges: Map<string, string[]> } {
  const files = walkFiles(pkgDir).filter((f) => SOURCE_EXTENSIONS.includes(extname(f)))
  const knownFiles = new Set(files)
  const edges = new Map<string, string[]>()
  for (const file of files) {
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const deps: string[] = []
    for (const specifier of extractImportSpecifiers(source)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(file, specifier, knownFiles)
        if (resolved) deps.push(resolved)
      } else {
        deps.push(`external:${specifier}`)
      }
    }
    edges.set(file, deps)
  }
  return { files, edges }
}

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
   * repository itself — a rule about the repo's own generated/managed
   * state, which no import ever names. Reachability can never select one of
   * these on the merits; they run on every push regardless.
   */
  alwaysRun?: readonly string[]
  /**
   * Repo-root-relative or absolute paths of files added or renamed in this
   * diff (`addedOrRenamedFilesSinceRemoteBase`). A brand-new or renamed test
   * file has nothing importing it yet, so it can never satisfy reachability
   * on its own first push — every one of these that IS a test file is
   * selected unconditionally.
   */
  addedOrRenamed?: readonly string[]
}

/**
 * The whole pipeline: given the changed files (repo-root-relative or
 * absolute, either works) and the repo root, groups them by workspace
 * package, resolves each package's own import graph once, and returns every
 * test file — in ANY package — whose transitive import closure reaches a
 * changed file in the SAME package, plus every test file that reaches a
 * changed OTHER package via a bare `@scope/name` import matching that
 * package's own `name`, plus every test file `options.alwaysRun` names or
 * that `options.addedOrRenamed` itself is.
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

  // Which packages have at least one changed file directly inside them.
  const changedPackageNames = new Set<string>()
  for (const pkg of packages) {
    for (const f of absChanged) {
      if (f.startsWith(`${pkg.dir}/`)) {
        changedPackageNames.add(pkg.name)
        break
      }
    }
  }

  const selected: string[] = []
  let totalTestFiles = 0

  for (const pkg of packages) {
    const { files, edges } = buildFileGraph(pkg.dir)
    const testFiles = files.filter(isTestFile)
    totalTestFiles += testFiles.length

    // A non-bun-test-compatible package (e.g. a vitest-only package) never
    // has one of its OWN files pushed into `selected` — `alwaysRun`/
    // `addedOrRenamed` are still test files this hook would run through
    // `bun test`, so a forced test is subject to the exact same restriction
    // the reachability path already applies, kept symmetric.
    if (!pkg.bunTestCompatible) continue

    const packageChanged = new Set([...absChanged].filter((f) => f.startsWith(`${pkg.dir}/`)))
    const relevant = packageChanged.size > 0 || changedPackageNames.size > 0

    for (const test of testFiles) {
      const forced = alwaysRunRegexes.some((re) => re.test(test.slice(repoRoot.length + 1))) || addedOrRenamed.has(test)
      if (forced || (relevant && reachesChangedFile(test, edges, packageChanged, changedPackageNames, pkg.name))) {
        selected.push(test)
      }
    }
  }

  return { selected, totalTestFiles }
}

/** DFS from `start` over the forward edge graph — true the moment it reaches a file in `changedInPackage`, or a `external:<specifier>` edge naming a package in `changedOtherPackages` (never the file's OWN package — a file always "imports its own package," which would otherwise select every test whenever anything in its own package changed, exactly the folder-shaped over-selection O6 rules out). */
function reachesChangedFile(
  start: string,
  edges: Map<string, string[]>,
  changedInPackage: Set<string>,
  changedOtherPackages: Set<string>,
  ownPackageName: string
): boolean {
  const visited = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (visited.has(current)) continue
    visited.add(current)
    if (changedInPackage.has(current)) return true
    for (const dep of edges.get(current) ?? []) {
      if (dep.startsWith('external:')) {
        const specifier = dep.slice('external:'.length)
        for (const otherPkg of changedOtherPackages) {
          if (otherPkg === ownPackageName) continue
          if (specifier === otherPkg || specifier.startsWith(`${otherPkg}/`)) return true
        }
        continue
      }
      if (!visited.has(dep)) stack.push(dep)
    }
  }
  return false
}
