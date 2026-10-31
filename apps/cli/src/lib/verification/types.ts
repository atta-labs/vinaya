/**
 * The public types of the selection library: the canonical inventory model a
 * selection reads, the repository reader and policy it is given, and the plan
 * it returns. Every path is repository-relative and `/`-separated.
 */
import type { TypeScriptApi } from './compiler-graph.js'
import type { ScannerDeclaration } from './scanner-inputs.js'
import type { SpawnProgram } from './spawn-inputs.js'

// ── The inventory model ────────────────────────────────────────────────────

/** A native test runner the inventory model records. */
export type NativeRunner = 'bun' | 'vitest'

/**
 * How a test reads an input: `code` (it runs — an import, a preload, a
 * spawned program), `raw-bytes` (any byte change matters), `semantic` (the
 * parsed whole, so formatting alone does not), `parsed-keys` (named key
 * domains only) or `schema-policy` (a schema or policy consumer, reached by any
 * change).
 */
export type ReaderKind = 'code' | 'raw-bytes' | 'semantic' | 'parsed-keys' | 'schema-policy'

/** What an input is to the tests that read it. */
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

/** The formats a semantic or parsed-keys reader's input is parsed in. */
export type InputFormat = 'json' | 'toml' | 'text'

/** Governance policy: what must run or hold whatever changed — never a dependency. */
export type PolicyDeclaration = {
  id: string
  kind: 'always-run' | 'mandatory' | 'security' | 'oracle'
  /** Repository paths, folders ending in `/`, or `path#key.path` configuration domains. */
  inputs: string[]
  duty: string
  source: string
}

export type SuiteFacts = {
  id: string
  owner: string
  kind: 'workspace' | 'repository'
  dir: string
  cwd: string
  runner: NativeRunner
  preload: string | null
  environment: Record<string, string | number | boolean>
  /** Repository-relative files the runner facts were read from. */
  configFiles: string[]
  include: string[]
  exclude: string[]
  /** The member's folders a selection models, when the suite declares them. */
  sourceRoots?: string[]
}

