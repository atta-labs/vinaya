import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

// Kept apart from `loop-log.ts` so the round-test progress observer appends driver-log lines without loading
// the redaction, and with it the Log SDK, at start-up.

/** Matches `dispatch.ts`'s own `openOutputTee` cap — past this, further lines are silently dropped rather than growing the file unbounded. Narration, not evidence: losing the tail of a very long run is an acceptable cost for never blocking or crashing the driver over disk growth. */
export const LOOP_LOG_MAX_BYTES = 8 * 1024 * 1024

/**
 * Appends one line (a trailing `\n` is added) to `path`, creating the file
 * and its parent directory as needed. Never throws — a narration write must
 * never be able to break the driver it is narrating. `O_NOFOLLOW` refuses to
 * follow a symlink at `path` (the same traversal/symlink hardening every other
 * append-to-a-forge-adjacent-path primitive in this codebase applies).
 */
export function appendLoopLogLine(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600
    )
    try {
      const stat = fstatSync(fd)
      if (stat.isFile() && stat.size < LOOP_LOG_MAX_BYTES) {
        writeSync(fd, `${line}\n`)
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    // Best-effort — see the module comment.
  }
}
