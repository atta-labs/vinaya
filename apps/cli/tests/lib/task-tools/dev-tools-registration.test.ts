import { describe, expect, it } from 'bun:test'
import {
  CODEX_DEV_TOOLS_APPROVAL_MODE,
  claudeDevToolName,
  claudeDevToolsArgs,
  codexDevToolsConfigToml,
  codexDevToolsMcpTable,
  devToolsMcpConfig,
  devToolsMcpConfigFileBody
} from '../../../src/lib/task-tools/dev-tools-registration.js'
import { DEV_TOOLS_MCP_SERVER_NAME } from '../../../src/lib/task-tools/dev-tools-server.js'

/**
 * The per-dispatch dev-tools registration (O2) — the one seam the O1 proof and
 * a real Developer dispatch share, so the proven macOS registration is the one
 * a dispatch ships. These assert each agent's own channel and that the
 * worktree's committed `.mcp.json` is never named by either.
 */

const BRIDGE = {
  command: '/usr/bin/bun',
  args: ['/repo/index.ts', 'task-tools', 'dev-bridge', '--socket', '/tmp/x.sock']
}

describe('devToolsMcpConfig (Claude)', () => {
  it('registers exactly the dev-tools server as a stdio bridge', () => {
    const cfg = devToolsMcpConfig(BRIDGE)
    expect(Object.keys(cfg.mcpServers)).toEqual([DEV_TOOLS_MCP_SERVER_NAME])
    const entry = cfg.mcpServers[DEV_TOOLS_MCP_SERVER_NAME]
    expect(entry).toEqual({ type: 'stdio', command: BRIDGE.command, args: BRIDGE.args })
  })
  it('the file body is the JSON config with a trailing newline', () => {
    const body = devToolsMcpConfigFileBody(BRIDGE)
    expect(body.endsWith('\n')).toBe(true)
    expect(JSON.parse(body)).toEqual(devToolsMcpConfig(BRIDGE))
  })
})

describe('claudeDevToolsArgs', () => {
  it('passes --strict-mcp-config so the committed .mcp.json is not loaded', () => {
    const args = claudeDevToolsArgs('/scratch/dev-tools.mcp.json')
    expect(args).toEqual(['--strict-mcp-config', '--mcp-config', '/scratch/dev-tools.mcp.json'])
  })
  it('appends --allowedTools as a csv when given', () => {
    const args = claudeDevToolsArgs('/p.json', [
      claudeDevToolName('run_checks'),
      claudeDevToolName('read_pull_request')
    ])
    expect(args.slice(-2)).toEqual([
      '--allowedTools',
      `mcp__${DEV_TOOLS_MCP_SERVER_NAME}__run_checks,mcp__${DEV_TOOLS_MCP_SERVER_NAME}__read_pull_request`
    ])
  })
})

describe('claudeDevToolName', () => {
  it('is Claude’s mcp__<server>__<tool> form', () => {
    expect(claudeDevToolName('publish_changes')).toBe(`mcp__${DEV_TOOLS_MCP_SERVER_NAME}__publish_changes`)
  })
})

describe('codexDevToolsMcpTable', () => {
  it('is a [mcp_servers.<name>] table with the bridge command and args', () => {
    const table = codexDevToolsMcpTable(BRIDGE)
    expect(table).toContain(`[mcp_servers.${DEV_TOOLS_MCP_SERVER_NAME}]`)
    expect(table).toContain(`command = ${JSON.stringify(BRIDGE.command)}`)
    expect(table).toContain('args = [')
    for (const a of BRIDGE.args) expect(table).toContain(JSON.stringify(a))
  })
  it('approves this server’s tools for the non-interactive run', () => {
    // Without this, a confined `codex exec` (approval_policy = "never")
    // auto-rejects the call: "MCP tool call requires approval, but approval
    // policy is never". The key is scoped to this one server table; the global
    // approval_policy and sandbox are untouched.
    const table = codexDevToolsMcpTable(BRIDGE)
    expect(table).toContain(`default_tools_approval_mode = "${CODEX_DEV_TOOLS_APPROVAL_MODE}"`)
    expect(CODEX_DEV_TOOLS_APPROVAL_MODE).toBe('approve')
    expect(table).not.toContain('approval_policy')
  })
  it('allows long-running pushes with hooks to complete', () => {
    expect(codexDevToolsMcpTable(BRIDGE)).toContain('tool_timeout_sec = 1800')
  })
})

describe('codexDevToolsConfigToml', () => {
  it('appends the mcp table after an existing sandbox config', () => {
    const toml = codexDevToolsConfigToml(BRIDGE, 'sandbox_mode = "workspace-write"')
    expect(toml.startsWith('sandbox_mode = "workspace-write"')).toBe(true)
    expect(toml).toContain(`[mcp_servers.${DEV_TOOLS_MCP_SERVER_NAME}]`)
  })
  it('is the table alone when there is no sandbox config', () => {
    const toml = codexDevToolsConfigToml(BRIDGE, null)
    expect(toml).toBe(codexDevToolsMcpTable(BRIDGE))
  })
})
