/**
 * `vinaya task-tools serve` — runs the shared task-tools MCP server
 * (`apps/cli/src/lib/task-tools/server.ts`) over stdio, the ONE command both
 * runtime adapters (`.mcp.json` for Claude, `[mcp_servers]` for Codex) register.
 * It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and nothing else —
 * every human-facing line the rest of the CLI prints would corrupt the
 * protocol stream, so this command writes none.
 *
 * The caller identity is resolved from the invocation context (the process
 * environment, `CALLER_ENV_VAR`), never from a tool argument — the transport
 * authenticates, not the payload (`server.ts`). An attended operator exports
 * that variable to authorize `task_start`; started without it, the server
 * still answers every read tool and refuses `task_start`.
 */

import { ownVersion } from '../lib/artifacts.js'
import { serveTaskToolsStdio } from '../lib/task-tools/server.js'

export async function taskToolsServeCommand(_args: string[]): Promise<void> {
  await serveTaskToolsStdio(ownVersion())
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  'task-tools serve': { date: '2026-09-14', callsToday: 2, retiresVia: 'sharedCommandShell' }
}
