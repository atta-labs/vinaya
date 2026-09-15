import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildWorkerEnv,
  buildWorkerSandboxProfile,
  isWorkerBoundaryAvailable,
  REAL_WORKER_BOUNDARY_DEPS,
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

describe('resolveWorkerBoundaryLaunch — GLOBAL_VINAYA_HOME narrowed (round 2 review, MAJOR; round 4 review, HIGH)', () => {
  it("vinayaHomeDir itself is NOT exposed at all — a confined Worker cannot read or rewrite ~/.vinaya's own config.json", () => {
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

describe('resolveWorkerBoundaryLaunch — vinayaHomeReadOnlySubdirs (round 4 review, BLOCKER: --settings file readable)', () => {
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
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: ['outbox'],
        vinayaHomeReadOnlySubdirs: ['dispatch-settings']
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
      // profile (which never names anything under `vinayaHomeDir`).
      const readOnlyIdx = profile.lastIndexOf('(allow file-read*\n    (subpath', rwRuleIdx)
      const readOnlyEnd = profile.indexOf('))', readOnlyIdx) + 2
      expect(profile.slice(readOnlyIdx, readOnlyEnd)).toContain(join(homeDir, 'dispatch-settings'))
      expect(rwRuleBody).not.toContain(join(homeDir, 'dispatch-settings'))
      expect(rwRuleBody).toContain(join(homeDir, 'outbox'))
    } finally {
      result.launch.cleanup()
    }
  })

  it('an absent vinayaHomeReadOnlySubdirs (undefined) behaves exactly like an empty array — no crash, nothing extra granted', () => {
    const allowedDir = tempDir('vinaya-wb-ro-absent-allowed-')
    const homeDir = tempDir('vinaya-wb-ro-absent-home-')
    const binDir = tempDir('vinaya-wb-ro-absent-bin-')
    const fakeBinary = fakeBinaryIn(binDir)

    const result = resolveWorkerBoundaryLaunch(
      {
        binaryPath: fakeBinary,
        args: [],
        allowedDir,
        vinayaHomeDir: homeDir,
        vinayaHomeWritableSubdirs: []
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
          vinayaHomeDir: homeDir,
          vinayaHomeWritableSubdirs: [],
          vinayaHomeReadOnlySubdirs: ['dispatch-settings']
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnSync(result.launch.command, result.launch.args, {
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
    'round 6 review, security CRITICAL: a confined child can append to its own named file inside an otherwise read-only vinayaHomeReadOnlySubdirs directory, but still cannot write a sibling file there',
    () => {
      // Reproduces `documentationLogHookScript`'s own shape live: the
      // `PostToolUse` WebFetch hook appends to `documentation-log-<runId>
      // .jsonl` inside `dispatch-settings`, a directory otherwise granted
      // read-only (`vinayaHomeReadOnlySubdirs`, above) because nothing else
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
          vinayaHomeDir: homeDir,
          vinayaHomeWritableSubdirs: [],
          vinayaHomeReadOnlySubdirs: ['dispatch-settings'],
          vinayaHomeWritableFiles: [join('dispatch-settings', 'documentation-log-run1.jsonl')]
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnSync(result.launch.command, result.launch.args, {
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
      const homeDir = tempDir('vinaya-wb-live-dns-home-')

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
          vinayaHomeDir: homeDir,
          vinayaHomeWritableSubdirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnSync(result.launch.command, result.launch.args, {
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
      const homeDir = tempDir('vinaya-wb-live-home-')
      const binDir = tempDir('vinaya-wb-live-bin-')
      const probeBinary = join(binDir, 'probe.sh')
      writeFileSync(probeBinary, CONFINEMENT_PROBE_SCRIPT)
      chmodSync(probeBinary, 0o755)
      const insidePath = join(allowedDir, 'inside.txt')
      const outsidePath = join(tmpdir(), `vinaya-wb-live-outside-${process.pid}-${Date.now()}`)
      // The REAL account home (`os.homedir()`, never this test's own scratch
      // `homeDir` — that is only `vinayaHomeDir`, an unrelated parameter) is
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
          vinayaHomeDir: homeDir,
          vinayaHomeWritableSubdirs: []
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
        const spawnResult = spawnSync(result.launch.command, result.launch.args, {
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
    'a real confined child cannot read the real Keychain directory',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-keychain-')
      const homeDir = tempDir('vinaya-wb-live-keychain-home-')
      const binDir = tempDir('vinaya-wb-live-keychain-bin-')
      const fakeBinary = fakeBinaryIn(binDir)

      const result = resolveWorkerBoundaryLaunch(
        {
          binaryPath: fakeBinary,
          args: [],
          allowedDir,
          vinayaHomeDir: homeDir,
          vinayaHomeWritableSubdirs: []
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
        const spawnResult = spawnSync(
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

describe('resolveWorkerBoundaryLaunch — bun toolchain reachable (round 5 review, BLOCKER)', () => {
  it.skipIf(!isWorkerBoundaryAvailable(REAL_WORKER_BOUNDARY_DEPS))(
    'a confined child can still exec bun for its own build/test subprocesses when binaryPath is a non-bun vendor binary (the real production shape)',
    () => {
      const allowedDir = tempDir('vinaya-wb-live-bun-')
      const homeDir = tempDir('vinaya-wb-live-bun-home-')
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
          vinayaHomeDir: homeDir,
          vinayaHomeWritableSubdirs: []
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnSync(
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
          vinayaHomeDir: homeDir,
          // Exactly what `dispatch.ts` now computes: `dirname(outboxPath)`
          // and `dirname(resumeRecordPathFor(...))`, scoped to ONE repo.
          vinayaHomeWritableSubdirs: [join('outbox', 'owner-repoA'), join('dispatch-resume', 'owner-repoA')]
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnSync(result.launch.command, result.launch.args, {
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
    'a confined dispatch granted vinayaHomeWritableFiles can write its OWN outbox/resume file but not a SIBLING task/role file in the SAME repo-segment directory',
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
          vinayaHomeDir: homeDir,
          vinayaHomeWritableSubdirs: [],
          // Exactly what `dispatch.ts` now computes for its own outbox
          // line: the exact FILE, never the shared directory it lives in.
          vinayaHomeWritableFiles: [join('outbox', 'owner-repo', '560.ndjson')]
        },
        REAL_WORKER_BOUNDARY_DEPS
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnSync(result.launch.command, result.launch.args, {
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
      const homeDir = tempDir('vinaya-wb-live-execpath-home-')
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
            vinayaHomeDir: homeDir,
            vinayaHomeWritableSubdirs: []
          },
          REAL_WORKER_BOUNDARY_DEPS
        )
      } finally {
        Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
      }
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const spawnResult = spawnSync(
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
