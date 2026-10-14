import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildWorkerEnv } from '../../src/lib/worker-boundary.js'
import { confinedTmpEnv, resolveProofConfinement, stageProofCodexHome } from '../../src/lib/task-tools/dev-proof.js'
import { startDevToolsHost } from '../../src/lib/task-tools/dev-tools-host.js'
import {
  type BridgeInvocation,
  claudeDevToolsArgs,
  devToolsMcpConfigFileBody,
  devToolsSocketPath,
  driverDevBridgeInvocation
} from '../../src/lib/task-tools/dev-tools-registration.js'
import { DEV_TOOLS_MCP_SERVER_NAME, type DevToolContext } from '../../src/lib/task-tools/dev-tools-server.js'
import { type GrantedRole, servedTools } from '../../src/lib/task-tools/role-grants.js'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture.js'

/**
 * Live grant conformance, shared by `claude.test.ts` and `codex.test.ts`: a
 * real agent session, registered exactly as a dispatch registers the
 * driver-run tool server, sees exactly its role's granted tools, and a
 * reviewer session cannot call a Developer tool. Each case starts the real
 * host for one role on a real unix socket, with a context that records every
 * call it receives and touches nothing outside this process.
 *
 * Opt-in: these need the agent CLI installed and logged in with a
 * subscription, which a sandboxed CI runner does not have, so they run only
 * with `VINAYA_LIVE_GRANT_CONFORMANCE=1`, for example
 * `VINAYA_LIVE_GRANT_CONFORMANCE=1 bun test apps/cli/tests/conformance/claude.test.ts`.
 */

export const LIVE_GRANT_CONFORMANCE = process.env.VINAYA_LIVE_GRANT_CONFORMANCE === '1'

type LiveAgent = 'claude' | 'codex'

const DEVELOPER_TOOL_PROBE = 'publish_changes'

/** The vinaya CLI's own entry, which the staged bridge runs: under `bun test`, `process.argv[1]` is the test file, not the CLI. */
export const VINAYA_CLI_ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url))

/** The bridge a live session's MCP client spawns: the dispatch's own builder, pointed at the real CLI entry. */
export function liveBridgeInvocation(socketPath: string): BridgeInvocation {
  return driverDevBridgeInvocation(socketPath, VINAYA_CLI_ENTRY)
}

/** Calls `onMessage` with each JSON object in a newline-delimited JSON-RPC byte stream. */
function jsonLines(onMessage: (message: Record<string, unknown>) => void): (chunk: Buffer) => void {
  let buffered = ''
  return (chunk) => {
    buffered += chunk.toString('utf8')
    let newline = buffered.indexOf('\n')
    while (newline !== -1) {
      try {
        const parsed = JSON.parse(buffered.slice(0, newline)) as unknown
        if (typeof parsed === 'object' && parsed !== null) onMessage(parsed as Record<string, unknown>)
      } catch {
        // not a JSON-RPC line
      }
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
    }
  }
}

/**
 * A relay in front of the host that records whether the host answered an
 * `initialize` request, so a case proves the server connected even for a role
 * that is served no tools. It listens beside the host's socket, in the same
 * owner-only directory, and forwards every byte unchanged.
 */
export async function startInitializeWitness(
  hostSocketPath: string
): Promise<{ socketPath: string; answered: () => boolean; close: () => Promise<void> }> {
  const socketPath = join(dirname(hostSocketPath), 'w.sock')
  let answered = false
  const initializeIds = new Set<unknown>()
  const sockets = new Set<net.Socket>()
  const relay = net.createServer((client) => {
    const host = net.connect(hostSocketPath)
    for (const socket of [client, host]) {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
    }
    client.on(
      'data',
      jsonLines((m) => {
        if (m.method === 'initialize') initializeIds.add(m.id)
      })
    )
    host.on(
      'data',
      jsonLines((m) => {
        if (initializeIds.has(m.id) && 'result' in m) answered = true
      })
    )
    client.pipe(host)
    host.pipe(client)
  })
  await new Promise<void>((resolve, reject) => {
    relay.once('error', reject)
    relay.listen(socketPath, resolve)
  })
  return {
    socketPath,
    answered: () => answered,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        relay.close(() => {
          rmSync(socketPath, { force: true })
          resolve()
        })
      })
  }
}

/** One live case's ceiling, and the shorter budget its agent session is killed at, so a hung session reports its own output. */
const LIVE_TIMEOUT_MS = 600_000
const SESSION_BUDGET_MS = 540_000

