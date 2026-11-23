import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { AgentVendor } from '../dispatch/dispatch.js'
import { isDriverPidAlive, readDriverLock } from '../standalone/dev-review-loop/pause-resume.js'
import { programFile } from '../../../tools/programs.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo } from '../../../../../kernel/run-paths.js'
import type { TaskRunner } from '../../../integration/config/compose.js'

export type EngineRunInput = { task: number; agent: AgentVendor; model?: string; effort?: string; flow?: string }

export type RecordedTaskRunner = { schemaVersion: 1; runner: TaskRunner; recordedAt: string }

export function taskRunnerRecordPath(task: number, root: string = runtimeDirForThisRepo()): string {
  return runPath(root, task, { area: 'task', file: 'runner.json' })
}

/** The runner is durable run provenance. Absence deliberately means the legacy standalone path. */
export function readTaskRunner(task: number, root: string = runtimeDirForThisRepo()): TaskRunner {
  try {
    const value = JSON.parse(readFileSync(taskRunnerRecordPath(task, root), 'utf8')) as Partial<RecordedTaskRunner>
    return value.schemaVersion === 1 && value.runner === 'atta-engine' ? 'atta-engine' : 'standalone'
  } catch {
    return 'standalone'
  }
}

export function recordTaskRunner(
  task: number,
  runner: TaskRunner,
  root: string = runtimeDirForThisRepo(),
  now: () => Date = () => new Date()
): void {
  const path = taskRunnerRecordPath(task, root)
  ensureRunDir(dirname(path), root)
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, runner, recordedAt: now().toISOString() })}\n`, {
    mode: 0o600
  })
  renameSync(temporary, path)
}

/** Why a runner refuses to continue a run: the run is recorded on another runner, named with the one requested. */
export type CrossRunnerRefusalReason = {
  code: 'recorded_on_another_runner'
  task: number
  recorded: TaskRunner
  requested: TaskRunner
}

/**
 * The typed refusal a runner gives a held pause another runner recorded; null when the pause is this runner's own.
 * A run with no recorded runner is a standalone run.
 */
export function crossRunnerRefusalReason(
  task: number,
  runner: TaskRunner,
  root: string = runtimeDirForThisRepo()
): CrossRunnerRefusalReason | null {
  const recorded = readTaskRunner(task, root)
  return recorded === runner ? null : { code: 'recorded_on_another_runner', task, recorded, requested: runner }
}

/** The refusal's text, as both runners print it. */
export function crossRunnerRefusalText(reason: CrossRunnerRefusalReason): string {
  return `task ${reason.task}'s paused run was recorded on the ${reason.recorded} runner, and the ${reason.requested} runner never continues another runner's run — resume it on ${reason.recorded}.`
}

/** The refusal a runner gives a held pause another runner recorded, as text; null when the pause is this runner's own. */
export function crossRunnerRefusal(task: number, runner: TaskRunner, root: string = runtimeDirForThisRepo()) {
  const reason = crossRunnerRefusalReason(task, runner, root)
  return reason === null ? null : crossRunnerRefusalText(reason)
}

/** One task's Engine run directory: `<runtimeDir>/engine-runs/<task>`, where the Engine keeps its checkpoints. */
export function engineRunDirectory(task: number, root: string = runtimeDirForThisRepo()): string {
  return join(root, 'engine-runs', String(task))
}

/** What the Operator reads of an Engine run: its run directory, whether a checkpoint is there, and the driver lock. */
export type EngineRunReading = {
  runDirectory: string
  checkpoint: boolean
  lock: { pid: number; alive: boolean } | null
}

/** The Engine run's own files, read by path: the run directory, its checkpoint file and the task's driver lock. */
export function readEngineRun(task: number, root: string = runtimeDirForThisRepo()): EngineRunReading {
  const runDirectory = engineRunDirectory(task, root)
  const lock = readDriverLock(root, task)
  return {
    runDirectory,
    checkpoint: existsSync(join(runDirectory, 'checkpoints.sqlite')),
    lock: lock === null ? null : { pid: lock.pid, alive: isDriverPidAlive(lock.pid) }
  }
}

/**
 * Whether the task's Engine run has not ended: its driver is live, its last leg ended short of completed or
 * cancelled, or it left a checkpoint and no trace at all. A held pause is not needed for a run to be in flight.
 */
export function engineRunInFlight(task: number, root: string = runtimeDirForThisRepo()): boolean {
  const reading = readEngineRun(task, root)
  if (reading.lock?.alive) return true
  const tracePath = join(reading.runDirectory, 'trace.json')
  if (!existsSync(tracePath)) return reading.checkpoint
  try {
    const outcome = (JSON.parse(readFileSync(tracePath, 'utf8')) as { outcome?: unknown }).outcome
    return outcome !== 'completed' && outcome !== 'cancelled'
  } catch {
    return true
  }
}

/** The refusal's text for an in-flight run another runner recorded that holds no pause. */
export function crossRunnerInFlightText(reason: CrossRunnerRefusalReason): string {
  return `task ${reason.task}'s in-flight run was recorded on the ${reason.recorded} runner, and the ${reason.requested} runner never takes over another runner's run — continue it on ${reason.recorded}, or end it and restart with \`task run --rollback\`.`
}

