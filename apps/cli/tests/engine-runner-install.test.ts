import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { loadProcess } from '../../../harness/kernel/dev-process-socket/loader/load-process'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../harness/kernel/conformance/unit/process-fixture'
import {
  BUILT_PROCESS_FOLDER,
  PROGRAMS,
  processFolderFor,
  programFile
} from '../../../harness/processes/vinaya-strict/tools/programs'

// The Engine runner, run from an installed package: the package's programs built into a temporary folder (never the
// package's own `dist/`, which other tests read and rewrite), assembled there as an installed package — its
// `package.json`, the build's output, the process files the packaging script ships and its declared runtime
// dependencies beside it — and the built runner dry-run from another git repository. Nothing here reaches a source
// path of this checkout at run time.

const CLI = join(import.meta.dir, '..')
const REPO = join(CLI, '..', '..')
const PROCESS_FOLDER = join(REPO, 'harness', 'processes', 'vinaya-strict')

let base: string
let installed: string
let dryRun: { status: number; stdout: string; stderr: string }

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'engine-runner-install-')))
  const env = stripVinayaEnv()
  const modules = join(base, 'install', 'node_modules')
  installed = join(modules, '@attalabs', 'vinaya')
  mkdirSync(installed, { recursive: true })
  copyFileSync(join(CLI, 'package.json'), join(installed, 'package.json'))
  const built = spawnSyncBudgeted(
    'bun',
    ['scripts/build.ts', '--out', installed],
    { cwd: CLI, env, encoding: 'utf8' },
    300_000
  )
  if (built.status !== 0) throw new Error(`build failed:\n${built.stdout}\n${built.stderr}`)
  const shipped = spawnSyncBudgeted(
    'bun',
    ['scripts/bundle-doctrine.ts', '--out', installed],
    { cwd: CLI, env, encoding: 'utf8' },
    60_000
  )
  if (shipped.status !== 0) throw new Error(`bundle-doctrine failed:\n${shipped.stdout}\n${shipped.stderr}`)
  // The declared runtime dependencies stay external to the bundle; an install places them beside the package.
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const target = join(modules, name)
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(realpathSync(join(REPO, 'node_modules', name)), target)
  }
  const other = join(base, 'other')
  mkdirSync(other)
  spawnSyncBudgeted('git', ['init', '--quiet'], { cwd: other, env, encoding: 'utf8' })
  dryRun = spawnSyncBudgeted(
    'bun',
    [join(installed, 'dist', 'programs', 'run-engine.js'), '--task', '1', '--agent', 'claude', '--dry-run'],
    {
      cwd: other,
      env: {
        ...env,
        VINAYA_RUNTIME_DIR: join(base, 'runtime'),
        VINAYA_PROCESS_REGISTRY_DIR: join(base, 'registry')
      },
      encoding: 'utf8'
    },
    60_000
  )
}, 420_000)

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('the Engine runner from an installed package', () => {
  it('dry-runs from another repository: the process line with the checkout digest, then the flow v2 steps', () => {
    expect(dryRun.status, dryRun.stderr).toBe(0)
    const lines = dryRun.stdout.split('\n')
    const checkout = loadProcess(PROCESS_FOLDER)
    expect(checkout.flowKey).toBe('v2')
    expect(lines[0]).toBe(`process ${checkout.identity.id}@${checkout.identity.version} digest ${checkout.digest}`)
    const steps = (parse(readFileSync(checkout.flowPath, 'utf8')) as { steps: { id: string; type: string }[] }).steps
    const stepLines = lines.filter((line) => line.startsWith('step '))
    expect(stepLines.map((line) => line.split(' ').slice(1, 3).join(' '))).toEqual(
      steps.map((step) => `${step.id} ${step.type}`)
    )
  })

  it('carries the command line entry and the built runner, wrapper, bridge and check program', () => {
    expect(existsSync(join(installed, 'dist', 'index.js'))).toBe(true)
    for (const name of ['run-engine', 'supervised-command', 'dev-bridge', 'check']) {
      const program = PROGRAMS.get(name)
      expect(program, name).toBeDefined()
      expect(existsSync(join(installed, program!.built)), program!.built).toBe(true)
    }
  })

  it('names the built runner and the shipped process folder for that install, off source', () => {
    expect(programFile('run-engine', installed, false)).toBe(join(installed, 'dist', 'programs', 'run-engine.js'))
    expect(processFolderFor(installed, false)).toBe(join(installed, BUILT_PROCESS_FOLDER))
    expect(loadProcess(processFolderFor(installed, false)).digest).toBe(loadProcess(PROCESS_FOLDER).digest)
  })

  it('names the checkout source from source, even beside a built copy', () => {
    expect(programFile('run-engine', installed, true)).toBe(
      join(REPO, 'harness', 'processes', 'vinaya-strict', 'bin', 'run-engine.ts')
    )
    expect(processFolderFor(installed, true)).toBe(PROCESS_FOLDER)
  })
})
