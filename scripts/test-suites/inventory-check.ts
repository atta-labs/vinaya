#!/usr/bin/env bun
/**
 * This repository's test inventory: every executable test it holds, the
 * native runner that runs it, and every input a test reads beyond its own
 * imports — read from `scripts/test-suites/inventory.json` and checked
 * against the tree itself.
 *
 * The universe is `git ls-files -z` matched against the test-shaped names
 * the native runners collect (`bun test`'s `*.test.*`, `*_test.*`,
 * `*.spec.*`, `*_spec.*`; Vitest's `*.{test,spec}.*`). Each such file is
 * owned by exactly one suite, by what that suite's own runner would collect:
 * a Bun suite every test-shaped file under its working directory, a Vitest
 * suite what its configuration's `include` keeps and `exclude` drops, the
 * repository suite only the files it lists. The runner, working directory,
 * preload and environment are read from each suite's `package.json` `test`
 * script, `bunfig.toml` and `vitest.config.*` — as text and syntax, never
 * executed — and must agree with what the inventory declares. A test-shaped
 * file under a `fixtures/` folder is either a declared fixture executable (a
 * real test a runner collects) or an exclusion no runner collects. Missing,
 * unclassified and duplicate entries are problems, and the check fails on any.
 *
 * Beside the tests the inventory is one versioned store of input edges: each
 * edge names an input path, the tests that read it and how they read it —
 * `code` (it runs: an import, a preload, a spawned program), `raw-bytes`
 * (any byte change matters), `semantic` (the parsed whole, so formatting
 * alone does not), `parsed-keys` (named key domains only) or
 * `schema-policy` (a schema or policy consumer, mandatory on any change).
 * Lists another module already owns — the sandbox suite's inputs, the
 * folder-scanning tests' declarations — are referenced and read from that
 * module's syntax, never copied; one that cannot be read that way is opaque
 * and keeps a scoped, explained fallback. Governance policy (what must run
 * whatever changed) is a separate list from dependency data.
 *
 * Every view is per revision: the base is read from the base tree's own
 * inventory, so a candidate's declarations never stand in for a base that
 * had none, and edges that exist only at the base — a deleted helper, an
 * import the head removed — still name their readers. No forge is read, no
 * candidate code is run, and nothing here records whether a test passed.
 *
 *   bun scripts/test-suites/inventory-check.ts             check the working tree; exit 1 on any problem
 *   bun scripts/test-suites/inventory-check.ts --base <rev>  also build and report the base view
 *   bun scripts/test-suites/inventory-check.ts --root-tests  print the repository suite's tests, one per line
 *   bun scripts/test-suites/inventory-check.ts --layout      print the workspace layout the CI selection can read
 *   bun scripts/test-suites/inventory-check.ts --json        print the validated inventory as JSON
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'
import { extractImportSpecifiers, resolveRelativeImport, testRunnerOf } from '../../apps/cli/src/lib/test-selector.ts'

/** The schema this file reads and every view it produces declares. */
export const INVENTORY_SCHEMA = 'vinaya.test-inventory'
export const INVENTORY_SCHEMA_VERSION = 1
/** Where the declarations live, repository-relative. */
export const INVENTORY_PATH = 'scripts/test-suites/inventory.json'

// ── Declarations (what `inventory.json` holds) ─────────────────────────────

export type NativeRunner = 'bun' | 'vitest'
export type ReaderKind = 'code' | 'raw-bytes' | 'semantic' | 'parsed-keys' | 'schema-policy'
export type EdgeKind =
  | 'import'
  | 'preload'
  | 'runner-config'
  | 'lockfile'
  | 'fixture'
  | 'schema'
  | 'doc'
  | 'config'
  | 'spawn'
  | 'scan'
  | 'provider'

export type SuiteDeclaration = {
  id: string
  /** The package name that owns the suite, or `repository` for the root suite. */
  owner: string
  kind: 'workspace' | 'repository'
  /** Repository-relative directory: the workspace member, `.` for the repository suite. */
  dir: string
  runner: NativeRunner
  /** Repository-relative preload the runner loads before every test, or `null`. */
  preload: string | null
  /** The repository suite's tests, explicitly. A workspace suite lists none: its runner collects them. */
  tests?: string[]
  /** Test-shaped files under a `fixtures/` folder that the runner collects and that are real tests. */
  fixtureExecutables?: string[]
  /** The member's folders the selector models, when they are not `src/` and `tests/`. */
  sourceRoots?: string[]
}

export type ReaderDeclaration = {
  kind: ReaderKind
  /** For `parsed-keys`: dotted key paths whose values the readers read. */
  keys?: string[]
  /** Test paths or globs. */
  tests?: string[]
  /** Suite ids: every test of the suite reads it. */
  suites?: string[]
}

export type InputDeclaration = {
  id: string
  kind: EdgeKind
  /** Repository-relative files, or folders ending in `/`. */
  paths: string[]
  format?: 'json' | 'toml' | 'text'
  readers: ReaderDeclaration[]
  /** Required when `readers` is empty: why nothing reads it. Checked against scanner and policy duties. */
  noReader?: { reason: string }
  reason: string
}

export type ProviderDeclaration = {
  id: string
  kind: EdgeKind
  /** Repository-relative module that owns the list. */
  file: string
  /** The exported constant holding it. */
  export: string
  /**
   * `path-list` — an array of repository paths (folders end in `/`), read by
   * the `readers` given here; `scanner-declarations` — objects with `test`,
   * `roots` and `trigger`, each test reading its own roots.
   */
  shape: 'path-list' | 'scanner-declarations'
  readers?: ReaderDeclaration[]
  reason: string
}

export type PolicyDeclaration = {
  id: string
  kind: 'always-run' | 'mandatory' | 'security' | 'oracle'
  /** Repository paths, folders ending in `/`, or `path#key.path` configuration domains. */
  inputs: string[]
  duty: string
  source: string
}

export type InventoryDeclarations = {
  schema: string
  schemaVersion: number
  declarationVersion: number
  suites: SuiteDeclaration[]
  typeInputs: { path: string; role: string }[]
  exclusions: { path: string; reason: string }[]
  inputs: InputDeclaration[]
  providers: ProviderDeclaration[]
  policies: PolicyDeclaration[]
  unknowns: { scope: string; reason: string }[]
}

// ── Views (what a reader gets back) ────────────────────────────────────────

export type SuiteFacts = {
  id: string
  owner: string
  kind: SuiteDeclaration['kind']
  dir: string
  cwd: string
  runner: NativeRunner
  preload: string | null
  environment: Record<string, string | number | boolean>
  /** Repository-relative files the runner facts were read from. */
  configFiles: string[]
  include: string[]
  exclude: string[]
  /** The member's folders the selector models, when the suite declares them. */
  sourceRoots?: string[]
}

