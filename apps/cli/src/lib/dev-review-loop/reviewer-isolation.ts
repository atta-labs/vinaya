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
 * role's context. Neither copy ever includes a symlink, a `.gitignore`d
 * path, or a filename `copyTree`'s own `SECRET_FILENAME_RE` recognizes
 * (see `copyTree`'s own doc comment) — the developer's worktree, and
 * everything untracked inside it, is untrusted input. A symlink surviving
 * into a candidate/scratch tree would let a reviewer read, or a stray
 * `chmod` reach, a path outside that tree entirely; an untracked secret
 * copied in verbatim would hand it to both reviewer processes just as
 * readily as a tracked source file. `chmodTree` locks or unlocks each
 * entry's own preserved-from-source mode (`LOCK_READ_ONLY`/
 * `UNLOCK_OWNER_WRITE`) rather than overwriting it with a fixed value, so a
 * file the developer had `0o600` never comes out world-readable on the way
 * through — and the candidate/scratch directory itself is created `0o700`,
 * so its own predictable, forge-derived path buys another host user
 * nothing without also being the owning user. Every function here is
 * best-effort by design, matching
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

import { basename, join, relative } from 'node:path'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

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

/**
 * Never copied into a candidate tree regardless of `.gitignore` (round 2
 * review, HIGH: a developer worktree's OWN `.gitignore` is untrusted input
 * too — a repo that never lists `.env`, or lists it inconsistently, would
 * otherwise still get it copied). Matched against the basename only, so
 * `.env`, `.env.local`, a private key, an `.npmrc`/`.netrc` carrying a
 * registry token, or an SSH key is refused at any depth in the tree.
 */
const SECRET_FILENAME_RE =
  /^\.env(\..+)?$|^\.npmrc$|^\.netrc$|^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|\.(pem|key|p12|pfx)$/i

/** `lstatSync` (never `statSync`) so a symlink is identified as itself, not as whatever it points to. Best-effort: an entry that vanishes between `readdirSync` and this call is treated as "not a symlink" — `cpSync`'s own read of the same path fails it out a moment later regardless. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Every path `git`, run from `root`, considers ignored — untracked files a
 * developer's own `.gitignore` (or global excludes) keeps out of the repo,
 * which is exactly where a stray secret file most often lives (round 2
 * review, HIGH: `copyTree` previously honored neither `.gitignore` nor any
 * secret-bearing filename, so an untracked `.env` sitting in the developer
 * worktree was copied into the shared candidate verbatim). `--directory`
 * collapses an entirely-ignored directory into one entry ending in `/` so a
 * large ignored tree (a build output directory, say) is matched by prefix
 * rather than walked file by file. Best-effort: a `sourceDir` that isn't a
 * git worktree at all (already unreachable in practice — every caller here
 * passes a `.worktrees/<branch>` checkout) yields an empty set rather than
 * throwing.
 */
function listGitIgnoredPaths(root: string): ReadonlySet<string> {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    return new Set(out.split('\0').filter(Boolean))
  } catch {
    return new Set()
  }
}

function isGitIgnored(relPath: string, ignored: ReadonlySet<string>): boolean {
  if (ignored.has(relPath)) return true
  for (const entry of ignored) {
    if (entry.endsWith('/') && (relPath === entry.slice(0, -1) || relPath.startsWith(entry))) return true
  }
  return false
}

const NO_IGNORED_PATHS: ReadonlySet<string> = new Set()

/**
 * Never copies a symlink into a candidate or scratch tree (round 2 review,
 * HIGH/MAJOR: a symlink copied verbatim by `cpSync`, then handed to
 * `chmodTree`, lets `chmodSync` — which always follows a symlink on POSIX,
 * there being no portable `lchmod` — change the permissions of whatever the
 * link resolves to, a path that can sit entirely outside the tree this
 * module exists to confine). The reviewed worktree is untrusted input; a
 * reviewer needs to read source and test files, never a link to somewhere
 * else on the host, so refusing every symlink outright costs nothing a
 * review needs and closes both the read-outside-the-tree and the
 * chmod-something-external vectors in one place, structurally, rather than
 * naming this one incident and leaving the next symlink shape to be found
 * the same way.
 *
 * `dest` is created `0o700` before anything is copied into it — owner-only,
 * so the candidate/scratch directory's own predictable path (round 2
 * review, MEDIUM) buys another host user nothing: entering it at all, not
 * just reading a file inside it, requires being the owning user. `ignored`
 * (only ever non-empty for the developer-worktree source, never for a
 * candidate-to-scratch copy, whose source has already been filtered once)
 * additionally drops every `.gitignore`d path and every filename
 * `SECRET_FILENAME_RE` matches.
 */
function copyTree(src: string, dest: string, ignored: ReadonlySet<string> = NO_IGNORED_PATHS): void {
  // `mode` here, not a separate `chmodSync` after (round 3 review, MEDIUM):
  // a create-then-narrow pair leaves `dest` briefly sitting at whatever the
  // process umask produces — commonly world-enterable — on this directory's
  // fully predictable, forge-derived path. One syscall closes the window.
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const rel = relative(src, source)
      if (rel === '') return true
      const base = basename(source)
      if (ISOLATION_COPY_EXCLUDES.has(base)) return false
      if (isSymlink(source)) return false
      if (SECRET_FILENAME_RE.test(base)) return false
      if (isGitIgnored(rel, ignored)) return false
      return true
    }
  })
}

