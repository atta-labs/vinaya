/**
 * This repository's file-list test selector: which test files a set of changed
 * files could affect, resolved through the real import graph — never a folder
 * heuristic.
 *
 * The one implementation lives in the selection library
 * (`verification/selector.ts`): the compiler and text-scan graphs, changed-name
 * attribution, the tree-scanner and spawn edges, and the walk. This module is
 * the compatibility adapter every existing caller imports. It reads the
 * checkout on disk, exactly as before, and injects this repository's own
 * defaults, which the library never holds:
 *
 * - the folder-scanning tests' declarations (`SCANNER_DECLARATIONS` in
 *   `repo-scanner-tests.ts`);
 * - the CLI entrypoint a test spawns with `bun` ({@link DEFAULT_CLI_ENTRYPOINT});
 * - the repository-root `vinaya.config.json` ({@link ROOT_CONFIG_FILENAME}) and
 *   its loader ({@link DEFAULT_CONFIG_LOADER}): a change to that one path
 *   selects the CLI's whole suite under the transitive walk, and the tests
 *   whose own depth-one edges reach the loader under depth one.
 *
 * A caller that wants a reproducible plan between two committed revisions
 * calls the library's public `selectTests` instead; this adapter's callers keep
 * their contracts until their integrations opt into it.
 */
import { CLI_SPAWN_BINARY } from './cli-spawn-tests.js'
import { SCANNER_DECLARATIONS, type ScannerDeclaration } from './repo-scanner-tests.js'
import {
  diskTree,
  discoverWorkspaceDirs as discoverTreeWorkspaceDirs,
  discoverWorkspacePackages as discoverTreeWorkspacePackages,
  expandWorkspacePatterns as expandTreeWorkspacePatterns,
  readWorkspacePatterns as readTreeWorkspacePatterns,
  type SelectionResult,
  selectAffectedFiles,
  type WorkspacePackage,
  walkTree
} from './verification/selector.js'

export {
  extractImportRecords,
  extractImportSpecifiers,
  extractOwnImportRecords,
  type ImportRecord,
  isTestFile,
  resolveRelativeImport,
  type SelectionExplanation,
  type SelectionReasonKind,
  type SelectionResult,
  type TestRunner,
  testRunnerOf,
  type WorkspacePackage
} from './verification/selector.js'

/** Every regular file under `root` on disk, skipping dependency and build folders — absolute paths. */
export function walkFiles(root: string): string[] {
  return walkTree(diskTree(root), root)
}

/**
 * The root manifest's `workspaces` entries — the array form, or the `packages`
 * array of the object form — or `null` when the manifest is missing or not
 * JSON.
 */
export function readWorkspacePatterns(repoRoot: string): string[] | null {
  return readTreeWorkspacePatterns(diskTree(repoRoot))
}

/**
 * Expands workspace patterns to the repository-relative directories they
 * name, in declaration order and each once: a literal directory (`harness`),
 * a glob in the last segment (`apps/*`) or in any segment
 * (`harness/processes/*`). A `!`-prefixed pattern removes what it matches. A
 * `**` segment is never expanded.
 */
export function expandWorkspacePatterns(repoRoot: string, patterns: readonly string[]): string[] {
  return expandTreeWorkspacePatterns(diskTree(repoRoot), patterns)
}

/**
 * The repository-relative directories of every workspace member with a real,
 * named `package.json`, found from the root manifest's own `workspaces`
 * entries — never a fixed list of folders, so a member moved under a new
 * parent (`harness/kernel`, `harness/processes/<name>`) is found the moment
 * the manifest names it.
 */
export function discoverWorkspaceDirs(repoRoot: string): string[] {
  return discoverTreeWorkspaceDirs(diskTree(repoRoot))
}

/**
 * Every workspace member with a real `package.json`. A member nested inside
 * another (`harness/kernel` inside `harness`) owns its own files: they are
 * left out of the enclosing member's `sourceFiles`, so no file belongs to two
 * packages.
 */