export type TestIdentity = {
  /** Repository-relative path: the stable identity. */
  id: string
  suite: string
  owner: string
  kind: SuiteDeclaration['kind']
  runner: NativeRunner
  cwd: string
  preload: string | null
  environment: SuiteFacts['environment']
}

export type ResolvedEdge = {
  /** Repository-relative file, or folder ending in `/`. */
  input: string
  kind: EdgeKind
  readerKind: ReaderKind
  /** For `parsed-keys`. */
  keys?: string[]
  format?: InputDeclaration['format']
  /** Test identities. */
  readers: string[]
  /** The declaration, provider or suite the edge came from. */
  source: string
}

export type InventoryProblem = {
  code:
    | 'unmodeled'
    | 'schema'
    | 'missing'
    | 'unclassified'
    | 'duplicate'
    | 'runner-mismatch'
    | 'unreadable'
    | 'unproven-no-reader'
  path: string
  detail: string
}

export type UnknownScope = { scope: string; reason: string }

export type InventoryView = {
  revision: string
  /** Whether this revision carries its own inventory declarations. */
  modeled: boolean
  schemaIdentity: string
  declarationVersion: number | null
  /** Hash of this revision's declarations, or `null` when it has none. */
  declarationIdentity: string | null
  /** The semantic verification context: schema, declarations and runner facts — not the file listing. */
  contextIdentity: string
  /** The generated graph for this revision: tests, edges and unknowns as resolved. */
  graphIdentity: string
  workspaces: string[]
  suites: SuiteFacts[]
  tests: TestIdentity[]
  exclusions: { path: string; reason: string }[]
  typeInputs: { path: string; role: string }[]
  edges: ResolvedEdge[]
  unknowns: UnknownScope[]
  policies: PolicyDeclaration[]
  problems: InventoryProblem[]
}

export type TestInventory = {
  schema: typeof INVENTORY_SCHEMA
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION
  head: InventoryView
  base: InventoryView | null
}

/** A head view with problems: the inventory does not validate. */
export class InventoryError extends Error {
  constructor(readonly problems: readonly InventoryProblem[]) {
    super(
      `the test inventory does not validate:\n${problems.map((p) => `  ${p.code} ${p.path}: ${p.detail}`).join('\n')}`
    )
  }
}

// ── Trees ──────────────────────────────────────────────────────────────────

/** One revision's files, read without running anything in it. */
export type TreeReader = {
  revision: string
  list(): readonly string[]
  read(path: string): string | null
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1 << 28
  })
}

/** The working tree: tracked paths from `git ls-files -z`, contents from disk. */
export function worktreeReader(repoRoot: string): TreeReader {
  let listed: string[] | null = null
  return {
    revision: 'worktree',
    list: () => {
      listed ??= git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean)
      return listed
    },
    read: (path) => {
      try {
        return readFileSync(join(repoRoot, path), 'utf8')
      } catch {
        return null
      }
    }
  }
}

/** A committed revision, read through `git ls-tree` and `git show` only. */
export function revisionReader(repoRoot: string, rev: string): TreeReader {
  let listed: string[] | null = null
  const cache = new Map<string, string | null>()
  return {
    revision: rev,
    list: () => {
      listed ??= git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', rev]).split('\0').filter(Boolean)
      return listed
    },
    read: (path) => {
      if (!cache.has(path)) {
        try {
          cache.set(path, git(repoRoot, ['show', `${rev}:${path}`]))
        } catch {
          cache.set(path, null)
        }
      }
      return cache.get(path) ?? null
    }
  }
}

/** An in-memory tree, for fixtures. */
export function memoryReader(revision: string, files: Readonly<Record<string, string>>): TreeReader {
  const listed = Object.keys(files).sort()
  return { revision, list: () => listed, read: (path) => files[path] ?? null }
}

// ── Small readers ──────────────────────────────────────────────────────────

/** A glob as a regular expression: `**​/` any folders (or none), `*` within one segment, `?`, `{a,b}`. */
export function globRegex(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const close = glob.indexOf('}', i)
      if (close < 0) re += '\\{'
      else {
        re += `(?:${glob
          .slice(i + 1, close)
          .split(',')
          .map((alt) => globRegex(alt).source.slice(1, -1))
          .join('|')})`
        i = close
      }
    } else re += /[.+^$|()[\]\\]/.test(c) ? `\\${c}` : c
  }
  return new RegExp(`${re}$`)
}

/** File names `bun test` collects by default. */
const BUN_TEST_NAME = /(\.|_)(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/
/** The union of every native runner's test-shaped names: the universe the check classifies. */
const TEST_SHAPED_NAME = /(\.|_)(test|spec)\.(c|m)?[jt]sx?$/
/** What Vitest leaves out unless a configuration says otherwise. */
const VITEST_DEFAULT_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)']
const VITEST_DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**']

function vitestIncludes(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern === VITEST_DEFAULT_INCLUDE[0] ? TEST_SHAPED_NAME.test(path) : globRegex(pattern).test(path)
  )
}

function under(path: string, dir: string): boolean {
  return dir === '.' || path.startsWith(`${dir}/`)
}

function relativeTo(dir: string, path: string): string {
  return dir === '.' ? path : path.slice(dir.length + 1)
}

