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
  step: 'execute_tool',
  checkHook: 'vinaya.checks.hook',
  checkLocal: 'vinaya.checks.local',
  checkPush: 'vinaya.checks.push',
  checkCi: 'vinaya.checks.ci',
  personAuthority: 'vinaya.person.authority',
  personStrategy: 'vinaya.person.strategy',
  personProduct: 'vinaya.person.product'
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
  confidenceStated: 'vinaya.agent.confidence_stated',
  reviewVerdicts: 'vinaya.review.verdicts',
  findingsCompared: 'vinaya.review.findings_compared',
  checksStarted: 'vinaya.checks.started',
  checkNotPassed: 'vinaya.checks.not_passed',
  checkResultRead: 'vinaya.checks.result_read',
  personAsked: 'vinaya.person.asked',
  forgeAction: 'vinaya.outside.forge',
  verifiedAction: 'vinaya.outside.verified',
  commandCompleted: 'vinaya.outside.command_completed',
  changeSaved: 'vinaya.change.saved',
  changePushed: 'vinaya.change.pushed',
  changeOpened: 'vinaya.change.opened',
  changeConflicted: 'vinaya.change.conflicted',
  changeRecovered: 'vinaya.change.recovered',
  changeMerged: 'vinaya.change.merged',
  changeReverted: 'vinaya.change.reverted',
  changeIncident: 'vinaya.change.incident'
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
  spanKey: 'vinaya.span.key',
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
  confidence: 'vinaya.confidence',
  seats: 'vinaya.review.seats',
  verdicts: 'vinaya.review.verdicts',
  blockingCount: 'vinaya.review.blocking_count',
  findingIds: 'vinaya.review.finding_ids',
  findingSeverities: 'vinaya.review.finding_severities',
  findingPlaces: 'vinaya.review.finding_places',
  findingBlocking: 'vinaya.review.finding_blocking',
  findingsOpen: 'vinaya.review.open',
  findingsResolved: 'vinaya.review.resolved',
  findingsNew: 'vinaya.review.new',
  findingsRecurring: 'vinaya.review.recurring',
  checkWhere: 'vinaya.checks.where',
  checksRan: 'vinaya.checks.ran',
  checksPassed: 'vinaya.checks.passed',
  checksFailed: 'vinaya.checks.failed',
  checksSkipped: 'vinaya.checks.skipped',
  failedNames: 'vinaya.checks.failed_names',
  waitMs: 'vinaya.checks.wait_ms',
  reruns: 'vinaya.checks.reruns',
  checkName: 'vinaya.checks.name',
  result: 'vinaya.result',
  change: 'vinaya.change.id',
  branch: 'vinaya.change.branch',
  commit: 'vinaya.change.commit',
  actor: 'vinaya.actor',
  severity: 'vinaya.severity',
  questionKind: 'vinaya.person.kind',
  questionKey: 'vinaya.person.key',
  answeredBy: 'vinaya.person.answered_by',
  target: 'vinaya.outside.target',
  action: 'vinaya.outside.action'
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

/** Reserved namespace for earlier-format events and fields. */
export const EARLIER_EVENT_PREFIX = 'vinaya.earlier.'
export const EARLIER_WRITER_PREFIX = 'earlier:'