/** The final answer each session must give: the tool names it sees from the driver-run server. */
const SEEN_TOOLS_SCHEMA = {
  type: 'object',
  properties: { tools: { type: 'array', items: { type: 'string' } } },
  required: ['tools'],
  additionalProperties: false
} as const

function recordingContext(calls: string[]): DevToolContext {
  return {
    publishChanges: async () => {
      calls.push('publish_changes')
      return { ok: true, result: { pushedHead: 'grant-probe-head' } }
    },
    openPullRequest: async () => {
      calls.push('open_pull_request')
      return { ok: true, result: { prNumber: 1 } }
    },
    updatePullRequestBody: async () => {
      calls.push('update_pull_request_body')
      return { ok: true, result: { prNumber: 1 } }
    },
    refreshEvidence: async () => {
      calls.push('refresh_evidence')
      return { ok: true, result: { head: 'grant-probe-head', checksPassed: true, evidence: 'none' } }
    },
    readPullRequest: async () => {
      calls.push('read_pull_request')
      return {
        ok: true,
        result: { prNumber: 1, state: 'OPEN', head: null, checks: [], reviews: [], body: null, failedChecks: [] }
      }
    },
    runChecks: async () => {
      calls.push('run_checks')
      return { ok: true, result: { passed: true, output: 'grant probe' } }
    },
    fetchDocumentation: async () => {
      calls.push('fetch_documentation')
      return {
        ok: false,
        error: {
          errorClass: 'policy_refusal',
          retryDisposition: 'never',
          effectState: 'not_started',
          check: 'grant-probe',
          output: 'The grant probe fetches nothing.',
          fix: 'Do not call fetch_documentation in this probe.'
        }
      }
    }
  }
}

function grantPrompt(): string {
  return (
    `List the name of every tool the MCP server \`${DEV_TOOLS_MCP_SERVER_NAME}\` provides to you, ` +
    'using each bare tool name without any server prefix. ' +
    `Then, only if \`${DEVELOPER_TOOL_PROBE}\` is one of those tools, call it once with the header ` +
    '"Test(grants): probe". Do not call any other tool and do not run any shell command. ' +
    'End with the list of tool names you saw from that server.'
  )
}

type SessionOutcome = { exitCode: number | null; stdout: string; stderr: string }

/** One agent session under the shared fixture budget, with every `VINAYA_*` variable stripped from its environment. */
async function runSession(
  command: string[],
  env: Record<string, string | undefined>,
  cwd: string
): Promise<SessionOutcome> {
  const ran = await spawnBudgetedAsync(command, { cwd, env }, SESSION_BUDGET_MS, `${command[0]} grant session`)
  return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

function streamEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (typeof parsed === 'object' && parsed !== null) events.push(parsed as Record<string, unknown>)
    } catch {
      // not an event line
    }
  }
  return events
}

/** The dev-tools server's status as Claude's own `system/init` event reports it, or `null` when it lists none. */
function claudeInitServerStatus(events: Record<string, unknown>[]): string | null {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  if (!init || !Array.isArray(init.mcp_servers)) return null
  const server = (init.mcp_servers as Record<string, unknown>[]).find((s) => s?.name === DEV_TOOLS_MCP_SERVER_NAME)
  return typeof server?.status === 'string' ? server.status : null
}

/** The server's tools as Claude's own `system/init` event lists them, with the `mcp__<server>__` prefix removed. */
function claudeInitServerTools(events: Record<string, unknown>[]): string[] | null {
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init')
  if (!init || !Array.isArray(init.tools)) return null
  const prefix = `mcp__${DEV_TOOLS_MCP_SERVER_NAME}__`
  return init.tools
    .filter((t): t is string => typeof t === 'string' && t.startsWith(prefix))
    .map((t) => t.slice(prefix.length))
}

function claudeSeenTools(events: Record<string, unknown>[]): string[] | null {
  const result = events.find((e) => e.type === 'result')
  const structured = result?.structured_output as { tools?: unknown } | undefined
  return Array.isArray(structured?.tools) ? (structured.tools as string[]) : null
}

function codexSeenTools(events: Record<string, unknown>[]): string[] | null {
  let text: string | null = null
  for (const e of events) {
    const item = e.item as Record<string, unknown> | undefined
    if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text
  }
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as { tools?: unknown }
    return Array.isArray(parsed.tools) ? (parsed.tools as string[]) : null
  } catch {
    return null
  }
}

