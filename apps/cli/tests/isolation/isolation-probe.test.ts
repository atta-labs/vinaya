import { describe, expect, it, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildSandboxProfile,
  isSandboxSupported,
  PROBE_CHECK_NAMES,
  runBare,
  runConfined
} from '../../scripts/isolation-probe'
import { spawnSync } from 'node:child_process'

/** A standalone script (no local imports) run BOTH bare and under
 * sandbox-exec by the two tests below. Attempts the two operations
 * round 3's security finding proved the profile left open: writing
 * outside the confined child's allowed directory, and connecting out
 * over the network to an address that is NOT the ssh-agent socket
 * check 5 already covers. Prints `{writeBlocked, netBlocked}` as JSON. */
const EXTRA_CHECK_SCRIPT = `
const fs = require('node:fs')
const net = require('node:net')
const [, , outsidePath, portArg] = process.argv
let writeBlocked
try {
  fs.writeFileSync(outsidePath, 'vinaya-isolation-probe-extra-check')
  writeBlocked = false
} catch {
  writeBlocked = true
}
const socket = net.connect(Number(portArg), '127.0.0.1')
const finish = (netBlocked) => {
  socket.removeAllListeners()
  socket.destroy()
  console.log(JSON.stringify({ writeBlocked, netBlocked }))
  process.exit(0)
}
socket.on('connect', () => finish(false))
socket.on('error', () => finish(true))
setTimeout(() => finish(true), 1500)
`

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

test.skipIf(!isSandboxSupported())(
  'confined run blocks every applicable negative, distinguishing a genuine n/a from a silently-collapsed one',
  () => {
    // A bare `null` means the resource genuinely doesn't exist on this host
    // (no ssh-agent, no osxkeychain helper) — the ONLY case a confined `null`
    // is allowed to mean the same thing. Without this pairing, a confined
    // `null` caused by an input that never reached the child (the bun/argv
    // defect `ProbeOverrides` exists to close) is indistinguishable from a
    // real n/a, and the suite stays green either way.
    const bare = runBare()
    const confined = runConfined()
    for (const name of PROBE_CHECK_NAMES) {
      const outcome = confined[name]
      const genuinelyNotApplicable = outcome === null && bare[name] === null
      expect(
        outcome === false || genuinelyNotApplicable,
        `check "${name}" was accessible while confined (confined: ${outcome}, bare: ${bare[name]})`
      ).toBe(true)
    }
  }
)

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

/**
 * Round 3 security finding: the profile's `(allow default)` baseline left
 * file-write to any path outside the confined worktree, and general
 * outbound network connections, both open — neither is one of the six
 * named PROBE_CHECK_NAMES, so the six-check suite above never caught it.
 * These two tests exercise the profile directly for exactly the two
 * properties that finding proved missing.
 */
test.skipIf(!isSandboxSupported())(
  'confined run cannot write outside its allowed directory or reach the network',
  async () => {
    // Realpath'd for the same reason `runConfined` realpaths its own scratch
    // dir: `tmpdir()` can return a path through a symlinked alias (macOS's
    // `/var` resolves to `/private/var`), and Seatbelt's `subpath` filter
    // matches the resolved path, not the alias.
    const scratchDir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-probe-extra-')))
    const fakeHome = join(scratchDir, 'fake-home')
    const outsidePath = join(tmpdir(), `isolation-probe-outside-${process.pid}-${Date.now()}`)
    const scriptPath = join(scratchDir, 'extra-check.js')
    writeFileSync(scriptPath, EXTRA_CHECK_SCRIPT)

    const server = createServer((socket) => socket.end())
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })

    try {
      const profilePath = buildSandboxProfile({
        realHome: '/nonexistent/real-home-marker',
        allowedDir: scratchDir,
        fakeHome,
        sshSockCanon: '/nonexistent/ssh-auth-sock',
        runtimeExecPath: process.execPath
      })
      try {
        const result = spawnSync(
          '/usr/bin/sandbox-exec',
          ['-f', profilePath, process.execPath, scriptPath, outsidePath, String(port)],
          { cwd: scratchDir, encoding: 'utf8' }
        )
        expect(result.status, `stderr: ${result.stderr}`).toBe(0)
        const parsed = JSON.parse(result.stdout) as { writeBlocked: boolean; netBlocked: boolean }
        expect(parsed.writeBlocked, 'write outside the allowed directory should be blocked while confined').toBe(true)
        expect(parsed.netBlocked, 'a general outbound connection should be blocked while confined').toBe(true)
      } finally {
        rmSync(dirname(profilePath), { recursive: true, force: true })
      }
    } finally {
      server.close()
      rmSync(scratchDir, { recursive: true, force: true })
      rmSync(outsidePath, { force: true })
    }
  }
)
