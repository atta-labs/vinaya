import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { currentRunId, type LogSinkDeps } from '../../../kernel/log/log-sink'
import {
  currentOwner,
  removeTree,
  TEST_TEMP_ROOT_ENV,
  testTempRoot,
  writeOwnerMarker
} from '../../../kernel/conformance/unit/test-temp'
import { TEST_TEMP_REPO_ID } from '../../../kernel/conformance/unit/test-temp-fixture'
import type { Agent } from '../bin/run-engine'
import type { Observation } from '../integration/conformance/unit/dev-review-current-loop-adapter'
import type { EngineScenarioRun } from './dev-review-engine-loop-adapter'

// The two adapters load the whole Engine and standalone loop; they are imported only when a run is computed, so a
// process that only reads the store (or its unit test's child processes) never loads them.
const engineAdapter = () => import('./dev-review-engine-loop-adapter')
const standaloneAdapter = () => import('../integration/conformance/unit/dev-review-current-loop-adapter')

/**
 * The engine corpus store: one cross-process, content-addressed record of each corpus scenario's run, so the tests
 * that read the corpus (the architecture exit gate, the Log replay, the Engine shadow suite and the fault rows) run
 * each scenario once per content key and share it.
 *
 * An entry is one scenario's run on one runner (the Engine for one agent, or the standalone loop), taken with one
 * kind of Log sink: its observation, and for an Engine run a copy of the scenario's whole ended root (its repository,
 * runtime folder and stub login) taken before the adapter's cleanup. Its key covers the scenario, the runner, the
 * agent, the sink kind, and a digest of every source file a run can execute: the working-tree path and bytes of every
 * tracked and untracked (not ignored) file under `harness/kernel`, `harness/processes/vinaya-strict` and `packages`,
 * plus `bun.lock` and every `package.json`, so an uncommitted edit changes the key too.
 *
 * An entry is built whole under a staging name beside its final one and published by one atomic rename: a reader
 * sees no entry or a complete one, never a partial one. Two processes that miss together may both compute; the
 * first rename wins and the other reads the winner. Entries live under the test-temp root, never in the repository:
 * with `VINAYA_TEST_TMP` set (a scheduled run's own root, or a review round's) an entry carries no owner marker, so
 * the next test process's sweep keeps it and the run's own removal takes it; with it unset, under the shared default
 * root, an entry carries its writer's owner marker, so the abandoned-run sweep removes it once that process is gone.
 *
 * Only plain runs are stored. A run given `shadow` or `between`, a fault-only scenario, and a run through a failing
 * sink test the execution itself and go to the adapter directly.
 */

/** Bumped whenever an entry's layout or meaning changes, so an older entry is never read as a newer one. */
const STORE_VERSION = 1
const ENTRY_PREFIX = 'engine-corpus-'
const ENTRY_FILE = 'entry.json'
const FILES_DIR = 'files'
// The same staging prefix the test-temp run directories use, so the sweep judges an abandoned one by its marker.
const STAGING_PREFIX = '.creating-'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
/** The folders and files whose working-tree content a corpus run can execute or read. */
export const SOURCE_PATHSPECS = [
  'harness/kernel',
  'harness/processes/vinaya-strict',
  'packages',
  'bun.lock',
  ':(glob)**/package.json'
] as const

/** The runner a stored run went through. */
export type CorpusRunner = 'engine' | 'standalone'

/** A Log sink a corpus run is given, named by its kind: runs with different kinds are different entries. */
export interface CorpusSink {
  kind: string
  deps: Partial<LogSinkDeps>
}

/** What a stored entry identifies. */
export interface CorpusKeyParts {
  scenario: string
  runner: CorpusRunner
  /** The Engine run's agent; null for a standalone run. */
  agent: Agent | null
  /** `none` for a run given no sink. */
  sink: string
  sources: string
}

