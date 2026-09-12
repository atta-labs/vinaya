import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSurfaceScope } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'

const BIN_PATH = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-surface-scope.ts')

function writeFakeGh(dir: string, body: string): void {
  const p = join(dir, 'gh')
  writeFileSync(
    p,
    `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  printf '%s' '${body.replace(/'/g, "'\\''")}'
  exit 0
fi
echo "unhandled fake gh call in surface-scope issue-mode test: $*" >&2
exit 1
`
  )
  chmodSync(p, 0o755)
}

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

describe('surface-scope check-bin — dormancy is narrowed to ONE reason: not a task branch at all', () => {
  it('a branch not shaped like task/<tranche>/<n> stays dormant — exit 0, no output, no network/forge call attempted', () => {
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
})

describe('surface-scope check-bin — a backlog Issue branch (task/issue-<n>) resolves directly, no topology lookup (task-run-v1 21, #541, O2, round 2 review MAJOR)', () => {
  it('a task/issue-<n> branch with no AEG_REPO and no origin remote still checks scope — the Issue number IS the branch, no forge/topology resolution needed', () => {
    const root = join(tmpdir(), `vinaya-surface-scope-issue-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const binDir = join(tmpdir(), `vinaya-surface-scope-issue-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(root, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
      execFileSync('git', ['checkout', '-q', '-b', 'task/issue-541'], { cwd: root })
      mkdirSync(join(root, 'packages', 'aeg-forge-state'), { recursive: true })
      writeFileSync(join(root, 'packages', 'aeg-forge-state', 'out-of-scope.ts'), 'export {}\n')
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Feat: an out-of-scope change'], { cwd: root })

      writeFakeGh(
        binDir,
        JSON.stringify({
          body: '## Surface\n\nin: apps/cli/src\nout: packages/aeg-forge-state\n'
        })
      )

      const result = Bun.spawnSync(['bun', BIN_PATH], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          BRANCH: 'task/issue-541',
          BASE_SHA: 'main',
          // No AEG_REPO, no origin remote — the tranche path would refuse
          // here (as the sibling describe block below proves); the
          // issue-mode path must never even attempt that resolution.
          AEG_REPO: ''
        }
      })
      expect(result.exitCode).toBe(1)
      const line = result.stderr.toString().trim()
      const error = JSON.parse(line)
      expect(error.check).toBe('surface-scope')
      // Names Issue #541 — the branch's OWN number — never a topology-
      // resolved one (there is no topology involved at all on this path).
      expect(error.message).toContain("Issue #541's `## Surface` `out:`")
      expect(error.message).toContain('packages/aeg-forge-state/out-of-scope.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('passes when the changed file falls outside the Issue-resolved out: globs', () => {
    const root = join(tmpdir(), `vinaya-surface-scope-issue-pass-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const binDir = join(
      tmpdir(),
      `vinaya-surface-scope-issue-pass-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(root, { recursive: true })
    mkdirSync(binDir, { recursive: true })
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
      execFileSync('git', ['checkout', '-q', '-b', 'task/issue-541'], { cwd: root })
      mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true })
      writeFileSync(join(root, 'apps', 'cli', 'src', 'in-scope.ts'), 'export {}\n')
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Feat: an in-scope change'], { cwd: root })

      writeFakeGh(
        binDir,
        JSON.stringify({
          body: '## Surface\n\nin: apps/cli/src\nout: packages/aeg-forge-state\n'
        })
      )

      const result = Bun.spawnSync(['bun', BIN_PATH], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          BRANCH: 'task/issue-541',
          BASE_SHA: 'main',
          AEG_REPO: ''
        }
      })
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})

describe('surface-scope check-bin — every OTHER resolution failure now REFUSES, naming what failed (Principal ruling, task plan-brief-v1 8)', () => {
  it('a task-shaped branch with no resolvable repo refuses, naming the repo lookup', () => {
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
      expect(result.exitCode).toBe(1)
      const line = result.stderr.toString().trim()
      const error = JSON.parse(line)
      expect(error.check).toBe('surface-scope')
      expect(error.message).toContain('owner/repo could not be resolved')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a task-shaped branch whose forge lookup fails refuses, naming the tranche it could not resolve', () => {
    const root = join(tmpdir(), `vinaya-surface-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(root, { recursive: true })
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      writeFileSync(join(root, 'README.md'), '# fixture\n')
      execFileSync('git', ['add', 'README.md'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
      // A resolvable owner/repo that does not exist — the forge lookup itself fails.

      const result = Bun.spawnSync(['bun', BIN_PATH], {
        cwd: root,
        env: {
          ...process.env,
          BRANCH: 'task/fixture-tranche/1',
          AEG_REPO: 'attalabs-fixture-nonexistent/vinaya-fixture-nonexistent'
        }
      })
      expect(result.exitCode).toBe(1)
      // The forge adapter's own `gh api` failure writes its own line to
      // stderr first (e.g. `gh: Not Found (HTTP 404)`) — find this check's
      // JSON line rather than assuming it is the only line.
      const jsonLine = result.stderr
        .toString()
        .split('\n')
        .find((l) => l.trimStart().startsWith('{'))
      const error = JSON.parse(jsonLine ?? '')
      expect(error.check).toBe('surface-scope')
      expect(error.message).toContain('fixture-tranche')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
