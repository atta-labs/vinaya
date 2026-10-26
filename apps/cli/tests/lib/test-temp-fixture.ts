import { spawn } from 'node:child_process'
import {
  claimTestTempRun,
  createTestTempRun,
  makeFixtureDir,
  type SweepReport,
  sweepAbandoned,
  type TestTempRun
} from '../../src/lib/test-temp'

// One test process's heavy-fixture storage: a run directory on disk (see `test-temp.ts`), created on first use and
// removed by the test preload once every test file has run.

/** The repository id this repository's tests file their run directories under. */
export const TEST_TEMP_REPO_ID = 'vinaya'

let run: TestTempRun | null = null

/** A fresh fixture directory for a heavy fixture, in place of `mkdtempSync(join(tmpdir(), prefix))`. */
export function fixtureDir(prefix: string): string {
  run ??= createTestTempRun(TEST_TEMP_REPO_ID)
  return makeFixtureDir(run, prefix)
}

/**
 * Releases this process's run directory once every test file has run: it is claimed (a quick rename), and the
 * claimed directory alone is deleted by a detached `rm` that outlives this process, so a run holding hundreds of
 * fixtures never holds up the test process's exit. What that `rm` leaves (a read-only subtree) the next process's
 * startup sweep finishes, and reports if it cannot. A failed claim is returned as the error.
 */
export function releaseFixtureRun(): string | null {
  if (run === null) return null
  const result = claimTestTempRun(run)
  if ('error' in result) return `${run.dir}: ${result.error}`
  run = null
  spawn('rm', ['-rf', result.claimed], { detached: true, stdio: 'ignore' }).unref()
  return null
}

/** Sweeps run directories earlier test processes abandoned. */
export function sweepAbandonedFixtureRuns(): Promise<SweepReport> {
  return sweepAbandoned(TEST_TEMP_REPO_ID)
}
