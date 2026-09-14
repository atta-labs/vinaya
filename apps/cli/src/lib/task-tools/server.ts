/**
 * The shared, transport-agnostic task-tool surface (O1) — the ONE place the
 * catalog (`@attalabs/aeg-core`'s `TASK_TOOL_CATALOG`) is bound to the CLI-side
 * handlers (`handlers.ts` for the reads and refusing stubs; `start.ts` for
 * `task_start`), and the ONE place the MCP wire protocol is spoken. Both
 * runtime adapters (`adapters.ts`: Claude's `.mcp.json`, Codex's `[mcp_servers]`
 * TOML) register the SAME server command; they differ only in the registration
 * file format, never in the protocol or the tools exposed. So a fixture that
 * drives this server over stdio proves both adapters at once — each adapter's
 * declared command is this server, and this server is what a client discovers
 * against.
 *
 * MCP is a transport, not authorization (the catalog's own module doc, and
 * this task's own traps): the wire layer here NEVER reads a caller's identity
 * from a tool-call argument. Authority is a property of the invocation
 * context — the environment this server was started in — carried as
 * `CallerContext` and handed to every handler, which is what lets `task_start`
 * refuse a call with no authenticated caller (O2) while a read tool ignores it.
 *
 * Protocol version pinned at `2025-06-18` (modelcontextprotocol.io server/tools
 * spec) — the version both adapters were verified against, recorded alongside
 * each runtime's own version in `apps/cli/specs/self-hosting.md`. The stdio
 * transport is newline-delimited JSON-RPC 2.0: one message per line, no
 * embedded newlines, UTF-8 — implemented directly here rather than pulling in
 * an MCP SDK, so the change adds no dependency and every protocol fixture runs
 * hermetically against real framing (this task's PR body records that decision).
 */

import {
  isTaskToolName,
  TASK_TOOL_CATALOG,
  type TaskToolDefinition,
  type TaskToolError,
  type TaskToolName,
  taskToolError
} from '@attalabs/aeg-core'
import { type Readable, Writable } from 'node:stream'
import type { TaskToolCallResult } from './handlers.js'
import { taskCancelHandler, taskEscalationReadHandler, taskResumeHandler, taskStatusHandler } from './handlers.js'
import { defaultTaskStartHandler } from './start.js'

/** The MCP spec revision this server implements and both adapters were verified against. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** The one MCP server name both adapters register — the key under `mcpServers`/`[mcp_servers.<name>]`. */
export const TASK_TOOLS_MCP_SERVER_NAME = 'vinaya-task-tools'

// --- caller context (authority lives in the transport, never in an argument) -

/**
 * The authenticated caller resolved from the INVOCATION CONTEXT — never from a
 * tool-call argument (a caller's own claim about who it is authenticates
 * nothing). `null` means the context carried no caller, which is the safe
 * default: `task_start` refuses, the reads still answer.
 */
export type Caller = { id: string }
export type CallerContext = { caller: Caller | null }

/** The env var an attended operator's session exports to authenticate itself to the server (O2). Absent → no caller → `task_start` refuses. */
export const CALLER_ENV_VAR = 'VINAYA_MCP_CALLER'

/** Resolves the caller from an environment map — the transport's own identity, read once at server start, never per call from arguments. */
export function resolveCallerFromEnv(env: Record<string, string | undefined>): CallerContext {
  const raw = env[CALLER_ENV_VAR]
  const id = typeof raw === 'string' ? raw.trim() : ''
  return { caller: id.length > 0 ? { id } : null }
}

// --- the bound handler surface ----------------------------------------------

/** Every handler takes the validated-or-not input and the caller context; reads ignore the context, `task_start` requires it. */
export type ToolHandler = (
  input: unknown,
  ctx: CallerContext
) => TaskToolCallResult<unknown> | Promise<TaskToolCallResult<unknown>>

export type TaskToolHandlers = Record<TaskToolName, ToolHandler>

/**
 * The default binding: the two read tools and the two still-refusing mutating
 * stubs (`task_resume`/`task_cancel`) from `handlers.ts`, and the real
 * caller-context-aware `task_start` from `start.ts`. This is the single wiring
 * point O1 names — a catalog tool with no entry here is a type error, not a
 * silent gap.
 */
export const defaultTaskToolHandlers: TaskToolHandlers = {
  task_status: (input) => taskStatusHandler(input),
  task_escalation_read: (input) => taskEscalationReadHandler(input),
  task_resume: (input) => taskResumeHandler(input),
  task_cancel: (input) => taskCancelHandler(input),
  task_start: (input, ctx) => defaultTaskStartHandler(input, ctx)
}

