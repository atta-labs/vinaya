import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginProgressSession, PROGRESS_MARKER, type startProgressObserver } from '../../src/lib/push-progress'
import { withV2DevTools, stagedPullRequestStore } from '../../../../processes/vinaya/loops/dev-review/v2/flow-v2-live'
import type { DevToolContext } from '../../src/lib/task-tools/dev-tools-server'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

/**
 * A file this test runs or copies, never a tree it reads: the only directories it lists are its own registry and
 * fixtures under the temporary folder.
 */
function ownFile(...parts: string[]): string {
  return join(import.meta.dir, ...parts)
}
const HELPER = ownFile('..', '..', 'src', 'lib', 'pre-push-progress-dir.ts')
const PROGRESS_MODULE = ownFile('..', '..', 'src', 'lib', 'push-progress.ts')
const FAKE_HOOK = ownFile('..', 'fixtures', 'push-progress', 'fake-pre-push-hook.sh')
const TASK = 9

let base: string
const saved = new Map<string, string | undefined>()
function setEnv(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'push-progress-observer-'))
  // The writer resolves the runtime directory the way every run file does: here, the one handed down to it.
  setEnv('VINAYA_RUNTIME_DIR', join(base, 'runtime'))
  setEnv('VINAYA_PROCESS_REGISTRY_DIR', join(base, 'registry'))
  // The hook's own capture (`mktemp`) lands in the test's folder, as the ready push gives its hook a folder of its own.
  setEnv('TMPDIR', base)
  setEnv('VINAYA_FAKE_PROGRESS_HELPER', HELPER)
  setEnv('VINAYA_FAKE_SELECTED', '2')
  setEnv('VINAYA_FAKE_RECORD', join(base, 'failure-record.log'))
  setEnv('VINAYA_FAKE_RECEIPT', join(base, 'receipt.txt'))
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) setEnv(key, undefined)
})
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
  rmSync(base, { recursive: true, force: true })
})

/** A child's environment: no ambient `VINAYA_*` key, only the ones this test set itself. */
const childEnv = (): NodeJS.ProcessEnv => {
  const env = stripVinayaEnv()
  for (const key of saved.keys()) if (process.env[key] !== undefined) env[key] = process.env[key]
  return env
}
const runDir = () => join(base, 'runtime', 'engine-runs', String(TASK))
/** The task's driver log under the same runtime directory: where the driver's own wiring points the observer. */
const logPath = () => join(base, 'runtime', 'tasks-execution', String(TASK), 'output', 'driver.log')
const driverLog = () => (existsSync(logPath()) ? readFileSync(logPath(), 'utf8') : '')
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

/** A worktree on a task branch with a bare remote, and the fake hook as its pre-push hook. */
function repository(): string {
  const remote = join(base, 'remote.git')
  const work = join(base, 'work')
  git(base, 'init', '-q', '--bare', remote)
  git(base, 'init', '-q', '-b', 'task/issue-9', work)
  git(work, 'config', 'user.email', 'test@example.com')
  git(work, 'config', 'user.name', 'Test')
  git(work, 'remote', 'add', 'origin', remote)
  writeFileSync(join(work, 'a.txt'), 'a\n')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'Chore(test): First')
  mkdirSync(join(work, '.git', 'hooks'), { recursive: true })
  copyFileSync(FAKE_HOOK, join(work, '.git', 'hooks', 'pre-push'))
  chmodSync(join(work, '.git', 'hooks', 'pre-push'), 0o755)
  return work
}

/** A fake test run: Bun-shaped output, with `pause` seconds between the first file's close and the rest. */
function testScript(pause: number, failing = false): void {
  const path = join(base, 'tests.sh')
  writeFileSync(
    path,
    [
      "printf 'bun test v1.4.2\\n\\ntests/first.test.ts:\\n(pass) first one [2.00ms]\\n\\ntests/second.test.ts:\\n'",
      pause > 0 ? `sleep ${pause}` : ':',
      failing
        ? "printf '(fail) second breaks [3.00ms]\\n\\n 1 pass\\n 1 fail\\nRan 2 tests across 2 files. [9.00ms]\\n'; exit 1"
        : "printf '(pass) second one [3.00ms]\\n\\n 2 pass\\n 0 fail\\nRan 2 tests across 2 files. [9.00ms]\\n'"
    ].join('\n')
  )
  setEnv('VINAYA_FAKE_TEST_SCRIPT', path)
}

/** The time a driver-log line was written, by its leading timestamp. */
function lineTime(line: string | undefined): number {
  return Date.parse((line ?? '').split('  ')[0] ?? '')
}

