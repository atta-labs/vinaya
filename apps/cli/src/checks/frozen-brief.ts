import {
  extractIssue,
  isIssueNotFoundError,
  isTaskBranch,
  type LiveGateInputs,
  parseLiveTestPlanItems,
  resolveNewestFrozenBrief
} from '@attalabs/aeg-core'
import { PrincipalsUnresolvedError, resolveTrustedPrincipals } from '../lib/config'
import { isForgeReadOversize, readIssueComments } from '../lib/forge-read'
import { incompleteForgeSnapshot } from '../lib/forge-snapshot'

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
      message: `could not fetch Issue #${issue}'s comments to ${purpose}: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  // Which comment is the frozen brief is a trust decision: with no Principal
  // list the default branch can vouch for — not configured, or the read
  // failed — the brief cannot be resolved, and the refusal's message, naming
  // the fix or the reason, is the failure.
  let allowlist: readonly string[]
  try {
    allowlist = principalAllowlist()
  } catch (err) {
    if (!(err instanceof PrincipalsUnresolvedError)) throw err
    return { ok: false, notFound: false, message: err.message }
  }
  const resolved = resolveNewestFrozenBrief(
    comments.map((c) => ({ body: c.body, author: c.author?.login ?? null })),
    allowlist
  )
  if (!resolved) {
    return { ok: false, notFound: false, message: `not dispatched — no \`aeg:brief:v<k>\` comment on Issue #${issue}.` }
  }
  return { ok: true, content: resolved.content }
}

/** What a Test Plan check reads: the PR body, its branch, and the pull request's head SHA (`PULL_REQUEST_HEAD_SHA`). */
export type LiveCheckInputs = { body: string; branch: string; head: string }

/**
 * The forge reads behind the frozen-brief resolution — injected so a test can
 * make one throw. In CI the default comment read is served from the run's
 * forge snapshot for the task Issue (`readIssueComments` routes there).
 */
export type LiveCheckDeps = {
  fetchIssueComments: (issue: number) => IssueComment[]
  principalAllowlist: () => readonly string[]
}

export const defaultLiveCheckDeps: LiveCheckDeps = {
  fetchIssueComments: (issue) => readIssueComments(issue, `Issue #${issue}`),
  principalAllowlist: () => resolveTrustedPrincipals()
}

/**
 * The `[live]` inputs a Test Plan check hands `evaluateTestPlanGate`, or why
 * they cannot be learned. `live` is `undefined` — the body is graded alone,
 * as before — on a non-task branch, and on a task branch with no body and no
 * pull request head (a local run before any pull request exists). A task
 * branch with a pull request head but no body, or whose frozen brief cannot
 * be resolved — any fetch error, a not-found Issue included — fails: the
 * lines the merge must wait for are then unknown. So does an incomplete
 * forge snapshot, on any branch.
 */
export function resolveLiveCheckInputs(
  inputs: LiveCheckInputs,
  deps: LiveCheckDeps = defaultLiveCheckDeps
): { ok: true; live: LiveGateInputs | undefined } | { ok: false; message: string } {
  const { body, branch, head } = inputs
  // Given an incomplete forge snapshot the check fails, on any branch, before
  // a read could fall back to the forge or a missing file could pass.
  const incomplete = incompleteForgeSnapshot()
  if (incomplete !== null) return { ok: false, message: incomplete }
  if (!isTaskBranch(branch)) return { ok: true, live: undefined }
  if (!body) {
    return head
      ? { ok: false, message: `no pull request body was supplied for the pull request at \`${head}\`.` }
      : { ok: true, live: undefined }
  }
  const brief = resolveTaskFrozenBrief(
    body,
    deps.fetchIssueComments,
    deps.principalAllowlist,
    "learn its frozen brief's `[live]` lines"
  )
  if (!brief.ok) return { ok: false, message: brief.message }
  return { ok: true, live: { liveCommands: parseLiveTestPlanItems(brief.content), head } }
}
