import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  buildWorkerEnv,
  buildWorkerSandboxProfile,
  isWorkerBoundaryAvailable,
  resolveWorkerBoundaryLaunch,
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
  return mkdtempSync(join(tmpdir(), prefix))
}

const AVAILABLE_DEPS: WorkerBoundaryDeps = {
  detectHost: () => ({ platform: 'darwin', sandboxExecExecutable: true })
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
        vinayaHomeDir: tempDir('vinaya-wb-home-')
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
        vinayaHomeDir: tempDir('vinaya-wb-home-')
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
    const fakeBinary = join(binDir, 'fake-vendor')
    writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n')
    chmodSync(fakeBinary, 0o755)

    const result = resolveWorkerBoundaryLaunch(
      { binaryPath: fakeBinary, args: ['--foo', 'bar'], allowedDir, vinayaHomeDir: homeDir },
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
    } finally {
      result.launch.cleanup()
    }
  })

  it('cleanup removes the generated profile directory', () => {
    const allowedDir = tempDir('vinaya-wb-allowed-')
    const homeDir = tempDir('vinaya-wb-home-')
    const binDir = tempDir('vinaya-wb-bin-')
    const fakeBinary = join(binDir, 'fake-vendor')
    writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n')
    chmodSync(fakeBinary, 0o755)

    const result = resolveWorkerBoundaryLaunch(
      { binaryPath: fakeBinary, args: [], allowedDir, vinayaHomeDir: homeDir },
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
        vinayaHomeDir: tempDir('vinaya-wb-home-')
      },
      AVAILABLE_DEPS
    )
    expect(result.ok).toBe(false)
  })
})

describe('buildWorkerSandboxProfile — Seatbelt string-literal escaping', () => {
  it('escapes a backslash or double quote so it cannot break out of the profile string literal', () => {
    const hostile = '/tmp/evil"))(allow default)(deny file-read* (subpath "'
    const profile = buildWorkerSandboxProfile({
      realHome: '/Users/marker',
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
