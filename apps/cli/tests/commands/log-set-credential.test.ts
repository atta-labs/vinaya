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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { type LogSetCredentialDeps, logSetCredentialCommand } from '../../src/commands/log-set-credential.js'
import { runRealSecurityCommand, storeLogHeaderKeychainCredential } from '../../src/lib/worker-boundary.js'

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

/**
 * The store itself (`storeLogHeaderKeychainCredential`), with the real
 * `/usr/bin/security` runner injected out so these run on Linux CI. A fake
 * keychain decodes the `-X <hex>` off the `security -i` command exactly as the
 * real tool would, so the hex round-trip (O3) and the read-back confirmation (O4)
 * are provable without a Keychain, and every recorded argument list is asserted to
 * never carry the value (O2).
 */
function fakeSecurity() {
  const calls: Array<{ args: string[]; input: string }> = []
  const items = new Map<string, string>()
  const run = (args: readonly string[], input: string): string => {
    calls.push({ args: [...args], input })
    if (args[0] === '-i') {
      const tokens = input.trim().split(/\s+/)
      const account = tokens[tokens.indexOf('-a') + 1] ?? ''
      const hex = tokens[tokens.indexOf('-X') + 1] ?? ''
      items.set(account, Buffer.from(hex, 'hex').toString('utf8'))
      return ''
    }
    if (args[0] === 'find-generic-password') {
      const account = args[args.indexOf('-a') + 1] ?? ''
      const value = items.get(account)
      if (value === undefined) {
        const err = new Error('item not found') as Error & { status?: number }
        err.status = 44
        throw err
      }
      return `${value}\n`
    }
    throw new Error(`unexpected security invocation: ${args.join(' ')}`)
  }
  return { run, calls, items }
}

