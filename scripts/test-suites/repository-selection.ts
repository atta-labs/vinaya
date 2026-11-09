#!/usr/bin/env bun
/**
 * This repository's one adapter to the selection package
 * (`@attalabs/test-selection`): {@link loadSelectionInputs} reads everything a
 * selection needs from outside — the commits, both inventory views, this
 * repository's policy, the read record, the branch's earlier results and
 * passes, and the incremental base — and hands it to `selectTests`, which
 * holds every selection rule. A local push and CI call it the same way, run
 * exactly `plannedTests` of the plan, and pass no selection option: only the
 * comparison base, the head, the record and the platform differ between them,
 * and each comes from here.
 *
 * The facts it supplies, each read from the head commit's own committed files
 * — never from the checkout this runs in:
 *
 * - the inventory views, built by `inventory-check.ts` for each commit from
 *   that commit's declarations;
 * - the policy: the import walk's depth (`one`), the folder-scanning tests'
 *   declarations, the programs tests start, the obligations (the inventory's
 *   always-run policies and the build job's own suites) and the suites the
 *   inventory's `whole-suite` policies run whole on a change under their folder;
 * - the record of what each test read on the default branch (`read-records.ts`),
 *   when one can be reached;
 * - on a push, the base `chooseNativeBase` proves — the merge base with the
 *   remote base, or the head of the last passing or refused run on this
 *   branch — the failed tests of the last refused run, and the branch's own
 *   changes after a default-branch merge;
 * - the earlier complete passes: the push gate's own, each hand run's JUnit
 *   report (`junit-store.ts`), and on CI the pass entries earlier runs of the
 *   same pull request stored, each under its key (`passEntryKey`).
 *
 *   bun scripts/test-suites/repository-selection.ts --base <rev> --head <rev> [--record <file>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import {
  type BranchSideInput,
  gitRepository,
  type InventoryView as LibraryInventoryView,
  isReadRecord,
  type PassEntry,
  passKeys,
  plannedTests,
  type ReadRecord,
  type ScannerDeclaration,
  type ScannerTrigger,
  type SelectionHistory,
  type SelectionObligation,
  type SelectionPlan,
  type SelectionPolicy,
  type SelectionRecords,
  type SelectTestsInput,
  SELECTION_ENGINE,
  selectTests,
  stableHash,
  type WholeSuitePolicy
} from '@attalabs/test-selection'
import { cleanMergeOnto, resolveRemoteBase } from '../../harness/kernel/connectors/git/remote-base.js'
import { CLI_SPAWN_BINARY } from '../../harness/kernel/gates/ring0-hooks/pre-push/cli-spawn-tests.js'
import {
  junitFileResults,
  marksOnly,
  runEnvironment,
  storedJunitReports
} from '../../harness/kernel/gates/ring0-hooks/pre-push/junit-store.js'
import {
  changedBetween,
  chooseNativeBase,
  type ContextParts,
  computeVerificationContext,
  currentBranch,
  isAncestor,
  type NativeBaseChoice,
  newestMergeSince,
  readFailedTestsRecord,
  readJsonUnderGit,
  readPassingRecord,
  type TestRunnerFacts,
  verificationInputsDirty,
  writeJsonUnderGit
} from '../../harness/kernel/gates/ring0-hooks/pre-push/pre-push-failed-tests.js'
import { DEFAULT_CLI_ENTRYPOINT } from '../../harness/processes/vinaya-strict/integration/repository-verification.js'
import { PROGRAMS } from '../../harness/processes/vinaya-strict/tools/programs.js'
import {
  bunLockParser,
  INVENTORY_PATH,
  type InventoryDeclarations,
  type InventoryView,
  readExportedScannerDeclarations,
  readTestInventory,
  revisionReader
} from './inventory-check.js'
import { nearestReachableRecord, type ReachedRecord, reachableRecord } from './read-records.js'

const SCANNER_TRIGGERS: ReadonlySet<string> = new Set(['tree-shape', 'process-start', 'listed-files', 'content'])

/** The version of how a plan is executed; part of every verification context a pass is keyed under. */
export const LOCAL_RUN_EXECUTION = 'native-local-run@1'

