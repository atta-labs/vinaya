#!/usr/bin/env bun

/**
 * Core check: ci-shard-coverage. Every newly added CLI test must appear in
 * apps/cli/tests/ci-shards/shard-{1..6}.txt.
 *
 * Pre-commit reads added files and shard lists from the index, only when
 * VINAYA_COMMIT_HOOK=1 and GIT_INDEX_FILE are both set. Pre-push and CI read
 * branch additions against the resolved base and shard lists from HEAD.
 * If no branch diff resolves, judge every CLI test tracked at HEAD instead
 * of treating an indeterminate diff as clean.
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
  const addedTestFiles = (files ?? (tracked || '').split('\n'))
    .filter((p) => p.startsWith(CLI_PREFIX))
    .map((p) => p.slice(CLI_PREFIX.length))
    .filter(isCliTestFile)

  if (addedTestFiles.length === 0) {
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

  process.stdout.write(
    `${CHECK_NAME}: ${addedTestFiles.length} CLI test file(s) judged from ${preCommit ? 'index' : 'HEAD'}; ${missing.length} missing from a shard\n`
  )

  const shardPaths = shardRelPaths.map((rel) => `${CLI_PREFIX}${rel}`)
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

  process.exit(missing.length > 0 ? 1 : 0)
}

main()
