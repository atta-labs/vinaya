import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createTestTempRun,
  currentOwner,
  isOwnerAlive,
  makeFixtureDir,
  OWNER_MARKER_FILE,
  readOwnerMarker,
  removeTestTempRun,
  removeTree,
  sweepOwnedDirs,
  TEST_TEMP_ROOT_ENV,
  testTempRoot
} from '../../src/lib/test-temp'
import { fixtureDir } from './test-temp-fixture'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

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

describe('shared-directory cleanup', () => {
  test('never deletes unrelated released names, even with an ownership marker outside the selection', async () => {
    const root = fixtureDir('shared-sweep-')
    const unrelated = join(root, '.removing-some-other-program')
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, 'live-data'), 'keep')
    const report = await sweepOwnedDirs(root, { select: (name) => name.startsWith('vinaya-claude-sandbox-') })
    expect(existsSync(join(unrelated, 'live-data'))).toBe(true)
    expect(report.removed).toEqual([])
  })

  test('requires ownership evidence before finishing a released directory', async () => {
    const root = fixtureDir('shared-sweep-')
    const unrelated = join(root, '.removing-foreign')
    mkdirSync(unrelated)
    await sweepOwnedDirs(root)
    expect(existsSync(unrelated)).toBe(true)
  })
})

describe('fixture cleanup reporting', () => {
  test('released reviewer candidates regain owner write without changing symlink targets outside the owned run', () => {
    const root = fixtureDir('readonly-candidate-cleanup-')
    try {
      const module = resolve(import.meta.dir, 'test-temp-fixture.ts')
      const child = spawnSyncBudgeted(
        process.execPath,
        [
          '--eval',
          `
        import { fixtureDir, releaseFixtureRun } from ${JSON.stringify(module)};
        import { mkdirSync, writeFileSync, chmodSync, symlinkSync, statSync, existsSync } from 'node:fs';
        import { join, dirname, basename } from 'node:path';
        const outside = ${JSON.stringify(join(root, 'outside'))};
        mkdirSync(outside);
        writeFileSync(join(outside, 'keep.md'), 'keep');
        chmodSync(join(outside, 'keep.md'), 0o444);
        chmodSync(outside, 0o555);
        const fixture = fixtureDir('review-');
        const candidate = join(fixture, 'candidate');
        mkdirSync(candidate);
        writeFileSync(join(candidate, 'docs.md'), 'reviewed content');
        symlinkSync(outside, join(candidate, 'external'), 'dir');
        chmodSync(join(candidate, 'docs.md'), 0o444);
        chmodSync(candidate, 0o555);
        chmodSync(fixture, 0o555);
        const run = dirname(fixture);
        const claimed = join(dirname(run), '.removing-' + basename(run));
        const error = await releaseFixtureRun();
        console.log(JSON.stringify({ error, remaining: existsSync(claimed), receipt: existsSync(claimed + '.owner.json'),
          outsideMode: statSync(outside).mode & 0o777, fileMode: statSync(join(outside, 'keep.md')).mode & 0o777 }));
      `
        ],
        { encoding: 'utf8', env: { ...stripVinayaEnv(), VINAYA_TEST_TMP: join(root, 'runs') } }
      )
      expect(child.status).toBe(0)
      const result = JSON.parse(child.stdout.trim()) as Record<string, unknown>
      expect(result).toEqual({ error: null, remaining: false, receipt: false, outsideMode: 0o555, fileMode: 0o444 })
      expect(child.stderr).not.toContain('Permission denied')
    } finally {
      expect(removeTree(root)).toBeNull()
    }
  })

  test('a cleanup subprocess failure is returned and preserved for the next startup sweep', async () => {
    const root = fixtureDir('cleanup-report-')
    const module = resolve(import.meta.dir, 'test-temp-fixture.ts')
    const child = spawnSyncBudgeted(
      process.execPath,
      [
        '--eval',
        `
      import { fixtureDir, releaseFixtureRun } from ${JSON.stringify(module)};
      import { dirname } from 'node:path';
      const dir = dirname(fixtureDir('payload-'));
      const error = await releaseFixtureRun(['/bin/sh', '-c', 'echo injected-removal-denied >&2; exit 42', 'cleanup']);
      console.log(JSON.stringify({ dir, error }));
    `
      ],
      { encoding: 'utf8', env: { ...stripVinayaEnv(), VINAYA_TEST_TMP: root } }
    )
    expect(child.status).toBe(0)
    const result = JSON.parse(child.stdout.trim()) as { dir: string; error: string | null }
    expect(result.error).toContain('42')
    expect(child.stderr).toContain('injected-removal-denied')
    const report = await sweepOwnedDirs(join(root, 'vinaya'), {
      stop: async () => ({ backend: 'registry', terminated: [], killed: [], alreadyGone: [] })
    })
    expect(report.failed).toEqual([{ dir: expect.any(String), error: expect.stringContaining('42') }])
    expect(report.removed).toHaveLength(1)
  })
})

