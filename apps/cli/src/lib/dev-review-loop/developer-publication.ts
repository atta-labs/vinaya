/**
 * `dev-review-loop`'s developer-publication concern — the pure logic the
 * driver runs right after every Developer turn to commit, push and open the
 * pull request the turn left behind, so no dispatched Developer ever holds a
 * forge credential or writes to `.git` itself (the task's whole point; see
 * `apps/cli/specs/loop.md` § "Publishing each Developer turn").
 *
 * Everything here is pure — header validation, the pre-publication checks,
 * the durable publication record's read/write — so it is exercised directly
 * by unit tests and by the in-process loop harness, never shelling out. The
 * governed push and pull-request open themselves (the one part that holds a
 * credential) are the driver's own `LoopDeps` closures in
 * `dev-review-loop.ts`, faked wholesale by the harness exactly as
 * `publishRound`/`createRemoteTaskBranch` already are.
 */

import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { COMMIT_TYPE_STYLE, COMMIT_TYPES, globCoversPath, type IssueSurface } from '@attalabs/aeg-core'
import { ensureRunDir, runPath } from '../run-paths.js'
import { readIfExists } from './reviewer-dispatch.js'

/**
 * The Developer writes its one-line commit header here, in the round's own
 * Developer folder beside the confidence file (`CONFIDENCE_FILE_NAME`), never
 * at the worktree root — a control-file name at the worktree root gets no
 * Surface exemption, so a header file there would read as an out-of-Surface
 * change. The driver reads it, validates it, and commits the turn's work
 * under it (O2).
 */
export const COMMIT_HEADER_FILE_NAME = '.vinaya-commit-header'

/**
 * The Developer writes its pull-request body here, the same way and in the
 * same place as the commit header — read by the driver only when it opens the
 * pull request (O3: round 1, or a crash-recovery open), never on a later
 * fix-push round that opens nothing.
 */
export const PR_BODY_FILE_NAME = '.vinaya-pr-body'

/** Appended to a Developer dispatch's prompt — the commit-header counterpart to `confidencePromptLine`. `filePath` is this round's own absolute path, granted to the session as a `developerFiles` entry. */
export function commitHeaderPromptLine(filePath: string): string {
  return `Leave all your changes UNCOMMITTED. Before ending this turn, write the one-line commit header for this turn's work to a file at the absolute path \`${filePath}\` — exactly \`Type(scope): Description\` (${COMMIT_TYPES.join(', ')} — start-case, an optional lower-case scope in parens, a colon, a space, then a sentence-case description), 72 characters or fewer, no trailing newline needed. The driver commits your uncommitted changes under this header and pushes the branch for you; you never run \`git commit\`, \`git push\` or open the pull request yourself.`
}

/** Appended to a round-1 Developer dispatch's prompt — the pull-request-body counterpart to `commitHeaderPromptLine`. */
export function prBodyPromptLine(filePath: string): string {
  return `Before ending this turn, write the full pull-request body (your Developer PR report — print the template with \`bun apps/cli/src/index.ts doctrine --template pr-report --print\`) to a file at the absolute path \`${filePath}\`. The driver opens the pull request from this file; you never open it yourself.`
}

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
    return {
      ok: false,
      reason: `no commit header file was written at this round's \`${COMMIT_HEADER_FILE_NAME}\` path`
    }
  }
  const allLines = raw.split('\n')
  const header = (allLines[0] ?? '').trim()
  if (header.length === 0) {
    return { ok: false, reason: 'the commit header file is empty — write one `Type(scope): Description` line' }
  }
  if (allLines.slice(1).some((l) => l.trim().length > 0)) {
    return {
      ok: false,
      reason:
        'the commit header file has more than one non-empty line — write only the single `Type(scope): Description` header line, not a body'
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
  /** The worktree branch's base (merge base with the default branch), or `null` when unreadable. */
  base: string | null
  /** The base this task was cut from — what `base` must equal. `null` when the driver could not resolve one; the base check is then inactive. */
  expectedBase: string | null
  /** Every path the turn changed, relative to the repo root. */
  changedPaths: readonly string[]
  /** The task Issue's own `## Surface` globs, or `null` when none could be resolved; the Surface check is then inactive. */
  surface: IssueSurface | null
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
  if (input.expectedBase !== null && input.base !== null && input.base !== input.expectedBase) {
    return {
      ok: false,
      reason: `the worktree branch's base is \`${input.base}\`, not the expected base \`${input.expectedBase}\` — rebase onto the base this task was cut from before leaving changes to publish`
    }
  }
  if (input.recordedHead !== null && input.worktreeHead !== null && input.worktreeHead !== input.recordedHead) {
    return {
      ok: false,
      reason: `the worktree head moved to \`${input.worktreeHead}\` during your turn (expected the recorded \`${input.recordedHead}\`) — leave your changes UNCOMMITTED; the driver makes the single commit for this turn`
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

// --- the durable publication record (O2, O8) --------------------------------

/**
 * One record per task, overwritten by each published turn — the single
 * durable trace a crashed driver reads to finish a publication exactly once
 * (O8). `commitSha` is recorded BEFORE the push, so a crash between the
 * commit and the push reconciles from this record (pushing the recorded
 * commit) rather than committing the same work twice; `pushed` and
 * `prNumber` advance as each later step confirms, so a restart after the push
 * (but before the open) opens the pull request without re-pushing, and a
 * restart after the open does neither.
 */
export type DeveloperPublicationRecord = {
  round: number
  /** The head recorded before the turn — what the commit was made on top of. */
  preTurnHead: string | null
  /** The sha the driver committed this turn, or `null` when the turn produced no commit (an open-only recovery, or a nothing-new turn). */
  commitSha: string | null
  /** True once `branch-push` confirmed the commit reached the remote. */
  pushed: boolean
  /** The pull request this task's publication opened, or `null` before one exists. */
  prNumber: number | null
}

function publicationRecordPath(root: string, task: number): string {
  return runPath(root, task, { area: 'control', file: 'developer-publication.json' })
}

export function readDeveloperPublicationRecord(root: string, task: number): DeveloperPublicationRecord | null {
  const raw = readIfExists(publicationRecordPath(root, task))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DeveloperPublicationRecord
    if (typeof parsed.round !== 'number' || typeof parsed.pushed !== 'boolean') return null
    return parsed
  } catch {
    return null
  }
}

export function writeDeveloperPublicationRecord(root: string, task: number, record: DeveloperPublicationRecord): void {
  const path = publicationRecordPath(root, task)
  ensureRunDir(dirname(path), root)
  writeFileSync(path, JSON.stringify(record), 'utf8')
}

// --- round-file paths -------------------------------------------------------

export function commitHeaderPathFor(root: string, task: number, round: number): string {
  return runPath(root, task, { area: 'developer', round, file: COMMIT_HEADER_FILE_NAME })
}

export function prBodyPathFor(root: string, task: number, round: number): string {
  return runPath(root, task, { area: 'developer', round, file: PR_BODY_FILE_NAME })
}
