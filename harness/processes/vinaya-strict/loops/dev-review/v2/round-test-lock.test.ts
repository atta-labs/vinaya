import { fixtureDir } from '../../../../../kernel/conformance/unit/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireRoundTestLock, ROUND_TEST_LOCK_DIRNAME } from './round-test-lock'

// The host-wide round-test mutex, against real directories under a throwaway runtime root.

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('acquireRoundTestLock', () => {
  test('two holders never overlap: the second waits until the first releases', async () => {
    const root = fixtureDir('round-lock-')
    const events: string[] = []
    const holder = async (name: string, holdMs: number) => {
      const lock = await acquireRoundTestLock({ rootDir: root, deadlineAt: Date.now() + 10_000, pollMs: 10 })
      if (!lock.ok) throw new Error(lock.detail)
      try {
        events.push(`${name}:in`)
        await tick(holdMs)
        events.push(`${name}:out`)
      } finally {
        lock.release()
      }
    }
    await Promise.all([holder('a', 80), holder('b', 20)])
    expect(events.length).toBe(4)
    // Whichever took the lock first left it before the other came in.
    expect(events[0]?.endsWith(':in')).toBe(true)
    expect(events[1]).toBe(`${events[0]?.split(':')[0]}:out`)
    expect(existsSync(join(root, ROUND_TEST_LOCK_DIRNAME))).toBe(false)
  })

  test('locks taken from two repositories’ runtime directories under one root never overlap', async () => {
    const root = fixtureDir('round-lock-root-')
    const runtimeA = join(root, 'repo-a')
    const runtimeB = join(root, 'repo-b')
    mkdirSync(runtimeA)
    mkdirSync(runtimeB)
    // The lock sits in the parent of each runtime directory, which is the one shared root.
    expect(dirname(runtimeA)).toBe(dirname(runtimeB))
    const first = await acquireRoundTestLock({ rootDir: dirname(runtimeA), deadlineAt: Date.now() + 5_000 })
    expect(first.ok).toBe(true)
    const second = await acquireRoundTestLock({
      rootDir: dirname(runtimeB),
      deadlineAt: Date.now() + 150,
      pollMs: 10
    })
    expect(second.ok).toBe(false)
    if (first.ok) first.release()
    expect(existsSync(join(root, ROUND_TEST_LOCK_DIRNAME))).toBe(false)
    const third = await acquireRoundTestLock({ rootDir: dirname(runtimeB), deadlineAt: Date.now() + 1_000 })
    expect(third.ok).toBe(true)
    if (third.ok) third.release()
  })

  test('a wait past the deadline gives up, and the holder keeps the lock', async () => {
    const root = fixtureDir('round-lock-')
    const held = await acquireRoundTestLock({ rootDir: root, deadlineAt: Date.now() + 5_000 })
    if (!held.ok) throw new Error('the first lock must be taken')
    const waited = await acquireRoundTestLock({ rootDir: root, deadlineAt: Date.now() + 120, pollMs: 10 })
    expect(waited).toMatchObject({ ok: false, reason: 'timeout' })
    expect(existsSync(join(root, ROUND_TEST_LOCK_DIRNAME))).toBe(true)
    held.release()
  })

  test('a holder whose process died is reclaimed once its heartbeat has stopped', async () => {
    const root = fixtureDir('round-lock-')
    const dead = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      pid: 999_999,
      startHeartbeat: () => () => {}
    })
    expect(dead.ok).toBe(true)
    // Fresh heartbeat: not reclaimable even though the process is gone.
    const early = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 100,
      pollMs: 10,
      isAlive: () => false
    })
    expect(early).toMatchObject({ ok: false, reason: 'timeout' })
    // The heartbeat stops: an hour ago.
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(join(root, ROUND_TEST_LOCK_DIRNAME, 'heartbeat'), old, old)
    const taken = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 2_000,
      pollMs: 10,
      isAlive: () => false
    })
    expect(taken.ok).toBe(true)
    if (taken.ok) taken.release()
    expect(existsSync(join(root, ROUND_TEST_LOCK_DIRNAME))).toBe(false)
  })

  test('a stale heartbeat of a live process is kept, and a lock with no owner file is reclaimed', async () => {
    const root = fixtureDir('round-lock-')
    const live = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      startHeartbeat: () => () => {}
    })
    expect(live.ok).toBe(true)
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(root, ROUND_TEST_LOCK_DIRNAME, 'heartbeat'), old, old)
    const blocked = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 100,
      pollMs: 10,
      isAlive: () => true
    })
    expect(blocked).toMatchObject({ ok: false, reason: 'timeout' })
    // A directory a crashed taker never finished: no owner, and old.
    const other = fixtureDir('round-lock-')
    mkdirSync(join(other, ROUND_TEST_LOCK_DIRNAME))
    utimesSync(join(other, ROUND_TEST_LOCK_DIRNAME), old, old)
    const reclaimed = await acquireRoundTestLock({ rootDir: other, deadlineAt: Date.now() + 2_000, pollMs: 10 })
    expect(reclaimed.ok).toBe(true)
    if (reclaimed.ok) reclaimed.release()
    if (live.ok) live.release()
  })

  test('a cancel while waiting stops the wait', async () => {
    const root = fixtureDir('round-lock-')
    const held = await acquireRoundTestLock({ rootDir: root, deadlineAt: Date.now() + 5_000 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const waited = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      signal: controller.signal,
      pollMs: 20
    })
    expect(waited).toMatchObject({ ok: false, reason: 'cancel' })
    if (held.ok) held.release()
  })

  test('a release after the lock was reclaimed leaves the new holder’s lock alone', async () => {
    const root = fixtureDir('round-lock-')
    const first = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      startHeartbeat: () => () => {}
    })
    if (!first.ok) throw new Error('the first lock must be taken')
    // Another owner replaces the lock behind the first holder's back.
    writeFileSync(join(root, ROUND_TEST_LOCK_DIRNAME, 'owner.json'), JSON.stringify({ pid: 1, token: 'someone-else' }))
    first.release()
    expect(existsSync(join(root, ROUND_TEST_LOCK_DIRNAME))).toBe(true)
  })

  test('the heartbeat is touched while the lock is held', async () => {
    const root = fixtureDir('round-lock-')
    let beat: (() => void) | undefined
    const lock = await acquireRoundTestLock({
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      startHeartbeat: (fn) => {
        beat = fn
        return () => {}
      }
    })
    if (!lock.ok) throw new Error('the lock must be taken')
    const old = new Date(Date.now() - 60 * 60_000)
    const heartbeat = join(root, ROUND_TEST_LOCK_DIRNAME, 'heartbeat')
    utimesSync(heartbeat, old, old)
    beat?.()
    expect(Date.now() - statSync(heartbeat).mtimeMs).toBeLessThan(5_000)
    lock.release()
  })
})
