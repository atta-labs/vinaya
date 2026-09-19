import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { execFileSync, spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runPath } from '../../../src/lib/run-paths'
import {
  buildWorkerEnv,
  buildWorkerSandboxProfile,
  isWorkerBoundaryAvailable,
  REAL_WORKER_BOUNDARY_DEPS,
  resolveOAuthConfigSourceDir,
  resolveWorkerBoundaryLaunch,
  RUNTIME_CREDENTIAL_ENV_KEYS,
  stageOAuthCredential,
  WORKER_ENV_ALLOWLIST_KEYS,
  type WorkerBoundaryDeps
} from '../../../src/lib/worker-boundary'

/**
 * `worker-isolation-v1` task 3 (`#560`) — O2's env allowlist, O3's host
 * detection and fail-closed resolution, and O1's profile construction, all
 * exercised as pure/injectable functions so the "malicious test script
 * cannot read credentials" and "unattended without boundary refused"
 * properties are provable on ANY host, never only on the Darwin host
 * `isolation.md` §3 names as supported (see `isolation-probe.test.ts`'s own
 * `skipIf(!isSandboxSupported())` precedent for the parts that genuinely do
 * need one).
 */

/**
 * issue-657, O5 — every live spawn in this file runs a REAL confined child
 * (`bwrap`/`sandbox-exec` wrapping a probe script or `bun`), and a hang
 * anywhere in that chain — a probe waiting on stdin, a confinement wrapper
 * itself stalling — used to burn a core indefinitely: `spawnSync` with no
 * `timeout` blocks forever, and found live, once, on a Linux host running
 * exactly this suite. Every call site here now goes through this wrapper
 * instead of `spawnSync` directly: `detached: true` makes the child the
 * leader of its OWN process group (never the test runner's), and the
 * `finally` below kills that whole group unconditionally once `spawnSync`
 * returns — whether it returned because the child exited on its own, or
 * because the bounded `timeout` fired and `spawnSync`'s own `killSignal`
 * only reached the immediate child, potentially leaving a confinement
 * wrapper's own grandchildren behind. The explicit group kill is a no-op
 * (`ESRCH`) in the ordinary case where nothing survives the child's own
 * exit; it is the actual cleanup in the hang case. A caller-supplied
 * `timeout` (e.g. a probe expected to need longer) overrides the default.
 */
function spawnConfinedSync(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; encoding?: 'utf8' } = {}
): { status: number | null; stdout: string; stderr: string; pid?: number } {
  const spawnOpts: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
    timeout: 10_000,
    killSignal: 'SIGKILL',
    ...opts,
    encoding: 'utf8',
    // `detached` is a real, honored `spawnSync` option at runtime (the
    // child becomes the leader of its own process group) even though
    // `@types/node`'s `SpawnSyncOptions` does not declare it for the sync
    // variant — the extended type above reflects a type-declaration gap,
    // not an unsupported feature (verified live: the child's own pgid
    // equals its pid with this option set).
    detached: true
  }
  const result = spawnSync(command, args, spawnOpts)
  if (typeof result.pid === 'number') {
    try {
      process.kill(-result.pid, 'SIGKILL')
    } catch {
      // ESRCH — the group is already gone, the ordinary case.
    }
  }
  return result
}

function tempDir(prefix: string): string {
  // `realpathSync`: on macOS `tmpdir()` is `/var/...`, a symlink to
  // `/private/var/...`, and the profile builder writes the CANONICAL path.
  // Comparing against the uncanonical one fails on Darwin only — the exact
  // host this boundary is built for. Canonicalise here, once.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

const AVAILABLE_DEPS: WorkerBoundaryDeps = {
  detectHost: () => ({ platform: 'darwin', sandboxExecExecutable: true })
}

function fakeBinaryIn(binDir: string): string {
  const fakeBinary = join(binDir, 'fake-vendor')
  writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n')
  chmodSync(fakeBinary, 0o755)
  return fakeBinary
}

describe('buildWorkerEnv — O2 allowlist, never a spread', () => {
  it('carries over only WORKER_ENV_ALLOWLIST_KEYS from sourceEnv', () => {
    const env = buildWorkerEnv(
      { PATH: '/usr/bin', HOME: '/home/dev', GH_TOKEN: 'ghp_super_secret', SSH_AUTH_SOCK: '/tmp/agent.sock' },
      {}
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/dev')
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.SSH_AUTH_SOCK).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH'])
  })

  it('never includes a key outside WORKER_ENV_ALLOWLIST_KEYS regardless of how many the source carries', () => {
    const wideSource: Record<string, string> = {}
    for (let i = 0; i < 50; i++) wideSource[`SECRET_VAR_${i}`] = `leaked-${i}`
    const env = buildWorkerEnv(wideSource, {})
    for (const key of Object.keys(env)) {
      expect((WORKER_ENV_ALLOWLIST_KEYS as readonly string[]).includes(key)).toBe(true)
    }
  })

  it('always includes every attribution entry, even when absent from the allowlist', () => {
    const env = buildWorkerEnv({}, { VINAYA_RUN_ID: 'run-1', VINAYA_ROLE: 'developer' })
    expect(env.VINAYA_RUN_ID).toBe('run-1')
    expect(env.VINAYA_ROLE).toBe('developer')
  })

  it('attribution wins over a same-named allowlist value', () => {
    const env = buildWorkerEnv({ PATH: '/from-source' }, { PATH: '/from-attribution' })
    expect(env.PATH).toBe('/from-attribution')
  })

  it('threads an extraAllowlistKeys entry through when present on the source, same as a baseline key', () => {
    const env = buildWorkerEnv({ ANTHROPIC_API_KEY: 'sk-ant-fixture-not-real' }, {}, ['ANTHROPIC_API_KEY'])
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-fixture-not-real')
  })

  it('never includes an extraAllowlistKeys entry the source does not carry', () => {
    const env = buildWorkerEnv({}, {}, ['ANTHROPIC_API_KEY'])
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('never includes an unrelated vendor credential key not named in extraAllowlistKeys', () => {
    const env = buildWorkerEnv({ ANTHROPIC_API_KEY: 'leak', OPENAI_API_KEY: 'also-leak' }, {}, ['OPENAI_API_KEY'])
    expect(env.OPENAI_API_KEY).toBe('also-leak')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
})

describe('RUNTIME_CREDENTIAL_ENV_KEYS — round 2 review, BLOCKER (a real model-runtime credential route)', () => {
  it('names ANTHROPIC_API_KEY for claude — verified live on this authoring host via `claude --help`', () => {
    expect(RUNTIME_CREDENTIAL_ENV_KEYS.claude).toEqual(['ANTHROPIC_API_KEY'])
  })

  it('names a vendor key for codex and gemini too, disclosed as convention-based rather than live-verified', () => {
    expect(RUNTIME_CREDENTIAL_ENV_KEYS.codex?.length).toBeGreaterThan(0)
    expect(RUNTIME_CREDENTIAL_ENV_KEYS.gemini?.length).toBeGreaterThan(0)
  })

  it('an unknown vendor string yields no entry — a caller falls back to an empty list, never throws', () => {
    expect(RUNTIME_CREDENTIAL_ENV_KEYS['not-a-real-vendor']).toBeUndefined()
  })
})

describe('resolveOAuthConfigSourceDir — O1 (Issue #640)', () => {
  it('defaults to <realHome>/.claude when the source env carries no CLAUDE_CONFIG_DIR', () => {
    expect(resolveOAuthConfigSourceDir({}, '/home/dev')).toBe(join('/home/dev', '.claude'))
  })

  it('honors an explicit CLAUDE_CONFIG_DIR override on the source env', () => {
    expect(resolveOAuthConfigSourceDir({ CLAUDE_CONFIG_DIR: '/custom/config' }, '/home/dev')).toBe('/custom/config')
  })
})

describe('stageOAuthCredential — O1 (Issue #640)', () => {
  it('returns null, and writes nothing, when no credential file exists at the source', () => {
    const scratchTmpDir = tempDir('vinaya-wb-oauth-stage-none-')
    const result = stageOAuthCredential({}, '/home/dev', scratchTmpDir, { readOAuthCredentialFile: () => null })
    expect(result).toBeNull()
    expect(existsSync(join(scratchTmpDir, 'claude-config'))).toBe(false)
  })

  it('stages a scoped COPY of the credential contents into scratchTmpDir, never the real source path', () => {
    const scratchTmpDir = tempDir('vinaya-wb-oauth-stage-copy-')
    const fixtureContents = JSON.stringify({ accessToken: 'fixture-not-a-real-oauth-token' })
    let requestedPath: string | null = null
    const result = stageOAuthCredential({}, '/home/dev', scratchTmpDir, {
      readOAuthCredentialFile: (path) => {
        requestedPath = path
        return fixtureContents
      }
    })
    expect(requestedPath).toBe(join('/home/dev', '.claude', '.credentials.json'))
    expect(result).not.toBeNull()
    const stagedPath = join(result!.configDir, '.credentials.json')
    expect(stagedPath.startsWith(scratchTmpDir)).toBe(true)
    expect(stagedPath).not.toContain('/home/dev')
    expect(readFileSync(stagedPath, 'utf8')).toBe(fixtureContents)
  })

  it('reads from CLAUDE_CONFIG_DIR when the source env sets one, rather than the <realHome>/.claude default', () => {
    const scratchTmpDir = tempDir('vinaya-wb-oauth-stage-override-')
    let requestedPath: string | null = null
    stageOAuthCredential({ CLAUDE_CONFIG_DIR: '/custom/config' }, '/home/dev', scratchTmpDir, {
      readOAuthCredentialFile: (path) => {
        requestedPath = path
        return '{}'
      }
    })
    expect(requestedPath).toBe(join('/custom/config', '.credentials.json'))
  })

  it('falls back to a real file read when no readOAuthCredentialFile dep is given', () => {
    const scratchTmpDir = tempDir('vinaya-wb-oauth-stage-realread-')
    const result = stageOAuthCredential({ CLAUDE_CONFIG_DIR: '/definitely/does/not/exist' }, '/home/dev', scratchTmpDir)
    expect(result).toBeNull()
  })
})

describe('resolveWorkerBoundaryLaunch — OAuth credential staging (O1, Issue #640, injected deps)', () => {
  it('stageOAuthCredential: true with a credential present resolves a non-null oauthConfigDir readable inside the launch', () => {
    const allowedDir = tempDir('vinaya-wb-oauth-launch-allowed-')
    const fixtureContents = JSON.stringify({ accessToken: 'fixture-not-a-real-oauth-token' })
    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: '/usr/bin/env',
        args: [],
        allowedDir,
        extraWritableDirs: [],
        stageOAuthCredential: true
      },
      { ...AVAILABLE_DEPS, readOAuthCredentialFile: () => fixtureContents }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      expect(result.launch.oauthConfigDir).not.toBeNull()
      const stagedPath = join(result.launch.oauthConfigDir as string, '.credentials.json')
      expect(readFileSync(stagedPath, 'utf8')).toBe(fixtureContents)
    } finally {
      result.launch.cleanup()
    }
  })

  it('stageOAuthCredential: true with no credential present resolves oauthConfigDir: null, never throws', () => {
    const allowedDir = tempDir('vinaya-wb-oauth-launch-missing-allowed-')
    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: '/usr/bin/env',
        args: [],
        allowedDir,
        extraWritableDirs: [],
        stageOAuthCredential: true
      },
      { ...AVAILABLE_DEPS, readOAuthCredentialFile: () => null }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.launch.oauthConfigDir).toBeNull()
    result.launch.cleanup()
  })

  it('stageOAuthCredential omitted never attempts staging, even when a credential would be found', () => {
    const allowedDir = tempDir('vinaya-wb-oauth-launch-disabled-allowed-')
    const result = resolveWorkerBoundaryLaunch(
      { binaryPath: '/usr/bin/env', args: [], allowedDir, extraWritableDirs: [] },
      { ...AVAILABLE_DEPS, readOAuthCredentialFile: () => '{"accessToken":"should-never-be-staged"}' }
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.launch.oauthConfigDir).toBeNull()
    result.launch.cleanup()
  })
})

describe('isWorkerBoundaryAvailable — O3 host detection', () => {
  it('reports false when the platform is not darwin, even with sandbox-exec present', () => {
    expect(isWorkerBoundaryAvailable({ detectHost: () => ({ platform: 'linux', sandboxExecExecutable: true }) })).toBe(
      false
    )
  })

  it('reports false on darwin when sandbox-exec is not executable', () => {
    expect(
      isWorkerBoundaryAvailable({ detectHost: () => ({ platform: 'darwin', sandboxExecExecutable: false }) })
    ).toBe(false)
  })

  it('reports true only when both darwin and sandbox-exec are present', () => {
    expect(isWorkerBoundaryAvailable(AVAILABLE_DEPS)).toBe(true)
  })

  it("on THIS host (documented scope, not a gap — mirrors isolation-probe.test.ts's own unsupported-host assertion), the real default deps report unavailable", () => {
    expect(isWorkerBoundaryAvailable()).toBe(process.platform === 'darwin')
  })
})

describe('resolveWorkerBoundaryLaunch — O3 fail-closed refusal', () => {
  it('refuses, naming the host, when the boundary is unavailable', () => {
    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: '/usr/bin/env',
        args: [],
        allowedDir: tempDir('vinaya-wb-'),
        extraWritableDirs: []
      },
      { detectHost: () => ({ platform: 'linux', sandboxExecExecutable: false }) }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('platform: linux')
      expect(result.reason).toContain('sandbox-exec: absent')
    }
  })

  it('never falls back to an unconfined launch when refused — there is no `launch` on the ok:false branch', () => {
    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: '/usr/bin/env',
        args: [],
        allowedDir: tempDir('vinaya-wb-'),
        extraWritableDirs: []
      },
      { detectHost: () => ({ platform: 'linux', sandboxExecExecutable: false }) }
    )
    expect('launch' in result).toBe(false)
  })
})