/**
 * The verification context a plan executes under: the environment's verification digest (selection policy, input
 * declarations, lockfiles, runner configuration, environment), the head inventory's runner facts, the selection
 * engine and the execution version. `null` when the digest cannot be read — an unreadable context refuses every reuse.
 */
export function nativeContext(verification: string | null, inventory: string): string | null {
  if (verification === null) return null
  return stableHash({ verification, inventory, engine: SELECTION_ENGINE, execution: LOCAL_RUN_EXECUTION })
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key]
  return out
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: cleanGitEnv(),
      maxBuffer: 256 * 1024 * 1024
    }).trim()
  } catch {
    return null
  }
}

/** The commit a revision names, resolved once, so the plan is pinned to an object id rather than a moving name. */
export function resolveCommit(repoRoot: string, revision: string): string {
  return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/** The folder-scanning declarations the head commit's inventory names a provider for, read from that commit's syntax. */
function scannerDeclarations(repoRoot: string, head: string): ScannerDeclaration[] {
  const tree = revisionReader(repoRoot, head)
  const declarations = JSON.parse(tree.read(INVENTORY_PATH) ?? '{}') as Partial<InventoryDeclarations>
  const out: ScannerDeclaration[] = []
  for (const provider of declarations.providers ?? []) {
    if (provider.shape !== 'scanner-declarations') continue
    const text = tree.read(provider.file)
    const read = text === null ? null : readExportedScannerDeclarations(text, provider.file, provider.export)
    for (const entry of read ?? [])
      if (SCANNER_TRIGGERS.has(entry.trigger))
        out.push({ test: entry.test, roots: entry.roots, trigger: entry.trigger as ScannerTrigger })
  }
  return out
}

/** The root suites the build job runs on every pull request, each under the policy that states the duty. */
const BUILD_GATES = [
  { policy: 'inventory-gate', suite: 'repository' },
  { policy: 'package-compatibility', suite: 'package-compat' }
]
/** A `path#key.path` list the head commit holds, or none. */
function committedList(repoRoot: string, head: string, entry: string): string[] {
  const [path, keyPath] = entry.split('#') as [string, string | undefined]
  const text = revisionReader(repoRoot, head).read(path)
  if (text === null || !keyPath) return []
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  for (const key of keyPath.split('.')) value = (value as Record<string, unknown> | undefined)?.[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The inventory's always-run policies, each with the tests its list names at the head commit. */
export function alwaysRunObligations(repoRoot: string, head: string, view: InventoryView): SelectionObligation[] {
  return view.policies
    .filter((policy) => policy.kind === 'always-run')
    .map((policy) => ({
      id: policy.id,
      kind: 'policy' as const,
      reason: policy.duty,
      tests: policy.inputs.flatMap((entry) => committedList(repoRoot, head, entry))
    }))
}

/**
 * One program source per folder among the programs that replaced command-line
 * commands. Tests start them through the program table, a spawn the selector
 * reads only coarsely: its edge is the started program's own folder, the same
 * for every program in that folder. So one entry per folder gives the same
 * edges, and the selector scans each test once per folder, not once per program.
 */
function spawnedProgramSources(): string[] {
  const byFolder = new Map<string, string>()
  for (const program of PROGRAMS.values()) {
    const folder = program.source.slice(0, program.source.lastIndexOf('/'))
    if (program.commands.length > 0 && !byFolder.has(folder)) byFolder.set(folder, program.source)
  }
  return [...byFolder.values()]
}

/** What every caller adds on top of what the change requires: the always-run policies and the build job's suites. */
function obligationsOf(repoRoot: string, head: string, view: InventoryView): SelectionObligation[] {
  const gates = BUILD_GATES.flatMap(({ policy: id, suite }) => {
    const gate = view.policies.find((policy) => policy.id === id)
    return gate ? [{ id: gate.id, kind: 'policy' as const, reason: gate.duty, suites: [suite] }] : []
  })
  return [...alwaysRunObligations(repoRoot, head, view), ...gates]
}

/** The inventory's `whole-suite` policies, each as the suite whose folder it names. */
function wholeSuitesOf(view: InventoryView): WholeSuitePolicy[] {
  return view.policies
    .filter((policy) => policy.kind === 'whole-suite')
    .flatMap((policy) =>
      policy.inputs.flatMap((input) => {
        const suite = view.suites.find((s) => `${s.dir}/` === input || s.dir === input)
        return suite ? [{ suite: suite.id, reason: policy.duty }] : []
      })
    )
}

/** This repository's selection policy, read from the head commit: the same for every caller. */
export function repositoryPolicy(repoRoot: string, head: string, view: InventoryView): SelectionPolicy {
  return {
    depth: 'one',
    scanners: scannerDeclarations(repoRoot, head),
    spawnPrograms: [
      { binary: CLI_SPAWN_BINARY, entrypoint: DEFAULT_CLI_ENTRYPOINT },
      // The programs a test may spawn as `bun <source file>`, as the command line once was.
      ...spawnedProgramSources().map((entrypoint) => ({ binary: 'bun', entrypoint }))
    ],
    obligations: obligationsOf(repoRoot, head, view),
    wholeSuites: wholeSuitesOf(view),
    parsers: { toml: (text) => Bun.TOML.parse(text), 'bun-lock': bunLockParser }
  }
}

export type RepositorySelectionOptions = {
  base: string
  head: string
  /** The record of the comparison's commit, when one was reached; absent, static selection decides every test. */
  record?: ReadRecord | null
  /** The platform the caller runs on; defaults to this process's. */
  platform?: string
}

/** The change part of a selection's input: both commits resolved, both inventory views, the policy and the record. */
export function repositorySelectionInput(repoRoot: string, options: RepositorySelectionOptions): SelectTestsInput {
  const base = resolveCommit(repoRoot, options.base)
  const head = resolveCommit(repoRoot, options.head)
  const inventory = readTestInventory(repoRoot, { base, head })
  return {
    repo: gitRepository(repoRoot),
    base,
    head,
    inventory: { head: inventory.head, base: inventory.base },
    policy: repositoryPolicy(repoRoot, head, inventory.head),
    records: options.record ? { record: options.record, platform: options.platform ?? process.platform } : null
  }
}

// ── Earlier passes ─────────────────────────────────────────────────────────

/** Where the push gate keeps the pass entries of its own runs, under the worktree's git directory. */
export const PASS_ENTRIES_FILE = 'vinaya/pass-entries.json'
/** How many pass entries a store keeps; the oldest go first. */
export const PASS_ENTRIES_LIMIT = 5000

/** A stored set of pass entries: the push gate's own file, or one CI shard's artifact. */
export type PassEntryFile = { version: 1; entries: PassEntry[] }

export function parsePassEntryFile(text: string | null): PassEntry[] {
  if (!text) return []
  try {
    const value = JSON.parse(text) as Partial<PassEntryFile>
    if (value.version !== 1 || !Array.isArray(value.entries)) return []
    return value.entries.filter(
      (e): e is PassEntry =>
        typeof e?.test === 'string' &&
        typeof e.key === 'string' &&
        typeof e.head === 'string' &&
        typeof e.source === 'string'
    )
  } catch {
    return []
  }
}

/**
 * The pass entries one Bun JUnit report proves: each test file it names that passed completely and whose source at
 * `revision` marks nothing `.only`, keyed at `revision` under `context`. A file the report cannot tie to a
 * repository test (`tests`), and a file whose key cannot be computed, gives no entry.
 */
export function passEntriesOfReport(input: {
  xml: string
  /** Repository-relative folder the run started in: the report's paths are relative to it. */
  cwd: string
  repo: SelectTestsInput['repo']
  revision: string
  context: string | null
  records: SelectionRecords | null
  tests: ReadonlySet<string>
  source: string
}): PassEntry[] {
  const results = junitFileResults(input.xml)
  if (!results || input.context === null) return []
  const keyOf = passKeys({ repo: input.repo, revision: input.revision, context: input.context, records: input.records })
  const entries: PassEntry[] = []
  for (const { file, passed } of results) {
    if (!passed) continue
    const test = posix.normalize(posix.join(input.cwd === '.' ? '' : input.cwd, file.replace(/^\.\//, '')))
    if (!input.tests.has(test)) continue
    const source = input.repo.read(input.revision, test)
    if (source === null || marksOnly(source)) continue
    const key = keyOf(test)
    if (key !== null) entries.push({ test, key, head: input.revision, source: input.source })
  }
  return entries
}

/**
 * The pass entries a scheduled run's own Bun reports prove at the checked-out commit, keyed under this checkout's
 * verification context and `record`: none when the tracked tree differs from the commit or a verification input
 * carries an uncommitted change, since then the run proved nothing about the commit.
 */
export function passEntriesOfRun(input: {
  repoRoot: string
  view: InventoryView
  reports: readonly { cwd: string; xml: string }[]
  record: ReadRecord | null
  platform?: string
  source: string
}): PassEntry[] {
  const { repoRoot, view } = input
  if (input.reports.length === 0) return []
  if (git(repoRoot, ['status', '--porcelain', '-uno']) !== '' || verificationInputsDirty(repoRoot) !== false) return []
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  if (!head) return []
  const context = nativeContext(
    computeVerificationContext(repoRoot, runEnvironment())?.digest ?? null,
    view.contextIdentity
  )
  const repo = gitRepository(repoRoot)
  const records = input.record ? { record: input.record, platform: input.platform ?? process.platform } : null
  const tests = new Set(view.tests.map((t) => t.id))
  return input.reports.flatMap((report) =>
    passEntriesOfReport({ ...report, repo, revision: head, context, records, tests, source: input.source })
  )
}

/** Appends entries to the push gate's store, keeping the newest {@link PASS_ENTRIES_LIMIT}. */
export function storePassEntries(repoRoot: string, entries: readonly PassEntry[]): void {
  if (entries.length === 0) return
  const kept = parsePassEntryFile(readJsonUnderGit(repoRoot, PASS_ENTRIES_FILE))
  const all = [...kept, ...entries]
  writeJsonUnderGit(repoRoot, PASS_ENTRIES_FILE, { version: 1, entries: all.slice(-PASS_ENTRIES_LIMIT) })
}

/** Every pass entry in the `*.json` pass-entry files under `dir`. */
export function passEntriesUnder(dir: string): PassEntry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.json'))
    .flatMap((path) => {
      try {
        return parsePassEntryFile(readFileSync(join(dir, path), 'utf8'))
      } catch {
        return []
      }
    })
}

/**
 * Whether the pass entries an earlier CI run stored at `producer` may be reused at `head`. That run executed the code
 * of `producer` merged onto its base, so whatever the pull request had changed at `producer` decided what it wrote:
 * its planner, its schedule, its preloads, its tests. The entries are trusted only when `producer` is a commit of
 * this branch's history (an ancestor of `head`) and every path the pull request changed at `producer` holds the same
 * content at `head` — so nothing that ran there is gone from the change now under review, and a change to a planning
 * input that is still there runs everything under the base guard.
 */
export function trustedPassProducer(repoRoot: string, base: string, head: string, producer: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(producer) || !isAncestor(repoRoot, producer, head)) return false
  const forkPoint = git(repoRoot, ['merge-base', producer, base])
  if (!forkPoint) return false
  const changed = git(repoRoot, ['diff', '--name-only', '--no-renames', forkPoint, producer])
  if (changed === null) return false
  const paths = changed.split('\n').filter(Boolean)
  if (paths.length === 0) return true
  const blobs = (revision: string) => git(repoRoot, ['ls-tree', '-r', revision, '--', ...paths])
  const before = blobs(producer)
  return before !== null && before === blobs(head)
}

/**
 * CI's downloaded pass entries, laid out `<dir>/<producer head sha>/…` by the workflow from the run list GitHub
 * reports — never from anything the producing run wrote. Only the entries of a trusted producer
 * ({@link trustedPassProducer}) are kept; a folder that names no commit is dropped whole.
 *
 * What an artifact says is checked too, since the code that wrote it is the pull request's: an entry is kept only
 * when it names its producer as its head and its stored key is the key its test has at that producer, recomputed
 * here under this run's context and record. An entry minted for a later head, or under a key its test never had at
 * the commit that ran it, is dropped; with no context, no entry is kept.
 */
export function trustedCiPassEntries(
  repoRoot: string,
  dir: string,
  base: string,
  head: string,
  verify: { repo: SelectTestsInput['repo']; context: string | null; records: SelectionRecords | null }
): PassEntry[] {
  if (!existsSync(dir) || verify.context === null) return []
  const context = verify.context
  return readdirSync(dir).flatMap((producer) => {
    if (!trustedPassProducer(repoRoot, base, head, producer)) return []
    const keyOf = passKeys({ repo: verify.repo, revision: producer, context, records: verify.records })
    return passEntriesUnder(join(dir, producer)).filter(
      (entry) => entry.head === producer && entry.key === keyOf(entry.test)
    )
  })
}

/**
 * The pass entries of every hand run's stored JUnit report (`junit-store.ts`): only a run that started on a clean
 * tracked tree at a commit this repository holds, keyed at that commit under the context it ran in.
 */
function handRunPassEntries(
  repoRoot: string,
  repo: SelectTestsInput['repo'],
  records: SelectionRecords | null
): PassEntry[] {
  const gitDir = git(repoRoot, ['rev-parse', '--absolute-git-dir'])
  if (!gitDir) return []
  const views = new Map<string, LibraryInventoryView | null>()
  const viewAt = (head: string) => {
    if (!views.has(head)) {
      try {
        views.set(head, readTestInventory(repoRoot, { head }).head)
      } catch {
        views.set(head, null)
      }
    }
    return views.get(head) ?? null
  }
  return storedJunitReports(gitDir).flatMap(({ report, note }) => {
    if (!note.clean) return []
    const view = viewAt(note.head)
    if (!view) return []
    let xml: string
    try {
      xml = readFileSync(report, 'utf8')
    } catch {
      return []
    }
    return passEntriesOfReport({
      xml,
      cwd: note.cwd,
      repo,
      revision: note.head,
      context: nativeContext(note.verification, view.contextIdentity),
      records,
      tests: new Set(view.tests.map((t) => t.id)),
      source: `hand run ${note.startedAt}`
    })
  })
}

/** The read record of exactly `commit` — the copy kept under the git directory, else fetched — or `null`. */
export function recordAt(repoRoot: string, commit: string): ReadRecord | null {
  return reachableRecord(repoRoot, commit).record
}

// ── The one entry ──────────────────────────────────────────────────────────

/** Reaches the read record of a commit, or says why none can be reached. */
export type RecordReach = (repoRoot: string, commit: string) => ReachedRecord

export type LoadSelectionOptions = {
  repoRoot: string
  /** Who plans: the push gate, or CI on a pull request. */
  caller: 'push' | 'ci'
  /** The head commit; the checkout's `HEAD` when absent. */
  head?: string
  /** CI: the pull request's base commit. A push compares with the base it proves itself. */
  base?: string
  /** CI: a folder of pass-entry files earlier runs of the same pull request stored. */
  passes?: string
  /** The platform the plan's tests run on; this process's when absent. */
  platform?: string
  /** How the read record is reached; `nearestReachableRecord` when absent. */
  reach?: RecordReach
}

/** What the inputs were read from, for the caller's account of the plan — never an input to the selection. */
export type SelectionAccount = {
  caller: 'push' | 'ci'
  /** Why the record was, or was not, reached. */
  recordNote: string
  /** The verification context the plan executes under. */
  context: string | null
  contextParts: ContextParts | null
  /** Whether the verification inputs carry no uncommitted change. */
  inputsClean: boolean
  /** A push's base choice: the proven base, its kind and reason, the merge base, the failed tests it re-runs. */
  choice: NativeBaseChoice | null
  mergeBase: string | null
  /** A push's count of the tests the same change from the merge base would run. */
  fullCount: () => number
}

export type LoadedSelectionInputs = SelectTestsInput & { account: SelectionAccount }

/**
 * Everything one selection needs, read from outside: the comparison base and the head, both inventory views, this
 * repository's policy, the read record, and the history — the failed tests of the last refused run, every earlier
 * complete pass and, after a default-branch merge, the branch's own changes. Every caller runs exactly
 * `plannedTests(selectTests(loadSelectionInputs(options)))`.
 */
export function loadSelectionInputs(options: LoadSelectionOptions): LoadedSelectionInputs {
  const { repoRoot } = options
  const reach = options.reach ?? ((root: string, commit: string) => nearestReachableRecord(root, commit))
  const platform = options.platform ?? process.platform
  const head = resolveCommit(repoRoot, options.head ?? 'HEAD')
  const headView = readTestInventory(repoRoot, { head }).head
  const repo = gitRepository(repoRoot)
  const inputsClean = verificationInputsDirty(repoRoot) === false
  const verificationContext = computeVerificationContext(repoRoot, runEnvironment())
  const context = nativeContext(verificationContext?.digest ?? null, headView.contextIdentity)
  const contextParts: ContextParts | null = verificationContext
    ? { ...verificationContext.parts, inventory: headView.contextIdentity }
    : null
  // A pass is reused only under a context this checkout's committed inputs fully decide.
  const usable = inputsClean ? context : null

  if (options.caller === 'ci') {
    if (!options.base) throw new Error('a CI selection needs the pull request base')
    const base = resolveCommit(repoRoot, options.base)
    const reached = reach(repoRoot, base)
    const change = repositorySelectionInput(repoRoot, { base, head, record: reached.record, platform })
    const passes = options.passes
      ? trustedCiPassEntries(repoRoot, options.passes, base, head, {
          repo,
          context: usable,
          records: change.records ?? null
        })
      : []
    const history: SelectionHistory = { context: usable, passes, failures: [] }
    return {
      ...change,
      history,
      branchSide: null,
      account: {
        caller: 'ci',
        recordNote: reached.reason,
        context,
        contextParts,
        inputsClean,
        choice: null,
        mergeBase: null,
        fullCount: () => 0
      }
    }
  }

  const branch = currentBranch(repoRoot)
  const remoteBase = options.base ?? resolveRemoteBase(repoRoot)
  const mergeBase = git(repoRoot, ['merge-base', remoteBase, head])
  if (!mergeBase) throw new Error(`no merge base between ${remoteBase} and ${head}`)
  const viewAt = (revision: string): InventoryView | null => {
    try {
      return readTestInventory(repoRoot, { head: revision }).head
    } catch {
      return null
    }
  }
  const factsIn = (view: InventoryView | null, id: string): TestRunnerFacts | null =>
    view?.tests.find((t) => t.id === id) ?? null
  const recordViews = new Map<string, InventoryView | null>()
  const recordView = (revision: string) => {
    if (!recordViews.has(revision)) recordViews.set(revision, viewAt(revision))
    return recordViews.get(revision) ?? null
  }
  const choice = chooseNativeBase({
    repoRoot,
    head,
    branch,
    mergeBase,
    failed: readFailedTestsRecord(repoRoot),
    passing: readPassingRecord(repoRoot),
    context,
    contextParts,
    inputsClean,
    isAncestor: (ancestor) => isAncestor(repoRoot, ancestor, head),
    exists: existsSync,
    changedBetween: (from) => changedBetween(repoRoot, from, head),
    mergeSince: (from) => newestMergeSince(repoRoot, from, head),
    mergeAware: {
      cleanMergeOnto: (recordHead) => cleanMergeOnto(repoRoot, recordHead),
      contextAtRecord: (recordHead) => {
        const view = recordView(recordHead)
        return view ? nativeContext(verificationContext?.digest ?? null, view.contextIdentity) : null
      },
      factsAtRecord: (recordHead, id) => factsIn(recordView(recordHead), id),
      factsNow: (id) => factsIn(headView, id)
    }
  })
  const relative = (path: string) => path.slice(repoRoot.length + 1)
  // The record is the merge base's; the comparison base may be a later proven head, and the selection checks the
  // record's own paths did not change between the two.
  const reached = reach(repoRoot, mergeBase)
  const change = repositorySelectionInput(repoRoot, { base: choice.base, head, record: reached.record, platform })
  const passes = [
    ...parsePassEntryFile(readJsonUnderGit(repoRoot, PASS_ENTRIES_FILE)),
    ...handRunPassEntries(repoRoot, repo, change.records ?? null)
  ]
  const history: SelectionHistory = { context: usable, passes, failures: choice.obligations.map(relative) }
  const sidePaths = choice.branchSide ? choice.branchSide.paths.map(relative) : []
  const branchSide: BranchSideInput | null = choice.branchSide
    ? {
        paths: sidePaths,
        base: () => {
          const commit = branchSideBase(repoRoot, choice.base, head, sidePaths)
          const view = commit ? viewAt(commit) : null
          return commit && view ? { commit, inventory: view } : null
        }
      }
    : null
  return {
    ...change,
    history,
    branchSide,
    account: {
      caller: 'push',
      recordNote: reached.reason,
      context,
      contextParts,
      inputsClean,
      choice,
      mergeBase,
      fullCount: () => {
        const fromMergeBase = repositorySelectionInput(repoRoot, {
          base: mergeBase,
          head,
          record: reached.record,
          platform
        })
        return plannedTests(selectTests({ ...fromMergeBase, history: { ...history, context: null, passes: [] } }))
          .length
      }
    }
  }
}

/**
 * A commit whose tree is the head's with only the branch-side paths (repository-relative) as they were at the
 * recorded head — present with that content, or absent when the recorded head lacks them — so the comparison from it
 * to the head changes exactly those paths. Built in a temporary index; the commit is written to the object store
 * unreferenced. `null` when any git step fails.
 */
export function branchSideBase(
  repoRoot: string,
  recordHead: string,
  head: string,
  paths: readonly string[]
): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-branch-side-'))
  const env = {
    ...cleanGitEnv(),
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'vinaya',
    GIT_AUTHOR_EMAIL: 'vinaya@localhost',
    GIT_COMMITTER_NAME: 'vinaya',
    GIT_COMMITTER_EMAIL: 'vinaya@localhost'
  }
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim()
  try {
    run(['read-tree', head])
    for (const path of paths) {
      const entry = run(['ls-tree', recordHead, '--', path])
      const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(entry)
      if (match) run(['update-index', '--add', '--cacheinfo', `${match[1]},${match[2]},${path}`])
      else if (entry === '') run(['update-index', '--force-remove', '--', path])
      else return null
    }
    const tree = run(['write-tree'])
    return run(['commit-tree', tree, '-p', recordHead, '-m', 'vinaya: the branch-side comparison base'])
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The plan of the tests the change from `base` to `head` requires, as CI plans it. */
export function repositorySelection(repoRoot: string, options: { base: string; head: string }): SelectionPlan {
  return selectTests(loadSelectionInputs({ repoRoot, caller: 'ci', base: options.base, head: options.head }))
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const base = argValue(argv, '--base')
  const head = argValue(argv, '--head') ?? 'HEAD'
  const recordFile = argValue(argv, '--record')
  if (!base) {
    process.stderr.write('usage: repository-selection.ts --base <rev> [--head <rev>] [--record <file>]\n')
    process.exitCode = 2
  } else {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const parsed = recordFile ? (JSON.parse(readFileSync(recordFile, 'utf8')) as unknown) : null
    const record = isReadRecord(parsed) ? parsed : null
    const plan = selectTests(
      loadSelectionInputs({
        repoRoot,
        caller: 'ci',
        base,
        head,
        reach: () => ({ record, reason: record ? 'the record given' : 'no record was given' })
      })
    )
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  }
}
