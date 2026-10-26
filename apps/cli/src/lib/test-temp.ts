import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { type ProcessIdentity, type StopOptions, type StopReport, stopRegistered } from './process-registry'

// Test temp storage on disk, with owned cleanup.
//
// Heavy test fixtures (clones, replay worlds, engine runs, review inputs) create their directories under one
// disk-backed root, never under the OS temp dir, so a quota-limited tmpfs cannot fill. The root comes from its
// own setting, default `~/.vinaya/test-tmp/<repo-id>/<run-uuid>`, and is never derived from VINAYA_RUNTIME_DIR
// (the test preload redirects that into temporary storage). Every run directory carries an ownership marker; a
// sweep removes a directory only when its owner is gone, after stopping the owner's surviving processes.
//
// Removal first renames a directory to a `.removing-` name, so a removal interrupted half-way (a killed process,
// a read-only subtree) is recognisable as released and the next sweep finishes it without asking about owners.

/** The environment variable that sets the test-temp root; CI sets it explicitly to a disk path. */
export const TEST_TEMP_ROOT_ENV = 'VINAYA_TEST_TMP'

/** The marker file's name inside an owned directory. */
export const OWNER_MARKER_FILE = '.vinaya-owner.json'

const REMOVING_PREFIX = '.removing-'
// A run directory under construction; its marker is written before the rename, so it is judged like any other.
const CREATING_PREFIX = '.creating-'

/** Who owns a run directory. */
export interface TestTempOwner extends ProcessIdentity {
  host: string
  /** A random token naming this test run; also the process registry's run token. */
  runToken: string
}

/** The marker file written into every run directory. */
export interface TestTempMarker {
  owner: TestTempOwner
  createdAt: string
}

/** One test run's directory under the root. */
export interface TestTempRun {
  /** `<root>/<repo-id>/<run-uuid>` */
  dir: string
  marker: TestTempMarker
}

/** What a sweep did. */
export interface SweepReport {
  removed: string[]
  /** Directories kept because their owner is alive or on another host. */
  kept: string[]
  /** Directories whose removal failed, with the error; never swallowed. */
  failed: Array<{ dir: string; error: string }>
}

/** The start time the OS reports for `pid`, or null when it cannot be read (no such process, or no `ps`). */
export function processStartTime(pid: number): string | null {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/bin:/usr/bin', LC_ALL: 'C' }
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  const text = result.stdout.trim()
  return text === '' ? null : text
}

let ownStartTime: string | undefined
/** This process as an owner of directories under `runToken`. */
export function currentOwner(runToken: string): TestTempOwner {
  ownStartTime ??= processStartTime(process.pid) ?? 'unknown'
  return { host: hostname(), pid: process.pid, startTime: ownStartTime, runToken }
}

/** Writes the ownership marker into `dir`. */
export function writeOwnerMarker(dir: string, owner: TestTempOwner): TestTempMarker {
  const marker: TestTempMarker = { owner, createdAt: new Date().toISOString() }
  writeFileSync(join(dir, OWNER_MARKER_FILE), `${JSON.stringify(marker)}\n`)
  return marker
}

/** The marker in `dir`, or null when there is none or it does not parse. */
export function readOwnerMarker(dir: string): TestTempMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, OWNER_MARKER_FILE), 'utf8')) as TestTempMarker
    const o = parsed?.owner
    if (
      typeof o?.host !== 'string' ||
      typeof o.pid !== 'number' ||
      typeof o.startTime !== 'string' ||
      typeof o.runToken !== 'string'
    )
      return null
    return parsed
  } catch {
    return null
  }
}

