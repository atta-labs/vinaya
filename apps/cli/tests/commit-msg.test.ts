import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitMsgCommand } from '../src/commands/commit-msg.js'

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

  it('skips validation outright when source is "merge" — git wrote that message, not the committer', () => {
    const stderr = captureStderr(() => commitMsgCommand([messageFile("Merge branch 'main' into feature\n"), 'merge']))
    expect(stderr).toBe('')
    expect(process.exitCode).toBe(0)
  })

  it('still validates a non-merge source keyword (e.g. "message")', () => {
    captureStderr(() => commitMsgCommand([messageFile('fixed stuff\n'), 'message']))
    expect(process.exitCode).toBe(1)
  })

  it('prints usage and exits 2 when no message file is given', () => {
    const stderr = captureStderr(() => commitMsgCommand([]))
    expect(process.exitCode).toBe(2)
    expect(stderr).toContain('Usage: vinaya commit-msg')
  })
})
