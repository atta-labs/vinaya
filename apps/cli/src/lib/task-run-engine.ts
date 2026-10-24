import { spawn } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { AgentVendor } from './dispatch.js'
import { isDriverPidAlive, readDriverLock } from './dev-review-loop/pause-resume.js'
import { packageRoot } from './package-root.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo } from './run-paths.js'
import type { TaskRunner } from './config.js'

export const ENGINE_FALLBACK_NOTICE =
  'vinaya task run: Engine runner script is unavailable; falling back to standalone.'

export type EngineRunInput = { task: number; agent: AgentVendor; model?: string }

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

/**
 * The refusal a runner gives a held pause another runner recorded, naming the recorded one; null when the pause is
 * this runner's own. A run with no recorded runner is a standalone run.
 */
export function crossRunnerRefusal(task: number, runner: TaskRunner, root: string = runtimeDirForThisRepo()) {
  const recorded = readTaskRunner(task, root)
  return recorded === runner
    ? null
    : `task ${task}'s paused run was recorded on the ${recorded} runner, and the ${runner} runner never continues another runner's run — resume it on ${recorded}.`
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

/** The continuation of a halted Engine run: `--resume <pr>` through its pull request, else its task's checkpoint. */
export function engineContinuationArgv(target: {
  issue: number
  pr: number | null
  agent: AgentVendor
  model?: string
}): string[] {
  return [
    engineRunnerScriptPath(),
    ...(target.pr === null ? ['--task', String(target.issue)] : ['--resume', String(target.pr)]),
    '--agent',
    target.agent,
    ...(target.model ? ['--model', target.model] : [])
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
  notice: (line: string) => void
}

export const defaultEngineRunnerDeps: EngineRunnerDeps = {
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
  notice: (line) => process.stderr.write(`${line}\n`)
}

export function engineRunnerScriptPath(): string {
  return resolve(packageRoot(import.meta.url), '../../processes/vinaya/bin/run-engine.ts')
}

/**
 * Starts the workspace script by path; a published CLI without it keeps the standalone loop. `starting` runs once
 * the Engine is known to start, before it does.
 */
export async function runTaskEngine(
  input: EngineRunInput,
  overrides: Partial<EngineRunnerDeps> = {},
  starting: () => void = () => {}
): Promise<number | null> {
  const deps = { ...defaultEngineRunnerDeps, ...overrides }
  const script = deps.scriptPath()
  if (!deps.exists(script)) {
    deps.notice(ENGINE_FALLBACK_NOTICE)
    return null
  }
  starting()
  return deps.spawn(
    [
      'bun',
      script,
      '--task',
      String(input.task),
      '--agent',
      input.agent,
      ...(input.model ? ['--model', input.model] : [])
    ],
    { stdio: 'inherit' }
  )
}
