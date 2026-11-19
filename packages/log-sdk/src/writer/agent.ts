import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import type { SpanParent } from '../contract/ids.js'
import {
  type Attrs,
  emitEvent,
  endSpan,
  runSpanRef,
  setOpenAttributes,
  startSpan,
  type WriterCore
} from './attributes.js'

export type AgentSent = {
  /** The seat the agent sits in; the span name and `gen_ai.agent.name` carry it. */
  seat: string
  provider?: string
  model?: string
  codingAgent?: string
  codingAgentVersion?: string
  /** Defaults to the open round. */
  round?: number
  id?: string
  /** The span the agent belongs to, which another process may have started; with none, the open round, else the run. */
  parent?: SpanParent
  spanId?: string
  key?: string
  startTime?: TimeInput
}

export type StepStarted = {
  tool: string
  callId?: string
  /** reading, searching, editing, creating, removing, running tests, type-checking, git, GitHub, tool request, skill, fetching, delegating, reporting, running, writing, checking or publishing */
  kind?: string
  /** The file or command the step works on. */
  target?: string
  spanId?: string
  key?: string
  startTime?: TimeInput
  /** The agent span the step belongs to, which another process may have started; with none, the handle's current agent span. */
  parent?: SpanParent
}

export type StepEnded = { errorType?: string; errorLine?: string; endTime?: TimeInput }

export type AgentReturned = {
  /** change opened, round pushed, verdict, escalation, plan or done */
  outcome?: string
  attempt?: number
  responseModel?: string
  agent?: SpanParent
  endTime?: TimeInput
}

export type AgentFailed = {
  /** timeout, crash, refused, wrote outside its place or usage limit */
  errorType: string
  /** When a usage limit resets, as an ISO time. */
  resetAt?: string
  attempt?: number
  agent?: SpanParent
  endTime?: TimeInput
}

export type UsageRecorded = {
  /** The started record's nanosecond timestamp when the span lives in another writer. */
  spanStart?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cost?: { amount: number; kind: 'exact' | 'estimated' }
  /** Why usage is unknown, as a short code; with it no figure is recorded. */
  unknownReason?: string
  agent?: SpanParent
}

export type ConfidenceStated = {
  /** 0 to 100; absent when the agent gave none. */
  confidence?: number
  reason?: string
  afterExtraTurn?: boolean
  agent?: SpanParent
}

/** An agent turn is an `invoke_agent {seat}` span under the open round, else the run. */
export function sent(core: WriterCore, options: AgentSent): SpanParent {
  core.moment.seat = options.seat
  try {
    const ref = startSpan(core, {
      name: spanName(S.agent, options.seat),
      startedEvent: E.agentStarted,
      attrs: {
        [A.operationName]: 'invoke_agent',
        [A.agentName]: options.seat,
        [A.agentId]: options.id,
        [A.providerName]: options.provider,
        [A.requestModel]: options.model,
        [A.codingAgent]: options.codingAgent,
        [A.codingAgentVersion]: options.codingAgentVersion,
        [A.roundNumber]: options.round ?? core.moment.round
      },
      parent: options.parent ?? core.current.round ?? runSpanRef(core),
      spanId: options.spanId,
      key: options.key,
      startTime: options.startTime
    })
    core.current.agent = ref
    return ref
  } catch (e) {
    delete core.moment.seat
    throw e
  }
}

/** Token usage goes on the agent span as GenAI usage attributes; it is the one place for tokens. */
export function usageRecorded(core: WriterCore, usage: UsageRecorded): void {
  const ref = usage.agent ?? core.current.agent
  if (ref === undefined) throw new Error('no agent is open')
  if (usage.spanStart !== undefined && !core.open.has(ref.spanId)) {
    emitEvent(core, E.usageRecorded, { ...usageAttributes(usage), [A.usageSpanStart]: usage.spanStart }, ref)
    return
  }
  setOpenAttributes(core, ref, usageAttributes(usage))
}

function usageAttributes(usage: UsageRecorded): Attrs {
  // A reason for unknown usage and a figure never ride together: the reason wins.
  const unknown = usage.unknownReason !== undefined
  return {
    [A.usageInputTokens]: unknown ? undefined : usage.inputTokens,
    [A.usageOutputTokens]: unknown ? undefined : usage.outputTokens,
    [A.usageCacheReadInputTokens]: unknown ? undefined : usage.cacheReadInputTokens,
    [A.usageCost]: unknown ? undefined : usage.cost?.amount,
    [A.usageCostKind]: unknown ? undefined : usage.cost?.kind,
    [A.usageUnknownReason]: usage.unknownReason
  }
}

/** The agent span ends with what came out of the turn. */
export function returned(core: WriterCore, options: AgentReturned = {}): void {
  const ref = options.agent ?? core.current.agent
  if (ref === undefined) throw new Error('no agent is open')
  endSpan(
    core,
    ref,
    {
      [A.agentOutcome]: options.outcome,
      [A.attempt]: options.attempt,
      [A.responseModel]: options.responseModel
    },
    options.endTime
  )
}

/** The agent span ends with an error type. */
export function failed(core: WriterCore, options: AgentFailed): void {
  const ref = options.agent ?? core.current.agent
  if (ref === undefined) throw new Error('no agent is open')
  endSpan(
    core,
    ref,
    { [A.agentResetAt]: options.resetAt, [A.attempt]: options.attempt },
    options.endTime,
    options.errorType
  )
}

/** An agent step is an `execute_tool {tool}` span under its agent. */
export function stepStarted(core: WriterCore, options: StepStarted): SpanParent {
  return startSpan(core, {
    name: spanName(S.step, options.tool),
    startedEvent: E.stepStarted,
    attrs: {
      [A.operationName]: 'execute_tool',
      [A.toolName]: options.tool,
      [A.toolCallId]: options.callId,
      [A.stepKind]: options.kind,
      [A.stepTarget]: options.target
    },
    parent: options.parent ?? core.current.agent ?? core.current.round ?? runSpanRef(core),
    spanId: options.spanId,
    key: options.key,
    startTime: options.startTime
  })
}

export function stepEnded(core: WriterCore, step: SpanParent, options: StepEnded = {}): void {
  endSpan(core, step, { [A.stepErrorLine]: options.errorLine }, options.endTime, options.errorType)
}

/** The agent states how confident it is, as an event on its span. */
export function confidenceStated(core: WriterCore, detail: ConfidenceStated = {}): void {
  emitEvent(
    core,
    E.confidenceStated,
    {
      [A.confidence]: detail.confidence,
      [A.confidenceReason]: detail.reason,
      [A.confidenceAfterExtraTurn]: detail.afterExtraTurn
    },
    detail.agent ?? core.current.agent ?? runSpanRef(core)
  )
}
