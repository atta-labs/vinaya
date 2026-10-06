import { describe, expect, it } from 'bun:test'
import net from 'node:net'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseBridgeArgs } from '../../../src/lib/task-tools/dev-tools-bridge.js'
import { startDevToolsHost } from '../../../src/lib/task-tools/dev-tools-host.js'
import { devToolsSocketPath } from '../../../src/lib/task-tools/dev-tools-registration.js'
import {
  createDevToolsMcpServer,
  DEV_TOOL_NAMES,
  DEV_TOOLS_MCP_SERVER_NAME,
  dispatchDevTool,
  type DevToolContext
} from '../../../src/lib/task-tools/dev-tools-server.js'

/**
 * The driver-run dev-tools server (O1–O3): the six tools over the shared wire
 * protocol, every gate behind a `DevToolContext` callback so a fixture fakes the
 * callbacks and the protocol/refusal channel is exercised for real. The last
 * block drives the server over a REAL unix socket — the same transport the
 * driver hosts it on — proving the socket path the bridge connects to works end
 * to end, in process, without a vendor agent.
 */

function okContext(overrides: Partial<DevToolContext> = {}): DevToolContext {
  return {
    publishChanges: async (header) => ({ ok: true, result: { pushedHead: `head-for-${header.slice(0, 4)}` } }),
    openPullRequest: async () => ({ ok: true, result: { prNumber: 42 } }),
    updatePullRequestBody: async () => ({ ok: true, result: { prNumber: 42 } }),
    refreshEvidence: async () => ({ ok: true, result: { head: 'abc123', checksPassed: true, evidence: 'EV' } }),
    readPullRequest: async () => ({
      ok: true,
      result: { prNumber: 42, state: 'OPEN', head: 'abc123', checks: [], reviews: [], body: 'body', failedChecks: [] }
    }),
    runChecks: async () => ({ ok: true, result: { passed: true, output: 'all green' } }),
    ...overrides
  }
}

function server(context: DevToolContext) {
  return createDevToolsMcpServer({ serverVersion: '0.0.0-test', context })
}

async function call(srv: ReturnType<typeof server>, name: string, args: unknown = {}) {
  const line = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })
  const resp = await srv.handleLine(line)
  expect(resp).not.toBeNull()
  return JSON.parse(resp as string)
}

describe('dev-tools server — catalog and protocol', () => {
  it('tools/list returns exactly the six tools, each with an input schema', async () => {
    const srv = server(okContext())
    const resp = await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    const parsed = JSON.parse(resp as string)
    const names = parsed.result.tools.map((t: { name: string }) => t.name)
    expect(names.sort()).toEqual([...DEV_TOOL_NAMES].sort())
    for (const tool of parsed.result.tools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('initialize reports the dev-tools server name', async () => {
    const srv = server(okContext())
    const resp = await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
    const parsed = JSON.parse(resp as string)
    expect(parsed.result.serverInfo.name).toBe(DEV_TOOLS_MCP_SERVER_NAME)
  })
})

describe('dev-tools server — success and refusal both land on the agent', () => {
  it('publish_changes success returns the pushed head with isError false', async () => {
    const parsed = await call(server(okContext()), 'publish_changes', { header: 'Fix: x' })
    expect(parsed.result.isError).toBe(false)
    expect(parsed.result.structuredContent.pushedHead).toBe('head-for-Fix:')
  })

  it('a gate refusal rides the error channel, naming the check, its output and the fix', async () => {
    const context = okContext({
      publishChanges: async () => ({
        ok: false,
        error: {
          check: 'pre-push-hook',
          output: 'aeg-core: 1 fail',
          fix: 'Fix the failing test, then publish_changes again.'
        }
      })
    })
    const parsed = await call(server(context), 'publish_changes', { header: 'Fix: x' })
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error.check).toBe('pre-push-hook')
    expect(parsed.result.structuredContent.error.output).toContain('1 fail')
    expect(parsed.result.structuredContent.error.fix).toContain('publish_changes')
  })

  it('a missing required argument is a tool-input refusal, never a thrown error', async () => {
    const parsed = await call(server(okContext()), 'publish_changes', {})
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error.check).toBe('tool-input')
  })

  it('an unknown tool name refuses, listing the real tools', async () => {
    const parsed = await call(server(okContext()), 'merge_pull_request')
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error.check).toBe('unknown-tool')
  })

  it('a handler that throws becomes an infrastructure error, never an uncaught rejection', async () => {
    const context = okContext({
      runChecks: async () => {
        throw new Error('check runner crashed')
      }
    })
    const parsed = await call(server(context), 'run_checks')
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error.message).toContain('check runner crashed')
  })
})

describe('dispatchDevTool — direct dispatch of each tool', () => {
  it('routes every catalog tool to its context method', async () => {
    const context = okContext()
    for (const name of DEV_TOOL_NAMES) {
      const args =
        name === 'publish_changes'
          ? { header: 'Fix: y' }
          : name === 'open_pull_request'
            ? { title: 't', body: 'b' }
            : name === 'update_pull_request_body'
              ? { body: 'b' }
              : {}
      const result = await dispatchDevTool(context, name, args)
      expect(result.ok).toBe(true)
    }
  })
})

describe('dev-tools host — a real unix socket is the driver transport', () => {
  it('answers initialize and a tool call over a socket connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-tools-host-'))
    const socketPath = join(dir, 'driver.sock')
    const host = await startDevToolsHost({ socketPath, serverVersion: '0.0.0-test', context: okContext() })
    try {
      const responses = await driveOverSocket(socketPath, [
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_checks', arguments: {} } }
      ])
      const init = responses[0]?.result as { serverInfo?: { name?: string } } | undefined
      const call = responses[1]?.result as { isError?: boolean; structuredContent?: { passed?: boolean } } | undefined
      expect(init?.serverInfo?.name).toBe(DEV_TOOLS_MCP_SERVER_NAME)
      expect(call?.isError).toBe(false)
      expect(call?.structuredContent?.passed).toBe(true)
    } finally {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates the socket owner-only (0600) inside an owner-only private directory (0700)', async () => {
    const socketPath = devToolsSocketPath('mode-test:owner/repo:tranche/1')
    const socketDir = dirname(socketPath)
    // A clean slate so the host itself, not a prior run, creates the directory.
    rmSync(socketDir, { recursive: true, force: true })
    const host = await startDevToolsHost({ socketPath, serverVersion: '0.0.0-test', context: okContext() })
    try {
      expect(statSync(socketDir).mode & 0o777).toBe(0o700)
      expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    } finally {
      await host.close()
      rmSync(socketDir, { recursive: true, force: true })
    }
  })
})

describe('bridge argument parsing', () => {
  it('reads --socket <path>', () => {
    expect(parseBridgeArgs(['--socket', '/tmp/x.sock'])).toEqual({ socketPath: '/tmp/x.sock' })
  })
  it('refuses a missing --socket', () => {
    const parsed = parseBridgeArgs([])
    expect('error' in parsed).toBe(true)
  })
})

/** Sends each message as one newline-delimited line, collecting one response per message. */
function driveOverSocket(socketPath: string, messages: unknown[]): Promise<Array<{ result: Record<string, unknown> }>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    const out: Array<{ result: Record<string, unknown> }> = []
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => {
      for (const msg of messages) socket.write(`${JSON.stringify(msg)}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim().length > 0) out.push(JSON.parse(line))
        if (out.length === messages.length) {
          socket.end()
          resolve(out)
          return
        }
        idx = buffer.indexOf('\n')
      }
    })
  })
}
