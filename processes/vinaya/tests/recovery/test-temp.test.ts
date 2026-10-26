import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StopOptions, StopReport } from '../../../../apps/cli/src/lib/process-registry'
import {
  createTestTempRun,
  currentOwner,
  makeFixtureDir,
  readOwnerMarker,
  sweepAbandoned,
  writeOwnerMarker
} from '../../../../apps/cli/src/lib/test-temp'
import { fixtureDir } from '../../../../apps/cli/tests/lib/test-temp-fixture'
import { ALL_RUNNERS } from './runners'

// Test temp storage on disk with owned cleanup. The storage is shared by every runner's fixtures, so each case
// runs once per runner against its own root.

/** A run directory whose owner has exited, as a killed test process leaves it. */
function abandonedRun(root: string): { dir: string; runToken: string } {
  const pid = spawnSync('true').pid as number
  const owner = { ...currentOwner(`dead-${pid}-${Math.random().toString(36).slice(2)}`), pid }
  const dir = join(root, owner.runToken)
  mkdirSync(join(dir, 'replay-repo-1', 'objects'), { recursive: true })
  writeFileSync(join(dir, 'replay-repo-1', 'objects', 'pack'), 'x')
  writeOwnerMarker(dir, owner)
  return { dir, runToken: owner.runToken }
}

function recordingStop(root: string, calls: Array<{ runToken: string; present: string[] }>) {
  return async (runToken: string, _opts: StopOptions): Promise<StopReport> => {
    calls.push({ runToken, present: readdirSync(root) })
    return { backend: 'registry', terminated: [], killed: [], alreadyGone: [] }
  }
}

describe.each(ALL_RUNNERS)('%s', () => {
  test('quota or peak-space exhaustion during a test run is reported, not hidden', () => {
    const run = createTestTempRun('repo', fixtureDir('recovery-temp-'))
    const full = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    expect(() => makeFixtureDir(run, 'engine-run-', { mkdir: full })).toThrow(
      /could not create the fixture directory .*engine-run-.* \(no space or quota left\).*VINAYA_TEST_TMP/
    )
  })

  test('an interrupted cleanup is finished by the next sweep', async () => {
    const root = fixtureDir('recovery-temp-')
    const run = createTestTempRun('repo', root)
    const fixture = makeFixtureDir(run, 'lifecycle-')
    mkdirSync(join(fixture, 'cache', 'pkg'), { recursive: true })
    writeFileSync(join(fixture, 'cache', 'pkg', 'index.js'), 'x')
    chmodSync(join(fixture, 'cache', 'pkg'), 0o500)
    // The owner released its directory, then died before the removal finished (the marker may already be gone).
    const released = join(root, `.removing-${run.marker.owner.runToken}`)
    renameSync(run.dir, released)
    const stops: Array<{ runToken: string; present: string[] }> = []
    const report = await sweepAbandoned('repo', { root, stop: recordingStop(root, stops) })
    expect(report).toEqual({ removed: [released], kept: [], failed: [] })
    expect(readdirSync(root)).toEqual([])
    expect(stops).toEqual([])
  })

  test('an abandoned run directory is swept and a live owner keeps its directory', async () => {
    const root = fixtureDir('recovery-temp-')
    const live = createTestTempRun('repo', root)
    const liveFixture = makeFixtureDir(live, 'handoff-run-')
    const abandoned = abandonedRun(root)
    const stops: Array<{ runToken: string; present: string[] }> = []
    const report = await sweepAbandoned('repo', { root, stop: recordingStop(root, stops) })
    expect(report).toEqual({ removed: [abandoned.dir], kept: [live.dir], failed: [] })
    // The owner's processes were stopped while its directory still existed, before the delete.
    expect(stops.map((s) => s.runToken)).toEqual([abandoned.runToken])
    expect(stops[0]?.present).toContain(abandoned.runToken)
    expect(existsSync(abandoned.dir)).toBe(false)
    expect(existsSync(liveFixture)).toBe(true)
    expect(readOwnerMarker(live.dir)).toEqual(live.marker)
  })

  test('a failed stop leaves the abandoned directory in place and reports it', async () => {
    const root = fixtureDir('recovery-temp-')
    const abandoned = abandonedRun(root)
    const report = await sweepAbandoned('repo', {
      root,
      stop: async () => {
        throw new Error('registry unreachable')
      }
    })
    expect(report.removed).toEqual([])
    expect(report.failed).toEqual([{ dir: abandoned.dir, error: expect.stringContaining('registry unreachable') }])
    expect(existsSync(abandoned.dir)).toBe(true)
  })
})
