/**
 * One-time migration from the dev-review-loop's pre-control-store side
 * files (`apps/cli/src/lib/dev-review-loop/pause-resume.ts`'s
 * `driver.pid.json`/`pause-state.json`, `publication.ts`'s
 * `effect-<key>.json`) into a task's first control-store epoch (Issue
 * #551, O3).
 *
 * This module reads the legacy layout directly rather than importing
 * `apps/cli` — the dependency runs the other way (the CLI depends on
 * `@attalabs/aeg-core`, never the reverse) — so the three legacy shapes
 * below are a deliberate, narrow re-statement of what those two files
 * already write, not a shared implementation.
 *
 * Refuses rather than guesses whenever ownership would be ambiguous:
 * a legacy driver whose pid still answers a liveness probe is still
 * mutating those side files, so migrating underneath it would race it;
 * a task that already holds a control-store epoch has already moved on
 * from the legacy layout, so re-migrating it would silently overwrite
 * real history. Both refuse rather than pick a side.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireOwnership,
  appendTransition,
  type ControlStoreDeps,
  readCurrentOwnership,
  writeInput,
  writeRun
} from './local'

type LegacyRead<T> = { status: 'ok'; value: T } | { status: 'absent' } | { status: 'corrupt'; reason: string }

function readLegacyJson<T>(path: string, isShape: (json: unknown) => json is T): LegacyRead<T> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent' }
    }
    return { status: 'corrupt', reason: err instanceof Error ? err.message : String(err) }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { status: 'corrupt', reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isShape(json)) return { status: 'corrupt', reason: 'does not match the expected legacy shape' }
  return { status: 'ok', value: json }
}

type LegacyDriverLock = { pid: number; startedAt: string }
function isLegacyDriverLock(json: unknown): json is LegacyDriverLock {
  return (
    typeof json === 'object' &&
    json !== null &&
    typeof (json as Record<string, unknown>).pid === 'number' &&
    typeof (json as Record<string, unknown>).startedAt === 'string'
  )
}

type LegacyPauseState = {
  round: number
  reason: string
  detail?: string
  prNumber: number
  pausedAt: string
}
function isLegacyPauseState(json: unknown): json is LegacyPauseState {
  const rec = json as Record<string, unknown>
  return (
    typeof json === 'object' &&
    json !== null &&
    typeof rec.round === 'number' &&
    typeof rec.reason === 'string' &&
    typeof rec.prNumber === 'number' &&
    typeof rec.pausedAt === 'string' &&
    (rec.detail === undefined || typeof rec.detail === 'string')
  )
}

type LegacyEffectRecord = { effectId: string; status: 'started' | 'posted'; url?: string }
function isLegacyEffectRecord(json: unknown): json is LegacyEffectRecord {
  const rec = json as Record<string, unknown>
  return (
    typeof json === 'object' &&
    json !== null &&
    typeof rec.effectId === 'string' &&
    (rec.status === 'started' || rec.status === 'posted') &&
    (rec.url === undefined || typeof rec.url === 'string')
  )
}

function legacyTaskDir(legacyOutboxRoot: string, task: number): string {
  return join(legacyOutboxRoot, 'dev-review-loop', String(task))
}

/** The same signal-0 liveness idiom `pause-resume.ts`'s `isDriverPidAlive` uses — restated here so this module never imports across the CLI/engine boundary. Used only as a one-time migration-timing safety gate, never as this store's own ownership model (that model is the epoch fence in `local.ts`). */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type MigrationResult =
  | { status: 'migrated'; task: number; epoch: number; transitionsWritten: number }
  | { status: 'nothing-to-migrate'; task: number }
  | { status: 'refused'; reason: string }

export function migrateLegacyTask(
  deps: ControlStoreDeps,
  legacyOutboxRoot: string,
  task: number,
  ownerId: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive
): MigrationResult {
  const dir = legacyTaskDir(legacyOutboxRoot, task)
  if (!existsSync(dir)) return { status: 'nothing-to-migrate', task }

  const driverLock = readLegacyJson(join(dir, 'driver.pid.json'), isLegacyDriverLock)
  if (driverLock.status === 'corrupt') {
    return { status: 'refused', reason: `legacy driver.pid.json for task ${task} is corrupt: ${driverLock.reason}` }
  }
  if (driverLock.status === 'ok' && isPidAlive(driverLock.value.pid)) {
    return {
      status: 'refused',
      reason: `legacy driver pid ${driverLock.value.pid} is still live for task ${task} — migrate only after it exits`
    }
  }

  const pauseState = readLegacyJson(join(dir, 'pause-state.json'), isLegacyPauseState)
  if (pauseState.status === 'corrupt') {
    return { status: 'refused', reason: `legacy pause-state.json for task ${task} is corrupt: ${pauseState.reason}` }
  }

  const effectFiles = readdirSync(dir)
    .filter((name) => /^effect-.+\.json$/.test(name))
    .sort()
  const effects: { key: string; record: LegacyEffectRecord }[] = []
  for (const name of effectFiles) {
    const parsed = readLegacyJson(join(dir, name), isLegacyEffectRecord)
    if (parsed.status === 'corrupt') {
      return { status: 'refused', reason: `legacy ${name} for task ${task} is corrupt: ${parsed.reason}` }
    }
    if (parsed.status === 'ok') {
      effects.push({ key: name.replace(/^effect-/, '').replace(/\.json$/, ''), record: parsed.value })
    }
  }

  if (driverLock.status === 'absent' && pauseState.status === 'absent' && effects.length === 0) {
    return { status: 'nothing-to-migrate', task }
  }

  const priorEpoch = readCurrentOwnership(deps, task)
  if (priorEpoch.epoch > 0) {
    return {
      status: 'refused',
      reason: `task ${task} already has a control-store epoch ${priorEpoch.epoch} — migration only runs against a task with no existing epoch`
    }
  }

  const acquired = acquireOwnership(deps, task, ownerId)
  if (!acquired.acquired) {
    return {
      status: 'refused',
      reason: `task ${task} already has a control-store epoch ${acquired.currentEpoch} — migration only runs against a task with no existing epoch`
    }
  }
  const epoch = acquired.epoch

  const now = deps.now().toISOString()
  writeRun(deps, task, epoch, {
    runId: ownerId,
    pid: driverLock.status === 'ok' ? driverLock.value.pid : deps.pid(),
    host: deps.hostname(),
    startedAt: driverLock.status === 'ok' ? driverLock.value.startedAt : now
  })
  writeInput(deps, task, epoch, {
    runId: ownerId,
    source: pauseState.status === 'ok' ? 'resume' : 'fresh',
    pr: pauseState.status === 'ok' ? pauseState.value.prNumber : null,
    round: pauseState.status === 'ok' ? pauseState.value.round : 0,
    recordedAt: now
  })

  let transitionsWritten = 0
  if (pauseState.status === 'ok') {
    appendTransition(deps, task, epoch, {
      from: 'active',
      to: `paused:${pauseState.value.reason}`,
      detail: pauseState.value.detail,
      at: pauseState.value.pausedAt
    })
    transitionsWritten++
  }
  for (const { key, record } of effects) {
    appendTransition(deps, task, epoch, {
      from: 'pending',
      to: `effect:${key}:${record.status}`,
      detail: record.url,
      at: now
    })
    transitionsWritten++
  }

  return { status: 'migrated', task, epoch, transitionsWritten }
}