export function discoverWorkspacePackages(repoRoot: string): WorkspacePackage[] {
  return discoverTreeWorkspacePackages(diskTree(repoRoot))
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
  /**
   * Repo-root-relative or absolute paths of files removed in this diff — a
   * deletion, or the old path of a rename (`removedFilesSinceRemoteBase`).
   * Read only by a `tree-shape` scanner declaration, which judges the shape
   * of a folder and so breaks on a removal as it does on an addition.
   */
  removed?: readonly string[]
  /**
   * Per changed file (absolute or repo-root-relative), the 1-based, inclusive
   * line ranges the diff touched on its new side. Read only by a
   * `process-start` scanner declaration. A changed file absent from this map
   * counts as touched everywhere — the wider, safe answer.
   */
  changedRanges?: ReadonlyMap<string, readonly { start: number; end: number }[]>
  /**
   * The folder-scanning tests and the kind of change each judges
   * (`repo-scanner-tests.ts`'s `SCANNER_DECLARATIONS`, the default). A test
   * here is selected when the diff is its kind of change, whatever
   * `repoTreeScanners` says — that option governs the scan edge, which
   * selects on any change under the roots; this is the narrower rule the
   * pre-push hook keeps. Overridable so a test can declare a fixture's own.
   */
  scannerDeclarations?: readonly ScannerDeclaration[]
  /**
   * Per changed file (absolute or repo-root-relative), the exported names this
   * diff actually touched — or `'all'` when the diff touched something that
   * cannot be attributed to one declaration, which makes the whole file
   * affected. A changed file ABSENT from this map is also wholly affected: the
   * default is always the file-level answer, so a caller that computes nothing
   * gets the wider, safe selection rather than a narrower, wrong one.
   */
  affectedNames?: ReadonlyMap<string, ReadonlySet<string> | 'all'>
  /**
   * Whether tests whose input is the repository TREE (`repo-scanner-tests.ts`)
   * get their `scan:` edges. `'select'` — the default, and the only safe
   * production value — gives them the edges; `'ignore'` withholds them, which
   * exists so the cost of the rule can be measured against the same tree
   * rather than estimated.
   */
  repoTreeScanners?: 'select' | 'ignore'
  /**
   * Forces the text-scan graph instead of the compiler one. Exists so the
   * fallback path — what a repository with no `typescript` installed actually
   * gets — is reachable from a test on a machine that does have it; production
   * callers never set it.
   */
  resolver?: 'compiler' | 'text-scan'
  /**
   * Whether a test that spawns the built CLI as a subprocess (`cli-spawn-tests.ts`)
   * gets its synthetic edge into the entrypoint's own import graph (`'select'`,
   * the default and the only safe production value) or withholds it
   * (`'ignore'`), which exists so this rule's own selection cost can be
   * measured against the same tree rather than estimated — the same shape
   * `repoTreeScanners` already offers for the repo-tree-scanner class.
   */
  cliSpawnDetection?: 'select' | 'ignore'
  /**
   * Repo-root-relative path of the CLI's own entrypoint file that
   * `cli-spawn-tests.ts` classifies a test's spawn calls against. Defaults to
   * this repository's real entrypoint, `apps/cli/src/index.ts`; overridable so
   * a test can point it at a throwaway fixture's own entrypoint instead of the
   * real one.
   */
  cliEntrypoint?: string
  /**
   * Repo-root-relative path of the CLI's configuration loader module — the
   * file that reads the repository-root `vinaya.config.json`. Under
   * `depth: 'one'` a change to that root file selects only the CLI tests whose
   * own direct edges reach this module, never the CLI's whole suite. Defaults
   * to this repository's real loader, `apps/cli/src/lib/config.ts`;
   * overridable so a test can point it at a throwaway fixture's own loader,
   * the same way `cliEntrypoint` is.
   */
  configLoader?: string
  /**
   * How far the reachability walk may travel past a test's own first-level
   * imports before it stops counting as "affected".
   * `'transitive'` — the default, and every caller's behaviour before this
   * option existed — keeps walking through however many files it takes to
   * reach the change; that is the never-miss answer this repository's own
   * ceiling-free suite of tests below still holds it to, and it stays CI's
   * job. `'one'` stops the walk after the test's own direct edges (an import
   * it names, plus whatever a resolved re-export hop or a barrel's own
   * module-scope pulls in for that SAME edge — never a second file's own
   * further imports): a test that reaches the change only by importing a
   * file that itself imports the changed file is not selected. This is what
   * lets a push touching a widely-imported module stay small — the pre-push
   * hook is the one caller that passes it (`pre-push-select-tests.ts`); the
   * full-suite CI shards and every other caller keep the default.
   */
  depth?: 'one' | 'transitive'
  /**
   * Whether tests of a package whose native runner is not `bun test` are
   * also judged and reported, with their runner, in
   * {@link SelectionResult.native} (`'expose'`), or skipped as before
   * (`'exclude'`, the default). Either way {@link SelectionResult.selected}
   * holds only files `bun test` can run.
   */
  nativeRunners?: 'exclude' | 'expose'
}

