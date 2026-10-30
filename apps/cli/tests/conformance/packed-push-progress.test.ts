import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginProgressSession, progressObserverEntry } from '../../src/lib/push-progress'
import { spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture'

// The hook's progress helper and the driver's progress observer, run from a packed install: the tarball `bun pm
// pack` makes from the built package (its `files` allowlist ships `dist`, never `src`), unpacked as an installed
// dependency beside its declared runtime dependencies. Nothing here reaches a source path.

const CLI = join(import.meta.dir, '..', '..')
const REPO = join(CLI, '..', '..')
const TASK = 3

let base: string
let installed: string
let manifest: { bin: Record<string, string>; dependencies?: Record<string, string> }
const savedEnv = new Map<string, string | undefined>()
const setEnv = (key: string, value: string) => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'packed-push-progress-'))
  const env = stripVinayaEnv()
  spawnSyncBudgeted('bun', ['scripts/build.ts'], { cwd: CLI, env, encoding: 'utf8' }, 60_000)
  const out = join(base, 'pack')
  mkdirSync(out)
  const packed = spawnSyncBudgeted(
    'bun',
    ['pm', 'pack', '--ignore-scripts', '--quiet', '--destination', out],
    { cwd: CLI, env, encoding: 'utf8' },
    60_000
  )
  const tarball = packed.stdout.trim().split('\n').at(-1) as string
  const extract = join(base, 'extract')
  mkdirSync(extract)
  spawnSyncBudgeted('tar', ['-xzf', tarball, '-C', extract], { env, encoding: 'utf8' })
  const modules = join(base, 'install', 'node_modules')
  mkdirSync(join(modules, '@attalabs'), { recursive: true })
  installed = join(modules, '@attalabs', 'vinaya')
  renameSync(join(extract, 'package'), installed)
  manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  // The declared runtime dependencies, as an install would place them beside the package.
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const target = join(modules, name)
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(realpathSync(join(REPO, 'node_modules', name)), target)
  }
  setEnv('VINAYA_RUNTIME_DIR', join(base, 'runtime'))
  setEnv('VINAYA_PROCESS_REGISTRY_DIR', join(base, 'registry'))
}, 120_000)

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(base, { recursive: true, force: true })
})

describe('progress from a packed install', () => {
  it('ships the hook helper and the observer as built entrypoints, and no source', () => {
    expect(existsSync(join(installed, 'src'))).toBe(false)
    expect(manifest.bin['vinaya-push-progress']).toBe('dist/lib/pre-push-progress-dir.js')
    expect(manifest.bin['vinaya-push-progress-observer']).toBe('dist/lib/push-progress-observer.js')
    expect(existsSync(join(installed, 'dist', 'lib', 'pre-push-progress-dir.js'))).toBe(true)
    expect(existsSync(join(installed, 'dist', 'lib', 'push-progress-observer.js'))).toBe(true)
    expect(progressObserverEntry(installed)).toEqual({
      command: 'node',
      args: [join(installed, 'dist', 'lib', 'push-progress-observer.js')]
    })
  })

  it('the packed hook helper and the packed observer start and write progress into the driver log', async () => {
    const work = join(base, 'work')
    mkdirSync(work)
    execFileSync('git', ['init', '-q', work])
    const logPath = join(base, 'runtime', 'tasks-execution', String(TASK), 'output', 'driver.log')
    const session = await beginProgressSession({
      runDir: join(base, 'runtime', 'engine-runs', String(TASK)),
      task: TASK,
      worktreePath: work,
      logPath,
      observer: { entry: progressObserverEntry(installed) }
    })
    expect(session.dir).not.toBeNull()
    const helper = join(installed, manifest.bin['vinaya-push-progress'] as string)
    // No ambient `VINAYA_*` or git key: only the runtime directory and registry this test hands down.
    const env: NodeJS.ProcessEnv = {
      ...stripVinayaEnv(),
      VINAYA_RUNTIME_DIR: join(base, 'runtime'),
      VINAYA_PROCESS_REGISTRY_DIR: join(base, 'registry')
    }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const on = spawnSyncBudgeted('node', [helper, 'dir'], { cwd: work, env, encoding: 'utf8' })
    expect(on.stdout).toBe('on\n')
    expect(on.status).toBe(0)
    const started = String(Math.floor(Date.now() / 1000))
    const record = spawnSyncBudgeted('node', [helper, 'check', 'lint', 'pass', started], {
      cwd: work,
      env,
      encoding: 'utf8'
    })
    expect({ status: record.status, stdout: record.stdout, stderr: record.stderr }).toEqual({
      status: 0,
      stdout: '',
      stderr: ''
    })
    const deadline = Date.now() + 10_000
    while (!(existsSync(logPath) && readFileSync(logPath, 'utf8').includes('check lint')) && Date.now() < deadline)
      await Bun.sleep(100)
    await session.end()
    expect(readFileSync(logPath, 'utf8')).toMatch(/ {2}push progress: check lint ✓, \d+(\.\d+)? (ms|s)/)
  }, 60_000)
})
