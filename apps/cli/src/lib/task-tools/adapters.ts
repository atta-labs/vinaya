/**
 * The two runtime adapters (O1) — one per runtime that hosts the shared MCP
 * server (`server.ts`). They differ ONLY in how each runtime is told to launch
 * the server; the server, the protocol, and the five tools are identical across
 * both:
 *
 *   - **Claude** registers a stdio MCP server in the project-root `.mcp.json`
 *     (`mcpServers.<name>.command`/`args`), generated through `artifacts.ts`
 *     (`buildInitOps`) as a refuse-if-foreign whole file, the same treatment
 *     `.claude/settings.json` already gets — strict JSON carries no comment
 *     markers, so it is never a managed block.
 *   - **Codex** registers the same command through its documented
 *     `~/.codex/config.toml` `[mcp_servers.<name>]` table (`command`/`args`).
 *     Codex's config is a user-home file, not a repo artifact, so this adapter
 *     emits the exact TOML an operator adds; `self-hosting.md` records where it
 *     goes and the version it was verified against.
 *
 * Both point at `vinaya task-tools serve` in whichever invocation shape the
 * repo needs — published `npx` (pinned to the exact installed version, same
 * `ownVersion()` source the workflows and hooks pin to) or the vendored
 * `node <bin>` shape — so the self-hosting boundary (`self-hosting.md`) covers
 * this registration exactly as it covers every other generated invocation.
 *
 * Each adapter carries the runtime version it was verified against. Claude Code
 * was verified live on the authoring host; the Codex CLI was not installed
 * there, so its adapter records the documented config format it targets and is
 * explicit (`verifiedLiveOnAuthoringHost: false`) that no `codex --version` was
 * captured — this task's PR body discloses the same, rather than inventing a
 * version the host could not confirm.
 */

import { ownVersion } from '../artifacts.js'
import type { VendoredVinaya } from '../self-host.js'
import { MCP_PROTOCOL_VERSION, TASK_TOOLS_MCP_SERVER_NAME } from './server.js'

/** The `vinaya task-tools serve` subcommand argv — the one command both adapters register. */
export const TASK_TOOLS_SERVE_ARGS = ['task-tools', 'serve'] as const

/** A launchable command: the program plus its argument vector, the shape both `.mcp.json` and Codex's TOML expect. */
export type ServerInvocation = { command: string; args: string[] }

/**
 * The shared server command in whichever shape the repo needs — the vendored
 * `node <bin>` form when the repo declares `@attalabs/vinaya` itself (npx
 * misresolves there, `self-hosting.md`), else published `npx` pinned to the
 * exact installed version.
 */
export function taskToolsServerInvocation(selfHost: VendoredVinaya | null): ServerInvocation {
  if (selfHost) {
    return { command: 'node', args: [selfHost.bin, ...TASK_TOOLS_SERVE_ARGS] }
  }
  return { command: 'npx', args: ['--yes', `@attalabs/vinaya@${ownVersion()}`, ...TASK_TOOLS_SERVE_ARGS] }
}

/** What each adapter pins: the runtime it registers on, the version verified against, and the MCP protocol revision. */
export type McpRuntimeAdapter = {
  runtime: 'claude' | 'codex'
  /** The runtime CLI version this adapter was verified against, or `null` when no binary was available on the authoring host to capture one. */
  runtimeVersion: string | null
  /** True only when a real binary of this runtime was run on the authoring host to confirm the registration; `false` means the format follows the runtime's documentation, disclosed as such. */
  verifiedLiveOnAuthoringHost: boolean
  /** The MCP spec revision the server implements and this adapter targets. */
  mcpProtocolVersion: string
  note: string
}

export const CLAUDE_MCP_ADAPTER: McpRuntimeAdapter = {
  runtime: 'claude',
  runtimeVersion: '2.1.197',
  verifiedLiveOnAuthoringHost: true,
  mcpProtocolVersion: MCP_PROTOCOL_VERSION,
  note: 'Claude Code reads project MCP servers from `.mcp.json` (`mcpServers.<name>`). Verified live against Claude Code 2.1.197.'
}

export const CODEX_MCP_ADAPTER: McpRuntimeAdapter = {
  runtime: 'codex',
  runtimeVersion: null,
  verifiedLiveOnAuthoringHost: false,
  mcpProtocolVersion: MCP_PROTOCOL_VERSION,
  note: "Codex reads MCP servers from `~/.codex/config.toml` (`[mcp_servers.<name>]`). No codex binary on the authoring host to capture `--version`; the emitted TOML follows Codex's documented `mcp_servers` config."
}

export const MCP_RUNTIME_ADAPTERS: readonly McpRuntimeAdapter[] = [CLAUDE_MCP_ADAPTER, CODEX_MCP_ADAPTER]

// --- Claude: the generated `.mcp.json` --------------------------------------

/** The Claude `.mcp.json` object — one stdio MCP server, the shared task-tools server. */
export function claudeMcpJsonConfig(selfHost: VendoredVinaya | null): {
  mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }>
} {
  const { command, args } = taskToolsServerInvocation(selfHost)
  return {
    mcpServers: {
      [TASK_TOOLS_MCP_SERVER_NAME]: { type: 'stdio', command, args }
    }
  }
}

/** The `.mcp.json` file content (trailing newline), generated through `artifacts.ts`. */
export function claudeMcpJsonFile(selfHost: VendoredVinaya | null): string {
  return `${JSON.stringify(claudeMcpJsonConfig(selfHost), null, 2)}\n`
}

// --- Codex: the documented `[mcp_servers]` TOML -----------------------------

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => JSON.stringify(v)).join(', ')}]`
}

/**
 * The Codex `[mcp_servers.<name>]` TOML an operator adds to `~/.codex/config.toml`
 * — the same server command as Claude's `.mcp.json`, in Codex's documented
 * registration format.
 */
export function codexMcpServersToml(selfHost: VendoredVinaya | null): string {
  const { command, args } = taskToolsServerInvocation(selfHost)
  return [
    `[mcp_servers.${TASK_TOOLS_MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(command)}`,
    `args = ${tomlStringArray(args)}`,
    ''
  ].join('\n')
}