/** This repository's real CLI entrypoint, repo-root-relative — {@link SelectionOptions.cliEntrypoint}'s default. */
export const DEFAULT_CLI_ENTRYPOINT = 'apps/cli/src/index.ts'

/** This repository's real CLI configuration loader, repo-root-relative — {@link SelectionOptions.configLoader}'s default. */
export const DEFAULT_CONFIG_LOADER = 'apps/cli/src/lib/config.ts'

/**
 * The repository-root configuration file whose change selects the CLI's
 * whole suite under the transitive walk, and the configuration loader's
 * direct importers under depth one.
 * Named rather than inlined so a test asserts against the same string this
 * module matches on.
 */
export const ROOT_CONFIG_FILENAME = 'vinaya.config.json'

/**
 * The whole pipeline: given the changed files (repo-root-relative or absolute,
 * either works) and the repo root, builds one global forward-import graph across
 * every workspace package on disk and returns every test file — in ANY package
 * — whose transitive import closure reaches a changed file, plus every test
 * file `options.alwaysRun` names or that `options.addedOrRenamed` itself is,
 * plus every folder-scanning test whose declared trigger the diff is, plus —
 * when the changed set contains the repository-root `vinaya.config.json` —
 * every test in the package that owns the CLI entrypoint, whose behaviour that
 * file configures without any test importing it.
 *
 * The rule a changed root configuration follows matches that one path
 * exactly, never a `vinaya.config.json` sitting in a fixture directory and
 * never another root-level JSON file. Under `depth: 'one'` it narrows to the
 * CLI tests whose own direct edges reach the configuration loader module, so a
 * push touching the root file stays inside the publish tool's time limit, and
 * the whole suite for it stays CI's job.
 */
export function selectAffectedTestFiles(
  repoRoot: string,
  changedFiles: string[],
  options: SelectionOptions = {}
): SelectionResult {
  const cliEntrypoint = options.cliEntrypoint ?? DEFAULT_CLI_ENTRYPOINT
  return selectAffectedFiles(diskTree(repoRoot), changedFiles, {
    ...(options.alwaysRun ? { alwaysRun: options.alwaysRun } : {}),
    ...(options.addedOrRenamed ? { addedOrRenamed: options.addedOrRenamed } : {}),
    ...(options.removed ? { removed: options.removed } : {}),
    ...(options.changedRanges ? { changedRanges: options.changedRanges } : {}),
    ...(options.affectedNames ? { affectedNames: options.affectedNames } : {}),
    ...(options.repoTreeScanners ? { repoTreeScanners: options.repoTreeScanners } : {}),
    ...(options.resolver ? { resolver: options.resolver } : {}),
    ...(options.cliSpawnDetection ? { spawnDetection: options.cliSpawnDetection } : {}),
    ...(options.depth ? { depth: options.depth } : {}),
    ...(options.nativeRunners ? { nativeRunners: options.nativeRunners } : {}),
    scannerDeclarations: options.scannerDeclarations ?? SCANNER_DECLARATIONS,
    spawnPrograms: [{ binary: CLI_SPAWN_BINARY, entrypoint: cliEntrypoint }],
    configInputs: [
      {
        path: ROOT_CONFIG_FILENAME,
        label: 'the repository-root configuration file',
        ownerFile: cliEntrypoint,
        loader: options.configLoader ?? DEFAULT_CONFIG_LOADER
      }
    ]
  })
}