function liveObservers(): number[] {
  const registry = join(base, 'registry')
  if (!existsSync(registry)) return []
  const pids: number[] = []
  for (const token of readdirSync(registry)) {
    if (!decodeURIComponent(token).startsWith('push-progress-')) continue
    for (const file of readdirSync(join(registry, token))) {
      if (!file.endsWith('.json')) continue
      const pid = (JSON.parse(readFileSync(join(registry, token, file), 'utf8')) as { pid: number }).pid
      try {
        process.kill(pid, 0)
        pids.push(pid)
      } catch {
        // Gone.
      }
    }
  }
  return pids
}

/** The Developer's publish tool, its base a real synchronous `git push` like the driver's own. */
function devTools(work: string, open: boolean): DevToolContext {
  const base = {
    publishChanges: async () => {
      const pushed = spawnSync('git', ['-C', work, 'push', 'origin', 'HEAD:refs/heads/task/issue-9'], {
        env: childEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return pushed.status === 0
        ? { ok: true, result: { pushedHead: git(work, 'rev-parse', 'HEAD') } }
        : { ok: false, error: { code: 'hook', output: `${pushed.stdout}${pushed.stderr}` } }
    }
  } as unknown as DevToolContext
  return withV2DevTools(base, {
    worktreePath: work,
    runId: 'run-1',
    store: stagedPullRequestStore(runDir()),
    findOpenPullRequest: () => (open ? { number: 1 } : null),
    onStoragePush: () => {},
    branch: 'task/issue-9',
    readyTestsPolicy: () => ({ mode: 'ci', workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }),
    checkBaseline: () => ({ ok: true })
  })
}

describe('a real push behind a driver', () => {
  for (const kind of ['storage', 'repair'] as const) {
    it(`a ${kind} push puts per-check and per-file lines in the driver log before it exits`, async () => {
      const work = repository()
      testScript(2)
      const result = await devTools(work, kind === 'repair').publishChanges('Chore(test): Push')
      const exited = Date.now()
      expect(result.ok).toBe(true)
      const lines = driverLog().split('\n').filter(Boolean)
      const words = lines.map((line) => line.split('  ').slice(1).join('  '))
      expect(words.some((w) => w.startsWith('push progress: check lint ✓, '))).toBe(true)
      expect(words.some((w) => w.startsWith('push progress: check typecheck ✓, '))).toBe(true)
      const first = lines.find((line) => line.includes('test progress: 1/2 tests/first.test.ts ✓, 2 ms'))
      expect(first).toBeDefined()
      expect(lines.some((line) => line.endsWith('test progress: 2/2 tests/second.test.ts ✓, 3 ms'))).toBe(true)
      // The first file's line was written while the push was still running its tests.
      expect(lineTime(first)).toBeLessThan(exited - 1000)
      // The mark is gone and the observer stopped with the push.
      expect(existsSync(join(work, '.git', PROGRESS_MARKER))).toBe(false)
      expect(liveObservers()).toEqual([])
    }, 60_000)
  }

  it('a fast final file followed by the capture removal is fully drained', async () => {
    const work = repository()
    testScript(0, true)
    const result = await devTools(work, false).publishChanges('Chore(test): Push')
    expect(result.ok).toBe(false)
    const log = driverLog()
    expect(log).toContain('test progress: 1/2 tests/first.test.ts ✓, 2 ms')
    expect(log).toContain('test progress: 2/2 tests/second.test.ts ✗, 3 ms — first failing test: second breaks')
    expect(log).not.toContain('interrupted')
  }, 60_000)
})

describe('progress changes nothing the hook does', () => {
  /** Runs the fake hook directly, as git would, and returns everything it leaves. */
  function runHook(work: string) {
    rmSync(process.env.VINAYA_FAKE_RECORD as string, { force: true })
    rmSync(process.env.VINAYA_FAKE_RECEIPT as string, { force: true })
    const run = spawnSyncBudgeted('sh', [join(work, '.git', 'hooks', 'pre-push'), 'origin', 'origin'], {
      cwd: work,
      env: childEnv(),
      encoding: 'utf8',
      input: ''
    })
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null)
    return {
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      record: read(process.env.VINAYA_FAKE_RECORD as string),
      receipt: read(process.env.VINAYA_FAKE_RECEIPT as string)
    }
  }

  for (const failing of [false, true]) {
    it(`with a ${failing ? 'failing' : 'passing'} run: output, failure record, receipt and exit are identical on, off, invalid and unwritable`, async () => {
      const work = repository()
      testScript(0, failing)
      const off = runHook(work)

      const session = await beginProgressSession({
        runDir: runDir(),
        task: TASK,
        worktreePath: work,
        logPath: logPath()
      })
      expect(session.dir).not.toBeNull()
      const on = runHook(work)
      // Unwritable storage: the directory exists but refuses writes.
      chmodSync(session.dir as string, 0o500)
      const unwritable = runHook(work)
      chmodSync(session.dir as string, 0o700)
      // A forged mark: a task with no run directory resolves nothing.
      const marker = join(work, '.git', PROGRESS_MARKER)
      writeFileSync(marker, readFileSync(marker, 'utf8').replace(`"task":${TASK}`, '"task":12345'))
      const forged = runHook(work)
      await session.end()

      for (const other of [on, unwritable, forged]) expect(other).toEqual(off)
      expect(off.status).toBe(failing ? 1 : 0)
      expect(off.stderr).toBe('')
      expect(driverLog()).toContain('push progress: check lint ✓')
    }, 60_000)
  }
})

describe('observer failures never reach the push', () => {
  type ObserverOptions = Omit<Parameters<typeof startProgressObserver>[0], 'dir' | 'logPath'>
  const failures: Record<string, () => ObserverOptions> = {
    startup: () => ({ entry: { command: join(base, 'no-such-observer'), args: [] } }),
    registration: () => ({
      register: async () => {
        throw new Error('the registry is unwritable')
      }
    }),
    crash: () => ({ entry: { command: 'sh', args: ['-c', 'exit 3', 'observer'] } }),
    'unresponsive shutdown': () => ({
      entry: { command: 'sh', args: ['-c', "trap '' TERM; sleep 30", 'observer'] },
      shutdownGraceMs: 200
    })
  }

  for (const [name, options] of Object.entries(failures)) {
    it(`an observer ${name} failure leaves the hook and its result unchanged`, async () => {
      const work = repository()
      testScript(0)
      const hookRun = () =>
        spawnSyncBudgeted('sh', [join(work, '.git', 'hooks', 'pre-push')], {
          cwd: work,
          env: childEnv(),
          encoding: 'utf8',
          input: ''
        })
      const baseline = hookRun()
      const session = await beginProgressSession({
        runDir: runDir(),
        task: TASK,
        worktreePath: work,
        logPath: logPath(),
        observer: options()
      })
      const run = hookRun()
      const stopping = Date.now()
      await session.end()
      expect(Date.now() - stopping).toBeLessThan(10_000)
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
        status: baseline.status,
        stdout: baseline.stdout,
        stderr: baseline.stderr
      })
      expect(liveObservers()).toEqual([])
    }, 60_000)
  }
})

