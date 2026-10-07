/**
 * `dev-review-loop`'s developer-publication concern — the pure gate logic the
 * driver's own publishing tools run before they touch the forge, so no
 * dispatched Developer ever holds a forge credential or writes to `.git`
 * itself (the task's whole point; see `apps/cli/specs/loop.md` § "Publishing
 * each Developer turn"). The Developer publishes by calling the driver-run
 * tools (`publish_changes`, `open_pull_request`, …); these pure checks run
 * inside the driver's tool context (`developer-dev-tools-context.ts`) before
 * the irreducible git/`gh` side effect.
 *
 * Everything here is pure — the commit-header validation and the
 * pre-publication checks — so it is exercised directly by unit tests and by
 * the in-process loop harness, never shelling out. The governed commit, push
 * and pull-request open themselves (the one part that holds a credential) are
 * the driver's own `LoopDeps` closures in `dev-review-loop.ts`, faked
 * wholesale by the harness exactly as `publishRound`/`createTaskWorktree`
 * already are.
 */

import { COMMIT_TYPE_STYLE, COMMIT_TYPES, globCoversPath, type IssueSurface } from '@attalabs/aeg-core'

// --- commit-header validation (O2) ------------------------------------------

export type HeaderValidation = { ok: true; header: string } | { ok: false; reason: string }

/**
 * O2: the header the driver will commit under must be a single
 * `Type(scope): Description` line of at most 72 characters — the SAME
 * `COMMIT_TYPE_STYLE` the `commit-msg` hook enforces (so the driver's own
 * commit can never be refused by that hook for a header this accepted), plus
 * the 72-character ceiling CI's own commit-header check enforces, re-checked
 * here so an over-length header is caught before the commit rather than after
 * the push. A missing (`null`) or empty file, a multi-line body, a
 * non-conforming first line, or an over-length line each return a specific
 * reason — the text sent back to the same Developer session.
 */
export function validateCommitHeader(raw: string | null): HeaderValidation {
  if (raw === null) {
    return { ok: false, reason: '`publish_changes` was called with no commit header' }
  }
  const allLines = raw.split('\n')
  const header = (allLines[0] ?? '').trim()
  if (header.length === 0) {
    return {
      ok: false,
      reason: 'the commit header is empty — pass one `Type(scope): Description` line to `publish_changes`'
    }
  }
  if (allLines.slice(1).some((l) => l.trim().length > 0)) {
    return {
      ok: false,
      reason:
        'the commit header has more than one non-empty line — pass only the single `Type(scope): Description` header line, not a body'
    }
  }
  if (!COMMIT_TYPE_STYLE.test(header)) {
    return {
      ok: false,
      reason: `the commit header "${header}" does not match \`Type(scope): Description\` — Type must be one of ${COMMIT_TYPES.join(', ')}, start-case, then a colon, a space and a sentence-case description`
    }
  }
  if (header.length > 72) {
    return {
      ok: false,
      reason: `the commit header "${header}" is ${header.length} characters — the ceiling is 72; shorten it`
    }
  }
  return { ok: true, header }
}

// --- pre-publication checks (O7) --------------------------------------------

export type PublicationCheckInput = {
  /** `git rev-parse --abbrev-ref HEAD` in the worktree, or `null` when unreadable. */
  worktreeBranch: string | null
  /** The task's own branch — what `worktreeBranch` must equal. */
  expectedBranch: string
  /** The worktree's current `HEAD` sha, or `null` when unreadable. */
  worktreeHead: string | null
  /** The head recorded before this turn was dispatched — what `worktreeHead` must still equal (the Developer committed nothing itself). `null` on a fresh round-1 turn where no head was recorded yet; the head check is then inactive. */
  recordedHead: string | null
  /** The task branch's head on the remote, or `null` when it has none or it is unreadable. Only consulted to recognize the Developer undoing the driver's own unpushed commit. */
  remoteHead?: string | null
  /** The commit the driver's own publication made whose push did not complete, with its parent, or `null` when there is none. */
  driverUnpushedCommit?: { sha: string; parent: string | null } | null
  /** The worktree branch's base (merge base with the default branch), or `null` when unreadable. */
  base: string | null
  /** The base this task was cut from — what `base` must equal. `null` only before a known base has been recorded. */
  expectedBase: string | null
  /** Every path the turn changed, relative to the repo root. */
  changedPaths: readonly string[]
  /** The task Issue's own `## Surface` globs, or `null` when none could be resolved; the Surface check is then inactive. */
  surface: IssueSurface | null
}

/**
 * True when the head moved back to the task branch's remote head and the
 * recorded head is the driver's own unpushed commit sitting directly on that
 * remote head — the Developer undid the driver's commit (changes kept
 * uncommitted), which loses no work. Any other moved head is not this case.
 */
function undidDriverUnpushedCommit(input: PublicationCheckInput): boolean {
  const commit = input.driverUnpushedCommit
  const remoteHead = input.remoteHead ?? null
  return (
    commit != null &&
    remoteHead !== null &&
    input.worktreeHead === remoteHead &&
    input.recordedHead === commit.sha &&
    commit.parent === remoteHead
  )
}

/**
 * O7: run before the driver commits or uses its GitHub credential — the
 * worktree must be on the task branch, its base the expected base, its head
 * the head recorded before the turn (the Developer left its work
 * uncommitted), and every changed path inside the task's Surface `in:` globs
 * and outside its `out:` globs. The first failing check names itself; the
 * caller sends that text back to the same Developer session and commits and
 * pushes nothing. Pure — the caller resolves every input.
 */
export function checkPublicationPreconditions(
  input: PublicationCheckInput
): { ok: true } | { ok: false; reason: string } {
  if (input.worktreeBranch === null) {
    return { ok: false, reason: `could not read the worktree's current branch — expected \`${input.expectedBranch}\`` }
  }
  if (input.worktreeBranch !== input.expectedBranch) {
    return {
      ok: false,
      reason: `the worktree is on branch \`${input.worktreeBranch}\`, not the task branch \`${input.expectedBranch}\` — refusing to commit or publish from the wrong branch`
    }
  }
  if (input.base === null) {
    return { ok: false, reason: 'could not read the worktree branch base — refusing to publish without the base check' }
  }
  if (input.expectedBase !== null && input.base !== input.expectedBase) {
    return {
      ok: false,
      reason: `the worktree branch's base is \`${input.base}\`, not the expected base \`${input.expectedBase}\` — rebase onto the base this task was cut from before leaving changes to publish`
    }
  }
  if (
    input.recordedHead !== null &&
    input.worktreeHead !== null &&
    input.worktreeHead !== input.recordedHead &&
    !undidDriverUnpushedCommit(input)
  ) {
    return {
      ok: false,
      reason: `the worktree head moved to \`${input.worktreeHead}\` during your turn (expected the recorded \`${input.recordedHead}\`) — do not commit yourself; call \`publish_changes\` to make this turn's single commit`
    }
  }
  if (input.surface) {
    const inGlobs = input.surface.in
    const outGlobs = input.surface.out
    for (const path of input.changedPaths) {
      if (outGlobs.some((g) => globCoversPath(g, path))) {
        return {
          ok: false,
          reason: `changed path \`${path}\` is outside the task's Surface — it crosses an \`out:\` glob; revert it before leaving changes to publish`
        }
      }
      if (inGlobs.length > 0 && !inGlobs.some((g) => globCoversPath(g, path))) {
        return {
          ok: false,
          reason: `changed path \`${path}\` is outside the task's Surface — it matches no \`in:\` glob; revert it before leaving changes to publish`
        }
      }
    }
  }
  return { ok: true }
}