/** The content key of one stored run. */
export function corpusKey(parts: CorpusKeyParts): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: STORE_VERSION,
        scenario: parts.scenario,
        runner: parts.runner,
        agent: parts.agent,
        sink: parts.sink,
        sources: parts.sources
      })
    )
    .digest('hex')
}

function gitPaths(repoRoot: string, extra: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...extra, '--', ...SOURCE_PATHSPECS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
    .split('\0')
    .filter(Boolean)
}

/**
 * The digest of every source file a corpus run can execute, read from `repoRoot`'s working tree: each tracked and
 * each untracked, not ignored, path under {@link SOURCE_PATHSPECS}, with its bytes (a symbolic link's target, or a
 * marker for a tracked path deleted from the tree).
 */
export function sourceDigest(repoRoot: string): string {
  const paths = [...new Set([...gitPaths(repoRoot, []), ...gitPaths(repoRoot, ['--others', '--exclude-standard'])])]
  paths.sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    const full = join(repoRoot, path)
    let content: Buffer
    let kind: string
    try {
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) {
        kind = 'link'
        content = Buffer.from(readlinkSync(full))
      } else if (stat.isFile()) {
        kind = 'file'
        content = readFileSync(full)
      } else {
        kind = 'other'
        content = Buffer.alloc(0)
      }
    } catch {
      kind = 'missing'
      content = Buffer.alloc(0)
    }
    hash.update(`${path}\0${kind}\0${content.length}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}

const digests = new Map<string, string>()
/** {@link sourceDigest}, computed once per process for each repository root. */
export function processSourceDigest(repoRoot: string = REPO_ROOT): string {
  let digest = digests.get(repoRoot)
  if (digest === undefined) {
    digest = sourceDigest(repoRoot)
    digests.set(repoRoot, digest)
  }
  return digest
}

// --- copying an ended scenario root -------------------------------------------------------------------------------

/**
 * Copies the tree at `from` into `to` (which must not exist): files with their bytes and mode, symbolic links as
 * links, folders created writable whatever their own mode, so a read-only folder is copied as it is. Sockets, pipes
 * and devices are skipped. Returns each folder's own mode, by path relative to `to`, for {@link applyFolderModes}.
 */
export function copyTree(from: string, to: string): Record<string, number> {
  const modes: Record<string, number> = {}
  const walk = (source: string, target: string, rel: string) => {
    const stat = lstatSync(source)
    if (stat.isDirectory()) {
      mkdirSync(target, { mode: 0o700 })
      chmodSync(target, 0o700)
      modes[rel] = stat.mode & 0o7777
      for (const name of readdirSync(source)) walk(join(source, name), join(target, name), rel ? join(rel, name) : name)
    } else if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target)
    } else if (stat.isFile()) {
      copyFileSync(source, target)
      chmodSync(target, stat.mode & 0o7777)
    }
  }
  walk(from, to, '')
  return modes
}

/** Gives each folder under `root` the mode it had where it was copied from, deepest first. */
export function applyFolderModes(root: string, modes: Record<string, number>): void {
  const paths = Object.keys(modes).sort((a, b) => b.length - a.length)
  for (const rel of paths) chmodSync(rel ? join(root, rel) : root, modes[rel]!)
}

// --- the store ----------------------------------------------------------------------------------------------------

interface EntryRecord {
  version: number
  key: string
  observation: Observation
  /** The writer's own Log run id: the default sink's lines name it, and a reader names its own instead. */
  producerRunId: string
  /** Each copied folder's mode, when the entry holds the run's ended files. */
  folderModes: Record<string, number> | null
}

/** One stored run, as a reader gets it. */
export interface StoredRun {
  observation: Observation
  /** The entry's folder: its ended files are in `files` beneath it, when it holds any. */
  entryDir: string
  folderModes: Record<string, number> | null
  /** True when the entry was already there, so this call ran nothing. */
  reused: boolean
}

export interface CorpusStoreOptions {
  /** Where entries live. */
  dir: string
  /** Whether each entry carries this process's owner marker, for the abandoned-run sweep. */
  ownerMarker: boolean
}

/** The store's place: under the test-temp root, with owner markers only when `VINAYA_TEST_TMP` is unset. */
export function defaultStoreOptions(
  env: Readonly<Record<string, string | undefined>> = process.env
): CorpusStoreOptions {
  const configured = env[TEST_TEMP_ROOT_ENV] !== undefined && env[TEST_TEMP_ROOT_ENV] !== ''
  const dir = testTempRoot(TEST_TEMP_REPO_ID, env)
  if (configured) return { dir, ownerMarker: false }
  try {
    // A folder that exists is not yet one this process may write in (a sandbox can deny the home root): probe it.
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `${STAGING_PREFIX}probe-${randomUUID()}`)
    mkdirSync(probe)
    rmdirSync(probe)
    return { dir, ownerMarker: true }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EROFS' && code !== 'EACCES' && code !== 'EPERM') throw error
    // The same fallback the test-temp run directories take, which the abandoned-run sweep also reads.
    return { dir: join(tmpdir(), 'vinaya-test-tmp', TEST_TEMP_REPO_ID), ownerMarker: true }
  }
}

/** One token for every owner marker this process writes. */
const PROCESS_RUN_TOKEN = randomUUID()

function readEntry(entryDir: string, key: string): EntryRecord | null {
  try {
    const record = JSON.parse(readFileSync(join(entryDir, ENTRY_FILE), 'utf8')) as EntryRecord
    if (record?.version !== STORE_VERSION || record.key !== key || typeof record.observation !== 'object') return null
    if (record.folderModes !== null && !existsSync(join(entryDir, FILES_DIR))) return null
    return record
  } catch {
    return null
  }
}

/** The observation as this process would have recorded it: the writer's Log run id read as this process's own. */
function asOwnRun(record: EntryRecord): Observation {
  const own = currentRunId()
  if (record.producerRunId === own || record.producerRunId === '') return record.observation
  return JSON.parse(JSON.stringify(record.observation).split(record.producerRunId).join(own)) as Observation
}

/** The published entry for `key`, or null when there is none (or none that reads whole). Runs nothing. */
export function peekEntry(options: CorpusStoreOptions, key: string): StoredRun | null {
  const entryDir = join(options.dir, `${ENTRY_PREFIX}${key}`)
  const record = readEntry(entryDir, key)
  return record === null
    ? null
    : { observation: asOwnRun(record), entryDir, folderModes: record.folderModes, reused: true }
}

/**
 * Computations in this process run one at a time: a scenario run sets process-wide variables and the working
 * directory, so two at once would see each other's.
 */
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

/**
 * Reads the entry for `key`, or computes it once and publishes it. `compute` writes the run's ended files (when it
 * keeps any) into the folder it is handed, and returns the observation and the copied folders' modes.
 */
export function obtainEntry(
  options: CorpusStoreOptions,
  key: string,
  compute: (filesDir: string) => Promise<{ observation: Observation; folderModes: Record<string, number> | null }>
): Promise<StoredRun> {
  return serialized(async () => {
    const entryDir = join(options.dir, `${ENTRY_PREFIX}${key}`)
    const existing = peekEntry(options, key)
    if (existing !== null) return existing
    mkdirSync(options.dir, { recursive: true })
    const staging = join(options.dir, `${STAGING_PREFIX}${ENTRY_PREFIX}${key}-${randomUUID()}`)
    mkdirSync(staging)
    if (options.ownerMarker) writeOwnerMarker(staging, currentOwner(PROCESS_RUN_TOKEN))
    let record: EntryRecord
    try {
      const computed = await compute(join(staging, FILES_DIR))
      record = {
        version: STORE_VERSION,
        key,
        observation: computed.observation,
        producerRunId: currentRunId(),
        folderModes: computed.folderModes
      }
      // The record is the entry's last file, written before the rename that publishes the whole folder.
      writeFileSync(join(staging, ENTRY_FILE), `${JSON.stringify(record)}\n`)
    } catch (error) {
      removeTree(staging)
      throw error
    }
    try {
      renameSync(staging, entryDir)
      return { observation: record.observation, entryDir, folderModes: record.folderModes, reused: false }
    } catch {
      // Another process published this key first: read its entry, and drop this one.
      const winner = readEntry(entryDir, key)
      if (winner !== null) {
        removeTree(staging)
        return { observation: asOwnRun(winner), entryDir, folderModes: winner.folderModes, reused: true }
      }
      // An unreadable entry under the final name is never read: this run's own staged copy serves the call.
      return { observation: record.observation, entryDir: staging, folderModes: record.folderModes, reused: false }
    }
  })
}

/** Restores an entry's ended files to a fresh folder, with each folder's own mode, and returns that folder. */
export function restoreEndedFiles(run: StoredRun): string {
  if (run.folderModes === null) throw new Error(`the stored run at ${run.entryDir} holds no ended files`)
  const parent = mkdtempSync(join(tmpdir(), 'engine-corpus-restored-'))
  const root = join(parent, 'root')
  copyTree(join(run.entryDir, FILES_DIR), root)
  applyFolderModes(root, run.folderModes)
  return root
}

// --- the corpus tests' entry points -------------------------------------------------------------------------------

function sinkKind(sink: CorpusSink | undefined): string {
  return sink === undefined ? 'none' : sink.kind
}

/**
 * A corpus scenario's Engine run for `agent`, from the store: run at most once per content key, its observation and
 * ended files shared by every test process of the run. Given `inspect`, the inspection reads a restored copy of the
 * run's ended files, inside the environment the adapter gives its own inspection.
 */
export async function storedEngineScenario(
  id: string,
  agent: Agent,
  options: { sink?: CorpusSink; inspect?: (run: EngineScenarioRun) => Promise<void> | void } = {},
  store: CorpusStoreOptions = defaultStoreOptions()
): Promise<Observation> {
  const { captureEngineScenario, ENGINE_SCENARIO_DRIVERS, inspectEndedEngineScenario } = await engineAdapter()
  if (ENGINE_SCENARIO_DRIVERS[id] === undefined) throw new Error(`${id} is not a corpus scenario`)
  const key = corpusKey({
    scenario: id,
    runner: 'engine',
    agent,
    sink: sinkKind(options.sink),
    sources: processSourceDigest()
  })
  const run = await obtainEntry(store, key, async (filesDir) => {
    let folderModes: Record<string, number> | null = null
    const observation = await captureEngineScenario(id, agent, options.sink?.deps, (root) => {
      folderModes = copyTree(root, filesDir)
    })
    if (folderModes === null) throw new Error(`the Engine run of ${id} ended without handing over its files`)
    return { observation, folderModes }
  })
  if (options.inspect !== undefined) {
    const inspect = options.inspect
    const root = restoreEndedFiles(run)
    try {
      await serialized(() => inspectEndedEngineScenario(id, agent, root, options.sink?.deps, inspect))
    } finally {
      removeTree(join(root, '..'))
    }
  }
  return run.observation
}

/** A corpus scenario's standalone run, from the store: run at most once per content key and sink kind. */
export async function storedStandaloneScenario(
  id: string,
  options: { sink?: CorpusSink } = {},
  store: CorpusStoreOptions = defaultStoreOptions()
): Promise<Observation> {
  const key = corpusKey({
    scenario: id,
    runner: 'standalone',
    agent: null,
    sink: sinkKind(options.sink),
    sources: processSourceDigest()
  })
  const { runStandaloneScenario } = await standaloneAdapter()
  const run = await obtainEntry(store, key, async () => ({
    observation: await runStandaloneScenario(id, options.sink?.deps),
    folderModes: null
  }))
  return run.observation
}