describe('resolveWorkerBoundaryLaunch — O1/O2 resolved launch (available boundary, injected deps)', () => {
  it('wraps the binary with sandbox-exec and a generated profile naming the allowed directory', () => {
    const allowedDir = tempDir('vinaya-wb-allowed-')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: ['--foo', 'bar'],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')]
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      expect(result.launch.command).toBe('/usr/bin/sandbox-exec')
      expect(result.launch.args[0]).toBe('-f')
      const profilePath = result.launch.args[1] as string
      expect(existsSync(profilePath)).toBe(true)
      expect(result.launch.args.slice(2)).toEqual([fakeBinary, '--foo', 'bar'])

      const profile = readFileSync(profilePath, 'utf8')
      expect(profile).toContain('(deny default)')
      expect(profile).toContain('(import "system.sb")')
      expect(profile).toContain(allowedDir)
      expect(profile).toContain('com.apple.securityd')
      expect(profile).toContain('(deny signal)')
      expect(profile).toContain('(deny process-info* (target others))')
      // round 3 review, HIGH: network-outbound is denied by default and
      // allowed only on the plain HTTP(S) ports a model-runtime/registry
      // client actually needs — never a blanket allow.
      expect(profile).toContain('(deny network-outbound)')
      expect(profile).toContain('(allow network-outbound (remote tcp "*:443"))')
      expect(profile).toContain('(allow network-outbound (remote tcp "*:80"))')
    } finally {
      result.launch.cleanup()
    }
  })

  it("(steady state, no bootstrapWritableSubpaths) grants allowedDir full read+write — a Worker's own worktree, a Reviewer's own scratch copy", () => {
    const allowedDir = tempDir('vinaya-wb-allowed-')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')]
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      // allowedDir appears inside a `file-read* file-write*` allow rule.
      const rwBlockStart = profile.indexOf('(allow file-read* file-write*')
      const rwBlockEnd = profile.indexOf(')', profile.indexOf(allowedDir, rwBlockStart))
      expect(rwBlockStart).toBeGreaterThan(-1)
      expect(profile.indexOf(allowedDir, rwBlockStart)).toBeLessThan(rwBlockEnd + 1)
    } finally {
      result.launch.cleanup()
    }
  })

  it('cleanup removes the generated profile directory', () => {
    const allowedDir = tempDir('vinaya-wb-allowed-')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')]
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const profilePath = result.launch.args[1] as string
    result.launch.cleanup()
    expect(existsSync(profilePath)).toBe(false)
    expect(existsSync(dirname(profilePath))).toBe(false)
  })

  it('refuses (never throws) when the allowed directory does not exist — e.g. a round-1 dispatch whose worktree is not created yet', () => {
    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: '/usr/bin/env',
        args: [],
        allowedDir: join(tmpdir(), `vinaya-wb-does-not-exist-${Math.random().toString(36).slice(2)}`),
        extraWritableDirs: []
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(false)
  })
})

