/**
 * Nothing on `log()`'s path may block the event loop with a synchronous
 * spawn (`execFileSync`, `spawnSync`, `execSync`).
 *
 * The first event commonly lands while a batch of async children is still
 * running — `runChecks` logs each check as it finishes, the loop logs while
 * its roles run — and a synchronous spawn at that moment can swallow those
 * children's exit: neither 'close' nor 'exit' is ever delivered, and the
 * runner records a check that finished in milliseconds as a timeout. It is
 * intermittent, so no ordinary test catches it; this one makes the rule
 * itself fail loudly instead.
 *
 * Each case runs the REAL default sink in its own `bun` process whose
 * `node:child_process` synchronous functions are replaced, before the sink
 * is imported, with ones that record the call and throw. The case passes
 * only when no synchronous spawn was attempted AND the event's line really
 * landed — so a code path that silently swallowed the throw still fails.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

const LOG_SINK = join(import.meta.dir, '..', '..', 'src', 'lib', 'log-sink.ts')

const PROBE = `
const cp = require('node:child_process')
const syncCalls = []
for (const name of ['execFileSync', 'spawnSync', 'execSync']) {
  cp[name] = (...args) => {
    syncCalls.push(name + ' ' + String(args[0]) + ' ' + JSON.stringify(args[1] ?? []))
    throw new Error('synchronous spawn on the log path: ' + name)
  }
}
const { log } = await import(${JSON.stringify(LOG_SINK)})
log({
  kind: 'dispatch',
  event: 'dispatched',
  payload: {},
  target_role: 'developer',
  model: 'sonnet',
  effect_id: 'no-sync-spawn-probe',
  prompt_hash: 'sha256:abc'
})
await new Promise((resolve) => setTimeout(resolve, 1500))
process.stdout.write(JSON.stringify({ syncCalls }))
`

function ndjsonUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) out.push(...ndjsonUnder(abs))
    else if (entry.endsWith('.ndjson')) out.push(abs)
  }
  return out
}

function runProbe(cwd: string, env: Record<string, string>): { syncCalls: string[] } {
  const probe = join(cwd, 'probe.mjs')
  writeFileSync(probe, PROBE, 'utf8')
  const r = spawnSyncBudgeted(
    'bun',
    [probe],
    { cwd, encoding: 'utf8', env: { ...stripVinayaEnv(), ...env } },
    20_000,
    'log-sink no-sync-spawn probe'
  )
  expect(r.status).toBe(0)
  return JSON.parse(r.stdout) as { syncCalls: string[] }
}

function landedIn(dir: string): boolean {
  return ndjsonUnder(dir).some((file) => readFileSync(file, 'utf8').includes('no-sync-spawn-probe'))
}

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

describe('log() never makes a synchronous spawn', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('the default destination (no `logs` setting, attended caller) resolves and writes without one', () => {
    const cwd = tempDir('vinaya-no-sync-spawn-')
    execFileSync('git', ['init', '--quiet'], { cwd })
    const r = runProbe(cwd, { HOME: cwd, AEG_REPO: 'example/example' })
    expect(r.syncCalls).toEqual([])
    expect(landedIn(join(cwd, '.vinaya'))).toBe(true)
  }, 30000)

  it('an unattended caller with `logs` and `runtimeDir` configured reads the trust anchor without one', () => {
    const cwd = tempDir('vinaya-no-sync-spawn-')
    const outside = tempDir('vinaya-no-sync-spawn-out-')
    execFileSync('git', ['init', '--quiet'], { cwd })
    const config = { logs: { folder: join(outside, 'logs') }, runtimeDir: join(outside, 'runtime') }
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(config), 'utf8')
    // The trust-anchor read is `gh api …/contents/vinaya.config.json --jq .content`
    // — this stand-in answers with the identical config, so both settings are
    // trusted and the line must land in the configured folder.
    const bin = join(cwd, 'bin')
    mkdirSync(bin)
    const content = Buffer.from(JSON.stringify(config)).toString('base64')
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho '${content}'\n`, { mode: 0o755 })
    const r = runProbe(cwd, {
      HOME: cwd,
      AEG_REPO: 'example/example',
      GITHUB_REPOSITORY: 'example/example',
      VINAYA_ROLE: 'developer',
      PATH: `${bin}:${process.env.PATH}`
    })
    expect(r.syncCalls).toEqual([])
    expect(landedIn(join(outside, 'logs'))).toBe(true)
  }, 30000)
})