describe('storeLogHeaderKeychainCredential (injected runner)', () => {
  // O3: every awkward character class the value can carry.
  const AWKWARD_VALUES = [
    'plain-token',
    'has spaces inside',
    'has "double" quotes',
    "has 'single' quotes",
    'back\\slash\\here',
    'all "\' \\ mixed',
    'x'.repeat(600)
  ]

  for (const value of AWKWARD_VALUES) {
    it(`O2/O3: round-trips ${JSON.stringify(value.length > 20 ? `${value.slice(0, 12)}…` : value)} with the value never in any argument list`, () => {
      const sec = fakeSecurity()
      storeLogHeaderKeychainCredential('VINAYA_LOG_TOKEN', value, { runSecurity: sec.run, platform: 'darwin' })
      // O3: the fake decoded the hex back to exactly the original value.
      expect(sec.items.get('VINAYA_LOG_TOKEN')).toBe(value)
      // O2: no recorded argument list carries the value; it travelled only as hex on stdin.
      for (const call of sec.calls) {
        for (const arg of call.args) expect(arg).not.toContain(value)
      }
      // The store command reached `security -i`, and the value is present in its
      // stdin only as hex, never verbatim.
      const store = sec.calls.find((c) => c.args[0] === '-i')
      expect(store).toBeDefined()
      expect(store?.input).toContain(Buffer.from(value, 'utf8').toString('hex'))
      expect(store?.input).not.toContain(value)
    })
  }

  it('O4: throws (naming the variable, never the value) when the item is absent after the write', () => {
    // A store command that records but never actually writes leaves the read-back empty.
    const noWrite = (args: readonly string[]): string => {
      if (args[0] === '-i') return ''
      const err = new Error('item not found') as Error & { status?: number }
      err.status = 44
      throw err
    }
    let message = ''
    try {
      storeLogHeaderKeychainCredential('VINAYA_LOG_TOKEN', 'the-secret', { runSecurity: noWrite, platform: 'darwin' })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('VINAYA_LOG_TOKEN')
    expect(message).toContain('absent')
    expect(message).not.toContain('the-secret')
  })

  it('O4: throws when the stored item reads back different from the given value', () => {
    const drift = (args: readonly string[]): string => {
      if (args[0] === '-i') return ''
      return 'a-different-value\n'
    }
    let message = ''
    try {
      storeLogHeaderKeychainCredential('VINAYA_LOG_TOKEN', 'the-secret', { runSecurity: drift, platform: 'darwin' })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('VINAYA_LOG_TOKEN')
    expect(message).toContain('different')
    expect(message).not.toContain('the-secret')
  })

  it('maps a `security -i` failure to a message carrying only the exit code', () => {
    const boom = (): string => {
      const err = new Error('exec failed') as Error & { status?: number }
      err.status = 59
      throw err
    }
    expect(() =>
      storeLogHeaderKeychainCredential('VINAYA_LOG_TOKEN', 'the-secret', { runSecurity: boom, platform: 'darwin' })
    ).toThrow('security add-generic-password failed (exit 59)')
  })

  it('refuses a non-identifier variable name before touching security', () => {
    const sec = fakeSecurity()
    expect(() =>
      storeLogHeaderKeychainCredential('bad name"; rm', 'v', { runSecurity: sec.run, platform: 'darwin' })
    ).toThrow('not a plain identifier')
    expect(sec.calls).toEqual([])
  })

  it('refuses off macOS', () => {
    expect(() => storeLogHeaderKeychainCredential('VINAYA_LOG_TOKEN', 'v', { platform: 'linux' })).toThrow(
      'only on macOS'
    )
  })
})

/**
 * O5: drives the REAL `/usr/bin/security` against a throwaway keychain FILE —
 * never the login keychain, never `security default-keychain` — proving O1–O4
 * end to end on macOS, and skipped everywhere else.
 */
const describeMac = process.platform === 'darwin' ? describe : describe.skip
describeMac('storeLogHeaderKeychainCredential against a real throwaway keychain (O5)', () => {
  it('round-trips values through /usr/bin/security, keeps the value out of every argv, and confirms by read-back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-log-kc-'))
    const keychain = join(dir, 'throwaway.keychain')
    const keychainPassword = 'throwaway-keychain-password'
    runRealSecurityCommand(['create-keychain', '-p', keychainPassword, keychain], '')
    try {
      runRealSecurityCommand(['unlock-keychain', '-p', keychainPassword, keychain], '')
      const calls: string[][] = []
      const runSecurity = (args: readonly string[], input: string): string => {
        calls.push([...args])
        return runRealSecurityCommand(args, input)
      }
      const values = [
        'plain-token',
        'has spaces inside',
        'has "double" quotes',
        "has 'single' quotes",
        'back\\slash\\here',
        'all "\' \\ mixed'
      ]
      values.forEach((value, i) => {
        const variable = `VINAYA_LOG_TEST_${i}`
        storeLogHeaderKeychainCredential(variable, value, { runSecurity, keychain })
        const readBack = runRealSecurityCommand(
          ['find-generic-password', '-s', 'Vinaya Log', '-a', variable, '-w', keychain],
          ''
        ).replace(/\n$/, '')
        expect(readBack).toBe(value) // O1, O3
      })

      // O2: the store function's own invocations never put a value in argv.
      for (const value of values) {
        for (const args of calls) {
          for (const arg of args) expect(arg).not.toContain(value)
        }
      }

      // O4 (update in place still round-trips through the read-back gate).
      storeLogHeaderKeychainCredential('VINAYA_LOG_TEST_0', 'updated-value', { runSecurity, keychain })
      expect(
        runRealSecurityCommand(
          ['find-generic-password', '-s', 'Vinaya Log', '-a', 'VINAYA_LOG_TEST_0', '-w', keychain],
          ''
        ).replace(/\n$/, '')
      ).toBe('updated-value')

      // O4 (negative) against real security: a store command that does not write
      // leaves the item absent, so the read-back gate fails — naming the variable,
      // never the value.
      const noWrite = (args: readonly string[], input: string): string =>
        args[0] === '-i' ? '' : runRealSecurityCommand(args, input)
      let message = ''
      try {
        storeLogHeaderKeychainCredential('VINAYA_LOG_ABSENT', 'never-written', { runSecurity: noWrite, keychain })
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain('VINAYA_LOG_ABSENT')
      expect(message).not.toContain('never-written')
    } finally {
      try {
        runRealSecurityCommand(['delete-keychain', keychain], '')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})
