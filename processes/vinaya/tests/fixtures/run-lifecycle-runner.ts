#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { loadProcess } from '../../../../harness/dev-process/loader/load-process'
import type { ActionRegistry } from '../../../../harness/dev-process/engine-runtime/run-process'
import { classifyGateResult, dispatchReviewers, ACTION_BINDINGS, type TaskInput } from '../../executing/actions'
import { runEngine, type Agent } from '../../bin/run-engine'
import { recordedHandoff } from '../handoff-fakes'

// A real runner process for the lifecycle tests: the Engine run over stub actions, whose agents are real shell
// processes (each starts a long-lived child of its own), so a signal sent to this process can be checked against
// what is left of them.
//
//   bun run-lifecycle-runner.ts <claude|codex> <runtimeDir> <agentScript> <argvFile>

const [agent, runtimeDir, agentScript, argvFile] = process.argv.slice(2) as [Agent, string, string, string]
const repoRoot = resolve(import.meta.dir, '../../../..')

// The agent is launched the way a real one is, by the runner's own launcher, as the vendor command on PATH: a stand-in
// that runs the agent script and keeps the real launch argv for the test to read.
const bin = `${argvFile}-bin`
mkdirSync(bin, { recursive: true })
for (const command of ['claude', 'codex'])
  writeFileSync(join(bin, command), `#!/bin/sh\nexec sh '${agentScript}' '${argvFile}' "$@"\n`, { mode: 0o755 })
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`

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
  // No forge is reached: no pull request is open, and a pause is recorded but never posted.
  taskInput: { bound: { findOpenPrForBranch: () => null } } as unknown as TaskInput,
  handoffDeps: recordedHandoff().deps,
  heldPullRequestConflicts: async () => false,
  actions,
  sink: { log: () => {}, drain: async () => {} },
  startHost: async () => ({ close: async () => {} }),
  devToolsContext: {} as never,
  out: (line) => process.stdout.write(`${line}\n`),
  revision: 'signal-test',
  lifecycle: { killGraceMs: 500 }
})
process.stdout.write(`exit ${result.exitCode}\n`)
process.exit(result.exitCode)
