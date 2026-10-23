import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  noPushPauseDetail,
  readUnpushedWorkDetail,
  unpushedFailureMessage,
  unpushedWorkResumeDetail
} from '../../../src/lib/dev-review-loop/unpushed-work.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A clone whose `main` tracks a bare remote, so `@{u}` resolves. */
function trackedClone(): { dir: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'unpushed-work-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const dir = join(root, 'work')
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  run(root, 'init', '-q', '--bare', '-b', 'main', remote)
  run(root, 'clone', '-q', remote, dir)
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  run(dir, 'add', '-A')
  run(dir, 'commit', '-q', '-m', 'base')
  run(dir, 'push', '-q', '-u', 'origin', 'HEAD:main')
  return { dir, git: (...args) => run(dir, ...args) }
}

describe('readUnpushedWorkDetail', () => {
  test('a clean worktree level with its upstream holds no unpushed work', () => {
    const { dir } = trackedClone()
    expect(readUnpushedWorkDetail(dir)).toEqual({ dirtyFiles: [], aheadCount: 0 })
  })

  test('an unstaged modification keeps its whole file name, the porcelain leading space included', () => {
    const { dir } = trackedClone()
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'new.txt'), 'new\n')
    expect(readUnpushedWorkDetail(dir).dirtyFiles.sort()).toEqual(['a.txt', 'new.txt'])
  })

  test('commits ahead of the upstream are counted', () => {
    const { dir, git } = trackedClone()
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'ahead')
    expect(readUnpushedWorkDetail(dir)).toEqual({ dirtyFiles: [], aheadCount: 1 })
  })

  test('no upstream and an unreadable path read as nothing unpushed, never a throw', () => {
    const { dir, git } = trackedClone()
    git('checkout', '-q', '-b', 'no-upstream')
    expect(readUnpushedWorkDetail(dir).aheadCount).toBe(0)
    expect(readUnpushedWorkDetail(join(dir, 'missing'))).toEqual({ dirtyFiles: [], aheadCount: 0 })
  })
})

describe('the texts that name unpushed work', () => {
  test('the no_push detail names only what is really unpushed', () => {
    expect(noPushPauseDetail('task/x/1', { dirtyFiles: ['a.ts'], aheadCount: 0 })).toBe(
      'branch task/x/1; dirty file(s): a.ts'
    )
    expect(noPushPauseDetail('task/x/1', { dirtyFiles: [], aheadCount: 2 })).toBe(
      'branch task/x/1; 2 commit(s) ahead of the remote'
    )
  })

  test('the resume detail and the failure message read the branch they are given', () => {
    expect(unpushedWorkResumeDetail({ dirtyFiles: [], aheadCount: 1 })).toBe(
      '1 commit(s) ahead of the remote, worktree clean'
    )
    expect(unpushedFailureMessage('task/x/1', 'abc1234', { dirtyFiles: [], aheadCount: 1 })).toBe(
      'push never landed on task/x/1: head abc1234 unchanged; 1 commit(s) ahead of the remote, worktree clean'
    )
  })
})