describe('resolveWorkerBoundaryLaunch — bootstrapWritableSubpaths (round 2 review, CRITICAL: repo root must not be writable)', () => {
  it('with bootstrapWritableSubpaths given, allowedDir itself is read-only — never in a file-write* allow rule', () => {
    const allowedDir = tempDir('vinaya-wb-repo-root-')
    mkdirSync(join(allowedDir, '.git'))
    mkdirSync(join(allowedDir, '.worktrees'))
    writeFileSync(join(allowedDir, 'vinaya.config.json'), '{}')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')],
        bootstrapWritableSubpaths: ['.git', '.worktrees']
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      // allowedDir must appear ONLY in a read-only allow rule, never in the
      // `file-read* file-write*` (both) allow rule — the CRITICAL finding's
      // own repro shape (a confined round-1 Developer rewriting
      // vinaya.config.json) requires allowedDir to carry write access; this
      // asserts it structurally cannot.
      const rwRuleIdx = profile.indexOf('(allow file-read* file-write*')
      const rwRuleEnd = profile.indexOf('))', rwRuleIdx) + 2
      const rwRuleBody = profile.slice(rwRuleIdx, rwRuleEnd)
      // The EXACT quoted literal, not a bare substring match — allowedDir is
      // itself a string prefix of `<allowedDir>/.git`, which legitimately
      // does appear here (the next test), so a naive `.not.toContain(allowedDir)`
      // would false-fail on that real, correct subpath.
      expect(rwRuleBody).not.toContain(`"${allowedDir}"`)
      // But it IS still readable — a bare `(allow file-read* ...)` rule
      // names it, so the Developer can still read doctrine/code pre-worktree.
      expect(profile).toContain(`(allow file-read*\n    (subpath "${allowedDir}")`)
    } finally {
      result.launch.cleanup()
    }
  })

  it('the named bootstrap subpaths (.git, .worktrees) DO get read+write', () => {
    const allowedDir = tempDir('vinaya-wb-repo-root-')
    mkdirSync(join(allowedDir, '.git'))
    mkdirSync(join(allowedDir, '.worktrees'))
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')],
        bootstrapWritableSubpaths: ['.git', '.worktrees']
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      const rwRuleIdx = profile.indexOf('(allow file-read* file-write*')
      const rwRuleEnd = profile.indexOf('))', rwRuleIdx) + 2
      const rwRuleBody = profile.slice(rwRuleIdx, rwRuleEnd)
      expect(rwRuleBody).toContain(join(allowedDir, '.git'))
      expect(rwRuleBody).toContain(join(allowedDir, '.worktrees'))
    } finally {
      result.launch.cleanup()
    }
  })

  it('a bootstrap subpath that does not exist yet (a fresh clone with no .worktrees dir) is still named, not silently dropped', () => {
    const allowedDir = tempDir('vinaya-wb-repo-root-')
    mkdirSync(join(allowedDir, '.git'))
    // .worktrees deliberately not created — first task ever dispatched here.
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')],
        bootstrapWritableSubpaths: ['.git', '.worktrees']
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      expect(profile).toContain(join(allowedDir, '.worktrees'))
    } finally {
      result.launch.cleanup()
    }
  })

  it('an empty bootstrapWritableSubpaths array still makes allowedDir read-only (a Reviewer falling back to the repo root never gets any repo write access)', () => {
    const allowedDir = tempDir('vinaya-wb-repo-root-')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')],
        bootstrapWritableSubpaths: []
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      const rwRuleIdx = profile.indexOf('(allow file-read* file-write*')
      const rwRuleEnd = profile.indexOf('))', rwRuleIdx) + 2
      expect(profile.slice(rwRuleIdx, rwRuleEnd)).not.toContain(allowedDir)
    } finally {
      result.launch.cleanup()
    }
  })
})

describe('resolveWorkerBoundaryLaunch — GLOBAL_VINAYA_HOME narrowed (round 2 review, MAJOR; round 4 review, HIGH)', () => {
  it("an unnamed parent directory is NOT exposed at all — a confined Worker cannot read or rewrite ~/.vinaya's own config.json", () => {
    const allowedDir = tempDir('vinaya-wb-allowed-')
    const homeDir = tempDir('vinaya-wb-home-')
    writeFileSync(join(homeDir, 'config.json'), '{}')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')]
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      const rwRuleIdx = profile.indexOf('(allow file-read* file-write*')
      const rwRuleEnd = profile.indexOf('))', rwRuleIdx) + 2
      // The EXACT quoted literal — homeDir is a string prefix of its own
      // `outbox`/`dispatch-resume` subpaths, which legitimately DO appear
      // here (the next test); a bare substring check would false-fail.
      expect(profile.slice(rwRuleIdx, rwRuleEnd)).not.toContain(`"${homeDir}"`)
      // Round 4 review, HIGH fix: homeDir never appears as its own
      // standalone `(subpath ...)` rule anywhere in the profile any more —
      // previously it sat directly in `readOnlyDirs`, producing exactly
      // this literal. Only its scoped `outbox`/`dispatch-resume` writable
      // subpaths (longer strings, asserted by the next test) are exposed.
      expect(profile).not.toContain(`(subpath "${homeDir}")`)
    } finally {
      result.launch.cleanup()
    }
  })

  it("only the caller's own named directories get read+write, even when they do not exist yet", () => {
    const allowedDir = tempDir('vinaya-wb-allowed-')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox'), join(homeDir, 'dispatch-resume')]
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      const rwRuleIdx = profile.indexOf('(allow file-read* file-write*')
      const rwRuleEnd = profile.indexOf('))', rwRuleIdx) + 2
      const rwRuleBody = profile.slice(rwRuleIdx, rwRuleEnd)
      expect(rwRuleBody).toContain(join(homeDir, 'outbox'))
      expect(rwRuleBody).toContain(join(homeDir, 'dispatch-resume'))
    } finally {
      result.launch.cleanup()
    }
  })
})

describe('buildWorkerSandboxProfile — read-only vs read-write directories', () => {
  it('a readOnlyDirs entry is read-allowed but excluded from the file-write* allow rule', () => {
    const profile = buildWorkerSandboxProfile({
      realHome: '/Users/marker',
      readOnlyDirs: ['/tmp/readonly-repo-root'],
      readWriteDirs: ['/tmp/writable-worktree'],
      execAllowDirs: ['/usr/bin'],
      runtimeDir: '/usr/bin',
      sshSockCanon: '/nonexistent',
      credentialHelperDenyLiterals: []
    })
    expect(profile).toContain('(allow file-read*\n    (subpath "/tmp/readonly-repo-root")')
    const rwRuleIdx = profile.indexOf('(allow file-read* file-write*')
    const rwRuleEnd = profile.indexOf('))', rwRuleIdx) + 2
    expect(profile.slice(rwRuleIdx, rwRuleEnd)).not.toContain('/tmp/readonly-repo-root')
    expect(profile.slice(rwRuleIdx, rwRuleEnd)).toContain('/tmp/writable-worktree')
  })

  it('the write-deny-elsewhere rule still applies to a readOnlyDirs entry — it is not exempted from the blanket write deny', () => {
    const profile = buildWorkerSandboxProfile({
      realHome: '/Users/marker',
      readOnlyDirs: ['/tmp/readonly-repo-root'],
      readWriteDirs: ['/tmp/writable-worktree'],
      execAllowDirs: ['/usr/bin'],
      runtimeDir: '/usr/bin',
      sshSockCanon: '/nonexistent',
      credentialHelperDenyLiterals: []
    })
    const denyElsewhereIdx = profile.indexOf('(deny file-write*\n  (require-all')
    const denyElsewhereEnd = profile.indexOf('))', denyElsewhereIdx) + 2
    const denyElsewhereBody = profile.slice(denyElsewhereIdx, denyElsewhereEnd)
    // Only readWriteDirs are named as exceptions (require-not) — a readOnlyDirs
    // entry is absent from the exception list, so the blanket deny reaches it.
    expect(denyElsewhereBody).toContain('/tmp/writable-worktree')
    expect(denyElsewhereBody).not.toContain('/tmp/readonly-repo-root')
  })
})

describe('buildWorkerSandboxProfile — DNS resolution (round 4 review, BLOCKER)', () => {
  it('grants the mDNSResponder unix-socket route and its three mach-lookup names, distinct from the tcp port allows', () => {
    const profile = buildWorkerSandboxProfile({
      realHome: '/Users/marker',
      readOnlyDirs: [],
      readWriteDirs: ['/tmp/writable-worktree'],
      execAllowDirs: ['/usr/bin'],
      runtimeDir: '/usr/bin',
      sshSockCanon: '/nonexistent',
      credentialHelperDenyLiterals: []
    })
    expect(profile).toContain(
      '(allow network-outbound\n  (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'
    )
    const machLookupIdx = profile.indexOf('(allow mach-lookup\n  (global-name "com.apple.dnssd")')
    expect(machLookupIdx).toBeGreaterThan(-1)
    const machLookupEnd = profile.indexOf('))', machLookupIdx) + 2
    const machLookupBody = profile.slice(machLookupIdx, machLookupEnd)
    expect(machLookupBody).toContain('com.apple.dnssd')
    expect(machLookupBody).toContain('com.apple.mDNSResponder')
    expect(machLookupBody).toContain('com.apple.mDNSResponderUnix')
    // The DNS route is additive to, never a substitute for, the tcp 80/443
    // allows a round-3 fix already put in place — both must survive together.
    expect(profile).toContain('(allow network-outbound (remote tcp "*:443"))')
    expect(profile).toContain('(allow network-outbound (remote tcp "*:80"))')
  })
})