describe('driver death and cancellation', () => {
  it('an observer whose driver died exits by itself, and a copier whose hook died does too', async () => {
    const work = repository()
    // A driver process that starts an observer and is then killed without stopping it.
    const script = join(base, 'driver.ts')
    writeFileSync(
      script,
      [
        `import { beginProgressSession } from ${JSON.stringify(PROGRESS_MODULE)}`,
        `await beginProgressSession({ runDir: ${JSON.stringify(runDir())}, task: ${TASK}, worktreePath: ${JSON.stringify(work)}, logPath: ${JSON.stringify(logPath())} })`,
        "process.stdout.write('started\\n')",
        'setInterval(() => {}, 1000)'
      ].join('\n')
    )
    const driver = spawn('bun', [script], { stdio: ['ignore', 'pipe', 'inherit'], env: childEnv() })
    // A driver that never reports in is killed rather than left to hang the test.
    const driverBudget = setTimeout(() => driver.kill('SIGKILL'), 20_000)
    await new Promise<void>((resolve) => driver.stdout?.on('data', () => resolve()))
    clearTimeout(driverBudget)
    const observers = liveObservers()
    expect(observers).toHaveLength(1)
    driver.kill('SIGKILL')
    const deadline = Date.now() + 10_000
    while (liveObservers().length > 0 && Date.now() < deadline) await Bun.sleep(100)
    expect(liveObservers()).toEqual([])

    // A copier is the hook's child: with its hook gone it stops following.
    const capture = join(base, 'capture.log')
    writeFileSync(capture, '')
    const session = await beginProgressSession({ runDir: runDir(), task: TASK, worktreePath: work, logPath: logPath() })
    const hook = spawn('sh', ['-c', `bun ${HELPER} follow ${capture} tests-1 1 & echo $!; sleep 30`], {
      cwd: work,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const copier = Number(await new Promise<string>((resolve) => hook.stdout?.once('data', (d) => resolve(String(d)))))
    await Bun.sleep(800)
    hook.kill('SIGKILL')
    const copierDeadline = Date.now() + 10_000
    const alive = () => {
      try {
        process.kill(copier, 0)
        return true
      } catch {
        return false
      }
    }
    while (alive() && Date.now() < copierDeadline) await Bun.sleep(100)
    expect(alive()).toBe(false)
    await session.end()
  }, 60_000)

  it('ending the session — what a cancelled push runs on its way out — stops the observer', async () => {
    const work = repository()
    const session = await beginProgressSession({ runDir: runDir(), task: TASK, worktreePath: work, logPath: logPath() })
    expect(liveObservers()).toHaveLength(1)
    await session.end()
    expect(liveObservers()).toEqual([])
    expect(existsSync(join(work, '.git', PROGRESS_MARKER))).toBe(false)
  }, 30_000)
})
