import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitMsgCommand } from '../src/commands/commit-msg.js'
import { fixtureDir } from './lib/test-temp-fixture'

let dir: string

/** Capture process.stderr.write output during `fn`, returning the output. */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr)
  let buf = ''
  process.stderr.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return buf
}

function messageFile(content: string): string {
  const path = join(dir, 'COMMIT_EDITMSG')
  writeFileSync(path, content)
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vinaya-commit-msg-'))
  // `process.exitCode = undefined` does not clear a previously-set code (Node
  // ignores the assignment) — `0` is the only value that actually resets it.
  process.exitCode = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  process.exitCode = 0
})

describe('vinaya commit-msg (Issue #63)', () => {
  it('accepts a conforming message, exits 0, and prints nothing — a chatty hook on every commit is adoption poison', () => {
    const stderr = captureStderr(() => commitMsgCommand([messageFile('Fix(cli): Refuse a malformed commit message\n')]))
    expect(stderr).toBe('')
    expect(process.exitCode).toBe(0)
  })

  it('accepts `Plan(scope): …` — the shared list, not a narrower hand-authored one', () => {
    captureStderr(() => commitMsgCommand([messageFile('Plan(cli): Sketch the commit-msg hook\n')]))
    expect(process.exitCode).toBe(0)
  })

  it('accepts every type in the shared commitlint-plus-Plan vocabulary', () => {
    const types = ['Build', 'Chore', 'Docs', 'Feat', 'Fix', 'Perf', 'Plan', 'Refactor', 'Revert', 'Style', 'Test']
    for (const type of types) {
      process.exitCode = 0
      captureStderr(() => commitMsgCommand([messageFile(`${type}(cli): Do the thing\n`)]))
      expect(process.exitCode).toBe(0)
    }
  })

  it('rejects a message with no type prefix, exits 1, and names the expected shape', () => {
    const stderr = captureStderr(() => commitMsgCommand([messageFile('fixed stuff\n')]))
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain('Type: Description')
    expect(stderr).toContain('Type(scope): Description')
  })

  it('rejects a type not in the shared vocabulary', () => {
    captureStderr(() => commitMsgCommand([messageFile('Improvement(cli): Do the thing\n')]))
    expect(process.exitCode).toBe(1)
  })

  it('rejects lower-case type (not start-case)', () => {
    captureStderr(() => commitMsgCommand([messageFile('fix(cli): Do the thing\n')]))
    expect(process.exitCode).toBe(1)
  })

  it('validates only the first line — a conforming subject with a malformed body still passes', () => {
    captureStderr(() =>
      commitMsgCommand([messageFile('Fix(cli): Do the thing\n\nnotes go here, no convention applies\n')])
    )
    expect(process.exitCode).toBe(0)
  })

  it('ignores a source keyword — only the merge in progress exempts a message', () => {
    captureStderr(() => commitMsgCommand([messageFile('fixed stuff\n'), 'merge']))
    expect(process.exitCode).toBe(1)
  })

  describe('in a git repository', () => {
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    let repo: string
    let originalCwd: string

    function git(...args: string[]): string {
      return execFileSync('git', args, { cwd: repo, env: gitEnv, encoding: 'utf-8' }).trim()
    }

    beforeEach(() => {
      originalCwd = process.cwd()
      repo = fixtureDir('vinaya-commit-msg-repo-')
      git('init', '-q', '-b', 'main')
      git('config', 'user.email', 'a@example.com')
      git('config', 'user.name', 'A')
      git('config', 'commit.gpgsign', 'false')
      git('commit', '-q', '--allow-empty', '-m', 'Chore: Start')
    })

    afterEach(() => {
      process.chdir(originalCwd)
    })

    function run(message: string): { stderr: string; code: number } {
      const file = join(repo, 'MSG')
      writeFileSync(file, message)
      process.chdir(repo)
      process.exitCode = 0
      const stderr = captureStderr(() => commitMsgCommand([file]))
      return { stderr, code: Number(process.exitCode) }
    }

    it('accepts conventional messages with and without a merge in progress; refuses a merge message without one', () => {
      const merge = "Merge commit 'abc1234' into task/issue-1\n"
      expect(run('Fix(cli): Do the thing\n').code).toBe(0)
      expect(run(merge).code).toBe(1)

      git('checkout', '-q', '-b', 'other')
      git('commit', '-q', '--allow-empty', '-m', 'Chore: Other')
      git('checkout', '-q', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'Chore: Main')
      git('merge', '-q', '--no-commit', '--no-ff', 'other')
      expect(run(merge)).toEqual({ stderr: '', code: 0 })
      expect(run('Fix(cli): Do the thing\n').code).toBe(0)
    })

    it('lets a real `git merge --no-edit --no-ff` land under the armed hook', () => {
      const hook = join(repo, '.git', 'hooks', 'commit-msg')
      const cli = join(import.meta.dir, '..', 'src', 'index.ts')
      writeFileSync(hook, `#!/bin/sh\nexec bun "${cli}" commit-msg "$1" "$2"\n`)
      chmodSync(hook, 0o755)

      git('checkout', '-q', '-b', 'other')
      git('commit', '-q', '--allow-empty', '-m', 'Chore: Other')
      const tip = git('rev-parse', 'HEAD')
      git('checkout', '-q', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'Chore: Main')

      const result = spawnSync('git', ['merge', '--no-edit', '--no-ff', tip], {
        cwd: repo,
        env: gitEnv,
        encoding: 'utf-8'
      })
      expect(result.stderr).not.toContain("doesn't match")
      expect(result.status).toBe(0)
      expect(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)
    })
  })

  it('prints usage and exits 2 when no message file is given', () => {
    const stderr = captureStderr(() => commitMsgCommand([]))
    expect(process.exitCode).toBe(2)
    expect(stderr).toContain('Usage: vinaya commit-msg')
  })
})
