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

/**
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` (and the rest of the `GIT_*`
 * family), when present in the environment, override git's own repository
 * discovery outright — `cwd` stops mattering at all. A real pre-push hook
 * inherits these correctly pointed at ITS OWN repo, so stripping them here
 * changes nothing for that caller (discovery from `cwd` lands on the exact
 * same repo `GIT_DIR` already named). What it closes is the caller this
 * file cannot see: a test resolving a REAL, unrelated `repoRoot` while the
 * process it runs in happens to carry a `GIT_DIR` from somewhere else —
 * found live, expensively: a fixture repo, no remote configured, resolved
 * `@{u}` to a real branch's real upstream because this function's own `git`
 * call inherited that branch's `GIT_DIR`, and its own `git commit` calls
 * (a different file's, run moments earlier) had already landed as genuine
 * commits on it. Every call this file makes builds its `env` fresh from the
 * ambient one with the `GIT_*` keys removed — never relies on `execFileSync`
 * inheriting `process.env` implicitly, which on this runtime does not even
 * see a same-process mutation of `process.env` made after the process
 * started (confirmed live: deleting `process.env.GIT_DIR` had no effect on
 * a child process spawned afterward in the same run — the fix has to be an
 * explicit `env` object at the call site, not a mutation anywhere earlier).
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return env
}

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: cleanGitEnv()
    }).trim()
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
