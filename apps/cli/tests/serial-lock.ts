import { lstatSync, mkdirSync, rmSync, utimesSync } from 'node:fs'

/**
 * A cross-process mutex for test files that spawn the same real CLI entry
 * point. `mkdir` is atomic on POSIX, so whichever process creates the lock
 * directory holds it, regardless of how many workers the runner schedules.
 *
 * Two failure modes of a naive mkdir lock are handled here:
 *
 * - A holder killed mid-test (SIGKILL, runner timeout) never reaches its
 *   `finally`, so its directory would block every later waiter until someone
 *   deletes it by hand. A lock whose mtime is older than `staleMs` is treated
 *   as abandoned and reclaimed.
 * - A slow but alive holder must not be mistaken for an abandoned one, so the
 *   holder refreshes the directory's mtime every `staleMs / 4` while it runs.
 *   A waiter therefore only ever reclaims a lock nobody is heartbeating.
 *
 * The lock path is inspected with `lstat`, never `stat`: a symlink planted at
 * the path is judged by its own mtime and removed as the link entry only,
 * so the target is neither followed nor touched.
 *
 * The staleness check and the reclaim are not atomic with each other, but
 * that gap is benign: the reclaim is followed by another `mkdir`, which stays
 * the sole gate — two waiters racing on a stale lock both `rmSync` (the second
 * is a no-op under `force`) and exactly one wins the next `mkdir`.
 */
export type SerialLockOptions = {
  /** Give up waiting after this long. Default one minute. */
  waitMs?: number
  /** A lock not heartbeated for this long is abandoned. Default five minutes. */
  staleMs?: number
  /** Delay between acquisition attempts. Default `50`ms. */
  pollMs?: number
}

export async function withSerialLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  { waitMs = 60_000, staleMs = 5 * 60_000, pollMs = 50 }: SerialLockOptions = {}
): Promise<T> {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      let stale = false
      try {
        stale = Date.now() - lstatSync(lockDir).mtimeMs > staleMs
      } catch {
        continue // vanished between mkdir and stat — retry immediately
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the serial lock at ${lockDir}`)
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }
  const heartbeat = setInterval(
    () => {
      try {
        const now = new Date()
        utimesSync(lockDir, now, now)
      } catch {
        // the directory is gone — nothing to keep alive; release below is a no-op
      }
    },
    Math.max(1, Math.floor(staleMs / 4))
  )
  heartbeat.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    rmSync(lockDir, { recursive: true, force: true })
  }
}
