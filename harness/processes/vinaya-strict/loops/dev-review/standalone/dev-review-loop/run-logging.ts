import type { LoopRunContext } from './run-context.js'
import type { DevReviewLoopEventInput } from '../../../../tools/dev-review-policy/types'
import { assertValidLoopEvent } from './git-defaults.js'
import { sizeOfSafe } from './round-assess.js'
import { waitForOwnLoopLine } from './round-assess.js'
import { narrateDriverEvent } from '../../../../../../kernel/log/client/loop-log.js'
import { drainLogSink } from '../../../../../../kernel/log/log-sink.js'

export function announcePr(c: LoopRunContext): void {
  if (c.prNumber > 0) process.env.VINAYA_PR = String(c.prNumber)
}

/**
 * Awaits EACH event's own landing before firing the next `log()` call —
 * not just the batch's last one. `resolveRepo()` only caches a
 * DETERMINISTIC outcome (a parsed `VINAYA_REPO`, or a successful git-remote
 * lookup); on an unresolvable repo (no remote, or the lookup itself
 * throws) it caches nothing (`resolve-repo.ts`'s own doc comment) — every
 * `log()` call in that case races an independent, uncached async
 * resolution, and two calls fired back-to-back can land out of order
 * (observed live: `gate_result_read` beat `round_started` to the file).
 * Sequencing each write removes the race outright rather than merely
 * waiting for the LAST one and hoping the rest arrived in order.
 */
export async function logEvents(c: LoopRunContext, events: readonly DevReviewLoopEventInput[]): Promise<void> {
  const { d, log, runId, loopLogPath, task } = c

  for (const e of events) {
    assertValidLoopEvent(e)
    const priorSize = sizeOfSafe(c.loopOutboxPath)
    log(e)
    await waitForOwnLoopLine(c.loopOutboxPath, priorSize, runId, e, d.sleep)
    // The plain line for the event just written: text only, after the
    // write, so when and whether the event is logged is unchanged.
    narrateDriverEvent(loopLogPath, e, c.narratedEvents, task)
    c.narratedEvents.push(e)
  }
}

export function drainAllLogSinks(c: LoopRunContext): Promise<void> {
  return Promise.all([c.drainLoopLogSink(), drainLogSink()]).then(() => undefined)
}
