import { describe, expect, it } from 'bun:test'
import type { VendoredVinaya } from '../../src/lib/self-host.js'
import { codexMcpServersToml } from '../../src/lib/task-tools/adapters.js'
import { TASK_TOOLS_MCP_SERVER_NAME } from '../../src/lib/task-tools/server.js'
import { ABS_BIN, defineConformanceSuite } from './harness.js'

/**
 * The Codex runtime half of Part 2 (O2) — nine scenarios, shared verbatim
 * with `claude.test.ts` via `harness.ts`'s `defineConformanceSuite`. The
 * command driven below is parsed back OUT of the real `[mcp_servers]` TOML
 * text `codexMcpServersToml` emits (`adapters.ts`) — not the shared
 * `taskToolsServerInvocation` helper called a second time — so this proves
 * the actual artifact an operator would paste into `~/.codex/config.toml`
 * is itself byte-parseable into the command Codex would run, the same
 * command Claude's `.mcp.json` registers (`protocol.test.ts`'s own
 * "identical command" assertion) and `claude.test.ts` drives.
 */

const SELF_HOST: VendoredVinaya = { dir: 'apps/cli', bin: ABS_BIN } as VendoredVinaya

function parseCodexServerInvocation(toml: string, name: string): { command: string; args: string[] } {
  const section = toml.split(`[mcp_servers.${name}]`)[1] ?? ''
  const commandMatch = /command\s*=\s*("(?:[^"\\]|\\.)*")/.exec(section)
  const argsMatch = /args\s*=\s*(\[[^\]]*\])/.exec(section)
  if (!commandMatch || !argsMatch) {
    throw new Error(`could not parse [mcp_servers.${name}] from the emitted TOML`)
  }
  return { command: JSON.parse(commandMatch[1] as string), args: JSON.parse(argsMatch[1] as string) }
}

describe('Codex adapter — registers the shared task-tools server', () => {
  it('`[mcp_servers]` TOML names the shared server under the shared server name', () => {
    const toml = codexMcpServersToml(SELF_HOST)
    expect(toml).toContain(`[mcp_servers.${TASK_TOOLS_MCP_SERVER_NAME}]`)
    const invocation = parseCodexServerInvocation(toml, TASK_TOOLS_MCP_SERVER_NAME)
    expect(invocation.command.length).toBeGreaterThan(0)
    expect(invocation.args.length).toBeGreaterThan(0)
  })
})

const codexToml = codexMcpServersToml(SELF_HOST)
const codexInvocation = parseCodexServerInvocation(codexToml, TASK_TOOLS_MCP_SERVER_NAME)
defineConformanceSuite('codex', codexInvocation)
