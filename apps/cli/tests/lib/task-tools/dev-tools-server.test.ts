import { describe, expect, it } from 'bun:test'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseBridgeArgs, withDispatchCapability } from '../../../src/lib/task-tools/dev-tools-bridge.js'
import {
  createDispatchCapabilityTable,
  type DispatchCapabilityTable,
  startDevToolsHost
} from '../../../src/lib/task-tools/dev-tools-host.js'
import { devToolsSocketPath, driverDevBridgeInvocation } from '../../../src/lib/task-tools/dev-tools-registration.js'
import {
  type CapabilityRefusalEvent,
  createDevToolsMcpServer,
  DEV_TOOL_NAMES,
  DEV_TOOLS_MCP_SERVER_NAME,
  DISPATCH_CAPABILITY_ARGUMENT,
  devToolError,
  dispatchDevTool,
  type DevToolContext
} from '../../../src/lib/task-tools/dev-tools-server.js'
import { stripVinayaEnv } from '../process-fixture.js'

/**
 * The driver-run dev-tools server (O1–O3): the seven tools over the shared wire
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
    fetchDocumentation: async (input) => ({
      ok: true,
      result: {
        notice: 'untrusted',
        untrusted: true,
        requestedUrl: input.url,
        finalUrl: input.url,
        status: 200,
        contentType: 'text/html',
        size: 2000,
        sha256: 'ab',
        receipt: { recorded: true, sourceId: input.url, revision: 'match', decision: 'counted' },
        offset: 0,
        nextOffset: null,
        text: 'page'
      }
    }),
    ...overrides
  }
}

function server(context: DevToolContext) {
  return createDevToolsMcpServer({ serverVersion: '0.0.0-test', context, role: 'developer' })
}

async function call(srv: ReturnType<typeof server>, name: string, args: unknown = {}) {
  const line = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } })
  const resp = await srv.handleLine(line)
  expect(resp).not.toBeNull()
  return JSON.parse(resp as string)
}

describe('dev-tools server — catalog and protocol', () => {
  it('tools/list returns exactly the seven tools, each with an input schema', async () => {
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
        error: devToolError(
          'policy_refusal',
          'same_attempt',
          'not_committed',
          'pre-push-hook',
          'aeg-core: 1 fail',
          'Fix the failing test, then publish_changes again.'
        )
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
    expect(parsed.result.structuredContent.error).toMatchObject({
      errorClass: 'invalid_input',
      retryDisposition: 'same_attempt',
      effectState: 'not_started'
    })
  })

  it('re-validates strict catalog arguments at execution time', async () => {
    const parsed = await call(server(okContext()), 'run_checks', { advertisedOnly: true })
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error).toMatchObject({
      errorClass: 'invalid_input',
      retryDisposition: 'same_attempt',
      effectState: 'not_started'
    })
  })

  it('refuses a success value outside the catalog output schema', async () => {
    const context = okContext({ runChecks: async () => ({ ok: true, result: { passed: true } as never }) })
    const parsed = await call(server(context), 'run_checks')
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error).toMatchObject({ errorClass: 'internal', effectState: 'uncertain' })
  })

  it('a tool outside the Developer grant refuses unauthorized, listing the granted tools', async () => {
    const parsed = await call(server(okContext()), 'merge_pull_request')
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error).toMatchObject({
      errorClass: 'unauthorized',
      retryDisposition: 'never',
      effectState: 'not_started',
      check: 'role-grant'
    })
    expect(parsed.result.structuredContent.error.fix).toContain('publish_changes')
  })

  it('a handler that throws becomes an infrastructure error, never an uncaught rejection', async () => {
    const context = okContext({
      runChecks: async () => {
        throw new Error('check runner crashed')
      }
    })
    const parsed = await call(server(context), 'run_checks')
    expect(parsed.result.isError).toBe(true)
    expect(parsed.result.structuredContent.error).toMatchObject({
      errorClass: 'internal',
      retryDisposition: 'new_attempt',
      effectState: 'uncertain',
      check: 'tool-execution'
    })
    expect(parsed.result.structuredContent.error.output).toContain('check runner crashed')
    expect(parsed.result.structuredContent.error.fix).toContain('reconcile')
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
              : name === 'fetch_documentation'
                ? { url: 'https://example.com/docs' }
                : {}
      const result = await dispatchDevTool(context, 'developer', name, args)
      expect(result.ok).toBe(true)
    }
  })
})

describe('dispatch capability', () => {
  /** A table whose clock is fixed and whose peer `pid` is inside a dispatch only when it is the launched process. */
  function table(clock = { now: 1_000 }) {
    return createDispatchCapabilityTable({ now: () => clock.now, descendsFrom: (pid, ancestor) => pid === ancestor })
  }

  /** Dispatches `run_checks` carrying `supplied` from peer `peerPid`, collecting each audit event. */
  async function callFrom(capabilities: DispatchCapabilityTable, supplied: string | undefined, peerPid: number | null) {
    const events: CapabilityRefusalEvent[] = []
    const result = await dispatchDevTool(
      okContext(),
      'developer',
      'run_checks',
      supplied === undefined ? {} : { [DISPATCH_CAPABILITY_ARGUMENT]: supplied },
      { verify: (value) => capabilities.verify(value, peerPid), audit: (event) => events.push(event) }
    )
    return { result, events }
  }

  it('refuses a missing capability and audits it, naming the role and the tool', async () => {
    const { result, events } = await callFrom(table(), undefined, 4100)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ check: 'dispatch-capability', errorClass: 'unauthorized' })
    expect(events).toEqual([
      { role: 'developer', tool: 'run_checks', reason: 'missing', detail: 'the call carried no capability' }
    ])
  })

  it('refuses an expired capability', async () => {
    const clock = { now: 1_000 }
    const capabilities = table(clock)
    const value = capabilities.mint(60_000)
    capabilities.bind(value, 4100)
    clock.now += 60_000
    const { events } = await callFrom(capabilities, value, 4100)
    expect(events.map((event) => event.reason)).toEqual(['expired'])
  })

  it('refuses a revoked capability: its dispatch has ended', async () => {
    const capabilities = table()
    const value = capabilities.mint(60_000)
    capabilities.bind(value, 4100)
    capabilities.revoke(value)
    const { events } = await callFrom(capabilities, value, 4100)
    expect(events.map((event) => event.reason)).toEqual(['revoked'])
  })

  it("refuses a capability replayed from outside its dispatch, from another role's host, or never bound", async () => {
    const own = table()
    const other = table()
    const value = own.mint(60_000)
    own.bind(value, 4100)
    const foreign = other.mint(60_000)
    other.bind(foreign, 4200)
    const unbound = own.mint(60_000)
    const outside = await callFrom(own, value, 4999)
    const otherRole = await callFrom(own, foreign, 4200)
    const notLaunched = await callFrom(own, unbound, 4100)
    const unreadPeer = await callFrom(own, value, null)
    for (const { result, events } of [outside, otherRole, notLaunched, unreadPeer]) {
      expect(result.ok).toBe(false)
      expect(events.map((event) => event.reason)).toEqual(['replayed'])
    }
    expect(outside.events[0]?.detail).toContain('peer process 4999 is outside the dispatch launched as process 4100')
  })

  it('checks the capability before the role grant and before argument validation', async () => {
    const events: CapabilityRefusalEvent[] = []
    const ungranted = await dispatchDevTool(
      okContext(),
      'code-reviewer',
      'publish_changes',
      { header: 42 },
      {
        verify: () => ({ reason: 'missing', detail: 'none' }),
        audit: (event) => events.push(event)
      }
    )
    expect(ungranted.ok).toBe(false)
    if (!ungranted.ok) expect(ungranted.error.check).toBe('dispatch-capability')
    expect(events.map((event) => event.tool)).toEqual(['publish_changes'])
  })

  it('serves its own dispatch and removes the capability before the strict argument check', async () => {
    const capabilities = table()
    const value = capabilities.mint(60_000)
    capabilities.bind(value, 4100)
    const { result, events } = await callFrom(capabilities, value, 4100)
    expect(result.ok).toBe(true)
    expect(events).toEqual([])
  })

  it('a host without a capability table serves its single caller as before', async () => {
    const result = await dispatchDevTool(okContext(), 'developer', 'run_checks', {})
    expect(result.ok).toBe(true)
  })
})

