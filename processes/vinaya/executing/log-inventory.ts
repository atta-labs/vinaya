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

const FROM_ASSESSMENT =
  'the events the deciding steps (validate-developer-output, assess-gate, validate-reviewer-outputs, assess-round) recorded in their results'
const HANDOFF_DEFERRAL =
  'deferred: produced once a ruling on a handed-off pause is consumed and the run continues from it; the handoff only raises the pause'
const FROM_HANDOFF = 'the handoff function'

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
    status: 'produced',
    from: 'the validate-developer-output step: a turn sent back for a red gate that left the remote head unchanged and work unpushed, resumed once with the commit-and-push instructions'
  },
  {
    family: 'dev_review_loop',
    events: ['round_ended'],
    status: 'produced',
    from: `${FROM_ASSESSMENT}; a red gate is a gate observation like a green one, so its round ends with the diffstat of the head the gate read`
  },
  {
    family: 'dev_review_loop',
    events: ['journal_finalized'],
    status: 'produced',
    from: 'the publish step, once the publication succeeded: result merged_ready, written from the close the assessment recorded and never while the assessment is read; a pause, a failed or exhausted leg, or a publication that failed ends its leg with result stopped from the head and totals the events carried, and writes none when no round was ever assessed'
  },
  {
    family: 'dev_review_loop',
    events: ['infrastructure_retry'],
    status: 'produced',
    from: `${FROM_HANDOFF}: a pause comment that took more than one attempt or never landed; no other step is retried`
  },
  {
    family: 'dev_review_loop',
    events: ['driver_heartbeat'],
    status: 'produced',
    from: 'the runner: one every five minutes while the run is alive, never one per node'
  },
  {
    family: 'dev_review_loop',
    events: ['driver_exited'],
    status: 'produced',
    from: 'the runner: one when the run ends, whatever way it ends'
  },
  {
    family: 'dev_review_loop',
    events: ['conflict_reentry'],
    status: 'produced',
    from: 'the runner: one each time its watch of a published pull request finds it conflicting and starts a fresh run, up to the re-entry bound'
  },
  {
    family: 'dev_review_loop',
    events: ['storage_push'],
    status: 'produced',
    from: 'the runner, version 2 only: one per Developer push that landed while no pull request is open (a storage push: cheap checks, no tests, no CI)'
  },
  {
    family: 'dev_review_loop',
    events: ['local_checks_run'],
    status: 'produced',
    from: 'the runner, version 2 only, at its run-mechanical-gates step: one per round, whether the local checks passed and how long they took'
  },
  {
    family: 'dev_review_loop',
    events: ['ready_push', 'failed_tests_rerun'],
    status: 'produced',
    from: 'the runner, version 2 only, at its ready-push step: one ready_push per approval it pushes, and failed_tests_rerun when that push re-ran only what a refused one failed plus what the fix affects'
  },
  {
    family: 'dev_review_loop',
    events: ['pr_opened'],
    status: 'produced',
    from: 'the runner, version 2 only, at its open-pull-request step: once, when the approved head opens the pull request'
  },
  {
    family: 'dev_review_loop',
    events: ['ci_result_read'],
    status: 'produced',
    from: 'the runner, version 2 only, at its read-ci-once step: one CI read per approved head'
  },
  {
    family: 'dev_review_loop',
    events: ['phase_time'],
    status: 'produced',
    from: 'every step of either flow, when it completes or fails: the wall time it spent, counted toward its phase'
  },
  {
    family: 'handoff',
    events: ['raised'],
    status: 'produced',
    from: `${FROM_HANDOFF}: the escalation record it writes logs one raised event, and none when the same pause is handed off again`
  },
  { family: 'handoff', events: ['resolved'], status: 'deferred', reason: HANDOFF_DEFERRAL },
  {
    family: 'role_attempt',
    events: ['attempted'],
    status: 'produced',
    from: 'the validate-reviewer-outputs step: one per reviewer role that gave no usable review on its fresh retry, before the infrastructure pause'
  }
]
