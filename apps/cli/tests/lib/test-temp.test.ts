import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  createTestTempRun,
  currentOwner,
  isOwnerAlive,
  makeFixtureDir,
  OWNER_MARKER_FILE,
  readOwnerMarker,
  removeTestTempRun,
  removeTree,
  TEST_TEMP_ROOT_ENV,
  testTempRoot
} from '../../src/lib/test-temp'
import { fixtureDir } from './test-temp-fixture'

function deadPid(): number {
  const child = spawnSync('true')
  return child.pid as number
}

describe('testTempRoot', () => {
  test('the setting names the root, with the repository id under it', () => {
    expect(testTempRoot('repo', { [TEST_TEMP_ROOT_ENV]: '/disk/tests' })).toBe('/disk/tests/repo')
  })

  test('the default is under the home directory and never follows the runtime directory', () => {
    expect(testTempRoot('repo', { VINAYA_RUNTIME_DIR: '/tmp/runtime' })).toBe(
      join(homedir(), '.vinaya', 'test-tmp', 'repo')
    )
  })
})

describe('createTestTempRun', () => {
  test('makes a run directory carrying host, pid, start time and run token', () => {
    const root = fixtureDir('test-temp-root-')
    const run = createTestTempRun('repo', root)
    expect(run.dir).toBe(join(root, run.marker.owner.runToken))
    const marker = readOwnerMarker(run.dir)
    expect(marker?.owner).toEqual({
      host: hostname(),
      pid: process.pid,
      startTime: run.marker.owner.startTime,
      runToken: run.marker.owner.runToken
    })
    expect(marker?.owner.startTime).not.toBe('unknown')
    expect(readdirSync(root)).toEqual([run.marker.owner.runToken])
  })

  test('a root that cannot be written is reported with the setting that moves it', () => {
    const blocker = join(fixtureDir('test-temp-root-'), 'file')
    writeFileSync(blocker, '')
    expect(() => createTestTempRun('repo', blocker)).toThrow(TEST_TEMP_ROOT_ENV)
  })
})

describe('makeFixtureDir', () => {
  test('creates a fresh directory inside the run', () => {
    const run = createTestTempRun('repo', fixtureDir('test-temp-root-'))
    const a = makeFixtureDir(run, 'clone-')
    const b = makeFixtureDir(run, 'clone-')
    expect(a.startsWith(join(run.dir, 'clone-'))).toBe(true)
    expect(a).not.toBe(b)
    expect(existsSync(a) && existsSync(b)).toBe(true)
  })
})

describe('isOwnerAlive', () => {
  test('this process is alive', () => {
    expect(isOwnerAlive(currentOwner('token'))).toBe(true)
  })

  test('an exited process is gone', () => {
    expect(isOwnerAlive({ ...currentOwner('token'), pid: deadPid() })).toBe(false)
  })

  test('a live pid with a different start time is a reused pid, so the owner is gone', () => {
    expect(isOwnerAlive({ ...currentOwner('token'), startTime: 'Thu Jan  1 00:00:00 1970' })).toBe(false)
  })

  test('an owner on another host is never judged gone from here', () => {
    expect(isOwnerAlive({ ...currentOwner('token'), host: `${hostname()}-elsewhere`, pid: deadPid() })).toBe(true)
  })
})

describe('removal', () => {
  test('removeTree removes a tree with read-only directories in it', () => {
    const dir = fixtureDir('test-temp-readonly-')
    mkdirSync(join(dir, 'cache', 'module'), { recursive: true })
    writeFileSync(join(dir, 'cache', 'module', 'file'), 'x')
    chmodSync(join(dir, 'cache', 'module'), 0o500)
    chmodSync(join(dir, 'cache'), 0o500)
    expect(removeTree(dir)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  test('removeTestTempRun removes the run and its fixtures, marker included', () => {
    const root = fixtureDir('test-temp-root-')
    const run = createTestTempRun('repo', root)
    writeFileSync(join(makeFixtureDir(run, 'world-'), 'f'), 'x')
    expect(existsSync(join(run.dir, OWNER_MARKER_FILE))).toBe(true)
    const report = removeTestTempRun(run)
    expect(report).toEqual({ removed: [run.dir], kept: [], failed: [] })
    expect(readdirSync(root)).toEqual([])
  })
})
