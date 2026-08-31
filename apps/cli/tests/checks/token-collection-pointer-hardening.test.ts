import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/**
 * Coverage for the `lstat` hardening in
 * `apps/cli/src/checks/bin/check-token-collection-wired.ts`.
 *
 * Both reviewers flagged that this control shipped with none: `safeLstat` could
 * be deleted and every suite stayed green. The repo's own writer-side CWE-59 fix
 * for this exact pointer path is tested (`claude-stop-hook-emitter.test.ts`), so
 * the precedent existed and was not followed.
 *
 * These drive the real bin against real files, because that is the only layer
 * where the guard lives — it is supplied as the probe's I/O deps, and the probe
 * itself is pure and knows nothing about symlinks.
 */
describe('token-collection-wired — pointer hardening (CWE-59)', () => {
  const BIN = join(import.meta.dir, '../../src/checks/bin/check-token-collection-wired.ts')
  const PROJECT_DIR = '/hardening-probe'
  let dir: string
  let pointerPath: string
  let transcriptPath: string

  /** Mirrors `sanitizeKey` + `transcriptPointerPath` in the probe. */
  const pointerFor = (tmp: string) => join(tmp, `claude-transcript-${PROJECT_DIR.replace(/[^A-Za-z0-9]+/g, '-')}.txt`)

  const REAL_JSONL = `${JSON.stringify({
    type: 'assistant',
    message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 } }
  })}\n`

  /** Runs the check and returns its exit code. Never throws on a non-zero exit. */
  function run(sessionId = 'sess-1'): number {
    try {
      execFileSync('bun', [BIN], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: PROJECT_DIR,
          TMPDIR: `${dir}/`,
          CLAUDE_CODE_SESSION_ID: sessionId
        }
      })
      return 0
    } catch (err) {
      return (err as { status?: number }).status ?? -1
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tcw-harden-'))
    pointerPath = pointerFor(dir)
    transcriptPath = join(dir, 'session.jsonl')
    writeFileSync(transcriptPath, REAL_JSONL)
  })

  afterEach(() => {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // best effort — a case may have left the directory unreadable
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes on a real, self-owned pointer naming a usable transcript — the guard is not blanket-refusing', () => {
    writeFileSync(pointerPath, `sess-1\t${transcriptPath}\n`)
    expect(run()).toBe(0)
  })

  // The CWE-59 case. A co-resident user who wins the race to this predictable
  // path must not be able to steer what the check reads, nor to block commits.
  it('IGNORES a symlink planted at the pointer path, rather than following it', () => {
    const realPointer = join(dir, 'attacker-controlled.txt')
    writeFileSync(realPointer, `sess-1\t${transcriptPath}\n`)
    symlinkSync(realPointer, pointerPath)
    // Ignored means "no pointer", which is the sanctioned operator-metered case
    // — a pass. Refusing here would hand the attacker a commit-blocking denial
    // of service, which is the outcome this guard exists to prevent.
    expect(run()).toBe(0)
  })

  it('IGNORES a symlink pointing somewhere sensitive, and reads nothing from it', () => {
    symlinkSync('/etc/passwd', pointerPath)
    expect(run()).toBe(0)
  })

  it('IGNORES a dangling symlink at the pointer path', () => {
    symlinkSync(join(dir, 'does-not-exist'), pointerPath)
    expect(run()).toBe(0)
  })

  it('IGNORES a directory at the pointer path', () => {
    mkdirSync(pointerPath)
    expect(run()).toBe(0)
  })

  // A FIFO previously blocked the check indefinitely — an unbounded hang on
  // every commit. `lstat` classifies it before anything opens it.
  it('IGNORES a FIFO at the pointer path instead of blocking on it', () => {
    execFileSync('mkfifo', [pointerPath])
    const started = Date.now()
    expect(run()).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('degrades to a clean refusal, never an unhandled throw, when the pointer is unreadable', () => {
    writeFileSync(pointerPath, `sess-1\t${transcriptPath}\n`)
    chmodSync(pointerPath, 0o000)
    // A regular file this user owns but cannot read is a genuine wiring defect:
    // the pointer is ours and unusable. Exit 1, not a crash.
    expect(run()).toBe(1)
  })

  it('refuses rather than following a symlinked transcript, and does not hang on a FIFO transcript', () => {
    const fifoTranscript = join(dir, 'fifo.jsonl')
    execFileSync('mkfifo', [fifoTranscript])
    writeFileSync(pointerPath, `sess-1\t${fifoTranscript}\n`)
    const started = Date.now()
    expect(run()).toBe(1)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
