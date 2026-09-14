import { describe, expect, it } from 'bun:test'
import type { VendoredVinaya } from '../../../src/lib/self-host.js'
import {
  CLAUDE_MCP_ADAPTER,
  claudeMcpJsonConfig,
  claudeMcpJsonFile,
  CODEX_MCP_ADAPTER,
  codexMcpServersToml,
  MCP_RUNTIME_ADAPTERS,
  TASK_TOOLS_SERVE_ARGS,
  taskToolsServerInvocation
} from '../../../src/lib/task-tools/adapters.js'
import { MCP_PROTOCOL_VERSION, TASK_TOOLS_MCP_SERVER_NAME } from '../../../src/lib/task-tools/server.js'

/**
 * The two runtime adapters (O1): both register the SAME server command; they
 * differ only in registration file format. These assert the command shapes and
 * that each adapter pins the runtime version it was verified against — Claude
 * live, Codex documented (no binary on the authoring host).
 */

const SELF_HOST: VendoredVinaya = { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' } as VendoredVinaya

describe('taskToolsServerInvocation', () => {
  it('published adopter: pinned npx invocation ending in the serve subcommand', () => {
    const inv = taskToolsServerInvocation(null)
    expect(inv.command).toBe('npx')
    expect(inv.args[0]).toBe('--yes')
    expect(inv.args[1]).toMatch(/^@attalabs\/vinaya@/)
    expect(inv.args.slice(-3)).toEqual([...TASK_TOOLS_SERVE_ARGS])
  })

  it('vendoring repo: node <bin> invocation ending in the serve subcommand', () => {
    const inv = taskToolsServerInvocation(SELF_HOST)
    expect(inv.command).toBe('node')
    expect(inv.args).toEqual(['apps/cli/dist/index.js', 'task', 'tools', 'serve'])
  })
})

describe('Claude .mcp.json adapter', () => {
  it('declares one stdio MCP server under the shared name', () => {
    const cfg = claudeMcpJsonConfig(SELF_HOST)
    const server = cfg.mcpServers[TASK_TOOLS_MCP_SERVER_NAME]
    expect(server).toBeDefined()
    expect(server?.type).toBe('stdio')
    expect(server?.command).toBe('node')
    expect(server?.args).toEqual(['apps/cli/dist/index.js', 'task', 'tools', 'serve'])
  })

  it('emits a parseable JSON file with a trailing newline', () => {
    const file = claudeMcpJsonFile(SELF_HOST)
    expect(file.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(file)).not.toThrow()
  })
})

describe('Codex [mcp_servers] adapter', () => {
  it('emits the documented TOML table for the same command', () => {
    const toml = codexMcpServersToml(SELF_HOST)
    expect(toml).toContain(`[mcp_servers.${TASK_TOOLS_MCP_SERVER_NAME}]`)
    expect(toml).toContain('command = "node"')
    expect(toml).toContain('args = ["apps/cli/dist/index.js", "task", "tools", "serve"]')
  })

  it('registers the same command as the Claude adapter — one server, two registrations', () => {
    const claude = claudeMcpJsonConfig(SELF_HOST).mcpServers[TASK_TOOLS_MCP_SERVER_NAME]
    const toml = codexMcpServersToml(SELF_HOST)
    // The TOML's command/args are the same invocation the Claude .mcp.json declares.
    expect(toml).toContain(`command = ${JSON.stringify(claude?.command)}`)
    expect(toml).toContain(`args = [${(claude?.args ?? []).map((a) => JSON.stringify(a)).join(', ')}]`)
  })
})

describe('runtime version pins', () => {
  it('Claude is pinned to a live-verified Claude Code version', () => {
    expect(CLAUDE_MCP_ADAPTER.runtime).toBe('claude')
    expect(CLAUDE_MCP_ADAPTER.verifiedLiveOnAuthoringHost).toBe(true)
    expect(CLAUDE_MCP_ADAPTER.runtimeVersion).toBe('2.1.197')
    expect(CLAUDE_MCP_ADAPTER.mcpProtocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })

  it('Codex records the documented format honestly — no binary on the authoring host', () => {
    expect(CODEX_MCP_ADAPTER.runtime).toBe('codex')
    expect(CODEX_MCP_ADAPTER.verifiedLiveOnAuthoringHost).toBe(false)
    expect(CODEX_MCP_ADAPTER.runtimeVersion).toBeNull()
    expect(CODEX_MCP_ADAPTER.mcpProtocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })

  it('exposes both adapters', () => {
    expect(MCP_RUNTIME_ADAPTERS.map((a) => a.runtime)).toEqual(['claude', 'codex'])
  })
})
