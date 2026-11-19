/**
 * Every span name, event name and attribute name the Log SDK writes. Plain
 * constants and types only: the harness, the Log server and Studio follow
 * this file by relative path, so it imports nothing.
 */

/** The version of the GenAI semantic conventions these names follow. */
export const GENAI_CONVENTIONS_VERSION = 'semantic-conventions-genai@main-2026-11-18'

/** The SDK's own version, recorded on every handle's resource. */
export const SDK_VERSION = '0.0.0'

/**
 * The base of every span name. A span's full name adds the part the product
 * table fills in after a space: `vinaya.round 3`, `invoke_agent reviewer`,
 * `execute_tool Bash`, `vinaya.checks ci`, `vinaya.person strategy`,
 * `vinaya.phase review`.
 */
export const SPAN_NAMES = {
  run: 'invoke_workflow',
  round: 'vinaya.round',
  phase: 'vinaya.phase',
  agent: 'invoke_agent',
  step: 'execute_tool',
  checks: 'vinaya.checks',
  person: 'vinaya.person',
  pause: 'vinaya.pause'
} as const

/** A span's full name: the base, then the filled-in part when there is one. */
export function spanName(base: (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES], part?: string | number): string {
  return part === undefined || part === '' ? base : `${base} ${part}`
}