/** Resolves a path written relative to `dir` to a repository-relative one. */
function resolveIn(dir: string, written: string): string {
  return posix.normalize(posix.join(dir, written)).replace(/^\.\//, '')
}

function matchesInput(input: string, path: string): boolean {
  return input.endsWith('/') ? path.startsWith(input) : path === input
}

/**
 * Whether an edge's input covers `path`. A scan root is a prefix as its
 * declaration writes it — a folder, a file, or a file-name prefix — and `.`
 * is the whole repository.
 */
function edgeCovers(edge: ResolvedEdge, path: string): boolean {
  if (edge.kind === 'scan') return edge.input === '.' || path.startsWith(edge.input)
  return matchesInput(edge.input, path)
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

/** JSON with object keys sorted, so equal values hash equally. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function parseToml(text: string): Record<string, unknown> | null {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function parseByFormat(text: string, format: InputDeclaration['format']): { ok: true; value: unknown } | { ok: false } {
  if (format === 'json') {
    try {
      return { ok: true, value: JSON.parse(text) }
    } catch {
      return { ok: false }
    }
  }
  if (format === 'toml') {
    const parsed = parseToml(text)
    return parsed ? { ok: true, value: parsed } : { ok: false }
  }
  return { ok: true, value: text }
}

/** The script's own `--timeout=N` / `--preload <p>` flags, read as text. */
function scriptFlags(script: string): { timeoutMs?: number; preload?: string } {
  const timeout = /--timeout[= ](\d+)/.exec(script)?.[1]
  const preload = /--preload[= ](\S+)/.exec(script)?.[1]
  return { ...(timeout ? { timeoutMs: Number(timeout) } : {}), ...(preload ? { preload } : {}) }
}

/**
 * A Vitest configuration's `test` options, read from its syntax: string-array
 * `include`/`exclude`/`setupFiles`, a boolean `globals`, and whether the
 * Workers pool wraps it. `null` for a value written in a shape this cannot
 * prove, so the caller reports it rather than guessing.
 */
function readVitestConfig(
  text: string,
  file: string
): {
  include: string[] | null
  exclude: string[] | null
  setupFiles: string[] | null
  environment: Record<string, string | number | boolean>
} {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out = {
    include: [] as string[] | null,
    exclude: [] as string[] | null,
    setupFiles: [] as string[] | null,
    environment: {} as Record<string, string | number | boolean>
  }
  let sawInclude = false
  let sawExclude = false
  const strings = (node: ts.Expression): string[] | null => {
    if (!ts.isArrayLiteralExpression(node)) return null
    const values: string[] = []
    for (const element of node.elements) {
      if (!ts.isStringLiteralLike(element)) return null
      values.push(element.text)
    }
    return values
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineWorkersConfig')
      out.environment.pool = 'cloudflare-workers'
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      if (name === 'include' && ts.isObjectLiteralExpression(node.parent)) {
        sawInclude = true
        out.include = strings(node.initializer)
      } else if (name === 'exclude' && ts.isObjectLiteralExpression(node.parent)) {
        sawExclude = true
        out.exclude = strings(node.initializer)
      } else if (name === 'setupFiles') {
        out.setupFiles = ts.isStringLiteralLike(node.initializer) ? [node.initializer.text] : strings(node.initializer)
      } else if (name === 'globals' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        out.environment.globals = true
      } else if (name === 'environment' && ts.isStringLiteralLike(node.initializer)) {
        out.environment.environment = node.initializer.text
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!sawInclude) out.include = [...VITEST_DEFAULT_INCLUDE]
  if (!sawExclude) out.exclude = [...VITEST_DEFAULT_EXCLUDE]
  return out
}

/**
 * The string list an exported constant holds, read from the module's syntax:
 * string literals, and `...NAME` spreads of other constants in the same
 * module, `as const` and type annotations allowed. `null` when any element
 * is a shape this cannot prove.
 */
function readExportedPathList(text: string, file: string, name: string): string[] | null {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const consts = new Map<string, ts.Expression>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations)
      if (ts.isIdentifier(decl.name) && decl.initializer) consts.set(decl.name.text, decl.initializer)
  }
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
      ? unwrap(node.expression)
      : node
  const read = (node: ts.Expression, seen: Set<string>): string[] | null => {
    const inner = unwrap(node)
    if (!ts.isArrayLiteralExpression(inner)) return null
    const out: string[] = []
    for (const element of inner.elements) {
      const literal = ts.isSpreadElement(element) ? null : staticString(element)
      if (literal !== null) out.push(literal)
      else if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
        const target = element.expression.text
        const value = consts.get(target)
        if (!value || seen.has(target)) return null
        const spread = read(value, new Set([...seen, target]))
        if (!spread) return null
        out.push(...spread)
      } else return null
    }
    return out
  }
  const initializer = consts.get(name)
  return initializer ? read(initializer, new Set([name])) : null
}

/** A string written as a literal, or as a template whose every substitution is itself a string literal; `null` otherwise. */
function staticString(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (!ts.isTemplateExpression(node)) return null
  let out = node.head.text
  for (const span of node.templateSpans) {
    if (!ts.isStringLiteralLike(span.expression)) return null
    out += span.expression.text + span.literal.text
  }
  return out
}

/** The `{ test, roots, trigger }` objects an exported constant holds, read from syntax; `null` on any unprovable shape. */
function readExportedScannerDeclarations(
  text: string,
  file: string,
  name: string
): { test: string; roots: string[]; trigger: string }[] | null {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let initializer: ts.Expression | undefined
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations)
      if (ts.isIdentifier(decl.name) && decl.name.text === name) initializer = decl.initializer
  }
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) return null
  const out: { test: string; roots: string[]; trigger: string }[] = []
  for (const element of initializer.elements) {
    if (!ts.isObjectLiteralExpression(element)) return null
    const fields = new Map<string, ts.Expression>()
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) return null
      fields.set(property.name.text, property.initializer)
    }
    const test = fields.get('test')
    const trigger = fields.get('trigger')
    const roots = fields.get('roots')
    const testPath = test ? staticString(test) : null
    const triggerName = trigger ? staticString(trigger) : null
    if (testPath === null || triggerName === null) return null
    if (!roots || !ts.isArrayLiteralExpression(roots)) return null
    const rootPaths = roots.elements.map(staticString)
    if (rootPaths.some((r) => r === null)) return null
    out.push({ test: testPath, trigger: triggerName, roots: rootPaths as string[] })
  }
  return out
}

