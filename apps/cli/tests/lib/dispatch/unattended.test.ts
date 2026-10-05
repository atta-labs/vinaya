import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLinuxSandboxTools } from '../../../src/lib/worker-boundary.js'
import { spawnSyncBudgeted } from '../process-fixture.js'

/**
 * O3: `--unattended` (`DispatchOpts.unattended`) marks a `vinaya dispatch`
 * invocation as an unattended start. There is no setting behind it: both
 * Claude and Codex refuse before spawn when their worker sandbox cannot be
 * established. Exercised through the real `vinaya dispatch` CLI entry
 * point (`execFileSync('bun', [INDEX, ...])`), the same discipline and the
 * same scratch-`HOME`/non-git-`cwd` reasoning `apps/cli/tests/lib/dispatch.test.ts`'s
 * own header documents — never by importing `dispatchRole` in-process, which
 * would write real launch/outbox records under this machine's own `HOME`.
 * The scratch `HOME` also keeps the host's real Keychain login out of reach,
 * so a "no login" fixture really has none.
 *
 * This fixture's `cwd` is a plain temp dir, never a real git repo, so on
 * macOS `repoRoot()` resolves `null` and the boundary is unavailable. The
 * available-boundary branch (the profile/env/command a resolved launch
 * actually produces) is unit-tested directly, with injected host detection,
 * in `worker-boundary.test.ts`.
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

function buildFixture(): Fixture {
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

describe('vinaya dispatch --unattended — Claude confinement', () => {
  it.skipIf(process.platform !== 'darwin')(
    "on darwin, confines via Claude Code's own sandbox settings and still spawns the vendor binary, even with no git worktree",
    () => {
      // Task 3 retires the OLD premise this fixture was built to exercise —
      // that an unattended Claude start shared Codex's `repoRoot()`-dependent
      // Seatbelt boundary and so refused on a plain, non-git `cwd`. Claude's
      // own confinement (`resolveClaudeConfinement`) needs no worktree
      // resolution at all: it is always available on macOS, so this exact
      // fixture now succeeds, confined, rather than refusing.
      const fixture = buildFixture()
      const result = runDispatch(fixture, ['--unattended'])

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(existsSync(fixture.markerFile)).toBe(true)

      const lines = outboxLines(fixture.home) as Array<{ event?: string }>
      expect(lines.find((l) => l.event === 'dispatched')).toBeDefined()
      expect(lines.find((l) => l.event === 'dispatch_failed')).toBeUndefined()
    }
  )

  it.skipIf(process.platform !== 'linux' || checkLinuxSandboxTools().available)(
    'on a linux host without bubblewrap/socat, refuses before spawn and records the missing confinement in the Vinaya Log',
    () => {
      // `runVinayaDispatch` only captures `stderr` on a NON-zero exit (its
      // own `try` branch returns `stderr: ''` on success), so the warning
      // TEXT itself — confirmed live via a direct `vinaya dispatch` run on
      // this exact dev/CI host, which genuinely lacks `bwrap` — is proven by
      // `worker-boundary.test.ts`'s own unit-level coverage of
      // `resolveClaudeConfinement`'s `warning` field, not observable through
      // this subprocess harness. What IS observable here, through the
      // fixture's own isolated outbox: the dispatch refuses before the vendor
      // starts, AND (round 2 review, MAJOR) the missing confinement
      // reaches the Vinaya Log itself, not only `writeLifecycle`'s own
      // stderr/driver.log mirror — a real `operation`/`completed` line,
      // read back from the SAME fixture `HOME` every other assertion in
      // this file already reads its own outbox from.
      const fixture = buildFixture()
      const result = runDispatch(fixture, ['--unattended'])

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.markerFile)).toBe(false)

      const lines = outboxLines(fixture.home) as Array<{
        kind?: string
        event?: string
        operation?: string
        result?: string
        target?: string | null
      }>
      const confinementLine = lines.find((l) => l.kind === 'operation' && l.operation === 'claude-sandbox-confinement')
      expect(confinementLine).toBeDefined()
      expect(confinementLine?.event).toBe('completed')
      expect(confinementLine?.result).toBe('unavailable')
      expect(confinementLine?.target).toContain('bwrap')
      expect(lines.find((l) => l.event === 'dispatch_failed')).toBeDefined()
    }
  )

  for (const bridge of [false, true]) {
    it(`refuses an unconfined unattended Claude worker ${bridge ? 'with' : 'without'} a dev-tools bridge`, () => {
      const fixture = buildFixture()
      const outputFile = join(fixture.cwd, 'dispatch-result.json')
      const scriptFile = join(fixture.cwd, 'dispatch-probe.ts')
      const dispatchLib = join(CLI_ROOT, 'src', 'lib', 'dispatch.ts')
      writeFileSync(
        scriptFile,
        [
          "import { writeFileSync } from 'node:fs'",
          `import { dispatchRole } from ${JSON.stringify(dispatchLib)}`,
          // Force the unsupported-platform branch in this isolated child so
          // the refusal is exercised on macOS and Linux CI alike.
          "Object.defineProperty(process, 'platform', { value: 'win32' })",
          "const result = await dispatchRole('developer', 'claude', 'probe', {",
          `  promptFile: ${JSON.stringify(fixture.promptFile)},`,
          `  cwd: ${JSON.stringify(fixture.cwd)},`,
          '  unattended: true,',
          ...(bridge ? ["  devToolsBridge: { command: 'false', args: [] },"] : []),
          '})',
          `writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify(result))`
        ].join('\n')
      )
      const probe = spawnSyncBudgeted(
        'bun',
        [scriptFile],
        {
          cwd: fixture.cwd,
          encoding: 'utf8',
          env: {
            ...stripVinayaEnv(process.env),
            HOME: fixture.home,
            PATH: `${fixture.binDir}:${pathWithoutRealVendors()}`
          }
        },
        SUBPROCESS_BUDGET_MS,
        'unconfined Claude dispatch probe'
      )
      expect(probe.status, probe.stderr).toBe(0)
      const result = JSON.parse(readFileSync(outputFile, 'utf8')) as { failureReason: string; exitCode: number | null }
      expect(result.failureReason).toBe('refused')
      expect(result.exitCode).toBeNull()
      expect(existsSync(fixture.markerFile)).toBe(false)
    })
  }

  it('an attended dispatch (no --unattended) is entirely unaffected — the pre-task-3 regression guard', () => {
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
function buildGitFixture(opts: { homeCredential?: string } = {}): Fixture & { envCaptureFile: string } {
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
      `printf '{"claudeConfigDir":"%s","ghTelemetry":"%s"}' "$CLAUDE_CONFIG_DIR" "$GH_TELEMETRY" > "${envCaptureFile}"`,
      'cat > /dev/null',
      `printf '%s' '{"session_id":"sess-x","usage":{"input_tokens":1,"output_tokens":1}}'`,
      'exit 0'
    ].join('\n')
  )
  chmodSync(join(binDir, 'claude'), 0o755)
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
  if (agent === 'claude' && extraArgs.includes('--unattended')) {
    // Only Claude success fixtures need sandbox prerequisites. The Codex
    // refusal fixture below must still see a host without them.
    for (const tool of ['bwrap', 'socat']) {
      const toolPath = join(fixture.binDir, tool)
      writeFileSync(toolPath, '#!/bin/sh\nexit 0\n')
      chmodSync(toolPath, 0o755)
    }
  }
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

describe('vinaya dispatch --unattended — task 3: Claude stages and pre-checks no credential at all', () => {
  // Pre-task-3, an unattended Claude dispatch ran through the hand-built
  // Seatbelt boundary, which denied the real `HOME` outright — so a staged
  // COPY of the OAuth credential, and a pre-spawn refusal when none could be
  // staged, were load-bearing (Issue #640). Claude's own native sandbox
  // never confines Claude Code's own main process (`isolation.md` §4,
  // "Claude Code itself runs unconfined") — only its tools are — so this
  // dispatch now needs neither: it never rewrites `CLAUDE_CONFIG_DIR` and
  // never pre-checks a credential before spawning, on EITHER platform,
  // which is why these two tests are not platform-gated.
  it('never stages or rewrites CLAUDE_CONFIG_DIR, and still succeeds with no credential at the fixture HOME', () => {
    const fixture = buildGitFixture()
    const result = runDispatchNoAmbientLogin(fixture, ['--unattended'])

    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(true)

    const captured = JSON.parse(readFileSync(fixture.envCaptureFile, 'utf8')) as {
      claudeConfigDir: string
      ghTelemetry: string
    }
    expect(captured.claudeConfigDir, 'dispatch.ts never sets CLAUDE_CONFIG_DIR for Claude any more').toBe('')
    expect(captured.ghTelemetry).toBe('0')
  })

  it('still never stages or rewrites CLAUDE_CONFIG_DIR when a real OAuth session credential exists at the fixture HOME', () => {
    const fixture = buildGitFixture({
      homeCredential: JSON.stringify({ accessToken: 'fixture-not-a-real-oauth-token' })
    })
    const result = runDispatchNoAmbientLogin(fixture, ['--unattended'])

    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(true)

    const captured = JSON.parse(readFileSync(fixture.envCaptureFile, 'utf8')) as { claudeConfigDir: string }
    expect(
      captured.claudeConfigDir,
      "unset — Claude Code's own main process reads the real fixture HOME directly, unconfined"
    ).toBe('')
  })

  it('a vendor API key on the controller environment is simply inert — no credential gate reads it, for or against', () => {
    const fixture = buildGitFixture()
    // The variable name is COMPOSED rather than written out, for the same
    // reason `worker-boundary.test.ts`'s own allowlist test composes
    // hers: no API-key name appears anywhere in this repository's
    // sources, tests or specs, and a regression test must not be the one
    // exception that reintroduces one.
    const result = runDispatchNoAmbientLogin(fixture, ['--unattended'], 'claude', {
      [`${'ANTHROPIC'}_API_KEY`]: 'sk-ant-fixture-not-real'
    })

    expect(result.status, `stderr: ${result.stderr}`).toBe(0)
    expect(existsSync(fixture.markerFile)).toBe(true)
  })
})

describe('vinaya dispatch --unattended — O2 Gemini has no subscription login yet', () => {
  it('refuses before any spawn, naming the missing subscription login rather than a missing API key', () => {
    const fixture = buildGitFixture()
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

  it('the refusal is about the login, not the boundary — it names no boundary failure', () => {
    const fixture = buildGitFixture()
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
    const fixture = buildGitFixture()
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

describe('vinaya dispatch --unattended — O4 a Codex start never runs outside the worker sandbox', () => {
  it('refuses before any spawn on every host — no boundary resolvable, so no per-run CODEX_HOME and no real ~/.codex', () => {
    const fixture = buildFixture()
    writeFileSync(
      join(fixture.binDir, 'codex'),
      `#!/bin/sh\ntouch "${fixture.markerFile}"\ncat > /dev/null\nprintf '%s' '{}'\nexit 0\n`
    )
    chmodSync(join(fixture.binDir, 'codex'), 0o755)

    const result = runDispatchNoAmbientLogin(fixture, ['--unattended'], 'codex')

    expect(result.status).not.toBe(0)
    expect(existsSync(fixture.markerFile), 'the codex binary must never be spawned').toBe(false)
    expect(result.stderr).toContain('refused')
    // O4 (task 4): Codex's own sandbox/network-proxy mechanism, resolved
    // through `resolveCodexConfinement`, replaced the hand-built Seatbelt
    // boundary's own "worker isolation boundary" refusal wording.
    expect(result.stderr).toContain("Codex's own sandbox and network proxy")
    const lines = outboxLines(fixture.home) as Array<{ event?: string; reason?: string }>
    expect(lines.find((l) => l.event === 'dispatch_failed')?.reason).toBe('refused')
    expect(lines.find((l) => l.event === 'dispatched')).toBeUndefined()
  })

  it.skipIf(process.platform === 'darwin')(
    'names the missing capability where the sandbox/network-proxy mechanism is unsupported',
    () => {
      const fixture = buildGitFixture()
      writeFileSync(
        join(fixture.binDir, 'codex'),
        `#!/bin/sh\ntouch "${fixture.markerFile}"\ncat > /dev/null\nprintf '%s' '{}'\nexit 0\n`
      )
      chmodSync(join(fixture.binDir, 'codex'), 0o755)

      const result = runDispatchNoAmbientLogin(fixture, ['--unattended'], 'codex')

      expect(result.status).not.toBe(0)
      expect(existsSync(fixture.markerFile)).toBe(false)
      // O4: this CI host is Linux without `bwrap` — the missing capability
      // `resolveCodexConfinement` names, not a bare "unavailable on this host".
      expect(result.stderr).toContain('bwrap')
    }
  )
})

describe('vinaya dispatch — attended Claude retains the operator environment', () => {
  it.skipIf(process.platform === 'darwin')(
    'an unconfined dispatch inherits the operator environment unchanged, so the agent signs in with its own subscription login',
    () => {
      const fixture = buildGitFixture()
      // The fake vendor reports back, through a shell probe rather than a
      // `process.env` read, what its own environment actually carried — a
      // confined child's `bun`/`node` reads `process.env` back empty under
      // Seatbelt, so only a shell probe answers the same way on both paths.
      writeFileSync(
        join(fixture.binDir, 'claude'),
        [
          '#!/bin/bash',
          `touch "${fixture.markerFile}"`,
          `printf '{"inherited":"%s","home":"%s"}' "$ISOLATION_FIXTURE_MARKER" "$HOME" > "${fixture.envCaptureFile}"`,
          'cat > /dev/null',
          `printf '%s' '{"session_id":"sess-x","usage":{"input_tokens":1,"output_tokens":1}}'`,
          'exit 0'
        ].join('\n')
      )
      chmodSync(join(fixture.binDir, 'claude'), 0o755)

      const result = runDispatchNoAmbientLogin(fixture, [], 'claude', {
        ISOLATION_FIXTURE_MARKER: 'inherited-from-the-operator'
      })

      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(existsSync(fixture.markerFile)).toBe(true)
      const captured = JSON.parse(readFileSync(fixture.envCaptureFile, 'utf8')) as {
        inherited: string
        home: string
      }
      // A variable no allowlist names: only a whole-environment spread
      // carries it, which is exactly the sandbox-off path's own shape.
      expect(captured.inherited).toBe('inherited-from-the-operator')
      // And the child's HOME is the operator's real one, never a staged or
      // synthetic directory — nothing about this path is rewritten.
      expect(captured.home).toBe(fixture.home)
    }
  )
})
