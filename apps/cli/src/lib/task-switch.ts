/**
 * `vinaya task switch`: changes the agent or model the next `task run` of a task uses, by setting the task's Engine
 * checkpoint aside. The Engine continues a run only on the agent its checkpoint started with, so a checkpoint kept
 * in place refuses another agent; one set aside leaves the next run to start from the task's branch and pull
 * request, which are never touched. The checkpoint is moved, never deleted: its three sqlite files go together into
 * a timestamped folder of the task's run directory. The standalone runner already continues a task on a new agent by
 * itself, so there the switch changes nothing on disk.
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRunner } from './config.js'
import type { AgentVendor } from './dispatch.js'
import { isDriverPidAlive, readDriverLock } from './dev-review-loop/pause-resume.js'
import { appendDriverLine, loopLogPathFor } from './loop-log.js'
import { engineRunDirectory, readTaskRunner } from './task-run-engine.js'

/** The checkpoint file and the write-ahead-log siblings that must travel with it. */
export const CHECKPOINT_FILES = ['checkpoints.sqlite', 'checkpoints.sqlite-wal', 'checkpoints.sqlite-shm'] as const

/** What a checkpoint recorded of the run that wrote it; a field is null when the checkpoint never recorded it. */
export type CheckpointRecord = { agent: string | null; model: string | null }

export type SwitchTaskInput = { task: number; agent: AgentVendor; model?: string | undefined }

export type SwitchTaskDeps = {
  runtimeDir: string
  readRunner: (task: number) => TaskRunner
  /** The pid of the live driver holding the task's lock, or null. */
  liveDriverPid: (task: number) => number | null
  /** The agent and model the newest checkpoint of the task recorded; null when the file cannot be read. */
  readCheckpointRecord: (checkpointFile: string) => Promise<CheckpointRecord | null>
  /** Whether the task's branch carries commits beyond main or has a pull request. */
  hasPublishedWork: (task: number) => boolean
  logLine: (task: number, words: string) => void
  now: () => Date
}

export type SwitchTaskResult =
  | { kind: 'standalone'; message: string }
  | { kind: 'refused'; message: string }
  | {
      kind: 'switched'
      message: string
      publishedWork: boolean
      /** The folder the checkpoint went to; null when the task had no checkpoint. */
      folder: string | null
      moved: string[]
    }

/** A folder name for the moment of the switch, safe on every filesystem. */
const folderStamp = (at: Date): string => at.toISOString().replaceAll(':', '-')

/** The timestamped folder inside `runDir` that does not exist yet. */
function freshFolder(runDir: string, at: Date): string {
  const base = join(runDir, `switched-${folderStamp(at)}`)
  let candidate = base
  for (let suffix = 2; existsSync(candidate); suffix++) candidate = `${base}-${suffix}`
  return candidate
}

export async function switchTask(input: SwitchTaskInput, deps: SwitchTaskDeps): Promise<SwitchTaskResult> {
  const { task, agent } = input
  if (deps.readRunner(task) !== 'atta-engine') {
    return {
      kind: 'standalone',
      message: `vinaya task switch: task ${task} runs on the standalone runner, which already continues a task on a new --agent by itself; nothing was changed. Run: vinaya task run --issue ${task} --agent ${agent}${input.model ? ` --model ${input.model}` : ''}`
    }
  }
  const pid = deps.liveDriverPid(task)
  if (pid !== null) {
    return {
      kind: 'refused',
      message: `vinaya task switch: task ${task}'s driver (pid ${pid}) is still running; nothing was changed. Let it reach its pause, or stop it, then switch.`
    }
  }
  const runDir = engineRunDirectory(task, deps.runtimeDir)
  const present = CHECKPOINT_FILES.filter((name) => existsSync(join(runDir, name)))
  const database = join(runDir, CHECKPOINT_FILES[0])
  const record = existsSync(database) ? await deps.readCheckpointRecord(database) : null
  const publishedWork = deps.hasPublishedWork(task)
  let folder: string | null = null
  if (present.length > 0) {
    folder = freshFolder(runDir, deps.now())
    mkdirSync(folder, { recursive: true })
    // The database file goes last: a switch cut short leaves it in place, so the next run still refuses rather than
    // opening a lone file whose log it lost.
    for (const name of [...present].reverse()) renameSync(join(runDir, name), join(folder, name))
  }
  const fromAgent = record?.agent ?? 'unrecorded'
  const fromModel = record?.model ? record.model : 'vendor default'
  const toModel = input.model ?? 'vendor default'
  deps.logLine(
    task,
    `Switched task ${task} from ${fromAgent} (${fromModel}) to ${agent} (${toModel}); old checkpoint ${folder ?? 'none, the task had no checkpoint'}`
  )
  const next = `vinaya task run --issue ${task} --agent ${agent}${input.model ? ` --model ${input.model}` : ''}`
  const where =
    folder === null ? 'The task had no checkpoint to set aside.' : `The old checkpoint is kept in ${folder}.`
  const work = publishedWork
    ? 'Its branch and pull request are untouched; the next run continues them from the next round.'
    : 'It has no published work; the next run starts fresh.'
  return {
    kind: 'switched',
    message: `vinaya task switch: task ${task} now continues on ${agent} (${toModel}). ${where} ${work} Run: ${next}`,
    publishedWork,
    folder,
    moved: present
  }
}

/** Reads the newest checkpoint's agent and model with a read-only sqlite handle; null when the file cannot be read. */
export async function readCheckpointRecordFromFile(file: string): Promise<CheckpointRecord | null> {
  try {
    // Loaded here: only a switch that finds a checkpoint needs a database.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const columns = new Set(
        (db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[]).map((column) => column.name)
      )
      if (!columns.has('model')) return null
      const row = db
        .prepare(
          `SELECT model, ${columns.has('agent') ? 'agent' : 'NULL AS agent'} FROM checkpoints WHERE checkpoint_ns = '' ORDER BY rowid DESC LIMIT 1`
        )
        .get() as { model: string | null; agent: string | null } | undefined
      return row === undefined ? null : { agent: row.agent, model: row.model }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Whether the task's branch has a pull request or commits beyond main, read from the forge and the local git. */
export function realHasPublishedWork(
  task: number,
  deps: {
    developerBranchFor: (issue: number) => string
    findOpenPrForBranch: (branch: string) => unknown
    commitsBeyondMain: (branch: string) => number
  }
): boolean {
  const branch = deps.developerBranchFor(task)
  return deps.findOpenPrForBranch(branch) !== null || deps.commitsBeyondMain(branch) > 0
}

export function liveSwitchDeps(runtimeDir: string, published: SwitchTaskDeps['hasPublishedWork']): SwitchTaskDeps {
  return {
    runtimeDir,
    readRunner: (task) => readTaskRunner(task, runtimeDir),
    liveDriverPid: (task) => {
      const lock = readDriverLock(runtimeDir, task)
      return lock !== null && isDriverPidAlive(lock.pid) ? lock.pid : null
    },
    readCheckpointRecord: readCheckpointRecordFromFile,
    hasPublishedWork: published,
    logLine: (task, words) => appendDriverLine(loopLogPathFor(null, task, runtimeDir), words),
    now: () => new Date()
  }
}
