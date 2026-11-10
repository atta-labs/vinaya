/**
 * The seat host: one tool server launch serves exactly one seat. A seat is a
 * named set of catalog entries, the handlers that implement them, and the
 * grant that says which of them may be called — all three supplied by the
 * process, never by this module, which names no seat of its own.
 *
 * Which seat a launch serves is fixed by the server program's own launch
 * arguments (`--seat <name>`), written by the generated MCP configuration that
 * starts it — never by a tool-call argument, and never by an environment value
 * a session sets: a caller's claim about who it is authenticates nothing. A
 * launch with no seat argument serves the process's default seat, so a
 * configuration generated before seats existed keeps starting the same server.
 * A seat argument naming no declared seat refuses to start, naming the seats
 * the process declares.
 *
 * Every call is refused before any handler runs when the tool is not one of
 * the seat's catalog entries, or when the seat's grant does not hold it (the
 * router's grant gate, `createTaskToolRouter`). Only a call that passes both
 * reaches its handler.
 */

import { taskToolError, type TaskToolError } from '../catalog/task-tools'
import type { McpToolListEntry } from '../mcp-protocol.js'
import { createTaskToolRouter, type RouterRolePolicy } from './router.js'

/** One tool call's outcome: the handler's result, or a typed refusal. */
export type SeatCallResult = { ok: true; result: unknown } | { ok: false; error: TaskToolError }

/** A tool's implementation: the caller's input and the invocation context the transport resolved. */
export type SeatHandler<Ctx> = (input: unknown, ctx: Ctx) => SeatCallResult | Promise<SeatCallResult>

/** One seat, as a process declares it. */
export type Seat<Ctx> = {
  /** What the server program's seat argument names. */
  readonly name: string
  /** The MCP server name the generated configurations register this seat under. */
  readonly serverName: string
  /** The catalog entries this seat may be served, as `tools/list` lists them. */
  readonly entries: readonly McpToolListEntry[]
  /** The handler for each entry, by tool name. */
  readonly handlers: Readonly<Record<string, SeatHandler<Ctx>>>
  /** The tools the seat may call, and how a refusal names the seat. */
  readonly grant: RouterRolePolicy
}

/** Every seat a process declares, and the one a launch with no seat argument serves. */
export type SeatTable<Ctx> = {
  readonly seats: readonly Seat<Ctx>[]
  readonly defaultSeat: string
}

/** The server program's launch argument that names its seat. */
export const SEAT_ARGUMENT = '--seat'

/** Thrown when a launch names a seat the process does not declare — the server refuses to start. */
export class UnknownSeatError extends Error {
  constructor(requested: string, declared: readonly string[]) {
    super(`no seat named "${requested}" — this process declares: ${declared.join(', ')}`)
    this.name = 'UnknownSeatError'
  }
}

/** Thrown when a process's seat declaration cannot be served as written. */
export class InvalidSeatTableError extends Error {
  constructor(problem: string) {
    super(`refusing to serve the seat table: ${problem}`)
    this.name = 'InvalidSeatTableError'
  }
}

/**
 * Reads the seat a launch names from the server program's own arguments:
 * `--seat <name>` or `--seat=<name>`, at most once. Returns `null` when the
 * launch names no seat. Other arguments are left for the program.
 */
export function readSeatArgument(argv: readonly string[]): string | null {
  let seat: string | null = null
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    let value: string | undefined
    if (arg === SEAT_ARGUMENT) {
      value = argv[i + 1]
      i++
    } else if (arg.startsWith(`${SEAT_ARGUMENT}=`)) {
      value = arg.slice(SEAT_ARGUMENT.length + 1)
    } else {
      continue
    }
    if (seen) throw new Error(`${SEAT_ARGUMENT} is given more than once — a launch serves exactly one seat`)
    if (value === undefined || value.trim().length === 0 || value.startsWith('--')) {
      throw new Error(`${SEAT_ARGUMENT} needs a seat name`)
    }
    seen = true
    seat = value.trim()
  }
  return seat
}

/**
 * Checks a process's seat table before anything is served: seat names and
 * server names are unique, the default seat is declared, and every tool a
 * seat's grant holds has both a catalog entry and a handler — a granted tool
 * with nothing behind it is a declaration error, never a silent gap.
 */