/** The workspace patterns a root manifest declares, expanded over a tree's own directories. */
function workspaceMembers(tree: TreeReader, files: readonly string[]): string[] {
  let patterns: string[] = []
  try {
    const manifest = JSON.parse(tree.read('package.json') ?? '') as { workspaces?: string[] | { packages?: string[] } }
    patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? [])
  } catch {
    return []
  }
  const manifests = files.filter((f) => f.endsWith('/package.json')).map((f) => f.slice(0, -'/package.json'.length))
  const out: string[] = []
  for (const pattern of patterns) {
    const negate = pattern.startsWith('!')
    const re = globRegex((negate ? pattern.slice(1) : pattern).replace(/^\.\//, '').replace(/\/+$/, ''))
    const hits = manifests.filter((dir) => re.test(dir))
    if (negate) {
      for (const hit of hits) if (out.includes(hit)) out.splice(out.indexOf(hit), 1)
    } else for (const hit of hits.sort()) if (!out.includes(hit)) out.push(hit)
  }
  return out.filter((dir) => {
    try {
      return Boolean((JSON.parse(tree.read(`${dir}/package.json`) ?? '') as { name?: string }).name)
    } catch {
      return false
    }
  })
}

// ── Building a view ────────────────────────────────────────────────────────

export type ViewOptions = {
  /**
   * Also resolve every test's relative import closure (the selector's own
   * import reader and resolver) into `import` edges. Off by default: the
   * selector itself walks imports, and the check needs only the declared edges.
   */
  imports?: boolean
}

function emptyView(tree: TreeReader, problems: InventoryProblem[], unknowns: UnknownScope[]): InventoryView {
  const view: InventoryView = {
    revision: tree.revision,
    modeled: false,
    schemaIdentity: `${INVENTORY_SCHEMA}@${INVENTORY_SCHEMA_VERSION}`,
    declarationVersion: null,
    declarationIdentity: null,
    contextIdentity: '',
    graphIdentity: '',
    workspaces: [],
    suites: [],
    tests: [],
    exclusions: [],
    typeInputs: [],
    edges: [],
    unknowns,
    policies: [],
    problems
  }
  view.contextIdentity = hash({ schema: view.schemaIdentity, declarations: null })
  view.graphIdentity = hash({ unknowns })
  return view
}

/** Builds one revision's inventory view from that revision's own files. */
export function buildInventoryView(tree: TreeReader, options: ViewOptions = {}): InventoryView {
  const files = tree.list()
  const fileSet = new Set(files)
  const problems: InventoryProblem[] = []
  const unknowns: UnknownScope[] = []
  const problem = (code: InventoryProblem['code'], path: string, detail: string) =>
    problems.push({ code, path, detail })

  const raw = tree.read(INVENTORY_PATH)
  if (raw === null) {
    return emptyView(
      tree,
      [{ code: 'unmodeled', path: INVENTORY_PATH, detail: 'this revision carries no inventory declarations' }],
      [
        {
          scope: '.',
          reason: 'this revision carries no inventory declarations, so none of its tests or inputs is modeled'
        }
      ]
    )
  }
  let declarations: InventoryDeclarations
  try {
    declarations = JSON.parse(raw) as InventoryDeclarations
  } catch (err) {
    return emptyView(
      tree,
      [{ code: 'schema', path: INVENTORY_PATH, detail: `not JSON: ${(err as Error).message}` }],
      [{ scope: '.', reason: 'the inventory declarations do not parse' }]
    )
  }
  if (declarations.schema !== INVENTORY_SCHEMA || declarations.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
    return emptyView(
      tree,
      [
        {
          code: 'schema',
          path: INVENTORY_PATH,
          detail: `declares ${declarations.schema}@${declarations.schemaVersion}, this reader reads ${INVENTORY_SCHEMA}@${INVENTORY_SCHEMA_VERSION}`
        }
      ],
      [{ scope: '.', reason: 'the inventory declares a schema this reader does not read' }]
    )
  }
  for (const key of ['suites', 'typeInputs', 'exclusions', 'inputs', 'providers', 'policies', 'unknowns'] as const) {
    if (!Array.isArray(declarations[key])) {
      problem('schema', INVENTORY_PATH, `${key} is not a list`)
      ;(declarations as Record<string, unknown>)[key] = []
    }
  }
  unknowns.push(...declarations.unknowns)

  // Lists must not repeat an entry, and every path they name must exist.
  const duplicatesIn = (where: string, values: readonly string[]) => {
    const seen = new Set<string>()
    for (const value of values) {
      if (seen.has(value)) problem('duplicate', value, `listed twice in ${where}`)
      seen.add(value)
    }
  }
  const exists = (path: string) => (path.endsWith('/') ? files.some((f) => f.startsWith(path)) : fileSet.has(path))
  duplicatesIn(
    'suites',
    declarations.suites.map((s) => s.id)
  )
  duplicatesIn(
    'exclusions',
    declarations.exclusions.map((e) => e.path)
  )
  duplicatesIn(
    'inputs',
    declarations.inputs.map((i) => i.id)
  )
  duplicatesIn(
    'providers',
    declarations.providers.map((p) => p.id)
  )
  duplicatesIn(
    'policies',
    declarations.policies.map((p) => p.id)
  )

  // ── Workspace members, each claimed by a suite or a type input.
  const workspaces = workspaceMembers(tree, files)
  for (const member of workspaces) {
    const claimed =
      declarations.suites.some((s) => s.dir === member) || declarations.typeInputs.some((t) => t.path === member)
    if (!claimed) problem('unclassified', member, 'workspace member has neither a suite nor a type-input entry')
  }
  for (const input of declarations.typeInputs) {
    if (!exists(input.path) && !fileSet.has(`${input.path}/package.json`))
      problem('missing', input.path, 'type input is not in the tree')
  }

  // ── Suites: runner facts read from each suite's own configuration.
  const suites: SuiteFacts[] = []
  for (const decl of declarations.suites) {
    const dir = decl.dir
    const configFiles: string[] = []
    const environment: SuiteFacts['environment'] = {}
    let runner: NativeRunner | null = null
    let preload: string | null = null
    let include: string[] = []
    let exclude: string[] = []
    if (decl.kind === 'workspace') {
      const manifestPath = `${dir}/package.json`
      const manifestText = tree.read(manifestPath)
      if (manifestText === null) {
        problem('missing', manifestPath, `suite ${decl.id} names a workspace member with no manifest`)
        continue
      }
      configFiles.push(manifestPath)
      let script: string | undefined
      try {
        script = (JSON.parse(manifestText) as { scripts?: { test?: string } }).scripts?.test
      } catch {
        problem('unreadable', manifestPath, 'the manifest is not JSON')
        continue
      }
      const read = testRunnerOf(script)
      if (read !== 'bun' && read !== 'vitest') {
        problem(
          'unreadable',
          manifestPath,
          `suite ${decl.id}: the test script ${JSON.stringify(script ?? null)} names no native runner this reads`
        )
        continue
      }
      runner = read
      const flags = scriptFlags(script ?? '')
      if (flags.timeoutMs !== undefined) environment.timeoutMs = flags.timeoutMs
      if (flags.preload) preload = resolveIn(dir, flags.preload)
    } else {
      runner = 'bun'
    }
    if (runner === 'bun') {
      const bunfigPath = dir === '.' ? 'bunfig.toml' : `${dir}/bunfig.toml`
      const bunfigText = tree.read(bunfigPath)
      if (bunfigText !== null) {
        configFiles.push(bunfigPath)
        const parsed = parseToml(bunfigText)
        if (!parsed) problem('unreadable', bunfigPath, 'bunfig.toml does not parse')
        const table = (parsed?.test ?? {}) as { preload?: string | string[]; timeout?: number; root?: string }
        const preloads = typeof table.preload === 'string' ? [table.preload] : (table.preload ?? [])
        if (preloads.length > 1)
          environment.extraPreloads = preloads
            .slice(1)
            .map((p) => resolveIn(dir, p))
            .join(',')
        if (preloads[0] && !preload) preload = resolveIn(dir, preloads[0])
        if (typeof table.timeout === 'number' && environment.timeoutMs === undefined)
          environment.timeoutMs = table.timeout
        if (typeof table.root === 'string') environment.root = resolveIn(dir, table.root)
      }
      include =
        decl.kind === 'repository' ? [...(decl.tests ?? [])] : ['**/*{.,_}{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}']
    } else {
      const configPath = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs']
        .map((name) => `${dir}/${name}`)
        .find((path) => fileSet.has(path))
      if (configPath) {
        configFiles.push(configPath)
        const config = readVitestConfig(tree.read(configPath) ?? '', configPath)
        if (!config.include || !config.exclude || !config.setupFiles) {
          problem('unreadable', configPath, `suite ${decl.id}: include, exclude or setupFiles is not a literal list`)
          continue
        }
        include = config.include
        exclude = config.exclude
        Object.assign(environment, config.environment)
        if (config.setupFiles.length > 0) preload = resolveIn(dir, config.setupFiles[0] as string)
        if (config.setupFiles.length > 1)
          environment.extraPreloads = config.setupFiles
            .slice(1)
            .map((p) => resolveIn(dir, p))
            .join(',')
      } else {
        include = [...VITEST_DEFAULT_INCLUDE]
        exclude = [...VITEST_DEFAULT_EXCLUDE]
      }
      // A Bun guard a Vitest suite keeps against being run under `bun test`
      // is recorded as what it is, never as this suite's own preload.
      const guardText = tree.read(`${dir}/bunfig.toml`)
      if (guardText !== null) {
        configFiles.push(`${dir}/bunfig.toml`)
        const guard = (parseToml(guardText)?.test as { preload?: string } | undefined)?.preload
        if (typeof guard === 'string') environment.bunGuardPreload = resolveIn(dir, guard)
      }
    }
    if (runner !== decl.runner)
      problem('runner-mismatch', dir, `suite ${decl.id} declares ${decl.runner}, its configuration runs ${runner}`)
    if (preload !== decl.preload)
      problem(
        'runner-mismatch',
        dir,
        `suite ${decl.id} declares preload ${decl.preload}, its configuration loads ${preload}`
      )
    if (preload && !fileSet.has(preload)) problem('missing', preload, `suite ${decl.id}'s preload is not in the tree`)
    suites.push({
      id: decl.id,
      owner: decl.owner,
      kind: decl.kind,
      dir,
      cwd: dir,
      runner,
      preload,
      environment,
      configFiles,
      include,
      exclude,
      ...(decl.sourceRoots ? { sourceRoots: [...decl.sourceRoots] } : {})
    })
  }

  // ── The test universe and its owners.
  const declById = new Map(declarations.suites.map((s) => [s.id, s]))
  const excluded = new Map(declarations.exclusions.map((e) => [e.path, e.reason]))
  for (const decl of declarations.suites) {
    duplicatesIn(`suite ${decl.id}'s tests`, decl.tests ?? [])
    duplicatesIn(`suite ${decl.id}'s fixture executables`, decl.fixtureExecutables ?? [])
    for (const path of [...(decl.tests ?? []), ...(decl.fixtureExecutables ?? [])])
      if (!fileSet.has(path)) problem('missing', path, `suite ${decl.id} lists a test that is not in the tree`)
  }
  for (const [path] of excluded)
    if (!fileSet.has(path)) problem('missing', path, 'an exclusion names a file that is not in the tree')

  const collects = (suite: SuiteFacts, path: string): boolean => {
    if (suite.kind === 'repository') return suite.include.includes(path)
    if (!under(path, suite.dir)) return false
    const inside = relativeTo(suite.dir, path)
    if (/(^|\/)node_modules\//.test(inside)) return false
    if (suite.runner === 'bun') {
      const root = suite.environment.root
      if (typeof root === 'string' && !under(path, root)) return false
      return BUN_TEST_NAME.test(path)
    }
    return vitestIncludes(inside, suite.include) && !suite.exclude.some((pattern) => globRegex(pattern).test(inside))
  }

  const tests: TestIdentity[] = []
  const exclusions: InventoryView['exclusions'] = []
  for (const path of files) {
    if (!TEST_SHAPED_NAME.test(path)) continue
    const owners = suites.filter((suite) => collects(suite, path))
    const inFixtures = /(^|\/)fixtures\//.test(path)
    if (excluded.has(path)) {
      if (owners.length > 0)
        problem(
          'unclassified',
          path,
          `excluded as fixture data, yet suite ${owners.map((o) => o.id).join(', ')}'s runner collects it`
        )
      exclusions.push({ path, reason: excluded.get(path) as string })
      continue
    }
    if (owners.length === 0) {
      problem('unclassified', path, 'test-shaped, but no suite runs it and no exclusion names it')
      continue
    }
    if (owners.length > 1) {
      problem('duplicate', path, `collected by more than one suite: ${owners.map((o) => o.id).join(', ')}`)
      continue
    }
    const owner = owners[0] as SuiteFacts
    if (inFixtures && !(declById.get(owner.id)?.fixtureExecutables ?? []).includes(path)) {
      problem(
        'unclassified',
        path,
        `test-shaped file under a fixtures folder that suite ${owner.id}'s runner collects: declare it a fixture executable or exclude it from the runner`
      )
      continue
    }
    tests.push({
      id: path,
      suite: owner.id,
      owner: owner.owner,
      kind: owner.kind,
      runner: owner.runner,
      cwd: owner.cwd,
      preload: owner.preload,
      environment: owner.environment
    })
  }
  const testIds = new Set(tests.map((t) => t.id))
  const testsOf = (suiteId: string) => tests.filter((t) => t.suite === suiteId).map((t) => t.id)

  // ── Edges.
  const edges: ResolvedEdge[] = []
  const resolveReaders = (
    readers: readonly ReaderDeclaration[] | undefined,
    where: string
  ): Map<ReaderDeclaration, string[]> => {
    const out = new Map<ReaderDeclaration, string[]>()
    for (const reader of readers ?? []) {
      const ids = new Set<string>()
      for (const suiteId of reader.suites ?? []) {
        if (!declById.has(suiteId)) problem('missing', where, `reader suite ${suiteId} is not declared`)
        for (const id of testsOf(suiteId)) ids.add(id)
      }
      for (const pattern of reader.tests ?? []) {
        const hits = pattern.includes('*') ? [...testIds].filter((id) => globRegex(pattern).test(id)) : [pattern]
        if (hits.length === 0 || hits.some((id) => !testIds.has(id)))
          problem('missing', where, `reader ${pattern} is not a test in this inventory`)
        for (const id of hits) if (testIds.has(id)) ids.add(id)
      }
      if (reader.kind === 'parsed-keys' && !(reader.keys && reader.keys.length > 0))
        problem('schema', where, 'a parsed-keys reader names no key domain')
      out.set(reader, [...ids].sort())
    }
    return out
  }

  for (const suite of suites) {
    const suiteTests = testsOf(suite.id)
    if (suite.preload)
      edges.push({
        input: suite.preload,
        kind: 'preload',
        readerKind: 'code',
        readers: suiteTests,
        source: `suite:${suite.id}`
      })
    for (const extra of String(suite.environment.extraPreloads ?? '')
      .split(',')
      .filter(Boolean))
      edges.push({
        input: extra,
        kind: 'preload',
        readerKind: 'code',
        readers: suiteTests,
        source: `suite:${suite.id}`
      })
    for (const config of suite.configFiles) {
      const format = config.endsWith('.json') ? 'json' : config.endsWith('.toml') ? 'toml' : undefined
      edges.push({
        input: config,
        kind: 'runner-config',
        readerKind: format ? 'semantic' : 'code',
        ...(format ? { format } : {}),
        readers: suiteTests,
        source: `suite:${suite.id}`
      })
    }
  }

  for (const input of declarations.inputs) {
    for (const path of input.paths)
      if (!exists(path)) problem('missing', path, `input ${input.id} names a path that is not in the tree`)
    const resolved = resolveReaders(input.readers, input.id)
    for (const [reader, ids] of resolved) {
      for (const path of input.paths)
        edges.push({
          input: path,
          kind: input.kind,
          readerKind: reader.kind,
          ...(reader.keys ? { keys: reader.keys } : {}),
          ...(input.format ? { format: input.format } : {}),
          readers: ids,
          source: input.id
        })
    }
  }

  const scannerDuties: { test: string; roots: string[] }[] = []
  for (const provider of declarations.providers) {
    const text = tree.read(provider.file)
    if (text === null) {
      problem('missing', provider.file, `provider ${provider.id}'s module is not in the tree`)
      unknowns.push({ scope: provider.file, reason: `provider ${provider.id} cannot be read: its module is missing` })
      continue
    }
    if (provider.shape === 'path-list') {
      const paths = readExportedPathList(text, provider.file, provider.export)
      if (!paths) {
        unknowns.push({
          scope: provider.file,
          reason: `provider ${provider.id}: ${provider.export} is not a literal path list, so its inputs stay opaque`
        })
        continue
      }
      const resolved = resolveReaders(provider.readers, provider.id)
      for (const path of paths) {
        if (!exists(path)) problem('missing', path, `provider ${provider.id} names a path that is not in the tree`)
        for (const [reader, ids] of resolved)
          edges.push({
            input: path,
            kind: provider.kind,
            readerKind: reader.kind,
            readers: ids,
            source: `provider:${provider.id}`
          })
      }
    } else {
      const declared = readExportedScannerDeclarations(text, provider.file, provider.export)
      if (!declared) {
        unknowns.push({
          scope: provider.file,
          reason: `provider ${provider.id}: ${provider.export} is not a literal declaration list, so its scan edges stay opaque`
        })
        continue
      }
      for (const scanner of declared) {
        if (!testIds.has(scanner.test)) continue // another repository's declaration, or a test this tree no longer has.
        scannerDuties.push({ test: scanner.test, roots: scanner.roots })
        for (const root of scanner.roots)
          edges.push({
            input: root,
            kind: 'scan',
            readerKind: 'raw-bytes',
            readers: [scanner.test],
            source: `provider:${provider.id}`
          })
      }
    }
  }

  // An input declared with no reader must say why, and the claim may not
  // erase a scanner's or a policy's duty over that path.
  for (const input of declarations.inputs) {
    if (input.readers.length > 0) continue
    if (!input.noReader?.reason) {
      problem('unproven-no-reader', input.id, 'declares no reader and gives no reason')
      continue
    }
    for (const path of input.paths) {
      const scanner = scannerDuties.find((duty) =>
        duty.roots.some((root) => root === '.' || path.startsWith(root) || root.startsWith(path))
      )
      if (scanner) problem('unproven-no-reader', input.id, `claims no reader for ${path}, which ${scanner.test} scans`)
      const policy = declarations.policies.find(
        (p) =>
          (p.kind === 'security' || p.kind === 'mandatory') &&
          p.inputs.some((entry) => {
            const target = entry.split('#')[0] as string
            return (
              target === path ||
              (target.endsWith('/') && path.startsWith(target)) ||
              (path.endsWith('/') && target.startsWith(path))
            )
          })
      )
      if (policy)
        problem(
          'unproven-no-reader',
          input.id,
          `claims no reader for ${path}, a ${policy.kind} duty of policy ${policy.id}`
        )
    }
  }

  for (const policy of declarations.policies)
    for (const entry of policy.inputs) {
      const target = entry.split('#')[0] as string
      if (!exists(target)) problem('missing', target, `policy ${policy.id} names a path that is not in the tree`)
    }

  if (options.imports)
    edges.push(
      ...importEdges(
        tree,
        files,
        tests,
        edges.filter((e) => e.kind === 'spawn' && !e.input.endsWith('/'))
      )
    )

  // Merge edges that say the same thing about the same input.
  const merged = new Map<string, ResolvedEdge>()
  for (const edge of edges) {
    const key = stableJson([
      edge.input,
      edge.kind,
      edge.readerKind,
      edge.keys ?? null,
      edge.format ?? null,
      edge.source
    ])
    const prior = merged.get(key)
    if (prior) prior.readers = [...new Set([...prior.readers, ...edge.readers])].sort()
    else merged.set(key, { ...edge, readers: [...edge.readers].sort() })
  }
  const finalEdges = [...merged.values()].sort((a, b) => stableJson(a).localeCompare(stableJson(b)))

  const schemaIdentity = `${INVENTORY_SCHEMA}@${INVENTORY_SCHEMA_VERSION}`
  const declarationIdentity = hash(declarations)
  const contextIdentity = hash({
    schemaIdentity,
    declarationIdentity,
    suites: suites.map(({ id, runner, cwd, preload, environment, include, exclude }) => ({
      id,
      runner,
      cwd,
      preload,
      environment,
      include,
      exclude
    }))
  })
  const graphIdentity = hash({ contextIdentity, tests, edges: finalEdges, unknowns, exclusions })
  return {
    revision: tree.revision,
    modeled: true,
    schemaIdentity,
    declarationVersion: declarations.declarationVersion,
    declarationIdentity,
    contextIdentity,
    graphIdentity,
    workspaces,
    suites,
    tests,
    exclusions,
    typeInputs: declarations.typeInputs,
    edges: finalEdges,
    unknowns,
    policies: declarations.policies,
    problems
  }
}

/**
 * Every test's relative import closure as `import` edges, read with the
 * selector's own text reader and resolver over the revision's tracked files —
 * the same over-approximation the selector falls back to, so an edge it
 * reports is never narrower than the compiler's.
 */
function importEdges(
  tree: TreeReader,
  files: readonly string[],
  tests: readonly TestIdentity[],
  spawned: readonly ResolvedEdge[]
): ResolvedEdge[] {
  const closure = importClosure(tree, files)
  const readersOf = new Map<string, Set<string>>()
  for (const test of tests) {
    for (const dep of closure(test.id)) {
      const readers = readersOf.get(dep) ?? new Set<string>()
      readersOf.set(dep, readers)
      readers.add(test.id)
    }
  }
  const out: ResolvedEdge[] = [...readersOf].map(([input, readers]) => ({
    input,
    kind: 'import' as const,
    readerKind: 'code' as const,
    readers: [...readers].sort(),
    source: 'imports'
  }))
  // A spawned program runs its own imports too, so its readers read them —
  // as imports: the files themselves stay ordinary, modeled source.
  for (const edge of spawned)
    for (const dep of closure(edge.input))
      out.push({
        input: dep,
        kind: 'import',
        readerKind: 'code',
        readers: edge.readers,
        source: `${edge.source} (imports)`
      })
  return out
}

/** A file's relative import closure, repository-relative, through the selector's text reader and resolver. */
function importClosure(tree: TreeReader, files: readonly string[]): (start: string) => string[] {
  const ROOT = '/tree'
  const known = new Set(files.filter((f) => /\.(c|m)?[jt]sx?$/.test(f)).map((f) => `${ROOT}/${f}`))
  const direct = new Map<string, string[]>()
  const depsOf = (file: string): string[] => {
    let deps = direct.get(file)
    if (!deps) {
      deps = []
      const text = tree.read(file.slice(ROOT.length + 1)) ?? ''
      for (const specifier of extractImportSpecifiers(text)) {
        if (!specifier.startsWith('.')) continue
        const resolved = resolveRelativeImport(file, specifier, known)
        if (resolved) deps.push(resolved)
      }
      direct.set(file, deps)
    }
    return deps
  }
  return (startPath) => {
    const start = `${ROOT}/${startPath}`
    if (!known.has(start)) return []
    const seen = new Set<string>([start])
    const stack = [start]
    while (stack.length > 0) {
      for (const dep of depsOf(stack.pop() as string)) {
        if (seen.has(dep)) continue
        seen.add(dep)
        stack.push(dep)
      }
    }
    seen.delete(start)
    return [...seen].map((dep) => dep.slice(ROOT.length + 1))
  }
}

// ── The validated API ──────────────────────────────────────────────────────

export type ReadOptions = ViewOptions & {
  /** A base revision to build a second view for. */
  base?: string
  /** The head: a revision, or the working tree (the default). */
  head?: string
}

/**
 * The repository's validated test inventory: the head view (the working tree
 * unless a revision is named) and, when asked, the base view built from the
 * base revision's own declarations. Throws {@link InventoryError} when the
 * head view has any problem; a base view's problems stay on it, since a base
 * may predate the inventory altogether — an unmodeled base is reported as
 * unmodeled, never filled in from the head's declarations.
 *
 * Trees may be passed directly instead of a repository root, for fixtures.
 */
export function readTestInventory(
  source: string | { head: TreeReader; base?: TreeReader },
  options: ReadOptions = {}
): TestInventory {
  const headTree =
    typeof source === 'string'
      ? options.head
        ? revisionReader(source, options.head)
        : worktreeReader(source)
      : source.head
  const baseTree =
    typeof source === 'string' ? (options.base ? revisionReader(source, options.base) : undefined) : source.base
  const head = buildInventoryView(headTree, options)
  if (head.problems.length > 0) throw new InventoryError(head.problems)
  return {
    schema: INVENTORY_SCHEMA,
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    head,
    base: baseTree ? buildInventoryView(baseTree, options) : null
  }
}

/** The view's tests grouped by how their native runner must start them — the unit a job plan schedules. */
export function nativeGroups(view: InventoryView): {
  suite: string
  runner: NativeRunner
  cwd: string
  preload: string | null
  environment: SuiteFacts['environment']
  tests: string[]
}[] {
  return view.suites.map((suite) => ({
    suite: suite.id,
    runner: suite.runner,
    cwd: suite.cwd,
    preload: suite.preload,
    environment: suite.environment,
    tests: view.tests.filter((t) => t.suite === suite.id).map((t) => t.id)
  }))
}

/** Test identities added, removed and renamed between two views; `renames` maps an old path to its new one, as `git diff -M` reports it. */
export function diffTestIdentities(
  base: InventoryView,
  head: InventoryView,
  renames: ReadonlyMap<string, string> = new Map()
): { added: string[]; removed: string[]; renamed: { from: string; to: string }[] } {
  const before = new Set(base.tests.map((t) => t.id))
  const after = new Set(head.tests.map((t) => t.id))
  const renamed = [...renames]
    .filter(([from, to]) => before.has(from) && after.has(to))
    .map(([from, to]) => ({ from, to }))
  const renamedFrom = new Set(renamed.map((r) => r.from))
  const renamedTo = new Set(renamed.map((r) => r.to))
  return {
    added: [...after].filter((id) => !before.has(id) && !renamedTo.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id) && !renamedFrom.has(id)).sort(),
    renamed
  }
}

// ── Which readers a changed input reaches ──────────────────────────────────

export type InputChange = {
  /** The path at the head; for a deletion, the path that was deleted. */
  path: string
  /** For a rename, the path at the base. */
  from?: string
  /** The bytes at the base, `null` when absent there. */
  before: string | null
  /** The bytes at the head, `null` when absent there. */
  after: string | null
}

export type InputImpact = {
  readers: { test: string; readerKind: ReaderKind; edge: string; reason: string }[]
  policies: { id: string; kind: PolicyDeclaration['kind']; duty: string }[]
  unknown: UnknownScope[]
}

/** Every leaf key path whose value differs between two parsed values. */
function changedKeyPaths(a: unknown, b: unknown, prefix = ''): string[] {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((k) => changedKeyPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k))
  }
  return stableJson(a) === stableJson(b) ? [] : [prefix]
}

