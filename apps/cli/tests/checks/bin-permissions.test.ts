import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
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

/** Removes `dir` and its parents up to and including `top`, stopping at the first one that is not empty. */
function removeEmptyDirs(dir: string, top: string | undefined): void {
  if (!top) return
  for (let current = dir; current.startsWith(top); current = dirname(current)) {
    try {
      rmdirSync(current)
    } catch {
      return
    }
    if (current === top) return
  }
}

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
    // A checkout with no build has no dist check to stand beside the source one, so the test
    // writes its own and removes it, and every folder it had to create, afterwards.
    const provided = !existsSync(staleDistCheck)
    const createdDir = provided ? mkdirSync(dirname(staleDistCheck), { recursive: true }) : undefined
    if (provided) writeFileSync(staleDistCheck, 'throw new Error("stale dist check")\n')
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
      if (provided) {
        rmSync(staleDistCheck, { force: true })
        removeEmptyDirs(dirname(staleDistCheck), createdDir)
      } else {
        chmodSync(staleDistCheck, original.mode)
        utimesSync(staleDistCheck, original.atime, original.mtime)
      }
    }
  })
})

describe('every built dist/checks/bin script loads under node and bun', () => {
  it('carries no __require.main and raises no load-time ReferenceError', () => {
    const build = spawnSyncBudgeted('bun', ['run', '--cwd', 'apps/cli', 'build'], { cwd: REPO_ROOT, encoding: 'utf8' })
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)
    const binDir = join(REPO_ROOT, 'apps/cli/dist/checks/bin')
    const files = readdirSync(binDir).filter((f) => f.endsWith('.js'))
    expect(files).toContain('verify-dispatch.js')
    for (const file of files) {
      const path = join(binDir, file)
      expect(readFileSync(path, 'utf8'), `${file} carries __require.main`).not.toContain('__require.main')
      for (const runtime of ['node', 'bun']) {
        // A script started with no arguments runs its body against closed stdin; only a load-time
        // error is under test, so the exit status is not asserted.
        // The verification tools bundled for the finding counts run a full repository sweep when
        // started as a script, so they are only imported: that still raises any load-time error.
        const importOnly = file === 'verify-docs.js' || file === 'verify-coherence.js'
        const result = spawnSyncBudgeted(
          runtime,
          importOnly
            ? runtime === 'node'
              ? ['--input-type=module', '-e', `await import(${JSON.stringify(path)})`]
              : ['-e', `await import(${JSON.stringify(path)})`]
            : [path],
          { cwd: REPO_ROOT, encoding: 'utf8', input: '', env: stripVinayaEnv() },
          30000
        )
        expect(`${result.stderr}`, `${file} under ${runtime}`).not.toContain('ReferenceError')
      }
    }
  }, 300000)
})
