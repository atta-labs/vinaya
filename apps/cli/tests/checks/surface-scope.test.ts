import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSurfaceScope } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'

const BIN_PATH = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-surface-scope.ts')

describe('surface-scope (O7) — the pure predicate', () => {
  it('refuses a changed file that falls inside a declared out: glob, naming both', () => {
    const result = checkSurfaceScope(['apps/cli/src/commands/foo.ts'], ['apps/cli/src/commands/**'])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.violations).toEqual([{ file: 'apps/cli/src/commands/foo.ts', glob: 'apps/cli/src/commands/**' }])
  })

  it('passes a changed file outside every out: glob', () => {
    const result = checkSurfaceScope(['apps/cli/src/lib/foo.ts'], ['apps/cli/src/commands/**'])
    expect(result.ok).toBe(true)
  })
})

describe('surface-scope check-bin — dormancy (no forge/network call unless the branch is a task branch)', () => {
  it('a branch not shaped like task/<tranche>/<n> stays dormant — exit 0, no output', () => {
    const root = join(tmpdir(), `vinaya-surface-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(root, { recursive: true })
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })

      const result = Bun.spawnSync(['bun', BIN_PATH], {
        cwd: root,
        env: { ...process.env, BRANCH: 'chore/not-a-task-branch' }
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a task-shaped branch with no resolvable repo stays dormant — exit 0, no output', () => {
    const root = join(tmpdir(), `vinaya-surface-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(root, { recursive: true })
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
      // No `origin` remote and no AEG_REPO — resolveRepo() returns null.

      const result = Bun.spawnSync(['bun', BIN_PATH], {
        cwd: root,
        env: { ...process.env, BRANCH: 'task/fixture-tranche/1', AEG_REPO: '' }
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe('')
      expect(result.stderr.toString()).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