describe('resolveWorkerBoundaryLaunch — extraReadOnlyDirs (round 4 review, BLOCKER: --settings file readable)', () => {
  it('a readOnlySubdir is read-allowed but excluded from the read-write rule, distinct from a writable subdir', () => {
    const allowedDir = tempDir('vinaya-wb-ro-allowed-')
    const homeDir = tempDir('vinaya-wb-ro-home-')
    const binDir = tempDir('vinaya-wb-ro-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: [join(homeDir, 'outbox')],
        extraReadOnlyDirs: [join(homeDir, 'dispatch-settings')]
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profilePath = result.launch.args[1] as string
      const profile = readFileSync(profilePath, 'utf8')
      const rwRuleIdx = profile.indexOf('(allow file-read* file-write*')
      const rwRuleEnd = profile.indexOf('))', rwRuleIdx) + 2
      const rwRuleBody = profile.slice(rwRuleIdx, rwRuleEnd)
      // The HOME-confinement carve-out is the read-only rule immediately
      // preceding the read-write one — the same `sbSubpathAllows` call site
      // `readOnlyDirs` tests above assert against, distinct from the
      // process-exec/runtime `file-read*`-only allow much earlier in the
      // profile (which never names an unrequested directory).
      const readOnlyIdx = profile.lastIndexOf('(allow file-read*\n    (subpath', rwRuleIdx)
      const readOnlyEnd = profile.indexOf('))', readOnlyIdx) + 2
      expect(profile.slice(readOnlyIdx, readOnlyEnd)).toContain(join(homeDir, 'dispatch-settings'))
      expect(rwRuleBody).not.toContain(join(homeDir, 'dispatch-settings'))
      expect(rwRuleBody).toContain(join(homeDir, 'outbox'))
    } finally {
      result.launch.cleanup()
    }
  })

  it('an absent extraReadOnlyDirs (undefined) behaves exactly like an empty array — no crash, nothing extra granted', () => {
    const allowedDir = tempDir('vinaya-wb-ro-absent-allowed-')
    const binDir = tempDir('vinaya-wb-ro-absent-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        extraWritableDirs: []
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    result.launch.cleanup()
  })

  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a real confined child can READ a file under a readOnlySubdir but cannot write into it',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-ro-allowed-')
      const homeDir = tempDir('vinaya-wb-live-ro-home-')
      mkdirSync(join(homeDir, 'dispatch-settings'), { recursive: true })
      const settingsFile = join(homeDir, 'dispatch-settings', 'settings.json')
      writeFileSync(settingsFile, '{"hooks":{}}')

      const probeScript = join(allowedDir, 'ro-subdir-probe.js')
      writeFileSync(
        probeScript,
        [
          "const fs = require('node:fs')",
          'const [settingsPath] = process.argv.slice(2)',
          'let readOk = true',
          'try { fs.readFileSync(settingsPath, "utf8") } catch { readOk = false }',
          'let writeBlocked = true',
          'try { fs.appendFileSync(settingsPath, "x"); writeBlocked = false } catch { writeBlocked = true }',
          'process.stdout.write(JSON.stringify({ readOk, writeBlocked }))'
        ].join('\n')
      )

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: process.execPath,
          args: [probeScript, settingsFile],
          allowedDir,
          extraWritableDirs: [],
          extraReadOnlyDirs: [join(homeDir, 'dispatch-settings')]
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8'
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const parsed = JSON.parse(spawnResult.stdout) as { readOk: boolean; writeBlocked: boolean }
        expect(parsed.readOk, 'reading the settings file the dispatch was handed should succeed').toBe(true)
        expect(parsed.writeBlocked, 'writing into the read-only settings directory should be blocked').toBe(true)
      } finally {
        result.launch.cleanup()
      }
    }
  )

  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'round 6 review, security CRITICAL: a confined child can append to its own named file inside an otherwise read-only extraReadOnlyDirs directory, but still cannot write a sibling file there',
    () => {
      // Reproduces `documentationLogHookScript`'s own shape live: the
      // `PostToolUse` WebFetch hook appends to `documentation-log-<runId>
      // .jsonl` inside `dispatch-settings`, a directory otherwise granted
      // read-only (`extraReadOnlyDirs`, above) because nothing else
      // in it is ever rewritten by the confined child — `settings.json`
      // itself, and every hook script, are written once by the trusted
      // controller and must stay unwritable from inside the sandbox.
      const allowedDir = tempDir('vinaya-wb-live-ro-file-allowed-')
      const homeDir = tempDir('vinaya-wb-live-ro-file-home-')
      mkdirSync(join(homeDir, 'dispatch-settings'), { recursive: true })
      const settingsFile = join(homeDir, 'dispatch-settings', 'settings.json')
      writeFileSync(settingsFile, '{"hooks":{}}')
      const logFile = join(homeDir, 'dispatch-settings', 'documentation-log-run1.jsonl')

      const probeScript = join(allowedDir, 'ro-dir-writable-file-probe.js')
      writeFileSync(
        probeScript,
        [
          "const fs = require('node:fs')",
          'const [settingsPath, logPath] = process.argv.slice(2)',
          'let logWriteOk = true',
          'try { fs.appendFileSync(logPath, "{\\"url\\":\\"https://example.com\\"}\\n") } catch { logWriteOk = false }',
          'let settingsWriteBlocked = true',
          'try { fs.appendFileSync(settingsPath, "x"); settingsWriteBlocked = false } catch { settingsWriteBlocked = true }',
          'process.stdout.write(JSON.stringify({ logWriteOk, settingsWriteBlocked }))'
        ].join('\n')
      )

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: process.execPath,
          args: [probeScript, settingsFile, logFile],
          allowedDir,
          extraWritableDirs: [],
          extraReadOnlyDirs: [join(homeDir, 'dispatch-settings')],
          extraWritableFiles: [join(homeDir, 'dispatch-settings', 'documentation-log-run1.jsonl')]
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8'
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const parsed = JSON.parse(spawnResult.stdout) as { logWriteOk: boolean; settingsWriteBlocked: boolean }
        expect(parsed.logWriteOk, 'appending to the named documentation-log file should succeed').toBe(true)
        expect(
          parsed.settingsWriteBlocked,
          'writing into a SIBLING file in the same read-only directory should still be blocked'
        ).toBe(true)
      } finally {
        result.launch.cleanup()
      }
    }
  )

  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a confined child can reach the mDNSResponder unix socket — Seatbelt does not report EPERM/EACCES',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-dns-allowed-')

      const probeScript = join(allowedDir, 'dns-route-probe.js')
      writeFileSync(
        probeScript,
        [
          "const net = require('node:net')",
          'const socket = net.createConnection({ path: "/private/var/run/mDNSResponder" })',
          'const finish = (code) => { try { socket.destroy() } catch {}; process.stdout.write(JSON.stringify({ code })) }',
          "socket.on('connect', () => finish(null))",
          "socket.on('error', (err) => finish(err.code ?? String(err)))",
          'setTimeout(() => finish("TIMEOUT"), 2000).unref()'
        ].join('\n')
      )

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: process.execPath,
          args: [probeScript],
          allowedDir,
          extraWritableDirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8',
          timeout: 5000
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const parsed = JSON.parse(spawnResult.stdout) as { code: string | null }
        // A protocol mismatch (mDNSResponder is a datagram-style endpoint) or
        // even a clean connect are both fine — the property under test is
        // that Seatbelt itself never refuses the attempt, which is what
        // EPERM/EACCES on the connect() syscall would mean. Before this
        // task's fix, no rule named this socket at all and `(deny default)`
        // applied, which surfaces this same way.
        expect(['EPERM', 'EACCES']).not.toContain(parsed.code)
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('buildWorkerSandboxProfile — Seatbelt string-literal escaping', () => {
  it('escapes a backslash or double quote so it cannot break out of the profile string literal', () => {
    const hostile = '/tmp/evil"))(allow default)(deny file-read* (subpath "'
    const profile = buildWorkerSandboxProfile({
      realHome: '/Users/marker',
      readOnlyDirs: [],
      readWriteDirs: [hostile],
      execAllowDirs: ['/usr/bin'],
      runtimeDir: '/usr/bin',
      sshSockCanon: '/nonexistent',
      credentialHelperDenyLiterals: []
    })
    expect(profile).toContain('\\"')
    expect(profile).not.toContain(`"${hostile}"`)
  })

  it('names every credential-helper literal as its own deny rule, layered after the process-exec allow', () => {
    const profile = buildWorkerSandboxProfile({
      realHome: '/Users/marker',
      readOnlyDirs: [],
      readWriteDirs: ['/tmp/allowed'],
      execAllowDirs: ['/usr/bin'],
      runtimeDir: '/usr/bin',
      sshSockCanon: '/nonexistent',
      credentialHelperDenyLiterals: ['/usr/libexec/git-core/git-credential-osxkeychain']
    })
    const execAllowIdx = profile.indexOf('(allow process-exec')
    const denyHelperIdx = profile.indexOf('git-credential-osxkeychain')
    expect(execAllowIdx).toBeGreaterThan(-1)
    expect(denyHelperIdx).toBeGreaterThan(execAllowIdx)
  })
})

