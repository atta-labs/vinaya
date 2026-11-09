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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../../../kernel/conformance/unit/process-fixture'
import {
  exemptPrefixes,
  isSanctionedAppend,
  liveTaskPrefixes,
  PROCESS_START_MS,
  realRuntimeDir,
  SANCTIONED_APPEND_STREAMS,
  touchedSince
} from '../../../../../kernel/conformance/unit/real-runtime-guard-core'
import { GATE_STREAM } from '../../../../../kernel/gates/checks/runner'
import { CLI_OPERATION_STREAM } from '../../../../../kernel/log/client/cli-operation-log'

/** The CLI's own entry point, run from source as the shipped program runs it. */
const CLI_ENTRY = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'apps', 'cli', 'src', 'index.ts')

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

  // That the Log sink honours these names is proven by the real producer runs below, which find their events in these files.
  it('exempts exactly the streams the CLI registration and the check runner name', () => {
    expect([...SANCTIONED_APPEND_STREAMS]).toEqual([CLI_OPERATION_STREAM, GATE_STREAM])
    const repo = 'owner-repo'
    for (const stream of SANCTIONED_APPEND_STREAMS) {
      expect(isSanctionedAppend(join('logs', repo, `${stream}.ndjson`))).toBe(true)
      expect(isSanctionedAppend(join('logs', repo, `${stream}.1.ndjson`))).toBe(true)
      for (const rel of [
        join('logs', repo, `${stream}.draining.ndjson`),
        join('logs', `${stream}.ndjson`),
        join('logs', repo, 'nested', `${stream}.ndjson`),
        join('tasks-execution', repo, `${stream}.ndjson`),
        join('logs', '..', `${stream}.ndjson`)
      ]) {
        expect(isSanctionedAppend(rel)).toBe(false)
      }
    }
    for (const rel of [
      'logs',
      join('logs', repo),
      join('logs', repo, 'none.ndjson'),
      join('logs', repo, '9.ndjson'),
      join('logs', repo, 'none-other.ndjson')
    ]) {
      expect(isSanctionedAppend(rel)).toBe(false)
    }
  })

  it('does not flag the sanctioned append or the parents it creates, and flags every other file in that new tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      const cutoff = Date.now() - 1000
      const folder = join(root, 'logs', 'owner-repo')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'none-cli-operations.ndjson'), 'x')
      writeFileSync(join(folder, 'none-cli-operations.1.ndjson'), 'x')
      writeFileSync(join(folder, 'none-gates.ndjson'), 'x')
      // only the sanctioned appends, under parents born during the run: nothing to report
      expect(touchedSince(root, cutoff, [])).toEqual([])
      // an unrelated leaking test in the same newly created tree is still caught, file by file
      writeFileSync(join(folder, 'none.ndjson'), 'x')
      writeFileSync(join(folder, '9.ndjson'), 'x')
      writeFileSync(join(root, 'logs', 'stray.ndjson'), 'x')
      mkdirSync(join(folder, 'nested'))
      writeFileSync(join(folder, 'nested', 'none-cli-operations.ndjson'), 'x')
      mkdirSync(join(root, 'logs', 'other-repo'))
      writeFileSync(join(root, 'logs', 'other-repo', 'none.ndjson'), 'x')
      const found = touchedSince(root, cutoff, [])
      expect(found).toContain(join('logs', 'owner-repo', 'none.ndjson'))
      expect(found).toContain(join('logs', 'owner-repo', '9.ndjson'))
      expect(found).toContain(join('logs', 'stray.ndjson'))
      expect(found).toContain(join('logs', 'owner-repo', 'nested'))
      expect(found).toContain(join('logs', 'owner-repo', 'nested', 'none-cli-operations.ndjson'))
      expect(found).toContain(join('logs', 'other-repo'))
      expect(found).toContain(join('logs', 'other-repo', 'none.ndjson'))
      expect(found).not.toContain('logs')
      expect(found).not.toContain(join('logs', 'owner-repo'))
      expect(found.some((p) => p.endsWith(join('owner-repo', 'none-cli-operations.ndjson')))).toBe(false)
      expect(found).not.toContain(join('logs', 'owner-repo', 'none-gates.ndjson'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('flags a new logs tree that holds no sanctioned append, and a non-regular file under the sanctioned name', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      const cutoff = Date.now() - 1000
      mkdirSync(join(root, 'logs', 'owner-repo'), { recursive: true })
      expect(touchedSince(root, cutoff, [])).toEqual(['logs', join('logs', 'owner-repo')])
      symlinkSync(join(root, 'elsewhere'), join(root, 'logs', 'owner-repo', 'none-cli-operations.ndjson'))
      expect(touchedSince(root, cutoff, [])).toEqual([
        'logs',
        join('logs', 'owner-repo'),
        join('logs', 'owner-repo', 'none-cli-operations.ndjson')
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('applies one rule whichever coding agent runs the tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'real-runtime-guard-'))
    try {
      const cutoff = Date.now() - 1000
      mkdirSync(join(root, 'logs', 'owner-repo'), { recursive: true })
      writeFileSync(join(root, 'logs', 'owner-repo', 'none-cli-operations.ndjson'), 'x')
      writeFileSync(join(root, 'logs', 'owner-repo', 'none.ndjson'), 'x')
      const claude = { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' }
      const codex = { CODEX_SANDBOX: 'seatbelt', CODEX_SANDBOX_NETWORK_DISABLED: '1' }
      expect(exemptPrefixes(claude)).toEqual(exemptPrefixes(codex))
      const underClaude = touchedSince(root, cutoff, exemptPrefixes(claude))
      expect(underClaude).toEqual([join('logs', 'owner-repo', 'none.ndjson')])
      expect(touchedSince(root, cutoff, exemptPrefixes(codex))).toEqual(underClaude)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A real producer, run beside a test process whose real runtime directory is a fixture, and the preload's end-of-run check.
  const producerRun = (producer: (work: string) => string[], stream: string) => {
    const home = mkdtempSync(join(tmpdir(), 'guard-home-'))
    const work = mkdtempSync(join(tmpdir(), 'guard-producer-probe-'))
    try {
      const core = join(import.meta.dir, '../../../../../kernel/conformance/unit/real-runtime-guard-core.ts')
      const probe = join(work, 'probe.test.ts')
      const run = (leak: boolean) => {
        // a fresh home each run, so the producer creates the whole runtime tree during the run
        rmSync(home, { recursive: true, force: true })
        mkdirSync(home)
        writeFileSync(
          probe,
          [
            "import { it } from 'bun:test'",
            "import { existsSync, readdirSync, writeFileSync } from 'node:fs'",
            "import { join } from 'node:path'",
            // the very directory the preload's end-of-run check watches
            `const ROOT = (await import(${JSON.stringify(core)})).realRuntimeDir()`,
            "it('an independent producer appends beside the suite', () => {",
            `  const r = Bun.spawnSync(${JSON.stringify(producer(work))}, { cwd: ${JSON.stringify(work)}, env: { ...process.env, NODE_ENV: 'production', HOME: ${JSON.stringify(home)}, VINAYA_RUNTIME_DIR: ROOT } })`,
            "  if (r.exitCode !== 0) throw new Error('producer failed: ' + r.stderr.toString())",
            "  const folders = readdirSync(join(ROOT, 'logs'))",
            "  if (folders.length !== 1) throw new Error('expected one repository folder, found ' + folders.join(' '))",
            `  const file = join(ROOT, 'logs', folders[0], ${JSON.stringify(`${stream}.ndjson`)})`,
            "  if (!existsSync(file)) throw new Error('the producer wrote no event to its stream: ' + readdirSync(join(ROOT, 'logs', folders[0])).join(' '))",
            "  if (existsSync(join(ROOT, 'logs', folders[0], 'none.ndjson'))) throw new Error('the producer wrote the shared none.ndjson')",
            "  console.log('PRODUCER_FOLDER=' + folders[0])",
            leak ? "  writeFileSync(join(ROOT, 'logs', folders[0], '9.ndjson'), 'x')" : '',
            '})',
            ''
          ].join('\n')
        )
        // the core backdates its start by one second; the runtime directory is born after it
        const out = spawnSyncBudgeted(
          'bun',
          ['test', '--preload', join(import.meta.dir, '..', '..', 'test-preload.ts'), probe],
          { cwd: work, env: { ...stripVinayaEnv(), HOME: home, AEG_REPO: 'o/r' }, encoding: 'utf8' }
        )
        return { status: out.status, output: `${out.stdout}${out.stderr}` }
      }
      const clean = run(false)
      expect(clean.output).toContain('PRODUCER_FOLDER=')
      expect(clean.output).not.toContain('tests wrote into the real runtime directory')
      expect(clean.status).toBe(0)
      const leaked = run(true)
      const folder = leaked.output.match(/PRODUCER_FOLDER=(\S+)/)?.[1] as string
      expect(folder).toBeDefined()
      expect(leaked.status).not.toBe(0)
      expect(leaked.output).toContain(
        `tests wrote into the real runtime directory: ${join('logs', folder, '9.ndjson')}`
      )
      expect(leaked.output).not.toContain(join('logs', folder, `${stream}.ndjson`))
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(work, { recursive: true, force: true })
    }
  }

  it('passes a run while a taskless CLI command appends its operation event, and fails one that also leaks beside it', () => {
    producerRun(() => ['bun', CLI_ENTRY, 'version'], CLI_OPERATION_STREAM)
  }, 60_000)

  it('passes a run while a taskless check run appends its gate events, and fails one that also leaks beside it', () => {
    const integration = join(import.meta.dir, '..', '..')
    const kernel = join(import.meta.dir, '..', '..', '..', '..', '..', 'kernel')
    producerRun((work) => {
      const script = join(work, 'gate-producer.ts')
      writeFileSync(
        script,
        [
          `import { installVinayaConfigProvider } from ${JSON.stringify(join(integration, 'config', 'compose.ts'))}`,
          `import { installVinayaLogSinkFactory } from ${JSON.stringify(join(integration, 'cli-startup.ts'))}`,
          `import { runChecks } from ${JSON.stringify(join(kernel, 'gates', 'checks', 'runner.ts'))}`,
          `import { drainLogSink } from ${JSON.stringify(join(kernel, 'log', 'log-sink.ts'))}`,
          'installVinayaLogSinkFactory()',
          'installVinayaConfigProvider()',
          // one failing check: the run records its `checked` and `summary` gate events, naming no Issue
          "await runChecks([{ name: 'probe-fails', run: 'false', scope: 'full' }], { parallel: 1, diffOnly: false, changedFiles: null, defaultTimeoutMs: 10000 })",
          'await drainLogSink()',
          ''
        ].join('\n')
      )
      return ['bun', script]
    }, GATE_STREAM)
  }, 60_000)

  // The preload's own end-of-run check, in a child test process whose real runtime directory is a fixture.
  it('passes a run whose other-task loop ends mid-run, fails one never live, and needs the start set', () => {
    const home = mkdtempSync(join(tmpdir(), 'guard-home-'))
    const work = mkdtempSync(join(tmpdir(), 'guard-probe-'))
    try {
      // The kernel's generic preload and the process preload that imports it first.
      const lib = join(import.meta.dir, '..', '..', '..', '..', '..', 'kernel', 'conformance', 'unit')
      const integration = join(import.meta.dir, '..', '..')
      const root = join(home, '.vinaya', 'runtime', 'o-r')
      const task = join(root, 'tasks-execution', '4242')
      mkdirSync(task, { recursive: true })
      const probe = join(work, 'probe.test.ts')
      writeFileSync(
        probe,
        `import { it } from 'bun:test'\nimport { rmSync, writeFileSync } from 'node:fs'\nit('ends the loop, then writes', () => {\n  rmSync(${JSON.stringify(join(task, 'driver.pid.json'))}, { force: true })\n  writeFileSync(${JSON.stringify(join(task, 'state'))}, 'x')\n})\n`
      )
      // the same preloads, with a core whose start set is removed and every import pointed back at the real files
      const core = readFileSync(join(lib, 'real-runtime-guard-core.ts'), 'utf-8')
      const mutatedCore = core.replace('root === START_ROOT ? LIVE_AT_START : []', '[]')
      expect(mutatedCore).not.toBe(core)
      writeFileSync(join(work, 'real-runtime-guard-core.ts'), mutatedCore)
      const preload = readFileSync(join(lib, 'test-env-preload.ts'), 'utf-8').replace(
        /from '\.\/test-temp-fixture'/,
        `from ${JSON.stringify(join(lib, 'test-temp-fixture.ts'))}`
      )
      writeFileSync(join(work, 'test-env-preload.ts'), preload)
      const kernelImport = "import '../../../kernel/conformance/unit/test-env-preload.ts'"
      const processPreload = readFileSync(join(integration, 'test-preload.ts'), 'utf-8')
      expect(processPreload).toContain(kernelImport)
      writeFileSync(
        join(work, 'test-preload.ts'),
        processPreload
          .replace(kernelImport, "import './test-env-preload.ts'")
          .replace(
            "import('./config/compose.js')",
            `import(${JSON.stringify(join(integration, 'config', 'compose.ts'))})`
          )
          .replace(
            "import('./log/log-sink-factory.js')",
            `import(${JSON.stringify(join(integration, 'log', 'log-sink-factory.ts'))})`
          )
      )
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
      const realPreload = join(integration, 'test-preload.ts')
      const ended = run(process.pid, realPreload)
      expect(ended.output).not.toContain('tests wrote into the real runtime directory')
      expect(ended.status).toBe(0)
      const never = run(dead, realPreload)
      expect(never.status).not.toBe(0)
      expect(never.output).toContain(
        `tests wrote into the real runtime directory: ${join('tasks-execution', '4242', 'state')}`
      )
      const mutated = run(process.pid, join(work, 'test-preload.ts'))
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
    const out = spawnSyncBudgeted(
      'bun',
      ['test', '--preload', '../../harness/processes/vinaya-strict/integration/test-preload.ts', probe],
      {
        cwd: join(import.meta.dir, '../../../../../../apps/cli'),
        env: { ...stripVinayaEnv(), VINAYA_RUNTIME_DIR: inherited },
        encoding: 'utf8'
      }
    )
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
      cwd: join(import.meta.dir, '../../../../../..'),
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
    const out = spawnSyncBudgeted(
      'bun',
      ['test', '--preload', '../../harness/processes/vinaya-strict/integration/test-preload.ts', probe],
      {
        cwd: join(import.meta.dir, '../../../../../../apps/cli'),
        env: { ...stripVinayaEnv(), VINAYA_RUNTIME_DIR: inherited },
        encoding: 'utf8'
      }
    )
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
      const out = spawnSyncBudgeted(
        'bun',
        ['test', '--preload', '../../harness/processes/vinaya-strict/integration/test-preload.ts', probe],
        {
          cwd: join(import.meta.dir, '../../../../../../apps/cli'),
          env: { ...stripVinayaEnv(), TMPDIR: tmp, VINAYA_RUNTIME_DIR: '/inherited' },
          encoding: 'utf8'
        }
      )
      expect(`${out.stdout}${out.stderr}`.match(/RUNTIME=(\S+)/)?.[1]).toContain(expected)
    }
  })

  it('takes the repository from GITHUB_REPOSITORY without running git, once per process', () => {
    const bin = mkdtempSync(join(tmpdir(), 'real-runtime-guard-git-'))
    try {
      const marker = join(bin, 'git-called')
      writeFileSync(join(bin, 'git'), `#!/bin/sh\necho called >> "${marker}"\nexit 1\n`, { mode: 0o755 })
      const core = join(import.meta.dir, '../../../../../kernel/conformance/unit/real-runtime-guard-core.ts')
      const env: NodeJS.ProcessEnv = { ...stripVinayaEnv(), PATH: `${bin}:${process.env.PATH ?? ''}` }
      delete env.AEG_REPO
      const out = spawnSyncBudgeted(
        'bun',
        ['-e', `const m = await import(${JSON.stringify(core)}); console.log('RUNTIME=' + m.realRuntimeDir())`],
        { cwd: bin, encoding: 'utf8', env: { ...env, GITHUB_REPOSITORY: 'owner/name' } }
      )
      expect(`${out.stdout}${out.stderr}`.match(/RUNTIME=(\S+)/)?.[1]).toBe(
        join(homedir(), '.vinaya', 'runtime', 'owner-name')
      )
      expect(existsSync(marker)).toBe(false)
      // With no repository in the environment, origin is asked once, however many times the directory is read.
      spawnSyncBudgeted(
        'bun',
        ['-e', `const m = await import(${JSON.stringify(core)}); m.realRuntimeDir(); m.realRuntimeDir()`],
        { cwd: bin, encoding: 'utf8', env: { ...env, GITHUB_REPOSITORY: '' } }
      )
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['called'])
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
