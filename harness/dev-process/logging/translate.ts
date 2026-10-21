import type { ActionRegistry, ActionResult } from '../engine-runtime/run-process'

// Turns what a Flow run does into Log events. The Engine reports a node
// starting, completing or failing, the actions record what they returned, and
// a leg of the run ends in an outcome; the translator hands each of those to
// the producers a process supplies and passes whatever events they return to
// an injected emit function, in the order they were produced. It knows no
// particular process: which events exist, and what they carry, is the
// producers' business. It writes nothing itself and never reaches the Log; the
// emit function is the only way out.

/** A Log event before its envelope is attached: its family, its name and the fields that family defines. */
export interface LogEventInput {
  readonly kind: string
  readonly event: string
  readonly [field: string]: unknown
}

/** Where produced events go; the caller completes each with its envelope and writes it. */
export type EmitLogEvent = (event: LogEventInput) => void

/** What a step's action returned, as the translator keeps it. */
export interface RecordedStep {
  exitCode: number
  stdout: string
  stderr: string
}

/** The latest recorded result of each step, keyed by step id. */
export type RecordedSteps = Readonly<Record<string, RecordedStep>>

/** The lifecycle events the Engine reports for a node. */
export type NodeLifecycle =
  | { type: 'node:start'; nodeId: string; runId: string }
  | { type: 'node:streaming'; nodeId: string; runId: string; content: string }
  | { type: 'node:complete'; nodeId: string; runId: string }
  | { type: 'node:failed'; nodeId: string; runId: string; error: string }

/** What a producer is told about the node an event concerns. */
export interface NodeContext {
  nodeId: string
  runId: string
  /** How many times this node has started in the run, this start included, across every leg. */
  attempt: number
  steps: RecordedSteps
}

export interface FailedNodeContext extends NodeContext {
  error: string
}

export interface LegContext {
  /** True when this leg continues a run that was halted. */
  resumed: boolean
  steps: RecordedSteps
}

/** How a leg ended, as the Engine's outcome reports it. */
export interface LegOutcome {
  reason: 'paused' | 'resumed' | 'completed' | 'failed' | 'exhausted'
  /** The thrown message, on a failed leg. */
  error?: string
  /** The reason the halt carried, on a paused leg. */
  haltReason?: string
  /** Results the run's checkpoint holds, keyed by step id. */
  checkpoint?: { results: Readonly<Record<string, { exitCode: number; stdout?: string; stderr?: string }>> }
}

export interface RunEndContext {
  outcome: LegOutcome
  /** True when the caller cancelled the leg rather than halting it. */
  cancelled: boolean
  steps: RecordedSteps
}

/** The events a process produces at each point of a run; each member may be absent. */
export interface LogProducers {
  legStarted?: (context: LegContext) => LogEventInput[]
  nodeStarted?: (context: NodeContext) => LogEventInput[]
  nodeCompleted?: (context: NodeContext) => LogEventInput[]
  nodeFailed?: (context: FailedNodeContext) => LogEventInput[]
  runEnded?: (context: RunEndContext) => LogEventInput[]
}

export interface LogTranslator {
  /** Begins a leg; call before the leg runs, with `resumed` true for a continuation of a halted run. */
  beginLeg: (options?: { resumed?: boolean }) => void
  /** The Engine's `onEvent` callback. */
  onEvent: (event: NodeLifecycle) => void
  /** Records what a step's action returned; the actions wrapper below calls it. */
  recordStep: (nodeId: string, result: RecordedStep) => void
  /** Ends a leg with the Engine's outcome; `cancelled` is true when the caller aborted it. */
  endLeg: (outcome: LegOutcome, options?: { cancelled?: boolean }) => void
  /** Every event handed to emit so far, in order. */
  readonly produced: readonly LogEventInput[]
}

export function createLogTranslator(producers: LogProducers, emit: EmitLogEvent): LogTranslator {
  const steps: Record<string, RecordedStep> = {}
  const starts = new Map<string, number>()
  const produced: LogEventInput[] = []

  const send = (events: LogEventInput[] | undefined): void => {
    for (const event of events ?? []) {
      produced.push(event)
      emit(event)
    }
  }
  const node = (nodeId: string, runId: string): NodeContext => ({
    nodeId,
    runId,
    attempt: starts.get(nodeId) ?? 0,
    steps: { ...steps }
  })

  return {
    produced,
    beginLeg: (options) => send(producers.legStarted?.({ resumed: options?.resumed ?? false, steps: { ...steps } })),
    onEvent: (event) => {
      if (event.type === 'node:start') starts.set(event.nodeId, (starts.get(event.nodeId) ?? 0) + 1)
      const context = node(event.nodeId, event.runId)
      if (event.type === 'node:start') send(producers.nodeStarted?.(context))
      else if (event.type === 'node:complete') send(producers.nodeCompleted?.(context))
      else if (event.type === 'node:failed') send(producers.nodeFailed?.({ ...context, error: event.error }))
    },
    recordStep: (nodeId, result) => {
      steps[nodeId] = result
    },
    endLeg: (outcome, options) => {
      // The checkpoint holds only the latest result of each step, so it fills a gap and never replaces a recorded one.
      for (const [nodeId, result] of Object.entries(outcome.checkpoint?.results ?? {})) {
        if (!(nodeId in steps)) {
          steps[nodeId] = { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
        }
      }
      send(producers.runEnded?.({ outcome, cancelled: options?.cancelled ?? false, steps: { ...steps } }))
    }
  }
}

/** What a failing action attaches to its error to keep the output it had produced. */
export interface ActionFailure extends Error {
  stdout: string
}

/**
 * Wraps an action registry so each action's result reaches the translator as the step's recorded
 * result. An action that throws after producing output records it by attaching `stdout` to its error.
 */
export function recordingActions(
  actions: ActionRegistry,
  translator: Pick<LogTranslator, 'recordStep'>
): ActionRegistry {
  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      async (context: Parameters<typeof action>[0]): Promise<ActionResult> => {
        try {
          const result = await action(context)
          translator.recordStep(context.nodeId, {
            exitCode: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? ''
          })
          return result
        } catch (error) {
          const stdout = (error as Partial<ActionFailure> | null)?.stdout
          translator.recordStep(context.nodeId, {
            exitCode: 1,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: error instanceof Error ? error.message : String(error)
          })
          throw error
        }
      }
    ])
  )
}
