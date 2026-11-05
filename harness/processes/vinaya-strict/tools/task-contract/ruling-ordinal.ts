/**
 * The newest principal-authored ruling ordinal on a pull request.
 * One implementation, shared by
 * every caller that needs it — `apps/cli/src/lib/dev-review-loop.ts` (the
 * loop's own `fetchRulings`, which this duplicates the marker regex for,
 * predates this package's involvement and stays local; this is the
 * NEW shared logic `check-review-gate.ts` and `review-post.ts` both need
 * and had no prior copy of), so the marker's parsing never drifts between
 * the gate and the hand-cast command the way `verdict-extraction.ts`'s own
 * module comment warns a duplicated pattern eventually would.
 *
 * Pure — no `fs`, no `fetch`. Every caller resolves the PR's comments via
 * `gh` itself and passes them in.
 */

import { isPrincipal } from './waiver-label'

/** The marker `apps/cli/src/commands/pr-rule.ts` posts: `<!-- aeg:principal:ruling:<pr>-<k> -->`, one line, nothing else on it. */
const RULING_MARKER_ORDINAL = /^<!-- aeg:principal:ruling:\d+-(\d+) -->$/

/**
 * The marker line a principal ruling carries, built from the two numbers it
 * encodes — `<ref>-<ordinal>`, where `ref` is the pull request or Issue the
 * ruling is about and `ordinal` is the strictly-increasing `k` every reader
 * here compares. It lives beside `RULING_MARKER_ORDINAL` because the two
 * cannot be allowed to disagree about which slot the ordinal sits in: a
 * renderer that swapped them emitted a marker that parsed as ordinal `1`
 * forever, so a ruling written exactly as instructed failed the very
 * freshness gate it was posted to satisfy. Any caller that WRITES a marker a
 * reader here will parse should build it with this rather than by
 * interpolating its own template.
 */
export function principalRulingMarker(ref: number, ordinal: number): string {
  return `<!-- aeg:principal:ruling:${ref}-${ordinal} -->`
}

export type RulingComment = {
  body: string
  /** The comment author's GitHub login, or `null` when the caller could not resolve one. */
  author: string | null
}

/**
 * `0` when no principal-authored ruling comment matches — never `null`: a
 * PR's ruling count is always a well-defined fact, unlike an objectives
 * list that can be genuinely unresolvable pre-cutover. `k` is read from the
 * marker's own `<pr>-<k>` and compared numerically, never by string/lexical
 * order or by comment timestamp — the ruling command assigns `k` strictly
 * increasing, so the highest `k` among principal-authored matches is always
 * the newest ruling, regardless of the comments array's own order.
 */
export function newestPrincipalRulingOrdinal(comments: readonly RulingComment[], allowlist: readonly string[]): number {
  let best = 0
  for (const c of comments) {
    if (!isPrincipal(c.author, allowlist as string[])) continue
    const firstLine = (c.body.split('\n')[0] ?? '').trim()
    const m = RULING_MARKER_ORDINAL.exec(firstLine)
    if (!m) continue
    const k = Number.parseInt(m[1] as string, 10)
    if (k > best) best = k
  }
  return best
}

/**
 * The AUTHOR of the newest principal-authored ruling comment — `null` when
 * none matches (`newestPrincipalRulingOrdinal` returning `0` for the
 * identical reason). An authenticated resolution record's own need (O2): its
 * `authenticatedBy` field names WHO
 * authorized a `--resume`/`--cancel`, not just that an authorization
 * existed. Same scan, same ordinal-wins rule, so the two functions can never
 * disagree about which ruling is newest.
 */
export function newestPrincipalRulingAuthor(
  comments: readonly RulingComment[],
  allowlist: readonly string[]
): string | null {
  let best = 0
  let bestAuthor: string | null = null
  for (const c of comments) {
    if (!isPrincipal(c.author, allowlist as string[])) continue
    const firstLine = (c.body.split('\n')[0] ?? '').trim()
    const m = RULING_MARKER_ORDINAL.exec(firstLine)
    if (!m) continue
    const k = Number.parseInt(m[1] as string, 10)
    if (k > best) {
      best = k
      bestAuthor = c.author
    }
  }
  return bestAuthor
}

/**
 * Where a ruling identity points. A resolution record names the ruling that
 * authenticated it as `<pr>-<k>` for a ruling on a pull request, or
 * `issue-<n>-<k>` for a ruling on the task Issue; either way the ruling
 * comment itself carries the marker `<ref>-<k>`. Any other value — a
 * self-recovery tag, or a superseding-brief reference — names no ruling, and
 * reads `null`.
 */
export function parseRulingIdentity(rulingId: string): { target: 'pr' | 'issue'; ref: number; ordinal: number } | null {
  const m = /^(issue-)?(\d+)-(\d+)$/.exec(rulingId)
  if (!m) return null
  const ref = Number.parseInt(m[2] as string, 10)
  const ordinal = Number.parseInt(m[3] as string, 10)
  if (ref <= 0 || ordinal <= 0) return null
  return { target: m[1] ? 'issue' : 'pr', ref, ordinal }
}

/**
 * The text of the ONE principal-authored ruling a ruling identity names — the
 * comment body after its marker line, trimmed, the same text every ruling
 * reader hands a Developer. The caller passes the comments of the pull
 * request or Issue the identity names; the identity's ordinal is matched
 * against each marker's ordinal, exactly the number the resume read when it
 * minted that identity (`newestPrincipalRulingOrdinal` reads the ordinal
 * alone). Never chosen by position, by newest ordinal, or by being the only
 * ruling present: `null` when no principal comment carries that ordinal, or
 * when more than one does (an ambiguous identity is not an identity).
 */
export function principalRulingTextById(
  comments: readonly RulingComment[],
  allowlist: readonly string[],
  rulingId: string
): string | null {
  const identity = parseRulingIdentity(rulingId)
  if (identity === null) return null
  const matches = comments.filter((c) => {
    if (!isPrincipal(c.author, allowlist as string[])) return false
    const m = RULING_MARKER_ORDINAL.exec((c.body.split('\n')[0] ?? '').trim())
    return m !== null && Number.parseInt(m[1] as string, 10) === identity.ordinal
  })
  if (matches.length !== 1) return null
  const body = (matches[0] as RulingComment).body
  const idx = body.indexOf('\n')
  return idx === -1 ? '' : body.slice(idx + 1).trim()
}
