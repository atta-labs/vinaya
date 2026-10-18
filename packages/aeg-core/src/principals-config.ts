import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The fix a refusal names: the one config edit that makes the scripts runnable. */
export const PRINCIPALS_CONFIG_FIX = 'add "principals": [...] to vinaya.config.json'

export type ConfigPrincipalsResult = { ok: true; principals: string[] } | { ok: false; reason: string }

/**
 * `vinaya.config.json`'s `principals` — the logins every aeg-core script
 * counts as a Principal — read as plain JSON beside its precedent
 * `readConfigObjectivesSinceIssue`, because aeg-core cannot depend on
 * `apps/cli`'s zod configuration loader. This is the only place the aeg-core
 * scripts read the key.
 *
 * Never a default: an unreadable file, a file that is not JSON, a missing
 * key, or a value that is not a non-empty array of strings is a refusal whose
 * reason names the fix. An empty list is a misconfiguration (the application's
 * schema requires at least one entry), not "trust nobody". The read is of the
 * working tree, unlike the application's trust-anchored default-branch read.
 * `repoRoot` defaults to the current working directory; a caller that has not
 * `chdir`'d to the repo root passes it explicitly.
 */
export function readConfigPrincipals(repoRoot = '.'): ConfigPrincipalsResult {
  const path = join(repoRoot, 'vinaya.config.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `cannot read ${path} as JSON (${why}) — ${PRINCIPALS_CONFIG_FIX}` }
  }
  const value = raw !== null && typeof raw === 'object' ? (raw as { principals?: unknown }).principals : undefined
  if (value === undefined) {
    return { ok: false, reason: `${path} declares no Principal list — ${PRINCIPALS_CONFIG_FIX}` }
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((p) => typeof p === 'string' && p.length > 0)) {
    return {
      ok: false,
      reason: `${path}'s "principals" must be a non-empty array of login strings — ${PRINCIPALS_CONFIG_FIX}`
    }
  }
  return { ok: true, principals: value as string[] }
}
