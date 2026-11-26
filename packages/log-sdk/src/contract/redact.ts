/**
 * Redacts secrets and the caller's home directory before a value is written,
 * sent or read. Self-contained so the sender's large-line worker can run it.
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
 *  13. The whole home directory at a path boundary → `~`, including within text.
 */
export function redact<T>(value: T, home: string): T {
  if (typeof value === 'string') {
    let out = value
      .replace(/\b(?:gho_|ghp_|ghs_|ghu_|ghr_|github_pat_)[A-Za-z0-9_]+\b/g, '<redacted>')
      .replace(/\b((?:token|GITHUB_TOKEN|PAT|api[_-]?key|api[_-]?token)\s*[:=]\s*)[a-f0-9]{40}\b/gi, '$1<redacted>')
      .replace(/\bBearer\s+\S+/g, '<redacted>')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>')
      .replace(/\bxox[baprs]-[0-9A-Za-z-]+\b/g, '<redacted>')
      .replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, '<redacted>')
      .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '<redacted>')
      .replace(/\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/g, '<redacted>')
      .replace(/\bnpm_[A-Za-z0-9]{36}\b/g, '<redacted>')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<redacted>')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted>')
      .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1<redacted>@')
      .replace(
        /\b((?:secret|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*)[A-Za-z0-9+/_=-]{16,}\b/gi,
        '$1<redacted>'
      )
    if (home.length > 0 && out.includes(home)) {
      const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const path = new RegExp(String.raw`(^|[\s"'=:(])${escaped}(?=$|[/\\\s"')])`, 'g')
      out = out.replace(path, '$1~')
    }
    return out as unknown as T
  }
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