export type TestIdentity = {
  /** Repository-relative path: the stable identity. */
  id: string
  suite: string
  owner: string
  kind: SuiteFacts['kind']
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
  format?: InputFormat
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

/** One revision's validated inventory: its tests, its input edges, its policies and what it cannot model. */
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

/** A changed input, for {@link InputImpact}. */
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

/** Which readers a changed input reaches, which policies it engages, and what stays unknown. */
export type InputImpact = {
  readers: { test: string; readerKind: ReaderKind; edge: string; reason: string }[]
  policies: { id: string; kind: PolicyDeclaration['kind']; duty: string }[]
  unknown: UnknownScope[]
}

/** Parsers for the formats a semantic or parsed-keys reader names; JSON and text need none. */
export type FormatParsers = Partial<Record<Exclude<InputFormat, 'text'>, (text: string) => unknown>>

// ── Selection inputs ───────────────────────────────────────────────────────

/**
 * Committed repository content, addressed by revision. A revision is an
 * immutable object id; the reader answers for exactly that revision and never
 * for a checkout, an index or a remote.
 */
export type RepositoryReader = {
  /** Every file path the revision holds. Throws when the revision cannot be read. */
  list(revision: string): readonly string[]
  /** A file's text at the revision, or `null` when it is absent or cannot be read. */
  read(revision: string, path: string): string | null
  /** A file's content identity at the revision (an object id), when the reader can name one without reading it. */
  identity?(revision: string, path: string): string | null
}

/** The validated inventory views a selection reads: one per revision, the base `null` when the caller has none. */
export type SelectionInventory = { head: InventoryView; base: InventoryView | null }

/**
 * An addition a consumer makes on top of what the change requires — always
 * stated, never folded into the dependency-required set.
 */
export type SelectionObligation = {
  id: string
  kind: 'policy' | 'platform' | 'configuration'
  reason: string
  /** Test globs (`path-pattern.ts`'s simple grammar). */
  tests?: readonly string[]
  /** Suite ids: every test of the suite. */
  suites?: readonly string[]
}

/** Everything a selection decides by, stated by the caller — the library holds no default of a repository's own. */
export type SelectionPolicy = {
  /**
   * `'transitive'` walks however many files it takes to reach the change;
   * `'one'` stops after a test's own direct edges, withholds tree-scan and
   * spawn edges, and selects a folder-scanning test only for its declared
   * trigger.
   */
  depth: 'one' | 'transitive'
  /** The repository's folder-scanning tests and the kind of change each judges. */
  scanners?: readonly ScannerDeclaration[]
  /** Programs whose spawn by a test is followed into the entrypoint's imports; entrypoints repository-relative. */
  spawnPrograms?: readonly SpawnProgram[]
  /** Folder names whose source files are data a test reads, not code: they select only through a declared input. Default `['fixtures']`. */
  dataFolders?: readonly string[]
  /** Additions on top of the dependency-required set. */
  obligations?: readonly SelectionObligation[]
  /** Parsers for input formats beyond JSON and text. */
  parsers?: FormatParsers
  /** Force the text-scan graph. */
  resolver?: 'compiler' | 'text-scan'
  /** The compiler, when the caller supplies one; absent, it is resolved from this library's own installation, `null` forces the text scan. */
  typescript?: TypeScriptApi | null
}

export type SelectTestsInput = {
  repo: RepositoryReader
  base: string
  head: string
  inventory: SelectionInventory
  policy: SelectionPolicy
}

// ── The plan ───────────────────────────────────────────────────────────────

/** Why a test is in a plan. `revision` names the graph that found it — the base graph keeps an edge the head removed. */
export type PlanReason = {
  kind: 'direct-dependency' | 'transitive-dependency' | 'declared-input' | 'conservative-fallback'
  detail: string
  via: string
  revision: 'base' | 'head'
}

export type PlannedTest = { test: string; suite: string; runner: NativeRunner; reasons: PlanReason[] }

export type PlannedObligation = {
  test: string
  suite: string
  runner: NativeRunner
  obligation: string
  kind: SelectionObligation['kind']
  reason: string
}

/** A named scope selected because what reads its paths is not known — every test, said so. */
export type FallbackScope = { id: string; reason: string; paths: string[]; tests: string[] }

export type PlannedChange = {
  path: string
  /** For a rename, the base path. */
  from?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  /** What modeled this path: `graph`, `input:<edge>`, `scanner:<test>`, `test`, or `fallback:<scope>`. */
  accountedBy: string[]
}

/** A selected suite's configuration identity: what its runner must be started with. */
export type SuiteConfiguration = Pick<SuiteFacts, 'id' | 'runner' | 'cwd' | 'preload' | 'environment' | 'configFiles'>

/** What a plan was computed from — enough to compute it again. */
export type ReproductionContext = {
  base: string
  head: string
  inventory: {
    head: { contextIdentity: string; graphIdentity: string }
    base: { contextIdentity: string; graphIdentity: string; modeled: boolean } | null
  }
  /** Hash of the policy's stated values. */
  policy: string
  resolver: 'compiler' | 'text-scan'
  compiler: string | null
  engine: string
}

export type SelectionPlan = {
  schema: 'test-selection-plan'
  schemaVersion: 1
  /** Hash of every field below except `profile`. */
  identity: string
  context: ReproductionContext
  changes: PlannedChange[]
  /** What the change requires, with every reason. */
  required: PlannedTest[]
  fallbacks: FallbackScope[]
  obligations: PlannedObligation[]
  /** Mandatory and security duties the changed inputs engage. */
  policies: { id: string; kind: PolicyDeclaration['kind']; duty: string; via: string[] }[]
  removedTests: string[]
  renamedTests: { from: string; to: string }[]
  configurations: SuiteConfiguration[]
  /** Timings — never part of the identity. */
  profile: { programMs: number; totalMs: number }
}
