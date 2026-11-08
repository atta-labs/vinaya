/**
 * `vinaya task switch`: changes the agent or model the next `task run` of a task uses, by setting the task's Engine
 * checkpoint aside. The Engine continues a run only on the agent its checkpoint started with, so a checkpoint kept
 * in place refuses another agent; one set aside leaves the next run to start from the task's branch and pull
 * request, which are never touched. The checkpoint is moved, never deleted: its three sqlite files go together into
 * a timestamped folder of the task's run directory. The standalone runner already continues a task on a new agent by
 * itself, so there the switch changes nothing on disk.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { assembleAndRenderBrief } from '../../../tools/task-contract/brief-assembly.js'
import type { TaskRunner } from '../../../integration/config/compose.js'
import type { AgentVendor } from '../dispatch/dispatch.js'
import {
  developerBranchAndTitleFor,
  developerBranchFor,
  fetchIssueLabels,
  fetchIssueTitle,
  findOpenPrForBranch
} from '../standalone/dev-review-loop/developer-dispatch.js'
import {
  isDriverPidAlive,
  readDriverLock,
  readPauseState,
  writePauseState
} from '../standalone/dev-review-loop/pause-resume.js'
import { runtimeDir as thisRepoRuntimeDir } from '../standalone/dev-review-loop/reviewer-dispatch.js'
import { appendDriverLine, loopLogPathFor } from '../../../../../kernel/log/client/loop-log.js'
import { engineRunDirectory, readTaskRunner } from './task-run-engine.js'
import { startBackgroundRun } from './task-run-background.js'

/** The checkpoint file and the write-ahead-log siblings that must travel with it. */
export const CHECKPOINT_FILES = ['checkpoints.sqlite', 'checkpoints.sqlite-wal', 'checkpoints.sqlite-shm'] as const

/** What a checkpoint recorded of the run that wrote it; a field is null when the checkpoint never recorded it. */
export type CheckpointRecord = { agent: string | null; model: string | null }

/** The two address forms a run accepts: `<tranche> <n>` for a tranche task, `--issue <n>` for a backlog Issue. */
export type TaskAddress = { tranche: string; n: number } | { issue: number }

export type SwitchTaskInput = {
  task: number
  /** The form the run is started and printed in; the `--issue` form of `task` when absent. */
  address?: TaskAddress | undefined
  agent: AgentVendor
  model?: string | undefined
}

/** The address as `task run` takes it on its command line. */
export function addressWords(address: TaskAddress): string {
  return 'tranche' in address ? `${address.tranche} ${address.n}` : `--issue ${address.issue}`
}

/** Whether a run accepts the address: a non-empty tranche with a positive whole task id, or a positive whole Issue. */
function addressIsRunnable(address: TaskAddress): boolean {
  if ('tranche' in address) {
    return (
      address.tranche.trim() !== '' && !address.tranche.startsWith('--') && Number.isInteger(address.n) && address.n > 0
    )
  }
  return Number.isInteger(address.issue) && address.issue > 0
}

export type SwitchTaskDeps = {
  runtimeDir: string
  readRunner: (task: number) => TaskRunner
  /** The pid of the live driver holding the task's lock, or null. */
  liveDriverPid: (task: number) => number | null
  /** The agent and model the newest checkpoint of the task recorded; null when the file cannot be read. */
  readCheckpointRecord: (checkpointFile: string) => Promise<CheckpointRecord | null>
  /** Whether the task's branch carries commits beyond main or has a pull request. */
  hasPublishedWork: (task: number) => boolean
  /**
   * Makes a held pause record name the new agent and model, so `--resume` on the new agent is accepted too; true when a
   * pause was held and rewritten. Nothing else of the pause changes.
   */
  rewritePauseAgent: (task: number, agent: AgentVendor, model: string | undefined) => boolean
  logLine: (task: number, words: string) => void
  now: () => Date
  /** Whether the task holds a pause record: a live driver that holds one is only waiting, not working a turn. */
  holdsPause: (task: number) => boolean
  /** Sends the driver a SIGTERM. */
  stopDriver: (pid: number) => void
  /** Waits `ms` between two reads of the driver's liveness. */
  sleep: (ms: number) => Promise<void>
  /** Starts the task's run in the background on the agent and model; returns the acknowledgement to print. */
  startBackground: (address: TaskAddress, agent: AgentVendor, model: string | undefined) => Promise<string>
}

