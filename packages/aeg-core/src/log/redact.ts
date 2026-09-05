/**
 * Redacts secrets and the caller's home directory out of a value before it
 * is written to the outbox. Pure: `home` is passed in, never read here (the
 * purity boundary, `apps/cli/specs/surface.md` "The rule" — no
 * `os.homedir()` under `packages/aeg-core/src/log/`).
 *
 * This is the durable, single redaction chokepoint for every family the log
 * will ever carry — today's two (`dispatch`, `dev_review_loop`) are
 * structured enough to limit exploitability, but `gate`/`forge_write`/
 * `command`/`tokens` will carry far more free-text content later, so the
 * pattern set here is deliberately broader than what today's two families
 * alone would need.
 *
 * Walks every string leaf of `value` (objects and arrays recursively;
 * everything else returned as-is) and, in order, rewrites:
 *   1. A GitHub token (`gho_`/`ghp_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_…`).
 *   2. A classic 40-hex GitHub PAT — ONLY when a token-ish keyword precedes
 *      it (`token:`/`PAT=`/…). A bare 40-hex string is indistinguishable
 *      from a git commit sha by shape alone, and this schema's own
 *      `subject.sha`/`meta.doctrine` fields legitimately carry one; blind
 *      matching would redact those. The keyword anchor is what gives real
 *      coverage without that collision.
 *   3. An `Authorization: Bearer <token>` value.
 *   4. An AWS access key ID (`AKIA…`).
 *   5. A Slack token (`xox[baprs]-…`).
 *   6. A Stripe key (`sk_live_…`/`pk_live_…`/`rk_live_…`, and their `_test_`
 *      counterparts).
 *   7. An Anthropic key (`sk-ant-…`) or an OpenAI-shaped key (`sk-…`).
 *   8. An npm token (`npm_…`).
 *   9. A JWT (`eyJ…`.`…`.`…`).
 *  10. A PEM private-key block, header to footer.
 *  11. Basic-auth credentials embedded in a URL (`https://user:pass@host`).
 *  12. A generic `secret=`/`password=`/`api_key=`/… assignment — the same
 *      keyword-anchor approach as (2), extended to any secret-shaped field
 *      with no fixed-prefix format of its own.
 *  13. An absolute path under `home` → `~/…`.
 */

const GITHUB_TOKEN_PATTERN = /\b(?:gho_|ghp_|ghs_|ghu_|ghr_|github_pat_)[A-Za-z0-9_]+\b/g
const CLASSIC_GITHUB_PAT_PATTERN = /\b((?:token|GITHUB_TOKEN|PAT|api[_-]?key|api[_-]?token)\s*[:=]\s*)[a-f0-9]{40}\b/gi
const BEARER_TOKEN_PATTERN = /\bBearer\s+\S+/g
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[0-9A-Za-z-]+\b/g
const STRIPE_KEY_PATTERN = /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}\b/g
const ANTHROPIC_KEY_PATTERN = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g
const OPENAI_KEY_PATTERN = /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g
const NPM_TOKEN_PATTERN = /\bnpm_[A-Za-z0-9]{36}\b/g
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const PEM_BLOCK_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const BASIC_AUTH_URL_PATTERN = /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g
const GENERIC_SECRET_ASSIGNMENT_PATTERN =
  /\b((?:secret|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*)[A-Za-z0-9+/_=-]{16,}\b/gi

function redactString(value: string, home: string): string {
  let out = value
    .replace(GITHUB_TOKEN_PATTERN, '<redacted>')
    .replace(CLASSIC_GITHUB_PAT_PATTERN, '$1<redacted>')
    .replace(BEARER_TOKEN_PATTERN, '<redacted>')
    .replace(AWS_ACCESS_KEY_PATTERN, '<redacted>')
    .replace(SLACK_TOKEN_PATTERN, '<redacted>')
    .replace(STRIPE_KEY_PATTERN, '<redacted>')
    .replace(ANTHROPIC_KEY_PATTERN, '<redacted>')
    .replace(OPENAI_KEY_PATTERN, '<redacted>')
    .replace(NPM_TOKEN_PATTERN, '<redacted>')
    .replace(JWT_PATTERN, '<redacted>')
    .replace(PEM_BLOCK_PATTERN, '<redacted>')
    .replace(BASIC_AUTH_URL_PATTERN, '$1<redacted>@')
    .replace(GENERIC_SECRET_ASSIGNMENT_PATTERN, '$1<redacted>')
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
