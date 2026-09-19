import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { realDeps } from './quickstart'

/**
 * `vinaya quickstart`'s wrapped `doctorDeps.meteringCapability`
 * closure calls `resolveMeteringCapability(hardenedMeteringDeps())`, the
 * same zero-argument, pointer-file-only route `doctor.ts` uses — see
 * `doctor-metering-io.test.ts` for why `TMPDIR`/`CLAUDE_PROJECT_DIR` are
 * sandboxed for the duration of each test here too.
 */
describe('quickstart realDeps — metering I/O hardening', () => {
  let dir: string
  let originalTmpdir: string | undefined
  let originalProjectDir: string | undefined
  let originalSessionId: string | undefined
  const pointerPath = () => join(dir, 'claude-transcript-metering-io-test-project.txt')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quickstart-metering-io-'))
    originalTmpdir = process.env.TMPDIR
    originalProjectDir = process.env.CLAUDE_PROJECT_DIR
    originalSessionId = process.env.CLAUDE_CODE_SESSION_ID
    process.env.TMPDIR = dir
    process.env.CLAUDE_PROJECT_DIR = 'metering-io-test-project'
    delete process.env.CLAUDE_CODE_SESSION_ID
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (originalTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpdir
    if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR
    else process.env.CLAUDE_PROJECT_DIR = originalProjectDir
    if (originalSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = originalSessionId
  })

  test('refuses a symlinked pointer file rather than following it', () => {
    const victim = join(dir, 'victim-secret.txt')
    writeFileSync(victim, 'sid\t/somewhere/transcript.jsonl\n')
    symlinkSync(victim, pointerPath())

    const cap = realDeps().doctorDeps.meteringCapability()
    expect(cap.capable).toBe(false)
    if (!cap.capable) expect(cap.reason).toBe('no-transcript-resolved')
  })

  test('refuses a FIFO pointer file without hanging', () => {
    execFileSync('mkfifo', [pointerPath()])

    const start = Date.now()
    const cap = realDeps().doctorDeps.meteringCapability()
    expect(cap.capable).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test('a legitimate pointer and transcript still resolve correctly', () => {
    const transcriptPath = join(dir, 'transcript.jsonl')
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 3, output_tokens: 4 } } })}\n`
    )
    writeFileSync(pointerPath(), `\t${transcriptPath}\n`)

    const cap = realDeps().doctorDeps.meteringCapability()
    expect(cap.capable).toBe(true)
    if (cap.capable) expect(cap.summary.model).toBe('claude-sonnet-5')
  })
})
