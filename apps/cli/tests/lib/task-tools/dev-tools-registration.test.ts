import { describe, expect, it } from 'bun:test'
import {
  CLAUDE_DEV_TOOLS_ENV,
  CODEX_DEV_TOOLS_APPROVAL_MODE,
  claudeDevToolName,
  claudeDevToolsArgs,
  claudeDevToolsStartFailure,
  codexDevToolsConfigToml,
  codexDevToolsMcpTable,
  DEV_TOOLS_TOOL_TIMEOUT_SEC,
  devToolsMcpConfig,
  devToolsMcpConfigFileBody,
  watchClaudeDevToolsStart
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
    expect(entry).toEqual({
      type: 'stdio',
      command: BRIDGE.command,
      args: BRIDGE.args,
      timeout: DEV_TOOLS_TOOL_TIMEOUT_SEC * 1000
    })
  })
  it('declares a per-call timeout, in milliseconds, long enough for a gated publication', () => {
    expect(DEV_TOOLS_TOOL_TIMEOUT_SEC).toBe(1800)
    expect(devToolsMcpConfig(BRIDGE).mcpServers[DEV_TOOLS_MCP_SERVER_NAME]?.timeout).toBe(1_800_000)
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

describe('claudeDevToolsStartFailure', () => {
  const init = (fields: Record<string, unknown>): string =>
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', ...fields })

  it('names a server the init event reports failed', () => {
    const line = init({ mcp_servers: [{ name: DEV_TOOLS_MCP_SERVER_NAME, status: 'failed', source: 'dynamic' }] })
    expect(claudeDevToolsStartFailure(line)).toContain('failed to start')
  })
  it('names a server the init event reports skipped, quoting Claude Code’s message', () => {
    const line = init({
      mcp_servers: [],
      mcp_server_errors: [{ name: DEV_TOOLS_MCP_SERVER_NAME, type: 'url_missing_type', message: 'Skipped — bad entry' }]
    })
    expect(claudeDevToolsStartFailure(line)).toContain('Skipped — bad entry')
  })
  it('names a server the init event lists nowhere', () => {
    expect(claudeDevToolsStartFailure(init({ mcp_servers: [], mcp_server_errors: null }))).toContain('not loaded')
  })
  it('accepts a connected or still-pending server', () => {
    for (const status of ['connected', 'pending']) {
      const line = init({ mcp_servers: [{ name: DEV_TOOLS_MCP_SERVER_NAME, status }] })
      expect(claudeDevToolsStartFailure(line)).toBeNull()
    }
  })
  it('ignores every line that is not the init event', () => {
    expect(claudeDevToolsStartFailure('not json')).toBeNull()
    expect(claudeDevToolsStartFailure(JSON.stringify({ type: 'assistant', message: {} }))).toBeNull()
    expect(claudeDevToolsStartFailure(JSON.stringify({ type: 'system', subtype: 'api_retry' }))).toBeNull()
  })
  it('ignores another server’s failure', () => {
    const line = init({
      mcp_servers: [
        { name: 'other', status: 'failed' },
        { name: DEV_TOOLS_MCP_SERVER_NAME, status: 'connected' }
      ]
    })
    expect(claudeDevToolsStartFailure(line)).toBeNull()
  })
})

describe('watchClaudeDevToolsStart', () => {
  const init = (status: string): string =>
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: DEV_TOOLS_MCP_SERVER_NAME, status }]
    })

  it('ends the session once, on the first line reporting the server failed', () => {
    const ended: string[] = []
    const watch = watchClaudeDevToolsStart((reason) => ended.push(reason))
    watch.onLine('{"type":"assistant"}')
    expect(watch.failure()).toBeNull()
    watch.onLine(init('failed'))
    watch.onLine(init('failed'))
    expect(ended).toHaveLength(1)
    expect(watch.failure()).toContain('failed to start')
  })
  it('never ends a session whose server connected', () => {
    const ended: string[] = []
    const watch = watchClaudeDevToolsStart((reason) => ended.push(reason))
    watch.onLine(init('connected'))
    expect(ended).toEqual([])
    expect(watch.failure()).toBeNull()
  })
  it('starts Claude waiting for its MCP servers, so the init event carries a settled status', () => {
    expect(CLAUDE_DEV_TOOLS_ENV).toEqual({ MCP_CONNECTION_NONBLOCKING: '0' })
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
  it('marks the server required, so Codex refuses to start without it', () => {
    expect(codexDevToolsMcpTable(BRIDGE)).toContain('required = true')
  })
})

describe('codexDevToolsConfigToml', () => {
  it('appends the mcp table after an existing sandbox config', () => {
    const toml = codexDevToolsConfigToml(BRIDGE, 'sandbox_mode = "workspace-write"')
    expect(toml.startsWith('sandbox_mode = "workspace-write"')).toBe(true)
    expect(toml).toContain(`[mcp_servers.${DEV_TOOLS_MCP_SERVER_NAME}]`)
  })
  it('the staged config.toml parses to a required server with the publication timeout', () => {
    const parsed = Bun.TOML.parse(codexDevToolsConfigToml(BRIDGE, 'sandbox_mode = "workspace-write"')) as {
      mcp_servers: Record<string, Record<string, unknown>>
    }
    const server = parsed.mcp_servers[DEV_TOOLS_MCP_SERVER_NAME]
    expect(server?.required).toBe(true)
    expect(server?.tool_timeout_sec).toBe(DEV_TOOLS_TOOL_TIMEOUT_SEC)
    expect(server?.command).toBe(BRIDGE.command)
  })
  it('is the table alone when there is no sandbox config', () => {
    const toml = codexDevToolsConfigToml(BRIDGE, null)
    expect(toml).toBe(codexDevToolsMcpTable(BRIDGE))
  })
})
