/**
 * Redacts secrets and the caller's home directory out of a value before it
 * is written to the outbox. Pure: `home` is passed in, never read here (the
 * purity boundary, `apps/cli/specs/surface.md` "The rule" — no
 * `os.homedir()` under `packages/aeg-core/src/log/`).
 *
 * Walks every string leaf of `value` (objects and arrays recursively;
 * everything else returned as-is) and rewrites, in this order:
 *   1. A GitHub token (`gho_…`, `ghp_…`, `github_pat_…`) → `<redacted>`.
 *   2. An `Authorization: Bearer <token>` value → the same `<redacted>`.
 *   3. An absolute path under `home` → `~/…`.
 */

const GITHUB_TOKEN_PATTERN = /\b(?:gho_|ghp_|github_pat_)[A-Za-z0-9_]+\b/g
const BEARER_TOKEN_PATTERN = /\bBearer\s+\S+/g

function redactString(value: string, home: string): string {
  let out = value.replace(GITHUB_TOKEN_PATTERN, '<redacted>').replace(BEARER_TOKEN_PATTERN, '<redacted>')
  if (home.length > 0 && out.startsWith(home)) {
    const rest = out.slice(home.length)
    if (rest === '' || rest.startsWith('/')) out = `~${rest}`
  }
  return out
}

export function redact<T>(value: T, home: string): T {
  if (typeof value === 'string') return redactString(value, home) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redact(v, home)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, home)
    }
    return out as unknown as T
  }
  return value
}
