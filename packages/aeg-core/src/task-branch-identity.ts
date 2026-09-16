/**
 * Task-branch identity. A developer branch names
 * its task one of two ways: `task/<tranche>/<n>`, keyed to a tranche
 * topology row, or `task/issue-<n>`, keyed directly to a backlog Issue that
 * carries no tranche at all. This is the one parser for both shapes — every
 * check that resolves a task's identity off its branch name (`closes-n`,
 * `surface-scope`, `dispatch-readiness`) reads through this, rather than
 * carrying its own two-segment regex.
 *
 * Deliberately NOT the same export as `first-push-dispatch-gate.ts`'s
 * `parseTaskBranch` — that function (and its flat `{tranche, taskId}` return
 * shape) is shared by `first-push-dispatch`/`issue-assignment`/
 * `assign-task-issue`, none of which are in this task's Surface or Boundary;
 * widening its return type would ripple into checks this task has no brief
 * coverage for. This module is the new, additional shape-parser named in the
 * Traps to avoid: "`task/issue-<n>` is its own shape, parsed by one function
 * next to `task/<tranche>/<n>`."
 */

export type TaskBranchIdentity =
  | { readonly kind: 'tranche'; readonly tranche: string; readonly taskId: string }
  | { readonly kind: 'issue'; readonly issueNumber: number }

const ISSUE_BRANCH_PATTERN = /^task\/issue-(\d+)$/
const TRANCHE_BRANCH_PATTERN = /^task\/([^/]+)\/([^/]+)$/

export function parseTaskBranchIdentity(branch: string): TaskBranchIdentity | null {
  const issueMatch = ISSUE_BRANCH_PATTERN.exec(branch)
  if (issueMatch) return { kind: 'issue', issueNumber: Number(issueMatch[1]) }
  const trancheMatch = TRANCHE_BRANCH_PATTERN.exec(branch)
  if (trancheMatch) return { kind: 'tranche', tranche: trancheMatch[1] as string, taskId: trancheMatch[2] as string }
  return null
}

/** `task/issue-<n>` — the branch shape for a backlog Issue with no tranche. */
export function issueBranchName(issueNumber: number): string {
  return `task/issue-${issueNumber}`
}
