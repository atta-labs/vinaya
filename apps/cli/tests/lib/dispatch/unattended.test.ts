import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `worker-isolation-v1` task 3 (`#560`), O3: `--unattended` (`DispatchOpts.unattended`)
 * marks a `vinaya dispatch` invocation as an unattended start; the SEPARATE
 * `dispatch.requireWorkerIsolation` config setting (`config.ts`, off by
 * default — "the declared, visible setting" this tranche's own milestone
 * names) decides whether that actually requires `apps/cli/specs/isolation.md`'s
 * OS-level boundary. Both must hold for a dispatch to refuse before any
 * spawn when the boundary cannot be established. Exercised through the real
 * `vinaya dispatch` CLI entry point (`execFileSync('bun', [INDEX, ...])`),
 * the same discipline and the same scratch-`HOME`/non-git-`cwd` reasoning
 * `apps/cli/tests/lib/dispatch.test.ts`'s own header documents — never by
 * importing `dispatchRole` in-process, which would write real launch/outbox
 * records under this machine's own `HOME`.
 *
 * This CI host is not Darwin, so a run with BOTH `--unattended` and the
 * config setting on refuses here every time — documented scope
 * (`isolation.md` §3), not a gap this suite papers over, mirroring
 * `isolation-probe.test.ts`'s own `skipIf(isSandboxSupported())`
 * "on an unsupported host" test. The available-boundary branch (the
 * profile/env/command a resolved launch actually produces) is unit-tested
 * directly, with injected host detection, in `worker-boundary.test.ts` —
 * this file proves the WIRING: with the setting on, `--unattended` on this
 * host never reaches the vendor binary at all; with the setting left off
 * (its default — the pre-existing `dev-review-loop`/`dispatch-task`
 * automated-loop call sites' own posture), `--unattended` is inert and a
 * dispatch with neither flag nor setting is entirely unaffected (the
 * pre-task-3 regression guard).
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

function pathWithoutRealVendors(): string {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  return dirs.filter((d) => !['claude', 'codex', 'gemini'].some((v) => existsSync(join(d, v)))).join(':')
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type Fixture = { home: string; cwd: string; binDir: string; promptFile: string; markerFile: string }

function buildFixture(opts: { requireWorkerIsolation?: boolean } = {}): Fixture {
  const home = tempDir('vinaya-unattended-home-')
  const cwd = tempDir('vinaya-unattended-cwd-')
  const binDir = tempDir('vinaya-unattended-bin-')
  const promptFile = join(cwd, 'prompt.txt')
  writeFileSync(promptFile, 'do the thing')
  const markerFile = join(cwd, 'vendor-was-run.marker')
  // A fake vendor that, if ever actually started, proves it by writing a
  // marker file the test can check for — the strongest possible assertion
  // that a refused dispatch never spawns anything at all, not merely that
  // the CLI's own exit code/message says so.
  writeFileSync(
    join(binDir, 'claude'),
    `#!/bin/sh\ntouch "${markerFile}"\ncat > /dev/null\nprintf '%s' '{"session_id":"sess-x","usage":{"input_tokens":1,"output_tokens":1}}'\nexit 0\n`
  )
  chmodSync(join(binDir, 'claude'), 0o755)
  if (opts.requireWorkerIsolation !== undefined) {
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({ dispatch: { requireWorkerIsolation: opts.requireWorkerIsolation } })
    )
  }
  return { home, cwd, binDir, promptFile, markerFile }
}

function runDispatch(fixture: Fixture, extraArgs: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      'bun',
      [INDEX, 'dispatch', 'developer', '--agent', 'claude', '--prompt-file', fixture.promptFile, ...extraArgs],
      {
        encoding: 'utf8',
        cwd: fixture.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: fixture.home, PATH: `${fixture.binDir}:${pathWithoutRealVendors()}` }
      }
    )
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function outboxLines(home: string): unknown[] {
  const p = join(home, '.vinaya', 'outbox', 'unresolved', 'none.ndjson')
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('vinaya dispatch --unattended — O3 fail-closed refusal', () => {
  it('refuses before ever spawning the vendor binary, with the boundary required and no boundary on this host', () => {
    const fixture = buildFixture({ requireWorkerIsolation: true })
    const result = runDispatch(fixture, ['--unattended'])

    expect(result.status).not.toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(false)
    expect(result.stderr).toContain('refused')

    const lines = outboxLines(fixture.home) as Array<{ event?: string; reason?: string }>
    const failed = lines.find((l) => l.event === 'dispatch_failed')
    expect(failed).toBeDefined()
    expect(failed?.reason).toBe('refused')
    // No 'dispatched' event either — the refusal happens before that line.
    expect(lines.find((l) => l.event === 'dispatched')).toBeUndefined()
  })

  it('--unattended alone, with requireWorkerIsolation left at its default (off), is inert', () => {
    const fixture = buildFixture()
    const result = runDispatch(fixture, ['--unattended'])

    expect(result.status).toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(true)
  })

  it('the config setting alone, with no --unattended flag, is inert — attribution AND the setting must both hold', () => {
    const fixture = buildFixture({ requireWorkerIsolation: true })
    const result = runDispatch(fixture, [])

    expect(result.status).toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(true)
  })

  it('an attended dispatch (no --unattended, no config setting) is entirely unaffected — the pre-task-3 regression guard', () => {
    const fixture = buildFixture()
    const result = runDispatch(fixture, [])

    expect(result.status).toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(true)

    const lines = outboxLines(fixture.home) as Array<{ event?: string }>
    expect(lines.find((l) => l.event === 'dispatched')).toBeDefined()
    expect(lines.find((l) => l.event === 'outcome_received')).toBeDefined()
  })
})
