// `vinaya log set-credential <VAR_NAME>` — store a `logs.headers` credential in
// the macOS login Keychain (issue #841, O2), so an Operator the Claude desktop
// app starts on macOS delivers logs with no token copied into any settings file.
//
// The value is read from STANDARD INPUT, never a command-line argument a `ps`
// listing could show — `printf %s "$TOKEN" | vinaya log set-credential
// VINAYA_LOG_TOKEN`. Only the variable NAME, which is not a secret, sits on the
// command line. The command prints a confirmation naming the variable and never
// echoes, returns, or logs the value; the low-level `security add-generic-password`
// invocation (`-w` last and empty, value on stdin) lives in `worker-boundary.ts`,
// beside the Codex worker's own Keychain access.

import { storeLogHeaderKeychainCredential } from '../lib/worker-boundary.js'

/** Injected so the command is provable on Linux CI, where the real Keychain is absent and `process.stdin` is not a credential source. */
export type LogSetCredentialDeps = {
  store: (variable: string, value: string) => void
  readStdin: () => Promise<string>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export function realLogSetCredentialDeps(): LogSetCredentialDeps {
  return {
    store: storeLogHeaderKeychainCredential,
    readStdin: readAllStdin,
    stdout: (text) => {
      process.stdout.write(text)
    },
    stderr: (text) => {
      process.stderr.write(text)
    }
  }
}

/**
 * Returns the process exit code — `0` on a stored credential, `2` for a missing
 * or malformed variable name or empty stdin, `1` when the Keychain write itself
 * failed (its message carries only the process's exit code, never the value).
 */
export async function logSetCredentialCommand(
  args: string[],
  deps: LogSetCredentialDeps = realLogSetCredentialDeps()
): Promise<number> {
  const variable = args[0]
  if (variable === undefined || variable.startsWith('-')) {
    deps.stderr(
      'vinaya log set-credential: name the environment variable to store, e.g. ' +
        '`printf %s "$TOKEN" | vinaya log set-credential VINAYA_LOG_TOKEN` (the value is read from standard input).\n'
    )
    return 2
  }
  if (!VAR_NAME_PATTERN.test(variable)) {
    deps.stderr(
      `vinaya log set-credential: '${variable}' is not a valid environment-variable name ` +
        '(letters, digits and underscore, never starting with a digit).\n'
    )
    return 2
  }

  // Strip a single trailing newline a shell's own `echo` adds; keep everything
  // else verbatim. Never printed or logged.
  const value = (await deps.readStdin()).replace(/\n$/, '')
  if (value.length === 0) {
    deps.stderr(
      'vinaya log set-credential: no value on standard input — pipe the credential in, e.g. ' +
        '`printf %s "$TOKEN" | vinaya log set-credential VINAYA_LOG_TOKEN`.\n'
    )
    return 2
  }

  try {
    deps.store(variable, value)
  } catch (err) {
    deps.stderr(`vinaya log set-credential: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  deps.stdout(
    `Stored a log delivery credential for the ${variable} variable in the macOS login Keychain ` +
      '(service "Vinaya Log"). Its value was not printed.\n'
  )
  return 0
}
