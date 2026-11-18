import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES, EVENT_NAMES, SPAN_NAMES } from '../contract/catalogue.js'
import type { SpanParent } from '../contract/ids.js'
import { emitEvent, endSpan, runSpanRef, setOpenAttributes, startSpan, type WriterCore } from './attributes.js'
import type { EndOptions } from './run.js'

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
}

export type StartAgentOptions = {
  name: string
  id?: string
  spanId?: string
  key?: string
  startTime?: TimeInput
}

export type StartStepOptions = {
  tool: string
  toolType?: string
  spanId?: string
  key?: string
  startTime?: TimeInput
  /** The agent span the step belongs to, which another process may have started; with none, the handle's current agent span. */
  parent?: SpanParent
}

function usageAttributes(usage: TokenUsage) {
  return {
    [ATTRIBUTE_NAMES.usageInputTokens]: usage.inputTokens,
    [ATTRIBUTE_NAMES.usageOutputTokens]: usage.outputTokens,
    [ATTRIBUTE_NAMES.usageCacheReadInputTokens]: usage.cacheReadInputTokens,
    [ATTRIBUTE_NAMES.usageCacheWriteInputTokens]: usage.cacheWriteInputTokens
  }
}

/** An agent turn is an `invoke_agent` span under the current phase, round or run. */
export function startAgent(core: WriterCore, options: StartAgentOptions): SpanParent {
  const ref = startSpan(core, {
    name: SPAN_NAMES.agent,
    startedEvent: EVENT_NAMES.agentStarted,
    attrs: {
      [ATTRIBUTE_NAMES.operationName]: 'invoke_agent',
      [ATTRIBUTE_NAMES.agentName]: options.name,
      [ATTRIBUTE_NAMES.agentId]: options.id
    },
    parent: core.current.phase ?? core.current.round ?? runSpanRef(core),
    spanId: options.spanId,
    key: options.key,
    startTime: options.startTime
  })
  core.current.agent = ref
  return ref
}

/** Token usage goes on the agent span as GenAI usage attributes; the figures are the turn's totals. */
export function recordUsage(core: WriterCore, usage: TokenUsage, agent?: SpanParent): void {
  const ref = agent ?? core.current.agent
  if (ref === undefined) throw new Error('no agent is open')
  setOpenAttributes(core, ref, usageAttributes(usage))
}

export function endAgent(core: WriterCore, options: EndOptions & { usage?: TokenUsage } = {}): void {
  const ref = core.current.agent
  if (ref === undefined) throw new Error('no agent is open')
  endSpan(core, ref, options.usage ? usageAttributes(options.usage) : {}, options.endTime, options.errorType)
}

/** An agent step is an `execute_tool` span under its agent. */
export function startStep(core: WriterCore, options: StartStepOptions): SpanParent {
  return startSpan(core, {
    name: SPAN_NAMES.step,
    startedEvent: EVENT_NAMES.stepStarted,
    attrs: {
      [ATTRIBUTE_NAMES.operationName]: 'execute_tool',
      [ATTRIBUTE_NAMES.toolName]: options.tool,
      [ATTRIBUTE_NAMES.toolType]: options.toolType
    },
    parent: options.parent ?? core.current.agent ?? core.current.phase ?? core.current.round ?? runSpanRef(core),
    spanId: options.spanId,
    key: options.key,
    startTime: options.startTime
  })
}

export function endStep(core: WriterCore, step: SpanParent, options: EndOptions = {}): void {
  endSpan(core, step, {}, options.endTime, options.errorType)
}

/** The agent states how confident it is, as an event on its span. */
export function confidenceStated(core: WriterCore, detail: { confidence: number; agent?: SpanParent }): void {
  emitEvent(
    core,
    EVENT_NAMES.confidenceStated,
    { [ATTRIBUTE_NAMES.confidence]: detail.confidence },
    detail.agent ?? core.current.agent ?? runSpanRef(core)
  )
}