describe('the bridge carries the capability into every tool call', () => {
  it('adds the capability to a tools/call and leaves every other message as it is', () => {
    const call = JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_checks' } })
    expect(JSON.parse(withDispatchCapability(call, 'cap-1')).params).toEqual({
      name: 'run_checks',
      arguments: { [DISPATCH_CAPABILITY_ARGUMENT]: 'cap-1' }
    })
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(withDispatchCapability(init, 'cap-1')).toBe(init)
    expect(withDispatchCapability('not json', 'cap-1')).toBe('not json')
  })

  it("puts the capability into the bridge invocation the agent's registration names", () => {
    expect(driverDevBridgeInvocation('/s.sock', '/cli.ts', 'cap-1').args).toEqual([
      '/cli.ts',
      'task-tools',
      'dev-bridge',
      '--socket',
      '/s.sock',
      '--capability',
      'cap-1'
    ])
    expect(driverDevBridgeInvocation('/s.sock', '/cli.ts').args).not.toContain('--capability')
  })
})

describe('dev-tools host — a real unix socket is the driver transport', () => {
  it('answers initialize and a tool call over a socket connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-tools-host-'))
    const socketPath = join(dir, 'driver.sock')
    const host = await startDevToolsHost({
      socketPath,
      serverVersion: '0.0.0-test',
      context: okContext(),
      role: 'developer'
    })
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

  it('serves a call only with a live capability of a dispatch the connecting peer belongs to, auditing each refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-tools-host-peer-'))
    const socketPath = join(dir, 'driver.sock')
    const capabilities = createDispatchCapabilityTable()
    const events: CapabilityRefusalEvent[] = []
    const host = await startDevToolsHost({
      socketPath,
      serverVersion: '0.0.0-test',
      context: okContext(),
      role: 'developer',
      capabilities,
      audit: (event) => events.push(event)
    })
    // This test process connects, so a dispatch launched as this process holds it; one launched as another does not.
    const own = capabilities.mint(60_000)
    capabilities.bind(own, process.pid)
    const elsewhere = spawn('sleep', ['30'], { env: stripVinayaEnv(), stdio: 'ignore' })
    const foreign = capabilities.mint(60_000)
    capabilities.bind(foreign, elsewhere.pid as number)
    const ended = capabilities.mint(60_000)
    capabilities.bind(ended, process.pid)
    capabilities.revoke(ended)
    try {
      const call = (id: number, supplied?: string) => ({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'run_checks',
          arguments: supplied === undefined ? {} : { [DISPATCH_CAPABILITY_ARGUMENT]: supplied }
        }
      })
      const responses = await driveOverSocket(socketPath, [
        call(1, own),
        call(2),
        call(3, foreign),
        call(4, ended),
        call(5, 'forged')
      ])
      const outcomes = responses.map((response) => {
        const result = response.result as { isError?: boolean; structuredContent?: { error?: { check?: string } } }
        return result.isError ? result.structuredContent?.error?.check : 'served'
      })
      expect(outcomes).toEqual([
        'served',
        'dispatch-capability',
        'dispatch-capability',
        'dispatch-capability',
        'dispatch-capability'
      ])
      expect(events.map((event) => `${event.role}:${event.tool}:${event.reason}`)).toEqual([
        'developer:run_checks:missing',
        'developer:run_checks:replayed',
        'developer:run_checks:revoked',
        'developer:run_checks:replayed'
      ])
    } finally {
      elsewhere.kill('SIGKILL')
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves the bridge a dispatch launched, carrying its capability; the same bridge without it is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-tools-host-bridge-'))
    const socketPath = join(dir, 'driver.sock')
    const capabilities = createDispatchCapabilityTable()
    const events: CapabilityRefusalEvent[] = []
    const host = await startDevToolsHost({
      socketPath,
      serverVersion: '0.0.0-test',
      context: okContext(),
      role: 'developer',
      capabilities,
      audit: (event) => events.push(event)
    })
    // The bridge is a child of this process, as an agent's bridge is a descendant of the launch its dispatch made.
    const capability = capabilities.mint(60_000)
    capabilities.bind(capability, process.pid)
    try {
      const carried = await throughBridge(driverDevBridgeInvocation(socketPath, CLI_ENTRY, capability))
      const bare = await throughBridge(driverDevBridgeInvocation(socketPath, CLI_ENTRY))
      expect(carried.isError).toBe(false)
      expect(bare.isError).toBe(true)
      expect(events.map((event) => event.reason)).toEqual(['missing'])
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
    const host = await startDevToolsHost({
      socketPath,
      serverVersion: '0.0.0-test',
      context: okContext(),
      role: 'developer'
    })
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
  it('reads the --capability <value> a dispatch carries', () => {
    expect(parseBridgeArgs(['--socket', '/tmp/x.sock', '--capability', 'cap-1'])).toEqual({
      socketPath: '/tmp/x.sock',
      capability: 'cap-1'
    })
  })
  it('refuses a missing --socket', () => {
    const parsed = parseBridgeArgs([])
    expect('error' in parsed).toBe(true)
  })
  it('refuses an empty --capability', () => {
    expect('error' in parseBridgeArgs(['--socket', '/tmp/x.sock', '--capability'])).toBe(true)
  })
})

const CLI_ENTRY = join(import.meta.dir, '../../../src/index.ts')

/** Runs the real bridge, sends initialize and one `run_checks` call through it, and returns the call's result. */
function throughBridge(bridge: { command: string; args: string[] }): Promise<{ isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bridge.command, bridge.args, { env: stripVinayaEnv(), stdio: ['pipe', 'pipe', 'inherit'] })
    let buffer = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('the bridge returned no tool result'))
    }, 20_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (const line of buffer.split('\n')) {
        if (line.trim().length === 0) continue
        let message: { id?: number; result?: { isError?: boolean } }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 2 && message.result) {
          clearTimeout(timeout)
          child.stdin.end()
          resolve(message.result)
          return
        }
      }
    })
    child.on('error', reject)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_checks', arguments: {} } })}\n`
    )
  })
}

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
