import { describe, expect, it } from 'bun:test'
import * as catalog from '../catalog/task-tools'
import {
  createSeatHost,
  InvalidSeatTableError,
  readSeatArgument,
  SEAT_ARGUMENT,
  type Seat,
  type SeatTable,
  seatLaunchArguments,
  selectSeat,
  UnknownSeatError,
  validateSeatTable
} from './seat-host'

/**
 * The seat host serves whatever seat a process gives it, and names none of its
 * own: these fixtures use synthetic seat labels (`alpha`, `beta`) and synthetic
 * tools, never a process's real seats.
 */

type Ctx = { caller: string | null }

function entry(name: string) {
  return { name, description: `${name} tool`, inputSchema: { type: 'object' } }
}

function recordingSeat(name: string, granted: string[], entries: string[], calls: string[]): Seat<Ctx> {
  const handlers: Record<string, (input: unknown, ctx: Ctx) => { ok: true; result: unknown }> = {}
  for (const tool of entries) {
    handlers[tool] = (input, ctx) => {
      calls.push(tool)
      return { ok: true, result: { tool, input, caller: ctx.caller } }
    }
  }
  return {
    name,
    serverName: `${name}-tools`,
    entries: entries.map(entry),
    handlers,
    grant: { grantedTools: granted, seat: `the ${name} seat`, askedOf: 'someone else' }
  }
}

function table(calls: string[] = []): SeatTable<Ctx> {
  return validateSeatTable({
    defaultSeat: 'alpha',
    seats: [
      recordingSeat('alpha', ['read', 'write'], ['read', 'write', 'merge'], calls),
      recordingSeat('beta', ['read'], ['read'], calls)
    ]
  })
}

describe('readSeatArgument — the seat comes from the launch arguments', () => {
  it('reads `--seat <name>` and `--seat=<name>`', () => {
    expect(readSeatArgument([SEAT_ARGUMENT, 'beta'])).toBe('beta')
    expect(readSeatArgument([`${SEAT_ARGUMENT}=beta`])).toBe('beta')
    expect(readSeatArgument(['--other', 'x', SEAT_ARGUMENT, 'beta'])).toBe('beta')
  })

  it('returns null when the launch names no seat', () => {
    expect(readSeatArgument([])).toBeNull()
    expect(readSeatArgument(['--other', 'x'])).toBeNull()
  })

  it('refuses a seat argument with no name, or a second seat argument', () => {
    expect(() => readSeatArgument([SEAT_ARGUMENT])).toThrow('needs a seat name')
    expect(() => readSeatArgument([`${SEAT_ARGUMENT}=`])).toThrow('needs a seat name')
    expect(() => readSeatArgument([SEAT_ARGUMENT, '--other'])).toThrow('needs a seat name')
    expect(() => readSeatArgument([SEAT_ARGUMENT, 'alpha', SEAT_ARGUMENT, 'beta'])).toThrow('more than once')
  })
})

describe('selectSeat — one seat per launch', () => {
  it('serves the default seat when the launch names none', () => {
    expect(selectSeat(table(), null).name).toBe('alpha')
  })

  it('serves the named seat', () => {
    expect(selectSeat(table(), 'beta').name).toBe('beta')
  })

  it('refuses an undeclared seat, naming the seats the process declares', () => {
    expect(() => selectSeat(table(), 'gamma')).toThrow(UnknownSeatError)
    expect(() => selectSeat(table(), 'gamma')).toThrow('no seat named "gamma" — this process declares: alpha, beta')
  })
})

describe('seatLaunchArguments — what a generated configuration appends', () => {
  it('appends nothing for the default seat, so its entry is unchanged', () => {
    expect(seatLaunchArguments(table(), 'alpha')).toEqual([])
  })

  it('appends the seat argument for any other seat, and reading it back selects that seat', () => {
    const args = seatLaunchArguments(table(), 'beta')
    expect(args).toEqual([SEAT_ARGUMENT, 'beta'])
    expect(selectSeat(table(), readSeatArgument(args)).name).toBe('beta')
  })

  it('refuses an undeclared seat', () => {
    expect(() => seatLaunchArguments(table(), 'gamma')).toThrow(UnknownSeatError)
  })
})

