import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VendoredVinaya } from '../../../src/lib/self-host.js'
import { claudeMcpJsonConfig, codexMcpServersToml } from '../../../src/lib/task-tools/adapters.js'
import { TASK_TOOLS_MCP_SERVER_NAME } from '../../../src/lib/task-tools/server.js'

/**
 * Protocol-level fixtures (O3): a REAL JSON-RPC client drives the shared server
 * over real stdio, spawned via the exact command the Claude adapter's `.mcp.json`
 * declares — and asserted identical to the Codex adapter's TOML — so both
 * adapters are proven at once. It discovers the five tools, calls `task_status`
 * and `task_start` end to end, and is refused on malformed input, an unknown
 * run, a duplicate start, and a tool not in the catalog. A separate scenario
 * proves a disconnect leaves no second run.
 *
 * Hermetic: a fake `gh` (empty issue list), `AEG_REPO`, an isolated `HOME` (the
 * durable task-start store), an authenticated caller in the environment, and a
 * recording launcher in place of a real detached `vinaya task run` — so the
 * transport, discovery, dispatch, validation, idempotency and disconnect are
 * all real, while the deep `runTask`/forge integration (tested elsewhere) is
 * stubbed at the process boundary.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')
const ABS_BIN = join(REPO_ROOT, 'apps', 'cli', 'dist', 'index.js')
const SELF_HOST: VendoredVinaya = { dir: 'apps/cli', bin: ABS_BIN } as VendoredVinaya

const CALLER = 'operator-1'

let sandbox: string
let launchFile: string
let baseEnv: Record<string, string>

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'vinaya-task-tools-protocol-'))
  const binDir = join(sandbox, 'bin')
  const home = join(sandbox, 'home')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  launchFile = join(sandbox, 'launches.log')

  // Fake gh: an empty issue list is all task_status's forge read needs.
  const gh = join(binDir, 'gh')
  writeFileSync(gh, "#!/bin/sh\necho '[]'\n", { mode: 0o755 })
  chmodSync(gh, 0o755)

  // Recording launcher: stands in for a real detached `vinaya task run`.
  const launcher = join(binDir, 'record-launch')
  writeFileSync(launcher, '#!/bin/sh\necho "launch $*" >> "$VINAYA_TEST_LAUNCH_FILE"\n', { mode: 0o755 })
  chmodSync(launcher, 0o755)

  baseEnv = {
    ...process.env,
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    AEG_REPO: 'attalabs/vinaya',
    VINAYA_MCP_CALLER: CALLER,
    VINAYA_TASK_RUN_COMMAND: launcher,
    VINAYA_TEST_LAUNCH_FILE: launchFile
  }
})

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

// --- a minimal real JSON-RPC stdio client -----------------------------------

type RpcResult = { result?: Record<string, unknown>; error?: { code: number; message: string } }

class RpcClient {
  private proc: ChildProcess
  private stdin: NodeJS.WritableStream
  private buffer = ''
  private pending = new Map<number, (value: RpcResult) => void>()
  private nextId = 1

  constructor(env: Record<string, string>) {
    const server = claudeMcpJsonConfig(SELF_HOST).mcpServers[TASK_TOOLS_MCP_SERVER_NAME]!
    this.proc = spawn(server.command, server.args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    this.stdin = this.proc.stdin!
    const stdout = this.proc.stdout!
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim()
        this.buffer = this.buffer.slice(idx + 1)
        if (line.length > 0) {
          const msg = JSON.parse(line) as { id?: number } & RpcResult
          if (typeof msg.id === 'number') {
            const resolve = this.pending.get(msg.id)
            if (resolve) {
              this.pending.delete(msg.id)
              resolve({ result: msg.result, error: msg.error })
            }
          }
        }
        idx = this.buffer.indexOf('\n')
      }
    })
  }

  request(method: string, params?: unknown): Promise<RpcResult> {
    const id = this.nextId++
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 15_000)
      this.pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      this.stdin.write(line)
    })
  }

  async callTool(name: string, args: unknown): Promise<{ isError: boolean; structured: Record<string, unknown> }> {
    const res = await this.request('tools/call', { name, arguments: args })
    const result = res.result as { isError?: boolean; structuredContent?: Record<string, unknown> }
    return { isError: Boolean(result?.isError), structured: result?.structuredContent ?? {} }
  }

  close(): void {
    try {
      this.stdin.end()
    } catch {
      // ignore
    }
    this.proc.kill('SIGKILL')
  }
}

async function launchCountFor(id: string): Promise<number> {
  // The launcher is a detached child; poll briefly for its append.
  for (let i = 0; i < 40; i++) {
    try {
      const lines = readFileSync(launchFile, 'utf8')
        .split('\n')
        .filter((l) => l.includes(`serve ${id}`) || l.endsWith(` ${id}`))
      if (lines.length > 0) return lines.length
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return 0
}

// --- shared-server cases -----------------------------------------------------

describe('task-tools MCP server — protocol fixtures on the adapter command', () => {
  let client: RpcClient

  beforeAll(async () => {
    client = new RpcClient(baseEnv)
    await client.request('initialize', {})
  })

  afterAll(() => {
    client?.close()
  })

  it('the Claude and Codex adapters register the identical command', () => {
    const claude = claudeMcpJsonConfig(SELF_HOST).mcpServers[TASK_TOOLS_MCP_SERVER_NAME]!
    const toml = codexMcpServersToml(SELF_HOST)
    expect(toml).toContain(`command = ${JSON.stringify(claude.command)}`)
    expect(toml).toContain(`args = [${claude.args.map((a) => JSON.stringify(a)).join(', ')}]`)
  })

  it('discovers exactly the five catalog tools, each with an object input schema', async () => {
    const res = await client.request('tools/list')
    const tools = (res.result?.tools ?? []) as Array<{ name: string; inputSchema: { type?: string } }>
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['task_cancel', 'task_escalation_read', 'task_resume', 'task_start', 'task_status'].sort()
    )
    expect(tools.every((t) => t.inputSchema?.type === 'object')).toBe(true)
  })

  it('invokes task_status end to end — an empty forge yields an empty page', async () => {
    const { isError, structured } = await client.callTool('task_status', {})
    expect(isError).toBe(false)
    expect(structured).toEqual({ items: [], nextCursor: null })
  })

  it('rejects malformed input with a validation error (before any read)', async () => {
    const { isError, structured } = await client.callTool('task_status', { limit: -1 })
    expect(isError).toBe(true)
    expect((structured.error as { kind?: string })?.kind).toBe('validation')
  })

  it('rejects an unknown run with a precondition error', async () => {
    const { isError, structured } = await client.callTool('task_status', { task: { tranche: 'nope', id: '999' } })
    expect(isError).toBe(true)
    expect((structured.error as { kind?: string })?.kind).toBe('precondition')
  })

  it('rejects a tool not in the catalog, before any effect', async () => {
    const { isError, structured } = await client.callTool('task_bogus', {})
    expect(isError).toBe(true)
    expect((structured.error as { kind?: string })?.kind).toBe('validation')
  })

  it('invokes task_start end to end and returns the durable run identity, launching once', async () => {
    const { isError, structured } = await client.callTool('task_start', { tranche: 'demo', id: '1' })
    expect(isError).toBe(false)
    expect(structured.started).toBe(true)
    expect(structured.mode).toBe('attended')
    expect(structured.run).toEqual({ tranche: 'demo', id: '1' })
    expect(typeof structured.requestId).toBe('string')
    expect(await launchCountFor('1')).toBe(1)
  })

  it('is idempotent — a duplicate start returns the same run and launches nothing new', async () => {
    const first = await client.callTool('task_start', { tranche: 'demo', id: '1' })
    expect(first.structured.started).toBe(false)
    expect(await launchCountFor('1')).toBe(1)
  })
})

// --- disconnect leaves no second run ----------------------------------------

describe('task_start across a disconnect', () => {
  it('a reconnect after a disconnect replays the claim — no second run', async () => {
    const a = new RpcClient(baseEnv)
    await a.request('initialize', {})
    const started = await a.callTool('task_start', { tranche: 'demo', id: '2' })
    expect(started.structured.started).toBe(true)
    expect(await launchCountFor('2')).toBe(1)

    // Disconnect: the whole server process goes away.
    a.close()
    await new Promise((r) => setTimeout(r, 200))

    // A fresh server (same durable store) sees the same request identity.
    const b = new RpcClient(baseEnv)
    await b.request('initialize', {})
    const replay = await b.callTool('task_start', { tranche: 'demo', id: '2' })
    expect(replay.structured.started).toBe(false)
    expect(await launchCountFor('2')).toBe(1) // still exactly one run
    b.close()
  })
})
