// One actor against a shared control store, run as its own OS process so two
// actors genuinely overlap: a superseded owner writing, a newer owner
// claiming and reading, or a process holding the task's lock. Every mode
// calls the SHIPPED store functions from `../local` — never a stand-in.
//
// Argv: <mode> <rootDir> <task> [<arg>]. Prints one JSON line to stdout per
// step named below.
//
// - `write-paused <epoch> <run|started|verified>`: makes one fenced write at
//   `<epoch>` — run record `r-0`, started effect `e-0`, or effect `v-0`
//   (written as started first, then as verified) — and pauses that write
//   between its ownership check and its write: it creates
//   `<rootDir>/<task>-paused`, then waits until `<rootDir>/<task>-go` exists
//   or `PAUSE_BOUND_MS` passes. Prints `{"paused":bool,"wrote":bool}`;
//   `wrote` is false when the write was refused as stale.
// - `claim-and-list <ownerId>`: claims ownership, then at once lists the run
//   records on disk and the started effects; prints
//   `{"claim":…,"runs":[…],"started":[…]}`.
// - `claim-and-mark <ownerId>`: claims ownership, then marks every started
//   effect uncertain; prints `{"claim":…,"marked":[keys marked]}`.
// - `die-holding`: takes the task's lock and exits without releasing it;
//   prints `{"pid":n}` first.
// - `hold`: takes the task's lock, prints `{"held":true}`, and keeps it until
//   killed.
// - `take`: takes the task's lock, marks `<rootDir>/inside` exclusively
//   (reporting an overlap if it is already there), holds briefly, removes the
//   mark and releases; prints `{"tookOverFrom":pid|null,"overlap":bool}`.

import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnership,
  acquireTaskLock,
  type ControlStoreDeps,
  type EffectInput,
  listStartedEffectKeys,
  markEffectUncertain,
  StaleEpochWriteError,
  writeEffect,
  writeRun
} from '../local'

const [, , mode, rootDir, taskArg, arg = '', what = ''] = process.argv as string[] as [
  string,
  string,
  string,
  string,
  string,
  string?,
  string?
]
const task = Number.parseInt(taskArg, 10)

/**
 * How long a paused write waits for its go signal. Under the task's lock the
 * newer claim cannot run while the write is paused, so no signal comes and the
 * write goes on after this wait; without the lock the claim and its listing
 * finish inside it.
 */
const PAUSE_BOUND_MS = 1_000

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The pause sits in `deps.root`, which a fenced write calls both inside its
 * ownership check (`readCurrentOwnership`) and again to name the file it
 * writes. Once armed, the first call made after a check, and outside one, is
 * the point between the check and the write.
 */
let armed = false
let checked = false
let paused = false

function root(): string {
  if (armed && !paused) {
    const stack = new Error().stack ?? ''
    if (stack.includes('readCurrentOwnership')) checked = true
    else if (checked) {
      paused = true
      writeFileSync(join(rootDir, `${task}-paused`), '')
      const go = join(rootDir, `${task}-go`)
      const until = Date.now() + PAUSE_BOUND_MS
      while (Date.now() < until && !existsSync(go)) sleepSyncMs(5)
    }
  }
  return rootDir
}

const deps: ControlStoreDeps = {
  root,
  now: () => new Date(),
  pid: () => process.pid,
  hostname: () => hostname()
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function effect(status: 'started' | 'verified'): EffectInput {
  return {
    operation: 'pr-comment',
    target: 'pr:1',
    inputVersion: 1,
    payloadDigest: 'deadbeef',
    status,
    recordedAt: new Date().toISOString()
  }
}

function runIds(): string[] {
  const dir = join(rootDir, String(task), 'control', 'run')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

switch (mode) {
  case 'write-paused': {
    const epoch = Number.parseInt(arg, 10)
    if (what === 'verified') writeEffect(deps, task, epoch, 'v-0', effect('started'))
    armed = true
    let wrote = true
    try {
      if (what === 'run') {
        writeRun(deps, task, epoch, {
          runId: 'r-0',
          pid: process.pid,
          host: hostname(),
          startedAt: new Date().toISOString()
        })
      } else if (what === 'started') {
        writeEffect(deps, task, epoch, 'e-0', effect('started'))
      } else if (what === 'verified') {
        writeEffect(deps, task, epoch, 'v-0', effect('verified'))
      } else {
        throw new Error(`unknown write ${what}`)
      }
    } catch (err) {
      if (!(err instanceof StaleEpochWriteError)) throw err
      wrote = false
    }
    print({ paused, wrote })
    break
  }
  case 'claim-and-list': {
    const claim = acquireOwnership(deps, task, arg)
    print({ claim, runs: runIds(), started: listStartedEffectKeys(deps, task).sort() })
    break
  }
  case 'claim-and-mark': {
    const claim = acquireOwnership(deps, task, arg)
    const marked: string[] = []
    if (claim.acquired) {
      for (const key of listStartedEffectKeys(deps, task)) {
        if (markEffectUncertain(deps, task, claim.epoch, key)) marked.push(key)
      }
    }
    print({ claim, marked: marked.sort() })
    break
  }
  case 'die-holding': {
    acquireTaskLock(deps, task)
    print({ pid: process.pid })
    process.exit(0)
    break
  }
  case 'hold': {
    acquireTaskLock(deps, task)
    print({ held: true })
    setInterval(() => {}, 1_000)
    break
  }
  case 'take': {
    const hold = acquireTaskLock(deps, task)
    const inside = join(rootDir, 'inside')
    let overlap = false
    try {
      writeFileSync(inside, String(process.pid), { flag: 'wx' })
    } catch {
      overlap = true
    }
    sleepSyncMs(200)
    if (!overlap) unlinkSync(inside)
    hold.release()
    print({ tookOverFrom: hold.tookOverFrom?.pid ?? null, overlap })
    break
  }
  default:
    throw new Error(`unknown mode ${mode}`)
}
