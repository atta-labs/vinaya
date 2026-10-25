/**
 * Re-run only what failed. When the pre-push hook refuses a push because some
 * selected tests fail, it records which test files failed and at which commit.
 * The next push from the same branch does not re-run the whole selection: it
 * runs those failed files plus the test files affected by the files changed
 * since that refused commit. CI still runs everything once on the pull
 * request, so nothing is skipped overall.
 *
 * The record lives in the worktree's own git directory
 * (`git rev-parse --git-path`), never in the tree: it is a fact about this
 * checkout's last refused push, not something to commit or share.
 *
 * Every decision here is a pure function of its inputs so it is unit-tested
 * without git; the IO wrappers at the bottom are thin.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

/** File name of the record under the worktree's git directory. */
export const FAILED_TESTS_RECORD = 'vinaya/pre-push-failed-tests.json'
/** File name of the last push's selection and result summary, read by the loop for its Log events. */
export const LAST_PUSH_RESULT = 'vinaya/pre-push-last-result.json'
/** File name the selector writes so the result recorder knows whether the run it records was a re-run. */
export const SELECTION_NOTE = 'vinaya/pre-push-selection.json'

/** What a refused push leaves behind for the next one. */
export type FailedTestsRecord = {
  version: 1
  /** The commit the refused push tried to publish. */
  head: string
  /** The branch it was on, so a record never leaks across branches in one worktree. */
  branch: string
  /**
   * Absolute paths of the failing test files, or `'all'` when the run failed
   * without naming any file (a crash, an unhandled error outside a file) —
   * the next push then runs its full selection, never nothing.
   */
  failed: string[] | 'all'
  recordedAt: string
}

/** How the selector chose this push's tests. */
export type SelectionNote = {
  version: 1
  mode: 'full' | 'rerun'
  head: string
  /** The refused commit this re-run continues from (re-run only). */
  rerunOf?: string
  /** Failed files carried over from that refused push (re-run only). */
  rerunFailed?: string[]
  /** Files affected by the changes since the refused commit (re-run only). */
  affectedSince?: string[]
  /** Size of the full selection this push would otherwise have run. */
  fullCount: number
  selected: string[]
}

/** The last push's summary: what ran and what failed. */
export type LastPushResult = {
  version: 1
  head: string
  branch: string
  /** `storage` (cheap checks only), `ready` (after approval), or `default` (today's push). */
  mode: 'storage' | 'ready' | 'default'
  outcome: 'passed' | 'failed'
  selection: SelectionNote | null
  failed: string[] | 'all'
  elapsedSeconds: number | null
  recordedAt: string
}

/**
 * The test files that failed in one captured `bun test` run. A file counts
 * as failed when its own block (from its `<path>.test.<ext>:` header to the
 * next header) holds a `(fail)` line or an unhandled error. Relative headers
 * resolve against `cwd`. Returns `'all'` when `exitedNonZero` but no file
 * could be named, so a crash never turns into an empty re-run.
 */
export function parseFailedTestFiles(log: string, cwd: string, exitedNonZero: boolean): string[] | 'all' {
  const failed = new Set<string>()
  let current: string | null = null
  for (const raw of log.split('\n')) {
    const line = raw.trimEnd()
    const header = /^(\S.*\.test\.[a-zA-Z]+):$/.exec(line)
    if (header?.[1]) {
      current = isAbsolute(header[1]) ? header[1] : join(cwd, header[1])
      continue
    }
    if (current && (/^\(fail\) /.test(line) || line.startsWith('# Unhandled error'))) failed.add(current)
  }
  if (failed.size === 0) return exitedNonZero ? 'all' : []
  return [...failed].sort()
}

export type RerunInputs = {
  record: FailedTestsRecord | null
  head: string
  branch: string
  /** Whether `record.head` is an ancestor of (or equal to) `head`. */
  recordIsAncestor: boolean
  /** The full selection for this push (what today's hook would run). */
  fullSelection: string[]
  /** Test files selected for the files changed between `record.head` and `head` alone. */
  affectedSince: string[]
  /** Whether a path still exists — a failed test file deleted since sends the push back to its full selection. */
  exists: (path: string) => boolean
}

