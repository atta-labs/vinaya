import type { DevReviewLoopEventInput, LoopConfig } from '@attalabs/aeg-core'
import type {
  LogEventInput,
  LogProducers,
  RecordedSteps,
  RunEndContext
} from '../../../harness/dev-process/logging/translate'
import type { DriverExitReason } from '../../../apps/cli/src/lib/dev-review-loop/driver-lifecycle'

// The Log events the developer review Flow's run produces, for the harness
// translator. Nothing here reaches the Log: each producer returns events
// without their envelope and the caller that wires the translator completes
// and writes them. Which old-driver event each one stands for is the table in
// `log-inventory.ts`.

const ASSESS_STEP = 'assess-round'
/** The steps that record the shared assessment's events with their decision, in the order a round reaches them. */
export const DECIDING_STEPS: readonly string[] = [
  'validate-developer-output',
  'assess-gate',
  'validate-reviewer-outputs',
  ASSESS_STEP
]
const LIVE_STEP = 'run-live-checks'
const PUBLISH_STEP = 'publish-ready-for-merge'
const DEVELOP_STEP = 'develop'

/** The Flow's agent steps and the role each launches. */
export const AGENT_STEP_ROLES: Readonly<Record<string, string>> = {
  [DEVELOP_STEP]: 'developer',
  'code-review': 'code-reviewer',
  'security-review': 'security-reviewer'
}

/** The code the driver's exit record gives a run that ended on a failed step. */
export const STEP_FAILED = 'step_failed'

const HANDOFF_HALT_PREFIX = 'handoff:'

/** The halt reason a run control carries when the handoff halted it for `reason`. */
export const handoffHaltReason = (reason: string): string => `${HANDOFF_HALT_PREFIX}${reason}`

/** The pause reason a halt reason names, or null for a halt the handoff did not raise. */
const handoffCodeOf = (haltReason: string | undefined): string | null =>
  haltReason?.startsWith(HANDOFF_HALT_PREFIX) ? haltReason.slice(HANDOFF_HALT_PREFIX.length) : null

/** How a leg ended, as the driver's exit record states it. */
export interface LegExit {
  reason: DriverExitReason
  /** The decision the exit record names: `publish`, `pause(<reason>)`, `cancel` or `error`. */
  lastDecision: string
  exitCode?: number
  /** True when the run ended on a failed step rather than a decision. */
  failedStep?: boolean
}

interface Assessment {
  decision: string
  events: DevReviewLoopEventInput[]
}

/** The events a deciding step recorded with its decision, or null when it recorded none or something unreadable. */
function readAssessment(steps: RecordedSteps, step: string = ASSESS_STEP): Assessment | null {
  const stdout = steps[step]?.stdout
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as { decision?: { type?: unknown; reason?: unknown }; events?: unknown }
    if (!Array.isArray(parsed.events) || typeof parsed.decision?.type !== 'string') return null
    // The loop's own events, and the role attempt a reviewer step that gave no usable review leaves.
    const events = parsed.events.filter(
      (event): event is DevReviewLoopEventInput =>
        typeof event === 'object' &&
        event !== null &&
        ['dev_review_loop', 'role_attempt'].includes(String((event as { kind?: unknown }).kind))
    )
    const decision =
      parsed.decision.type === 'pause' ? `pause(${String(parsed.decision.reason)})` : parsed.decision.type
    return { decision, events }
  } catch {
    return null
  }
}

interface LiveOutcome {
  /** What the live-check step decided: the head stands for publication, goes back to the Developer, or pauses. */
  decision: string
  /** The events to log now: the assessment's, with an approval a failed line withdrew already rewritten. */
  events: DevReviewLoopEventInput[]
}

/** The live-check step's recorded outcome, or null when it recorded none or something unreadable. */
function readLiveOutcome(steps: RecordedSteps): LiveOutcome | null {
  const stdout = steps[LIVE_STEP]?.stdout
  if (!stdout) return null
  try {
    const parsed = JSON.parse(stdout) as { outcome?: unknown; events?: unknown }
    if (typeof parsed.outcome !== 'string' || !Array.isArray(parsed.events)) return null
    const decision = parsed.outcome === 'revise' ? 'dispatch_developer' : parsed.outcome
    return {
      decision: decision === 'pause' ? 'pause(max_rounds)' : decision,
      events: parsed.events as DevReviewLoopEventInput[]
    }
  } catch {
    return null
  }
}