/**
 * Round 3 review, MAJOR (F1): every assertion above this point checks the
 * generated Seatbelt profile as TEXT (injected `detectHost`, no real
 * `sandbox-exec` invocation) — a syntax/ordering mistake that compiles but
 * does not enforce as intended would pass all of them. These tests close
 * that gap the same way `isolation-probe.test.ts` already does for task 1's
 * narrower probe profile (`test.skipIf(!isSandboxSupported())`): they build
 * a REAL profile with `buildWorkerSandboxProfile`/`resolveWorkerBoundaryLaunch`
 * and run it through the REAL `/usr/bin/sandbox-exec`, on the one host
 * `isolation.md` §3 actually names as supported — skipped elsewhere as
 * documented scope, not a gap this suite papers over.
 */
// A plain `bash` script, never a node/bun one: the interpreter a shebang
// names must itself be inside the profile's own `execAllowDirs` for the OS
// to exec it at all, and `/bin` (bash's real home) is always a member of
// `CANDIDATE_SYSTEM_BIN_DIRS` — a `#!/usr/bin/env node`/`bun` script would
// need ITS OWN interpreter's real install directory named too, which this
// probe has no reason to depend on. Uses bash's own `/dev/tcp` pseudo-device
// for the network checks so no separate network client binary is needed
// either — one process-exec allow (`/bin`) is enough for every check here.
const CONFINEMENT_PROBE_SCRIPT = `#!/bin/bash
set -u
inside_path="$1"; outside_path="$2"; denied_home_dir="$3"; allowed_port="$4"; denied_port="$5"

inside_write_ok=false
echo probe > "$inside_path" 2>/dev/null && inside_write_ok=true

outside_write_blocked=true
echo probe > "$outside_path" 2>/dev/null && outside_write_blocked=false

home_read_blocked=true
ls "$denied_home_dir" >/dev/null 2>&1 && home_read_blocked=false

allowed_port_reachable=false
(exec 3<>"/dev/tcp/127.0.0.1/$allowed_port") 2>/dev/null && allowed_port_reachable=true

denied_port_blocked=true
(exec 4<>"/dev/tcp/127.0.0.1/$denied_port") 2>/dev/null && denied_port_blocked=false

printf '{"insideWriteOk":%s,"outsideWriteBlocked":%s,"homeReadBlocked":%s,"allowedPortReachable":%s,"deniedPortBlocked":%s}\\n' \\
  "$inside_write_ok" "$outside_write_blocked" "$home_read_blocked" "$allowed_port_reachable" "$denied_port_blocked"
`