/**
 * Routes one tool call to its handler — refusing any name not in the catalog
 * BEFORE a handler runs (O3: a forbidden tool name reaches no effect). Every
 * other refusal (malformed input, absent caller, unknown run) is the handler's
 * own typed `TaskToolError`, returned unchanged.
 */
export async function dispatchToolCall(
  handlers: TaskToolHandlers,
  name: string,
  input: unknown,
  ctx: CallerContext
): Promise<TaskToolCallResult<unknown>> {
  if (!isTaskToolName(name)) {
    return { ok: false, error: taskToolError('validation', `no such task tool: ${JSON.stringify(name)}`) }
  }
  return handlers[name](input, ctx)
}

// --- tool input JSON Schemas (the wire needs JSON Schema, the catalog is Zod) -

const TASK_REF_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: { tranche: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } },
      required: ['tranche', 'id'],
      additionalProperties: false
    },
    {
      type: 'object',
      properties: { issue: { type: 'integer', minimum: 1 } },
      required: ['issue'],
      additionalProperties: false
    }
  ]
} as const

const CURSOR_LIMIT_PROPS = {
  cursor: { type: 'string' },
  limit: { type: 'integer', minimum: 1, maximum: 100 }
} as const

/**
 * One JSON Schema per catalog tool — the shape MCP `tools/list` requires,
 * hand-authored here (Zod 3 ships no JSON-Schema exporter) and kept beside the
 * transport, so `aeg-core` stays a pure Zod catalog. A test asserts every
 * catalog name has an entry here, so the two never drift.
 */
export const TASK_TOOL_INPUT_JSON_SCHEMAS: Record<TaskToolName, Record<string, unknown>> = {
  task_start: {
    type: 'object',
    properties: { tranche: { type: 'string', minLength: 1 }, id: { type: 'string', minLength: 1 } },
    required: ['tranche', 'id'],
    additionalProperties: false
  },
  task_status: {
    type: 'object',
    properties: { task: TASK_REF_JSON_SCHEMA, ...CURSOR_LIMIT_PROPS },
    additionalProperties: false
  },
  task_escalation_read: {
    type: 'object',
    properties: { task: TASK_REF_JSON_SCHEMA, ...CURSOR_LIMIT_PROPS },
    required: ['task'],
    additionalProperties: false
  },
  task_resume: {
    type: 'object',
    properties: { task: TASK_REF_JSON_SCHEMA },
    required: ['task'],
    additionalProperties: false
  },
  task_cancel: {
    type: 'object',
    properties: { task: TASK_REF_JSON_SCHEMA, reason: { type: 'string', minLength: 1 } },
    required: ['task', 'reason'],
    additionalProperties: false
  }
}

/** The `tools/list` entry for one catalog tool — name, a description composed from the catalog's own purpose + boundaries, and the tool's JSON-Schema input. */
export function toolListEntry(def: TaskToolDefinition): {
  name: string
  description: string
  inputSchema: Record<string, unknown>
} {
  return {
    name: def.name,
    description: `${def.purpose}\n\n${def.boundaries}`,
    inputSchema: TASK_TOOL_INPUT_JSON_SCHEMAS[def.name]
  }
}

// --- JSON-RPC 2.0 message handling ------------------------------------------

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown }

function rpcResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } })
}

/** The MCP `tools/call` result shape for one handler outcome — the structured value in both `content` (text) and `structuredContent`, `isError` set on a refusal. */
function toolCallResult(outcome: TaskToolCallResult<unknown>): Record<string, unknown> {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: false
    }
  }
  const error: TaskToolError = outcome.error
  return {
    content: [{ type: 'text', text: JSON.stringify(error) }],
    structuredContent: { error },
    isError: true
  }
}

export type TaskToolsMcpServer = {
  /**
   * Handles one already-parsed-or-raw JSON-RPC message line. Returns the
   * response line to write, or `null` for a notification (no response) and for
   * a blank line. Never throws — a malformed line becomes a JSON-RPC parse
   * error response, exactly as the spec requires.
   */
  handleLine: (line: string) => Promise<string | null>
  /** Wires `handleLine` to a newline-delimited stdio pair for the CLI subcommand. */
  serve: (input: Readable, output: Writable) => Promise<void>
}

