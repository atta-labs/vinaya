import { describe, expect, it } from 'bun:test'
import type { VendoredVinaya } from '../../../tools/self-host.js'
import { claudeMcpJsonConfig } from '../../adapters.js'
import { TASK_TOOLS_MCP_SERVER_NAME } from '../../server.js'
import { resolve } from 'node:path'
import { ABS_BIN, defineConformanceSuite, REPO_ROOT } from './harness.js'
import { defineLiveGrantCases } from './role-grants-live.js'

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
// The registration names the program's source from the repository root; the suite starts it from a sandbox.
defineConformanceSuite('claude', {
  command: claudeServer.command,
  args: claudeServer.args.map((arg) => resolve(REPO_ROOT, arg))
})

// Live, opt-in: each role's session sees exactly its granted driver-run tools (`role-grants-live.ts`).
defineLiveGrantCases('claude')