/** How long a stopped driver has to exit, and how often that is checked. */
export const DRIVER_EXIT_WAIT_MS = 30_000
const DRIVER_EXIT_POLL_MS = 500

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
  const address: TaskAddress = input.address ?? { issue: task }
  const run = `vinaya task run ${addressWords(address)} --agent ${agent}${input.model ? ` --model ${input.model}` : ''}`
  if (!addressIsRunnable(address)) {
    return {
      kind: 'refused',
      message: `vinaya task switch: task ${task}'s address (${addressWords(address)}) is not one a run accepts; nothing was changed.`
    }
  }
  if (deps.readRunner(task) !== 'atta-engine') {
    return {
      kind: 'standalone',
      message: `vinaya task switch: task ${task} runs on the standalone runner, which already continues a task on a new --agent by itself; nothing was changed. Run: ${run}`
    }
  }
  const pid = deps.liveDriverPid(task)
  if (pid !== null) {
    if (!deps.holdsPause(task)) {
      return {
        kind: 'refused',
        message: `vinaya task switch: task ${task}'s driver (pid ${pid}) is still running; nothing was changed. Let it reach its pause, or stop it, then switch.`
      }
    }
    // The driver only waits in its held pause: it is stopped, and the switch goes on once it has exited.
    deps.stopDriver(pid)
    let waited = 0
    while (deps.liveDriverPid(task) !== null && waited < DRIVER_EXIT_WAIT_MS) {
      await deps.sleep(DRIVER_EXIT_POLL_MS)
      waited += DRIVER_EXIT_POLL_MS
    }
    const stillAlive = deps.liveDriverPid(task)
    if (stillAlive !== null) {
      return {
        kind: 'refused',
        message: `vinaya task switch: task ${task}'s driver (pid ${stillAlive}) did not exit within ${DRIVER_EXIT_WAIT_MS / 1000} seconds of being stopped; nothing was changed.`
      }
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
  deps.rewritePauseAgent(task, agent, input.model)
  const fromAgent = record?.agent ?? 'unrecorded'
  const fromModel = record?.model ? record.model : 'vendor default'
  const toModel = input.model ?? 'vendor default'
  deps.logLine(
    task,
    `Switched task ${task} from ${fromAgent} (${fromModel}) to ${agent} (${toModel}); old checkpoint ${folder ?? 'none, the task had no checkpoint'}`
  )
  const where =
    folder === null ? 'The task had no checkpoint to set aside.' : `The old checkpoint is kept in ${folder}.`
  const work = publishedWork
    ? 'Its branch and pull request are untouched; the next run continues them from the next round.'
    : 'It has no published work; the next run starts fresh.'
  let acknowledgement: string
  try {
    acknowledgement = await deps.startBackground(address, agent, input.model)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      kind: 'refused',
      message: `vinaya task switch: task ${task} was switched to ${agent} (${toModel}), but its background run did not start: ${reason}\n${where} Start the run with: ${run} --background`
    }
  }
  return {
    kind: 'switched',
    message: `vinaya task switch: task ${task} now continues on ${agent} (${toModel}). ${where} ${work} Started: ${run} --background\n${acknowledgement}`,
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
    rewritePauseAgent: (task, agent, model) => {
      const held = readPauseState(runtimeDir, task)
      if (held === null) return false
      // The recorded model belongs to the old vendor and is never carried over.
      const { model: _heldModel, ...withoutModel } = held
      writePauseState(runtimeDir, { ...withoutModel, agent, ...(model ? { model } : {}) })
      return true
    },
    logLine: (task, words) => appendDriverLine(loopLogPathFor(null, task, runtimeDir), words),
    now: () => new Date(),
    holdsPause: (task) => readPauseState(runtimeDir, task) !== null,
    stopDriver: (pid) => {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone: the exit wait sees it.
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    startBackground: async (address, agent, model) => {
      const handle = await startBackgroundRun({ ...address, agent, ...(model ? { model } : {}) })
      return [
        `vinaya task run: task ${handle.task} — background controller acknowledged (pid ${handle.pid}, run ${handle.runId})`,
        `Follow with: vinaya task status --issue ${handle.task} --follow`,
        `Log: ${handle.logPath}`
      ].join('\n')
    }
  }
}

/** Commits the branch holds beyond the default branch, counted against the remote when the branch is there; 0 when git cannot say. */
function commitsBeyondMain(branch: string): number {
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      const count = execFileSync('git', ['rev-list', '--count', `origin/main..${ref}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return Number.parseInt(count.trim(), 10) || 0
    } catch {
      // The ref is not there: try the next one.
    }
  }
  return 0
}

export type TaskSwitchRequest = ({ tranche: string; n: number } | { issue: number }) & {
  agent: AgentVendor
  model?: string | undefined
}

/** The reads that tell a `--issue` request whether its Issue is a tranche task; injectable so no forge is needed. */
export type SwitchResolution = {
  fetchLabels?: (issue: number) => string[]
  fetchTitle?: (issue: number, options?: { once?: boolean }) => string
  /** The switch's own dependencies; the live ones over this repository when absent. */
  switchDeps?: SwitchTaskDeps
}

/**
 * The tranche address of a tranche-labeled Issue, read from its label and its `[<tranche>] <n> —` title by the
 * standalone dispatch's own branch derivation; the `--issue` form for an Issue without a tranche label. Throws when
 * the Issue cannot be read or carries a tranche label with a malformed title.
 */
export function resolveIssueAddress(issue: number, resolution: SwitchResolution = {}): TaskAddress {
  const { branch } = developerBranchAndTitleFor(
    issue,
    resolution.fetchTitle ?? fetchIssueTitle,
    resolution.fetchLabels ?? fetchIssueLabels
  )
  const tranche = /^task\/([^/]+)\/(\d+)$/.exec(branch)
  return tranche ? { tranche: tranche[1] as string, n: Number.parseInt(tranche[2] as string, 10) } : { issue }
}

/**
 * The command's whole run over this repository: resolves the task's Issue (a `<tranche> <n>` address through the
 * read-only brief render, `--issue` as given) and the address the run is started in (a tranche-labeled `--issue`
 * Issue resolves to its tranche address), then switches it. Throws when the address cannot be resolved, before
 * anything changes.
 */
export async function runTaskSwitch(
  request: TaskSwitchRequest,
  resolution: SwitchResolution = {}
): Promise<SwitchTaskResult> {
  let task: number
  let address: TaskAddress
  if ('issue' in request) {
    task = request.issue
    try {
      address = resolveIssueAddress(task, resolution)
    } catch (err) {
      throw new Error(
        `vinaya task switch: could not resolve the address of Issue #${task}; nothing was changed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  } else {
    const rendered = await assembleAndRenderBrief(request.tranche, String(request.n))
    if (!rendered.ok) {
      throw new Error(
        `vinaya task switch: could not resolve task ${request.n} in tranche \`${request.tranche}\`:\n${rendered.missing.map((m) => `  - ${m}`).join('\n')}`
      )
    }
    task = rendered.issue
    address = { tranche: request.tranche, n: request.n }
  }
  const deps =
    resolution.switchDeps ??
    liveSwitchDeps(thisRepoRuntimeDir(), (issue) =>
      realHasPublishedWork(issue, { developerBranchFor, findOpenPrForBranch, commitsBeyondMain })
    )
  return switchTask({ task, address, agent: request.agent, ...(request.model ? { model: request.model } : {}) }, deps)
}
