/**
 * The one rule for "is this a CLI test file that must be listed in a CI
 * shard" — shared by `tests/ci-shards.test.ts` (which enforces it over every
 * file on disk, at push/CI time) and `checks/bin/check-ci-shard-coverage.ts`
 * (which enforces the same rule over a commit's staged diff, at commit time).
 * A second, independent definition of this rule is exactly what let the two
 * enforcement points drift apart; this file is the fix for that shape, not
 * just for this task's own check.
 */

/** Number of `shard-N.txt` files under `CI_SHARD_DIR_REL`. */
export const CI_SHARD_COUNT = 3

/** `tests/ci-shards/`, relative to `apps/cli/`. */
export const CI_SHARD_DIR_REL = 'tests/ci-shards'

/** `tests/ci-shards/shard-2.txt`, relative to `apps/cli/`. */
export function shardFileRelPath(n: number): string {
  return `${CI_SHARD_DIR_REL}/shard-${n}.txt`
}

/**
 * True for `relPath` (relative to `apps/cli/`, POSIX-separated) being a CLI
 * test file that must appear in exactly one shard file — a `*.test.ts` path
 * not under a `node_modules` or `dist` directory at any depth.
 */
export function isCliTestFile(relPath: string): boolean {
  if (!relPath.endsWith('.test.ts')) return false
  const segments = relPath.split('/')
  return !segments.includes('node_modules') && !segments.includes('dist')
}
