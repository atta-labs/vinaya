import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
} from './test-temp'
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

  test('a released run another process removed first is no cleanup failure', async () => {
    const root = fixtureDir('cleanup-race-')
    const module = resolve(import.meta.dir, 'test-temp-fixture.ts')
    // The remover finds its tree already being removed by another sweep: the tree is gone, and its own step fails.
    const child = spawnSyncBudgeted(
      process.execPath,
      [
        '--eval',
        `
      import { fixtureDir, releaseFixtureRun } from ${JSON.stringify(module)};
      import { dirname } from 'node:path';
      const dir = dirname(fixtureDir('payload-'));
      const error = await releaseFixtureRun(['/bin/sh', '-c', 'rm -rf "$1"; echo raced >&2; exit 1', 'cleanup']);
      console.log(JSON.stringify({ dir, error }));
    `
      ],
      { encoding: 'utf8', env: { ...stripVinayaEnv(), VINAYA_TEST_TMP: root } }
    )
    expect(child.status).toBe(0)
    const result = JSON.parse(child.stdout.trim()) as { dir: string; error: string | null }
    expect(result.error).toBeNull()
    expect(readdirSync(join(root, 'vinaya'))).toEqual([])
  })

  // The release's two steps, each a shell script that appends its name to one log (`$1`) before running, so a test
  // reads the order the steps ran in; `$2` is the claimed tree, and `grep -c <step> "$1"` the call a step is on.
  const releaseWithSteps = (root: string, steps: { restore: string; remove: string }) => {
    const module = resolve(import.meta.dir, 'test-temp-fixture.ts')
    const log = join(root, 'release-steps.log')
    const step = (name: 'restore' | 'remove') => ['/bin/sh', '-c', `echo ${name} >> "$1"; ${steps[name]}`, name, log]
    const child = spawnSyncBudgeted(
      process.execPath,
      [
        '--eval',
        `
      import { fixtureDir, releaseFixtureRun } from ${JSON.stringify(module)};
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      import { basename, dirname, join } from 'node:path';
      const fixture = fixtureDir('payload-');
      mkdirSync(join(fixture, 'nested'));
      writeFileSync(join(fixture, 'nested', 'file.txt'), 'payload');
      const run = dirname(fixture);
      const claimed = join(dirname(run), '.removing-' + basename(run));
      const error = await releaseFixtureRun(${JSON.stringify(step('remove'))}, ${JSON.stringify(step('restore'))});
      console.log(JSON.stringify({ error, remaining: existsSync(claimed), receipt: existsSync(claimed + '.owner.json') }));
    `
      ],
      { encoding: 'utf8', env: { ...stripVinayaEnv(), VINAYA_TEST_TMP: root } }
    )
    expect(child.status).toBe(0)
    const result = JSON.parse(child.stdout.trim()) as { error: string | null; remaining: boolean; receipt: boolean }
    const order = readFileSync(log, 'utf8').trim().split('\n')
    return { ...result, order, stderr: child.stderr }
  }

  test('a claimed tree another process removes part of during the release is released without a cleanup failure', () => {
    const root = fixtureDir('cleanup-partial-race-')
    // First attempt: another process deletes a subfolder after `chmod -R` listed it, so `chmod` fails on the vanished
    // entry; the removal that still runs after it finds the tree mid-sweep and fails too, leaving the tree. The
    // second attempt restores write and removes the rest.
    const result = releaseWithSteps(root, {
      restore: `if [ "$(grep -c restore "$1")" -eq 1 ]; then rm -rf "$2"/*/nested; echo "chmod: $2/nested: No such file or directory" >&2; exit 1; fi; exec chmod -R u+w "$2"`,
      remove: `if [ "$(grep -c remove "$1")" -eq 1 ]; then echo "rm: $2: Directory not empty" >&2; exit 1; fi; exec rm -rf "$2"`
    })
    expect(result).toMatchObject({ error: null, remaining: false, receipt: false })
    // The removal ran after the failed `chmod` in the first attempt, and the release took exactly two attempts.
    expect(result.order).toEqual(['restore', 'remove', 'restore', 'remove'])
    expect(result.stderr).not.toContain('test temp:')
    expect(readdirSync(join(root, 'vinaya'))).toEqual([])
  })

  test('a failed chmod never decides the release: the removal still runs, and a tree it removes is released', () => {
    const root = fixtureDir('cleanup-chmod-fails-')
    const result = releaseWithSteps(root, {
      restore: `echo "chmod: $2: No such file or directory" >&2; exit 1`,
      remove: `exec rm -rf "$2"`
    })
    expect(result).toMatchObject({ error: null, remaining: false, receipt: false, order: ['restore', 'remove'] })
    expect(result.stderr).not.toContain('test temp:')
  })

  test('a claimed tree that stays in place after both attempts still records its cleanup failure', async () => {
    const root = fixtureDir('cleanup-persistent-')
    // The removal fails on both attempts and leaves the tree, as it does on a tree that stays unwritable.
    const result = releaseWithSteps(root, {
      restore: `exec chmod -R u+w "$2"`,
      remove: `echo "rm: $2: Operation not permitted" >&2; exit 1`
    })
    expect(result).toMatchObject({ remaining: true, receipt: true, order: ['restore', 'remove', 'restore', 'remove'] })
    expect(result.error).toContain('Operation not permitted')
    expect(result.stderr).toContain('test temp:')
    const report = await sweepOwnedDirs(join(root, 'vinaya'), {
      stop: async () => ({ backend: 'registry', terminated: [], killed: [], alreadyGone: [] })
    })
    expect(report.failed).toEqual([
      { dir: expect.any(String), error: expect.stringContaining('Operation not permitted') }
    ])
    expect(report.removed).toHaveLength(1)
  })

  test('a removal that exits cleanly but leaves the claimed tree is tried again and recorded as a failure', () => {
    const root = fixtureDir('cleanup-silent-leftover-')
    const result = releaseWithSteps(root, { restore: `exec chmod -R u+w "$2"`, remove: 'exit 0' })
    expect(result).toMatchObject({ remaining: true, receipt: true, order: ['restore', 'remove', 'restore', 'remove'] })
    expect(result.error).toContain('left the claimed tree in place')
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
    const storage = resolve(import.meta.dir, '../../../../harness/kernel/conformance/unit/test-temp.ts')
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
