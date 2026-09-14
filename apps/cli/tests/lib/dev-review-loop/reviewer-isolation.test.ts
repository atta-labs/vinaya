/**
 * `#561` — the isolation.md/loop.md-named
 * gap `dispatchReviewer` never closed before this task: two reviewers
 * dispatched the same round must read byte-identical content (O1), any test
 * run or write either performs must never touch that shared content or the
 * sibling role's own context (O2), and both the shared candidate and every
 * scratch copy must be gone once a round concludes, is restarted, or is
 * cancelled (O3). These are pure-`fs` unit tests — no subprocess, no fake
 * `git` — exercising `reviewer-isolation.ts` directly.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildReviewerCandidate,
  buildReviewerScratch,
  buildVerifiedReviewerCandidate,
  cleanupAllReviewerIsolationArtifacts,
  cleanupReviewerIsolationForRound,
  reviewerCandidateDir,
  reviewerScratchDir
} from '../../../src/lib/dev-review-loop/reviewer-isolation'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    // A leftover read-only candidate/scratch tree refuses its own removal
    // unless unlocked first — mirrors `removeIfPresent`'s own chmod-before-rm.
    try {
      chmodRecursiveForCleanup(dir)
    } catch {
      // best-effort
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function chmodRecursiveForCleanup(dir: string): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  try {
    chmodSync(dir, 0o755)
  } catch {
    // best-effort
  }
  for (const name of entries) chmodRecursiveForCleanup(join(dir, name))
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeSourceWorktree(): string {
  const src = tempDir('vinaya-riso-src-')
  mkdirSync(join(src, '.git'), { recursive: true })
  writeFileSync(join(src, '.git', 'HEAD'), 'ref: refs/heads/task/x/1\n')
  mkdirSync(join(src, 'node_modules', 'some-dep'), { recursive: true })
  writeFileSync(join(src, 'node_modules', 'some-dep', 'index.js'), 'module.exports = {}\n')
  mkdirSync(join(src, 'apps', 'cli', 'src'), { recursive: true })
  writeFileSync(join(src, 'apps', 'cli', 'src', 'thing.ts'), 'export const thing = 1\n')
  writeFileSync(join(src, 'README.md'), '# hello\n')
  return src
}

function attemptWrite(path: string): 'wrote' | 'refused' {
  try {
    writeFileSync(path, 'mutated')
    return 'wrote'
  } catch {
    return 'refused'
  }
}

describe('buildReviewerCandidate — O1, one shared read-only checkout per round', () => {
  it('copies tracked-looking content, excluding .git and node_modules', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const dest = buildReviewerCandidate(root, 9001, 1, src)
    expect(dest).toBe(reviewerCandidateDir(root, 9001, 1))
    expect(existsSync(join(dest as string, 'apps', 'cli', 'src', 'thing.ts'))).toBe(true)
    expect(readFileSync(join(dest as string, 'README.md'), 'utf8')).toBe('# hello\n')
    expect(existsSync(join(dest as string, '.git'))).toBe(false)
    expect(existsSync(join(dest as string, 'node_modules'))).toBe(false)
  })

  it('is read-only in intent: neither an existing file nor a new one can be written inside it', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const dest = buildReviewerCandidate(root, 9001, 1, src) as string
    expect(attemptWrite(join(dest, 'README.md'))).toBe('refused')
    expect(attemptWrite(join(dest, 'new-file.txt'))).toBe('refused')
  })

  it('returns null when the source worktree does not exist on this machine, never throws', () => {
    const root = tempDir('vinaya-riso-root-')
    const missing = join(root, 'nowhere', 'task', 'x', '1')
    expect(buildReviewerCandidate(root, 9001, 1, missing)).toBeNull()
  })

  it('worker mutation invisible: a source-tree write after the candidate is built never reaches the candidate', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const dest = buildReviewerCandidate(root, 9001, 1, src) as string
    writeFileSync(join(src, 'apps', 'cli', 'src', 'thing.ts'), 'export const thing = 999 // mutated by worker\n')
    writeFileSync(join(src, 'new-from-worker.ts'), 'export const sneaky = true\n')
    expect(readFileSync(join(dest, 'apps', 'cli', 'src', 'thing.ts'), 'utf8')).toBe('export const thing = 1\n')
    expect(existsSync(join(dest, 'new-from-worker.ts'))).toBe(false)
  })

  it('rebuilds in place on a second call for the same round, never leaving a stale copy', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const first = buildReviewerCandidate(root, 9001, 1, src) as string
    writeFileSync(join(src, 'README.md'), '# updated\n')
    const second = buildReviewerCandidate(root, 9001, 1, src) as string
    expect(second).toBe(first)
    expect(readFileSync(join(second, 'README.md'), 'utf8')).toBe('# updated\n')
  })

  it('never copies a symlink into the candidate (round 2 review, HIGH/MAJOR)', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const externalDir = tempDir('vinaya-riso-external-')
    const externalTarget = join(externalDir, 'outside-the-tree.txt')
    writeFileSync(externalTarget, 'not meant to be reachable\n')
    symlinkSync(externalTarget, join(src, 'sneaky-link.txt'))

    const dest = buildReviewerCandidate(root, 9001, 1, src) as string

    expect(existsSync(join(dest, 'sneaky-link.txt'))).toBe(false)
    // A real file at the same name (never a symlink) still copies normally.
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('# hello\n')
  })

  it("chmod'ing the candidate read-only never touches a symlink target's own permissions (round 2 review, HIGH/MAJOR)", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const externalDir = tempDir('vinaya-riso-external-')
    const externalTarget = join(externalDir, 'outside-the-tree.txt')
    writeFileSync(externalTarget, 'not meant to be reachable\n')
    chmodSync(externalTarget, 0o644)
    symlinkSync(externalTarget, join(src, 'sneaky-link.txt'))

    buildReviewerCandidate(root, 9001, 1, src)

    // `chmodTree`'s own `0o444` pass must never have followed the symlink
    // through to this file — its mode is untouched.
    expect(statSync(externalTarget).mode & 0o777).toBe(0o644)
    expect(lstatSync(join(src, 'sneaky-link.txt')).isSymbolicLink()).toBe(true)
  })

  it('never copies a filename recognized as secret-bearing, even when nothing gitignores it (round 2 review, HIGH)', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    writeFileSync(join(src, '.env'), 'API_KEY=secret\n')
    writeFileSync(join(src, '.env.local'), 'API_KEY=secret2\n')
    mkdirSync(join(src, 'nested'), { recursive: true })
    writeFileSync(join(src, 'nested', 'id_rsa'), 'private key material\n')

    const dest = buildReviewerCandidate(root, 9001, 1, src) as string

    expect(existsSync(join(dest, '.env'))).toBe(false)
    expect(existsSync(join(dest, '.env.local'))).toBe(false)
    expect(existsSync(join(dest, 'nested', 'id_rsa'))).toBe(false)
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toBe('# hello\n')
  })

  it("honors the developer worktree's own .gitignore — an untracked ignored file or directory is never copied (round 2 review, HIGH)", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = tempDir('vinaya-riso-src-git-')
    execFileSync('git', ['init', '-q'], { cwd: src })
    writeFileSync(join(src, '.gitignore'), 'ignored-secret.txt\nbuild/\n')
    writeFileSync(join(src, 'tracked.txt'), 'kept\n')
    writeFileSync(join(src, 'ignored-secret.txt'), 'untracked and gitignored\n')
    mkdirSync(join(src, 'build'), { recursive: true })
    writeFileSync(join(src, 'build', 'output.js'), 'built artifact\n')

    const dest = buildReviewerCandidate(root, 9002, 1, src) as string

    expect(readFileSync(join(dest, 'tracked.txt'), 'utf8')).toBe('kept\n')
    expect(existsSync(join(dest, 'ignored-secret.txt'))).toBe(false)
    expect(existsSync(join(dest, 'build'))).toBe(false)
  })

  it('locks to read-only without widening a narrower-than-default source mode to world-readable (round 2 review, HIGH)', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const ownerOnly = join(src, 'owner-only.txt')
    writeFileSync(ownerOnly, 'owner-only content\n')
    chmodSync(ownerOnly, 0o600)

    const dest = buildReviewerCandidate(root, 9001, 1, src) as string

    // The developer's own `0o600` never survives as `0o444`: locking only
    // ever strips write bits, so a file with no group/other read access to
    // begin with keeps having none.
    expect(statSync(join(dest, 'owner-only.txt')).mode & 0o777).toBe(0o400)
  })

  it('creates the candidate directory itself owner-only, so its predictable path buys nothing without also being the owning user (round 2 review, MEDIUM)', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()

    const dest = buildReviewerCandidate(root, 9001, 1, src) as string

    expect(statSync(dest).mode & 0o077).toBe(0)
  })
})

describe('buildReviewerScratch — O2, a fresh writable copy per reviewer, derived from the SAME candidate', () => {
  it('both reviewers this round read identical content from the one shared candidate', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const candidate = buildReviewerCandidate(root, 9001, 1, src) as string
    const reviewerScratch = buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate) as string
    const securityScratch = buildReviewerScratch(root, 9001, 1, 'security', 1, candidate) as string
    expect(reviewerScratch).not.toBe(securityScratch)
    expect(readFileSync(join(reviewerScratch, 'README.md'), 'utf8')).toBe(
      readFileSync(join(securityScratch, 'README.md'), 'utf8')
    )
  })

  it("scratch isolated: a write inside one reviewer's scratch never reaches the candidate or the other reviewer's scratch", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const candidate = buildReviewerCandidate(root, 9001, 1, src) as string
    const reviewerScratch = buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate) as string
    const securityScratch = buildReviewerScratch(root, 9001, 1, 'security', 1, candidate) as string
    writeFileSync(join(reviewerScratch, 'README.md'), '# reviewer scribbled here\n')
    writeFileSync(join(reviewerScratch, 'scratch-only.txt'), 'private to the reviewer\n')
    expect(readFileSync(join(candidate, 'README.md'), 'utf8')).toBe('# hello\n')
    expect(readFileSync(join(securityScratch, 'README.md'), 'utf8')).toBe('# hello\n')
    expect(existsSync(join(securityScratch, 'scratch-only.txt'))).toBe(false)
  })

  it('is writable, unlike the candidate it was copied from', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const candidate = buildReviewerCandidate(root, 9001, 1, src) as string
    const scratch = buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate) as string
    expect(attemptWrite(join(scratch, 'README.md'))).toBe('wrote')
  })

  it("fresh per attempt: a retry never inherits a prior attempt's leftover file at the same path", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const candidate = buildReviewerCandidate(root, 9001, 1, src) as string
    const attempt1 = buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate) as string
    writeFileSync(join(attempt1, 'stray-from-attempt-1.txt'), 'left behind by a crashed attempt\n')
    // Attempt 2 gets its OWN directory (`reviewerWorkDir`'s own `-retry1` convention)...
    const attempt2 = buildReviewerScratch(root, 9001, 1, 'reviewer', 2, candidate) as string
    expect(attempt2).not.toBe(attempt1)
    expect(existsSync(join(attempt2, 'stray-from-attempt-1.txt'))).toBe(false)
    // ...and a second call for the SAME attempt number is wiped, not merged.
    writeFileSync(join(attempt1, 'another-stray.txt'), 'x')
    const attempt1Again = buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate) as string
    expect(existsSync(join(attempt1Again, 'another-stray.txt'))).toBe(false)
  })

  it('returns null when the candidate directory it should copy from does not exist', () => {
    const root = tempDir('vinaya-riso-root-')
    const missingCandidate = join(root, 'dev-review-loop', '9001', 'round-1-candidate')
    expect(buildReviewerScratch(root, 9001, 1, 'reviewer', 1, missingCandidate)).toBeNull()
  })

  it('unlocks only the owner write bit, never widening a narrower-than-default source mode to group/other (round 2 review, HIGH)', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const ownerOnly = join(src, 'owner-only.txt')
    writeFileSync(ownerOnly, 'owner-only content\n')
    chmodSync(ownerOnly, 0o600)
    const candidate = buildReviewerCandidate(root, 9001, 1, src) as string

    const scratch = buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate) as string

    // The candidate's own locked `0o400` becomes writable again for the
    // owner only — never `0o644`, which would grant group/other read access
    // the original file never had.
    expect(statSync(join(scratch, 'owner-only.txt')).mode & 0o777).toBe(0o600)
  })

  it("creates the scratch directory itself owner-only, same as the candidate it's derived from (round 2 review, MEDIUM)", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const candidate = buildReviewerCandidate(root, 9001, 1, src) as string

    const scratch = buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate) as string

    expect(statSync(scratch).mode & 0o077).toBe(0)
  })
})

describe('cleanupReviewerIsolationForRound — O3, removed once the round concludes', () => {
  it("removes this round's candidate and every scratch copy, leaving other rounds and work dirs untouched", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const candidate1 = buildReviewerCandidate(root, 9001, 1, src) as string
    buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate1)
    buildReviewerScratch(root, 9001, 1, 'security', 1, candidate1)
    buildReviewerScratch(root, 9001, 1, 'reviewer', 2, candidate1)
    const candidate2 = buildReviewerCandidate(root, 9001, 2, src) as string
    buildReviewerScratch(root, 9001, 2, 'reviewer', 1, candidate2)

    // A same-named artifact this module never owns — the pre-existing
    // findings/report work directory — must survive cleanup untouched.
    const workDir = join(root, 'dev-review-loop', '9001', 'round-1-reviewer-work')
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, 'findings.txt'), '')

    cleanupReviewerIsolationForRound(root, 9001, 1)

    expect(existsSync(candidate1)).toBe(false)
    expect(existsSync(reviewerScratchDir(root, 9001, 1, 'reviewer', 1))).toBe(false)
    expect(existsSync(reviewerScratchDir(root, 9001, 1, 'security', 1))).toBe(false)
    expect(existsSync(reviewerScratchDir(root, 9001, 1, 'reviewer', 2))).toBe(false)
    // Round 2's own artifacts are a different round — untouched.
    expect(existsSync(candidate2)).toBe(true)
    expect(existsSync(reviewerScratchDir(root, 9001, 2, 'reviewer', 1))).toBe(true)
    // Not this module's file at all — untouched.
    expect(existsSync(join(workDir, 'findings.txt'))).toBe(true)
  })

  it('is a safe no-op when nothing was ever built for this task', () => {
    const root = tempDir('vinaya-riso-root-')
    expect(() => cleanupReviewerIsolationForRound(root, 4242, 1)).not.toThrow()
  })
})

describe('cleanupAllReviewerIsolationArtifacts — O3, restart and cancellation cleanliness', () => {
  it("removes every round's candidate and scratch directory for the task", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const candidate1 = buildReviewerCandidate(root, 9001, 1, src) as string
    buildReviewerScratch(root, 9001, 1, 'reviewer', 1, candidate1)
    const candidate2 = buildReviewerCandidate(root, 9001, 2, src) as string
    buildReviewerScratch(root, 9001, 2, 'security', 1, candidate2)

    const workDir = join(root, 'dev-review-loop', '9001', 'round-1-reviewer-work')
    mkdirSync(workDir, { recursive: true })

    cleanupAllReviewerIsolationArtifacts(root, 9001)

    expect(existsSync(candidate1)).toBe(false)
    expect(existsSync(candidate2)).toBe(false)
    expect(existsSync(reviewerScratchDir(root, 9001, 1, 'reviewer', 1))).toBe(false)
    expect(existsSync(reviewerScratchDir(root, 9001, 2, 'security', 1))).toBe(false)
    expect(existsSync(workDir)).toBe(true)
  })

  it("never touches a different task's own candidate/scratch directories", () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const otherTaskCandidate = buildReviewerCandidate(root, 4242, 1, src) as string
    cleanupAllReviewerIsolationArtifacts(root, 9001)
    expect(existsSync(otherTaskCandidate)).toBe(true)
  })

  it('is a safe no-op when the task has no `dev-review-loop` directory at all (a fresh task, or nothing ever dispatched)', () => {
    const root = tempDir('vinaya-riso-root-')
    expect(() => cleanupAllReviewerIsolationArtifacts(root, 9001)).not.toThrow()
  })
})

describe('buildVerifiedReviewerCandidate — closing the gap between the head check and the copy (round 2 review, MINOR; round 3 review, MAJOR)', () => {
  it('discards a candidate the worktree outran mid-copy, cleaning it up, rather than returning torn content', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    let calls = 0
    const readHead = () => {
      calls += 1
      // Agrees with the expected head on the pre-copy read, then reports a
      // moved head on the post-copy read — the exact race this function
      // exists to catch.
      return calls === 1 ? 'sha-a' : 'sha-b'
    }

    const dest = buildVerifiedReviewerCandidate(root, 9003, 1, src, 'sha-a', readHead)

    expect(dest).toBeNull()
    expect(calls).toBe(2)
    expect(existsSync(reviewerCandidateDir(root, 9003, 1))).toBe(false)
  })

  it('never attempts the copy at all when the worktree has already moved before the first read', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const readHead = () => 'sha-different'

    const dest = buildVerifiedReviewerCandidate(root, 9003, 1, src, 'sha-a', readHead)

    expect(dest).toBeNull()
    expect(existsSync(reviewerCandidateDir(root, 9003, 1))).toBe(false)
  })

  it('returns the built candidate when the head agrees on both reads', () => {
    const root = tempDir('vinaya-riso-root-')
    const src = writeSourceWorktree()
    const readHead = () => 'sha-a'

    const dest = buildVerifiedReviewerCandidate(root, 9003, 1, src, 'sha-a', readHead)

    expect(dest).toBe(reviewerCandidateDir(root, 9003, 1))
    expect(existsSync(dest as string)).toBe(true)
  })
})
