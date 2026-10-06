/**
 * A push the repository's pre-push hook refuses reaches the Developer as a
 * hook refusal carrying the failing test names; any other push failure carries
 * the push's own bounded error output. Real git, real hook, real remote.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedPushOutput, pushBranchClassified } from '../../../src/lib/dev-review-loop.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}

function repoWithRemote(hook: string | null): { work: string } {
  const root = mkdtempSync(join(tmpdir(), 'push-hook-refusal-'))
  roots.push(root)
  const remote = join(root, 'remote.git')
  const work = join(root, 'work')
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['init', '-q', work])
  git(work, ['config', 'user.email', 'a@b.c'])
  git(work, ['config', 'user.name', 'x'])
  git(work, ['config', 'core.hooksPath', join(root, 'hooks')])
  git(work, ['remote', 'add', 'origin', remote])
  git(work, ['commit', '-q', '--allow-empty', '-m', 'init'])
  if (hook !== null) {
    execFileSync('mkdir', ['-p', join(root, 'hooks')])
    const path = join(root, 'hooks', 'pre-push')
    writeFileSync(path, hook)
    chmodSync(path, 0o755)
  }
  return { work }
}

function caught(fn: () => void): Error {
  try {
    fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the push to fail')
}

describe('pushBranchClassified', () => {
  it('returns a failing pre-push hook as a hook refusal naming the failing tests', () => {
    const noise = Array.from({ length: 300 }, (_, i) => `(pass) suite > passing case ${i}`).join('\n')
    const { work } = repoWithRemote(
      `#!/bin/sh\necho "selected 2 of 9 test file(s)"\nsleep 1\ncat <<'OUT'\n${noise}\nOUT\necho "(fail) widget > renders the title" >&2\necho " 1 fail" >&2\nexit 1\n`
    )
    const err = caught(() => pushBranchClassified(work, 'task/x/1'))
    expect(err.name).toBe('PushHookRefusal')
    expect(err.message).not.toContain('git exit')
    const output = (err as unknown as { output: string }).output
    expect(output).toContain('(fail) widget > renders the title')
    expect(output).not.toContain('passing case 7')
    expect(output.split('\n').length).toBeLessThanOrEqual(40)
  })

  it('returns any other push failure with the git exit and its own error output', () => {
    const { work } = repoWithRemote(null)
    git(work, ['remote', 'set-url', 'origin', join(work, 'missing.git')])
    const err = caught(() => pushBranchClassified(work, 'task/x/1'))
    expect(err.name).not.toBe('PushHookRefusal')
    expect(err.message).toContain('git exit 128')
    expect(err.message.toLowerCase()).toContain('does not appear to be a git repository')
  })
})

describe('pushBranchClassified with large output', () => {
  it('reads a hook that prints more than the default buffer and still reports the failing test', () => {
    const { work } = repoWithRemote(
      `#!/bin/sh\nawk 'BEGIN { for (i = 0; i < 30000; i++) print "(pass) suite > passing case " i " padding padding padding padding padding" }'\necho "(fail) late > last failing test" >&2\nexit 1\n`
    )
    const err = caught(() => pushBranchClassified(work, 'task/x/1'))
    expect(err.name).toBe('PushHookRefusal')
    expect((err as unknown as { output: string }).output).toContain('(fail) late > last failing test')
  })
})

describe('boundedPushOutput', () => {
  it('keeps every failing test name when detail lines would fill the cap', () => {
    const block = (n: number) =>
      `(fail) suite > test ${n}\nerror: expect(received).toEqual(expected)\nExpected: 1\nReceived: 2\n`
    const out = boundedPushOutput(Array.from({ length: 30 }, (_, i) => block(i)).join(''), 'failing')
    for (let i = 0; i < 30; i++) expect(out).toContain(`(fail) suite > test ${i}\n`.trimEnd())
    expect(out.split('\n').length).toBeLessThanOrEqual(40)
  })

  it('redacts home paths and credentials per line and caps the size', () => {
    const out = boundedPushOutput(
      `(fail) a at /Users/someone/x.ts\n(fail) b token=abc123\n${'(fail) c\n'.repeat(100)}`,
      'failing'
    )
    expect(out).not.toContain('/Users/someone')
    expect(out).not.toContain('abc123')
    expect(out.split('\n').length).toBe(40)
  })
})