describe('read-only default test storage', () => {
  function sandboxHome() {
    const root = fixtureDir('readonly-home-')
    const home = join(root, 'home')
    const scratch = join(root, 'scratch')
    const defaultRoot = join(home, '.vinaya', 'test-tmp', 'vinaya')
    mkdirSync(defaultRoot, { recursive: true })
    mkdirSync(scratch)
    chmodSync(defaultRoot, 0o500)
    return { root, home, scratch, defaultRoot }
  }

  test('a heavy fixture falls back and recovers when the default root is read-only', async () => {
    const { root, home, scratch, defaultRoot } = sandboxHome()
    const fixtures = resolve(import.meta.dir, 'test-temp-fixture.ts')
    const storage = resolve(import.meta.dir, '../../src/lib/test-temp.ts')
    const env = { ...stripVinayaEnv(), HOME: home, TMPDIR: scratch }
    const child = spawnSyncBudgeted(
      process.execPath,
      [
        '--eval',
        `
      import { fixtureDir } from ${JSON.stringify(fixtures)};
      import { mkdirSync, writeFileSync, statSync } from 'node:fs';
      import { join } from 'node:path';
      const dir = fixtureDir('clone-');
      mkdirSync(join(dir, 'objects'));
      const data = join(dir, 'objects', 'pack');
      writeFileSync(data, Buffer.alloc(128 * 1024, 7));
      console.log(JSON.stringify({ dir, bytes: statSync(data).size }));
    `
      ],
      { encoding: 'utf8', cwd: root, env }
    )
    expect(child.status).toBe(0)
    const fixture = JSON.parse(child.stdout.trim()) as { dir: string; bytes: number }
    expect(fixture.dir.startsWith(join(scratch, 'vinaya-test-tmp', 'vinaya'))).toBe(true)
    expect(fixture.bytes).toBe(128 * 1024)
    expect(child.stderr).toContain(defaultRoot)
    expect(child.stderr).toContain('falling back')
    expect(child.stderr).toContain('VINAYA_TEST_TMP')
    const recovery = spawnSyncBudgeted(
      process.execPath,
      [
        '--eval',
        `
      import { sweepAbandoned } from ${JSON.stringify(storage)};
      console.log(JSON.stringify(await sweepAbandoned('vinaya')));
    `
      ],
      { encoding: 'utf8', cwd: root, env }
    )
    expect(recovery.status).toBe(0)
    const report = JSON.parse(recovery.stdout.trim()) as { removed: string[]; failed: unknown[] }
    expect(report.failed).toEqual([])
    expect(report.removed).toHaveLength(1)
    expect(existsSync(fixture.dir)).toBe(false)
  })

  test('preload does not allocate a heavy fixture for a test that never requests one', () => {
    const { root, home, scratch } = sandboxHome()
    const smoke = join(root, 'lazy.test.ts')
    writeFileSync(
      smoke,
      `
      import { test, expect } from 'bun:test';
      import { existsSync } from 'node:fs';
      test('lazy storage', () => {
        expect(process.env.VINAYA_STEP_ONE_TMP).toBeDefined();
        expect(existsSync(process.env.VINAYA_STEP_ONE_TMP!)).toBe(false);
        expect(existsSync(${JSON.stringify(join(scratch, 'vinaya-test-tmp'))})).toBe(false);
      });
    `
    )
    const child = spawnSyncBudgeted(
      process.execPath,
      ['test', '--preload', resolve(import.meta.dir, 'test-env-preload.ts'), smoke],
      { encoding: 'utf8', cwd: root, env: { ...stripVinayaEnv(), HOME: home, TMPDIR: scratch } }
    )
    expect(child.stderr).not.toContain('falling back')
    expect(child.status).toBe(0)
  })
})
