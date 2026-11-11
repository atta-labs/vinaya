import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { join } from 'node:path'

// A host-wide counted lock for round-test runs: a fixed number of slots, each a directory taken with an atomic `mkdir`
// under the runtime root (the parent of every repository's own runtime directory), kept alive by a heartbeat file its
// holder touches, and reclaimed from a holder whose process died and whose heartbeat stopped. The slot count comes
// from the host's memory and processors, so a small host runs one round-test run at a time and a large one runs
// several, whichever number of drivers and repositories are running.

/** The first slot's directory name under the runtime root; slot `i > 0` is this name followed by `.<i>`. */
export const ROUND_TEST_LOCK_DIRNAME = 'round-tests.lock'

/** The memory one round-test slot is sized for. */
export const ROUND_TEST_SLOT_MEMORY_BYTES = 4 * 1024 ** 3

/**
 * How many round-test runs a host runs at once: one per 4 GiB of memory and per two logical processors, whichever
 * is fewer, and never fewer than one. A host below 8 GiB keeps a single slot.
 */
export function roundTestSlotCount(host: { totalMemoryBytes: number; processors: number }): number {
  const byMemory = Math.floor(host.totalMemoryBytes / ROUND_TEST_SLOT_MEMORY_BYTES)
  const byProcessors = Math.floor(host.processors / 2)
  return Math.max(1, Math.min(byMemory, byProcessors))
}

/** The directory of slot `index` under `rootDir`. */
export function roundTestSlotDir(rootDir: string, index: number): string {
  return join(rootDir, index === 0 ? ROUND_TEST_LOCK_DIRNAME : `${ROUND_TEST_LOCK_DIRNAME}.${index}`)
}

const OWNER_FILE = 'owner.json'
const HEARTBEAT_FILE = 'heartbeat'

/** How often a holder touches its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 5_000
/** How old a heartbeat must be before its holder may be reclaimed (when its process is gone). */
export const HEARTBEAT_STALE_MS = 30_000
/** A heartbeat this old is dead whatever the holder's pid says (a pid can be reused by another process). */
const HEARTBEAT_ABANDONED_MS = 10 * 60_000
/** How often a waiter looks at the lock again. */
export const LOCK_POLL_MS = 1_000

export type RoundTestLockResult =
  | { ok: true; release: () => void; slot: number; slots: number; waitedMs: number }
  | { ok: false; reason: 'timeout' | 'cancel' | 'error'; detail: string }