/**
 * Recursive `chmod`, best-effort per entry — a single unreadable/removed
 * entry never aborts the whole walk (mirrors this module's blanket
 * best-effort posture). `mode` derives the new mode from each entry's OWN
 * current mode rather than overwriting it with a fixed value (round 2
 * review, HIGH: `chmodTree(dest, 0o444, 0o555)`/`chmodTree(dest, 0o644,
 * 0o755)` forced every file to that exact mode regardless of its original
 * one, so a file the developer had `0o600` — owner-only, the shape a
 * locally-generated secret that slipped past `copyTree`'s own excludes
 * would carry — came out `0o444`, world-readable, on the way through; using
 * `cpSync`'s own preserved-from-source mode as the input to a transform
 * (strip write bits to lock, add the owner's own write bit to unlock) can
 * only ever narrow or restore what the source already granted, never widen
 * it past that.
 */
function chmodTree(dir: string, mode: (current: number) => number): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  try {
    chmodSync(dir, mode(lstatSync(dir).mode) & 0o777)
  } catch {
    // best-effort
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      // Second, independent layer: `copyTree` should never have let a
      // symlink reach this tree at all, but `chmodSync` dereferences one
      // unconditionally — skipping it here means a regression in the copy
      // step still can't turn into a permission change on an arbitrary
      // external path.
      continue
    }
    if (entry.isDirectory()) {
      chmodTree(full, mode)
    } else {
      try {
        chmodSync(full, mode(lstatSync(full).mode) & 0o777)
      } catch {
        // best-effort
      }
    }
  }
}

/** Strips every write bit (owner, group, other), preserving whatever read/execute bits the source already had. */
const LOCK_READ_ONLY = (current: number): number => current & ~0o222
/** Restores the owner's own write bit only — never grants group/other anything they did not already have from the source. */
const UNLOCK_OWNER_WRITE = (current: number): number => current | 0o200

function removeIfPresent(dir: string): void {
  try {
    // A prior read-only candidate/scratch tree must be unlocked before
    // `rmSync` can remove its entries — a directory with no owner write bit
    // refuses even its own owner permission to unlink a child.
    chmodTree(dir, UNLOCK_OWNER_WRITE)
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
 *
 * This function trusts `sourceDir`'s content wholesale — it has no way to
 * know, from the filesystem alone, whether that worktree's own `HEAD` still
 * matches the round's resolved candidate sha (round 2 review, MAJOR: a
 * local worktree that has moved on between push and dispatch would
 * otherwise be copied silently, handing both reviewers content that
 * disagrees with the manifest's own `headSha` with nothing to catch the
 * mismatch). This function alone only guards the BEFORE side of that check;
 * `buildVerifiedReviewerCandidate`, below, is the caller-facing wrapper that
 * also re-checks AFTER the copy, closing the gap where the worktree moves
 * WHILE the copy runs.
 */
export function buildReviewerCandidate(root: string, task: number, round: number, sourceDir: string): string | null {
  if (!existsSync(sourceDir)) return null
  const dest = reviewerCandidateDir(root, task, round)
  try {
    removeIfPresent(dest)
    copyTree(sourceDir, dest, listGitIgnoredPaths(sourceDir))
    chmodTree(dest, LOCK_READ_ONLY)
    return dest
  } catch {
    removeIfPresent(dest)
    return null
  }
}

/**
 * O1, the non-atomic-gap close (round 2 review, MINOR; round 3 review,
 * MAJOR: needed its own direct test). The pre-copy head check
 * `buildReviewerCandidate`'s own doc comment describes, plus a second read
 * of the SAME `sourceDir` once the copy returns: a worktree that advances
 * between those two reads (a commit landing mid-copy) means the bytes just
 * copied no longer agree with `head`, and `buildReviewerCandidate` itself
 * has no way to notice — it only ever reads `sourceDir` once, via `cpSync`.
 * A candidate caught this way is discarded via `cleanupReviewerIsolationForRound`
 * (nothing else has been built for this round yet at this point in the
 * caller's own flow) rather than left on disk for a later round to trip
 * over. `readHead` is a parameter, not this module's own import of
 * `readWorktreeHead`, so `dev-review-loop.ts` keeps threading its own
 * already-tested `d.readWorktreeHead` injection point through here, and
 * this function is directly unit-testable with a fake that answers
 * differently across its two calls.
 */
export function buildVerifiedReviewerCandidate(
  root: string,
  task: number,
  round: number,
  sourceDir: string,
  head: string,
  readHead: (worktreePath: string) => string | null
): string | null {
  if (readHead(sourceDir) !== head) return null
  const dir = buildReviewerCandidate(root, task, round, sourceDir)
  if (dir && readHead(sourceDir) !== head) {
    cleanupReviewerIsolationForRound(root, task, round)
    return null
  }
  return dir
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
    // `UNLOCK_OWNER_WRITE` only ever adds the owner's own write bit back —
    // it never grants group/other anything the original file in the
    // developer's worktree didn't already have (round 2 review, HIGH).
    chmodTree(dest, UNLOCK_OWNER_WRITE)
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