export type CreateTaskToolsMcpServerOptions = {
  serverVersion: string
  handlers?: TaskToolHandlers
  callerContext?: CallerContext
}

/**
 * Builds the server over an explicit handler set and caller context — both
 * injectable so a fixture can drive the real protocol with recording handlers
 * (O3) while the CLI subcommand wires the production defaults.
 */
export function createTaskToolsMcpServer(opts: CreateTaskToolsMcpServerOptions): TaskToolsMcpServer {
  const handlers = opts.handlers ?? defaultTaskToolHandlers
  const ctx = opts.callerContext ?? { caller: null }

  async function handle(msg: JsonRpcRequest): Promise<string | null> {
    const id: JsonRpcId = msg.id === undefined ? null : msg.id
    const isNotification = msg.id === undefined
    const method = typeof msg.method === 'string' ? msg.method : null

    if (method === null) {
      return isNotification ? null : rpcError(id, -32600, 'Invalid Request: missing method')
    }

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: TASK_TOOLS_MCP_SERVER_NAME, version: opts.serverVersion }
        })
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools: TASK_TOOL_CATALOG.map((def) => toolListEntry(def)) })
      case 'tools/call': {
        const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as {
          name?: unknown
          arguments?: unknown
        }
        if (typeof params.name !== 'string') {
          return rpcError(id, -32602, 'Invalid params: tools/call requires a string `name`')
        }
        const outcome = await dispatchToolCall(handlers, params.name, params.arguments ?? {}, ctx)
        return rpcResult(id, toolCallResult(outcome))
      }
      default:
        // Every `notifications/*` message (initialized, cancelled, …) is a
        // notification with no response; any other unknown method with an id
        // is a real method-not-found error.
        if (isNotification || method.startsWith('notifications/')) return null
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }

  async function handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim()
    if (trimmed.length === 0) return null
    let parsed: JsonRpcRequest
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      return rpcError(null, -32700, 'Parse error')
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return rpcError(null, -32600, 'Invalid Request')
    }
    return handle(parsed)
  }

  async function serve(input: Readable, output: Writable): Promise<void> {
    let buffer = ''
    input.setEncoding('utf8')
    // Sequential per line: an interleaved response order would still be legal
    // JSON-RPC (ids match), but a strictly ordered writer keeps the fixture's
    // reads simple and the transport easy to reason about.
    let chain: Promise<void> = Promise.resolve()
    const write = (s: string) => {
      chain = chain.then(
        () =>
          new Promise<void>((resolve) => {
            output.write(`${s}\n`, () => resolve())
          })
      )
      return chain
    }

    await new Promise<void>((resolve) => {
      input.on('data', (chunk: string) => {
        buffer += chunk
        let idx = buffer.indexOf('\n')
        while (idx !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          void handleLine(line).then((response) => {
            if (response !== null) void write(response)
          })
          idx = buffer.indexOf('\n')
        }
      })
      input.on('end', () => {
        void chain.then(() => resolve())
      })
      input.on('close', () => {
        void chain.then(() => resolve())
      })
    })
  }

  return { handleLine, serve }
}

/**
 * Runs the production server on this process's stdio (the `vinaya task tools
 * serve` entry point). The one non-obvious property it guarantees: **stdout
 * carries JSON-RPC and nothing else.** Handler code reaches deep into the CLI
 * (`task_status` reads the forge, which can print a trust-anchor warning), and
 * a single stray `process.stdout.write`/`console.log` from anywhere in that
 * call tree would corrupt the protocol stream and wedge the client. So the real
 * stdout is captured for the server's own writes, and the global
 * `process.stdout.write` is redirected to stderr for the process's lifetime —
 * every stray write becomes harmless diagnostic output on stderr, never a
 * malformed protocol frame. `serverVersion` is passed in (never imported from
 * `artifacts.ts` here) to keep this module free of the `artifacts → adapters →
 * server` import cycle.
 */
export async function serveTaskToolsStdio(serverVersion: string): Promise<void> {
  const realStdoutWrite = process.stdout.write.bind(process.stdout)
  const protocolOut = new Writable({
    write(chunk, _encoding, callback) {
      realStdoutWrite(chunk as string | Uint8Array)
      callback()
    }
  })
  // Any other stdout write (a library warning, a stray console.log) goes to
  // stderr from here on, so it can never land in the JSON-RPC stream.
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write

  const server = createTaskToolsMcpServer({
    serverVersion,
    callerContext: resolveCallerFromEnv(process.env)
  })
  await server.serve(process.stdin, protocolOut)
}
