import { describe, expect, it, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSandboxProfile,
  isSandboxSupported,
  PROBE_CHECK_NAMES,
  runBare,
  runConfined
} from '../../scripts/isolation-probe'

/**
 * Proves apps/cli/specs/isolation.md's O2: the chosen mechanism (Apple
 * Seatbelt) blocks all six negatives inside its confinement, and the SAME
 * six checks succeed with no confinement at all. The sandbox-exec-backed
 * tests only run on the host this contract actually claims support for
 * (Darwin) — `isolation.md` §3 names no mechanism for any other host yet,
 * so skipping there is the contract's own documented scope, not a gap this
 * suite papers over.
 */

describe('PROBE_CHECK_NAMES', () => {
  it('names exactly the six boundaries isolation.md documents', () => {
    expect(PROBE_CHECK_NAMES).toEqual([
      'environment',
      'home',
      'keychain',
      'credentialHelper',
      'socket',
      'parentProcess'
    ])
  })
})

describe('buildSandboxProfile', () => {
  it('substitutes every {{PLACEHOLDER}} with the supplied value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isolation-probe-test-'))
    try {
      const profilePath = buildSandboxProfile({
        realHome: '/REAL_HOME_MARKER',
        allowedDir: '/ALLOWED_DIR_MARKER',
        fakeHome: '/FAKE_HOME_MARKER',
        sshSockCanon: '/SSH_SOCK_MARKER',
        runtimeExecPath: '/RUNTIME_EXEC_MARKER'
      })
      const rendered = readFileSync(profilePath, 'utf8')
      // The fixture's own header comment mentions the literal token
      // `{{PLACEHOLDER}}` as documentation — check the real placeholders by
      // name rather than a blanket `{{` scan.
      expect(rendered).not.toContain('{{REAL_HOME}}')
      expect(rendered).not.toContain('{{ALLOWED_DIR}}')
      expect(rendered).not.toContain('{{FAKE_HOME}}')
      expect(rendered).not.toContain('{{SSH_SOCK_CANON}}')
      expect(rendered).not.toContain('{{RUNTIME_EXEC_PATH}}')
      expect(rendered).toContain('/REAL_HOME_MARKER')
      expect(rendered).toContain('/ALLOWED_DIR_MARKER')
      expect(rendered).toContain('/FAKE_HOME_MARKER')
      expect(rendered).toContain('/SSH_SOCK_MARKER')
      expect(rendered).toContain('/RUNTIME_EXEC_MARKER')
      expect(rendered).toContain('(version 1)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('escapes a backslash or double quote so it cannot break out of the profile string literal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isolation-probe-test-'))
    try {
      const hostile = '/tmp/evil"))(allow default)(deny file-read* (subpath "'
      const profilePath = buildSandboxProfile({
        realHome: hostile,
        allowedDir: '/ALLOWED_DIR_MARKER',
        fakeHome: '/FAKE_HOME_MARKER',
        sshSockCanon: '/SSH_SOCK_MARKER',
        runtimeExecPath: '/RUNTIME_EXEC_MARKER'
      })
      const rendered = readFileSync(profilePath, 'utf8')
      // The injected `"` must show up escaped (`\"`), never as a bare
      // quote that would close the string literal early.
      expect(rendered).toContain('\\"')
      expect(rendered).not.toContain(`"${hostile}"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.skipIf(!isSandboxSupported())('confined run blocks every applicable negative', () => {
  const results = runConfined()
  for (const name of PROBE_CHECK_NAMES) {
    const outcome = results[name]
    expect(outcome === false || outcome === null, `check "${name}" was accessible while confined: ${outcome}`).toBe(
      true
    )
  }
})

test.skipIf(!isSandboxSupported())('bare run leaves every applicable check accessible', () => {
  const results = runBare()
  for (const name of PROBE_CHECK_NAMES) {
    const outcome = results[name]
    expect(outcome === true || outcome === null, `check "${name}" was blocked while bare: ${outcome}`).toBe(true)
  }
})

test.skipIf(isSandboxSupported())(
  'on an unsupported host, isSandboxSupported reports false (documented scope, not a gap)',
  () => {
    expect(isSandboxSupported()).toBe(false)
  }
)