/**
 * The tests this push runs. A usable record (same branch, its commit still in
 * this branch's history, a named file list) gives the failed files plus the
 * files affected since; anything else gives the full selection — the wider,
 * safe answer.
 */
export function chooseTests(inputs: RerunInputs): SelectionNote {
  const { record, head, branch, fullSelection } = inputs
  const full: SelectionNote = {
    version: 1,
    mode: 'full',
    head,
    fullCount: fullSelection.length,
    selected: fullSelection
  }
  if (!record || record.failed === 'all') return full
  if (record.branch !== branch || !inputs.recordIsAncestor) return full
  // A refusal was recorded, so this push must run something: a failed file deleted since (which would let the push
  // pass having run nothing it refused for), or a re-run that comes out empty, takes the full selection instead.
  if (!record.failed.every(inputs.exists)) return full
  const rerunFailed = [...record.failed]
  // Deletions count as changes (they widen what is affected), but a deleted test file is never itself run.
  const affectedSince = inputs.affectedSince.filter(inputs.exists).sort()
  const selected = [...new Set([...rerunFailed, ...affectedSince])].sort()
  if (selected.length === 0) return full
  return {
    version: 1,
    mode: 'rerun',
    head,
    rerunOf: record.head,
    rerunFailed,
    affectedSince,
    fullCount: fullSelection.length,
    selected
  }
}

/** The record a refused run leaves, or `null` for a green run (which clears it). */
export function recordFromRun(
  outcome: 'passed' | 'failed',
  failed: string[] | 'all',
  head: string,
  branch: string,
  now: Date
): FailedTestsRecord | null {
  if (outcome === 'passed') return null
  return { version: 1, head, branch, failed, recordedAt: now.toISOString() }
}

/** Reads a JSON record, or `null` when missing, unreadable or of another shape. */
export function parseRecord(text: string | null): FailedTestsRecord | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Partial<FailedTestsRecord>
    if (value.version !== 1 || typeof value.head !== 'string' || typeof value.branch !== 'string') return null
    if (value.failed !== 'all' && !Array.isArray(value.failed)) return null
    return value as FailedTestsRecord
  } catch {
    return null
  }
}

// ── IO ──────────────────────────────────────────────────────────────────────

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return env
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: cleanGitEnv()
    }).trim()
  } catch {
    return null
  }
}

/** Absolute path of `name` under this worktree's git directory, or `null` outside a repository. */
export function gitPath(repoRoot: string, name: string): string | null {
  const out = git(repoRoot, ['rev-parse', '--git-path', name])
  if (!out) return null
  return isAbsolute(out) ? out : join(repoRoot, out)
}

export function currentHead(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', 'HEAD']) ?? ''
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? ''
}

export function isAncestor(repoRoot: string, ancestor: string, head: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, head], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: cleanGitEnv()
    })
    return true
  } catch {
    return false
  }
}

/** Absolute paths of files added, copied, modified, renamed or deleted between two commits. */
export function changedBetween(repoRoot: string, from: string, to: string): string[] {
  const out = git(repoRoot, ['diff', '--name-only', '--diff-filter=ACMRD', from, to]) ?? ''
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((f) => join(repoRoot, f))
}

export function readJsonUnderGit(repoRoot: string, name: string): string | null {
  const path = gitPath(repoRoot, name)
  if (!path || !existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function writeJsonUnderGit(repoRoot: string, name: string, value: unknown): void {
  const path = gitPath(repoRoot, name)
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function removeUnderGit(repoRoot: string, name: string): void {
  const path = gitPath(repoRoot, name)
  if (path) rmSync(path, { force: true })
}

/** The record left by this worktree's last refused push, if any. */
export function readFailedTestsRecord(repoRoot: string): FailedTestsRecord | null {
  return parseRecord(readJsonUnderGit(repoRoot, FAILED_TESTS_RECORD))
}

/** The last push's summary, if any — the loop's source for its ready-push and re-run Log events. */
export function readLastPushResult(repoRoot: string): LastPushResult | null {
  const text = readJsonUnderGit(repoRoot, LAST_PUSH_RESULT)
  if (!text) return null
  try {
    const value = JSON.parse(text) as LastPushResult
    return value.version === 1 ? value : null
  } catch {
    return null
  }
}
