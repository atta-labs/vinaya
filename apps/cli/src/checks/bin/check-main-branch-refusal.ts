#!/usr/bin/env bun

/**
 * Core check: main-branch-refusal. Thin adapter over `@attalabs/aeg-core`'s
 * `checkMainBranchRefusal` — mechanizes the
 * worktree-plus-PR rule at ring 0 for adopters: refuses a commit or push
 * whose current branch IS the repo's default branch. Today this is
 * enforced only by attalabs' hand-written husky shell (which `init` never
 * generates) and detected post-merge by `audit --only=direct-push`
 * (`direct-main-push.ts`, unrelated and untouched — that predicate stays as
 * defense in depth for the case a direct push slips past this one anyway,
 * e.g. an adopter who never ran `init`).
 *
 * Local-only, no network: both facts come from `git` alone.
 *   - current branch: `symbolic-ref --quiet --short HEAD` — empty/failing
 *     on detached HEAD (every CI checkout), never a false name.
 *   - default branch: `symbolic-ref --quiet --short refs/remotes/origin/HEAD`
 *     stripped of its `origin/` prefix — the local ref a `git clone` sets
 *     automatically and `git remote set-head origin -a` (re)computes; no
 *     forge CLI or network call, so this stays evaluable with zero network
 *     and zero token, same constraint as `workspace-escape`'s `env: {}`.
 *
 * Real failure (`error`, exit 1) on a genuine refusal — this is an action
 * refusal, not a doctrine-parity report; warn-only would be the check
 * refusing to do its one job. It cannot redden existing CI: CI always runs
 * on a detached HEAD, which this predicate never refuses.
 *
 * `VINAYA_PUSH_REFS`: the generated `pre-push` hook reads
 * git's own pre-push stdin (`<local ref> <local sha> <remote ref> <remote
 * sha>` per line) into this env var before running `check --all --local`
 * — see `prePushBody` in `apps/cli/src/lib/artifacts.ts`. When set, it
 * lets the predicate tell a tag-only push (`git push origin --tags`) apart
 * from a push that also carries a branch ref; unset (a commit, via
 * `--diff-only`, or a bare `check` invocation) it behaves exactly as
 * before.
 */

import { execFileSync } from 'node:child_process'
import { checkMainBranchRefusal } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'main-branch-refusal'

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function currentSymbolicBranch(): string | null {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return branch === '' ? null : branch
}

/** `refs/remotes/origin/HEAD` resolves to e.g. `origin/main` — strip the leading `origin/` segment. `null` when the ref doesn't exist (never fetched, or a remote other than `origin`). */
function defaultBranch(): string | null {
  const ref = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (ref === null || ref === '') return null
  const branch = ref.slice('origin/'.length)
  return branch === '' ? null : branch
}

function main(): void {
  const currentSymbolicBranchName = currentSymbolicBranch()
  const defaultBranchName = defaultBranch()
  const pushRefs = process.env.VINAYA_PUSH_REFS ?? null

  const finding = checkMainBranchRefusal({
    currentSymbolicBranch: currentSymbolicBranchName,
    defaultBranch: defaultBranchName,
    pushRefs
  })

  if (finding === null) {
    console.log(`${CHECK_NAME}: pass (branch: ${currentSymbolicBranchName ?? '(detached)'})`)
    if (pushRefs !== null && currentSymbolicBranchName !== null && currentSymbolicBranchName === defaultBranchName) {
      console.log(
        `${CHECK_NAME}: tag-only push — no refs/heads/* ref in this push, allowing it from the default branch`
      )
    }
    process.exit(0)
  }

  if (finding.reason === 'on-default-branch') {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `main-branch-refusal: HEAD is on \`${finding.defaultBranch}\`, this repo's default branch — work belongs in a worktree on its own branch, not committed directly here.`,
      agent_recovery_prompt: `Move this work to a worktree instead of committing on \`${finding.defaultBranch}\`: \`git worktree add .worktrees/task/<tranche>/<n> -b task/<tranche>/<n> --no-track origin/${finding.defaultBranch}\`, \`cd\` into it, run \`git config push.autoSetupRemote true\`, and redo the change there.`
    })
    process.exit(1)
  }

  // default-branch-undetermined: fail open, report-only — never a false refusal.
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: CHECK_NAME,
    severity: 'warning',
    message:
      "main-branch-refusal: could not determine this repo's default branch (no resolvable `origin/HEAD`) — skipping the refusal check rather than risk a false block.",
    agent_recovery_prompt:
      'Run `git remote set-head origin -a` (requires network) so `origin/HEAD` resolves locally, then re-run `vinaya check main-branch-refusal`.'
  })
  process.exit(0)
}

main()
