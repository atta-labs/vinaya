#!/usr/bin/env node
/**
 * The pre-push hook's progress helper (`vinaya-push-progress`): the hook's only way into the reserved progress
 * directory. Every subcommand resolves that directory itself (`push-progress.ts`'s `resolveProgressDirLive`: a live
 * driver's mark, then `<runtimeDir>/engine-runs/<task>/progress` with no symlinked component); no path the hook
 * passes is ever written to. Every subcommand prints nothing, writes nothing when no directory resolves, and exits 0
 * whatever happens, so the hook's output and exit status are the same with progress on and off.
 *
 * - `dir` — prints `on` when a progress directory resolves, nothing otherwise. The hook uses it only as a switch.
 * - `check <name> <pass|fail> <started epoch seconds>` — one local step (lint, typecheck) finished.
 * - `follow <capture> <stream> <total>` — the copier: appends what the hook's test-output capture gains to the
 *   progress copy `<stream>.out`, until the hook stops it or the hook is gone. The capture itself is only read.
 * - `finish <capture> <stream> <total>` — the bounded final drain: appends the rest of the capture, to its end, then
 *   marks the copy ended. The hook runs it before it records, caches and removes the capture.
 */
import {
  appendProgressRecord,
  copyCaptureTail,
  FINAL_DRAIN_BOUND_MS,
  isProgressStreamName,
  type ProgressRecord,
  resolveProgressDirLive
} from './push-progress.js'

/** How often the copier looks at the capture. */
const FOLLOW_INTERVAL_MS = 250

const parentAlive = (parent: number): boolean => {
  if (process.ppid !== parent) return false
  try {
    process.kill(parent, 0)
    return true
  } catch {
    return false
  }
}

async function follow(dir: string, capture: string, stream: string): Promise<void> {
  const parent = process.ppid
  for (;;) {
    copyCaptureTail({ capture, dir, stream, deadline: Date.now() + FOLLOW_INTERVAL_MS })
    // The copier never outlives the hook that started it.
    if (!parentAlive(parent)) return
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_INTERVAL_MS))
  }
}

/** A copy's start record: the selection's file count, when the hook knows one. */
function testsStart(stream: string, total: string | undefined): ProgressRecord {
  const count = Number(total)
  return {
    v: 1,
    kind: 'tests-start',
    stream,
    total: Number.isInteger(count) && count > 0 ? count : null,
    label: 'selected tests'
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv
  // The hook stops the copier with TERM; `finish` copies whatever it had not, so it simply exits.
  if (command === 'follow') process.on('SIGTERM', () => process.exit(0))
  const dir = resolveProgressDirLive(process.cwd())
  if (dir === null) return
  switch (command) {
    case 'dir':
      process.stdout.write('on\n')
      return
    case 'check': {
      const [name, status, started] = args
      if (!name || !/^[a-z][a-z0-9-]{0,40}$/.test(name)) return
      const startedMs = Number(started) * 1000
      appendProgressRecord(dir, `steps-${process.ppid}.ndjson`, {
        v: 1,
        kind: 'check',
        name,
        outcome: status === 'pass' ? 'pass' : 'fail',
        ms: Number.isFinite(startedMs) && startedMs > 0 ? Math.max(0, Date.now() - startedMs) : 0
      })
      return
    }
    case 'follow': {
      const [capture, stream, total] = args
      if (!capture || !stream || !isProgressStreamName(stream)) return
      appendProgressRecord(dir, `${stream}.ndjson`, testsStart(stream, total))
      await follow(dir, capture, stream)
      return
    }
    case 'finish': {
      const [capture, stream, total] = args
      if (!capture || !stream || !isProgressStreamName(stream)) return
      // A copier stopped before it started wrote no start record: this one carries the total either way.
      appendProgressRecord(dir, `${stream}.ndjson`, testsStart(stream, total))
      copyCaptureTail({ capture, dir, stream, deadline: Date.now() + FINAL_DRAIN_BOUND_MS })
      appendProgressRecord(dir, `${stream}.ndjson`, { v: 1, kind: 'tests-end', stream })
      return
    }
    default:
      return
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  () => process.exit(0)
)