export const EVENT_NAMES = {
  runStarted: 'vinaya.run.started',
  roundStarted: 'vinaya.round.started',
  agentStarted: 'vinaya.agent.started',
  stepStarted: 'vinaya.step.started',
  pauseStarted: 'vinaya.pause.started',
  personAsked: 'vinaya.person.asked',
  alive: 'vinaya.run.alive',
  stageChanged: 'vinaya.run.stage_changed',
  cancelled: 'vinaya.run.cancelled',
  retried: 'vinaya.run.retried',
  stopRuleMet: 'vinaya.run.stop_rule_met',
  exited: 'vinaya.run.exited',
  confidenceStated: 'vinaya.agent.confidence_stated',
  reviewVerdicts: 'vinaya.review.verdicts',
  findingsCompared: 'vinaya.review.findings_compared',
  checkNotPassed: 'vinaya.checks.not_passed',
  checkRead: 'vinaya.checks.read',
  forgeValidated: 'vinaya.forge.validated',
  forgeRefused: 'vinaya.forge.refused',
  forgeWritten: 'vinaya.forge.written',
  actionVerified: 'vinaya.action.verified',
  commandCompleted: 'vinaya.command.completed',
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
  providerName: 'gen_ai.provider.name',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  toolName: 'gen_ai.tool.name',
  toolCallId: 'gen_ai.tool.call.id',
  usageInputTokens: 'gen_ai.usage.input_tokens',
  usageOutputTokens: 'gen_ai.usage.output_tokens',
  usageCacheReadInputTokens: 'gen_ai.usage.cache_read.input_tokens',
  errorType: 'error.type',
  // Resource
  serviceName: 'service.name',
  serviceVersion: 'service.version',
  hostId: 'host.id',
  repository: 'vinaya.repository',
  sdkVersion: 'vinaya.sdk.version',
  semconvVersion: 'vinaya.semconv.version',
  // Stamps every record carries
  seq: 'vinaya.seq',
  spanKey: 'vinaya.span.key',
  writerId: 'vinaya.writer.id',
  provenance: 'vinaya.provenance',
  trust: 'vinaya.trust',
  eventId: 'vinaya.event.id',
  workRef: 'vinaya.work.ref',
  workTitle: 'vinaya.work.title',
  workChange: 'vinaya.work.change',
  workCommit: 'vinaya.work.commit',
  round: 'vinaya.round',
  seat: 'vinaya.seat',
  inputBrief: 'vinaya.input.brief',
  inputObjectives: 'vinaya.input.objectives',
  inputRuling: 'vinaya.input.ruling',
  inputPolicy: 'vinaya.input.policy',
  // Run
  runId: 'vinaya.run.id',
  processName: 'vinaya.process.name',
  processVersion: 'vinaya.process.version',
  roundLimit: 'vinaya.run.round_limit',
  runSeats: 'vinaya.run.seats',
  runSeatModels: 'vinaya.run.seat_models',
  runRounds: 'vinaya.run.rounds',
  runTotalMs: 'vinaya.run.total_ms',
  runTimeToGreenMs: 'vinaya.run.time_to_green_ms',
  runFilesChanged: 'vinaya.run.files_changed',
  runOutcome: 'vinaya.run.outcome',
  stageFrom: 'vinaya.stage.from',
  stageTo: 'vinaya.stage.to',
  pauseWhy: 'vinaya.pause.why',
  pauseBy: 'vinaya.pause.by',
  actor: 'vinaya.actor',
  retryFailed: 'vinaya.retry.failed',
  retryTries: 'vinaya.retry.tries',
  retryRecovered: 'vinaya.retry.recovered',
  rule: 'vinaya.rule',
  exitCode: 'vinaya.exit.code',
  exitKind: 'vinaya.exit.kind',
  // Round and phase
  roundNumber: 'vinaya.round.number',
  roundStartCommit: 'vinaya.round.start_commit',
  roundFilesChanged: 'vinaya.round.files_changed',
  roundLinesAdded: 'vinaya.round.lines_added',
  roundLinesRemoved: 'vinaya.round.lines_removed',
  roundOutcome: 'vinaya.round.outcome',
  phaseName: 'vinaya.phase.name',
  phaseStep: 'vinaya.phase.step',
  // Agent
  codingAgent: 'vinaya.agent.coding_agent',
  codingAgentVersion: 'vinaya.agent.coding_agent_version',
  agentOutcome: 'vinaya.agent.outcome',
  agentResetAt: 'vinaya.agent.reset_at',
  attempt: 'vinaya.attempt',
  stepKind: 'vinaya.step.kind',
  stepTarget: 'vinaya.step.target',
  stepErrorLine: 'vinaya.step.error_line',
  confidence: 'vinaya.confidence',
  confidenceReason: 'vinaya.confidence.reason',
  confidenceAfterExtraTurn: 'vinaya.confidence.after_extra_turn',
  usageCost: 'vinaya.usage.cost',
  usageCostKind: 'vinaya.usage.cost_kind',
  usageUnknownReason: 'vinaya.usage.unknown_reason',
  // Review
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
  // Checks
  checkWhere: 'vinaya.checks.where',
  checksRan: 'vinaya.checks.ran',
  checksPassed: 'vinaya.checks.passed',
  checksFailed: 'vinaya.checks.failed',
  checksSkipped: 'vinaya.checks.skipped',
  failedNames: 'vinaya.checks.failed_names',
  waitMs: 'vinaya.checks.wait_ms',
  checkName: 'vinaya.checks.name',
  checkVersion: 'vinaya.checks.version',
  checksGreen: 'vinaya.checks.green',
  rerunFailed: 'vinaya.checks.rerun_failed',
  rerunAffected: 'vinaya.checks.rerun_affected',
  rerunTotal: 'vinaya.checks.rerun_total',
  result: 'vinaya.result',
  reason: 'vinaya.reason',
  // Change
  change: 'vinaya.change.id',
  branch: 'vinaya.change.branch',
  commit: 'vinaya.change.commit',
  changeTestsPicked: 'vinaya.change.tests_picked',
  changeTestsFailed: 'vinaya.change.tests_failed',
  changePushMs: 'vinaya.change.push_ms',
  changeReentry: 'vinaya.change.reentry',
  changeLink: 'vinaya.change.link',
  severity: 'vinaya.severity',
  // Person
  questionKind: 'vinaya.person.kind',
  questionKey: 'vinaya.person.key',
  personWhy: 'vinaya.person.why',
  personDecision: 'vinaya.person.decision',
  personAnswer: 'vinaya.person.answer',
  answeredBy: 'vinaya.person.answered_by',
  // Outside actions
  target: 'vinaya.outside.target',
  action: 'vinaya.outside.action'
} as const

export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES]
export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES]
export type AttributeName = (typeof ATTRIBUTE_NAMES)[keyof typeof ATTRIBUTE_NAMES]

export type RecordProvenance = 'governed' | 'reported'

/** How far a record's origin is trusted: the earlier Log's four levels. */
export type RecordTrust = 'parent_attributed' | 'env_correlated' | 'self_reported' | 'unavailable'

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

/** Whether `name` is a catalogue span base, or a base followed by its filled-in part. */
export function isSpanName(name: string): boolean {
  return ALL_SPAN_NAMES.some((base) => name === base || (name.startsWith(`${base} `) && name.length > base.length + 1))
}

/** Reserved namespace for earlier-format events and fields. */
export const EARLIER_EVENT_PREFIX = 'vinaya.earlier.'
export const EARLIER_WRITER_PREFIX = 'earlier:'
