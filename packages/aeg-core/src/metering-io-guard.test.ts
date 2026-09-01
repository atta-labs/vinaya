import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hardenedMeteringDeps, isTrustedMeteringStat } from './metering-io-guard'

describe('isTrustedMeteringStat', () => {
  it('trusts a regular file owned by the current user', () => {
    expect(isTrustedMeteringStat({ isFile: () => true, uid: 1000 }, 1000)).toBe(true)
  })

  it('refuses a non-regular file (FIFO, device, directory)', () => {
    expect(isTrustedMeteringStat({ isFile: () => false, uid: 1000 }, 1000)).toBe(false)
  })

  it('refuses a regular file owned by a different user', () => {
    // Not constructible as a real fixture in CI without a second local user
    // — exercised here via a faked stat instead (this repo's own
    // brief-authoring convention for the untestable-in-CI case).
    expect(isTrustedMeteringStat({ isFile: () => true, uid: 1000 }, 1)).toBe(false)
  })

  it('trusts any owner when the platform reports none (no process.getuid, e.g. Windows)', () => {
    expect(isTrustedMeteringStat({ isFile: () => true, uid: 1000 }, undefined)).toBe(true)
  })
})

describe('hardenedMeteringDeps', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metering-io-guard-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('exists/readFile round-trip a legitimate regular file unaffected', () => {
    const deps = hardenedMeteringDeps()
    const path = join(dir, 'transcript.jsonl')
    writeFileSync(path, 'real content\n')

    expect(deps.exists(path)).toBe(true)
    expect(deps.readFile(path)).toBe('real content\n')
  })

  it('reports a missing path as not existing, and refuses to read it', () => {
    const deps = hardenedMeteringDeps()
    const path = join(dir, 'nope.jsonl')

    expect(deps.exists(path)).toBe(false)
    expect(() => deps.readFile(path)).toThrow()
  })

  it('refuses a symlink at the pointer path rather than following it (CWE-59)', () => {
    const deps = hardenedMeteringDeps()
    const victim = join(dir, 'victim-secret.txt')
    const link = join(dir, 'pointer.txt')
    writeFileSync(victim, 'SECRET_OF_ANOTHER_USER\n')
    symlinkSync(victim, link)

    expect(deps.exists(link)).toBe(false)
    expect(() => deps.readFile(link)).toThrow()
  })

  it('refuses a FIFO at the pointer path without blocking (CWE-59 hang)', () => {
    const deps = hardenedMeteringDeps()
    const fifo = join(dir, 'pointer.txt')
    execFileSync('mkfifo', [fifo])

    const start = Date.now()
    expect(deps.exists(fifo)).toBe(false)
    expect(() => deps.readFile(fifo)).toThrow()
    // No writer ever attaches to this FIFO; a blocking open/read would hang
    // for the life of the process. Finishing at all proves non-blocking —
    // the bound is generous only to absorb CI scheduling noise, not because
    // a real guard needs anywhere near this long.
    expect(Date.now() - start).toBeLessThan(2000)
  })
})
