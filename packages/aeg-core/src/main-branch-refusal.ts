/**
 * Ring-0 main-branch refusal (task 9, Issue #58). Mechanizes the
 * worktree-plus-PR rule at ring 0 for adopters: refuses a commit or push
 * whose current branch IS the repo's default branch — today enforced only
 * by attalabs' hand-written husky shell (which `init` never generates) and
 * detected post-merge by `audit --only=direct-push`. Pure — no `git`/`fs`
 * I/O; the caller derives both branch facts and passes them in, same
 * discipline as `no-disk-state.ts`.
 *
 * The discriminator that makes this safe: refusal keys on the SYMBOLIC
 * current branch equaling the default branch. A detached HEAD (every CI
 * checkout, or a deliberate `git checkout --detach`) has no symbolic branch
 * name at all — `currentSymbolicBranch` is `null` — and always passes,
 * never refused. Any branch other than the default passes too. Only a
 * real, named local branch that literal-matches the default branch name
 * refuses. A plain `vinaya check --all` run while parked on the default
 * branch locally WILL refuse — that is the intended behavior (work belongs
 * in worktrees), not a bug.
 *
 * `defaultBranch: null` means the caller could not derive the default
 * branch (no resolvable `origin/HEAD`, no forge answer) — this predicate
 * fails OPEN with a `warning` finding naming why, never a false refusal: a
 * check whose job is refusing risky actions must not itself risk refusing
 * a legitimate one it cannot actually evaluate.
 */

export type MainBranchRefusalReason = 'on-default-branch' | 'default-branch-undetermined'

export type MainBranchRefusalFinding = {
  reason: MainBranchRefusalReason
  severity: 'error' | 'warning'
  currentBranch: string
  defaultBranch: string | null
}

export function checkMainBranchRefusal(facts: {
  currentSymbolicBranch: string | null
  defaultBranch: string | null
}): MainBranchRefusalFinding | null {
  const { currentSymbolicBranch, defaultBranch } = facts

  // Detached HEAD — no symbolic branch to compare. Never refuse.
  if (currentSymbolicBranch === null) return null

  if (defaultBranch === null) {
    return {
      reason: 'default-branch-undetermined',
      severity: 'warning',
      currentBranch: currentSymbolicBranch,
      defaultBranch: null
    }
  }

  if (currentSymbolicBranch === defaultBranch) {
    return {
      reason: 'on-default-branch',
      severity: 'error',
      currentBranch: currentSymbolicBranch,
      defaultBranch
    }
  }

  return null
}
