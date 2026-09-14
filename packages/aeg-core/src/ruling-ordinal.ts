/**
 * The newest principal-authored ruling ordinal on a pull request
 * (`review-validity-v1` task 3, `#477`). One implementation, shared by
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
 * identical reason). `control-store-v1` task 6 (`#556`, O2)'s own need: an
 * authenticated resolution record's `authenticatedBy` field names WHO
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
