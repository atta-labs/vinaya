/**
 * "The files changed since the remote base" is one
 * fact both the pre-push hook's Biome step and its test-file selector need
 * identically; computed once here so the two can never quietly diverge on
 * what "changed" means.
 *
 * Base resolution order: the branch's own upstream (`@{u}`) when one is
 * configured (the ordinary case — this hook only ever runs on a branch
 * that's about to push, and `git push` itself requires a remote to exist),
 * falling back to `origin/main` for a first push with no upstream tracking
 * set up yet, and finally the previous commit — a push can never fail this
 * resolution outright the way a check with no repo state at all might.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** The ref this push's changes should be measured against — never throws. */
export function resolveRemoteBase(repoRoot: string): string {
  const upstream = git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (upstream) return upstream
  const originMain = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'origin/main'])
  if (originMain) return 'origin/main'
  return 'HEAD~1'
}

/** Repo-root-relative paths of every file changed between `resolveRemoteBase()` and `HEAD` — added, copied, modified, renamed; never a deleted file, which has nothing left to lint or test. */
export function changedFilesSinceRemoteBase(repoRoot: string): string[] {
  const base = resolveRemoteBase(repoRoot)
  const out = git(repoRoot, ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`])
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Absolute paths, for callers (the test selector) that walk the filesystem rather than shelling back out to git. */
export function changedFilesSinceRemoteBaseAbsolute(repoRoot: string): string[] {
  return changedFilesSinceRemoteBase(repoRoot).map((f) => join(repoRoot, f))
}
