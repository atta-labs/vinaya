import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { doctrineCommand, resolveDoctrineRoot } from '../../src/commands/doctrine.js'

/**
 * O2 — role discovery exposes the Operator: `doctrine --role operator`
 * resolves straight to the role doc, exactly as `/vinaya operator` (which
 * shells to the same command) and the generated skill do. Nothing hardcodes
 * the role name; adding `roles/operator.md` with `actor: agent` is what makes
 * it discoverable.
 */

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

describe('vinaya doctrine --role operator', () => {
  it('resolves to roles/operator.md under the doctrine root', () => {
    const root = resolveDoctrineRoot()
    if (root === null) throw new Error('no doctrine root on this machine — cannot exercise --role operator')

    const printed = captureStdout(() => doctrineCommand(['--role', 'operator'])).trim()
    expect(isAbsolute(printed)).toBe(true)
    expect(printed).toBe(join(root, 'roles', 'operator.md'))
    expect(existsSync(printed)).toBe(true)
  })

  it('--role operator --json emits a coherent root/entry pair', () => {
    const out = captureStdout(() => doctrineCommand(['--role', 'operator', '--json']))
    const parsed = JSON.parse(out)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.entry).toBe(join(parsed.data.root, 'roles', 'operator.md'))
  })
})
