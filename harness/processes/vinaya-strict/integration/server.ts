/**
 * The shared, transport-agnostic task-tool surface (O1) — the ONE place the
 * catalog (`@attalabs/aeg-core`'s `TASK_TOOL_CATALOG`) is bound to the CLI-side
 * handlers (`handlers.ts` for the two outbox reads, `pr-read.ts` for the
 * forge read; `start.ts` for `task_start`), and the ONE place the MCP wire
 * protocol is spoken. Both
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
 *
 * One launch serves one seat. The kernel's seat host (`seat-host.ts`) serves
 * whatever seat it is given; this module is Vinaya's seat table
 * (`vinayaToolSeats`) — which seats exist and, for each, its catalog entries,
 * handlers and grant — and the server program's own `--seat` launch argument,
 * written by the generated configuration, picks one. A launch with no seat
 * argument serves the Operator.
 */

import {
  isTaskToolName,
  TASK_TOOL_CATALOG,
  type TaskToolDefinition,
  type TaskToolError,
  type TaskToolName
} from '../../../kernel/tools/catalog/task-tools'
import {
  createSeatHost,
  dispatchSeatCall,
  readSeatArgument,
  type SeatHandler,
  type SeatTable,
  selectSeat,
  validateSeatTable
} from '../../../kernel/tools/host/seat-host.js'
import { Writable } from 'node:stream'
import { defaultTaskCancelHandler } from '../loops/dev-review/run-control/cancel.js'
import type { TaskToolCallResult } from '../loops/dev-review/run-control/handlers.js'
import { taskEscalationReadHandler, taskStatusHandler } from '../loops/dev-review/run-control/handlers.js'
import { createMcpServerCore, MCP_PROTOCOL_VERSION, type McpServerCore } from '../../../kernel/tools/mcp-protocol.js'
import { taskPrReadHandler } from '../loops/dev-review/run-control/pr-read.js'
import { createTaskToolRouter } from '../../../kernel/tools/host/router.js'
import { vinayaRouterPolicies } from './policies/vinaya-policies.js'
import { VINAYA_PLANNER_ROUTER_ROLES } from './policies/roles.js'
import { PLANNER_TOOL_ENTRIES, plannerToolHandlers } from '../thinking/planner/tools/planner-tools.js'
import { defaultTaskResumeHandler } from '../loops/dev-review/run-control/resume.js'
import { defaultTaskStartHandler } from '../loops/dev-review/run-control/start.js'

/** The MCP spec revision this server implements and both adapters were verified against. */
export { MCP_PROTOCOL_VERSION }

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
 * The default binding: the two pure reads from `handlers.ts`, the forge read
 * from `pr-read.ts`, and the three real, caller-context-aware mutating
 * handlers, each from its own module — `task_start` (`start.ts`),
 * `task_resume` (`resume.ts`), `task_cancel` (`cancel.ts`). This is the
 * single wiring point O1 names — a catalog tool with no entry here is a type
 * error, not a silent gap. `task_pr_read` ignores the caller context for the
 * same reason the other reads do: it performs no effect to authenticate, and
 * holds no credential the caller could be granted.
 */
export const defaultTaskToolHandlers: TaskToolHandlers = {
  task_status: (input) => taskStatusHandler(input),
  task_escalation_read: (input) => taskEscalationReadHandler(input),
  task_pr_read: (input) => taskPrReadHandler(input),
  task_resume: (input, ctx) => defaultTaskResumeHandler(input, ctx),
  task_cancel: (input, ctx) => defaultTaskCancelHandler(input, ctx),
  task_start: (input, ctx) => defaultTaskStartHandler(input, ctx)
}

/**
 * Routes one Operator-seat tool call to its handler through the seat host's
 * two refusals (`dispatchSeatCall`), both BEFORE a handler runs so a
 * forbidden call reaches no effect: first, a name not in the catalog at all;
 * second, `grantCheck` (by default the `refuseUngrantedTool` of a router built
 * from `vinayaRouterPolicies` — the Operator's grant), a catalog name outside
 * the grant. `grantCheck` is injectable, like `handlers`, so a fixture can
 * force the refusal branch without a global module mock or a catalog tool
 * that is actually outside the grant (there is none — the Operator is granted
 * all six). Every other refusal (malformed input, absent caller, unknown run)
 * is the handler's own typed `TaskToolError`, returned unchanged. A served
 * launch reaches the same function through its seat's host
 * (`createSeatHost`), built over the seat's own grant.
 */
export async function dispatchToolCall(
  handlers: TaskToolHandlers,
  name: string,
  input: unknown,
  ctx: CallerContext,
  grantCheck: (tool: string) => TaskToolError | null = createTaskToolRouter(vinayaRouterPolicies()).refuseUngrantedTool
): Promise<TaskToolCallResult<unknown>> {
  return dispatchSeatCall({ isEntry: isTaskToolName, refuseUngranted: grantCheck, handlers }, name, input, ctx)
}

