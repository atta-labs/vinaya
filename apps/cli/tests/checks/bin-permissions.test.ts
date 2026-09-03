import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Every `apps/cli/src/checks/bin/*.ts` file must carry mode `100755` in the
 * git index — `check --all` on Linux with no `apps/cli/dist` present (what
 * `CI`'s own checkout has) spawns these files directly (`registry.ts`'s
 * `bin()` falls back to `src` when `dist` is absent), and `posix_spawn`
 * refuses a non-executable regular file with `EACCES` (round-2 ruling
 * addendum 2 — `check-doctrine-no-procedures.ts` was committed `100644`,
 * invisible locally because `apps/cli/dist/checks/bin/` exists in every
 * developer's own worktree, git-ignored, and `bin()` prefers it when
 * present, so the source file's mode is never exercised except on a clean
 * checkout with no build artifacts — exactly `CI`'s shape).
 */

const REPO_ROOT = join(import.meta.dir, '../../../..')

describe('every checks/bin executable carries mode 100755 in the git index', () => {
  it('git ls-files -s reports no non-executable entry', () => {
    const output = execFileSync('git', ['ls-files', '-s', 'apps/cli/src/checks/bin'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    })
    const nonExecutable = output
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.startsWith('100755'))
    expect(nonExecutable, output).toEqual([])
  })
})
