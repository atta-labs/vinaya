/**
 * The public types of the selection library: the canonical inventory model a
 * selection reads, the repository reader and policy it is given, and the plan
 * it returns. Every path is repository-relative and `/`-separated.
 */
import type { TypeScriptApi } from './compiler-graph.js'
import type { ReadRecord } from './recorded-reads.js'
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
export type InputFormat = 'json' | 'toml' | 'bun-lock' | 'text'

/** Governance policy: what must run or hold whatever changed — never a dependency. */
export type PolicyDeclaration = {
  id: string
  kind: 'always-run' | 'mandatory' | 'security' | 'oracle' | 'whole-suite'
  /** Repository paths, folders ending in `/`, or `path#key.path` configuration domains. */
  inputs: string[]
  duty: string
  source: string
}

export type SuiteFacts = {
  id: string
  owner: string
  /**
   * `workspace` — a member's runner collects its tests; `repository` — the root
   * suite's listed tests; `compatibility` — listed root tests that check the
   * published packages through their public subpaths.
   */
  kind: 'workspace' | 'repository' | 'compatibility'
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
  /**
   * Suites that run whole when the change touches any path under their folder: the selection does not model
   * every input such a suite reads. Only the suite's tests with no valid record run whole; a record decides the rest.
   */
  wholeSuites?: readonly WholeSuitePolicy[]
  /** Parsers for input formats beyond JSON and text. */
  parsers?: FormatParsers
  /** Force the text-scan graph. */
  resolver?: 'compiler' | 'text-scan'
  /** The compiler, when the caller supplies one; absent, it is resolved from this library's own installation, `null` forces the text scan. */
  typescript?: TypeScriptApi | null
}

/** A suite that runs whole on a change under its folder, and why. */
export type WholeSuitePolicy = { suite: string; reason: string }

/**
 * A test file that ran completely and passed — every test in it ran and passed, none skipped, filtered, focused or
 * todo — under the key {@link passEntryKey} computed at the commit it ran on.
 */
export type PassEntry = {
  /** Repository-relative test file. */
  test: string
  /** The verification context plus the content of every path the test reads; see {@link passEntryKey}. */
  key: string
  /** The commit the test passed on — when it ran on a merge of that commit onto `base`, the merged commit. */
  head: string
  /** When the test ran on `head` merged onto another commit (a pull request's merge commit), that commit. */
  base?: string
  /** Who ran it: a local push, a CI shard, a hand run — for the plan's account only. */
  source: string
}

/** What earlier runs of the same branch or pull request proved and failed. */
export type SelectionHistory = {
  /** The verification context digest of the run being planned; `null` refuses every reuse. */
  context: string | null
  /** Earlier complete passes; a planned test whose key at the head matches one is reused instead of run. */
  passes: readonly PassEntry[]
  /** Tests the last refused run failed or never confirmed: re-run whatever the change selects. */
  failures: readonly string[]
}

/**
 * After the default branch was merged into a branch, the paths the branch itself changed since its last proven
 * head. A planned test whose every reason names a changed path outside this set — a path only the default branch
 * changed — is left out, unless a selection from a commit that changes only these paths reaches it. `base` builds
 * that commit and its inventory view when the selection needs it; `null` when it cannot, which leaves nothing out.
 */
export type BranchSideInput = {
  paths: readonly string[]
  base: () => { commit: string; inventory: InventoryView } | null
}

/**
 * The recorded reads a selection may decide by: the record of one commit, and
 * the platform the caller's push runs on. A test with a valid record is decided
 * by it; every other test is decided by the static selection, unchanged.
 */
export type SelectionRecords = {
  /** The record taken at `record.commit`; the selection uses it for tests whose reads did not change between that commit and the base. */
  record: ReadRecord
  /** The platform the caller runs on (`process.platform`). */
  platform: string
}

export type SelectTestsInput = {
  repo: RepositoryReader
  base: string
  head: string
  inventory: SelectionInventory
  policy: SelectionPolicy
  /** The recorded reads, when the caller could reach the record of the comparison's commit; absent, static selection decides every test. */
  records?: SelectionRecords | null
  /** Earlier passes and failures of the same branch; absent, nothing is reused and nothing is re-run on its account. */
  history?: SelectionHistory | null
  /** The branch's own changes after a default-branch merge; absent, nothing is left out. */
  branchSide?: BranchSideInput | null
}

/** A test decided by static selection instead of a record, and why. */
export type RecordFallbackScope = { id: string; reason: string; tests: string[] }

/** What the record decided and what it left to static selection. */
export type PlanRecords = {
  /** The commit whose record was used, or `null` when none was reachable. */
  commit: string | null
  /** The tests the record decided. */
  recorded: string[]
  /** Every test the static selection decided instead, grouped by reason. */
  fallbacks: RecordFallbackScope[]
}

// ── The plan ───────────────────────────────────────────────────────────────

/** Why a test is in a plan. `revision` names the graph that found it — the base graph keeps an edge the head removed. */
export type PlanReason = {
  kind: 'direct-dependency' | 'transitive-dependency' | 'declared-input' | 'conservative-fallback' | 'recorded-read'
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
  /** What the recorded reads decided, and every test left to static selection with its reason. */
  records: PlanRecords
  /** Mandatory and security duties the changed inputs engage. */
  policies: { id: string; kind: PolicyDeclaration['kind']; duty: string; via: string[] }[]
  removedTests: string[]
  renamedTests: { from: string; to: string }[]
  configurations: SuiteConfiguration[]
  /** Suites that run whole, each with why and the tests it runs. */
  wholeSuites: { suite: string; reason: string; tests: string[] }[]
  /** Planned tests only default-branch changes reached after a merge ({@link BranchSideInput}); not run. */
  leftOut: string[]
  /** Planned tests an earlier complete pass under the same key covers; not run. */
  reused: { test: string; head: string; source: string }[]
  /** Timings — never part of the identity. */
  profile: { programMs: number; totalMs: number }
}
