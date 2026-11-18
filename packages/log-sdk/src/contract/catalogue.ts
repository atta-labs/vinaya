/**
 * Every span name, event name and attribute name the Log SDK writes. Plain
 * constants and types only: the harness, the Log server and Studio follow
 * this file by relative path, so it imports nothing.
 */

/** The version of the GenAI semantic conventions these names follow. */
export const GENAI_CONVENTIONS_VERSION = 'semantic-conventions-genai@main-2026-11-18'

/** The SDK's own version, recorded on every handle's resource. */
export const SDK_VERSION = '0.0.0'

export const SPAN_NAMES = {
  run: 'invoke_workflow',
  round: 'vinaya.round',
  phase: 'vinaya.phase',
  agent: 'invoke_agent',
  step: 'execute_tool'
} as const

export const EVENT_NAMES = {
  runStarted: 'vinaya.run.started',
  roundStarted: 'vinaya.round.started',
  phaseStarted: 'vinaya.phase.started',
  agentStarted: 'vinaya.agent.started',
  stepStarted: 'vinaya.step.started',
  alive: 'vinaya.run.alive',
  stageChanged: 'vinaya.run.stage_changed',
  cancelled: 'vinaya.run.cancelled',
  retried: 'vinaya.run.retried',
  stopRuleMet: 'vinaya.run.stop_rule_met',
  exited: 'vinaya.run.exited',
  confidenceStated: 'vinaya.agent.confidence_stated'
} as const

export const ATTRIBUTE_NAMES = {
  // OpenTelemetry GenAI conventions
  operationName: 'gen_ai.operation.name',
  agentName: 'gen_ai.agent.name',
  agentId: 'gen_ai.agent.id',
  toolName: 'gen_ai.tool.name',
  toolType: 'gen_ai.tool.type',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageCacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  usageCacheWriteInputTokens: 'gen_ai.usage.cache_write.input_tokens',
  errorType: 'error.type',
  // Resource
  serviceName: 'service.name',
  serviceVersion: 'service.version',
  hostId: 'host.id',
  // Stamps
  seq: 'vinaya.seq',
  writerId: 'vinaya.writer.id',
  provenance: 'vinaya.provenance',
  eventId: 'vinaya.event.id',
  workRef: 'vinaya.work.ref',
  // Vinaya namespace
  repository: 'vinaya.repository',
  sdkVersion: 'vinaya.sdk.version',
  semconvVersion: 'vinaya.semconv.version',
  runId: 'vinaya.run.id',
  roundNumber: 'vinaya.round.number',
  phaseName: 'vinaya.phase.name',
  stageFrom: 'vinaya.stage.from',
  stageTo: 'vinaya.stage.to',
  reason: 'vinaya.reason',
  rule: 'vinaya.rule',
  attempt: 'vinaya.attempt',
  exitCode: 'vinaya.exit.code',
  confidence: 'vinaya.confidence'
} as const

export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES]
export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES]
export type AttributeName = (typeof ATTRIBUTE_NAMES)[keyof typeof ATTRIBUTE_NAMES]

export type RecordProvenance = 'governed' | 'reported'

/** GenAI content attributes the Log never records: no prompt, reasoning or tool content. */
export const FORBIDDEN_CONTENT_ATTRIBUTES: readonly string[] = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.definitions'
]

export const ALL_SPAN_NAMES: readonly string[] = Object.values(SPAN_NAMES)
export const ALL_EVENT_NAMES: readonly string[] = Object.values(EVENT_NAMES)
export const ALL_ATTRIBUTE_NAMES: readonly string[] = Object.values(ATTRIBUTE_NAMES)
