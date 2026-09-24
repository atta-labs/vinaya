#!/usr/bin/env bun

/**
 * Core check: ci-shard-coverage. Refuses a commit that stages a new CLI test
 * file (`apps/cli/**\/*.test.ts`) not listed in any of
 * `apps/cli/tests/ci-shards/shard-{1,2,3}.txt` — the same membership rule
 * `tests/ci-shards.test.ts` enforces over every file on disk, at push time.
 * That test only runs on the one push (`3`+ minutes observed for the full
 * affected suite), so a Developer who forgets the shard line pays a whole
 * pre-push run to learn it. This check runs the same rule over the STAGED
 * diff, in the pre-commit hook, in seconds.
 *
 * Reads the git INDEX, never `resolveChangedFiles()`
 * (`../../lib/diff-evidence.ts`)'s committed `base...HEAD` diff: at
 * pre-commit time the commit being made has no SHA yet, so a file staged for
 * THIS commit is invisible to a committed-history diff. `git diff --cached`
 * is the diff that actually contains it. For the same reason, a shard file's
 * membership is read from the INDEX (`git show :<path>`), not from `HEAD` or
 * the working tree — the passing case stages the new test file and its
 * shard line together, in the same commit, before either is committed.
 *
 * Only newly ADDED CLI test files are judged (`--diff-filter=A`) — a
 * modified existing one is already covered by `ci-shards.test.ts` itself,
 * which this check does not duplicate.
 *
 * scope: diff, local-only: `git diff --cached`/`git show :<path>` only,
 * never the network.
 */

import { execFileSync } from 'node:child_process'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { CI_SHARD_COUNT, isCliTestFile, shardFileRelPath } from '../../lib/ci-shard-membership'

const CHECK_NAME = 'ci-shard-coverage'
const CLI_PREFIX = 'apps/cli/'

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

/** Repo-root-relative paths newly added to the index for this commit. */
function stagedAddedFiles(): string[] {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=A'])
  if (out === null || out === '') return []
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** The INDEX content of `apps/cli/<relPath>`, or `null` when it isn't staged/tracked. */
function stagedCliFileContent(relPath: string): string | null {
  return git(['show', `:${CLI_PREFIX}${relPath}`])
}

function main(): void {
  const addedTestFiles = stagedAddedFiles()
    .filter((p) => p.startsWith(CLI_PREFIX))
    .map((p) => p.slice(CLI_PREFIX.length))
    .filter(isCliTestFile)

  if (addedTestFiles.length === 0) {
    process.stdout.write(`${CHECK_NAME}: no new CLI test file staged in this commit\n`)
    process.exit(0)
  }

  const shardRelPaths = Array.from({ length: CI_SHARD_COUNT }, (_, i) => shardFileRelPath(i + 1))
  const shardMembers = new Set<string>()
  for (const rel of shardRelPaths) {
    const content = stagedCliFileContent(rel)
    if (content === null) continue
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) shardMembers.add(trimmed)
    }
  }

  const missing = addedTestFiles.filter((f) => !shardMembers.has(f))

  process.stdout.write(
    `${CHECK_NAME}: ${addedTestFiles.length} new CLI test file(s) staged; ${missing.length} missing from a shard\n`
  )

  const shardPaths = shardRelPaths.map((rel) => `${CLI_PREFIX}${rel}`)
  for (const file of missing) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `${CLI_PREFIX}${file} is a new CLI test file not listed in any CI shard (${shardPaths.join(', ')}).`,
      file: `${CLI_PREFIX}${file}`,
      agent_recovery_prompt: `Add "${file}" as its own line to one of ${shardPaths.join(', ')}, stage that shard file, and commit again.`
    })
  }

  process.exit(missing.length > 0 ? 1 : 0)
}

main()