/** Producers for one run of the Flow, with the state a run builds up across its legs. */
export function createVinayaLogProducers(
  config: Pick<LoopConfig, 'loopId' | 'task'>
): LogProducers & { exit: (context: RunEndContext) => LegExit } {
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

  /** Takes the totals a later journal close needs from `events`, and returns them as Log events. */
  const absorbed = (events: readonly DevReviewLoopEventInput[]): LogEventInput[] => {
    for (const event of events) {
      if (event.event === 'gate_result_read') finalHead = event.head
      if (event.event === 'round_ended') {
        roundsEnded += 1
        totalWallMs += event.wall_ms
        filesChanged += event.files_changed
        finalHead = event.head
      }
      if (event.event === 'journal_finalized') finalized = true
    }
    return events as unknown as LogEventInput[]
  }

  /**
   * A deciding step's events. A publish decision waits for the live check: whether the approval stands is not
   * known yet, so the events are logged by that step, and only the head they name is kept for a close.
   */
  const assessed = (steps: RecordedSteps, step: string): LogEventInput[] => {
    const assessment = readAssessment(steps, step)
    if (assessment === null) return []
    lastDecision = assessment.decision
    if (step === ASSESS_STEP && assessment.decision === 'publish') {
      for (const event of assessment.events) if (event.event === 'gate_result_read') finalHead = event.head
      return []
    }
    return absorbed(assessment.events)
  }

  /** The live check's outcome: the events it settled on, with the journal's close left for the publish step. */
  const liveChecked = (steps: RecordedSteps): LogEventInput[] => {
    const outcome = readLiveOutcome(steps)
    if (outcome === null) return []
    lastDecision = outcome.decision
    return absorbed(outcome.events)
  }

  /** The journal's close, written only once the publication succeeded: the publish step hands on what it held. */
  const published = (steps: RecordedSteps): LogEventInput[] => {
    const stdout = steps[PUBLISH_STEP]?.stdout
    if (!stdout) return []
    try {
      const parsed = JSON.parse(stdout) as { events?: unknown }
      return Array.isArray(parsed.events) ? absorbed(parsed.events as DevReviewLoopEventInput[]) : []
    } catch {
      return []
    }
  }

  return {
    legStarted: ({ resumed }) => {
      lastDecision = null
      return resumed ? [loop({ event: 'resumed', round, by: 'principal' })] : []
    },
    // The driver's liveness is the timed heartbeat the runner emits and its exit record; no node writes either.
    nodeStarted: ({ nodeId, attempt: started }) => {
      if (nodeId === DEVELOP_STEP) round = Math.max(1, started)
      return []
    },
    nodeCompleted: ({ nodeId, steps }) =>
      DECIDING_STEPS.includes(nodeId)
        ? assessed(steps, nodeId)
        : nodeId === LIVE_STEP
          ? liveChecked(steps)
          : nodeId === PUBLISH_STEP
            ? published(steps)
            : [],
    nodeFailed: ({ nodeId, steps }) =>
      DECIDING_STEPS.includes(nodeId) ? assessed(steps, nodeId) : nodeId === LIVE_STEP ? liveChecked(steps) : [],
    runEnded: ({ outcome, cancelled }) => {
      if (cancelled) return [loop({ event: 'cancelled', round, by: 'principal' })]
      switch (outcome.reason) {
        case 'completed':
          return []
        case 'paused': {
          // A decided pause already wrote its own `paused`; a pause the handoff raised for an error wrote none.
          if (lastDecision?.startsWith('pause(')) return []
          const code = handoffCodeOf(outcome.haltReason)
          return code === null ? [paused('halt')] : [paused(code), ...closeJournal()]
        }
        case 'exhausted':
          return [
            loop({ event: 'stop_condition_met', round, condition: 'max_rounds' }),
            paused('max_rounds'),
            ...closeJournal()
          ]
        default: {
          // A decided pause already wrote its own `paused`, `round_ended` and `journal_finalized`; a crash wrote none.
          if (lastDecision?.startsWith('pause(')) return []
          return [paused('infrastructure'), ...closeJournal()]
        }
      }
    },
    exit: ({ outcome, cancelled }) => {
      if (cancelled) return { reason: 'signal', lastDecision: 'cancel' }
      switch (outcome.reason) {
        case 'completed':
          return { reason: 'finished', lastDecision: 'publish', exitCode: 0 }
        case 'paused': {
          if (lastDecision?.startsWith('pause(')) return { reason: 'paused', lastDecision }
          return { reason: 'paused', lastDecision: `pause(${handoffCodeOf(outcome.haltReason) ?? 'halt'})` }
        }
        case 'exhausted':
          return { reason: 'paused', lastDecision: 'pause(max_rounds)' }
        default:
          if (lastDecision?.startsWith('pause(')) return { reason: 'paused', lastDecision }
          return { reason: 'error', lastDecision: 'error', exitCode: 1, failedStep: true }
      }
    }
  }
}
