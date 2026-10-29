#!/usr/bin/env node
/**
 * The progress observer (`vinaya-push-progress-observer`): a separate process the version-2 driver starts before
 * each push or explicit-command run, since the driver's own pushes run inside the broker's synchronous effect poster
 * and no timer of the driver's can run during them. It tails the reserved progress directory into the task's driver
 * log as ordinary loop lines (`push-progress.ts`'s `ProgressReader`), writes each test run's 60-second line, and
 * exits on TERM after a last read, or by itself once the driver that started it is gone.
 *
 * Arguments: `<progress dir> <driver log path> <driver pid>`, all from the driver that spawned it. It only reads the
 * directory and only appends to the log; it never decides anything.
 */
import { appendLoopLogLine } from './loop-log.js'
import { ProgressReader } from './push-progress.js'

/** How often the directory is read. */
const POLL_MS = 200

/** A safety net: an observer never outlives this, whatever happened to its driver. */
const MAX_LIFETIME_MS = 3 * 60 * 60 * 1000

const [dir, logPath, parentArg] = process.argv.slice(2)
const parent = Number(parentArg)
if (!dir || !logPath || !Number.isInteger(parent) || parent <= 0) process.exit(0)

const reader = new ProgressReader(dir as string, (line) =>
  appendLoopLogLine(logPath as string, `${new Date().toISOString()}  ${line}`)
)
const started = Date.now()
let stopping = false

function finish(): void {
  if (stopping) return
  stopping = true
  try {
    reader.close()
  } catch {
    // The last read is best-effort.
  }
  process.exit(0)
}

const parentAlive = (): boolean => {
  if (process.ppid !== parent) return false
  try {
    process.kill(parent, 0)
    return true
  } catch {
    return false
  }
}

process.on('SIGTERM', finish)
process.on('SIGINT', finish)
process.on('SIGHUP', finish)

function poll(): void {
  if (stopping) return
  try {
    reader.scan()
    reader.tick()
  } catch {
    // A read that fails is retried on the next poll.
  }
  if (!parentAlive() || Date.now() - started > MAX_LIFETIME_MS) {
    finish()
    return
  }
  setTimeout(poll, POLL_MS)
}

poll()
