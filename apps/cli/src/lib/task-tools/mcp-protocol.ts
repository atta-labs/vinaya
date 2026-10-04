/**
 * The transport-agnostic MCP wire protocol, factored out of `server.ts` so a
 * SECOND server — the driver-run developer tools (`dev-tools-server.ts`, O1) —
 * speaks the identical protocol without copying it. This module knows only
 * JSON-RPC 2.0 framing and the four MCP methods every server answers
 * (`initialize`, `ping`, `tools/list`, `tools/call`); it knows nothing about
 * WHICH tools a server exposes or WHO may call them. A concrete server supplies
 * its own name, version, tool list and `callTool` dispatcher through
 * `McpServerCoreOptions`, and gets back the same `{ handleLine, serve }` pair
 * `server.ts` has always returned — so every protocol fixture that drove the
 * task-tools server over newline-delimited stdio drives this one unchanged.
 *
 * The stdio transport is newline-delimited JSON-RPC 2.0: one message per line,
 * no embedded newlines, UTF-8 — implemented directly here rather than pulling in
 * an MCP SDK, so the change adds no dependency and every protocol fixture runs
 * hermetically against real framing. `serve`'s single chained promise keeps at
 * most one `handleLine` in flight at a time (the task-tools server depends on
 * that — its handlers mutate `process.env.VINAYA_TASK` for the duration of a
 * `log()` call, and two concurrent lines would race that mutation); the dev
 * tools inherit the same serialization for free.
 */

import type { Readable, Writable } from 'node:stream'

/** The `tools/list` entry one server exposes for one tool — name, description, JSON-Schema input. */
export type McpToolListEntry = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * The outcome of one `tools/call`: a serializable success value, or a
 * serializable error object. The core does not interpret `error` — it reflects
 * it into `isError: true`/`structuredContent.error` verbatim — so each server
 * keeps its own error vocabulary (the task tools' `TaskToolError`, the dev
 * tools' structured refusal).
 */
export type McpToolOutcome = { ok: true; result: unknown } | { ok: false; error: unknown }

export type McpServerCore = {
  /**
   * Handles one already-parsed-or-raw JSON-RPC message line. Returns the
   * response line to write, or `null` for a notification (no response) and for
   * a blank line. Never throws — a malformed line becomes a JSON-RPC parse
   * error response, exactly as the spec requires.
   */
  handleLine: (line: string) => Promise<string | null>
  /** Wires `handleLine` to a newline-delimited stream pair (stdio for a CLI subcommand, a socket for the driver-run server). */
  serve: (input: Readable, output: Writable) => Promise<void>
}

export type McpServerCoreOptions = {
  /** The MCP spec revision this server implements, echoed in `initialize`. */
  protocolVersion: string
  /** The `serverInfo.name` this server reports. */
  serverName: string
  /** The `serverInfo.version` this server reports. */
  serverVersion: string
  /** The `tools/list` catalog — called fresh per request. */
  listTools: () => McpToolListEntry[]
  /** Dispatches one validated-by-name tool call to its handler. May reject; the core turns a rejection into a tool-call error response rather than letting it escape. */
  callTool: (name: string, args: unknown) => McpToolOutcome | Promise<McpToolOutcome>
}

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown }

export function rpcResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } })
}

/** The MCP `tools/call` result shape for one outcome — the value in both `content` (text) and `structuredContent`, `isError` set on a refusal. */
export function toolCallResult(outcome: McpToolOutcome): Record<string, unknown> {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: false
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome.error) }],
    structuredContent: { error: outcome.error },
    isError: true
  }
}

/**
 * Builds the wire protocol over one server's catalog + dispatcher. The returned
 * `handleLine`/`serve` behave exactly as `server.ts`'s own did before this was
 * factored out — the task-tools server now delegates here, and the dev-tools
 * server is its only other caller.
 */
export function createMcpServerCore(opts: McpServerCoreOptions): McpServerCore {
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
          protocolVersion: opts.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.serverName, version: opts.serverVersion }
        })
      case 'ping':
        return rpcResult(id, {})
      case 'tools/list':
        return rpcResult(id, { tools: opts.listTools() })
      case 'tools/call': {
        const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as {
          name?: unknown
          arguments?: unknown
        }
        if (typeof params.name !== 'string') {
          return rpcError(id, -32602, 'Invalid params: tools/call requires a string `name`')
        }
        // A handler can throw or reject for reasons unrelated to the call's own
        // validity (a forge read shells out to `gh`, which fails on a transient
        // network error). That must become one caller's refusal, never an
        // uncaught rejection — this `await` sits inside `handleLine`'s "never
        // throws" contract, and an escaped rejection here is fatal to the whole
        // process, taking every other in-flight and future call down with it.
        let outcome: McpToolOutcome
        try {
          outcome = await opts.callTool(params.name, params.arguments ?? {})
        } catch (err) {
          outcome = {
            ok: false,
            error: { kind: 'infrastructure', message: `${params.name} failed: ${errText(err)}` }
          }
        }
        // `toolCallResult`/`rpcResult` both `JSON.stringify` the handler's own
        // result — a value that isn't serializable (a `BigInt` field, say)
        // throws there, OUTSIDE the `try` above. Caught here so a bad result
        // becomes this call's own error response, same as a handler that threw.
        try {
          return rpcResult(id, toolCallResult(outcome))
        } catch (err) {
          return rpcError(id, -32603, `${params.name}: result could not be serialized — ${errText(err)}`)
        }
      }
      default:
        // Every `notifications/*` message (initialized, cancelled, …) is a
        // notification with no response; any other unknown method with an id is
        // a real method-not-found error.
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
    const write = (s: string): Promise<void> =>
      new Promise<void>((resolve) => {
        output.write(`${s}\n`, () => resolve())
      })

    // Sequential per line, dispatch included: each line's `handleLine` runs to
    // completion and its response is written before the next line's begins.
    // This is the serialization the task-tools server depends on (its handlers
    // mutate `process.env.VINAYA_TASK` for the duration of a `log()` call); a
    // single chained promise makes that race structurally impossible. Each link
    // swallows its own failure rather than rejecting the chain — one rejected
    // link would otherwise skip every `.then` already queued behind it, wedging
    // every later line for the rest of the process's life.
    let chain: Promise<void> = Promise.resolve()

    await new Promise<void>((resolve) => {
      input.on('data', (chunk: string) => {
        buffer += chunk
        let idx = buffer.indexOf('\n')
        while (idx !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          chain = chain.then(async () => {
            try {
              const response = await handleLine(line)
              if (response !== null) await write(response)
            } catch (err) {
              process.stderr.write(`mcp serve: dropped one line after an internal error — ${errText(err)}\n`)
            }
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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
