import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEAT_ARGUMENT } from '../../../../../kernel/tools/host/seat-host.js'
import type { VendoredVinaya } from '../../../tools/self-host.js'
import {
  CLAUDE_MCP_ADAPTER,
  claudeMcpJsonConfig,
  claudeMcpJsonFile,
  CODEX_MCP_ADAPTER,
  codexMcpServersToml,
  MCP_RUNTIME_ADAPTERS,
  seatServerRegistrations,
  taskToolsServerInvocation
} from '../../../integration/adapters.js'
import { ownVersion } from '../../../integration/artifacts.js'
import {
  MCP_PROTOCOL_VERSION,
  PLANNER_TOOLS_MCP_SERVER_NAME,
  TASK_TOOLS_MCP_SERVER_NAME,
  vinayaToolSeats
} from '../../../integration/server.js'

const REPO_ROOT = join(import.meta.dir, '../../../../../..')

/**
 * The two runtime adapters (O1): both register the SAME server command; they
 * differ only in registration file format. These assert the command shapes and
 * that each adapter pins the runtime version it was verified against — Claude
 * live, Codex documented (no binary on the authoring host).
 */

const SELF_HOST: VendoredVinaya = { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' } as VendoredVinaya

/** The serve program's source file, the program table's `task-tools-serve` entry. */
const SERVE_SOURCE = 'harness/processes/vinaya-strict/integration/bin/task-tools-serve.ts'

describe('taskToolsServerInvocation', () => {
  it('published adopter: pinned npx invocation naming the serve program', () => {
    const inv = taskToolsServerInvocation(null)
    expect(inv.command).toBe('npx')
    expect(inv.args.slice(0, 2)).toEqual(['--yes', '-p'])
    expect(inv.args[2]).toMatch(/^@attalabs\/vinaya@/)
    expect(inv.args.slice(3)).toEqual(['vinaya-task-tools-serve'])
  })

  it('vendoring repo: bun <source> invocation of the serve program', () => {
    const inv = taskToolsServerInvocation(SELF_HOST)
    expect(inv.command).toBe('bun')
    expect(inv.args).toEqual([SERVE_SOURCE])
  })
})

describe('Claude .mcp.json adapter', () => {
  it('declares one stdio MCP server under the shared name', () => {
    const cfg = claudeMcpJsonConfig(SELF_HOST)
    const server = cfg.mcpServers[TASK_TOOLS_MCP_SERVER_NAME]
    expect(server).toBeDefined()
    expect(server?.type).toBe('stdio')
    expect(server?.command).toBe('bun')
    expect(server?.args).toEqual([SERVE_SOURCE])
  })

  it('emits a parseable JSON file with a trailing newline', () => {
    const file = claudeMcpJsonFile(SELF_HOST)
    expect(file.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(file)).not.toThrow()
  })
})

describe('Codex [mcp_servers] adapter', () => {
  it('emits the documented TOML table for the same command', () => {
    const toml = codexMcpServersToml(SELF_HOST)
    expect(toml).toContain(`[mcp_servers.${TASK_TOOLS_MCP_SERVER_NAME}]`)
    expect(toml).toContain('command = "bun"')
    expect(toml).toContain(`args = ["${SERVE_SOURCE}"]`)
  })

  it('registers the same command as the Claude adapter — one server, two registrations', () => {
    const claude = claudeMcpJsonConfig(SELF_HOST).mcpServers[TASK_TOOLS_MCP_SERVER_NAME]
    const toml = codexMcpServersToml(SELF_HOST)
    // The TOML's command/args are the same invocation the Claude .mcp.json declares.
    expect(toml).toContain(`command = ${JSON.stringify(claude?.command)}`)
    expect(toml).toContain(`args = [${(claude?.args ?? []).map((a) => JSON.stringify(a)).join(', ')}]`)
  })
})

/**
 * One server entry per declared seat, the Operator's byte-identical to the
 * entry the generator wrote before seats existed: same server name, same
 * command, no seat argument. The expected text below is that earlier output,
 * written out — never recomputed from the generator under test.
 */
describe('one server entry per declared seat, the Operator’s unchanged', () => {
  const BOTH_CLAUDE_FILE_SELF_HOST = `{
  "mcpServers": {
    "vinaya-task-tools": {
      "type": "stdio",
      "command": "bun",
      "args": [
        "harness/processes/vinaya-strict/integration/bin/task-tools-serve.ts"
      ]
    },
    "vinaya-planner-tools": {
      "type": "stdio",
      "command": "bun",
      "args": [
        "harness/processes/vinaya-strict/integration/bin/task-tools-serve.ts",
        "--seat",
        "planner"
      ]
    }
  }
}
`
  const PLANNER_CODEX_TOML_SELF_HOST = `[mcp_servers.vinaya-planner-tools]
command = "bun"
args = ["harness/processes/vinaya-strict/integration/bin/task-tools-serve.ts", "--seat", "planner"]
`
  const OPERATOR_CODEX_TOML_SELF_HOST = `[mcp_servers.vinaya-task-tools]
command = "bun"
args = ["harness/processes/vinaya-strict/integration/bin/task-tools-serve.ts"]
`
  const operatorClaudeFilePublished = (version: string) => `{
  "mcpServers": {
    "vinaya-task-tools": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "-p",
        "@attalabs/vinaya@${version}",
        "vinaya-task-tools-serve"
      ]
    }
  }
}
`
  const operatorCodexTomlPublished = (version: string) => `[mcp_servers.vinaya-task-tools]
command = "npx"
args = ["--yes", "-p", "@attalabs/vinaya@${version}", "vinaya-task-tools-serve"]
`

  it('registers exactly one server per seat the seat table declares', () => {
    const seats = vinayaToolSeats().seats
    const registrations = seatServerRegistrations(SELF_HOST)
    expect(registrations.map((r) => r.serverName)).toEqual(seats.map((seat) => seat.serverName))
    expect(Object.keys(claudeMcpJsonConfig(SELF_HOST).mcpServers)).toEqual(seats.map((seat) => seat.serverName))
    const tables: string[] = [...(codexMcpServersToml(SELF_HOST).match(/^\[mcp_servers\.[^\]]+\]$/gm) ?? [])]
    expect(tables).toEqual(seats.map((seat) => `[mcp_servers.${seat.serverName}]`))
  })

  it("the Operator's seat is registered under its current name, with no seat argument", () => {
    const operator = seatServerRegistrations(SELF_HOST).find((r) => r.serverName === TASK_TOOLS_MCP_SERVER_NAME)
    expect(operator?.invocation).toEqual({ command: 'bun', args: [SERVE_SOURCE] })
    expect(operator?.invocation.args).not.toContain(SEAT_ARGUMENT)
  })

  it('the vendoring-repo Claude .mcp.json and Codex TOML carry the Operator’s entry as it was, then the Planner’s', () => {
    expect(claudeMcpJsonFile(SELF_HOST)).toBe(BOTH_CLAUDE_FILE_SELF_HOST)
    expect(codexMcpServersToml(SELF_HOST)).toBe(`${OPERATOR_CODEX_TOML_SELF_HOST}\n${PLANNER_CODEX_TOML_SELF_HOST}`)
  })

  it('the published-adopter Claude .mcp.json and Codex TOML carry both servers, the Operator’s as it was', () => {
    const version = ownVersion()
    const claude = JSON.parse(claudeMcpJsonFile(null))
    expect(Object.keys(claude.mcpServers)).toEqual([TASK_TOOLS_MCP_SERVER_NAME, PLANNER_TOOLS_MCP_SERVER_NAME])
    expect(claude.mcpServers[TASK_TOOLS_MCP_SERVER_NAME]).toEqual(
      JSON.parse(operatorClaudeFilePublished(version)).mcpServers[TASK_TOOLS_MCP_SERVER_NAME]
    )
    expect(claude.mcpServers[PLANNER_TOOLS_MCP_SERVER_NAME].args).toEqual([
      '--yes',
      '-p',
      `@attalabs/vinaya@${version}`,
      'vinaya-task-tools-serve',
      SEAT_ARGUMENT,
      'planner'
    ])
    expect(codexMcpServersToml(null).startsWith(operatorCodexTomlPublished(version))).toBe(true)
    expect(codexMcpServersToml(null)).toContain(`[mcp_servers.${PLANNER_TOOLS_MCP_SERVER_NAME}]`)
  })

  it('the Planner is registered under its own server name with its seat argument', () => {
    const planner = seatServerRegistrations(SELF_HOST).find((r) => r.serverName === PLANNER_TOOLS_MCP_SERVER_NAME)
    expect(planner?.invocation).toEqual({ command: 'bun', args: [SERVE_SOURCE, SEAT_ARGUMENT, 'planner'] })
  })

  it("the committed .mcp.json at the repository root registers the Operator's entry the generator writes", () => {
    // `.mcp.json` is a managed file: `vinaya upgrade` regenerates it, so the Planner's entry reaches the committed file there.
    const committed = JSON.parse(readFileSync(join(REPO_ROOT, '.mcp.json'), 'utf8'))
    expect(committed.mcpServers[TASK_TOOLS_MCP_SERVER_NAME]).toEqual(
      claudeMcpJsonConfig(SELF_HOST).mcpServers[TASK_TOOLS_MCP_SERVER_NAME]
    )
  })

  it('lists .mcp.json in the managed-files manifest, so upgrade owns and regenerates it', () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'vinaya.config.json'), 'utf8'))
    expect(config.managed.files).toContain('.mcp.json')
  })
})

describe('runtime version pins', () => {
  it('Claude is pinned to a live-verified Claude Code version', () => {
    expect(CLAUDE_MCP_ADAPTER.runtime).toBe('claude')
    expect(CLAUDE_MCP_ADAPTER.verifiedLiveOnAuthoringHost).toBe(true)
    expect(CLAUDE_MCP_ADAPTER.runtimeVersion).toBe('2.1.197')
    expect(CLAUDE_MCP_ADAPTER.mcpProtocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })

  it('Codex records the documented format honestly — no binary on the authoring host', () => {
    expect(CODEX_MCP_ADAPTER.runtime).toBe('codex')
    expect(CODEX_MCP_ADAPTER.verifiedLiveOnAuthoringHost).toBe(false)
    expect(CODEX_MCP_ADAPTER.runtimeVersion).toBeNull()
    expect(CODEX_MCP_ADAPTER.mcpProtocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })

  it('exposes both adapters', () => {
    expect(MCP_RUNTIME_ADAPTERS.map((a) => a.runtime)).toEqual(['claude', 'codex'])
  })
})
