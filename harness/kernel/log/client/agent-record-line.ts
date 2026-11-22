/**
 * The plain line for one agent record, in its own module because it needs the Log SDK: the driver-log module
 * (`loop-log.ts`) is imported by the round-test progress observer, which never writes an agent record, and loading
 * the SDK there slows the observer's start-up.
 */

import {
  type NarratableRecord,
  narrate as narrateRecord,
  type SeatNames
} from '../../../../packages/log-sdk/src/index.js'
import { appendDriverLine, marksByKind } from './loop-log.js'

/**
 * The plain line for one agent record the run's Log handle just wrote — the Log SDK's `narrate` for that very
 * record, with the seat names the caller passes: into the driver log and onto the terminal, as the driver's own
 * lines are. A record with no wording writes nothing.
 */
export function narrateAgentRecord(path: string, record: NarratableRecord, seatNames: SeatNames): void {
  const line = narrateRecord(record, seatNames)
  if (!line) return
  appendDriverLine(path, line.text, marksByKind[line.kind])
}
