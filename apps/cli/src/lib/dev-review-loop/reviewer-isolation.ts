/**
 * Reviewers inspect one immutable candidate with isolated scratch space
 * (`#561`, O1/O2/O3).
 *
 * `apps/cli/specs/isolation.md` specifies the full OS-level Worker/Reviewer
 * boundary (Seatbelt, credential scoping) and is explicit that wiring
 * `dispatchRole` to that mechanism belongs to a later, separate change, not
 * this one. This module is a narrower, already-in-surface slice of that same
 * boundary: it never touches environment inheritance or process
 * confinement, and it addresses one concrete gap named in that file's own
 * boundary table — "read the repository at the judged head (its own
 * checkout or worktree, read-only in intent)" was, before this task, a
 * promise `dispatchReviewer` never kept. `dispatchRole`'s own `spawn` call
 * carried no `cwd` at all, so a dispatched reviewer's shell ran from
 * whatever directory the driver process itself happened to be started in —
 * never the candidate's own content, and never guaranteed identical between
 * the two reviewers dispatched the same round.
 *
 * The mechanism here is a plain, permission-enforced filesystem copy, not a
 * second `git worktree` or `git archive` invocation — see the PR's Decisions
 * for why. `buildReviewerCandidate` copies the developer's own local
 * worktree (the same `.worktrees/<branch>` this driver already trusts
 * elsewhere — `readWorktreeHead`, `readUnpushedWorkDetail`) into a
 * driver-owned directory once per round, then chmods every file and
 * directory in it read-only: a reviewer that tries to write inside it fails
 * on the OS's own permission check, not on a convention. Both reviewers
 * dispatched this round are handed a scratch copy DERIVED FROM THAT SAME
 * candidate (`buildReviewerScratch`) — never the candidate itself, and never
 * each other's copy — so a reviewer that writes or runs its own toolchain
 * inside its own `cwd` can never mutate the shared snapshot or the sibling
 * role's context. Every function here is best-effort by design, matching
 * this file's sibling `persistManifestRecord`/`runEvidenceReport`: a
 * snapshot or scratch copy that could not be built degrades to `null` —
 * the caller then dispatches with no `cwd` override, exactly as before this
 * task — never a thrown error that turns the loop's own filesystem
 * bookkeeping into a reason to pause a round. The manifest binding
 * (`compareManifest`) is what actually gates a verdict against a moved base
 * or head; this module only makes sure two reviewers reading "the
 * candidate" this round read the identical bytes, and that neither can
 * alter what the other reads.
 */

import { basename, join } from 'node:path'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'

export type ReviewerRole = 'reviewer' | 'security'

/** One shared, read-only checkout per round — both reviewer roles are dispatched against the SAME directory content (O1). */
export function reviewerCandidateDir(root: string, task: number, round: number): string {
  return join(root, 'dev-review-loop', String(task), `round-${round}-candidate`)
}

/**
 * `attempt` mirrors `reviewerWorkDir`'s own convention (`reviewer-dispatch.ts`):
 * attempt 1 is the round's normal scratch copy; attempt 2+ is a fresh
 * directory for a retry, never the failed attempt's own (O3, fresh-reviewer
 * semantics — never resume a crashed reviewer's own scratch).
 */
export function reviewerScratchDir(root: string, task: number, round: number, role: ReviewerRole, attempt = 1): string {
  const suffix = attempt > 1 ? `-retry${attempt - 1}` : ''
  return join(root, 'dev-review-loop', String(task), `round-${round}-${role}-scratch${suffix}`)
}

/** Never copied into a candidate or scratch tree: version-control internals and installed dependencies a reviewer never needs to read, and — for `.worktrees` specifically — every OTHER task's own worktree, were a stray one ever nested under the source directory. */
const ISOLATION_COPY_EXCLUDES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.worktrees'])

function copyTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, {
    recursive: true,
    filter: (source) => !ISOLATION_COPY_EXCLUDES.has(basename(source))
  })
}

/** Recursive `chmod`, best-effort per entry — a single unreadable/removed entry never aborts the whole walk (mirrors this module's blanket best-effort posture). */
function chmodTree(dir: string, fileMode: number, dirMode: number): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  try {
    chmodSync(dir, dirMode)
  } catch {
    // best-effort
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      chmodTree(full, fileMode, dirMode)
    } else {
      try {
        chmodSync(full, fileMode)
      } catch {
        // best-effort
      }
    }
  }
}

