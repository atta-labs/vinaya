import { fixtureDir } from '@harness/kernel/conformance/unit/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  acquireRoundTestLock,
  ROUND_TEST_FILE_CONCURRENCY,
  ROUND_TEST_LOCK_DIRNAME,
  ROUND_TEST_SLOT_MEMORY_BYTES,
  roundTestFileConcurrency,
  roundTestSlotCount,
  roundTestSlotDir
} from './round-test-lock'

// The host-wide round-test mutex, against real directories under a throwaway runtime root.

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const GIB = 1024 ** 3
// An 8 GiB, four-processor host: exactly one round of four test processes, the case the single-holder tests below
// exercise.
const ONE_SLOT = { totalMemory: () => 8 * GIB, processors: () => 4 }

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
  test('N is four, and a round-test slot is budgeted 8 GiB', () => {
    expect(ROUND_TEST_FILE_CONCURRENCY).toBe(4)
    expect(ROUND_TEST_SLOT_MEMORY_BYTES).toBe(8 * GIB)
  })

  test('a 36 GB, twelve-processor host gets three rounds of four files: the processors bind', () => {
    for (const memory of [36 * GIB, 36_000_000_000]) {
      expect(roundTestSlotCount({ totalMemoryBytes: memory, processors: 12 })).toBe(3)
      expect(roundTestFileConcurrency({ totalMemoryBytes: memory, processors: 12 })).toBe(4)
    }
  })

  test('a two-processor host gets one round of two files; a one-processor host one round of one', () => {
    const host = (processors: number) => ({ totalMemoryBytes: 36 * GIB, processors })
    expect(roundTestSlotCount(host(2))).toBe(1)
    expect(roundTestFileConcurrency(host(2))).toBe(2)
    expect(roundTestSlotCount(host(1))).toBe(1)
    expect(roundTestFileConcurrency(host(1))).toBe(1)
  })

  test('where memory is the tighter limit, a round counts 8 GiB', () => {
    // Sixteen processors would allow four rounds; 16 GiB holds two rounds of 8 GiB.
    expect(roundTestSlotCount({ totalMemoryBytes: 16 * GIB, processors: 16 })).toBe(2)
    expect(roundTestSlotCount({ totalMemoryBytes: 16 * GIB - 1, processors: 16 })).toBe(1)
    expect(roundTestSlotCount({ totalMemoryBytes: 24 * GIB, processors: 16 })).toBe(3)
    expect(roundTestFileConcurrency({ totalMemoryBytes: 16 * GIB, processors: 16 })).toBe(4)
  })

  test('a host with less than 8 GiB runs one round of one file at a time', () => {
    for (const memory of [0, 4 * GIB, 8 * GIB - 1]) {
      expect(roundTestSlotCount({ totalMemoryBytes: memory, processors: 12 })).toBe(1)
      expect(roundTestFileConcurrency({ totalMemoryBytes: memory, processors: 12 })).toBe(1)
    }
    expect(roundTestFileConcurrency({ totalMemoryBytes: 8 * GIB, processors: 12 })).toBe(4)
  })

  test('every host gets at least one round, and a round at least one file', () => {
    expect(roundTestSlotCount({ totalMemoryBytes: 0, processors: 0 })).toBe(1)
    expect(roundTestSlotCount({ totalMemoryBytes: 1, processors: 64 })).toBe(1)
    expect(roundTestFileConcurrency({ totalMemoryBytes: 36 * GIB, processors: 0 })).toBe(1)
  })

  test("the rounds' test processes together never exceed the host's logical processors", () => {
    for (let processors = 1; processors <= 64; processors++) {
      for (const gib of [1, 2, 4, 8, 16, 36, 64, 128]) {
        const host = { totalMemoryBytes: gib * GIB, processors }
        const slots = roundTestSlotCount(host)
        const files = roundTestFileConcurrency(host)
        expect(slots * files).toBeLessThanOrEqual(processors)
        expect(slots * ROUND_TEST_SLOT_MEMORY_BYTES).toBeLessThanOrEqual(Math.max(host.totalMemoryBytes, 8 * GIB))
        expect(slots).toBeGreaterThanOrEqual(1)
        expect(files).toBeGreaterThanOrEqual(1)
      }
    }
  })

  test('the lock hands its holder the file concurrency read from the same processors', async () => {
    const root = fixtureDir('round-lock-files-')
    const small = await acquireRoundTestLock({
      totalMemory: () => 36 * GIB,
      processors: () => 2,
      rootDir: root,
      deadlineAt: Date.now() + 5_000
    })
    if (!small.ok) throw new Error(small.detail)
    expect([small.slots, small.fileConcurrency]).toEqual([1, 2])
    small.release()
    const large = await acquireRoundTestLock({
      totalMemory: () => 36 * GIB,
      processors: () => 12,
      rootDir: root,
      deadlineAt: Date.now() + 5_000
    })
    if (!large.ok) throw new Error(large.detail)
    expect([large.slots, large.fileConcurrency]).toEqual([3, 4])
    large.release()
    const lean = await acquireRoundTestLock({
      totalMemory: () => 4 * GIB,
      processors: () => 12,
      rootDir: root,
      deadlineAt: Date.now() + 5_000
    })
    if (!lean.ok) throw new Error(lean.detail)
    expect([lean.slots, lean.fileConcurrency]).toEqual([1, 1])
    lean.release()
  })

  test('holders run together up to the slot count, never beyond it', async () => {
    const root = fixtureDir('round-lock-slots-')
    const host = { totalMemory: () => 24 * GIB, processors: () => 12 } // three slots: four processors and 8 GiB each
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
    const host = { totalMemory: () => 16 * GIB, processors: () => 8 } // two slots: four processors and 8 GiB each
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

  test('a dead holder whose slot cannot be moved never stops the wait from reaching its deadline', async () => {
    const root = fixtureDir('round-lock-stuck-')
    const dead = await acquireRoundTestLock({
      ...ONE_SLOT,
      rootDir: root,
      deadlineAt: Date.now() + 5_000,
      pid: 999_999,
      startHeartbeat: () => () => {}
    })
    if (!dead.ok) throw new Error('the slot must be taken')
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(join(roundTestSlotDir(root, 0), 'heartbeat'), old, old)
    // The runtime root refuses the reclaim's rename: the dead holder stays dead and its slot stays put.
    chmodSync(root, 0o500)
    try {
      const waited = await acquireRoundTestLock({
        ...ONE_SLOT,
        rootDir: root,
        deadlineAt: Date.now() + 300,
        pollMs: 10,
        isAlive: () => false
      })
      expect(waited).toMatchObject({ ok: false, reason: 'timeout' })
    } finally {
      chmodSync(root, 0o700)
    }
  })
})
