#!/usr/bin/env bun

/**
 * Core check: ci-shard-coverage. Every newly added CLI test must appear in
 * apps/cli/tests/ci-shards/shard-{1..6}.txt, and a CLI test the change
 * removes or moves away — to another owner, whose tests the repository's
 * test schedule places on its own — must leave those lists in the same
 * change, so no test is listed where it no longer is.
 *
 * Pre-commit reads added and removed files and shard lists from the index,
 * only when VINAYA_COMMIT_HOOK=1 and GIT_INDEX_FILE are both set. Pre-push
 * and CI read branch additions and removals against the resolved base and
 * shard lists from HEAD. If no branch diff resolves, judge every CLI test
 * tracked at HEAD, and every listed path against them, instead of treating
 * an indeterminate diff as clean.
 *
 * scope: diff, local-only git reads, never the network.
 */

import { execFileSync } from 'node:child_process'
import { resolveAddedFiles } from '../../lib/diff-evidence'
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

function pathLines(out: string | null): string[] {
  if (out === null || out === '') return []
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Repo-root-relative paths newly added to the index for this commit. */
function stagedAddedFiles(): string[] {
  return pathLines(git(['diff', '--cached', '--name-only', '--diff-filter=A']))
}

/** Repo-root-relative paths this commit removes from the index, a rename's old path among them. */
function stagedRemovedFiles(): string[] {
  return pathLines(git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D']))
}

/**
 * Paths the branch removes against the first base candidate that resolves
 * and has a merge base — the same candidates `resolveAddedFiles` tries — or
 * `null` when none does.
 */
function branchRemovedFiles(): string[] | null {
  const head = git(['rev-parse', '--verify', 'HEAD'])
  for (const ref of new Set([process.env.BASE_SHA || 'origin/main', 'origin/main', 'main'])) {
    const resolved = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (resolved === null || resolved === '' || resolved === head) continue
    const out = git(['diff', '--name-only', '--no-renames', '--diff-filter=D', `${ref}...HEAD`])
    if (out !== null) return pathLines(out)
  }
  return null
}

/** The INDEX content of `apps/cli/<relPath>`, or `null` when it isn't staged/tracked. */
function stagedCliFileContent(relPath: string): string | null {
  return git(['show', `:${CLI_PREFIX}${relPath}`])
}

function main(): void {
  const preCommit = process.env.VINAYA_COMMIT_HOOK === '1' && Boolean(process.env.GIT_INDEX_FILE)
  const files = preCommit ? stagedAddedFiles() : resolveAddedFiles()
  const tracked = files === null ? git(['ls-tree', '-r', '--name-only', 'HEAD', '--', CLI_PREFIX]) : null
  if (files === null && tracked === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: 'Cannot resolve the branch diff or enumerate CLI tests tracked at HEAD.',
      agent_recovery_prompt: 'Restore readable git history and run the check again.'
    })
    process.exit(1)
  }
  const cliTests = (paths: readonly string[]) =>
    paths
      .filter((p) => p.startsWith(CLI_PREFIX))
      .map((p) => p.slice(CLI_PREFIX.length))
      .filter(isCliTestFile)
  const addedTestFiles = cliTests(files ?? (tracked || '').split('\n'))
  // With no resolvable diff, every listed path is judged against the tracked tests instead.
  const removedTestFiles =
    files === null ? [] : cliTests((preCommit ? stagedRemovedFiles() : branchRemovedFiles()) ?? [])

  if (addedTestFiles.length === 0 && removedTestFiles.length === 0 && files !== null) {
    process.stdout.write(`${CHECK_NAME}: no CLI test file to judge\n`)
    process.exit(0)
  }

  const shardRelPaths = Array.from({ length: CI_SHARD_COUNT }, (_, i) => shardFileRelPath(i + 1))
  const shardMembers = new Set<string>()
  for (const rel of shardRelPaths) {
    const content = preCommit ? stagedCliFileContent(rel) : git(['show', `HEAD:${CLI_PREFIX}${rel}`])
    if (content === null) continue
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) shardMembers.add(trimmed)
    }
  }

  const missing = addedTestFiles.filter((f) => !shardMembers.has(f))
  const trackedTests = new Set(addedTestFiles)
  const stale = [
    ...removedTestFiles.filter((f) => shardMembers.has(f)),
    ...(files === null ? [...shardMembers].filter((f) => !trackedTests.has(f)) : [])
  ].sort()

  process.stdout.write(
    `${CHECK_NAME}: ${addedTestFiles.length} CLI test file(s) judged from ${preCommit ? 'index' : 'HEAD'}; ${missing.length} missing from a shard; ${stale.length} listed but no longer there\n`
  )

  const shardPaths = shardRelPaths.map((rel) => `${CLI_PREFIX}${rel}`)
  for (const file of stale) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `${CLI_PREFIX}${file} is listed in a CI shard (${shardPaths.join(', ')}) but is no longer a CLI test file — removed, or moved to another owner.`,
      file: `${CLI_PREFIX}${file}`,
      agent_recovery_prompt: `Remove the "${file}" line from its shard file in the same change. A test moved to another owner needs no line: the repository's test schedule places it.`
    })
  }
  for (const file of missing) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `${CLI_PREFIX}${file} is a CLI test file not listed in any CI shard (${shardPaths.join(', ')}).`,
      file: `${CLI_PREFIX}${file}`,
      agent_recovery_prompt: `Add "${file}" as its own line to one of ${shardPaths.join(', ')}, stage that shard file, and commit the update.`
    })
  }

  process.exit(missing.length > 0 || stale.length > 0 ? 1 : 0)
}

main()
