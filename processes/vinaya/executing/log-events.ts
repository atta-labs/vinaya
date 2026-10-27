import type { DevReviewLoopEventInput, LoopConfig } from '@attalabs/aeg-core'
import type {
  LogEventInput,
  LogProducers,
  RecordedSteps,
  RunEndContext
} from '../../../harness/dev-process/logging/translate'
import { decodeExecutionRound } from '../../../harness/dev-process/engine-runtime/checkpoint-round'
import type { DriverExitReason } from '../../../apps/cli/src/lib/dev-review-loop/driver-lifecycle'
import { localChecksRunEvent, phaseOfStep, phaseTimeEvent } from '../../../apps/cli/src/lib/flow-v2-events'

// The Log events the developer review Flow's run produces, for the harness
// translator. Nothing here reaches the Log: each producer returns events
// without their envelope and the caller that wires the translator completes
// and writes them. Which old-driver event each one stands for is the table in
// `log-inventory.ts`.

const ASSESS_STEP = 'assess-round'
/** The steps that record the shared assessment's events with their decision, in the order a round reaches them. */
export const DECIDING_STEPS: readonly string[] = [
  'validate-developer-output',
  'check-mergeability',
  'assess-gate',
  'validate-reviewer-outputs',
  ASSESS_STEP,
  // Version 2's steps after an approval: the ready push, the pull request's opening and the one CI read.
  'ready-push',
  'open-pull-request',
  'read-ci-once'
]
const GATE_STEP = 'run-mechanical-gates'
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
  /** The code the exit record carries; as on the standalone driver, a finished or failed run carries none. */
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

/** The loop state fields a resumed leg's restart events name, as the deciding steps record them. */
interface RecordedLoopState {
  config: Pick<LoopConfig, 'task' | 'maxRounds' | 'reviewers' | 'models'>
  pending: { round: number; stats: { baseHead: string } } | null
}

/** The newest loop state a deciding step recorded, by sequence number; null before any. */
function recordedLoopState(steps: RecordedSteps): RecordedLoopState | null {
  let newest: { seq: number; state: RecordedLoopState } | null = null
  for (const step of DECIDING_STEPS) {
    const stdout = steps[step]?.stdout
    if (!stdout) continue
    try {
      const parsed = JSON.parse(stdout) as { seq?: unknown; state?: RecordedLoopState }
      if (typeof parsed.seq !== 'number' || typeof parsed.state?.config !== 'object') continue
      if (newest === null || parsed.seq > newest.seq) newest = { seq: parsed.seq, state: parsed.state }
    } catch {
      // An unreadable record names no state.
    }
  }
  return newest?.state ?? null
}

