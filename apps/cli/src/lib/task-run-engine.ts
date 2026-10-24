import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dirname, join } from 'node:path'
import type { AgentVendor } from './dispatch.js'
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

export function engineCancellationPath(task: number, root: string = runtimeDirForThisRepo()): string {
  return join(root, 'engine-runs', String(task), 'cancel-requested')
}

export function requestEngineCancellation(task: number, root: string = runtimeDirForThisRepo()): void {
  const path = engineCancellationPath(task, root)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600 })
}

export function engineCancellationRequested(task: number, root: string = runtimeDirForThisRepo()): boolean {
  return existsSync(engineCancellationPath(task, root))
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

/** Starts the workspace script by path; a published CLI without it keeps the standalone loop. */
export async function runTaskEngine(
  input: EngineRunInput,
  overrides: Partial<EngineRunnerDeps> = {}
): Promise<number | null> {
  const deps = { ...defaultEngineRunnerDeps, ...overrides }
  const script = deps.scriptPath()
  if (!deps.exists(script)) {
    deps.notice(ENGINE_FALLBACK_NOTICE)
    return null
  }
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
