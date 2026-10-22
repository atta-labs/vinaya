import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { AgentVendor } from './dispatch.js'
import { packageRoot } from './package-root.js'

export const ENGINE_FALLBACK_NOTICE =
  'vinaya task run: Engine runner script is unavailable; falling back to standalone.'

export type EngineRunInput = { task: number; agent: AgentVendor; model?: string }
export type EngineRunnerDeps = {
  scriptPath: () => string
  exists: (path: string) => boolean
  spawn: (argv: string[], options: { stdio: 'inherit' }) => Promise<number>
  notice: (line: string) => void
}

export const defaultEngineRunnerDeps: EngineRunnerDeps = {
  scriptPath: () => resolve(packageRoot(import.meta.url), '../../processes/vinaya/bin/run-engine.ts'),
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