/** Producers for one run of the Flow, with the state a run builds up across its legs. */
export function createVinayaLogProducers(
  config: Pick<LoopConfig, 'loopId' | 'task'> & {
    /** The base a resumed leg's restarted round names when the recorded state carries none. */
    baseHead?: () => string | null
    /** The flow key the run chose (`v1`, `v2`); version 2 also logs each round's local checks. */
    flow?: string
    /** The driver counter restored before dispatch, also used by the round-ending actions. */
    reviewRound?: () => number
    /** Milliseconds since an arbitrary origin, for the time each step spends. */
    now?: () => number
    /** The head the local checks judged, for their event. */
    head?: () => string | null
  }
): LogProducers & { exit: (context: RunEndContext) => LegExit } {
  let round = 1
  let restarting = false
  let lastDecision: string | null = null
  let finalHead: string | null = null
  let roundsEnded = 0
  let totalWallMs = 0
  let filesChanged = 0
  let finalized = false
  const now = config.now ?? (() => Date.now())
  const nodeStarts = new Map<string, number>()

  /**
   * Version 2 only: the time the node spent, counted toward its phase, and the local checks' own event. Version 1's
   * Log is unchanged, so its runs never write an event a log server not yet redeployed would reject.
   */
  const timed = (nodeId: string, steps: RecordedSteps): LogEventInput[] => {
    if (config.flow !== 'v2') return []
    const started = nodeStarts.get(nodeId)
    if (started === undefined) return []
    nodeStarts.delete(nodeId)
    const wallMs = Math.max(0, now() - started)
    const loopRef = { loopId: config.loopId, round }
    const events = [phaseTimeEvent(loopRef, phaseOfStep(nodeId), nodeId, wallMs) as unknown as LogEventInput]
    if (nodeId === GATE_STEP) {
      const gate = steps[GATE_STEP]
      events.push(
        localChecksRunEvent(loopRef, config.head?.() ?? null, gate?.exitCode === 0, wallMs) as unknown as LogEventInput
      )
    }
    return events
  }

  const loop = (fields: Record<string, unknown>): LogEventInput =>
    ({ kind: 'dev_review_loop', payload: {}, loop_id: config.loopId, ...fields }) as unknown as LogEventInput

  const paused = (reasonCode: string): LogEventInput =>
    loop({ event: 'paused', round, reason: 'principal_item', reason_code: reasonCode })

  /**
   * A resumed leg starts its loop and its round again before its first event, as a restarted standalone driver
   * does; it names them from the recorded loop state, and says nothing when no state was recorded yet.
   */
  const restarted = (steps: RecordedSteps, events: LogEventInput[]): LogEventInput[] => {
    if (!restarting || events.length === 0) return events
    restarting = false
    const state = recordedLoopState(steps)
    if (state === null) return events
    const baseHead = state.pending?.stats.baseHead ?? config.baseHead?.() ?? null
    return [
      loop({
        event: 'loop_started',
        task: state.config.task,
        policy: { max_rounds: state.config.maxRounds, reviewers: state.config.reviewers, models: state.config.models }
      }),
      ...(baseHead === null
        ? []
        : [loop({ event: 'round_started', round: state.pending?.round ?? round, base_head: baseHead })]),
      ...events
    ]
  }

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
      restarting = resumed
      if (config.flow === 'v2') round = config.reviewRound?.() ?? round
      return resumed ? [loop({ event: 'resumed', round, by: 'principal' })] : []
    },
    // The driver's liveness is the timed heartbeat the runner emits and its exit record; no node writes either.
    nodeStarted: ({ nodeId, attempt: started, steps = {} }) => {
      if (config.flow === 'v2') {
        // The driver restores its counter before the translator begins a resumed leg. Its cache may be empty.
        // Read before the node runs so the handoff's own time stays in the round it closes.
        round =
          config.reviewRound?.() ??
          Math.max(1, ...Object.values(steps).map((step) => decodeExecutionRound(step.stderr)?.round ?? 1))
      } else if (nodeId === DEVELOP_STEP) round = Math.max(1, started)
      nodeStarts.set(nodeId, now())
      return []
    },
    nodeCompleted: ({ nodeId, steps }) => [
      ...restarted(
        steps,
        DECIDING_STEPS.includes(nodeId)
          ? assessed(steps, nodeId)
          : nodeId === LIVE_STEP
            ? liveChecked(steps)
            : nodeId === PUBLISH_STEP
              ? published(steps)
              : []
      ),
      ...timed(nodeId, steps)
    ],
    nodeFailed: ({ nodeId, steps }) => [
      ...restarted(
        steps,
        DECIDING_STEPS.includes(nodeId) ? assessed(steps, nodeId) : nodeId === LIVE_STEP ? liveChecked(steps) : []
      ),
      ...timed(nodeId, steps)
    ],
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
          return { reason: 'finished', lastDecision: 'publish' }
        case 'paused': {
          if (lastDecision?.startsWith('pause(')) return { reason: 'paused', lastDecision }
          return { reason: 'paused', lastDecision: `pause(${handoffCodeOf(outcome.haltReason) ?? 'halt'})` }
        }
        case 'exhausted':
          return { reason: 'paused', lastDecision: 'pause(max_rounds)' }
        default:
          if (lastDecision?.startsWith('pause(')) return { reason: 'paused', lastDecision }
          return { reason: 'error', lastDecision: 'error', failedStep: true }
      }
    }
  }
}