/** The continuation of a halted Engine run: `--resume <pr>` through its pull request, else its task's checkpoint. */
export function engineContinuationArgv(target: {
  issue: number
  pr: number | null
  agent: AgentVendor
  model?: string
  effort?: string
}): string[] {
  return [
    engineRunnerScriptPath(),
    ...(target.pr === null ? ['--task', String(target.issue)] : ['--resume', String(target.pr)]),
    '--agent',
    target.agent,
    ...(target.model ? ['--model', target.model] : []),
    ...(target.effort ? ['--effort', target.effort] : [])
  ]
}

/** The same continuation as a command a person runs. */
export function engineContinuationCommand(target: Parameters<typeof engineContinuationArgv>[0]): string {
  return ['bun', ...engineContinuationArgv(target)].join(' ')
}

export type EngineRunnerDeps = {
  scriptPath: () => string
  exists: (path: string) => boolean
  spawn: (argv: string[], options: { stdio: 'inherit' }) => Promise<number>
  /** The path of a `bun` executable on the PATH, or null when there is none. */
  findBun?: () => string | null
}

/**
 * A plain `bun` executable in one of the PATH's directories, or null. Scanned by hand rather than asked of Bun,
 * because the command runs under Node in an installed package.
 */
export function findBunOnPath(path: string | undefined = process.env.PATH): string | null {
  for (const directory of (path ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = join(directory, 'bun')
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here, or not executable: the next PATH entry.
    }
  }
  return null
}

/**
 * Whether the Atta Engine runner can start: null when it can, otherwise the one refusal text `task run` and
 * `runTask` both print. It cannot when the runner's file is absent, or when Bun, which runs it, is not on the PATH.
 * The text names `--runner standalone`, except for a flow other than `v1`, which only the Engine runs.
 */
export function engineStartRefusal(
  flow: string | undefined = undefined,
  script: string = engineRunnerScriptPath(),
  exists: (path: string) => boolean = existsSync,
  findBun: () => string | null = () => findBunOnPath()
): string | null {
  const cause = !exists(script)
    ? `its runner file ${script} is absent`
    : findBun() === null
      ? 'Bun is not on the PATH, and the Engine runner runs on Bun'
      : null
  if (cause === null) return null
  const remedy =
    flow !== undefined && flow !== 'v1'
      ? `flow ${flow} needs the Engine, so make the Engine startable before starting this flow`
      : 'make the Engine startable, or start this task on the standalone runner with `--runner standalone`'
  return `the Atta Engine runner cannot start: ${cause}. Nothing was started; ${remedy}.`
}

export const defaultEngineRunnerDeps: Required<EngineRunnerDeps> = {
  scriptPath: engineRunnerScriptPath,
  exists: existsSync,
  spawn: (argv, options) =>
    new Promise((resolveExit, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), options)
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1))
      })
    }),
  findBun: () => findBunOnPath()
}

/** The Vinaya process folder, relative to the root of a checkout of this repository. */
export const PROCESS_FOLDER_IN_CHECKOUT = 'harness/processes/vinaya-strict'

/**
 * The Engine runner `task run`, resume, status and cancel start: the program table's answer for its row, which is the
 * built runner in an installed package and the runner's source file in a checkout.
 */
export function engineRunnerScriptPath(): string {
  return programFile('run-engine')
}

/**
 * Starts the Engine runner by path, with `bun`: its checkpoint store is Bun's SQLite. Its caller has already asked
 * `engineStartRefusal`, so this always starts the Engine and answers its exit code. `starting` runs before it does.
 */
export async function runTaskEngine(
  input: EngineRunInput,
  overrides: Partial<EngineRunnerDeps> = {},
  starting: () => void = () => {}
): Promise<number> {
  const deps = { ...defaultEngineRunnerDeps, ...overrides }
  const script = deps.scriptPath()
  starting()
  return deps.spawn(
    [
      'bun',
      script,
      '--task',
      String(input.task),
      '--agent',
      input.agent,
      ...(input.model ? ['--model', input.model] : []),
      ...(input.effort ? ['--effort', input.effort] : []),
      ...(input.flow ? ['--flow', input.flow] : [])
    ],
    { stdio: 'inherit' }
  )
}