describe('resolveWorkerBoundaryLaunch — live sandbox-exec enforcement (round 3 review, MAJOR)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a real confined child can write only inside its allowed dir, cannot read the real HOME, and can reach only the allowed port',
    async () => {
      const allowedDir = tempDir('vinaya-wb-live-allowed-')
      const binDir = tempDir('vinaya-wb-live-bin-')
      const probeBinary = join(binDir, 'probe.sh')
      writeFileSync(probeBinary, CONFINEMENT_PROBE_SCRIPT)
      chmodSync(probeBinary, 0o755)
      const insidePath = join(allowedDir, 'inside.txt')
      const outsidePath = join(tmpdir(), `vinaya-wb-live-outside-${process.pid}-${Date.now()}`)
      // The REAL account home (`os.homedir()`, never this test's own scratch
      // `homeDir` — an unrelated fixture directory) is
      // what `resolveWorkerBoundaryLaunch` denies internally as `realHome`.
      // Listing it (never writing into it) proves the profile's HOME-wide
      // deny reaches a confined role, independent of Keychain's own
      // dedicated rule — mirrors the Keychain test below, which lists
      // rather than reads/writes a specific file for the same reason.
      const deniedHomeDir = homedir()

      const allowedServer = createServer((socket) => socket.end())
      const deniedServer = createServer((socket) => socket.end())
      const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
        new Promise((resolve) => {
          server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            resolve(typeof address === 'object' && address !== null ? address.port : 0)
          })
        })
      const allowedPort = await listen(allowedServer)
      const deniedPort = await listen(deniedServer)

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: probeBinary,
          args: [insidePath, outsidePath, deniedHomeDir, String(allowedPort), String(deniedPort)],
          allowedDir,
          extraWritableDirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const profilePath = result.launch.args[1] as string
      // The real launch's own profile only opens 80/443 — this probe's own
      // "allowed port" server stands in for one of those (binding 80/443
      // itself needs root, unavailable in CI); patching just the port
      // number in an otherwise-untouched, REAL, live-compiled profile keeps
      // every other rule (HOME/Keychain/exec/write) exactly as shipped.
      const liveProfile = readFileSync(profilePath, 'utf8').replace(
        '(allow network-outbound (remote tcp "*:443"))',
        `(allow network-outbound (remote tcp "*:443"))\n(allow network-outbound (remote tcp "*:${allowedPort}"))`
      )
      writeFileSync(profilePath, liveProfile)
      try {
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8'
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const parsed = JSON.parse(spawnResult.stdout) as {
          insideWriteOk: boolean
          outsideWriteBlocked: boolean
          homeReadBlocked: boolean
          allowedPortReachable: boolean
          deniedPortBlocked: boolean
        }
        expect(parsed.insideWriteOk, 'writing inside allowedDir should succeed while confined').toBe(true)
        expect(parsed.outsideWriteBlocked, 'writing outside allowedDir should be blocked while confined').toBe(true)
        expect(parsed.homeReadBlocked, 'reading the real HOME should be blocked while confined').toBe(true)
        expect(parsed.allowedPortReachable, 'the profile-allowed port should be reachable while confined').toBe(true)
        expect(parsed.deniedPortBlocked, 'a port outside 80/443 should be blocked while confined').toBe(true)
      } finally {
        result.launch.cleanup()
        allowedServer.close()
        deniedServer.close()
        rmSync(outsidePath, { force: true })
      }
    }
  )

  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    // Round 2 security review, HIGH: proves both halves live — the bug
    // (parent TMPDIR passed through unmodified is NOT writable inside the
    // confinement) and the fix (`launch.tmpDir`, overridden into the
    // spawned env's `TMPDIR`/`TMP`/`TEMP`, IS writable). A single-level
    // `mkdir "$TMPDIR/x"` — the shape `fs.mkdtempSync(os.tmpdir())` and most
    // Node/bun toolchain temp-dir creation actually issues (one syscall
    // against an already-existing parent) — not `mkdir -p`: live-verified
    // separately that BSD `mkdir -p` walks and `mkdir()`s every ancestor
    // component from `/private` down regardless of whether it already
    // exists, so it hits `EPERM` on an ancestor outside the granted subpath
    // (e.g. `/private`) even once `TMPDIR` itself is correctly overridden —
    // a real, disclosed limitation of `-p` specifically under this profile,
    // not evidence the override in this fix does not work, and not the
    // pattern real toolchain temp-dir creation uses.
    'a real confined child can only use $TMPDIR for scratch writes once TMPDIR is overridden to launch.tmpDir',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-tmpdir-allowed-')
      const binDir = tempDir('vinaya-wb-live-tmpdir-bin-')
      const probeBinary = join(binDir, 'tmpdir-probe.sh')
      writeFileSync(probeBinary, '#!/bin/bash\nmkdir "$TMPDIR/child-test-dir" 2>/dev/null && echo ok || echo blocked\n')
      chmodSync(probeBinary, 0o755)

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: probeBinary,
          args: [],
          allowedDir,
          extraWritableDirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        expect(result.launch.tmpDir, 'tmpDir must not be the same path as allowedDir').not.toBe(allowedDir)

        const overriddenEnv = buildWorkerEnv(process.env, {
          TMPDIR: result.launch.tmpDir,
          TMP: result.launch.tmpDir,
          TEMP: result.launch.tmpDir
        })
        const withOverride = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          env: overriddenEnv,
          encoding: 'utf8'
        })
        expect(withOverride.stdout.trim(), `stderr: ${withOverride.stderr}`).toBe('ok')

        // Regression guard: the parent's own real TMPDIR, unmodified — the
        // pre-fix shape `buildWorkerEnv`'s allowlist alone produced — must
        // still be denied, proving this is the profile actually enforcing
        // the boundary and not merely `launch.tmpDir` happening to be
        // writable for an unrelated reason.
        const unoverriddenEnv = buildWorkerEnv(process.env, {})
        const withoutOverride = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          env: unoverriddenEnv,
          encoding: 'utf8'
        })
        expect(withoutOverride.stdout.trim()).toBe('blocked')
      } finally {
        result.launch.cleanup()
      }
    }
  )

  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a real confined child cannot read the real Keychain directory',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-keychain-')
      const binDir = tempDir('vinaya-wb-live-keychain-bin-')
      const fakeBinary = fakeBinaryIn(binDir)

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: fakeBinary,
          args: [],
          allowedDir,
          extraWritableDirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        // The REAL home's own Keychain directory always exists on a real
        // macOS user account — list it (never write/read a specific
        // keychain file, which this account may not have) to prove the
        // profile's dedicated Keychain deny rule actually reaches it.
        // `/bin/ls`, not a `bun -e` expression (round 5 review, BLOCKER
        // fix, adjacent): once bun's own install dir is a granted
        // exec/read path (see `resolveBunExecDir` in `worker-boundary.ts`),
        // this repo's own bun's `-e` mode was found live to exit `0` on an
        // uncaught synchronous exception when confined — a bun/Seatbelt
        // interaction, not a signal the underlying deny rule failed (a
        // caught `readdirSync` under the same profile, verified separately,
        // still throws EPERM). `/bin/ls` is a plain binary with no such
        // exception-reporting layer and reliably reflects its own exit code.
        const spawnResult = spawnConfinedSync(
          '/usr/bin/sandbox-exec',
          ['-f', result.launch.args[1] as string, '/bin/ls', join(homedir(), 'Library', 'Keychains')],
          {
            cwd: allowedDir,
            encoding: 'utf8'
          }
        )
        expect(spawnResult.status).not.toBe(0)
        expect(spawnResult.stderr).toMatch(/EPERM|EACCES|operation not permitted|permission denied/i)
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('resolveWorkerBoundaryLaunch — OAuth credential staging, live sandbox-exec (O1/O3, Issue #640)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'an OAuth-only host resolves a working staged credential path into the confined session; the real credentials file and Keychain remain denied',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-oauth-allowed-')
      const fixtureContents = JSON.stringify({ accessToken: 'fixture-not-a-real-oauth-token' })
      const realCredentialPath = join(homedir(), '.claude', '.credentials.json')

      // A bash probe, not a bun/node one, deliberately (round 5's own
      // `/bin/ls`-over-`bun -e` precedent, this Keychain describe block's
      // sibling test, above): found LIVE, in authoring this task, that a
      // confined bun process's own `process.env` reads back EMPTY under
      // this profile — the kernel-level `execve` environment (confirmed via
      // a confined `/usr/bin/env`, which prints it correctly) is intact, so
      // this is a bun-runtime-under-Seatbelt quirk, not evidence the env
      // override failed — a plain shell reads `$CLAUDE_CONFIG_DIR` reliably
      // instead, the same posture the pre-existing `$TMPDIR` override test
      // above already takes for exactly this reason.
      const probeScript = join(allowedDir, 'oauth-probe.sh')
      writeFileSync(
        probeScript,
        [
          '#!/bin/bash',
          'printf \'STAGED:%s\\n\' "$(cat "$CLAUDE_CONFIG_DIR/.credentials.json" 2>/dev/null)"',
          `if cat ${JSON.stringify(realCredentialPath)} >/dev/null 2>&1; then echo 'REAL:READABLE'; else echo 'REAL:BLOCKED'; fi`,
          `if ls ${JSON.stringify(join(homedir(), 'Library', 'Keychains'))} >/dev/null 2>&1; then echo 'KEYCHAIN:READABLE'; else echo 'KEYCHAIN:BLOCKED'; fi`
        ].join('\n')
      )
      chmodSync(probeScript, 0o755)

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: probeScript,
          args: [],
          allowedDir,
          extraWritableDirs: [],
          stageOAuthCredential: true
        },
        { ...REAL_WORKER_BOUNDARY_DEPS, readOAuthCredentialFile: () => fixtureContents }
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.launch.oauthConfigDir).not.toBeNull()
      try {
        const env = buildWorkerEnv(process.env, { CLAUDE_CONFIG_DIR: result.launch.oauthConfigDir as string })
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8',
          env
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const lines = spawnResult.stdout.trim().split('\n')
        expect(lines[0], 'the confined child reads the staged COPY via CLAUDE_CONFIG_DIR').toBe(
          `STAGED:${fixtureContents}`
        )
        expect(
          lines[1],
          "the real ~/.claude/.credentials.json stays denied — it is a subpath of the boundary's own HOME deny rule, never widened by staging"
        ).toBe('REAL:BLOCKED')
        expect(lines[2], 'the Keychain deny rule is unaffected by OAuth staging').toBe('KEYCHAIN:BLOCKED')
      } finally {
        result.launch.cleanup()
      }
    }
  )

  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'O3: the real credentials file and Keychain stay denied on the ANTHROPIC_API_KEY credential path too, not only the staged-OAuth path proven above',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-oauth-o3-allowed-')
      const realCredentialPath = join(homedir(), '.claude', '.credentials.json')

      const probeScript = join(allowedDir, 'o3-probe.sh')
      writeFileSync(
        probeScript,
        [
          '#!/bin/bash',
          `if cat ${JSON.stringify(realCredentialPath)} >/dev/null 2>&1; then echo 'REAL:READABLE'; else echo 'REAL:BLOCKED'; fi`,
          `if ls ${JSON.stringify(join(homedir(), 'Library', 'Keychains'))} >/dev/null 2>&1; then echo 'KEYCHAIN:READABLE'; else echo 'KEYCHAIN:BLOCKED'; fi`
        ].join('\n')
      )
      chmodSync(probeScript, 0o755)

      // `stageOAuthCredential` omitted entirely — `dispatch.ts` only ever
      // sets it `true` for `agent === 'claude'` regardless of whether an
      // `ANTHROPIC_API_KEY` is also present, so this launch resolves
      // exactly as an API-key-authenticated dispatch's boundary does.
      const result = resolveWorkerBoundaryLaunch(
        { binaryPath: probeScript, args: [], allowedDir, extraWritableDirs: [] },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.launch.oauthConfigDir, 'no staging was requested on this path').toBeNull()
      try {
        const env = buildWorkerEnv(process.env, {}, RUNTIME_CREDENTIAL_ENV_KEYS.claude)
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8',
          env
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const lines = spawnResult.stdout.trim().split('\n')
        expect(lines[0], 'the real credentials file stays denied regardless of credential path').toBe('REAL:BLOCKED')
        expect(lines[1], 'the Keychain deny rule stays in force regardless of credential path').toBe('KEYCHAIN:BLOCKED')
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('resolveWorkerBoundaryLaunch — bun toolchain reachable (round 5 review, BLOCKER)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a confined child can still exec bun for its own build/test subprocesses when binaryPath is a non-bun vendor binary (the real production shape)',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-bun-')
      const binDir = tempDir('vinaya-wb-live-bun-bin-')
      // The real production shape the round 5 finding named: the vendor
      // binary (`binaryPath`) lives OUTSIDE `~/.bun/bin` — every prior live
      // test here instead passed `binaryPath: process.execPath` (this test
      // runner's own bun binary), which incidentally granted bun's own
      // directory as `runtimeDir` and so never exercised this gap.
      const fakeVendorBinary = fakeBinaryIn(binDir)

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: fakeVendorBinary,
          args: [],
          allowedDir,
          extraWritableDirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnConfinedSync(
          '/usr/bin/sandbox-exec',
          ['-f', result.launch.args[1] as string, 'bun', '--version'],
          {
            cwd: allowedDir,
            encoding: 'utf8',
            env: { PATH: process.env.PATH ?? '' }
          }
        )
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        expect(spawnResult.stdout.trim().length).toBeGreaterThan(0)
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('resolveWorkerBoundaryLaunch — repo-segment scoping (round 4 review, BLOCKER)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a confined Worker scoped to its own repo-segment can write there but not into a SIBLING repo-segment under the same GLOBAL_VINAYA_HOME subdir',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-scope-allowed-')
      const homeDir = tempDir('vinaya-wb-live-scope-home-')

      // `outbox`/`dispatch-resume` already exist as long-lived top-level
      // directories on any host that has dispatched before (this task's own
      // authoring host included) — pre-created here, unsandboxed, to match
      // that real precondition rather than testing a from-scratch machine
      // that never existed in production.
      mkdirSync(join(homeDir, 'outbox'), { recursive: true })
      mkdirSync(join(homeDir, 'dispatch-resume'), { recursive: true })

      const ownRepoFile = join(homeDir, 'outbox', 'owner-repoA', '1.ndjson')
      const siblingRepoFile = join(homeDir, 'outbox', 'owner-repoB', '2.ndjson')

      // The probe runs `fs.mkdirSync(dirname, { recursive: true })` —
      // literally the SAME primitive `dispatch.ts`'s own `writeLaunchRecord`
      // calls in production — not a shell `mkdir -p`, whose own step-by-step
      // per-ancestor algorithm behaves differently under Seatbelt and would
      // misrepresent what the real code path actually does. Lives inside
      // `allowedDir` (full read+write already) so the runtime can read it;
      // `binaryPath` is this same test runner's own interpreter, so its
      // install dir is automatically exec/read-allowed as `runtimeDir`.
      const probeScript = join(allowedDir, 'repo-scope-probe.js')
      writeFileSync(
        probeScript,
        [
          "const fs = require('node:fs')",
          "const path = require('node:path')",
          'const [ownPath, siblingPath] = process.argv.slice(2)',
          'let ownWriteOk = true',
          'try {',
          '  fs.mkdirSync(path.dirname(ownPath), { recursive: true })',
          "  fs.writeFileSync(ownPath, 'own')",
          '} catch { ownWriteOk = false }',
          'let siblingWriteBlocked = true',
          'try {',
          '  fs.mkdirSync(path.dirname(siblingPath), { recursive: true })',
          "  fs.writeFileSync(siblingPath, 'sibling')",
          '  siblingWriteBlocked = false',
          '} catch { siblingWriteBlocked = true }',
          'process.stdout.write(JSON.stringify({ ownWriteOk, siblingWriteBlocked }))'
        ].join('\n')
      )

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: process.execPath,
          args: [probeScript, ownRepoFile, siblingRepoFile],
          allowedDir,

          // Exactly what `dispatch.ts` now computes: `dirname(outboxPath)`
          // and `dirname(resumeRecordPathFor(...))`, scoped to ONE repo.
          extraWritableDirs: [join(homeDir, 'outbox', 'owner-repoA'), join(homeDir, 'dispatch-resume', 'owner-repoA')]
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8'
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const parsed = JSON.parse(spawnResult.stdout) as { ownWriteOk: boolean; siblingWriteBlocked: boolean }
        expect(parsed.ownWriteOk, "writing inside this dispatch's own repo-segment should succeed").toBe(true)
        expect(
          parsed.siblingWriteBlocked,
          'writing into a SIBLING repo-segment under the same subdir should be blocked'
        ).toBe(true)
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('resolveWorkerBoundaryLaunch — cross-task/role scoping (round 5 review, CRITICAL)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a confined dispatch granted extraWritableFiles can write its OWN outbox/resume file but not a SIBLING task/role file in the SAME repo-segment directory',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-file-scope-allowed-')
      const homeDir = tempDir('vinaya-wb-live-file-scope-home-')

      // Same repo-segment DIRECTORY (`outbox/owner-repo`) two DIFFERENT
      // tasks' own outbox lines share by `outboxPathFor`'s own naming
      // convention — the exact shape the round 5 CRITICAL finding named:
      // one confined dispatch (task 560) must never reach a sibling task's
      // (561) own file in that same shared directory, even though both
      // sit one literal path apart.
      const repoSegDir = join(homeDir, 'outbox', 'owner-repo')
      mkdirSync(repoSegDir, { recursive: true })
      const ownFile = join(repoSegDir, '560.ndjson')
      const siblingFile = join(repoSegDir, '561.ndjson')
      writeFileSync(siblingFile, 'sibling task already wrote this')

      const probeScript = join(allowedDir, 'file-scope-probe.js')
      writeFileSync(
        probeScript,
        [
          "const fs = require('node:fs')",
          'const [ownPath, siblingPath] = process.argv.slice(2)',
          'let ownWriteOk = true',
          'try {',
          "  fs.writeFileSync(ownPath, 'own')",
          '} catch { ownWriteOk = false }',
          'let siblingWriteBlocked = true',
          'try {',
          "  fs.writeFileSync(siblingPath, 'stolen')",
          '  siblingWriteBlocked = false',
          '} catch { siblingWriteBlocked = true }',
          'let siblingReadBlocked = true',
          'try {',
          '  fs.readFileSync(siblingPath, "utf8")',
          '  siblingReadBlocked = false',
          '} catch { siblingReadBlocked = true }',
          'process.stdout.write(JSON.stringify({ ownWriteOk, siblingWriteBlocked, siblingReadBlocked }))'
        ].join('\n')
      )

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: process.execPath,
          args: [probeScript, ownFile, siblingFile],
          allowedDir,
          extraWritableDirs: [],
          // Exactly what `dispatch.ts` now computes for its own outbox
          // line: the exact FILE, never the shared directory it lives in.
          extraWritableFiles: [join(homeDir, 'outbox', 'owner-repo', '560.ndjson')]
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8'
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const parsed = JSON.parse(spawnResult.stdout) as {
          ownWriteOk: boolean
          siblingWriteBlocked: boolean
          siblingReadBlocked: boolean
        }
        expect(parsed.ownWriteOk, "writing this dispatch's own named file should succeed, first write included").toBe(
          true
        )
        expect(
          parsed.siblingWriteBlocked,
          'writing a SIBLING task/role file in the same shared directory should be blocked'
        ).toBe(true)
        expect(
          parsed.siblingReadBlocked,
          "reading a SIBLING task/role file (e.g. another role's live vendor resumeId) should be blocked"
        ).toBe(true)
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('resolveBunExecDir — independent of the DISPATCHER process own runtime (round 5 review, BLOCKER; round 6 fix)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a confined child can still exec bun even when process.execPath (this dispatcher process own interpreter) is NOT bun',
    () => {
      // The exact gap round 5 review found: the prior fix derived bun's own
      // directory from `dirname(process.execPath)`, true only when the
      // DISPATCHER is itself running under bun (this repo's own source
      // invocation, `bun apps/cli/src/index.ts`) — never true for the
      // published, declared-supported entry point, built `--target=node`
      // with a `#!/usr/bin/env node` shebang, where `process.execPath`
      // never contains `bun` at all. Every live test through round 5 ran
      // under `bun test`, where `process.execPath` genuinely IS bun, so
      // none of them could catch this — reproduced here by stubbing
      // `process.execPath` to a plainly non-bun path for the duration of
      // the resolution call, proving the fix (`which bun`, independent of
      // `process.execPath`) no longer depends on which runtime hosts the
      // dispatcher process. Fails under the prior `dirname(process.execPath)`
      // implementation; passes under the current one.
      const allowedDir = tempDir('vinaya-wb-live-execpath-allowed-')
      const binDir = tempDir('vinaya-wb-live-execpath-bin-')
      const fakeVendorBinary = fakeBinaryIn(binDir)
      const originalExecPath = process.execPath
      Object.defineProperty(process, 'execPath', { value: '/usr/bin/node-that-does-not-exist', configurable: true })
      let result: ReturnType<typeof resolveWorkerBoundaryLaunch>
      try {
        result = resolveWorkerBoundaryLaunch(
          {
            binaryPath: fakeVendorBinary,
            args: [],
            allowedDir,
            extraWritableDirs: []
          },
          REAL_WORKER_BOUNDARY_DEPS
        )
      } finally {
        Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
      }
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnConfinedSync(
          '/usr/bin/sandbox-exec',
          ['-f', result.launch.args[1] as string, 'bun', '--version'],
          { cwd: allowedDir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } }
        )
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        expect(spawnResult.stdout.trim().length).toBeGreaterThan(0)
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

/** `null` when no real `node` binary is on this host's PATH — best-effort, never assumed, the same posture `resolveGitExecPath`/`resolveBunExecDir` already take in `worker-boundary.ts` itself. */
const REAL_NODE_PATH: string | null = (() => {
  try {
    return execFileSync('which', ['node'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()

describe('resolveWorkerBoundaryLaunch — file-read-metadata for Node.js-hosted confined processes (round 2 review, MAJOR)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS) || !REAL_NODE_PATH)(
    'a real node binary no longer crashes at startup on an ancestor lstat EPERM, while the real credentials file stays content-denied',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-node-allowed-')
      const realCredentialPath = join(homedir(), '.claude', '.credentials.json')

      const probeScript = join(allowedDir, 'node-probe.js')
      writeFileSync(
        probeScript,
        [
          "const fs = require('node:fs')",
          "console.log('STARTED')",
          `try { fs.readFileSync(${JSON.stringify(realCredentialPath)}, 'utf8'); console.log('CRED:READABLE') } catch { console.log('CRED:BLOCKED') }`
        ].join('\n')
      )

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: REAL_NODE_PATH as string,
          args: [probeScript],
          allowedDir,
          extraWritableDirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        // Before this fix: `node <script>` failed immediately with `EPERM:
        // operation not permitted, lstat '/private'` (Node's own module
        // resolution walking every ancestor directory up to the filesystem
        // root) — never reaching `STARTED` at all, live-reproduced on this
        // host with the un-fixed profile.
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8'
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        const lines = spawnResult.stdout.trim().split('\n')
        expect(lines[0], 'the confined node process must start and run its own script').toBe('STARTED')
        expect(
          lines[1],
          'file-read-metadata is a separate Seatbelt operation from file-read* (content) — granting the former must not reopen the latter'
        ).toBe('CRED:BLOCKED')
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('resolveWorkerBoundaryLaunch — symlinked binaryPath exec target (security review, HIGH)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a binaryPath that is a symlink into a different directory (the official installer layout) still execs successfully',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-symlink-allowed-')
      const targetDir = tempDir('vinaya-wb-live-symlink-target-')
      const binDir = tempDir('vinaya-wb-live-symlink-bin-')
      const realVendor = join(targetDir, 'real-vendor')
      writeFileSync(realVendor, '#!/bin/bash\necho ran-ok\n')
      chmodSync(realVendor, 0o755)
      // Mirrors the officially documented macOS install layout: a PATH
      // entry symlinked into a SEPARATE directory from the symlink itself
      // (e.g. `~/.local/bin/claude` -> `~/.local/share/claude/versions/<v>`)
      // — the exact shape `dispatch.ts`'s own `which claude` resolution
      // returns, and the shape the security review's HIGH finding
      // reproduced against.
      const symlinkPath = join(binDir, 'claude')
      symlinkSync(realVendor, symlinkPath)

      const result = resolveWorkerBoundaryLaunch(
        { binaryPath: symlinkPath, args: [], allowedDir, extraWritableDirs: [] },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        // Before this fix: `sandbox-exec` was launched with the ORIGINAL,
        // un-realpath'd symlink path as its exec target, while the
        // profile's own process-exec allowlist was built from the
        // REALPATH'd target directory — a mismatch that denied the launch
        // outright (`execvp() ... Operation not permitted`), live-verified
        // by the security reviewer against exactly this installer layout.
        const spawnResult = spawnConfinedSync(result.launch.command, result.launch.args, {
          cwd: allowedDir,
          encoding: 'utf8'
        })
        expect(spawnResult.status, `stderr: ${spawnResult.stderr}`).toBe(0)
        expect(spawnResult.stdout.trim()).toBe('ran-ok')
      } finally {
        result.launch.cleanup()
      }
    }
  )
})

describe('the confined role reaches only its OWN task folder under the new layout (O4)', () => {
  const OWN_TASK = 648
  const SIBLING_TASK = 649

  /**
   * Goes through `resolveWorkerBoundaryLaunch` with paths built by `runPath`,
   * not `buildWorkerSandboxProfile` with hand-written literals (round 2
   * review, MINOR): the seam this task actually changed is the caller
   * computing ABSOLUTE grants and the launcher consuming them, and four
   * earlier assertions here named strings the test itself never passed in,
   * so they could not fail. `runtimeDir` is a real temp directory so the
   * canonicalisation the launcher performs is exercised too.
   */
  function resolveForOwnTask(runtimeDir: string): { profile: string; cleanup: () => void } | null {
    const allowedDir = tempDir('vinaya-wb-o4-allowed-')
    const binDir = tempDir('vinaya-wb-o4-bin-')
    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinaryIn(binDir),
        args: [],
        allowedDir,
        // Exactly what `dispatch.ts` computes for one confined dispatch.
        extraWritableFiles: [runPath(runtimeDir, OWN_TASK, { area: 'sessions', file: 'developer-claude.json' })],
        extraReadOnlyDirs: [runPath(runtimeDir, OWN_TASK, { area: 'hooks' })],
        extraWritableDirs: [runPath(runtimeDir, OWN_TASK, { area: 'round', round: 2, file: 'reviewer-work' })]
      },
      AVAILABLE_DEPS
    )
    if (!result.ok) return null
    return { profile: readFileSync(result.launch.args[1] as string, 'utf8'), cleanup: result.launch.cleanup }
  }

  it("grants this dispatch's own session record as an exact file, never its containing directory", () => {
    const runtimeDir = tempDir('vinaya-wb-o4-runtime-')
    const resolved = resolveForOwnTask(runtimeDir)
    expect(resolved).not.toBeNull()
    if (!resolved) return
    try {
      const ownRecord = realpathSync(runtimeDir)
      expect(resolved.profile).toContain(
        `(literal "${join(ownRecord, 'tasks-execution', String(OWN_TASK), 'sessions', 'developer-claude.json')}")`
      )
      // A subpath grant on `sessions/` would expose every OTHER role's record
      // for this task — the widening the exact-file grant exists to stop.
      expect(resolved.profile).not.toContain(
        `(subpath "${join(ownRecord, 'tasks-execution', String(OWN_TASK), 'sessions')}")`
      )
    } finally {
      resolved.cleanup()
    }
  })

  it("never names another task's folder, the tasks root, or the runtime directory itself", () => {
    const runtimeDir = tempDir('vinaya-wb-o4-runtime-')
    // Create the sibling task's own files, so the strings below are real
    // paths on disk that a widened grant could plausibly have canonicalised
    // and emitted — not names nothing ever produced.
    const siblingSessions = runPath(runtimeDir, SIBLING_TASK, { area: 'sessions' })
    mkdirSync(siblingSessions, { recursive: true })
    writeFileSync(join(siblingSessions, 'developer-claude.json'), '{}')
    const resolved = resolveForOwnTask(runtimeDir)
    expect(resolved).not.toBeNull()
    if (!resolved) return
    try {
      const real = realpathSync(runtimeDir)
      const siblingDir = join(real, 'tasks-execution', String(SIBLING_TASK))
      expect(resolved.profile).not.toContain(siblingDir)
      expect(resolved.profile).not.toContain(`(subpath "${join(real, 'tasks-execution')}")`)
      expect(resolved.profile).not.toContain(`(subpath "${real}")`)
    } finally {
      resolved.cleanup()
    }
  })

  it('never names the configuration file, and keeps the hooks directory out of the read-write rule', () => {
    const runtimeDir = tempDir('vinaya-wb-o4-runtime-')
    const resolved = resolveForOwnTask(runtimeDir)
    expect(resolved).not.toBeNull()
    if (!resolved) return
    try {
      expect(resolved.profile).not.toContain('config.json')
      const real = realpathSync(runtimeDir)
      const hooksDir = join(real, 'tasks-execution', String(OWN_TASK), 'hooks')
      const rwRuleIdx = resolved.profile.indexOf('(allow file-read* file-write*')
      const rwRuleEnd = resolved.profile.indexOf('))', rwRuleIdx) + 2
      // Read-only: the trusted controller writes the settings file and the
      // hook scripts before the child starts, and a confined child that could
      // rewrite them would strip its own hooks.
      expect(resolved.profile.slice(rwRuleIdx, rwRuleEnd)).not.toContain(hooksDir)
      expect(resolved.profile).toContain(`(subpath "${hooksDir}")`)
    } finally {
      resolved.cleanup()
    }
  })

  it("grants a reviewer only its own round's work directory, never the round folder or a sibling round", () => {
    const runtimeDir = tempDir('vinaya-wb-o4-runtime-')
    const resolved = resolveForOwnTask(runtimeDir)
    expect(resolved).not.toBeNull()
    if (!resolved) return
    try {
      const real = realpathSync(runtimeDir)
      const roundTwo = join(real, 'tasks-execution', String(OWN_TASK), 'rounds', '2')
      expect(resolved.profile).toContain(`(subpath "${join(roundTwo, 'reviewer-work')}")`)
      // Not the round folder itself — that holds both roles' held verdicts
      // and the shared read-only candidate every reviewer this round judges.
      expect(resolved.profile).not.toContain(`(subpath "${roundTwo}")`)
      expect(resolved.profile).not.toContain(join(roundTwo, 'security-work'))
      expect(resolved.profile).not.toContain(join(real, 'tasks-execution', String(OWN_TASK), 'rounds', '1'))
    } finally {
      resolved.cleanup()
    }
  })

  it('canonicalises a grant whose path does not exist yet, through a symlinked runtime directory', () => {
    // The documentation-log file `dispatch.ts` grants never exists at
    // resolution time, and the reference's own documented example runtimeDir
    // (`/var/lib/vinaya/runs`) traverses a symlink on the one host with a
    // boundary. A grant left non-canonical would never match what the kernel
    // resolves (round 2 review, MAJOR).
    const realRuntime = tempDir('vinaya-wb-o4-realruntime-')
    const linkParent = tempDir('vinaya-wb-o4-link-')
    const linkedRuntime = join(linkParent, 'runs')
    symlinkSync(realRuntime, linkedRuntime)

    const allowedDir = tempDir('vinaya-wb-o4-allowed-')
    const binDir = tempDir('vinaya-wb-o4-bin-')
    const notYetCreated = runPath(linkedRuntime, OWN_TASK, { area: 'hooks', file: 'documentation-log-run1.jsonl' })
    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinaryIn(binDir),
        args: [],
        allowedDir,
        extraWritableFiles: [notYetCreated],
        extraWritableDirs: []
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    try {
      const profile = readFileSync(result.launch.args[1] as string, 'utf8')
      const canonical = join(
        realpathSync(realRuntime),
        'tasks-execution',
        String(OWN_TASK),
        'hooks',
        'documentation-log-run1.jsonl'
      )
      expect(profile).toContain(`(literal "${canonical}")`)
      expect(profile).not.toContain(linkedRuntime)
    } finally {
      result.launch.cleanup()
    }
  })
})
