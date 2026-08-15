import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { doctrineCommand } from '../src/commands/doctrine.js'

// NOT in the same file as doctrine-pointer.test.ts, deliberately: that file
// mock.module()s package-root.js, and this command needs the real resolver.

/** Capture process.stdout.write output during `fn`, returning the output. */
function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stdout.write
  try {
    fn()
  } finally {
    process.stdout.write = original
  }
  return buf
}

describe('vinaya doctrine', () => {
  it('prints an absolute front-door path that exists on this machine', () => {
    const printed = captureStdout(() => doctrineCommand([])).trim()
    expect(isAbsolute(printed)).toBe(true)
    expect(printed.endsWith(join('aeg-root', 'skills', 'aeg', 'SKILL.md'))).toBe(true)
    expect(existsSync(printed)).toBe(true)
  })

  it('--json emits the envelope with a coherent root/entry pair', () => {
    const out = captureStdout(() => doctrineCommand(['--json']))
    const parsed = JSON.parse(out)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.entry).toBe(join(parsed.data.root, 'skills', 'aeg', 'SKILL.md'))
    expect(existsSync(parsed.data.entry)).toBe(true)
  })
})
