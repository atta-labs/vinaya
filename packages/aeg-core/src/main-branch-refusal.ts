/**
 * Ring-0 main-branch refusal. Mechanizes the
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
 *
 * `pushRefs` carries git's pre-push stdin — one line per
 * ref being pushed, `<local ref> <local sha> <remote ref> <remote sha>` —
 * newline-joined, exactly as `VINAYA_PUSH_REFS` carries it. `null` means no
 * push is in flight at all (a commit, via `check --all --diff-only
 * --local`): the default-branch refusal still applies, unchanged. A push
 * whose ref list is present but names only `refs/tags/*` remote refs — a
 * tag-only push, e.g. `git push origin --tags` after a release — is not the
 * "committed directly on the default branch" case this predicate exists to
 * catch, so it passes even from the default branch. Any `refs/heads/*`
 * remote ref in the list still refuses, same as the no-`pushRefs` case.
 */

export type MainBranchRefusalReason = 'on-default-branch' | 'default-branch-undetermined'

export type MainBranchRefusalFinding = {
  reason: MainBranchRefusalReason
  severity: 'error' | 'warning'
  currentBranch: string
  defaultBranch: string | null
}

function pushesAnyBranchRef(pushRefs: string): boolean {
  return pushRefs
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .some((line) => line.split(/\s+/)[2]?.startsWith('refs/heads/') === true)
}

export function checkMainBranchRefusal(facts: {
  currentSymbolicBranch: string | null
  defaultBranch: string | null
  pushRefs?: string | null
}): MainBranchRefusalFinding | null {
  const { currentSymbolicBranch, defaultBranch, pushRefs = null } = facts

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
    // A tag-only push carries a ref list with no `refs/heads/*` remote ref —
    // pass. No ref list at all means this isn't a push (a commit), or a
    // push containing a branch ref — refuse either way.
    if (pushRefs !== null && !pushesAnyBranchRef(pushRefs)) return null

    return {
      reason: 'on-default-branch',
      severity: 'error',
      currentBranch: currentSymbolicBranch,
      defaultBranch
    }
  }

  return null
}
