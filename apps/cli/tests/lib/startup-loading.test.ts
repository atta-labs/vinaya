/**
 * A command-line start loads only what the command runs. With no Log destination, as in the test environment, it
 * loads no Log client; with one, the invocation's operation is still recorded at exit.
 */
import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENTRY = join(import.meta.dir, '../../src/index.ts')

/** Starts the program with a preload that writes `Object.keys(require.cache)` at exit; returns the loaded paths. */
function loadedBy(args: string[], extraEnv: Record<string, string> = {}): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-startup-loading-'))
  try {
    const out = join(dir, 'loaded.json')
    const preload = join(dir, 'preload.ts')
    writeFileSync(
      preload,
      "import { writeFileSync } from 'node:fs'\n" +
        "process.on('exit', () => writeFileSync(process.env.LOADED_OUT as string, JSON.stringify(Object.keys(require.cache))))\n"
    )
    Bun.spawnSync(['bun', '--preload', preload, ENTRY, ...args], {
      env: { ...process.env, NODE_ENV: 'test', VINAYA_NO_DEFER: '1', LOADED_OUT: out, ...extraEnv },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    return JSON.parse(readFileSync(out, 'utf8')) as string[]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const logClient = (paths: string[]): string[] => paths.filter((path) => path.includes('harness/kernel/log/client/'))

it('`version` loads no Log client and no more than 30 modules', () => {
  const loaded = loadedBy(['version'])
  expect(logClient(loaded)).toEqual([])
  expect(loaded.length).toBeLessThanOrEqual(30)
})

it('`check --plan` loads no Log client', () => {
  expect(logClient(loadedBy(['check', '--plan']))).toEqual([])
})

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]
  )
}

it('with a Log destination, `version` still records its operation at exit', () => {
  const spool = mkdtempSync(join(tmpdir(), 'vinaya-startup-spool-'))
  try {
    mkdirSync(spool, { recursive: true })
    loadedBy(['version'], { VINAYA_LOG_SPOOL_DIR: spool })
    const lines = filesUnder(spool).flatMap((file) => readFileSync(file, 'utf8').split('\n'))
    const events = lines.filter((line) => line.includes('"cli_command"'))
    expect(events.length).toBe(1)
    expect(events[0]).toContain('"target":"version"')
    expect(events[0]).toContain('"result":"ok"')
  } finally {
    rmSync(spool, { recursive: true, force: true })
  }
})
