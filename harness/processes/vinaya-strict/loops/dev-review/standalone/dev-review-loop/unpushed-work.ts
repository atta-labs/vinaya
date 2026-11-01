import { execFileSync } from 'node:child_process'
import { sh } from './gate-reading.js'

// The reading of a Developer's unpushed work and the texts that name it,
// shared by the standalone review loop and the Engine runner. Each takes every
// value it needs as an explicit parameter, so both runners decide a turn that
// pushed nothing from the same reading of the worktree.

/** What a worktree holds that is not on the remote: its dirty files and the commits its head sits ahead of its upstream. */
export interface UnpushedWork {
  dirtyFiles: string[]
  aheadCount: number
}

/**
 * The loop keeps no control file in the worktree — the Developer's turn
 * result arrives as structured output, and the driver's own records live under
 * the round's Developer folder inside the task's folder — so this reads the
 * worktree's own `git status --porcelain` with no exemption at all: a stray
 * file of any name is ordinary untracked work, never specially ignored.
 */
export function readUnpushedWorkDetail(worktreePath: string): UnpushedWork {
  let dirtyFiles: string[] = []
  try {
    // Deliberately NOT `sh()`: its own blanket `.trim()` on the whole output
    // destroys porcelain's own leading space on line 1 when the status code
    // there is ` M` (unstaged modify) — the single most common code — before
    // this function's own fixed-width slice ever runs. `execFileSync` here
    // keeps every byte porcelain actually printed.
    const raw = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    dirtyFiles = raw
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3))
  } catch {
    // Worktree unreadable — nothing to report.
  }
  let aheadCount = 0
  try {
    const count = sh('git', ['-C', worktreePath, 'rev-list', '--count', '@{u}..HEAD'])
    const parsed = Number.parseInt(count.trim(), 10)
    aheadCount = Number.isFinite(parsed) ? parsed : 0
  } catch {
    // No upstream tracking ref (or the worktree is unreadable) — zero, not a throw.
  }
  return { dirtyFiles, aheadCount }
}

/**
 * The `no_push` pause's detail: the branch, then only what is really
 * unpushed — the dirty file(s), and the count of commits ahead of the remote
 * when there are any. Never a claim about commits when there are none.
 */
export function noPushPauseDetail(branch: string, unpushed: UnpushedWork): string {
  const parts = [`branch ${branch}`]
  if (unpushed.dirtyFiles.length > 0) parts.push(`dirty file(s): ${unpushed.dirtyFiles.join(', ')}`)
  if (unpushed.aheadCount > 0) parts.push(`${unpushed.aheadCount} commit(s) ahead of the remote`)
  return parts.join('; ')
}

/** Shared by the journal event and the pull request comment, so the two never describe the same stall differently. */
export function unpushedWorkResumeDetail(unpushed: UnpushedWork): string {
  return unpushed.dirtyFiles.length > 0
    ? `dirty file(s): ${unpushed.dirtyFiles.join(', ')}`
    : `${unpushed.aheadCount} commit(s) ahead of the remote, worktree clean`
}

/**
 * The mechanical failure of an attempt whose push never landed, as a
 * message — everything a driver can observe of one, which is everything it
 * will ever have: the refusal text itself (a pre-push hook refusing, the
 * remote refusing) exists only inside the developer's own session, and what
 * survives the turn is the head that did not move plus
 * `readUnpushedWorkDetail`'s reading of the worktree. Fed to `assessRound` as
 * a `mechanical_failure` observation, where the same normalised signature that
 * matches two red gates matches two of these; also what the resulting pause
 * names, so the message a reader gets is this exact text.
 */
export function unpushedFailureMessage(branch: string, head: string, unpushed: UnpushedWork): string {
  return `push never landed on ${branch}: head ${head} unchanged; ${unpushedWorkResumeDetail(unpushed)}`
}
