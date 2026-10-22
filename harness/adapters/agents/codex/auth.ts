import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The operator's Codex subscription login: `$CODEX_HOME/auth.json` when CODEX_HOME is set, else `~/.codex/auth.json`. */
export function operatorCodexAuthPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): string {
  return join(env.CODEX_HOME || join(home, '.codex'), 'auth.json')
}

/**
 * Copies the operator's Codex subscription login into `codexHome`, the
 * generated directory an agent's CODEX_HOME names, as `auth.json` with mode
 * 0600. It is a copy, never a symlink, so nothing the agent writes reaches the
 * operator's own login. With no login to copy it throws, naming the path;
 * there is no API-key route.
 */
export function stageCodexAuth(
  codexHome: string,
  options: { env?: Readonly<Record<string, string | undefined>>; home?: string } = {}
): string {
  const source = operatorCodexAuthPath(options.env, options.home)
  if (!existsSync(source))
    throw new Error(
      `no Codex subscription login found at ${source}. Sign in as the operator with \`codex login\`, then run again (an API key is never used).`
    )
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  // An existing directory keeps its mode under mkdirSync; the login copy's home is owner-only either way.
  chmodSync(codexHome, 0o700)
  const target = join(codexHome, 'auth.json')
  if (target === source) return target
  writeFileSync(target, readFileSync(source), { mode: 0o600 })
  chmodSync(target, 0o600)
  return target
}
