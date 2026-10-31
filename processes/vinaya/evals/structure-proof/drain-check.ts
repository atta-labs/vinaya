#!/usr/bin/env bun
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isDriverPidAlive,
  readDriverLock,
  readPauseState
} from '../../../../apps/cli/src/lib/dev-review-loop/pause-resume'
import { runtimeDirForThisRepo, TASKS_EXECUTION_DIRNAME } from '../../../../apps/cli/src/lib/run-paths'
import { SqliteCheckpointer } from '../../../../harness/dev-process/engine-runtime/sqlite-checkpointer'
import { checkpointPath, runDirectory } from '../../bin/run-engine'
import { chooseStart, currentRunGeneration, runIdentityOfTask } from '../../bin/run-lifecycle'

// The drain check a host that runs loops passes before a path move: every task in its local runtime directory with a
// live driver, a held pause, or an Engine run whose checkpoint is not at a terminal step is a run the move could cross.
// It reads the runtime directory itself rather than the forge, so a run whose Issue was already closed is still found.
// Usage: bun evals/structure-proof/drain-check.ts [--runtime-dir <path>]

/** How one task's local run stands. `live` and `resumable` block a move; `completed` is history. */
export type DrainState = 'live' | 'resumable' | 'completed'

export interface DrainEntry {
  task: number
  state: DrainState
  /** What was found, one phrase per reader that found something. */
  found: string[]
}

export interface DrainReport {
  runtimeDir: string
  entries: DrainEntry[]
  /** True when any run is live or resumable. */
  blocked: boolean
}

export interface DrainDeps {
  isPidAlive: (pid: number) => boolean
}

const numericFolders = (dir: string): number[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => Number(entry.name))
    : []

/** Where the task's Engine run stands, read through the runtime's own checkpointer and start choice. */
async function engineRunState(runtimeDir: string, task: number): Promise<{ state: DrainState; found: string } | null> {
  const file = checkpointPath(runDirectory(runtimeDir, task))
  if (!existsSync(file)) return null
  // A checkpoint no runner can read is never taken as finished: it blocks until it is repaired or set aside.
  const unreadable = (error: unknown) => ({
    state: 'resumable' as const,
    found: `an Engine checkpoint that cannot be read (${error instanceof Error ? error.message : String(error)})`
  })
  let saver: SqliteCheckpointer
  try {
    saver = new SqliteCheckpointer({ path: file, revision: 'unknown' })
  } catch (error) {
    return unreadable(error)
  }
  try {
    const identity = runIdentityOfTask(task, currentRunGeneration(saver, task))
    const choice = await chooseStart(saver, identity)
    switch (choice.kind) {
      case 'fresh':
        return null
      case 'completed':
      case 'exhausted':
        return { state: 'completed', found: `an Engine run at a terminal step (${choice.kind}, ${identity.runId})` }
      case 'resume':
        return {
          state: 'resumable',
          found: `an Engine run whose checkpoint is not at a terminal step (${identity.runId})`
        }
      case 'refused':
        return {
          state: 'resumable',
          found: `an Engine checkpoint a runner refuses (${choice.refusal.code}, ${identity.runId})`
        }
    }
  } catch (error) {
    return unreadable(error)
  } finally {
    saver.close()
  }
}

/** Every local run under `runtimeDir`, whether or not its Issue is still open. */
export async function drainReport(
  runtimeDir: string,
  deps: DrainDeps = { isPidAlive: isDriverPidAlive }
): Promise<DrainReport> {
  const tasks = new Set([
    ...numericFolders(join(runtimeDir, TASKS_EXECUTION_DIRNAME)),
    ...numericFolders(join(runtimeDir, 'engine-runs'))
  ])
  const entries: DrainEntry[] = []
  for (const task of [...tasks].sort((a, b) => a - b)) {
    const found: string[] = []
    let state: DrainState | null = null
    const raise = (to: DrainState): void => {
      const rank: Record<DrainState, number> = { completed: 0, resumable: 1, live: 2 }
      if (state === null || rank[to] > rank[state]) state = to
    }
    const lock = readDriverLock(runtimeDir, task)
    if (lock !== null) {
      if (deps.isPidAlive(lock.pid)) {
        found.push(`a live driver lock (pid ${lock.pid}, since ${lock.startedAt})`)
        raise('live')
      } else {
        found.push(`a driver lock whose process is gone (pid ${lock.pid}, since ${lock.startedAt})`)
        raise('resumable')
      }
    }
    const pause = readPauseState(runtimeDir, task)
    if (pause !== null) {
      found.push(`a pause state (${pause.reason}, round ${pause.round}, on ${pause.agent ?? 'an unrecorded agent'})`)
      raise('resumable')
    }
    const engine = await engineRunState(runtimeDir, task)
    if (engine !== null) {
      found.push(engine.found)
      raise(engine.state)
    }
    if (state !== null) entries.push({ task, state, found })
  }
  return { runtimeDir, entries, blocked: entries.some((entry) => entry.state !== 'completed') }
}

/** The report as the lines the procedure records per host. */
export function renderDrainReport(report: DrainReport): string[] {
  const section = (state: DrainState, title: string): string[] => {
    const rows = report.entries.filter((entry) => entry.state === state)
    return [`${title}: ${rows.length}`, ...rows.map((entry) => `  task ${entry.task}: ${entry.found.join('; ')}`)]
  }
  return [
    `runtime directory: ${report.runtimeDir}`,
    ...section('live', 'live runs'),
    ...section('resumable', 'resumable runs'),
    ...section('completed', 'completed history'),
    report.blocked ? 'NOT DRAINED: a live or resumable run could cross the move' : 'drained: no live or resumable run'
  ]
}

function runtimeDirArg(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--runtime-dir')
  if (at === -1) return undefined
  const value = argv[at + 1]
  if (!value) throw new Error('drain-check: --runtime-dir takes a path')
  return value
}

if (import.meta.main) {
  const runtimeDir = runtimeDirArg(process.argv.slice(2)) ?? runtimeDirForThisRepo()
  const report = await drainReport(runtimeDir)
  for (const line of renderDrainReport(report)) console.log(line)
  process.exit(report.blocked ? 1 : 0)
}
