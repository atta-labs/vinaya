#!/usr/bin/env bun
/**
 * Tells a tag-only push of already-pushed commits apart from every other push,
 * so this repository's self-hosted pre-push hook can stop after the Vinaya
 * checks: a tag adds no code, and a commit the remote default branch already
 * reaches passed CI there.
 *
 * `isTagOnlyPushOfPushedCommits` is pure. A push qualifies only when it has at
 * least one ref line, every line's remote ref is under `refs/tags/` (a branch,
 * `refs/notes/*` or anything else disqualifies it), and every pushed tag's
 * commit is reached by the remote default branch. A tag deletion — an all-zero
 * local sha — pushes no commit and counts as reached. With no default branch
 * the answer is `false`: the push runs every step.
 *
 * The program beside it reads `VINAYA_PUSH_REFS` (never git's stdin, which the
 * checks step already consumed), reads the three local git facts the
 * `main-branch-refusal` check reads, resolves the default branch with its
 * `resolveDefaultBranch`, peels each pushed tag to its commit, and prints
 * `tags` for a qualifying push and nothing otherwise.
 */
import { execFileSync } from 'node:child_process'
import { resolveDefaultBranch } from '../pre-commit/main-branch-refusal.js'

const ZERO_SHA = /^0+$/

export function isTagOnlyPushOfPushedCommits(input: {
  pushRefs: string
  defaultBranch: string | null
  /** Whether the commit a pushed tag's local sha names is an ancestor of the remote default branch. */
  isReached: (localSha: string) => boolean
}): boolean {
  const { pushRefs, defaultBranch, isReached } = input
  if (defaultBranch === null) return false
  const lines = pushRefs
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return false
  return lines.every((line) => {
    const [, localSha, remoteRef] = line.split(/\s+/)
    if (localSha === undefined || remoteRef === undefined) return false
    if (!remoteRef.startsWith('refs/tags/')) return false
    return ZERO_SHA.test(localSha) || isReached(localSha)
  })
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function hasRef(ref: string): boolean {
  return git(['rev-parse', '--verify', '--quiet', ref]) !== null
}

function main(): void {
  const pushRefs = process.env.VINAYA_PUSH_REFS ?? ''
  const head = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const originHead = head === null || head === '' ? null : head.slice('origin/'.length) || null
  const defaultBranch = resolveDefaultBranch({
    originHead,
    hasOriginMain: hasRef('refs/remotes/origin/main'),
    hasOriginMaster: hasRef('refs/remotes/origin/master')
  })
  const answer = isTagOnlyPushOfPushedCommits({
    pushRefs,
    defaultBranch,
    isReached: (localSha) => {
      const commit = git(['rev-parse', '--verify', '--quiet', `${localSha}^{commit}`])
      if (commit === null || commit === '') return false
      return git(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${defaultBranch}`]) !== null
    }
  })
  if (answer) process.stdout.write('tags\n')
}

if (import.meta.main) main()
