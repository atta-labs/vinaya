import { extractIssue, isIssueNotFoundError, resolveNewestFrozenBrief } from '@attalabs/aeg-core'
import { isForgeReadOversize } from '../lib/forge-read'

/** One task Issue comment, as the CI-side checks read it. */
export type IssueComment = { body: string; author?: { login?: string } | null }

/**
 * A task branch's frozen brief, resolved from its pull request body. On a
 * failure `notFound` says whether the Issue itself did not resolve — a
 * check decides for itself whether that exempts it; every other failure
 * means the brief could not be read.
 */
export type FrozenBriefResolution = { ok: true; content: string } | { ok: false; notFound: boolean; message: string }

/**
 * The task Issue's newest frozen `aeg:brief:v<k>` comment — the Issue named
 * by the body's `Closes #N`, its comments read through `fetchComments`, the
 * newest principal-authored version picked by `@attalabs/aeg-core`'s
 * `resolveNewestFrozenBrief`, the same single resolver the review loop uses,
 * so a supersession is picked up here too. `purpose` finishes the fetch
 * failure's message ("… to <purpose>").
 */
export function resolveTaskFrozenBrief(
  prBody: string,
  fetchComments: (issue: number) => IssueComment[],
  principalAllowlist: () => readonly string[],
  purpose: string
): FrozenBriefResolution {
  const { issue } = extractIssue(prBody)
  if (issue === null) {
    return {
      ok: false,
      notFound: false,
      message: 'not dispatched — no `Closes #N` in the PR body to resolve the task Issue.'
    }
  }

  let comments: IssueComment[]
  try {
    comments = fetchComments(issue)
  } catch (err) {
    if (isForgeReadOversize(err)) return { ok: false, notFound: false, message: err.message }
    return {
      ok: false,
      notFound: isIssueNotFoundError(err),
      message: `could not fetch Issue #${issue}'s comments (\`gh issue view\`) to ${purpose}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const resolved = resolveNewestFrozenBrief(
    comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
    principalAllowlist()
  )
  if (!resolved) {
    return { ok: false, notFound: false, message: `not dispatched — no \`aeg:brief:v<k>\` comment on Issue #${issue}.` }
  }
  return { ok: true, content: resolved.content }
}
