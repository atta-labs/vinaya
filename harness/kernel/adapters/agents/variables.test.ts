import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantVariables } from './variables'

describe('grantVariables', () => {
  test('resolves every placeholder to a real path for a git worktree', () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'grant-wt-')))
    execFileSync('git', ['init', '-q', worktree])
    const runDir = mkdtempSync(join(tmpdir(), 'grant-run-'))
    const vars = grantVariables(worktree, runDir)
    expect(Object.keys(vars).sort()).toEqual(['BUN_INSTALL_CACHE', 'GIT_COMMON_DIR', 'SCRATCH', 'WORKTREE'])
    expect(vars.WORKTREE).toBe(worktree)
    expect(vars.SCRATCH).toBe(join(runDir, 'scratch'))
    expect(existsSync(vars.SCRATCH as string)).toBe(true)
    expect(vars.GIT_COMMON_DIR).toBe(join(worktree, '.git'))
    expect(existsSync(vars.GIT_COMMON_DIR as string)).toBe(true)
    expect(vars.BUN_INSTALL_CACHE).toBeTruthy()
  })

  test('a worktree that does not exist yet falls back to <worktree>/.git', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'grant-run-'))
    const missing = join(runDir, 'no-such-worktree')
    const vars = grantVariables(missing, runDir)
    expect(vars.WORKTREE).toBe(missing)
    expect(vars.GIT_COMMON_DIR).toBe(join(missing, '.git'))
    expect(existsSync(vars.SCRATCH as string)).toBe(true)
  })

  test('a worktree that does not exist yet takes the common directory of its repository', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'grant-repo-')))
    execFileSync('git', ['init', '-q', repo])
    const runDir = mkdtempSync(join(tmpdir(), 'grant-run-'))
    const vars = grantVariables(join(repo, '.worktrees', 'task', 'issue-9'), runDir, repo)
    expect(vars.GIT_COMMON_DIR).toBe(join(repo, '.git'))
  })
})