function keyCovered(changed: string, domain: string): boolean {
  return changed === domain || changed.startsWith(`${domain}.`) || domain.startsWith(`${changed}.`) || changed === ''
}

/**
 * The tests a changed input reaches, by how each reads it, looked up on both
 * the base view (at the change's old path) and the head view — so an edge
 * the head removed, or an input it deleted, still names its readers.
 *
 * A raw-bytes or code reader is reached by any byte change; a schema or
 * policy consumer, and every security or mandatory policy over the input, by
 * any byte change too. A semantic reader is reached only when the parsed
 * value differs, and a parsed-keys reader only when a key in its domain
 * does — so formatting alone reaches neither. A changed key no declared
 * domain covers, a side that is malformed, absent or deleted, an unmodeled
 * base, an unknown scope over the path, or a path no edge names keeps the
 * conservative answer: every reader of the input, and an unknown naming why.
 */
export function changedInputReaders(base: InventoryView | null, head: InventoryView, change: InputChange): InputImpact {
  const impact: InputImpact = { readers: [], policies: [], unknown: [] }
  const reached = new Map<string, InputImpact['readers'][number]>()
  const reach = (test: string, readerKind: ReaderKind, edge: string, reason: string) => {
    const key = `${test}\0${readerKind}\0${edge}`
    if (!reached.has(key)) reached.set(key, { test, readerKind, edge, reason })
  }
  const basePath = change.from ?? change.path
  const candidates: { edge: ResolvedEdge; side: 'base' | 'head' }[] = []
  if (base?.modeled)
    for (const edge of base.edges) if (edgeCovers(edge, basePath)) candidates.push({ edge, side: 'base' })
  for (const edge of head.edges) if (edgeCovers(edge, change.path)) candidates.push({ edge, side: 'head' })

  if (base && !base.modeled)
    impact.unknown.push({
      scope: basePath,
      reason: 'the base revision is not modeled, so its readers of this path are unknown'
    })
  for (const view of [base, head]) {
    for (const scope of view?.unknowns ?? [])
      if (scope.scope === '.' || matchesInput(scope.scope, change.path) || matchesInput(scope.scope, basePath))
        impact.unknown.push(scope)
  }
  if (candidates.length === 0)
    impact.unknown.push({ scope: change.path, reason: 'no declared edge names this path, so its readers are unknown' })

  const bytesChanged = change.before !== change.after
  const conservative = (reason: string) => {
    for (const { edge } of candidates)
      for (const test of edge.readers) reach(test, edge.readerKind, edge.source, reason)
  }

  if (change.before === null || change.after === null) {
    if (bytesChanged) {
      const why = change.after === null ? 'the input was deleted' : 'the input was added'
      impact.unknown.push({ scope: change.path, reason: `${why}, so every reader of it is reached` })
      conservative(why)
    }
  } else if (bytesChanged) {
    // Key domains declared over this input, across both views.
    const domains = candidates
      .filter(({ edge }) => edge.readerKind === 'parsed-keys')
      .flatMap(({ edge }) => edge.keys ?? [])
    const hasSemantic = candidates.some(({ edge }) => edge.readerKind === 'semantic')
    let parsedFallback = false
    for (const { edge } of candidates) {
      if (edge.readerKind === 'code' || edge.readerKind === 'raw-bytes' || edge.readerKind === 'schema-policy') {
        for (const test of edge.readers) reach(test, edge.readerKind, edge.source, 'its bytes changed')
        continue
      }
      const before = parseByFormat(change.before, edge.format)
      const after = parseByFormat(change.after, edge.format)
      if (!before.ok || !after.ok) {
        parsedFallback = true
        continue
      }
      const keys = changedKeyPaths(before.value, after.value)
      if (keys.length === 0) continue // formatting only: the parsed value is the same.
      if (edge.readerKind === 'semantic') {
        for (const test of edge.readers)
          reach(test, 'semantic', edge.source, `its parsed value changed (${keys.join(', ')})`)
        continue
      }
      const relevant = keys.filter((k) => (edge.keys ?? []).some((domain) => keyCovered(k, domain)))
      if (relevant.length > 0)
        for (const test of edge.readers)
          reach(test, 'parsed-keys', edge.source, `a key it reads changed (${relevant.join(', ')})`)
      const unclaimed = keys.filter((k) => !domains.some((domain) => keyCovered(k, domain)))
      if (unclaimed.length > 0 && !hasSemantic) {
        for (const key of unclaimed)
          impact.unknown.push({
            scope: `${change.path}#${key}`,
            reason: 'a changed key belongs to no declared key domain'
          })
        parsedFallback = true
      }
    }
    if (parsedFallback) {
      if (!impact.unknown.some((u) => u.scope.startsWith(change.path)))
        impact.unknown.push({
          scope: change.path,
          reason: 'the input does not parse on one side, so it is read conservatively'
        })
      conservative('the change could not be confined to declared keys')
    }
  }

  if (bytesChanged) {
    for (const view of [base, head]) {
      for (const policy of view?.policies ?? []) {
        if (policy.kind !== 'security' && policy.kind !== 'mandatory') continue
        const covers = policy.inputs.some((entry) => {
          const target = entry.split('#')[0] as string
          return matchesInput(target, change.path) || matchesInput(target, basePath)
        })
        if (covers && !impact.policies.some((p) => p.id === policy.id))
          impact.policies.push({ id: policy.id, kind: policy.kind, duty: policy.duty })
      }
    }
  }
  impact.readers = [...reached.values()].sort((a, b) => a.test.localeCompare(b.test) || a.edge.localeCompare(b.edge))
  const seenUnknown = new Set<string>()
  impact.unknown = impact.unknown.filter((u) => {
    const key = `${u.scope}\0${u.reason}`
    if (seenUnknown.has(key)) return false
    seenUnknown.add(key)
    return true
  })
  return impact
}

