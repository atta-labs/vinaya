/**
 * Guard: no test in this suite may create or change a file under the REAL
 * per-repository runtime directory (`~/.vinaya/runtime/<owner>-<repo>`).
 * Leaks of that kind outlive the test run — they showed up as task folders
 * numbered like fixtures (9, 9001, 9201) that the start-up sweep then logged
 * forge errors for on every loop start.
 *
 * The whole-run check lives in `test-env-preload.ts` (an `afterAll` every test
 * process loads, so every CI shard and every local run fails on a leak). This
 * file is that observer's own test, plus a mid-run check whose TITLE names any
 * leaked path — a failing run's summary lists titles, not assertion output.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'
import {
  exemptPrefixes,
  liveTaskPrefixes,
  PROCESS_START_MS,
  realRuntimeDir,
  touchedSince
} from './real-runtime-guard-core'

/** Taken at module load so the test's own TITLE names the leaked paths. */
const leakedAtLoad = touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))
const TITLE = 'no test so far has written into the real runtime directory'
const title = leakedAtLoad.length > 0 ? `${TITLE} — LEAKED: ${leakedAtLoad.join(' ').slice(0, 800)}` : TITLE

describe('real runtime directory guard', () => {
  it(title, () => {
    expect(touchedSince(realRuntimeDir(), PROCESS_START_MS, exemptPrefixes(process.env))).toEqual([])
  })

  it('detects a write newer than the cutoff and ignores exempt paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      mkdirSync(join(root, 'tasks-execution', '7'), { recursive: true })
      mkdirSync(join(root, 'tasks-execution', '9'), { recursive: true })
      writeFileSync(join(root, 'tasks-execution', '7', 'a'), 'x')
      writeFileSync(join(root, 'tasks-execution', '9', 'b'), 'x')
      const found = touchedSince(root, Date.now() - 60_000, [join('tasks-execution', '7')])
      expect(found).toContain(join('tasks-execution', '9', 'b'))
      expect(found.some((p) => p.startsWith(join('tasks-execution', '7')))).toBe(false)
      expect(touchedSince(root, Date.now() + 60_000, [])).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not flag a directory whose only change is an exempt entry added inside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      mkdirSync(join(root, 'tasks-execution', 'old'), { recursive: true })
      const cutoff = Date.now() + 1000
      Bun.sleepSync(1100)
      mkdirSync(join(root, 'tasks-execution', '7'))
      writeFileSync(join(root, 'tasks-execution', '7', 'a'), 'x')
      expect(touchedSince(root, cutoff, [join('tasks-execution', '7')])).toEqual([])
      // the same directory created after the cutoff, not exempt, is flagged
      expect(touchedSince(root, cutoff, [])).toEqual([join('tasks-execution', '7'), join('tasks-execution', '7', 'a')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exempts a task whose lock names a running process, not one whose pid is dead', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      // an unused pid: spawn-and-reap a child, whose pid is then free
      const dead = Bun.spawnSync(['true']).pid
      const lock = (pid: number) => JSON.stringify({ pid, startedAt: new Date().toISOString(), token: 't' })
      for (const [task, pid] of [
        ['live', process.pid],
        ['stale', dead]
      ] as const) {
        mkdirSync(join(root, 'tasks-execution', task), { recursive: true })
        mkdirSync(join(root, 'logs', 'owner-repo'), { recursive: true })
        writeFileSync(join(root, 'tasks-execution', task, 'driver.pid.json'), lock(pid))
        writeFileSync(join(root, 'tasks-execution', task, 'state'), 'x')
        writeFileSync(join(root, 'logs', `${task}.ndjson`), 'x')
        writeFileSync(join(root, 'logs', 'owner-repo', `${task}.ndjson`), 'x')
        mkdirSync(join(root, 'engine-runs', task), { recursive: true })
        writeFileSync(join(root, 'engine-runs', task, 'checkpoints.sqlite'), 'x')
      }
      writeFileSync(join(root, 'logs', 'other.ndjson'), 'x')
      const found = touchedSince(root, Date.now() - 60_000, [])
      expect(found.some((p) => p.includes('live'))).toBe(false)
      expect(found).toContain(join('tasks-execution', 'stale', 'state'))
      expect(found).toContain(join('logs', 'stale.ndjson'))
      expect(found).toContain(join('logs', 'owner-repo', 'stale.ndjson'))
      expect(found).toContain(join('logs', 'other.ndjson'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exempts a task whose loop was live at start and then ended, not one never live', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      const dead = Bun.spawnSync(['true']).pid
      const lock = (pid: number) => JSON.stringify({ pid, startedAt: new Date().toISOString(), token: 't' })
      const lockPath = (task: string) => join(root, 'tasks-execution', task, 'driver.pid.json')
      for (const task of ['removed', 'died', 'never', 'late']) {
        mkdirSync(join(root, 'tasks-execution', task), { recursive: true })
        mkdirSync(join(root, 'engine-runs', task), { recursive: true })
      }
      mkdirSync(join(root, 'logs', 'owner-repo'), { recursive: true })
      writeFileSync(lockPath('removed'), lock(process.pid))
      writeFileSync(lockPath('died'), lock(process.pid))
      writeFileSync(lockPath('never'), lock(dead))
      const liveAtStart = liveTaskPrefixes(root)
      // the two loops end — one removes its lock, one leaves it naming a dead pid — and a third starts
      rmSync(lockPath('removed'))
      writeFileSync(lockPath('died'), lock(dead))
      writeFileSync(lockPath('late'), lock(process.pid))
      for (const task of ['removed', 'died', 'never', 'late']) {
        writeFileSync(join(root, 'tasks-execution', task, 'state'), 'x')
        writeFileSync(join(root, 'engine-runs', task, 'checkpoints.sqlite'), 'x')
        writeFileSync(join(root, 'logs', 'owner-repo', `${task}.ndjson`), 'x')
      }
      writeFileSync(join(root, 'stray'), 'x')
      const found = touchedSince(root, Date.now() - 60_000, [], liveAtStart)
      for (const task of ['removed', 'died', 'late']) expect(found.some((p) => p.includes(task))).toBe(false)
      expect(found).toContain(join('tasks-execution', 'never', 'state'))
      expect(found).toContain(join('engine-runs', 'never', 'checkpoints.sqlite'))
      expect(found).toContain(join('logs', 'owner-repo', 'never.ndjson'))
      expect(found).toContain('stray')
      // without the start set, the ended loops are flagged; a directory other than the real one gets none by default
      const withoutStart = touchedSince(root, Date.now() - 60_000, [])
      expect(withoutStart).toContain(join('tasks-execution', 'removed', 'state'))
      expect(withoutStart).toContain(join('tasks-execution', 'died', 'state'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The preload's own end-of-run check, in a child test process whose real runtime directory is a fixture.
  it('passes a run whose other-task loop ends mid-run, fails one never live, and needs the start set', () => {
    const home = mkdtempSync(join(tmpdir(), 'guard-home-'))
    const work = mkdtempSync(join(tmpdir(), 'guard-probe-'))
    try {
      const lib = import.meta.dir
      const root = join(home, '.vinaya', 'runtime', 'o-r')
      const task = join(root, 'tasks-execution', '4242')
      mkdirSync(task, { recursive: true })
      const probe = join(work, 'probe.test.ts')
      writeFileSync(
        probe,
        `import { it } from 'bun:test'\nimport { rmSync, writeFileSync } from 'node:fs'\nit('ends the loop, then writes', () => {\n  rmSync(${JSON.stringify(join(task, 'driver.pid.json'))}, { force: true })\n  writeFileSync(${JSON.stringify(join(task, 'state'))}, 'x')\n})\n`
      )
      // the same preload, with a core whose start set is removed and every import pointed back at the real files
      const core = readFileSync(join(lib, 'real-runtime-guard-core.ts'), 'utf-8')
      const mutatedCore = core.replace('root === START_ROOT ? LIVE_AT_START : []', '[]')
      expect(mutatedCore).not.toBe(core)
      writeFileSync(join(work, 'real-runtime-guard-core.ts'), mutatedCore)
      const factoryImport = "'../../../../harness/processes/vinaya-strict/integration/log/log-sink-factory.js'"
      const unmutatedPreload = readFileSync(join(lib, 'test-env-preload.ts'), 'utf-8')
      expect(unmutatedPreload).toContain(factoryImport)
      const preload = unmutatedPreload
        .replace(/from '\.\/test-temp-fixture'/, `from ${JSON.stringify(join(lib, 'test-temp-fixture.ts'))}`)
        .replace(
          factoryImport,
          JSON.stringify(
            join(
              lib,
              '..',
              '..',
              '..',
              '..',
              'harness',
              'processes',
              'vinaya-strict',
              'integration',
              'log',
              'log-sink-factory.ts'
            )
          )
        )
        .replace(
          /import\('\.\.\/\.\.\/src\/lib\/config\.js'\)/,
          `import(${JSON.stringify(join(lib, '..', '..', 'src', 'lib', 'config.ts'))})`
        )
      writeFileSync(join(work, 'test-env-preload.ts'), preload)
      const dead = Bun.spawnSync(['true']).pid
      const run = (pid: number, preloadPath: string) => {
        rmSync(join(task, 'state'), { force: true })
        writeFileSync(join(task, 'driver.pid.json'), JSON.stringify({ pid, startedAt: new Date().toISOString() }))
        // the core backdates its start by one second; the fixture tree must predate it
        Bun.sleepSync(1100)
        const out = spawnSyncBudgeted('bun', ['test', '--preload', preloadPath, probe], {
          cwd: work,
          env: { ...stripVinayaEnv(), HOME: home, AEG_REPO: 'o/r' },
          encoding: 'utf8'
        })
        return { status: out.status, output: `${out.stdout}${out.stderr}` }
      }
      const realPreload = join(lib, 'test-env-preload.ts')
      const ended = run(process.pid, realPreload)
      expect(ended.output).not.toContain('tests wrote into the real runtime directory')
      expect(ended.status).toBe(0)
      const never = run(dead, realPreload)
      expect(never.status).not.toBe(0)
      expect(never.output).toContain(
        `tests wrote into the real runtime directory: ${join('tasks-execution', '4242', 'state')}`
      )
      const mutated = run(process.pid, join(work, 'test-env-preload.ts'))
      expect(mutated.status).not.toBe(0)
      expect(mutated.output).toContain(join('tasks-execution', '4242', 'state'))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    }
  }, 60_000)

  // A dispatched session hands its real runtime directory down; the tests it runs must still never write there.
  it('gives a test process a private runtime directory even when one is inherited', () => {
    const inherited = mkdtempSync(join(tmpdir(), 'inherited-runtime-'))
    const probe = join(mkdtempSync(join(tmpdir(), 'runtime-probe-')), 'probe.test.ts')
    writeFileSync(
      probe,
      "import { it } from 'bun:test'\nit('prints', () => console.log('RUNTIME=' + process.env.VINAYA_RUNTIME_DIR))\n"
    )
    const out = spawnSyncBudgeted('bun', ['test', '--preload', './tests/lib/test-env-preload.ts', probe], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...stripVinayaEnv(), VINAYA_RUNTIME_DIR: inherited },
      encoding: 'utf8'
    })
    const line = `${out.stdout}${out.stderr}`.match(/RUNTIME=(\S+)/)?.[1]
    expect(line).toBeDefined()
    expect(line).not.toBe(inherited)
    expect(line).toContain('vinaya-test-runtime-')
    rmSync(inherited, { recursive: true, force: true })
  })

  // The pre-push hook runs the selected test files from the repository root, where only the root bunfig applies.
  it('gives a test run from the repository root the same private runtime directory', () => {
    const inherited = mkdtempSync(join(tmpdir(), 'inherited-runtime-'))
    const probe = join(mkdtempSync(join(tmpdir(), 'runtime-probe-')), 'probe.test.ts')
    writeFileSync(
      probe,
      "import { it } from 'bun:test'\nit('prints', () => console.log('RUNTIME=' + process.env.VINAYA_RUNTIME_DIR))\n"
    )
    const out = spawnSyncBudgeted('bun', ['test', '--timeout=30000', '--', probe], {
      cwd: join(import.meta.dir, '../../../..'),
      env: { ...stripVinayaEnv(), VINAYA_RUNTIME_DIR: inherited },
      encoding: 'utf8'
    })
    const line = `${out.stdout}${out.stderr}`.match(/RUNTIME=(\S+)/)?.[1]
    expect(line).toBeDefined()
    expect(line).not.toBe(inherited)
    expect(line).toContain('vinaya-test-runtime-')
    rmSync(inherited, { recursive: true, force: true })
  })

  // Bun.spawn without an env hands a child the environment the test process started with, unless the preload fixes it.
  it('gives a child a test spawns without an env the same private runtime directory', () => {
    const inherited = mkdtempSync(join(tmpdir(), 'inherited-runtime-'))
    const probe = join(mkdtempSync(join(tmpdir(), 'runtime-probe-')), 'probe.test.ts')
    writeFileSync(
      probe,
      "import { it } from 'bun:test'\nit('prints', () => console.log(Bun.spawnSync(['sh', '-c', 'echo CHILD=$VINAYA_RUNTIME_DIR']).stdout.toString()))\n"
    )
    const out = spawnSyncBudgeted('bun', ['test', '--preload', './tests/lib/test-env-preload.ts', probe], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...stripVinayaEnv(), VINAYA_RUNTIME_DIR: inherited },
      encoding: 'utf8'
    })
    const line = `${out.stdout}${out.stderr}`.match(/CHILD=(\S+)/)?.[1]
    expect(line).toBeDefined()
    expect(line).not.toBe(inherited)
    expect(line).toContain('vinaya-test-runtime-')
    rmSync(inherited, { recursive: true, force: true })
  })

  // A sandbox names a temporary directory that does not exist yet; the preload creates it, or keeps what it was handed.
  it('starts under a temporary directory that does not exist yet, and under one that cannot be made', () => {
    const probe = join(mkdtempSync(join(tmpdir(), 'runtime-probe-')), 'probe.test.ts')
    writeFileSync(
      probe,
      "import { it } from 'bun:test'\nit('prints', () => console.log('RUNTIME=' + process.env.VINAYA_RUNTIME_DIR))\n"
    )
    const missing = join(mkdtempSync(join(tmpdir(), 'tmp-parent-')), 'claude')
    for (const [tmp, expected] of [
      [missing, 'vinaya-test-runtime-'],
      ['/dev/null/claude', '/inherited']
    ] as const) {
      const out = spawnSyncBudgeted('bun', ['test', '--preload', './tests/lib/test-env-preload.ts', probe], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...stripVinayaEnv(), TMPDIR: tmp, VINAYA_RUNTIME_DIR: '/inherited' },
        encoding: 'utf8'
      })
      expect(`${out.stdout}${out.stderr}`.match(/RUNTIME=(\S+)/)?.[1]).toContain(expected)
    }
  })
})
