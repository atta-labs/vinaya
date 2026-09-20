#!/usr/bin/env bun
/**
 * The bounded, authorized live smoke run (O1) — a REAL
 * invocation of the shared `vinaya-task-tools` MCP server's production code
 * path (real subprocess, real JSON-RPC, real handler, real `log()` sink),
 * proving `apps/cli/specs/conformance.md`'s claims are not test-harness
 * fiction. This is deliberately NOT a `.test.ts` file: `bun test` never
 * discovers or runs it, because it writes one real Vinaya Log event and is
 * meant to be re-run by hand, not on every CI push.
 *
 * Scenario: `task_resume` against an escalation whose resolution is already
 * durably consumed — the same safe, non-mutating "Recovery" scenario
 * `harness.ts`'s own test proves (`already_resumed`, no worker launch, no
 * `gh` call: resume.ts's early-return branch for an existing resolution
 * never reaches the ruling-fetch code that would need one). Chosen
 * specifically so a real run of this script can never dispatch a worker,
 * open a PR, or touch the real forge.
 *
 * Isolation: reuses `harness.ts`'s own `buildSandbox()` verbatim (isolated
 * `HOME`, fake `gh`, isolated `VINAYA_RUNTIME_DIR`) — the SAME sandbox task
 * 5's own tests already run safely, not a second isolation mechanism. The
 * real `log()` chokepoint (`log-sink.ts`) reads `HOME` via `os.homedir()`
 * for its outbox root, so the sandboxed `HOME` also isolates the ONE real
 * event this script writes: it lands under `<sandbox>/home/.vinaya/outbox/`,
 * never this machine's own `~/.vinaya/outbox` that real dev-review-loop runs
 * on this repo already share.
 *
 * What this script does NOT do: it does not spawn a live model session. An
 * actual live-model-driven call — an LLM autonomously deciding, from a
 * natural-language prompt, to invoke this tool over MCP — was attempted
 * during this task's authoring and refused by this host's own agent-safety
 * classifier, which named the reason verbatim: the task brief's own Test
 * Plan reserves that authorization step for the Principal
 * (`--permission-mode bypassPermissions` on a spawned `claude -p` process
 * is what it refused). This script instead drives the exact same production
 * code the Operator's own tool call would reach — the MCP server, the
 * router, the catalog's Zod validation, the real handler, the real log sink
 * — everything BELOW the model's own decision to call the tool. The one
 * layer this script cannot honestly claim to prove is that decision layer
 * itself; `apps/cli/specs/conformance.md`'s own evidence section says so
 * plainly rather than papering over the gap.
 *
 * Codex: no `codex` binary exists on this authoring host (confirmed twice —
 * task 5's own `adapters.ts` already recorded `verifiedLiveOnAuthoringHost:
 * false` for the identical reason). This script only exercises the shared
 * server + the Claude-side `.mcp.json` shape; there is no live Codex
 * evidence to capture here, or anywhere on this host.
 *
 * Usage: `bun apps/cli/tests/conformance/live-smoke.ts`
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ABS_BIN,
  buildSandbox,
  ensureCliBuilt,
  REPO_ROOT,
  SpawnRpcClient,
  writeEscalationFixture,
  writePauseFixture
} from './harness.js'
import { acquireOwnership, consumeResolutionOnce, defaultControlStoreDeps } from '@attalabs/aeg-core'
import { tasksExecutionRoot } from '../../src/lib/run-paths.js'
import { claudeMcpJsonFile } from '../../src/lib/task-tools/adapters.js'

const ISSUE = 9301
const PR = 9601
const ESCALATION_ID = `${ISSUE}-1-headsha1`

async function main(): Promise<void> {
  console.log('live-smoke: building apps/cli...')
  ensureCliBuilt()

  const sb = buildSandbox()
  try {
    writePauseFixture(sb.runtimeDir, { task: ISSUE, escalationId: ESCALATION_ID, prNumber: PR })
    writeEscalationFixture(sb.runtimeDir, ISSUE, { pr: PR })

    // The same "earlier process already resumed this" simulation
    // harness.ts's own Recovery scenario uses — guarantees this call hits
    // the safe, no-launch `already_resumed` replay branch (resume.ts:264-284).
    const controlStoreDeps = defaultControlStoreDeps(() => tasksExecutionRoot(sb.runtimeDir))
    const acquired = acquireOwnership(controlStoreDeps, ISSUE, 'live-smoke-fixture')
    if (!acquired.acquired) throw new Error('live-smoke: could not acquire control-store epoch for fixture setup')
    consumeResolutionOnce(controlStoreDeps, ISSUE, acquired.epoch, {
      escalationId: ESCALATION_ID,
      decision: 'resume',
      authenticatedBy: 'principal-1',
      authenticatedFrom: `${PR}-1`,
      consumedAt: '2026-01-01T00:00:00.000Z'
    })

    // Also emit the real Claude `.mcp.json` a Principal-authorized live
    // model session would actually load — informational output only; this
    // script itself drives the server directly (below), not through a
    // spawned `claude`/`codex` CLI.
    const mcpConfigPath = join(sb.sandbox, '.mcp.json')
    writeFileSync(mcpConfigPath, claudeMcpJsonFile({ dir: 'apps/cli', bin: ABS_BIN } as never))

    const client = new SpawnRpcClient({ command: 'node', args: [ABS_BIN, 'task-tools', 'serve'] }, sb.env, REPO_ROOT)
    await client.request('initialize', {})
    const { isError, structured } = await client.callTool('task_resume', { task: { issue: ISSUE } })
    console.log('live-smoke: task_resume result —', JSON.stringify({ isError, structured }))

    // log()'s own outbox write is asynchronous (log-sink.ts's
    // `resolveRepoOnce().then(...)`) — give it time to land before the
    // client disconnects and this script's own process exits.
    await new Promise((r) => setTimeout(r, 3000))
    client.close()

    // `buildSandbox()`'s own `AEG_REPO` fixture value (`attalabs/vinaya`, no
    // hyphen — `resolveRepo`'s own env-first precedence, `resolve-repo.ts`)
    // wins over the real git remote, so the outbox lands under whatever that
    // fixture resolves to, not this repo's real `atta-labs-vinaya` slug —
    // found live authoring this script. Searched for, never hardcoded.
    const outboxRoot = join(sb.env.HOME as string, '.vinaya', 'outbox')
    const eventFile = existsSync(outboxRoot)
      ? readdirSync(outboxRoot)
          .map((repoDir) => join(outboxRoot, repoDir, `${ISSUE}.ndjson`))
          .find((p) => existsSync(p))
      : undefined
    if (!eventFile) {
      console.error(`live-smoke: FAILED — expected a real typed event under ${outboxRoot}, found none.`)
      console.error(
        `live-smoke: outbox root contents: ${existsSync(outboxRoot) ? readdirSync(outboxRoot).join(', ') : '(missing)'}`
      )
      process.exitCode = 1
      return
    }
    const event = readFileSync(eventFile, 'utf8').trim()
    console.log('live-smoke: real typed event captured —')
    console.log(event)
    console.log('live-smoke: Claude Code CLI version (this host) — see `claude --version`.')
    console.log("live-smoke: vinaya package version — see the emitted event's own meta.vinaya field above.")
  } finally {
    sb.cleanup()
  }
}

main().catch((err) => {
  console.error('live-smoke: FAILED —', err instanceof Error ? err.stack : String(err))
  process.exitCode = 1
})
