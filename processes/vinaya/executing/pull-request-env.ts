import { execFileSync } from 'node:child_process'
import { worktreeCheckEnv } from '../../../apps/cli/src/lib/dev-review-loop'

/** The open-or-not pull request for a branch, as `gh pr view <branch>` reports it. */
export interface PullRequestView {
  number: number
  body: string
  headRefOid: string
  state: string
}

/** Reads `branch`'s pull request from the forge; throws when there is none. */
export function ghPullRequestView(branch: string): PullRequestView {
  const out = execFileSync('gh', ['pr', 'view', branch, '--json', 'number,body,headRefOid,state'], { encoding: 'utf8' })
  return JSON.parse(out) as PullRequestView
}

/**
 * The pull-request environment the PR-body checks read, exactly as CI gives
 * `check --all`: the branch, plus the number, live body and head once an open
 * pull request exists. No pull request, a closed one or a failed read gives
 * the branch alone.
 */
export function pullRequestCheckEnv(
  branch: string,
  read: (branch: string) => PullRequestView = ghPullRequestView
): Record<string, string> {
  try {
    const pr = read(branch)
    if (pr.state !== 'OPEN') return worktreeCheckEnv({ branch, prNumber: null, body: null })
    return worktreeCheckEnv({ branch, prNumber: pr.number, body: pr.body, head: pr.headRefOid })
  } catch {
    return worktreeCheckEnv({ branch, prNumber: null, body: null })
  }
}
