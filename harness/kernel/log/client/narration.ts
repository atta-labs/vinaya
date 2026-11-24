/**
 * One plain line for one loop or dispatch record, so the terminal log and a
 * live screen use the same words. The kind carries the meaning; each consumer
 * adds its own time and styling. An earlier-format record is converted to the
 * Log SDK's own record by its public line reader and worded by its public
 * `narrate`; this file adds only the seats the role registry knows.
 */

import {
  createLineReader,
  narrate as sdkNarrate,
  NARRATION_KINDS,
  type NarrationKind,
  type NarrationLine,
  type OtelRecord,
  reasonWaitsOn,
  type SeatNames
} from '@attalabs/vinaya-log-sdk'
import { lookupRole, registeredRoles } from '../roles'

export { NARRATION_KINDS, reasonWaitsOn }
export type { NarrationKind, NarrationLine }

/** The earlier events that end a span: their record needs the event that opened the span read first. */
const SPAN_ENDS = new Set(['round_ended', 'outcome_received'])

/** The earlier events this narration words, by kind: the loop's rounds and stops, and a dispatch's start and end. Every other event has no line here. */
const WORDED: Readonly<Record<string, ReadonlySet<string>>> = {
  dev_review_loop: new Set([
    'round_started',
    'gate_result_read',
    'verdicts_read',
    'round_ended',
    'paused',
    'stop_condition_met',
    'driver_exited',
    'conflict_reentry'
  ]),
  dispatch: new Set(['dispatched', 'outcome_received'])
}

/** The seats the role registry holds, as the Log SDK's narration reads them: a reading name, and whether the seat reviews. */
function registeredSeats(): SeatNames {
  const seats: Record<string, { reading: string; reviews: boolean }> = {}
  for (const name of registeredRoles()) {
    const role = lookupRole(name)
    if (role !== undefined) seats[name] = { reading: role.reading, reviews: role.reviews }
  }
  return seats
}

/** The header a record the driver has not yet written carries none of, so the line reader reads it as the stored record it will be. */
const NO_HEADER = {
  meta: {
    schema: 1,
    run_id: 'narration',
    repo: 'narration/narration',
    vinaya: '0.0.0',
    doctrine: 'narration',
    host: 'loop',
    machine: 'narration',
    ts: '1970-01-01T00:00:00.000Z',
    seq: 0
  },
  subject: { issue: null, role: 'unattributed' },
  payload: {}
}

/** The line a record is read from: the record itself, with the header it lacks. */
function stored(record: object): string {
  return JSON.stringify({ ...NO_HEADER, ...record })
}

/** The record an earlier event converts to, read after the events before it that its conversion needs. */
function convert(event: object, earlier: readonly unknown[]): { record: OtelRecord | undefined; before: OtelRecord[] } {
  const lines = createLineReader('narration')
  const before: OtelRecord[] = []
  const needs = SPAN_ENDS.has(String((event as { event?: unknown }).event))
  if (needs) {
    for (const previous of earlier) {
      if (typeof previous !== 'object' || previous === null) continue
      const read = lines.readLine(stored(previous)).records[0]
      if (read !== undefined) before.push(read)
    }
  }
  return { record: lines.readLine(stored(event)).records[0], before }
}

/**
 * The one plain line for a record, or `null` when this record has no wording.
 *
 * `earlier` is the loop's records already read, in order. It is used for two
 * things only: a span's end is read after the event that opened it, and a
 * round end states the confidence recorded at the same round's gate read,
 * because a round end record carries no confidence of its own.
 */
export function narrate(record: unknown, earlier: readonly unknown[] = []): NarrationLine | null {
  try {
    if (typeof record !== 'object' || record === null) return null
    const { kind, event } = record as { kind?: unknown; event?: unknown }
    if (typeof kind !== 'string' || typeof event !== 'string' || !WORDED[kind]?.has(event)) return null
    const { record: converted, before } = convert(record, Array.isArray(earlier) ? earlier : [])
    if (converted === undefined) return null
    return sdkNarrate(converted, registeredSeats(), before)
  } catch {
    return null
  }
}