async function runGrantSession(
  agent: LiveAgent,
  role: Exclude<GrantedRole, 'controller'>
): Promise<{
  calls: string[]
  seen: string[] | null
  initTools: string[] | null
  initStatus: string | null
  initializeAnswered: boolean
  outcome: SessionOutcome
}> {
  const scratchDir = mkdtempSync(join(tmpdir(), `vinaya-grant-live-${agent}-`))
  const calls: string[] = []
  const host = await startDevToolsHost({
    socketPath: devToolsSocketPath(`grant-live:${randomUUID()}`),
    serverVersion: '0.0.0-grant-live',
    context: recordingContext(calls),
    role
  })
  const witness = await startInitializeWitness(host.socketPath)
  try {
    const bridge = liveBridgeInvocation(witness.socketPath)
    const confinement = resolveProofConfinement(agent, role, scratchDir, scratchDir)
    const schemaPath = join(scratchDir, 'seen-tools.schema.json')
    writeFileSync(schemaPath, `${JSON.stringify(SEEN_TOOLS_SCHEMA)}\n`)
    let outcome: SessionOutcome
    if (agent === 'claude') {
      const mcpConfigPath = join(scratchDir, 'dev-tools.mcp.json')
      writeFileSync(mcpConfigPath, devToolsMcpConfigFileBody(bridge))
      outcome = await runSession(
        [
          'claude',
          '-p',
          grantPrompt(),
          '--verbose',
          '--output-format',
          'stream-json',
          ...claudeDevToolsArgs(mcpConfigPath),
          '--json-schema',
          JSON.stringify(SEEN_TOOLS_SCHEMA),
          ...(confinement.settingsPath ? ['--settings', confinement.settingsPath] : [])
        ],
        // Startup waits for the server, so the init event reports its tools rather than a pending connection.
        buildWorkerEnv(stripVinayaEnv(process.env), {
          MCP_CONNECTION_NONBLOCKING: '0',
          ...confinedTmpEnv(confinement.confined, scratchDir)
        }),
        scratchDir
      )
    } else {
      const codexHome = stageProofCodexHome(bridge, scratchDir, confinement)
      outcome = await runSession(
        [
          'codex',
          'exec',
          '--sandbox',
          'workspace-write',
          '--strict-config',
          '--dangerously-bypass-hook-trust',
          '--skip-git-repo-check',
          '--json',
          '--output-schema',
          schemaPath,
          grantPrompt()
        ],
        buildWorkerEnv(stripVinayaEnv(process.env), {
          CODEX_HOME: codexHome,
          ...confinedTmpEnv(confinement.confined, scratchDir)
        }),
        scratchDir
      )
    }
    const events = streamEvents(outcome.stdout)
    return {
      calls,
      seen: agent === 'claude' ? claudeSeenTools(events) : codexSeenTools(events),
      initTools: agent === 'claude' ? claudeInitServerTools(events) : null,
      initStatus: agent === 'claude' ? claudeInitServerStatus(events) : null,
      initializeAnswered: witness.answered(),
      outcome
    }
  } finally {
    await witness.close()
    await host.close()
    rmSync(scratchDir, { recursive: true, force: true })
  }
}

/** Registers the live grant cases for one agent; skipped unless `VINAYA_LIVE_GRANT_CONFORMANCE=1`. */
export function defineLiveGrantCases(agent: LiveAgent): void {
  describe.skipIf(!LIVE_GRANT_CONFORMANCE)(`${agent} — each role sees exactly its granted tools (live)`, () => {
    for (const role of ['developer', 'code-reviewer', 'security'] as const) {
      const granted = servedTools(role).map((tool) => tool.name)
      it(
        `${role}: the session sees exactly ${granted.length === 0 ? 'no tools' : granted.join(', ')}`,
        async () => {
          const run = await runGrantSession(agent, role)
          expect(run.outcome.exitCode, run.outcome.stderr.slice(-2000)).toBe(0)
          // The server connected: the host answered the session's initialize, and Claude reports it connected.
          expect(run.initializeAnswered, run.outcome.stderr.slice(-2000)).toBe(true)
          if (agent === 'claude') expect(run.initStatus).toBe('connected')
          if (run.initTools !== null) expect([...run.initTools].sort()).toEqual([...granted].sort())
          expect(run.seen).not.toBeNull()
          expect([...(run.seen ?? [])].sort()).toEqual([...granted].sort())
          if (role === 'developer') {
            expect(run.calls).toContain(DEVELOPER_TOOL_PROBE)
          } else {
            // A reviewer is served no Developer tool, so no Developer handler ever runs.
            expect(run.calls).toEqual([])
          }
        },
        LIVE_TIMEOUT_MS
      )
    }
  })
}