export interface RoundTestLockOptions {
  /** The runtime root: the parent directory of the repository's runtime directory. */
  rootDir: string
  /** The absolute time, on `now`'s clock, past which the wait gives up. */
  deadlineAt: number
  now?: () => number
  signal?: AbortSignal
  /** Waits `ms`, ending early when `signal` aborts. A test fakes the clock through it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  heartbeatIntervalMs?: number
  staleMs?: number
  pollMs?: number
  /** Whether a process is alive; the real check when absent. */
  isAlive?: (pid: number) => boolean
  pid?: number
  /** Starts the heartbeat: calls `beat` every `ms`, returns its canceller. A test fakes it. */
  startHeartbeat?: (beat: () => void, ms: number) => () => void
  /** The host's total memory in bytes; the real reading when absent. */
  totalMemory?: () => number
  /** The host's logical processor count; the real reading when absent. */
  processors?: () => number
  /** Called once, when every slot is held and the caller starts to wait. */
  onWait?: (info: { slots: number }) => void
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function realIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function realHeartbeat(beat: () => void, ms: number): () => void {
  const timer = setInterval(beat, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}

function readOwner(lockDir: string): { pid: number; token: string } | null {
  try {
    const value = JSON.parse(readFileSync(join(lockDir, OWNER_FILE), 'utf8')) as { pid?: unknown; token?: unknown }
    return typeof value.pid === 'number' && typeof value.token === 'string'
      ? { pid: value.pid, token: value.token }
      : null
  } catch {
    return null
  }
}

/** The last time the holder proved it was alive, in epoch ms; null when the lock directory is gone. */
function lastBeat(lockDir: string): number | null {
  for (const path of [join(lockDir, HEARTBEAT_FILE), lockDir]) {
    try {
      return statSync(path).mtimeMs
    } catch {
      // Try the directory itself: a holder that died between `mkdir` and its first heartbeat.
    }
  }
  return null
}

/** Whether the lock's holder is dead: its heartbeat stopped and its process is gone (or the beat is long abandoned). */
function holderDead(lockDir: string, nowMs: number, staleMs: number, isAlive: (pid: number) => boolean): boolean {
  const beat = lastBeat(lockDir)
  if (beat === null) return false
  const age = nowMs - beat
  if (age <= staleMs) return false
  const owner = readOwner(lockDir)
  return owner === null || !isAlive(owner.pid) || age > HEARTBEAT_ABANDONED_MS
}

/**
 * Takes the first free round-test slot, waiting for one to free up until `deadlineAt`. Returns a `release` that stops
 * the heartbeat and removes the slot's directory (only when it still belongs to this holder), the slot taken, the slot
 * count and how long the wait lasted. Never throws: a failure is `ok: false`.
 */
export async function acquireRoundTestLock(options: RoundTestLockOptions): Promise<RoundTestLockResult> {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? realSleep
  const isAlive = options.isAlive ?? realIsAlive
  const staleMs = options.staleMs ?? HEARTBEAT_STALE_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const token = `${options.pid ?? process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`
  const startedAt = now()
  let waiting = false
  try {
    const slots = roundTestSlotCount({
      totalMemoryBytes: (options.totalMemory ?? totalmem)(),
      processors: (options.processors ?? availableParallelism)()
    })
    mkdirSync(options.rootDir, { recursive: true, mode: 0o700 })
    for (;;) {
      if (options.signal?.aborted)
        return { ok: false, reason: 'cancel', detail: 'cancelled while waiting for the lock' }
      for (let slot = 0; slot < slots; slot++) {
        const lockDir = roundTestSlotDir(options.rootDir, slot)
        try {
          mkdirSync(lockDir, { mode: 0o700 })
          writeFileSync(join(lockDir, OWNER_FILE), JSON.stringify({ pid: options.pid ?? process.pid, token }))
          writeFileSync(join(lockDir, HEARTBEAT_FILE), String(now()))
          utimesSync(join(lockDir, HEARTBEAT_FILE), new Date(now()), new Date(now()))
          return {
            ok: true,
            release: holdLock(lockDir, token, options),
            slot,
            slots,
            waitedMs: waiting ? Math.max(0, now() - startedAt) : 0
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        if (holderDead(lockDir, now(), staleMs, isAlive)) {
          // One reclaimer wins the rename (each slot has its own aside name); a loser's rename fails and it looks again.
          const aside = `${lockDir}.reclaimed-${token}`
          try {
            renameSync(lockDir, aside)
            rmSync(aside, { recursive: true, force: true })
          } catch {
            // Someone else reclaimed it first.
          }
          slot--
        }
      }
      if (!waiting) {
        waiting = true
        options.onWait?.({ slots })
      }
      const remaining = options.deadlineAt - now()
      if (remaining <= 0) return { ok: false, reason: 'timeout', detail: 'every slot stayed held until the deadline' }
      await sleep(Math.min(pollMs, remaining), options.signal)
    }
  } catch (error) {
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) }
  }
}

function holdLock(lockDir: string, token: string, options: RoundTestLockOptions): () => void {
  const now = options.now ?? (() => Date.now())
  const beat = () => {
    try {
      const at = new Date(now())
      utimesSync(join(lockDir, HEARTBEAT_FILE), at, at)
    } catch {
      // A beat that cannot be written is a beat missed; the holder is reclaimed only after several.
    }
  }
  const stop = (options.startHeartbeat ?? realHeartbeat)(beat, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
  let released = false
  return () => {
    if (released) return
    released = true
    stop()
    // Only the holder that wrote the lock removes it: a reclaimed lock now belongs to someone else.
    if (readOwner(lockDir)?.token === token) rmSync(lockDir, { recursive: true, force: true })
  }
}