/** The test-temp root for `repoId`: the setting when present, otherwise the default under the home directory. */
export function testTempRoot(repoId: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env[TEST_TEMP_ROOT_ENV]
  const base = configured !== undefined && configured !== '' ? configured : join(homedir(), '.vinaya', 'test-tmp')
  return join(base, repoId)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An error that names where test temp lives and how to move it, for a write the disk refused. */
function storageError(action: string, path: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code
  const space = code === 'ENOSPC' || code === 'EDQUOT' ? ' (no space or quota left)' : ''
  return new Error(
    `test temp: could not ${action} ${path}${space}: ${describeError(error)} — set ${TEST_TEMP_ROOT_ENV} to a disk path with room`,
    { cause: error }
  )
}

/** Creates this process's run directory with its ownership marker, under `root` (default: `testTempRoot`). */
export function createTestTempRun(repoId: string, root: string = testTempRoot(repoId)): TestTempRun {
  const owner = currentOwner(randomUUID())
  const dir = join(root, owner.runToken)
  // Built under a staging name and renamed, so the run directory never exists without its marker.
  const staging = join(root, `${CREATING_PREFIX}${owner.runToken}`)
  try {
    mkdirSync(staging, { recursive: true })
    const marker = writeOwnerMarker(staging, owner)
    renameSync(staging, dir)
    return { dir, marker }
  } catch (error) {
    throw storageError('create the test-temp run directory', dir, error)
  }
}

export interface FixtureDirDeps {
  mkdir: (path: string) => void
}

/** Creates a fixture directory inside `run`, for a test to use instead of the OS temp dir. */
export function makeFixtureDir(
  run: TestTempRun,
  prefix: string,
  deps: FixtureDirDeps = { mkdir: (p) => mkdirSync(p) }
): string {
  const dir = join(run.dir, `${prefix}${randomUUID().slice(0, 8)}`)
  try {
    deps.mkdir(dir)
  } catch (error) {
    throw storageError('create the fixture directory', dir, error)
  }
  return dir
}

/** True when `owner` is on this host and its process (pid plus start time) is still running. */
export function isOwnerAlive(owner: TestTempOwner): boolean {
  if (owner.host !== hostname()) return true
  try {
    process.kill(owner.pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  const now = processStartTime(owner.pid)
  // A start time that cannot be read is no proof the owner is gone; only a different one is (a reused pid).
  if (now === null || owner.startTime === 'unknown') return true
  return now === owner.startTime
}

/** Makes every directory under `dir` writable so its entries can be unlinked; files need no change. */
function makeTreeWritable(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) return
    chmodSync(dir, 0o700)
    for (const entry of readdirSync(dir)) makeTreeWritable(join(dir, entry))
  } catch {
    // The removal that follows reports what is still in the way.
  }
}

/**
 * Removes `dir` and everything in it, read-only subdirectories included (a module cache or a tool's sandbox
 * marks them read-only, which a plain recursive remove cannot unlink). Returns the error text, or null.
 */
export function removeTree(dir: string): string | null {
  try {
    rmSync(dir, { recursive: true, force: true })
    return null
  } catch (first) {
    const code = (first as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') return describeError(first)
  }
  makeTreeWritable(dir)
  try {
    rmSync(dir, { recursive: true, force: true })
    return null
  } catch (second) {
    return describeError(second)
  }
}

/** Releases `dir` (renamed to a `.removing-` name beside it), then removes it; the result goes into `report`. */
function releaseAndRemove(dir: string, report: SweepReport): void {
  const released = join(dirname(dir), `${REMOVING_PREFIX}${basename(dir)}`)
  try {
    renameSync(dir, released)
  } catch (error) {
    // Another sweep released it first; that one finishes it.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    report.failed.push({ dir, error: describeError(error) })
    return
  }
  const error = removeTree(released)
  if (error === null) report.removed.push(dir)
  else report.failed.push({ dir, error })
}

/** Removes `run`'s directories and reports every error. */
export function removeTestTempRun(run: TestTempRun): SweepReport {
  const report: SweepReport = { removed: [], kept: [], failed: [] }
  releaseAndRemove(run.dir, report)
  return report
}

export interface SweepDeps {
  /** Stops a gone owner's surviving processes; the process registry's `stopRegistered` by default. */
  stop: (runToken: string, opts: StopOptions) => Promise<StopReport>
  graceMs: number
  /** Which entries of the parent directory the sweep judges; every entry by default. */
  select: (name: string) => boolean
}

const DEFAULT_SWEEP: SweepDeps = { stop: stopRegistered, graceMs: 2000, select: () => true }

/**
 * Sweeps the owned directories directly under `parent`: a released (`.removing-`) one is finished; one whose
 * owner is gone has the owner's processes stopped, then is removed; one whose owner is alive, on another host,
 * or unknown (no marker) is kept. A stop that fails leaves the directory in place and is reported.
 */
export async function sweepOwnedDirs(parent: string, deps: Partial<SweepDeps> = {}): Promise<SweepReport> {
  const { stop, graceMs, select } = { ...DEFAULT_SWEEP, ...deps }
  const report: SweepReport = { removed: [], kept: [], failed: [] }
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return report
    report.failed.push({ dir: parent, error: describeError(error) })
    return report
  }
  for (const name of names) {
    const dir = join(parent, name)
    if (name.startsWith(REMOVING_PREFIX)) {
      const error = removeTree(dir)
      if (error === null) report.removed.push(dir)
      else report.failed.push({ dir, error })
      continue
    }
    if (!select(name)) continue
    const marker = readOwnerMarker(dir)
    if (marker === null || isOwnerAlive(marker.owner)) {
      report.kept.push(dir)
      continue
    }
    try {
      await stop(marker.owner.runToken, { graceMs })
    } catch (error) {
      report.failed.push({ dir, error: `stopping the owner's processes failed: ${describeError(error)}` })
      continue
    }
    releaseAndRemove(dir, report)
  }
  return report
}

/** Removes abandoned run directories under the root: stops owned processes first, never touches a live owner's. */
export function sweepAbandoned(
  repoId: string,
  deps: Partial<SweepDeps> & { root?: string } = {}
): Promise<SweepReport> {
  const { root, ...rest } = deps
  return sweepOwnedDirs(root ?? testTempRoot(repoId), rest)
}