// --- the seat table: every seat Vinaya serves, in one place -------------------

/** The Operator's seat — what `--seat` names, and the seat a launch with no seat argument serves. */
export const OPERATOR_SEAT = 'operator'

/** The Planner's seat — what `--seat planner` names. */
export const PLANNER_SEAT = 'planner'

/** The MCP server name the generated configurations register the Planner's seat under. */
export const PLANNER_TOOLS_MCP_SERVER_NAME = 'vinaya-planner-tools'

/**
 * Vinaya's seat table — the one place it declares which seats its tool server
 * serves and, for each, the catalog entries, the handlers and the grant. It
 * declares two: the Operator's seat — the six task tools, their handlers, and
 * `VINAYA_ROUTER_ROLES` (the Operator's grant) — and the Planner's — its six
 * Issue, objectives and brief tools, their handlers, and
 * `VINAYA_PLANNER_ROUTER_ROLES`. The Operator's seat is the default, and it
 * keeps the server name every generated configuration already registers, so a
 * server started with no seat argument still serves it. `handlers` and
 * `plannerHandlers` are injectable so a fixture drives the real seat host with
 * recording handlers.
 */
export function vinayaToolSeats(
  handlers: TaskToolHandlers = defaultTaskToolHandlers,
  plannerHandlers: Record<string, SeatHandler<CallerContext>> = plannerToolHandlers()
): SeatTable<CallerContext> {
  return validateSeatTable({
    defaultSeat: OPERATOR_SEAT,
    seats: [
      {
        name: OPERATOR_SEAT,
        serverName: TASK_TOOLS_MCP_SERVER_NAME,
        entries: TASK_TOOL_CATALOG.map((def) => toolListEntry(def)),
        handlers,
        grant: vinayaRouterPolicies().roles
      },
      {
        name: PLANNER_SEAT,
        serverName: PLANNER_TOOLS_MCP_SERVER_NAME,
        entries: PLANNER_TOOL_ENTRIES,
        handlers: plannerHandlers,
        grant: VINAYA_PLANNER_ROUTER_ROLES
      }
    ]
  })
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
  // The ref union at the TOP level — `task_start` takes the two address forms
  // bare rather than under a `task` key, the shape it has always had. The
  // `type` stays declared beside the union: every branch is an object, and a
  // client that reads only `type` (as `tools/list`'s own consumers do) must
  // still see one.
  task_start: { type: 'object', ...TASK_REF_JSON_SCHEMA },
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
  task_pr_read: {
    type: 'object',
    properties: { task: TASK_REF_JSON_SCHEMA, pr: { type: 'integer', minimum: 1 } },
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

// --- JSON-RPC 2.0 message handling (the wire protocol lives in mcp-protocol) -

/**
 * Backwards-compatible alias for the shared `McpServerCore` — the task-tools
 * server has always returned `{ handleLine, serve }`, and every fixture that
 * drives it over newline-delimited framing uses exactly those two methods.
 */
export type TaskToolsMcpServer = McpServerCore

export type CreateTaskToolsMcpServerOptions = {
  serverVersion: string
  handlers?: TaskToolHandlers
  callerContext?: CallerContext
  /** The seat this launch serves, as its seat argument named it; absent serves the default seat (the Operator's). An undeclared seat throws `UnknownSeatError`. */
  seat?: string | null
}

/**
 * Builds the server for one seat over an explicit handler set and caller
 * context — both injectable so a fixture can drive the real protocol with
 * recording handlers (O3) while the CLI subcommand wires the production
 * defaults. The seat is chosen once, here, from the launch — never per call.
 * The wire protocol itself is the shared `createMcpServerCore`
 * (`mcp-protocol.ts`); this function binds it to the seat host built over the
 * seat's own entries, handlers and grant.
 */
export function createTaskToolsMcpServer(opts: CreateTaskToolsMcpServerOptions): TaskToolsMcpServer {
  const host = createSeatHost(selectSeat(vinayaToolSeats(opts.handlers), opts.seat ?? null))
  const ctx = opts.callerContext ?? { caller: null }
  return createMcpServerCore({
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverName: host.seat.serverName,
    serverVersion: opts.serverVersion,
    listTools: () => host.listTools(),
    callTool: (name, args) => host.callTool(name, args, ctx)
  })
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
 *
 * `argv` is the program's own launch arguments: its seat argument
 * (`--seat <name>`) picks the seat, and none serves the Operator. The seat is
 * resolved before any stream is touched, so a launch naming an undeclared
 * seat refuses to start with the declared seats named, rather than serving.
 */
export async function serveTaskToolsStdio(serverVersion: string, argv: readonly string[] = []): Promise<void> {
  const seat = readSeatArgument(argv)
  const callerContext = resolveCallerFromEnv(process.env)
  const server = createTaskToolsMcpServer({ serverVersion, callerContext, seat })

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

  await server.serve(process.stdin, protocolOut)
}
