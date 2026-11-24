/**
 * The plain line for one agent record, in its own module because it needs the Log SDK: the driver-log module
 * (`loop-log.ts`) is imported by the round-test progress observer, which never writes an agent record, and loading
 * the SDK there slows the observer's start-up.
 */

import { type NarratableRecord, narrate as narrateRecord, type SeatNames } from '@attalabs/vinaya-log-sdk'
import { appendDriverLine, marksByKind } from './loop-log.js'
import { narrate } from './narration'

/**
 * The plain line for one Log event this driver just wrote — the shared
 * phrase function's words, so a live screen reads the same sentences. A
 * pause or stop that needs a person also says who acts and that the run
 * continues through the Operator's `task_resume`, for this task and the round
 * it paused in; it never prints a command. A record with no wording writes
 * nothing.
 */
export function narrateDriverEvent(path: string, event: unknown, earlier: readonly unknown[], task: number): void {
  const line = narrate(event, earlier)
  if (!line) return
  const fields = event as { event?: unknown; round?: unknown }
  const needsPerson = line.kind === 'blocked' && (fields.event === 'paused' || fields.event === 'stop_condition_met')
  const pause = typeof fields.round === 'number' ? `the pause at round ${fields.round}` : 'this pause'
  const words = needsPerson
    ? `${line.text} The Operator's task_resume for task ${task} continues this run, bound to ${pause}, once the person has decided or repaired it.`
    : line.text
  appendDriverLine(path, words, marksByKind[line.kind])
}

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
