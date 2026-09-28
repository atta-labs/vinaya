/**
 * `vinaya log set-credential <VAR_NAME>` (issue #841, O2): stores a
 * `logs.headers` credential in the macOS login Keychain, reading the value from
 * STANDARD INPUT — never a command-line argument — and printing nothing of it.
 *
 * The Keychain write and the stdin read are both injected, so the command is
 * provable on Linux CI where the real Keychain is absent: the fake `store`
 * records what it was handed, and the assertions prove the value never reaches
 * stdout or stderr.
 */

import { describe, expect, it } from 'bun:test'
import { type LogSetCredentialDeps, logSetCredentialCommand } from '../../src/commands/log-set-credential.js'

const SECRET = 'super-secret-token-value-abc123'

function harness(overrides: Partial<LogSetCredentialDeps> = {}) {
  const stored: Array<{ variable: string; value: string }> = []
  let out = ''
  let err = ''
  const deps: LogSetCredentialDeps = {
    store: (variable, value) => {
      stored.push({ variable, value })
    },
    readStdin: async () => `${SECRET}\n`,
    stdout: (text) => {
      out += text
    },
    stderr: (text) => {
      err += text
    },
    ...overrides
  }
  return { deps, stored, out: () => out, err: () => err }
}

describe('vinaya log set-credential', () => {
  it('O2: stores the value from stdin under the given variable name and exits 0', async () => {
    const h = harness()
    const code = await logSetCredentialCommand(['VINAYA_LOG_TOKEN'], h.deps)
    expect(code).toBe(0)
    expect(h.stored).toEqual([{ variable: 'VINAYA_LOG_TOKEN', value: SECRET }])
  })

  it('O2: prints nothing of the value — the secret never reaches stdout or stderr', async () => {
    const h = harness()
    await logSetCredentialCommand(['VINAYA_LOG_TOKEN'], h.deps)
    expect(h.out()).not.toContain(SECRET)
    expect(h.err()).not.toContain(SECRET)
    // The confirmation still names the variable so the operator knows it landed.
    expect(h.out()).toContain('VINAYA_LOG_TOKEN')
    expect(h.err()).toBe('')
  })

  it('strips a single trailing newline (a shell `echo`) but keeps the value otherwise verbatim', async () => {
    const h = harness({ readStdin: async () => '  padded value \n' })
    await logSetCredentialCommand(['TOK'], h.deps)
    expect(h.stored[0]?.value).toBe('  padded value ')
  })

  it('refuses when no variable name is given (exit 2), storing nothing', async () => {
    const h = harness()
    const code = await logSetCredentialCommand([], h.deps)
    expect(code).toBe(2)
    expect(h.stored).toEqual([])
    expect(h.err()).toContain('name the environment variable')
  })

  it('refuses a value that looks like a flag rather than a variable name (exit 2)', async () => {
    const h = harness()
    const code = await logSetCredentialCommand(['--token'], h.deps)
    expect(code).toBe(2)
    expect(h.stored).toEqual([])
  })

  it('refuses a malformed variable name (exit 2)', async () => {
    const h = harness()
    const code = await logSetCredentialCommand(['1BAD-NAME'], h.deps)
    expect(code).toBe(2)
    expect(h.stored).toEqual([])
    expect(h.err()).toContain('not a valid environment-variable name')
  })

  it('refuses empty stdin (exit 2), storing nothing', async () => {
    const h = harness({ readStdin: async () => '\n' })
    const code = await logSetCredentialCommand(['VINAYA_LOG_TOKEN'], h.deps)
    expect(code).toBe(2)
    expect(h.stored).toEqual([])
    expect(h.err()).toContain('no value on standard input')
  })

  it('reports a Keychain write failure (exit 1) without leaking the value', async () => {
    const h = harness({
      store: () => {
        throw new Error('security add-generic-password failed (exit 45)')
      }
    })
    const code = await logSetCredentialCommand(['VINAYA_LOG_TOKEN'], h.deps)
    expect(code).toBe(1)
    expect(h.err()).toContain('security add-generic-password failed (exit 45)')
    expect(h.err()).not.toContain(SECRET)
    expect(h.out()).toBe('')
  })
})