/**
 * The workspace layout the CI selection can read (`ci-test-selection.ts
 * --layout`): the workspace members the selector discovers, each suite's
 * declared source folders, every preload, and every spawned program or
 * declared unknown as opaque.
 */
export function layoutOf(view: InventoryView): {
  packageDirs: string[]
  sourceRoots: Record<string, string[]>
  preloads: string[]
  opaque: string[]
} {
  const sourceRoots: Record<string, string[]> = {}
  for (const suite of view.suites) if (suite.sourceRoots) sourceRoots[suite.dir] = [...suite.sourceRoots]
  return {
    packageDirs: [...view.workspaces],
    sourceRoots,
    preloads: [...new Set(view.edges.filter((e) => e.kind === 'preload').map((e) => e.input))].sort(),
    opaque: [
      ...new Set([
        ...view.edges.filter((e) => e.kind === 'spawn').map((e) => e.input),
        ...view.unknowns.filter((u) => u.scope !== '.').map((u) => u.scope.split('#')[0] as string)
      ])
    ].sort()
  }
}

// ── Command line ───────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function main(argv: readonly string[]): number {
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  const base = argValue(argv, '--base')
  let inventory: TestInventory
  try {
    inventory = readTestInventory(repoRoot, { ...(base ? { base } : {}) })
  } catch (err) {
    if (err instanceof InventoryError) {
      process.stderr.write(`${err.message}\n`)
      process.stderr.write(`vinaya inventory: ${err.problems.length} problem(s) in ${INVENTORY_PATH}\n`)
      return 1
    }
    throw err
  }
  const { head } = inventory
  if (argv.includes('--root-tests')) {
    for (const test of head.tests.filter((t) => t.kind === 'repository')) process.stdout.write(`${test.id}\n`)
    return 0
  }
  if (argv.includes('--layout')) {
    process.stdout.write(`${JSON.stringify(layoutOf(head), null, 2)}\n`)
    return 0
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`)
    return 0
  }
  const bySuite = nativeGroups(head)
    .map((g) => `${g.suite} ${g.tests.length} (${g.runner})`)
    .join(', ')
  process.stdout.write(
    `vinaya inventory: ${head.tests.length} test(s) in ${head.suites.length} suite(s) — ${bySuite}; ` +
      `${head.exclusions.length} exclusion(s), ${head.edges.length} edge(s), ${head.unknowns.length} unknown scope(s)\n`
  )
  if (inventory.base) {
    const diff = inventory.base.modeled ? diffTestIdentities(inventory.base, head) : null
    process.stdout.write(
      inventory.base.modeled
        ? `vinaya inventory: base ${inventory.base.revision} — ${diff?.added.length} added, ${diff?.removed.length} removed test(s)\n`
        : `vinaya inventory: base ${inventory.base.revision} carries no inventory; it is reported unmodeled\n`
    )
  }
  return 0
}

// `exitCode`, not `exit()`: an immediate exit can cut a piped `--json` short.
if (import.meta.main) process.exitCode = main(process.argv.slice(2))
