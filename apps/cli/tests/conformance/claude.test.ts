import { describe, expect, it } from 'bun:test'
import type { VendoredVinaya } from '../../src/lib/self-host.js'
import { claudeMcpJsonConfig } from '../../src/lib/task-tools/adapters.js'
import { TASK_TOOLS_MCP_SERVER_NAME } from '../../src/lib/task-tools/server.js'
import { ABS_BIN, defineConformanceSuite } from './harness.js'

/**
 * The Claude runtime half of Part 2 (O2) — nine scenarios, shared verbatim
 * with `codex.test.ts` via `harness.ts`'s `defineConformanceSuite`. This
 * file's own job is narrower: prove the server every scenario below drives
 * is the EXACT command Claude's `.mcp.json` adapter (`adapters.ts`) actually
 * registers — the same command `protocol.test.ts` already proves reachable
 * over real stdio — so a scenario passing here is a claim about the real
 * Claude registration path, not an invented invocation.
 */

const SELF_HOST: VendoredVinaya = { dir: 'apps/cli', bin: ABS_BIN } as VendoredVinaya

describe('Claude adapter — registers the shared task-tools server', () => {
  it('`.mcp.json` names the shared server under the shared server name', () => {
    const config = claudeMcpJsonConfig(SELF_HOST)
    expect(Object.keys(config.mcpServers)).toEqual([TASK_TOOLS_MCP_SERVER_NAME])
    expect(config.mcpServers[TASK_TOOLS_MCP_SERVER_NAME]?.type).toBe('stdio')
  })
})

const claudeServer = claudeMcpJsonConfig(SELF_HOST).mcpServers[TASK_TOOLS_MCP_SERVER_NAME]!
defineConformanceSuite('claude', { command: claudeServer.command, args: claudeServer.args })
