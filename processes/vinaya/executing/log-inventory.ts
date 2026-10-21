// The Log events the review loop's driver wrote, and what becomes of each on
// the Engine path. One row per event kind: produced by a producer in
// `log-events.ts`, dropped with the reason it has no meaning here, or deferred
// to a named later task. The coverage test in `tests/log-events.test.ts` holds
// every event the old driver could write to a row of this table.

interface RowBase {
  /** The Log family the events belong to. */
  family: 'dev_review_loop' | 'role_attempt' | 'handoff'
  /** The event names the row covers. */
  events: readonly string[]
}

export type InventoryRow =
  | (RowBase & {
      status: 'produced'
      /** Where in a run the producer gets the event from. */
      from: string
    })
  | (RowBase & {
      status: 'dropped'
      /** Why the Engine path never writes it. */
      reason: string
    })
  | (RowBase & {
      status: 'deferred'
      /** Why it is not produced yet, and what makes it producible. */
      reason: string
    })

const FROM_ASSESSMENT = 'the events the assess-round step recorded in its result'
const HANDOFF_DEFERRAL =
  'deferred: produced once an assess-round `pause` decision becomes an Engine pause awaiting a human handoff; today the binding throws on that decision'

export const LOG_INVENTORY: readonly InventoryRow[] = [
  { family: 'dev_review_loop', events: ['loop_started'], status: 'produced', from: FROM_ASSESSMENT },
  { family: 'dev_review_loop', events: ['round_started'], status: 'produced', from: FROM_ASSESSMENT },
  { family: 'dev_review_loop', events: ['gate_result_read'], status: 'produced', from: FROM_ASSESSMENT },
  { family: 'dev_review_loop', events: ['verdicts_read'], status: 'produced', from: FROM_ASSESSMENT },
  { family: 'dev_review_loop', events: ['findings_compared'], status: 'produced', from: FROM_ASSESSMENT },
  {
    family: 'dev_review_loop',
    events: ['stop_condition_met'],
    status: 'produced',
    from: `${FROM_ASSESSMENT}; a run that exhausts a revision ceiling ends on max_rounds`
  },
  {
    family: 'dev_review_loop',
    events: ['paused'],
    status: 'produced',
    from: `${FROM_ASSESSMENT}; a halted leg, a failed step or an exhausted ceiling at the end of a leg`
  },
  {
    family: 'dev_review_loop',
    events: ['resumed'],
    status: 'produced',
    from: 'the start of a leg that continues a halted run'
  },
  {
    family: 'dev_review_loop',
    events: ['cancelled'],
    status: 'produced',
    from: 'the end of a leg the caller cancelled'
  },
  {
    family: 'dev_review_loop',
    events: ['unpushed_work_resume'],
    status: 'dropped',
    reason:
      'The Flow has no mid-round driver resume: a developer step that pushed nothing fails output validation and ends the run.'
  },
  {
    family: 'dev_review_loop',
    events: ['round_ended'],
    status: 'produced',
    from: `${FROM_ASSESSMENT}; a round whose gate went red loops back before any assessment, so it writes none and the diffstat of that round is never invented`
  },
  {
    family: 'dev_review_loop',
    events: ['journal_finalized'],
    status: 'produced',
    from: `${FROM_ASSESSMENT}; a failed or exhausted leg closes the journal from the head and totals those events carried, and writes none when no round was ever assessed`
  },
  {
    family: 'dev_review_loop',
    events: ['infrastructure_retry'],
    status: 'dropped',
    reason: 'The Engine path retries nothing: a step that fails fails the run, so there is no retry episode to count.'
  },
  { family: 'dev_review_loop', events: ['driver_heartbeat'], status: 'produced', from: 'each node start' },
  { family: 'dev_review_loop', events: ['driver_exited'], status: 'produced', from: 'the end of every leg' },
  { family: 'handoff', events: ['raised', 'resolved'], status: 'deferred', reason: HANDOFF_DEFERRAL },
  { family: 'role_attempt', events: ['attempted'], status: 'produced', from: 'each agent step completing or failing' }
]
