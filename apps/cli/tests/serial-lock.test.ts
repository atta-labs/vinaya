import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSerialLock } from './serial-lock.js'

let lockDir: string

beforeEach(() => {
  lockDir = join(tmpdir(), `vinaya-serial-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
})

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true })
})

/** Backdate a lock directory so it reads as abandoned. */
function ageLock(dir: string, ageMs: number): void {
  const then = new Date(Date.now() - ageMs)
  utimesSync(dir, then, then)
}

describe('withSerialLock', () => {
  it('holds the lock directory for the duration of the callback and releases it after', async () => {
    let existedInside = false
    await withSerialLock(lockDir, async () => {
      existedInside = existsSync(lockDir)
    })
    expect(existedInside).toBe(true)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('waits for a live holder rather than running concurrently', async () => {
    const order: string[] = []
    const first = withSerialLock(lockDir, async () => {
      order.push('first:start')
      await new Promise((r) => setTimeout(r, 150))
      order.push('first:end')
    })
    await new Promise((r) => setTimeout(r, 20))
    const second = withSerialLock(lockDir, async () => {
      order.push('second:start')
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('reclaims a lock nobody has heartbeated for longer than staleMs', async () => {
    mkdirSync(lockDir)
    ageLock(lockDir, 10_000)
    const started = Date.now()
    let ran = false
    await withSerialLock(
      lockDir,
      async () => {
        ran = true
      },
      { staleMs: 1_000, waitMs: 5_000 }
    )
    expect(ran).toBe(true)
    // Reclaimed on the first poll, not after the wait deadline.
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('does not reclaim a fresh lock before staleMs, and gives up at waitMs', async () => {
    mkdirSync(lockDir)
    await expect(
      withSerialLock(lockDir, async () => undefined, { staleMs: 10_000, waitMs: 300, pollMs: 20 })
    ).rejects.toThrow(/timed out waiting for the serial lock/)
    expect(existsSync(lockDir)).toBe(true)
  })

  it('keeps a slow but alive holder from being reclaimed by refreshing the lock mtime', async () => {
    const staleMs = 200
    const order: string[] = []
    const holder = withSerialLock(
      lockDir,
      async () => {
        order.push('holder:start')
        // Hold for several multiples of staleMs; without a heartbeat the
        // waiter below would steal the lock partway through.
        await new Promise((r) => setTimeout(r, staleMs * 4))
        order.push('holder:end')
      },
      { staleMs }
    )
    await new Promise((r) => setTimeout(r, 30))
    const mtimeAtStart = statSync(lockDir).mtimeMs
    const waiter = withSerialLock(
      lockDir,
      async () => {
        order.push('waiter:start')
      },
      { staleMs, waitMs: 5_000, pollMs: 20 }
    )
    await new Promise((r) => setTimeout(r, staleMs * 2))
    // Still held by the holder, and its mtime has moved forward.
    expect(order).toEqual(['holder:start'])
    expect(statSync(lockDir).mtimeMs).toBeGreaterThan(mtimeAtStart)
    await Promise.all([holder, waiter])
    expect(order).toEqual(['holder:start', 'holder:end', 'waiter:start'])
  })
})
