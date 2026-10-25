#!/usr/bin/env node
/**
 * The pre-push hook's push mode. Three modes:
 *
 * - `storage` — a Developer's push to its task branch while no pull request
 *   is open (review locally, push once). Cheap checks only: no typecheck, no
 *   tests. Allowed only while no pull request is open for the branch, which
 *   this script confirms with the forge and refuses when it cannot.
 * - `ready` — the push made once both reviewers approved: the selected tests
 *   run, measured against the default branch rather than the branch's own
 *   upstream (which storage pushes already moved to the head).
 * - `default` — every other push, exactly as before.
 *
 * `VINAYA_PUSH_MODE` names `ready` or `default` only. Storage mode comes
 * from the worktree's own marker alone (`git rev-parse --git-path
 * vinaya/push-mode`, written by a run of version 2 and removed when that run
 * pauses, ends or opens its pull request), honoured only on that run's task
 * branch while its process is alive; anything else is `default`. Contract with the generated hook (`artifacts.ts`'s
 * `prePushBody`): prints the mode on STDOUT; exits 1, with the reason on
 * STDERR, when a storage push is not allowed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { currentBranch, gitPath } from './pre-push-failed-tests.js'
import { PUSH_MODE_MARKER, resolvePushMode } from './pre-push-mode-logic.js'

function liveOpenPullRequests(repoRoot: string, branch: string): number {
  const out = execFileSync(
    'gh',
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', 'length'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    }
  )
  const count = Number(out.trim())
  if (!Number.isInteger(count)) throw new Error(`gh answered ${JSON.stringify(out.trim())}`)
  return count
}

function main(): void {
  const repoRoot = process.cwd()
  const markerPath = gitPath(repoRoot, PUSH_MODE_MARKER)
  let marker: string | null = null
  if (markerPath && existsSync(markerPath)) {
    try {
      marker = readFileSync(markerPath, 'utf8')
    } catch {
      marker = null
    }
  }
  const branch = currentBranch(repoRoot)
  const resolved = resolvePushMode({
    envMode: process.env.VINAYA_PUSH_MODE,
    marker,
    branch,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    openPullRequests: () => liveOpenPullRequests(repoRoot, branch)
  })
  if (!resolved.ok) {
    process.stderr.write(`vinaya pre-push: refused — ${resolved.reason}\n`)
    process.exit(1)
  }
  process.stdout.write(`${resolved.mode}\n`)
}

main()
