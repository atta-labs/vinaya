import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageProofCodexHome } from '../../src/lib/task-tools/dev-proof.js'
import { startDevToolsHost } from '../../src/lib/task-tools/dev-tools-host.js'
import { devToolsMcpConfigFileBody, devToolsSocketPath } from '../../src/lib/task-tools/dev-tools-registration.js'
import { DEV_TOOLS_MCP_SERVER_NAME, type DevToolContext } from '../../src/lib/task-tools/dev-tools-server.js'
import { MCP_PROTOCOL_VERSION } from '../../src/lib/task-tools/server.js'
import { PROCESS_FIXTURE_BUDGET_MS, stripVinayaEnv } from '../lib/process-fixture.js'
import { liveBridgeInvocation, startInitializeWitness, VINAYA_CLI_ENTRY } from './role-grants-live.js'

/**
 * The live grant harness's staged bridge, proven without a vendor login: the
 * command each agent's MCP client would spawn is read back out of the exact
 * configuration the harness stages (Claude's `--mcp-config` file, Codex's
 * `config.toml`), spawned as written, and must answer `initialize` through the
 * real host. The harness once built that command from `process.argv[1]`, which
 * under `bun test` is the test file rather than the vinaya CLI, so the spawned
 * bridge never relayed and closed before its initialize response.
 */

const SPAWN_TIMEOUT_MS = 30_000

const refuseEverything = new Proxy({} as DevToolContext, {
  get: () => async () => {
    throw new Error('the bridge test calls no tool')
  }
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function stagedHost(): Promise<{ bridgeSocket: string; answered: () => boolean; scratchDir: string }> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'vinaya-grant-bridge-'))
  cleanups.push(() => rmSync(scratchDir, { recursive: true, force: true }))
  const host = await startDevToolsHost({
    socketPath: devToolsSocketPath(`grant-bridge:${randomUUID()}`),
    serverVersion: '0.0.0-grant-bridge',
    context: refuseEverything,
    role: 'code-reviewer'
  })
  cleanups.push(() => host.close())
  const witness = await startInitializeWitness(host.socketPath)
  cleanups.push(() => witness.close())
  return { bridgeSocket: witness.socketPath, answered: witness.answered, scratchDir }
}

/** Spawns `command args` as an MCP client would, sends `initialize`, and returns the first response line. */
async function initializeOver(command: string, args: string[], cwd: string): Promise<Record<string, unknown>> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: stripVinayaEnv(process.env),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  // The bridge stays up while its client does, so it is killed once the case ends, or at the fixture budget if it hangs.
  const budget = setTimeout(() => child.kill('SIGKILL'), PROCESS_FIXTURE_BUDGET_MS)
  cleanups.push(() => {
    clearTimeout(budget)
    child.kill('SIGKILL')
  })
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'grant-bridge-test', version: '0' }
      }
    })}\n`
  )
  child.stdin.flush()
  const reader = child.stdout.getReader()
  let buffered = ''
  while (!buffered.includes('\n')) {
    const { value, done } = await reader.read()
    if (done) {
      const stderr = await new Response(child.stderr).text()
      throw new Error(`the bridge closed before answering initialize (exit ${await child.exited}): ${stderr}`)
    }
    buffered += new TextDecoder().decode(value)
  }
  return JSON.parse(buffered.slice(0, buffered.indexOf('\n'))) as Record<string, unknown>
}

function expectInitializeAnswered(response: Record<string, unknown>): void {
  expect(response.id).toBe(1)
  const result = response.result as { serverInfo?: { name?: unknown } } | undefined
  expect(result?.serverInfo?.name).toBe(DEV_TOOLS_MCP_SERVER_NAME)
}

describe('live grant harness — the staged bridge answers initialize', () => {
  it('launches the bridge from the vinaya CLI entry, never the running test file', () => {
    const bridge = liveBridgeInvocation('/tmp/x/s.sock')
    expect(bridge.command).toBe(process.execPath)
    expect(bridge.args[0]).toBe(VINAYA_CLI_ENTRY)
    expect(VINAYA_CLI_ENTRY.endsWith(join('apps', 'cli', 'src', 'index.ts'))).toBe(true)
    expect(bridge.args[0]).not.toBe(process.argv[1])
  })

  it(
    'Claude: the command in the staged --mcp-config file answers initialize',
    async () => {
      const staged = await stagedHost()
      const configPath = join(staged.scratchDir, 'dev-tools.mcp.json')
      writeFileSync(configPath, devToolsMcpConfigFileBody(liveBridgeInvocation(staged.bridgeSocket)))
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, { command: string; args: string[] }>
      }
      const server = config.mcpServers[DEV_TOOLS_MCP_SERVER_NAME]!
      expectInitializeAnswered(await initializeOver(server.command, server.args, staged.scratchDir))
      expect(staged.answered()).toBe(true)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'Codex: the command in the staged config.toml answers initialize',
    async () => {
      const staged = await stagedHost()
      const codexHome = stageProofCodexHome(liveBridgeInvocation(staged.bridgeSocket), staged.scratchDir, {
        confined: false,
        detail: 'unconfined bridge test',
        settingsPath: null,
        codexHome: null,
        codexSandboxToml: null
      })
      const config = Bun.TOML.parse(readFileSync(join(codexHome, 'config.toml'), 'utf8')) as {
        mcp_servers: Record<string, { command: string; args: string[] }>
      }
      const server = config.mcp_servers[DEV_TOOLS_MCP_SERVER_NAME]!
      expectInitializeAnswered(await initializeOver(server.command, server.args, staged.scratchDir))
      expect(staged.answered()).toBe(true)
    },
    SPAWN_TIMEOUT_MS
  )
})
