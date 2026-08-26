import { beforeEach, describe, expect, it } from 'bun:test'
import { __resetStdinForTest, closeStdin, promptYesNo } from '../src/lib/prompt.js'

// `prompt.ts` drives a shared, module-level stdin buffer directly off the
// real `process.stdin` — there is no per-call injection seam, only
// `__resetStdinForTest()`. That resets the buffer/pending-resolver state but
// does not strip listeners already registered on `process.stdin` by a prior
// test's `setupStdinReader()` call, so every test here also strips them —
// otherwise stale listeners from an earlier test would double-append the
// next test's fed chunk into the (already-reset) shared buffer.
beforeEach(() => {
  process.stdin.removeAllListeners('data')
  process.stdin.removeAllListeners('end')
  __resetStdinForTest()
})

function feedLine(line: string): void {
  process.stdin.emit('data', `${line}\n`)
}

function endStdin(): void {
  process.stdin.emit('end')
}

describe('promptYesNo', () => {
  it('returns true on an explicit "y" answer', async () => {
    const pending = promptYesNo('Continue?')
    feedLine('y')
    expect(await pending).toBe(true)
  })

  it('returns false on an explicit "n" answer', async () => {
    const pending = promptYesNo('Continue?')
    feedLine('n')
    expect(await pending).toBe(false)
  })

  it('is case-insensitive when the answer starts with an uppercase "Y" ("Yes")', async () => {
    const pending = promptYesNo('Continue?')
    feedLine('Yes')
    expect(await pending).toBe(true)
  })

  it('takes defaultYes=true on an empty answer', async () => {
    const pending = promptYesNo('Continue?', true)
    feedLine('')
    expect(await pending).toBe(true)
  })

  it('takes defaultYes=false (the default) on an empty answer', async () => {
    const pending = promptYesNo('Continue?')
    feedLine('')
    expect(await pending).toBe(false)
  })

  it('takes the default when stdin ends with no input at all, instead of hanging', async () => {
    const pending = promptYesNo('Continue?', true)
    endStdin()
    expect(await pending).toBe(true)
  })

  it('once stdin has ended, a later prompt resolves immediately with the default rather than waiting again', async () => {
    const first = promptYesNo('Q1?', true)
    endStdin()
    expect(await first).toBe(true)

    // `stdinEnded` is now true module-wide; `prompt()`'s early-return branch
    // must fire here without registering a new wait.
    expect(await promptYesNo('Q2?', false)).toBe(false)
  })
})

describe('closeStdin', () => {
  it('is safe to call when stdin was never opened for reading (a no-op)', () => {
    expect(() => {
      closeStdin()
      closeStdin()
    }).not.toThrow()
  })

  it('is safe to call twice after stdin was opened for reading, and only tears down once', async () => {
    // Stub `.destroy` for this test only — the real one would tear down the
    // process-wide `process.stdin` singleton and break every later test (in
    // this file and others) that still needs to read from it.
    const originalDestroy = process.stdin.destroy.bind(process.stdin)
    let destroyCalls = 0
    process.stdin.destroy = (() => {
      destroyCalls++
      return process.stdin
    }) as typeof process.stdin.destroy

    try {
      const pending = promptYesNo('Continue?', true)
      feedLine('')
      await pending

      expect(() => {
        closeStdin()
        closeStdin()
      }).not.toThrow()
      // First call sees `reading === true` and destroys; the second sees the
      // flag already flipped and is a genuine no-op — not a second teardown.
      expect(destroyCalls).toBe(1)
    } finally {
      process.stdin.destroy = originalDestroy
    }
  })
})
