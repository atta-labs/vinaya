#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process'
import type { ActionRegistry } from '../../../../harness/dev-process/engine-runtime/run-process'
import { classifyGateResult, dispatchReviewers, ACTION_BINDINGS, type TaskInput } from '../../executing/actions'
import { runEngine, type Agent } from '../../bin/run-engine'

// A real runner process for the lifecycle tests: the Engine run over stub actions, whose agents are real shell
// processes (each starts a long-lived child of its own), so a signal sent to this process can be checked against
// what is left of them.
//
//   bun run-lifecycle-runner.ts <claude|codex> <runtimeDir> <agentScript> <argvFile>

const [agent, runtimeDir, agentScript, argvFile] = process.argv.slice(2) as [Agent, string, string, string]
const repoRoot = resolve(import.meta.dir, '../../../..')

const actions: ActionRegistry = Object.fromEntries(
  Object.keys(ACTION_BINDINGS).map((name) => [
    name,
    async (context) => {
      if (name === 'vinaya.classify-gate-result') return classifyGateResult(context)
      if (name === 'vinaya.dispatch-reviewers') return dispatchReviewers()
      return { exitCode: 0 }
    }
  ])
)

const result = await runEngine({
  args: { task: 7, agent, dryRun: false },
  process: loadProcess(resolve(import.meta.dir, '../..')),
  repoRoot,
  runtimeDir,
  loopId: 'signal-test',
  taskInput: {} as TaskInput,
  actions,
  sink: { log: () => {}, drain: async () => {} },
  startHost: async () => ({ close: async () => {} }),
  devToolsContext: {} as never,
  out: (line) => process.stdout.write(`${line}\n`),
  revision: 'signal-test',
  lifecycle: { killGraceMs: 500 },
  // The agent is the real launch argv's shape, run as a shell script: the argv is kept for the test to read.
  spawnFn: (_command, args, options) =>
    spawn('sh', [agentScript, argvFile, ...args], { ...options, stdio: ['pipe', 'pipe', 'pipe'] }) as never
})
process.stdout.write(`exit ${result.exitCode}\n`)
process.exit(result.exitCode)
