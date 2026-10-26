import type { ProcessIdentity } from './process-registry'

// Owner: agent C (test temp storage on disk, with owned cleanup).
// Shared interface only: types and stubs, no behaviour yet.
//
// Heavy test fixtures (clones, replay worlds, engine runs, review inputs) create their directories under one
// disk-backed root, never under the OS temp dir, so a quota-limited tmpfs cannot fill. The root comes from its
// own setting, default `~/.vinaya/test-tmp/<repo-id>/<run-uuid>`, and is never derived from VINAYA_RUNTIME_DIR
// (the test preload redirects that into temporary storage). Every run directory carries an ownership marker; a
// sweep removes a directory only when its owner is gone, after stopping the owner's surviving processes.

/** The environment variable that sets the test-temp root; CI sets it explicitly to a disk path. */
export const TEST_TEMP_ROOT_ENV = 'VINAYA_TEST_TMP'

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

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`)
}

/** The test-temp root for `repoId`: the setting when present, otherwise the default under the home directory. */
export function testTempRoot(_repoId: string, _env?: Readonly<Record<string, string | undefined>>): string {
  return notImplemented('testTempRoot')
}

/** Creates this process's run directory with its ownership marker. */
export function createTestTempRun(_repoId: string): TestTempRun {
  return notImplemented('createTestTempRun')
}

/** Creates a fixture directory inside `run`, for a test to use instead of the OS temp dir. */
export function makeFixtureDir(_run: TestTempRun, _prefix: string): string {
  return notImplemented('makeFixtureDir')
}

/** True when `owner` is on this host and its process (pid plus start time) is still running. */
export function isOwnerAlive(_owner: TestTempOwner): boolean {
  return notImplemented('isOwnerAlive')
}

/** Removes `run`'s directories and reports every error. */
export function removeTestTempRun(_run: TestTempRun): SweepReport {
  return notImplemented('removeTestTempRun')
}

/** Removes abandoned run directories under the root: stops owned processes first, never touches a live owner's. */
export function sweepAbandoned(_repoId: string): Promise<SweepReport> {
  return notImplemented('sweepAbandoned')
}