export function validateSeatTable<Ctx>(table: SeatTable<Ctx>): SeatTable<Ctx> {
  const names = table.seats.map((seat) => seat.name)
  const servers = table.seats.map((seat) => seat.serverName)
  if (names.length === 0) throw new InvalidSeatTableError('it declares no seat')
  if (new Set(names).size !== names.length) throw new InvalidSeatTableError('two seats share a name')
  if (new Set(servers).size !== servers.length) throw new InvalidSeatTableError('two seats share a server name')
  if (!names.includes(table.defaultSeat)) {
    throw new InvalidSeatTableError(`its default seat "${table.defaultSeat}" is not declared`)
  }
  for (const seat of table.seats) {
    const entryNames = new Set(seat.entries.map((entry) => entry.name))
    for (const tool of seat.grant.grantedTools) {
      if (!entryNames.has(tool)) {
        throw new InvalidSeatTableError(`seat "${seat.name}" is granted "${tool}" but has no catalog entry for it`)
      }
      if (!Object.hasOwn(seat.handlers, tool) || typeof seat.handlers[tool] !== 'function') {
        throw new InvalidSeatTableError(`seat "${seat.name}" is granted "${tool}" but has no handler for it`)
      }
    }
  }
  return table
}

/** The seat a launch serves: the named one, or the default when the launch names none. An undeclared name refuses. */
export function selectSeat<Ctx>(table: SeatTable<Ctx>, requested: string | null): Seat<Ctx> {
  const name = requested ?? table.defaultSeat
  const seat = table.seats.find((candidate) => candidate.name === name)
  if (!seat)
    throw new UnknownSeatError(
      name,
      table.seats.map((candidate) => candidate.name)
    )
  return seat
}

/** The seat arguments a generated configuration appends to the server program for one seat: none for the default seat, so its entry stays as it always was. */
export function seatLaunchArguments<Ctx>(table: SeatTable<Ctx>, seatName: string): string[] {
  const seat = selectSeat(table, seatName)
  return seat.name === table.defaultSeat ? [] : [SEAT_ARGUMENT, seat.name]
}

/** The two refusals a call meets before its handler, and the handlers behind them. */
export type SeatGate<Ctx> = {
  /** Whether the tool is one of the seat's catalog entries at all. */
  readonly isEntry: (tool: string) => boolean
  /** The grant gate: an `authority` refusal for a tool outside the seat's grant, else `null`. */
  readonly refuseUngranted: (tool: string) => TaskToolError | null
  readonly handlers: Readonly<Record<string, SeatHandler<Ctx>>>
}

/**
 * Routes one call through both refusals, each BEFORE a handler runs, so a
 * refused call reaches no effect: a tool that is no catalog entry of the seat
 * is a `validation` refusal; a catalog entry outside the grant is the grant
 * gate's `authority` refusal. Every other refusal is the handler's own,
 * returned unchanged.
 */
export async function dispatchSeatCall<Ctx>(
  gate: SeatGate<Ctx>,
  name: string,
  input: unknown,
  ctx: Ctx
): Promise<SeatCallResult> {
  const handler = gate.isEntry(name) && Object.hasOwn(gate.handlers, name) ? gate.handlers[name] : undefined
  if (typeof handler !== 'function') {
    return { ok: false, error: taskToolError('validation', `no such task tool: ${JSON.stringify(name)}`) }
  }
  const refusal = gate.refuseUngranted(name)
  if (refusal) return { ok: false, error: refusal }
  return handler(input, ctx)
}

/** What a server launch is built over: the one seat it serves, its tool list, and its call path. */
export type SeatHost<Ctx> = {
  readonly seat: Seat<Ctx>
  /** The seat's granted catalog entries, in the order the seat declares them. */
  listTools: () => McpToolListEntry[]
  callTool: (name: string, input: unknown, ctx: Ctx) => Promise<SeatCallResult>
}

/** Builds the host for one seat; the grant gate is the router's, built over the seat's own grant. */
export function createSeatHost<Ctx>(seat: Seat<Ctx>): SeatHost<Ctx> {
  const { refuseUngrantedTool } = createTaskToolRouter({ roles: seat.grant })
  const entryNames = new Set(seat.entries.map((entry) => entry.name))
  const gate: SeatGate<Ctx> = {
    isEntry: (tool) => entryNames.has(tool),
    refuseUngranted: refuseUngrantedTool,
    handlers: seat.handlers
  }
  return {
    seat,
    listTools: () => seat.entries.filter((entry) => seat.grant.grantedTools.includes(entry.name)),
    callTool: (name, input, ctx) => dispatchSeatCall(gate, name, input, ctx)
  }
}
