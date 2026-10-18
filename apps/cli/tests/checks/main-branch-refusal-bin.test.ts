import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coreCheckRegistry } from '../../src/checks/registry'
import { runChecks } from '../../src/checks/runner'

// Bin-level tests for check-main-branch-refusal.ts: scratch repositories with
// no network and an isolated git configuration, so the developer's own
// `init.defaultBranch` never decides a case.

const BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-main-branch-refusal.ts')

let roots: string[] = []

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

function isolatedEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1'
  }
}

function git(cwd: string, home: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: isolatedEnv(home) }).trim()
}

/** A scratch repository on `branch` with one commit; `home` is its own isolated HOME. */
function newRepo(branch: string): { dir: string; home: string } {
  const raw = join(tmpdir(), `vinaya-main-branch-refusal-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(raw, { recursive: true })
  const base = realpathSync(raw)
  const home = join(base, 'home')
  const dir = join(base, 'repo')
  mkdirSync(home, { recursive: true })
  mkdirSync(dir, { recursive: true })
  roots.push(base)
  git(dir, home, ['init', '-q', '-b', branch])
  git(dir, home, ['config', 'user.email', 't@example.com'])
  git(dir, home, ['config', 'user.name', 't'])
  git(dir, home, ['commit', '-q', '--allow-empty', '-m', 'init'])
  return { dir, home }
}

function runBin(dir: string, home: string): { status: number | null; out: string } {
  const r = spawnSync('bun', [BIN], { cwd: dir, encoding: 'utf8', env: isolatedEnv(home) })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('check-main-branch-refusal bin', () => {
  it('refuses on main when only refs/remotes/origin/main exists', () => {
    const { dir, home } = newRepo('main')
    git(dir, home, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    const r = runBin(dir, home)
    expect(r.status).toBe(1)
    expect(r.out).toContain('default branch')
  })

  it('refuses on master when only refs/remotes/origin/master exists', () => {
    const { dir, home } = newRepo('master')
    git(dir, home, ['update-ref', 'refs/remotes/origin/master', 'HEAD'])
    expect(runBin(dir, home).status).toBe(1)
  })

  it('passes with a warning on main with no remote, even with init.defaultBranch=main', () => {
    const { dir, home } = newRepo('main')
    git(dir, home, ['config', 'init.defaultBranch', 'main'])
    const r = runBin(dir, home)
    expect(r.status).toBe(0)
    expect(r.out).toContain('could not determine')
  })

  it('passes with a warning when nothing resolves', () => {
    const { dir, home } = newRepo('main')
    const r = runBin(dir, home)
    expect(r.status).toBe(0)
    expect(r.out).toContain('warning')
    expect(r.out).toContain('could not determine')
  })

  it('passes on a detached HEAD even when the default branch resolves', () => {
    const { dir, home } = newRepo('main')
    git(dir, home, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(dir, home, ['checkout', '-q', '--detach'])
    expect(runBin(dir, home).status).toBe(0)
  })

  it('passes on another branch', () => {
    const { dir, home } = newRepo('main')
    git(dir, home, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(dir, home, ['checkout', '-q', '-b', 'task/x/1'])
    expect(runBin(dir, home).status).toBe(0)
  })
})

describe('main-branch-refusal under the commit hook flags', () => {
  it('runs, and is not skipped, with --diff-only and --skip-full', async () => {
    const { dir, home } = newRepo('main')
    git(dir, home, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    const spec = coreCheckRegistry().filter((s) => s.name === 'main-branch-refusal')
    expect(spec).toHaveLength(1)
    const cwd = process.cwd()
    const prevHome = process.env.HOME
    process.chdir(dir)
    process.env.HOME = home
    try {
      const [outcome] = await runChecks(spec, {
        parallel: 1,
        diffOnly: true,
        changedFiles: ['README.md'],
        defaultTimeoutMs: 30_000,
        skipFull: true,
        localOnly: true
      })
      expect(outcome?.status).not.toBe('skipped')
      expect(outcome?.status).toBe('fail')
    } finally {
      process.chdir(cwd)
      if (prevHome === undefined) process.env.HOME = undefined
      else process.env.HOME = prevHome
    }
  })
})
