import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture'

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

  it('the source CLI executes a source check even beside an older unusable dist check (Issue #1036, O2)', () => {
    const staleDistCheck = join(REPO_ROOT, 'apps/cli/dist/checks/bin/check-pr-report-density.js')
    const original = statSync(staleDistCheck)
    try {
      chmodSync(staleDistCheck, 0o000)
      utimesSync(staleDistCheck, new Date(0), new Date(0))
      const result = spawnSyncBudgeted(process.execPath, ['apps/cli/src/index.ts', 'check', 'pr-report-density'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...stripVinayaEnv(),
          PR_BODY: '## Scope\n\nSource execution.\n<!-- AEG:TIER:START -->\n**Tier:** 0\n<!-- AEG:TIER:END -->'
        }
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('pr-report-density: pass')
    } finally {
      chmodSync(staleDistCheck, original.mode)
      utimesSync(staleDistCheck, original.atime, original.mtime)
    }
  })
})
