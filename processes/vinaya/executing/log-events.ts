import type { DevReviewLoopEventInput, LoopConfig } from '@attalabs/aeg-core'
import type { LogEventInput, LogProducers, RecordedSteps } from '../../../harness/dev-process/logging/translate'

// The Log events the developer review Flow's run produces, for the harness
// translator. Nothing here reaches the Log: each producer returns events
// without their envelope and the caller that wires the translator completes
// and writes them. Which old-driver event each one stands for is the table in
// `log-inventory.ts`.

const ASSESS_STEP = 'assess-round'
const DEVELOP_STEP = 'develop'

/** The Flow's agent steps and the role each launches. */
export const AGENT_STEP_ROLES: Readonly<Record<string, string>> = {
  [DEVELOP_STEP]: 'developer',
  'code-review': 'code-reviewer',
  'security-review': 'security-reviewer'
}

/** The code the driver's exit record gives a run that ended on a failed step. */
const STEP_FAILED = 'step_failed'

interface Assessment {
  decision: string
  events: DevReviewLoopEventInput[]
}

/** The assessment the assess-round step recorded, or null when it recorded none or something unreadable. */
function readAssessment(steps: RecordedSteps): Assessment | null {
  const stdout = steps[ASSESS_STEP]?.stdout
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as { decision?: { type?: unknown; reason?: unknown }; events?: unknown }
    if (!Array.isArray(parsed.events) || typeof parsed.decision?.type !== 'string') return null
    const events = parsed.events.filter(
      (event): event is DevReviewLoopEventInput =>
        typeof event === 'object' && event !== null && (event as { kind?: unknown }).kind === 'dev_review_loop'
    )
    const decision =
      parsed.decision.type === 'pause' ? `pause(${String(parsed.decision.reason)})` : parsed.decision.type
    return { decision, events }
  } catch {
    return null
  }
}

/** Producers for one run of the Flow, with the state a run builds up across its legs. */
export function createVinayaLogProducers(config: Pick<LoopConfig, 'loopId' | 'task'>): LogProducers {
  let round = 1
  let lastDecision: string | null = null
  let finalHead: string | null = null
  let roundsEnded = 0
  let totalWallMs = 0
  let filesChanged = 0
  let finalized = false

  const loop = (fields: Record<string, unknown>): LogEventInput =>
    ({ kind: 'dev_review_loop', payload: {}, loop_id: config.loopId, ...fields }) as unknown as LogEventInput

  const paused = (reasonCode: string): LogEventInput =>
    loop({ event: 'paused', round, reason: 'principal_item', reason_code: reasonCode })

  const exited = (reason: string, lastDecisionText: string, extra: Record<string, unknown> = {}): LogEventInput =>
    loop({ event: 'driver_exited', task: config.task, reason, last_decision: lastDecisionText, ...extra })

  /** Closes the journal from what the assessment events carried; says nothing when no round was ever assessed. */
  const closeJournal = (): LogEventInput[] => {
    if (finalized || finalHead === null) return []
    finalized = true
    return [
      loop({
        event: 'journal_finalized',
        rounds: roundsEnded,
        total_wall_ms: totalWallMs,
        time_to_green_ms: null,
        files_changed_total: filesChanged,
        final_head: finalHead,
        result: 'stopped'
      })
    ]
  }

  /** The assessment's events, with the totals a later journal close needs taken from them. */
  const assessed = (steps: RecordedSteps): LogEventInput[] => {
    const assessment = readAssessment(steps)
    if (assessment === null) return []
    lastDecision = assessment.decision
    for (const event of assessment.events) {
      if (event.event === 'gate_result_read') finalHead = event.head
      if (event.event === 'round_ended') {
        roundsEnded += 1
        totalWallMs += event.wall_ms
        filesChanged += event.files_changed
        finalHead = event.head
      }
      if (event.event === 'journal_finalized') finalized = true
    }
    return assessment.events as unknown as LogEventInput[]
  }

  const attempt = (
    nodeId: string,
    attemptNumber: number,
    outcome: 'completed' | 'infrastructure_failed'
  ): LogEventInput[] => {
    const actor = AGENT_STEP_ROLES[nodeId]
    if (actor === undefined) return []
    return [
      {
        kind: 'role_attempt',
        event: 'attempted',
        payload: {},
        actor,
        attempt: attemptNumber,
        effect_id: `${nodeId}:${attemptNumber}`,
        model: null,
        outcome,
        usage: null
      }
    ]
  }

  return {
    legStarted: ({ resumed }) => {
      lastDecision = null
      return resumed ? [loop({ event: 'resumed', round, by: 'driver' })] : []
    },
    nodeStarted: ({ nodeId, attempt: started }) => {
      if (nodeId === DEVELOP_STEP) round = Math.max(1, started)
      return [loop({ event: 'driver_heartbeat', task: config.task, round, phase: nodeId })]
    },
    nodeCompleted: ({ nodeId, attempt: started, steps }) =>
      nodeId === ASSESS_STEP ? assessed(steps) : attempt(nodeId, started, 'completed'),
    nodeFailed: ({ nodeId, attempt: started, steps }) =>
      nodeId === ASSESS_STEP ? assessed(steps) : attempt(nodeId, started, 'infrastructure_failed'),
    runEnded: ({ outcome, cancelled }) => {
      if (cancelled) {
        return [loop({ event: 'cancelled', round, by: 'principal' }), exited('signal', 'cancel')]
      }
      switch (outcome.reason) {
        case 'completed':
          return [exited('finished', 'publish', { exit_code: 0 })]
        case 'paused':
          return [paused('halt'), exited('paused', 'pause(halt)')]
        case 'exhausted':
          return [
            loop({ event: 'stop_condition_met', round, condition: 'max_rounds' }),
            paused('max_rounds'),
            ...closeJournal(),
            exited('paused', 'pause(max_rounds)')
          ]
        default: {
          // A decided pause already wrote its own `paused`, `round_ended` and `journal_finalized`; a crash wrote none.
          if (lastDecision?.startsWith('pause(')) return [exited('paused', lastDecision)]
          return [
            paused('infrastructure'),
            ...closeJournal(),
            exited('error', 'error', { exit_code: 1, error_class: STEP_FAILED })
          ]
        }
      }
    }
  }
}
