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

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEV_TOOLS_MCP_SERVER_NAME } from './dev-tools-names.js'

/** The bridge the agent's MCP client spawns (command + args), pointing at a `dev-bridge --socket <path>` relay. */
export type BridgeInvocation = { command: string; args: string[] }

/**
 * The owner-only private directory the driver creates for a task's dev-tools
 * socket — a per-task digest directory under one `vinaya-dev-tools` root.
 * `startDevToolsHost` creates it mode 0700 so no other local user can traverse
 * into it, which is what keeps the socket inside it unreachable to anyone but
 * the driver's own user (a predictable path in the world-writable shared temp
 * dir would otherwise let another local user pre-create or connect to it).
 */
export function devToolsSocketDir(key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(devToolsSocketRoot(), digest)
}

/** A single literal parent that the Claude Bash sandbox can hide at launch. */
export function devToolsSocketRoot(): string {
  return join(tmpdir(), 'vinaya-dev-tools')
}

/**
 * A stable, short unix-domain socket path for the driver-run dev-tools host,
 * derived from a per-task key. Lives inside the owner-only `devToolsSocketDir`
 * (mode 0700) and is itself created mode 0600 by `startDevToolsHost`. Short by
 * construction (a 16-hex digest directory under `tmpdir()`, a one-char socket
 * name) so it stays inside the `sockaddr_un` path limit (~104 bytes on macOS,
 * ~108 on Linux) that a long runtime path would blow, and STABLE across a
 * task's rounds so a reused Codex `CODEX_HOME` whose staged `config.toml` baked
 * the bridge in round 1 still points at the host the driver restarts on the
 * same path each dispatch (`startDevToolsHost` unlinks a stale socket).
 */
export function devToolsSocketPath(key: string): string {
  return join(devToolsSocketDir(key), 's.sock')
}

/**
 * The bridge the agent's own MCP client spawns INSIDE its sandbox — this
 * running vinaya entrypoint (`process.execPath` + this process's entry script)
 * relaying stdio to the driver-run host over `socketPath`. Repo-local and
 * identical whether invoked as `bun …/index.ts` or the installed `vinaya`
 * binary; the one builder both the production dispatch and the O1 proof use so
 * they register the server identically.
 */
export function driverDevBridgeInvocation(socketPath: string): BridgeInvocation {
  const entry = process.argv[1] ?? 'vinaya'
  return { command: process.execPath, args: [entry, 'task-tools', 'dev-bridge', '--socket', socketPath] }
}

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
 * Codex's per-server key approving THIS server's tools without an interactive
 * prompt. A confined `codex exec` runs under `approval_policy = "never"`, which
 * in non-interactive mode means "auto-reject any tool that needs approval," so
 * a managed MCP call fails with "MCP tool call requires approval, but approval
 * policy is never" (Principal ruling 1040-3, confirmed live on macOS). The
 * documented per-server override is `mcp_servers.<id>.default_tools_approval_mode`
 * — "Default approval behavior for MCP tools on this server unless a per-tool
 * override exists," values `auto | prompt | writes | approve` — set to
 * `approve` so the driver-run server's own tools (and ONLY those: no other
 * server is registered) are approved for this one dispatch, with the global
 * `approval_policy` and the sandbox left untouched. Documented at
 * https://developers.openai.com/codex/config-file/config-reference
 * ([mcp_servers.<name>] table).
 */
export const CODEX_DEV_TOOLS_APPROVAL_MODE = 'approve'

/**
 * The `[mcp_servers.<name>]` TOML table Codex reads from its `CODEX_HOME`
 * `config.toml`. Appended after any sandbox config in the same staged file so
 * the one generated home carries both. String/array values are JSON-encoded,
 * which is valid TOML for these scalar shapes. Carries
 * `default_tools_approval_mode` so Codex approves this server's tools under its
 * non-interactive `approval_policy = "never"` (see
 * `CODEX_DEV_TOOLS_APPROVAL_MODE`).
 */
export function codexDevToolsMcpTable(bridge: BridgeInvocation): string {
  const argsToml = `[${bridge.args.map((a) => JSON.stringify(a)).join(', ')}]`
  return [
    `[mcp_servers.${DEV_TOOLS_MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(bridge.command)}`,
    `args = ${argsToml}`,
    `default_tools_approval_mode = ${JSON.stringify(CODEX_DEV_TOOLS_APPROVAL_MODE)}`,
    'tool_timeout_sec = 1800',
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
