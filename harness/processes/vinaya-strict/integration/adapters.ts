/**
 * The two runtime adapters (O1) — one per runtime that hosts the shared MCP
 * server (`server.ts`). They differ ONLY in how each runtime is told to launch
 * the server; the server, the protocol, and the tools are identical across
 * both. Each registers one server per seat Vinaya's seat table declares
 * (`seatServerRegistrations`) — the Operator's, under the name and arguments it
 * has always had, plus the Planner, Architect and Tranche Archivist under
 * their own names with explicit `--seat` launch arguments:
 *
 *   - **Claude** registers a stdio MCP server in the project-root `.mcp.json`
 *     (`mcpServers.<name>.command`/`args`), generated through `artifacts.ts`
 *     (`buildInitOps`) as a refuse-if-foreign whole file, the same treatment
 *     `.claude/settings.json` already gets — strict JSON carries no comment
 *     markers, so it is never a managed block. It is a managed file
 *     (`vinaya.config.json`'s `managed.files`), so `vinaya upgrade` regenerates it.
 *   - **Codex** registers the same command through its documented
 *     `~/.codex/config.toml` `[mcp_servers.<name>]` table (`command`/`args`).
 *     Codex's config is a user-home file, not a repo artifact, so this adapter
 *     emits the exact TOML an operator adds; `self-hosting.md` records where it
 *     goes and the version it was verified against.
 *
 * Both point at the `vinaya-task-tools-serve` program in whichever invocation shape the
 * repo needs — published `npx` (pinned to the exact installed version, same
 * `ownVersion()` source the workflows and hooks pin to) or the vendored
 * `bun <source>` shape — so the self-hosting boundary (`self-hosting.md`) covers
 * this registration exactly as it covers every other generated invocation.
 *
 * Each adapter carries the runtime version it was verified against. Claude Code
 * was verified live on the authoring host; the Codex CLI was not installed
 * there, so its adapter records the documented config format it targets and is
 * explicit (`verifiedLiveOnAuthoringHost: false`) that no `codex --version` was
 * captured — this task's PR body discloses the same, rather than inventing a
 * version the host could not confirm.
 */

import { ownVersion } from './artifacts.js'
import type { VendoredVinaya } from '../tools/self-host.js'
import { MCP_PROTOCOL_VERSION } from '../../../kernel/tools/mcp-protocol.js'
import { seatLaunchArguments } from '../../../kernel/tools/host/seat-host.js'
import { VINAYA_SEAT_NAMES } from './seat-names.js'
import { type Program, PROGRAMS } from '../tools/programs.js'

/** A launchable command: the program plus its argument vector, the shape both `.mcp.json` and Codex's TOML expect. */
export type ServerInvocation = { command: string; args: string[] }

/**
 * The shared server program (`vinaya-task-tools-serve`, the program table's
 * `task-tools-serve`) in whichever shape the repo needs — `bun <source>` when
 * the repo declares `@attalabs/vinaya` itself and so holds the program's
 * source (`self-hosting.md`), else published `npx` pinned to the exact
 * installed version, naming the program's own `bin`.
 */
export function taskToolsServerInvocation(selfHost: VendoredVinaya | null): ServerInvocation {
  const program = PROGRAMS.get('task-tools-serve') as Program
  if (selfHost) {
    return { command: 'bun', args: [program.source] }
  }
  return { command: 'npx', args: ['--yes', '-p', `@attalabs/vinaya@${ownVersion()}`, program.bin] }
}

/** One MCP server registration: the name it is registered under and the launch that serves its seat. */
export type SeatServerRegistration = { serverName: string; invocation: ServerInvocation }

/**
 * One registration per seat Vinaya's seat table declares, in the table's
 * order: the shared server program, plus the seat's own launch argument. The
 * Operator's seat is the default, so its entry carries no seat argument and
 * keeps the server name and arguments every configuration already generated
 * registers. It reads the names-only table (`seat-names.ts`), never the tool
 * server, so generating a configuration loads no role's tools.
 */
export function seatServerRegistrations(selfHost: VendoredVinaya | null): SeatServerRegistration[] {
  const table = VINAYA_SEAT_NAMES
  const base = taskToolsServerInvocation(selfHost)
  return table.seats.map((seat) => ({
    serverName: seat.serverName,
    invocation: { command: base.command, args: [...base.args, ...seatLaunchArguments(table, seat.name)] }
  }))
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

/** The Claude `.mcp.json` object — one stdio MCP server per declared seat, each a launch of the shared task-tools server. */
export function claudeMcpJsonConfig(selfHost: VendoredVinaya | null): {
  mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }>
} {
  const mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }> = {}
  for (const { serverName, invocation } of seatServerRegistrations(selfHost)) {
    mcpServers[serverName] = { type: 'stdio', command: invocation.command, args: invocation.args }
  }
  return { mcpServers }
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
 * — one table per declared seat, the same server commands as Claude's
 * `.mcp.json`, in Codex's documented registration format. Tables are
 * separated by one blank line.
 */
export function codexMcpServersToml(selfHost: VendoredVinaya | null): string {
  return seatServerRegistrations(selfHost)
    .map(({ serverName, invocation }) =>
      [
        `[mcp_servers.${serverName}]`,
        `command = ${JSON.stringify(invocation.command)}`,
        `args = ${tomlStringArray(invocation.args)}`,
        ''
      ].join('\n')
    )
    .join('\n')
}
