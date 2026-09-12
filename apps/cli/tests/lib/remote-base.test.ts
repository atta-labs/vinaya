// task-run-v1 20, O5/O6 — real git repos, never mocked: a bare "remote", a
// clone with an upstream, and a fresh repo with no remote at all, proving
// the fallback chain actually falls back rather than just reading right on
// the happy path.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedFilesSinceRemoteBase, resolveRemoteBase } from '../../src/lib/remote-base'

// This suite's own process (`bun test`) can itself be running INSIDE a git
// hook — the pre-push hook this very selector feeds runs the affected suite
// before the push it's part of ever leaves the machine. A hook's invoking
// git sets GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE for ITS OWN repo, and those
// inherit into any child `git` command that doesn't build its own explicit
// `env` — confirmed live, expensively: a "no remote at all" fixture, cwd in
// a fresh tmpdir with no remote configured, resolved `@{u}` to THIS
// BRANCH'S real upstream, and four of this suite's real `git commit` calls
// landed as genuine commits on it — the worktree needed a `git reset --hard`
// to its last real commit to recover. `resolveRemoteBase`/
// `changedFilesSinceRemoteBase` themselves now build the same clean `env`
// internally (`remote-base.ts`'s own `cleanGitEnv`) for every call they
// make, so the direct, in-process calls to them below are covered by that
// fix; this file's OWN setup calls (`git init`/`commit`/`push` against the
// fixtures) need the identical treatment for the same reason. A same-process
// mutation of `process.env` was tried first and does NOT work on this
// runtime — a child process spawned afterward still saw the ORIGINAL
// `GIT_DIR`, proving `execFileSync`'s default env inheritance reads a
// snapshot taken at process start, not the live object. The fix has to be
// an explicit `env` at every call site, never a deletion anywhere earlier.
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env }
for (const key of Object.keys(GIT_ENV)) {
  if (key.startsWith('GIT_')) delete GIT_ENV[key]
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim()
}

function initRepo(dir: string): void {
  git(dir, ['init', '--quiet', '--initial-branch=main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
}

function commit(dir: string, file: string, content: string, message: string): void {
  writeFileSync(join(dir, file), content)
  git(dir, ['add', '--', file])
  git(dir, ['commit', '--quiet', '-m', message])
}

describe('resolveRemoteBase / changedFilesSinceRemoteBase (task-run-v1 20, O5/O6)', () => {
  it('with a configured upstream, resolves it and diffs against it', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-bare-'))
    git(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main'])

    const cloneDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-clone-'))
    git(cloneDir, ['clone', '--quiet', bareDir, '.'])
    git(cloneDir, ['config', 'user.email', 'test@example.com'])
    git(cloneDir, ['config', 'user.name', 'Test'])
    commit(cloneDir, 'a.txt', 'one\n', 'Initial commit')
    git(cloneDir, ['push', '--quiet', '-u', 'origin', 'main'])

    // Local commit not yet pushed — exactly the pre-push moment this exists for.
    commit(cloneDir, 'b.txt', 'two\n', 'Second commit')

    try {
      expect(resolveRemoteBase(cloneDir)).toBe('origin/main')
      expect(changedFilesSinceRemoteBase(cloneDir)).toEqual(['b.txt'])
    } finally {
      rmSync(bareDir, { recursive: true, force: true })
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('with no upstream but a resolvable origin/main, falls back to it', () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-bare-'))
    git(bareDir, ['init', '--quiet', '--bare', '--initial-branch=main'])

    const cloneDir = mkdtempSync(join(tmpdir(), 'vinaya-remote-clone-'))
    initRepo(cloneDir)
    git(cloneDir, ['remote', 'add', 'origin', bareDir])
    commit(cloneDir, 'a.txt', 'one\n', 'Initial commit')
    git(cloneDir, ['push', '--quiet', 'origin', 'main']) // no -u: no upstream tracking set
    commit(cloneDir, 'c.txt', 'three\n', 'Untracked-upstream commit')

    try {
      expect(resolveRemoteBase(cloneDir)).toBe('origin/main')
      expect(changedFilesSinceRemoteBase(cloneDir)).toEqual(['c.txt'])
    } finally {
      rmSync(bareDir, { recursive: true, force: true })
      rmSync(cloneDir, { recursive: true, force: true })
    }
  })

  it('with no remote at all, falls back to the previous commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-remote-none-'))
    initRepo(dir)
    commit(dir, 'a.txt', 'one\n', 'Initial commit')
    commit(dir, 'd.txt', 'four\n', 'Second commit, still local-only')

    try {
      expect(resolveRemoteBase(dir)).toBe('HEAD~1')
      expect(changedFilesSinceRemoteBase(dir)).toEqual(['d.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a deleted file is never reported — nothing left to lint or test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-remote-delete-'))
    initRepo(dir)
    commit(dir, 'a.txt', 'one\n', 'Initial commit')
    commit(dir, 'b.txt', 'two\n', 'Add b')
    git(dir, ['rm', '--quiet', 'b.txt'])
    git(dir, ['commit', '--quiet', '-m', 'Remove b'])

    try {
      expect(changedFilesSinceRemoteBase(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
