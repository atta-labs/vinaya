import { fixtureDir } from '../../../../../kernel/conformance/unit/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireRoundTestLock, ROUND_TEST_LOCK_DIRNAME, roundTestSlotCount, roundTestSlotDir } from './round-test-lock'

// The host-wide round-test mutex, against real directories under a throwaway runtime root.

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const GIB = 1024 ** 3
// A 4 GB host with plenty of processors: exactly one slot, the case the single-holder tests below exercise.
const ONE_SLOT = { totalMemory: () => 4 * GIB, processors: () => 12 }

describe('acquireRoundTestLock', () => {
  test('two holders never overlap: the second waits until the first releases', async () => {
    const root = fixtureDir('round-lock-')
    const events: string[] = []
    const holder = async (name: string, holdMs: number) => {
      const lock = await acquireRoundTestLock({
        ...ONE_SLOT,
        rootDir: root,
        deadlineAt: Date.now() + 10_000,
        pollMs: 10
      })
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
    const first = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: dirname(runtimeA),
      deadlineAt: Date.now() + 5_000
    })
    expect(first.ok).toBe(true)
    const second = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: dirname(runtimeB),
      deadlineAt: Date.now() + 150,
      pollMs: 10
    })
    expect(second.ok).toBe(false)
    if (first.ok) first.release()
    expect(existsSync(join(root, ROUND_TEST_LOCK_DIRNAME))).toBe(false)
    const third = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: dirname(runtimeB),
      deadlineAt: Date.now() + 1_000
    })
    expect(third.ok).toBe(true)
    if (third.ok) third.release()
  })

  test('a wait past the deadline gives up, and the holder keeps the lock', async () => {
    const root = fixtureDir('round-lock-')
    const held = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 5_000
    })
    if (!held.ok) throw new Error('the first lock must be taken')
    const waited = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 120,
      pollMs: 10
    })
    expect(waited).toMatchObject({ ok: false, reason: 'timeout' })
    expect(existsSync(join(root, ROUND_TEST_LOCK_DIRNAME))).toBe(true)
    held.release()
  })

  test('a holder whose process died is reclaimed once its heartbeat has stopped', async () => {
    const root = fixtureDir('round-lock-')
    const dead = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      pid: 999_999,
      startHeartbeat: () => () => {}
    })
    expect(dead.ok).toBe(true)
    // Fresh heartbeat: not reclaimable even though the process is gone.
    const early = await acquireRoundTestLock({
      ...ONE_SLOT,
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
      ...ONE_SLOT,
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
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      startHeartbeat: () => () => {}
    })
    expect(live.ok).toBe(true)
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(root, ROUND_TEST_LOCK_DIRNAME, 'heartbeat'), old, old)
    const blocked = await acquireRoundTestLock({
      ...ONE_SLOT,
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
    const reclaimed = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: other,
      deadlineAt: Date.now() + 2_000,
      pollMs: 10
    })
    expect(reclaimed.ok).toBe(true)
    if (reclaimed.ok) reclaimed.release()
    if (live.ok) live.release()
  })

  test('a cancel while waiting stops the wait', async () => {
    const root = fixtureDir('round-lock-')
    const held = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 5_000
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const waited = await acquireRoundTestLock({
      ...ONE_SLOT,
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
      ...ONE_SLOT,
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
      ...ONE_SLOT,
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

describe('round-test slots', () => {
  test('a host below 8 GiB keeps one slot; a 36 GiB, 12-processor host gets six', () => {
    expect(roundTestSlotCount({ totalMemoryBytes: 4_000_000_000, processors: 2 })).toBe(1)
    expect(roundTestSlotCount({ totalMemoryBytes: 4 * GIB, processors: 12 })).toBe(1)
    expect(roundTestSlotCount({ totalMemoryBytes: 8 * GIB - 1, processors: 12 })).toBe(1)
    expect(roundTestSlotCount({ totalMemoryBytes: 36 * GIB, processors: 12 })).toBe(6)
    expect(roundTestSlotCount({ totalMemoryBytes: 36 * GIB, processors: 1 })).toBe(1)
    expect(roundTestSlotCount({ totalMemoryBytes: 0, processors: 0 })).toBe(1)
  })

  test('holders run together up to the slot count, never beyond it', async () => {
    const root = fixtureDir('round-lock-slots-')
    const host = { totalMemory: () => 12 * GIB, processors: () => 12 } // three slots
    let inside = 0
    let peak = 0
    const holder = async () => {
      const lock = await acquireRoundTestLock({ ...host, rootDir: root, deadlineAt: Date.now() + 10_000, pollMs: 5 })
      if (!lock.ok) throw new Error(lock.detail)
      expect(lock.slots).toBe(3)
      inside++
      peak = Math.max(peak, inside)
      await tick(40)
      inside--
      lock.release()
    }
    await Promise.all(Array.from({ length: 7 }, holder))
    expect(peak).toBe(3)
    for (let slot = 0; slot < 3; slot++) expect(existsSync(roundTestSlotDir(root, slot))).toBe(false)
  })

  test('a free slot is taken at once with no wait reported; a full host reports one wait and its length', async () => {
    const root = fixtureDir('round-lock-wait-')
    const waits: number[] = []
    const first = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      onWait: ({ slots }) => waits.push(slots)
    })
    if (!first.ok) throw new Error(first.detail)
    expect(first).toMatchObject({ slot: 0, slots: 1, waitedMs: 0 })
    expect(waits).toEqual([])
    setTimeout(() => first.release(), 80)
    const second = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      pollMs: 5,
      onWait: ({ slots }) => waits.push(slots)
    })
    if (!second.ok) throw new Error(second.detail)
    expect(waits).toEqual([1])
    expect(second.waitedMs).toBeGreaterThanOrEqual(50)
    second.release()
  })

  test('a dead holder of a later slot is reclaimed while the earlier slots stay held', async () => {
    const root = fixtureDir('round-lock-slot-reclaim-')
    const host = { totalMemory: () => 8 * GIB, processors: () => 12 } // two slots
    const live = await acquireRoundTestLock({ ...host, rootDir: root, deadlineAt: Date.now() + 5_000 })
    const dead = await acquireRoundTestLock({
      ...host,
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      pid: 999_999,
      startHeartbeat: () => () => {}
    })
    if (!live.ok || !dead.ok) throw new Error('both slots must be taken')
    expect(dead.slot).toBe(1)
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(join(roundTestSlotDir(root, 1), 'heartbeat'), old, old)
    const taken = await acquireRoundTestLock({
      ...host,
      rootDir: root,
      deadlineAt: Date.now() + 2_000,
      pollMs: 5,
      isAlive: (pid) => pid !== 999_999
    })
    if (!taken.ok) throw new Error(taken.detail)
    expect(taken.slot).toBe(1)
    expect(existsSync(roundTestSlotDir(root, 0))).toBe(true)
    taken.release()
    live.release()
  })
})
