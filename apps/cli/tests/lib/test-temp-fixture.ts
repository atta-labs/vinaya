import {
  createTestTempRun,
  makeFixtureDir,
  removeTestTempRun,
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

/** Removes this process's run directory, when one was made; the report carries every failure. */
export function releaseFixtureRun(): SweepReport | null {
  if (run === null) return null
  const report = removeTestTempRun(run)
  run = null
  return report
}

/** Sweeps run directories earlier test processes abandoned. */
export function sweepAbandonedFixtureRuns(): Promise<SweepReport> {
  return sweepAbandoned(TEST_TEMP_REPO_ID)
}
