/**
 * `vinaya-task-tools-serve` — runs the shared task-tools MCP server
 * (`harness/processes/vinaya-strict/integration/server.ts`) over stdio, the ONE program both
 * runtime adapters (`.mcp.json` for Claude, `[mcp_servers]` for Codex) register.
 * It speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and nothing else —
 * every human-facing line the rest of the CLI prints would corrupt the
 * protocol stream, so this program writes none.
 *
 * The caller identity is resolved from the invocation context (the process
 * environment, `CALLER_ENV_VAR`), never from a tool argument — the transport
 * authenticates, not the payload (`server.ts`). An attended operator exports
 * that variable to authorize `task_start`; started without it, the server
 * still answers every read tool and refuses `task_start`.
 */

import { isEntryPoint } from '../../../../kernel/gates/checks/entry-point.js'
import { ownVersion } from '../artifacts.js'
import { serveTaskToolsStdio } from '../server.js'

export async function taskToolsServeCommand(_args: string[]): Promise<void> {
  await serveTaskToolsStdio(ownVersion())
}

// Run as a program (`vinaya-task-tools-serve`): started through the shared program entry.
if (isEntryPoint(import.meta.url, 'task-tools-serve')) {
  const { runProgram } = await import('../../tools/program-entry.js')
  await runProgram('task-tools-serve', async (argv: string[]) => {
    await taskToolsServeCommand(argv)
  })
}
