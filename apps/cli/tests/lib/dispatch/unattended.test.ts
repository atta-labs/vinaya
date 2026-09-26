import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `worker-isolation-v1` task 3 (`#560`), O3: `--unattended` (`DispatchOpts.unattended`)
 * marks a `vinaya dispatch` invocation as an unattended start; the SEPARATE
 * `dispatch.requireWorkerIsolation` config setting (`config.ts`) decides
 * whether that actually requires `apps/cli/specs/isolation.md`'s OS-level
 * boundary — an explicit config value always wins, and an unset value
 * resolves platform-conditionally: `true` on Darwin, `false` elsewhere
 * (round 2 review, HIGH; `dispatch.ts`'s own doc comment on this default).
 * Both `--unattended` and the resolved setting must hold for a dispatch to
 * refuse before any spawn when the boundary cannot be established.
 * Exercised through the real `vinaya dispatch` CLI entry point
 * (`execFileSync('bun', [INDEX, ...])`), the same discipline and the same
 * scratch-`HOME`/non-git-`cwd` reasoning `apps/cli/tests/lib/dispatch.test.ts`'s
 * own header documents — never by importing `dispatchRole` in-process, which
 * would write real launch/outbox records under this machine's own `HOME`.
 *
 * This fixture's `cwd` is a plain temp dir, never a real git repo, so on a
 * host where the resolved setting is `true` (Darwin, or any host with an
 * explicit override), `repoRoot()` resolves `null` and the boundary is
 * unavailable — the SAME refusal as the explicit-on case, not the inert
 * case a Linux CI host sees. The available-boundary branch (the
 * profile/env/command a resolved launch actually produces) is unit-tested
 * directly, with injected host detection, in `worker-boundary.test.ts` —
 * this file proves the WIRING, host-conditional default included: with the
 * setting resolving on, `--unattended` never reaches the vendor binary at
 * all; with it resolving off, `--unattended` is inert (the pre-existing
 * `dev-review-loop`/`dispatch-task` automated-loop call sites' own posture);
 * a dispatch with neither flag nor setting is entirely unaffected on every
 * host (the pre-task-3 regression guard), since that path never evaluates
 * the setting at all.
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

/**
 * Issue #660, O3 round 3 (security review, HIGH) — all three real `vinaya
 * dispatch --unattended` fixtures below spread `...process.env` straight
 * into the spawned child with no `VINAYA_*` stripping and no
 * `execFileSync` timeout: the same `VINAYA_RUNTIME_DIR` leak/no-budget
 * pattern already fixed in `apps/cli/tests/lib/dispatch.test.ts`'s own
 * `stripVinayaEnv` + budget.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  // Left in place, a leaked GITHUB_ACTIONS makes a spawned child's own
  // log() resolve its destination to 'none' (log-sink.ts's
  // resolveLogDestinationFrom) instead of the folder/server a test expects
  // — the same leak #721 fixed for the in-process loop harness.
  delete out.GITHUB_ACTIONS
  return out
}

const SUBPROCESS_BUDGET_MS = 18_000

function runVinayaDispatch(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bun', [INDEX, 'dispatch', ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      timeout: SUBPROCESS_BUDGET_MS,
      killSignal: 'SIGKILL'
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string | null }
    if (err.signal) {
      throw new Error(
        `vinaya dispatch --unattended subprocess killed by ${err.signal} after exceeding its ${SUBPROCESS_BUDGET_MS}ms budget ` +
          `(args: ${args.join(' ')})\n--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function runDispatch(fixture: Fixture, extraArgs: string[]): { status: number; stdout: string; stderr: string } {
  return runVinayaDispatch(
    fixture.cwd,
    ['developer', '--agent', 'claude', '--prompt-file', fixture.promptFile, ...extraArgs],
    { ...stripVinayaEnv(process.env), HOME: fixture.home, PATH: `${fixture.binDir}:${pathWithoutRealVendors()}` }
  )
}

function outboxLines(home: string): unknown[] {
  // [task-files-v1] 5, O1: the default `logs` destination is now a folder
  // under this repository's own `runtimeDir` — never the machine-global
  // `~/.vinaya/outbox/` this fixture resolves to `unresolved` (no git
  // origin in the scratch `cwd`).
  const p = join(home, '.vinaya', 'runtime', 'unresolved', 'logs', 'unresolved', 'none.ndjson')
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

  it("--unattended alone, with requireWorkerIsolation left unset, follows this host's resolved default", () => {
    const fixture = buildFixture()
    const result = runDispatch(fixture, ['--unattended'])

    if (process.platform === 'darwin') {
      // The unset default resolves `true` here, same as the explicit-on
      // case above — this fixture's non-repo cwd makes the boundary
      // unavailable, so the dispatch refuses the same way.
      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.markerFile)).toBe(false)
      expect(result.stderr).toContain('refused')
    } else {
      expect(result.status).toBe(0)
      expect(existsSync(fixture.markerFile)).toBe(true)
    }
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

/**
 * `worker-isolation-v1` task 3's own O3 fixture (`buildFixture`, above)
 * always makes the boundary itself unavailable (a plain, non-git `cwd`), so
 * every case there refuses before ever reaching O2's own credential check —
 * proving O2 needs a fixture where the boundary actually RESOLVES: a real
 * (if minimal) git repo as `cwd`, so `repoRoot()` finds it and the round-1
 * Developer bootstrap grants the confined boundary a real, if read-only,
 * launch (`apps/cli/specs/isolation.md` §4 item 4). This is Issue #640's
 * own fixture shape, distinct from `buildFixture`'s deliberately-unavailable
 * one above.
 */
function buildGitFixture(
  opts: { requireWorkerIsolation?: boolean; homeCredential?: string } = {}
): Fixture & { envCaptureFile: string } {
  const home = tempDir('vinaya-unattended-oauth-home-')
  const cwd = tempDir('vinaya-unattended-oauth-cwd-')
  const binDir = tempDir('vinaya-unattended-oauth-bin-')
  execFileSync('git', ['init', '-q'], { cwd })
  const promptFile = join(cwd, 'prompt.txt')
  writeFileSync(promptFile, 'do the thing')
  // Round-1 Developer bootstrap (`isolation.md` §4 item 4): the repo root
  // itself is READ-ONLY under confinement — only `.git`/`.worktrees` are
  // writable. A marker/capture file at the repo root would silently fail to
  // write (no error surfaced — the fake vendor script has no `set -e`, so a
  // denied `touch`/`printf` is swallowed and the final line still emits a
  // valid usage JSON, making the dispatch look like it "succeeded" while
  // actually proving nothing) — found live authoring this fixture. `.git`
  // is one of the two paths this bootstrap mode actually grants write to.
  const markerFile = join(cwd, '.git', 'vendor-was-run.marker')
  const envCaptureFile = join(cwd, '.git', 'env-capture.json')
  // Captures $CLAUDE_CONFIG_DIR into a file (never stdout — stdout must stay
  // the usage-shaped JSON `dispatch.ts`'s own vendor-output parser expects)
  // so a test that DOES spawn can assert the confined child saw a staged
  // path, distinct from the real fixture `home`.
  writeFileSync(
    join(binDir, 'claude'),
    [
      '#!/bin/bash',
      `touch "${markerFile}"`,
      `printf '{"claudeConfigDir":"%s"}' "$CLAUDE_CONFIG_DIR" > "${envCaptureFile}"`,
      'cat > /dev/null',
      `printf '%s' '{"session_id":"sess-x","usage":{"input_tokens":1,"output_tokens":1}}'`,
      'exit 0'
    ].join('\n')
  )
  chmodSync(join(binDir, 'claude'), 0o755)
  if (opts.requireWorkerIsolation !== undefined) {
    writeFileSync(
      join(cwd, 'vinaya.config.json'),
      JSON.stringify({ dispatch: { requireWorkerIsolation: opts.requireWorkerIsolation } })
    )
  }
  if (opts.homeCredential !== undefined) {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', '.credentials.json'), opts.homeCredential)
  }
  return { home, cwd, binDir, promptFile, markerFile, envCaptureFile }
}

/**
 * Same shape as `runDispatch`, but drops `CLAUDE_CONFIG_DIR` from the
 * spawned CLI's own environment first — the Operator's real shell may
 * override it, which would point a "no subscription login" fixture at a
 * real credential directory outside its own scratch `HOME` and defeat the
 * test. No API-key variable needs dropping: no dispatch path reads one.
 */
function runDispatchNoAmbientLogin(
  fixture: Fixture,
  extraArgs: string[],
  agent = 'claude',
  extraEnv: NodeJS.ProcessEnv = {}
): { status: number; stdout: string; stderr: string } {
  const { CLAUDE_CONFIG_DIR: _drop, ...envWithoutConfigDir } = process.env
  return runVinayaDispatch(
    fixture.cwd,
    ['developer', '--agent', agent, '--prompt-file', fixture.promptFile, ...extraArgs],
    {
      ...stripVinayaEnv(envWithoutConfigDir),
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${pathWithoutRealVendors()}`,
      ...extraEnv
    }
  )
}

describe('vinaya dispatch --unattended — O2 fail-closed refusal (Issue #640, no resolvable credential)', () => {
  it.skipIf(process.platform !== 'darwin')(
    'refuses before ever spawning the vendor binary, boundary resolved but no subscription login to stage',
    () => {
      const fixture = buildGitFixture({ requireWorkerIsolation: true })
      const result = runDispatchNoAmbientLogin(fixture, ['--unattended'])

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.markerFile), 'the vendor binary must never be spawned at all').toBe(false)
      expect(existsSync(fixture.envCaptureFile)).toBe(false)
      expect(result.stderr).toContain('refused')
      expect(result.stderr).toContain('no resolvable credential')
      // O3: the refusal names where this looked and how to sign in, never
      // an API key — the operator can act on it without reading the source.
      expect(result.stderr).toContain(join(fixture.home, '.claude', '.credentials.json'))
      expect(result.stderr).toContain('/login')
      expect(result.stderr.toLowerCase()).not.toContain('api key')

      const lines = outboxLines(fixture.home) as Array<{ event?: string; reason?: string }>
      const failed = lines.find((l) => l.event === 'dispatch_failed')
      expect(failed).toBeDefined()
      expect(failed?.reason).toBe('refused')
      expect(lines.find((l) => l.event === 'dispatched')).toBeUndefined()
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'succeeds, staging a scoped copy, when a real OAuth session credential exists at the fixture HOME — never refused',
    () => {
      const fixture = buildGitFixture({
        requireWorkerIsolation: true,
        homeCredential: JSON.stringify({ accessToken: 'fixture-not-a-real-oauth-token' })
      })
      const result = runDispatchNoAmbientLogin(fixture, ['--unattended'])

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(existsSync(fixture.markerFile)).toBe(true)

      const captured = JSON.parse(readFileSync(fixture.envCaptureFile, 'utf8')) as { claudeConfigDir: string }
      expect(captured.claudeConfigDir.length).toBeGreaterThan(0)
      expect(
        captured.claudeConfigDir,
        'the confined child must see a STAGED copy, never the real fixture HOME/.claude'
      ).not.toBe(join(fixture.home, '.claude'))
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'O1: a vendor API key on the controller environment no longer authenticates anything — the same fixture still refuses, and still never spawns',
    () => {
      const fixture = buildGitFixture({ requireWorkerIsolation: true })
      // The variable name is COMPOSED rather than written out, for the same
      // reason `worker-boundary.test.ts`'s own allowlist test composes
      // hers: no API-key name appears anywhere in this repository's
      // sources, tests or specs, and a regression test must not be the one
      // exception that reintroduces one.
      const result = runDispatchNoAmbientLogin(fixture, ['--unattended'], 'claude', {
        [`${'ANTHROPIC'}_API_KEY`]: 'sk-ant-fixture-not-real'
      })

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.markerFile), 'an API key must not start a vendor process').toBe(false)
      expect(result.stderr).toContain('no resolvable credential')
    }
  )
})

describe('vinaya dispatch --unattended — O2 Gemini has no subscription login yet', () => {
  it('refuses before any spawn, naming the missing subscription login rather than a missing API key', () => {
    const fixture = buildGitFixture({ requireWorkerIsolation: true })
    // A real fake `gemini` on the fixture PATH, so a refusal here can only
    // be the no-subscription-login one — never "binary not resolvable".
    writeFileSync(
      join(fixture.binDir, 'gemini'),
      `#!/bin/sh
touch "${fixture.markerFile}"
cat > /dev/null
printf '%s' '{}'
exit 0
`
    )
    chmodSync(join(fixture.binDir, 'gemini'), 0o755)

    const result = runDispatchNoAmbientLogin(fixture, ['--unattended'], 'gemini')

    expect(result.status).not.toBe(0)
    expect(existsSync(fixture.markerFile), 'the gemini binary must never be spawned at all').toBe(false)
    expect(result.stderr).toContain('refused')
    expect(result.stderr).toContain('no subscription login in Vinaya yet')
    // The wording rules an API key OUT rather than asking for one — the
    // failure an operator reads is a missing login, never a missing key.
    expect(result.stderr).toContain('no agent authenticates with an API key')

    const lines = outboxLines(fixture.home) as Array<{ event?: string; reason?: string }>
    expect(lines.find((l) => l.event === 'dispatch_failed')?.reason).toBe('refused')
    expect(lines.find((l) => l.event === 'dispatched')).toBeUndefined()
  })

  it('refuses on a host where the worker sandbox is off too — the refusal is about the login, not the boundary', () => {
    const fixture = buildGitFixture({ requireWorkerIsolation: false })
    writeFileSync(
      join(fixture.binDir, 'gemini'),
      `#!/bin/sh
touch "${fixture.markerFile}"
cat > /dev/null
printf '%s' '{}'
exit 0
`
    )
    chmodSync(join(fixture.binDir, 'gemini'), 0o755)

    const result = runDispatchNoAmbientLogin(fixture, ['--unattended'], 'gemini')

    expect(result.status).not.toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(false)
    expect(result.stderr).toContain('no subscription login in Vinaya yet')
  })

  it('an ATTENDED gemini dispatch is untouched — a human at their own terminal signs their vendor CLI in themselves', () => {
    const fixture = buildGitFixture({ requireWorkerIsolation: false })
    writeFileSync(
      join(fixture.binDir, 'gemini'),
      `#!/bin/sh
touch "${fixture.markerFile}"
cat > /dev/null
printf '%s' '{}'
exit 0
`
    )
    chmodSync(join(fixture.binDir, 'gemini'), 0o755)

    const result = runDispatchNoAmbientLogin(fixture, [], 'gemini')

    expect(existsSync(fixture.markerFile), 'an attended dispatch still reaches the vendor binary').toBe(true)
    expect(result.stderr).not.toContain('no subscription login in Vinaya yet')
  })
})