describe('validateSeatTable — a declaration that cannot be served refuses', () => {
  it('refuses a granted tool with no catalog entry or no handler', () => {
    const noEntry = recordingSeat('alpha', ['read', 'write'], ['read'], [])
    expect(() => validateSeatTable({ defaultSeat: 'alpha', seats: [noEntry] })).toThrow(InvalidSeatTableError)
    const noHandler: Seat<Ctx> = { ...recordingSeat('alpha', ['read'], ['read'], []), handlers: {} }
    expect(() => validateSeatTable({ defaultSeat: 'alpha', seats: [noHandler] })).toThrow('no handler')
  })

  it('refuses duplicate seats, duplicate server names, an undeclared default and an empty table', () => {
    const a = recordingSeat('alpha', [], [], [])
    expect(() => validateSeatTable({ defaultSeat: 'alpha', seats: [a, a] })).toThrow('share a name')
    const b = { ...recordingSeat('beta', [], [], []), serverName: a.serverName }
    expect(() => validateSeatTable({ defaultSeat: 'alpha', seats: [a, b] })).toThrow('share a server name')
    expect(() => validateSeatTable({ defaultSeat: 'gamma', seats: [a] })).toThrow('not declared')
    expect(() => validateSeatTable({ defaultSeat: 'alpha', seats: [] })).toThrow('declares no seat')
  })
})

describe('createSeatHost — the seat’s grant gate runs before any handler', () => {
  it('lists only the seat’s granted entries', () => {
    expect(
      createSeatHost(selectSeat(table(), null))
        .listTools()
        .map((t) => t.name)
    ).toEqual(['read', 'write'])
    expect(
      createSeatHost(selectSeat(table(), 'beta'))
        .listTools()
        .map((t) => t.name)
    ).toEqual(['read'])
  })

  it('calls a granted tool’s handler with the input and the transport’s context', async () => {
    const calls: string[] = []
    const host = createSeatHost(selectSeat(table(calls), null))
    expect(await host.callTool('read', { x: 1 }, { caller: 'c' })).toEqual({
      ok: true,
      result: { tool: 'read', input: { x: 1 }, caller: 'c' }
    })
    expect(calls).toEqual(['read'])
  })

  it('refuses an ungranted catalog entry with an authority error before its handler runs', async () => {
    const calls: string[] = []
    const host = createSeatHost(selectSeat(table(calls), null))
    const result = await host.callTool('merge', {}, { caller: 'c' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('authority')
      expect(result.error.message).toBe('the alpha seat is not granted "merge"')
      expect(result.error.detail).toContain('read, write')
    }
    expect(calls).toEqual([])
  })

  it('a tool granted to one seat is refused on another seat’s launch', async () => {
    const calls: string[] = []
    const host = createSeatHost(selectSeat(table(calls), 'beta'))
    const result = await host.callTool('write', {}, { caller: 'c' })
    expect(result).toMatchObject({ ok: false, error: { kind: 'validation' } })
    expect(calls).toEqual([])
  })

  it('refuses an unknown tool — including an inherited object key — with a validation error before any handler', async () => {
    const calls: string[] = []
    const host = createSeatHost(selectSeat(table(calls), null))
    for (const name of ['nope', 'toString', '__proto__', 'constructor']) {
      expect(await host.callTool(name, {}, { caller: 'c' })).toEqual({
        ok: false,
        error: { kind: 'validation', message: `no such task tool: ${JSON.stringify(name)}` }
      })
    }
    expect(calls).toEqual([])
  })

  it('a seat named in the call input changes nothing — the seat is the launch’s', async () => {
    const calls: string[] = []
    const host = createSeatHost(selectSeat(table(calls), 'beta'))
    const result = await host.callTool('write', { seat: 'alpha' }, { caller: 'c' })
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('the kernel catalog names no seat grant', () => {
  it('exports no role-named grant', () => {
    expect(Object.keys(catalog).filter((key) => /grant/i.test(key))).toEqual([])
  })
})
