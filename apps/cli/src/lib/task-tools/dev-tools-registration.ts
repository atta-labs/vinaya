/**
 * The per-dispatch dev-tools registration — the SAME shape a real Developer
 * dispatch and the O1 proof both use to point an agent's own MCP client at the
 * driver-run dev-tools server through the thin `dev-bridge` relay (O2). Factored
 * out of `dev-proof.ts` so the proof and the dispatch wiring register the
 * server identically rather than drifting apart: the proof's macOS PASS then
 * proves the exact registration a dispatch ships.
 *
 * Each agent is registered through its OWN configuration channel, never the
 * worktree's committed `.mcp.json`:
 *
 *  - Claude: a driver-written config file passed with
 *    `--strict-mcp-config --mcp-config <file>`. `--strict-mcp-config` makes
 *    `<file>` the ONLY MCP configuration the session loads, so a committed
 *    `.mcp.json` in the worktree is never read (O2).
 *  - Codex: a `[mcp_servers.<name>]` table in the staged `CODEX_HOME`
 *    `config.toml` — the only config home a confined Codex dispatch reads, so
 *    again the worktree's committed `.mcp.json` plays no part.
 */

import { DEV_TOOLS_MCP_SERVER_NAME } from './dev-tools-server.js'

/** The bridge the agent's MCP client spawns (command + args), pointing at a `dev-bridge --socket <path>` relay. */
export type BridgeInvocation = { command: string; args: string[] }

/**
 * The Claude MCP configuration object the driver writes and passes with
 * `--mcp-config`. A single `stdio` server entry whose `command`/`args` are the
 * bridge, keyed by the dev-tools server name.
 */
export function devToolsMcpConfig(bridge: BridgeInvocation): {
  mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }>
} {
  return { mcpServers: { [DEV_TOOLS_MCP_SERVER_NAME]: { type: 'stdio', command: bridge.command, args: bridge.args } } }
}

/** The serialized `--mcp-config` file body (trailing newline), ready to write. */
export function devToolsMcpConfigFileBody(bridge: BridgeInvocation): string {
  return `${JSON.stringify(devToolsMcpConfig(bridge), null, 2)}\n`
}

/**
 * The Claude CLI flags that register the dev-tools server and nothing else:
 * `--strict-mcp-config` (ignore every other MCP source, including the
 * worktree's committed `.mcp.json`) and `--mcp-config <file>`. `allowedTools`,
 * when given, are appended as `--allowedTools <csv>` so a caller can restrict
 * the session to specific dev-tools (the proof allows only `run_checks`).
 */
export function claudeDevToolsArgs(mcpConfigPath: string, allowedTools?: readonly string[]): string[] {
  return [
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    ...(allowedTools && allowedTools.length > 0 ? ['--allowedTools', allowedTools.join(',')] : [])
  ]
}

/** The fully-qualified name Claude exposes an MCP tool under: `mcp__<server>__<tool>`. */
export function claudeDevToolName(tool: string): string {
  return `mcp__${DEV_TOOLS_MCP_SERVER_NAME}__${tool}`
}

/**
 * The `[mcp_servers.<name>]` TOML table Codex reads from its `CODEX_HOME`
 * `config.toml`. Appended after any sandbox config in the same staged file so
 * the one generated home carries both. String/array values are JSON-encoded,
 * which is valid TOML for these scalar shapes.
 */
export function codexDevToolsMcpTable(bridge: BridgeInvocation): string {
  const argsToml = `[${bridge.args.map((a) => JSON.stringify(a)).join(', ')}]`
  return [
    `[mcp_servers.${DEV_TOOLS_MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(bridge.command)}`,
    `args = ${argsToml}`,
    ''
  ].join('\n')
}

/**
 * Codex's `config.toml` carrying the dev-tools registration — the sandbox
 * config (when present) followed by the `[mcp_servers.<name>]` table. When
 * there is no sandbox config (an unconfined floor-only home), the table is the
 * whole file.
 */
export function codexDevToolsConfigToml(bridge: BridgeInvocation, sandboxConfigToml: string | null): string {
  const table = codexDevToolsMcpTable(bridge)
  return sandboxConfigToml ? `${sandboxConfigToml}\n${table}` : table
}