function removeIfPresent(dir: string): void {
  try {
    // A prior read-only candidate/scratch tree must be unlocked before
    // `rmSync` can remove its entries — a directory chmod'd `0o555` refuses
    // even its own owner permission to unlink a child.
    chmodTree(dir, 0o644, 0o755)
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort — never fails a round over cleanup.
  }
}

/**
 * O1: builds (or rebuilds) this round's shared, read-only candidate from
 * `sourceDir` — the developer's own local worktree. `null` when `sourceDir`
 * doesn't exist on this machine (a fresh attach with no local checkout yet,
 * or a driver running on a different host than the one that last dispatched
 * the developer) or the copy itself fails for any reason: the caller then
 * dispatches reviewers with no `cwd` override, the exact behavior every
 * round had before this task. Idempotent per round: a second call for the
 * same `(task, round)` (the loop's own resend-for-finding-ids path calls
 * `buildReviewerScratch` again, never this) replaces whatever was there
 * rather than leaving two candidates on disk.
 */
export function buildReviewerCandidate(root: string, task: number, round: number, sourceDir: string): string | null {
  if (!existsSync(sourceDir)) return null
  const dest = reviewerCandidateDir(root, task, round)
  try {
    removeIfPresent(dest)
    copyTree(sourceDir, dest)
    chmodTree(dest, 0o444, 0o555)
    return dest
  } catch {
    removeIfPresent(dest)
    return null
  }
}

/**
 * O2: a fresh, writable copy of `candidateDir` for exactly one reviewer
 * role's one dispatch attempt — never the candidate itself, and never
 * shared with the sibling role's own scratch copy. Wiped and rebuilt on
 * every call, so a retried attempt (`dispatchReviewer`'s one-fresh-retry,
 * `resendForFindingIds`'s resend) never resumes a prior attempt's scratch.
 * `null` on any copy failure — the caller dispatches with no `cwd` override.
 */
export function buildReviewerScratch(
  root: string,
  task: number,
  round: number,
  role: ReviewerRole,
  attempt: number,
  candidateDir: string
): string | null {
  const dest = reviewerScratchDir(root, task, round, role, attempt)
  try {
    removeIfPresent(dest)
    copyTree(candidateDir, dest)
    // `cpSync` preserves the source's own permission bits — the candidate
    // this copies from is chmod'd read-only (`buildReviewerCandidate`), so
    // without this the scratch copy would inherit that same read-only mode
    // and defeat the entire point of a WRITABLE per-reviewer scratch space.
    chmodTree(dest, 0o644, 0o755)
    return dest
  } catch {
    removeIfPresent(dest)
    return null
  }
}

const CANDIDATE_NAME_RE = /^round-(\d+)-candidate$/
const SCRATCH_NAME_RE = /^round-(\d+)-(reviewer|security)-scratch(?:-retry\d+)?$/

/**
 * O3: removes this round's shared candidate and every scratch copy any
 * attempt created — called once the round has concluded (published, paused,
 * or handed back to the developer for another round) so a round's isolation
 * artifacts never outlive the round itself. Best-effort; never throws.
 */
export function cleanupReviewerIsolationForRound(root: string, task: number, round: number): void {
  const taskDir = join(root, 'dev-review-loop', String(task))
  let entries: string[]
  try {
    entries = readdirSync(taskDir)
  } catch {
    return
  }
  for (const name of entries) {
    const candidateMatch = CANDIDATE_NAME_RE.exec(name)
    const scratchMatch = SCRATCH_NAME_RE.exec(name)
    const matchedRound = candidateMatch?.[1] ?? scratchMatch?.[1]
    if (matchedRound !== undefined && Number(matchedRound) === round) {
      removeIfPresent(join(taskDir, name))
    }
  }
}

/**
 * O3: restart/cancellation cleanliness. Removes every round's candidate and
 * scratch directory for `task`, regardless of round number — called once at
 * driver start (fresh or `--resume`), before this run builds its own, and
 * from the driver's own `SIGTERM`/`SIGINT` shutdown handlers, so a crashed
 * or killed prior run never leaves a stale checkout for the next run (or a
 * human) to find. Best-effort; never throws.
 */
export function cleanupAllReviewerIsolationArtifacts(root: string, task: number): void {
  const taskDir = join(root, 'dev-review-loop', String(task))
  let entries: string[]
  try {
    entries = readdirSync(taskDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (CANDIDATE_NAME_RE.test(name) || SCRATCH_NAME_RE.test(name)) {
      removeIfPresent(join(taskDir, name))
    }
  }
}
