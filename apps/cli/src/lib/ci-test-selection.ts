#!/usr/bin/env node
/**
 * A pull request's CI entrypoint into the test selector: what one `test-cli`
 * shard runs, and whether the shared-packages job may narrow to the packages
 * the diff affects. A push to `main` never calls this — it runs everything.
 *
 * The selection is the pre-push hook's own (`prePushSelection`), walked to
 * its full transitive closure instead of the hook's depth one. The selector
 * sees TypeScript imports and declared folder scans only, so the answer
 * narrows nothing unless every changed path is a kind it can see — a path
 * under the portal, under `.changeset/`, or a TypeScript source under
 * `apps/` or `packages/` outside a fixture folder and other than the test
 * preload, which no test imports. Any other changed path, a base commit that
 * does not resolve, a selection that throws, or a selection that saw no
 * changed file while git did means the whole shard and every package.
 *
 *   bun apps/cli/src/lib/ci-test-selection.ts --base <sha> --shard-list <file>
 *     prints the shard's paths to run, relative to `apps/cli`, one per line —
 *     empty when nothing in that shard is selected.
 *   bun apps/cli/src/lib/ci-test-selection.ts --base <sha> --packages
 *     prints `affected` when the shared-packages job may narrow, else `all`.
 *
 * The reason for the answer goes to STDERR, so the STDOUT a workflow captures
 * holds nothing else. Run from the repository root.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { prePushSelection } from './pre-push-selection.js'
import { changedFilesSinceRemoteBase, removedFilesSinceRemoteBase } from './remote-base.js'

/** The test preload every `apps/cli` test runs under, which no test imports. */
const TEST_PRELOAD = 'apps/cli/tests/lib/test-env-preload.ts'

/** The package folder a shard list's paths are relative to. */
const CLI_DIR = 'apps/cli'

/**
 * Whether a changed path, repository-root-relative, is one the selector can
 * judge: a path under the portal or under `.changeset/`, or a `.ts`/`.tsx`
 * file under `apps/` or `packages/` that is neither under a `fixtures/`
 * folder nor the test preload.
 */
export function isSelectablePath(path: string): boolean {
  if (path.startsWith('apps/vinaya-portal/') || path.startsWith('.changeset/')) return true
  if (!/^(apps|packages)\/.+\.tsx?$/.test(path)) return false
  if (/(^|\/)fixtures\//.test(path)) return false
  return path !== TEST_PRELOAD
}

/** What a pull request's selection decided: everything, with the reason, or a narrowed run. */
export type CiDecision = { scope: 'all'; reason: string } | { scope: 'selected'; selected: readonly string[] }

/** The facts a decision is made from, each read by {@link readCiFacts}. */
export type CiFacts = {
  /** Whether the base commit resolves to a commit (`git cat-file -e <base>^{commit}`). */
  baseResolves: boolean
  /** Every path `git diff --name-only --no-renames <base>...HEAD` lists, both sides of a rename included. */
  gitDiff: readonly string[]
  /** The changed and removed paths the selection itself read. */
  selectionChanged: readonly string[]
  /** The selection, run only when every other fact allows narrowing. Throws on any failure. */
  select: () => readonly string[]
}

/** Decides from the facts whether a pull request may run fewer tests than everything. */
export function decideCiSelection(facts: CiFacts): CiDecision {
  if (!facts.baseResolves) return { scope: 'all', reason: 'the base commit does not resolve' }
  const unseen = facts.gitDiff.filter((path) => !isSelectablePath(path))
  if (unseen.length > 0) {
    return { scope: 'all', reason: `the selector cannot judge ${unseen.length} changed path(s), first ${unseen[0]}` }
  }
  if (facts.selectionChanged.length === 0 && facts.gitDiff.length > 0) {
    return { scope: 'all', reason: 'the selection saw no changed file while git diff lists some' }
  }
  try {
    return { scope: 'selected', selected: facts.select() }
  } catch (err) {
    return { scope: 'all', reason: `the selection failed: ${(err as Error).message}` }
  }
}

/**
 * The shard list's entries to run: all of them under a run-everything
 * decision, otherwise only those the selection picked, in the list's order.
 * Shard entries are relative to `apps/cli`; the selection is absolute.
 */
export function shardFilesToRun(repoRoot: string, shardList: readonly string[], decision: CiDecision): string[] {
  if (decision.scope === 'all') return [...shardList]
  const picked = new Set(decision.selected.map((file) => relative(join(repoRoot, CLI_DIR), file)))
  return shardList.filter((entry) => picked.has(entry))
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Reads the facts for `base` from the repository. Unlike the hook's own git helpers, a git error here is never an empty answer. */
export function readCiFacts(repoRoot: string, base: string): CiFacts {
  let baseResolves = true
  try {
    git(repoRoot, ['cat-file', '-e', `${base}^{commit}`])
  } catch {
    baseResolves = false
  }
  if (!baseResolves) return { baseResolves, gitDiff: [], selectionChanged: [], select: () => [] }
  return {
    baseResolves,
    gitDiff: lines(git(repoRoot, ['diff', '--name-only', '--no-renames', `${base}...HEAD`])),
    selectionChanged: [...changedFilesSinceRemoteBase(repoRoot, base), ...removedFilesSinceRemoteBase(repoRoot, base)],
    select: () => prePushSelection(repoRoot, base, 'transitive').selected
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function main(argv: readonly string[]): void {
  const repoRoot = process.cwd()
  const base = argValue(argv, '--base')
  const shardListPath = argValue(argv, '--shard-list')
  const packages = argv.includes('--packages')
  if (!base || (!shardListPath && !packages)) {
    process.stderr.write('usage: ci-test-selection.ts --base <sha> (--shard-list <file> | --packages)\n')
    process.exit(2)
  }
  const started = performance.now()
  const decision = decideCiSelection(readCiFacts(repoRoot, base))
  const elapsed = (performance.now() - started).toFixed(0)
  const why = decision.scope === 'all' ? `everything: ${decision.reason}` : 'selected'
  if (packages) {
    process.stdout.write(`${decision.scope === 'all' ? 'all' : 'affected'}\n`)
    process.stderr.write(`vinaya ci: shared packages run ${why} [${elapsed} ms]\n`)
    return
  }
  const shardList = lines(readFileSync(shardListPath as string, 'utf8'))
  const run = shardFilesToRun(repoRoot, shardList, decision)
  for (const file of run) process.stdout.write(`${file}\n`)
  process.stderr.write(`vinaya ci: ${run.length} of ${shardList.length} shard file(s), ${why} [${elapsed} ms]\n`)
}

if (import.meta.main) main(process.argv.slice(2))
