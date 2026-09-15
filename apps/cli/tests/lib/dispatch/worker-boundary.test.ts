import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildWorkerEnv,
  buildWorkerSandboxProfile,
  isWorkerBoundaryAvailable,
  resolveWorkerBoundaryLaunch,
  RUNTIME_CREDENTIAL_ENV_KEYS,
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
        vinayaHomeDir: tempDir('vinaya-wb-home-'),
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
        vinayaHomeDir: tempDir('vinaya-wb-home-'),
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
      expect(profile).toContain('(allow network-outbound)')
      expect(profile).toContain('com.apple.securityd')
      expect(profile).toContain('(deny signal)')
      expect(profile).toContain('(deny process-info* (target others))')
      // round 2 review, LOW: outbound port 22 denied as a cheap, disclosed
      // partial egress mitigation.
      expect(profile).toContain('(deny network-outbound (remote tcp "*:22"))')
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
        vinayaHomeDir: tempDir('vinaya-wb-home-'),
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume'],
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume'],
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume'],
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume'],
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

describe('resolveWorkerBoundaryLaunch — GLOBAL_VINAYA_HOME narrowed (round 2 review, MAJOR)', () => {
  it("vinayaHomeDir itself is read-only — a confined Worker cannot rewrite ~/.vinaya's own config.json", () => {
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
      expect(profile).toContain(`(allow file-read*\n    (subpath "${homeDir}")`)
    } finally {
      result.launch.cleanup()
    }
  })

  it('only outbox/ and dispatch-resume/ under vinayaHomeDir get read+write, even when they do not exist yet', () => {
    const allowedDir = tempDir('vinaya-wb-allowed-')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox', 'dispatch-resume']
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
