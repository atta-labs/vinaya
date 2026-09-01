import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveMeteringCapability } from '@attalabs/aeg-core'
import { realDeps } from './tokens'

/**
 * `#313`: `vinaya tokens`'s `realDeps()` must resolve through
 * `hardenedMeteringDeps()`, not hand-rolled `existsSync`/`readFileSync` —
 * proven here against an explicit `--transcript` path (the same route
 * `buildTokensResult` takes), so this needs no `TMPDIR` pointer-file
 * simulation. `archive.ts` and `pr-report.ts` both import this exact
 * `realDeps`, so this test covers them too.
 */
describe('tokens realDeps — metering I/O hardening', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tokens-metering-io-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('refuses a symlinked transcript path rather than following it', () => {
    const victim = join(dir, 'victim-secret.txt')
    const link = join(dir, 'transcript.jsonl')
    writeFileSync(
      victim,
      `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'exfiltrated', usage: { input_tokens: 1, output_tokens: 1 } } })}\n`
    )
    symlinkSync(victim, link)

    const cap = resolveMeteringCapability(realDeps(), link)
    expect(cap.capable).toBe(false)
    if (!cap.capable) expect(cap.reason).toBe('transcript-unreadable')
  })

  test('refuses a FIFO transcript path without hanging', () => {
    const fifo = join(dir, 'transcript.jsonl')
    execFileSync('mkfifo', [fifo])

    const start = Date.now()
    const cap = resolveMeteringCapability(realDeps(), fifo)
    expect(cap.capable).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test('a legitimate transcript still resolves and summarizes correctly', () => {
    const path = join(dir, 'transcript.jsonl')
    writeFileSync(
      path,
      `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 7 } } })}\n`
    )

    const cap = resolveMeteringCapability(realDeps(), path)
    expect(cap.capable).toBe(true)
    if (cap.capable) {
      expect(cap.summary.model).toBe('claude-sonnet-5')
      expect(cap.summary.components.inputTokens).toBe(5)
      expect(cap.summary.components.outputTokens).toBe(7)
    }
  })
})
