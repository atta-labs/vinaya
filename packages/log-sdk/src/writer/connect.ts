import { createHash, randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { basename } from 'node:path'
import type { Context, TimeInput } from '@opentelemetry/api'
import { LoggerProvider, type LogRecordProcessor, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor
} from '@opentelemetry/sdk-trace-base'
import {
  ATTRIBUTE_NAMES,
  GENAI_CONVENTIONS_VERSION,
  type RecordProvenance,
  type RecordTrust
} from '../contract/catalogue.js'
import { SDK_VERSION } from '../contract/version.js'
import type { CustomEventDeclarations } from '../contract/custom.js'
import { createRunIdGenerator, type SpanParent, traceIdFor } from '../contract/ids.js'
import { cleanLocalCopy, copyFilePrefix, copyFolder, createFileExporters } from '../local-copy/file-exporters.js'
import * as agent from './agent.js'
import { type Attrs, guard, type InputVersions, type Work, type WriterCore } from './attributes.js'
import { carryOn } from './carried.js'
import * as change from './change.js'
import * as checks from './checks.js'
import { custom } from './custom.js'
import * as outside from './outside.js'
import * as person from './person.js'
import * as review from './review.js'
import * as round from './round.js'
import * as run from './run.js'
import { type LogsSetting, type PassedSettings, resolveSettings, type ResolvedSettings } from './settings.js'
import { writeWholeSpan } from './whole-span.js'

/** What ran the run, given by the caller; each part given is a resource attribute on every record. */
export type RunIdentity = {
  runnerName?: string
  runnerVersion?: string
  cliVersion?: string
  flowId?: string
  flowVersion?: string
  processDigest?: string
  settingsDigest?: string
  /** Whether the run is in CI; the SDK reads `CI` when this is not given. */
  ci?: boolean
}

/** OpenTelemetry's os.type value for Node's platform name. */
function osType(platform: string = process.platform): string {
  if (platform === 'win32') return 'windows'
  if (platform === 'sunos') return 'solaris'
  if (platform === 'android') return 'linux'
  return platform
}

function inCi(value: string | undefined = process.env.CI): boolean {
  return value !== undefined && value !== '' && value !== 'false'
}

function identityAttributes(identity: RunIdentity | undefined): Record<string, string> {
  const named: [string, string | undefined][] = [
    [ATTRIBUTE_NAMES.runnerName, identity?.runnerName],
    [ATTRIBUTE_NAMES.runnerVersion, identity?.runnerVersion],
    [ATTRIBUTE_NAMES.cliVersion, identity?.cliVersion],
    [ATTRIBUTE_NAMES.flowId, identity?.flowId],
    [ATTRIBUTE_NAMES.flowVersion, identity?.flowVersion],
    [ATTRIBUTE_NAMES.processDigest, identity?.processDigest],
    [ATTRIBUTE_NAMES.settingsDigest, identity?.settingsDigest]
  ]
  return Object.fromEntries(named.filter((pair): pair is [string, string] => pair[1] !== undefined))
}

export type ConnectOptions = {
  /** The run every record belongs to; the trace id derives from it alone. */
  runId: string
  /** `owner/repo`, for the resource and the default runtime directory. */
  repository?: string
  /** Where `log.config.json` and `vinaya.config.json` sit; the working directory by default. */
  repoRoot?: string
  runtimeDir?: string
  destination?: LogsSetting
  /** Days the local copy is kept; replaces `logs.keepDays` from the settings files, which a passed destination replaces too. */
  keepDays?: number
  headers?: Record<string, string>
  /** Carried on every record as vinaya.work.ref. */
  workRef?: string
  /** The work the run is for; each part named is carried on every record. */
  work?: Work
  /** The versions of what the run was given; each named one is carried on every record. */
  inputs?: InputVersions
  /** `governed` only when the caller says so; the default is `reported`. */
  provenance?: RecordProvenance
  /** How far the records' origin is trusted; `unavailable` when not given. */
  trust?: RecordTrust
  /** The handle's clock and timers; a test supplies its own. */
  timers?: run.Timers
  /** What ran the run; each part given is carried on every record as a resource attribute. */
  identity?: RunIdentity
  processName?: string
  serviceVersion?: string
  /** Additional processors for spans written to the local copy. */
  spanProcessors?: SpanProcessor[]
  /** Additional processors for events written to the local copy. */
  logRecordProcessors?: LogRecordProcessor[]
  /** Called once per failure; no handle function ever throws. */
  onError?: (error: unknown) => void
  /** The home directory redaction rewrites to `~`. */
  home?: string
  /** The Vinaya home, for the default runtime directory. */
  vinayaHome?: string
}

const NO_SPAN_ID = '0000000000000000'

export type LogHandle = {
  readonly runId: string
  readonly traceId: string
  readonly writerId: string
  /** Whether the handle records anything. */
  readonly enabled: boolean
  /** The resolved settings; `undefined` when the handle records nothing. */
  readonly settings: ResolvedSettings | undefined
  readonly run: {
    started(options?: run.StartRun): SpanParent
    ended(options?: run.EndRun): void
    alive(): void
    stageChanged(change: { from?: run.Stage; to: run.Stage; round?: number }): void
    paused(options?: run.Pause): SpanParent
    resumed(options: run.Resume): void
    cancelled(detail?: { round?: number; by?: string }): void
    retried(detail?: { failed?: string; tries?: number; recovered?: boolean }): void
    stopRuleMet(detail: { rule: run.StopRule }): void
    exited(detail: { kind: run.ExitKind; code?: number; errorType?: string }): void
  }
  readonly round: {
    started(options: round.StartRound): SpanParent
    ended(options?: round.EndRound): void
  }
  readonly phase: { ended(options: round.PhaseEnded): void }
  readonly agent: {
    sent(options: agent.AgentSent): SpanParent
    stepStarted(options: agent.StepStarted): SpanParent
    stepEnded(step: SpanParent, options?: agent.StepEnded): void
    returned(options?: agent.AgentReturned): void
    failed(options: agent.AgentFailed): void
    confidenceStated(detail?: agent.ConfidenceStated): void
  }
  readonly usage: { recorded(usage: agent.UsageRecorded): void }
  readonly review: {
    verdicts(d: review.ReviewVerdicts): void
    findingsCompared(d: review.FindingsCompared): void
  }
  readonly checks: {
    ran(d: checks.ChecksRan): void
    notPassed(d: checks.CheckNotPassed): void
    read(d: checks.ChecksRead): void
    local(d: checks.ChecksLocal): void
    ci(d: checks.ChecksCi): void
    rerun(d: checks.ChecksRerun): void
  }
  readonly change: {
    saved(d?: change.ChangeSaved): void
    pushed(d: change.ChangePushed): void
    opened(d: change.ChangeOpened): void
    conflicted(d?: change.ChangeConflicted): void
    recovered(): void
    merged(d?: change.ChangeMerged): void
    reverted(d?: change.ChangeReverted): void
    incident(d?: change.ChangeIncident): void
    closed(d?: change.ChangeClosed): void
  }
  readonly person: {
    asked(d: person.PersonAsked): SpanParent
    answered(d: person.PersonAnswered): void
  }
  readonly forge: {
    validated(d: outside.ForgeWrite): void
    refused(d: outside.ForgeRefusal): void
    written(d: outside.ForgeWrite): void
  }
  readonly action: { verified(d: outside.ActionVerified): void }
  readonly command: { completed(d: outside.CommandCompleted): void }
  readonly custom: { recorded(name: string, fields: Readonly<Record<string, unknown>>): void }
  writeSpan(
    name: string,
    own: SpanParent,
    parent: SpanParent | undefined,
    startTime: TimeInput,
    endTime: TimeInput,
    attributes?: Attrs
  ): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

function safeSpanProcessor(p: SpanProcessor, report: (e: unknown) => void): SpanProcessor {
  return {
    onStart(span: Span, ctx: Context) {
      try {
        p.onStart(span, ctx)
      } catch (e) {
        report(e)
      }
    },
    onEnd(span: ReadableSpan) {
      try {
        p.onEnd(span)
      } catch (e) {
        report(e)
      }
    },
    async forceFlush() {
      try {
        await p.forceFlush()
      } catch (e) {
        report(e)
      }
    },
    async shutdown() {
      try {
        await p.shutdown()
      } catch (e) {
        report(e)
      }
    }
  }
}

function safeLogProcessor(p: LogRecordProcessor, report: (e: unknown) => void): LogRecordProcessor {
  return {
    onEmit(record, ctx) {
      try {
        p.onEmit(record, ctx)
      } catch (e) {
        report(e)
      }
    },
    async forceFlush() {
      try {
        await p.forceFlush()
      } catch (e) {
        report(e)
      }
    },
    async shutdown() {
      try {
        await p.shutdown()
      } catch (e) {
        report(e)
      }
    }
  }
}

export type { ReadableLogRecord, ReadableSpan }

/** Builds a Log handle. Never throws: a failure goes to `onError` and the handle records nothing. */
export function connect(options: ConnectOptions): LogHandle {
  const report = (error: unknown): void => {
    try {
      options.onError?.(error)
    } catch {
      // The error callback itself failing is not the caller's problem either.
    }
  }

  const passed: PassedSettings = {}
  if (options.destination !== undefined) passed.destination = options.destination
  if (options.keepDays !== undefined) passed.keepDays = options.keepDays
  if (options.headers !== undefined) passed.headers = options.headers
  if (options.runtimeDir !== undefined) passed.runtimeDir = options.runtimeDir

  let declarations: CustomEventDeclarations = {}
  let settings: ResolvedSettings | undefined
  try {
    const resolved = resolveSettings({
      repoRoot: options.repoRoot ?? process.cwd(),
      ...(options.repository !== undefined ? { repository: options.repository } : {}),
      ...(options.vinayaHome !== undefined ? { vinayaHome: options.vinayaHome } : {}),
      passed
    })
    if (resolved.ok) {
      declarations = resolved.declarations
      settings = resolved.settings
    } else report(resolved.error)
  } catch (e) {
    report(e)
  }

  const runId = String(options.runId)
  const idGenerator = createRunIdGenerator(runId)
  const writerId = randomUUID()

  let tracerProvider: BasicTracerProvider | undefined
  let loggerProvider: LoggerProvider | undefined
  let tracer: WriterCore['tracer']
  let logger: WriterCore['logger']
  if (settings !== undefined && settings.logs !== false) {
    try {
      const resource = resourceFromAttributes({
        [ATTRIBUTE_NAMES.serviceName]: options.processName ?? basename(process.argv[1] ?? 'vinaya'),
        ...(options.serviceVersion !== undefined ? { [ATTRIBUTE_NAMES.serviceVersion]: options.serviceVersion } : {}),
        ...(options.repository !== undefined ? { [ATTRIBUTE_NAMES.repository]: options.repository } : {}),
        [ATTRIBUTE_NAMES.hostId]: createHash('sha256').update(hostname()).digest('hex').slice(0, 32),
        [ATTRIBUTE_NAMES.sdkVersion]: SDK_VERSION,
        [ATTRIBUTE_NAMES.semconvVersion]: GENAI_CONVENTIONS_VERSION,
        [ATTRIBUTE_NAMES.osType]: osType(),
        [ATTRIBUTE_NAMES.ci]: options.identity?.ci ?? inCi(),
        ...identityAttributes(options.identity)
      })
      const files = createFileExporters({
        runId,
        writerId,
        repository: options.repository,
        repoRoot: options.repoRoot ?? process.cwd(),
        settings
      })
      try {
        cleanLocalCopy({
          folder: copyFolder({ repository: options.repository, repoRoot: options.repoRoot ?? process.cwd(), settings }),
          keepDays: settings.keepDays,
          now: Date.now(),
          keepWriterId: writerId
        })
      } catch (e) {
        report(e)
      }
      const reportExport = (result: { error?: Error }) => {
        if (result.error) report(result.error)
      }
      tracerProvider = new BasicTracerProvider({
        resource,
        idGenerator,
        sampler: new AlwaysOnSampler(),
        spanProcessors: [
          {
            onStart() {},
            onEnd: (span) => files.spans.export([span], reportExport),
            forceFlush: () => files.spans.forceFlush?.() ?? Promise.resolve(),
            shutdown: () => files.spans.shutdown()
          },
          ...(options.spanProcessors ?? []).map((p) => safeSpanProcessor(p, report))
        ]
      })
      loggerProvider = new LoggerProvider({
        resource,
        processors: [
          {
            onEmit: (record) => files.logs.export([record], reportExport),
            forceFlush: () => files.logs.forceFlush(),
            shutdown: () => files.logs.shutdown()
          },
          ...(options.logRecordProcessors ?? []).map((p) => safeLogProcessor(p, report))
        ]
      })
      tracer = tracerProvider.getTracer('@attalabs/vinaya-log-sdk', SDK_VERSION)
      logger = loggerProvider.getLogger('@attalabs/vinaya-log-sdk', SDK_VERSION)
    } catch (e) {
      report(e)
    }
  }

  const timers = options.timers ?? run.SYSTEM_TIMERS
  const core: WriterCore = {
    enabled: tracer !== undefined && logger !== undefined,
    runId,
    traceId: traceIdFor(runId),
    writerId,
    provenance: options.provenance === 'governed' ? 'governed' : 'reported',
    trust: options.trust ?? 'unavailable',
    work: { ...options.work, ...(options.workRef !== undefined ? { ref: options.workRef } : {}) },
    inputs: { ...options.inputs },
    moment: {},
    now: () => timers.now(),
    lastWrite: timers.now(),
    home: options.home ?? homedir(),
    idGenerator,
    tracer,
    logger,
    open: new Map(),
    current: {},
    pauses: new Map(),
    seq: 0,
    ...(settings !== undefined && settings.logs !== false
      ? {
          copy: {
            folder: () =>
              copyFolder({ repository: options.repository, repoRoot: options.repoRoot ?? process.cwd(), settings }),
            prefix: copyFilePrefix(runId, writerId)
          }
        }
      : {}),
    report
  }
  const heartbeat = run.createHeartbeat(core, timers)

  const noSpan: SpanParent = { traceId: core.traceId, spanId: NO_SPAN_ID }
  const g =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void =>
      guard(core, () => fn(...a), undefined)
  const s =
    <A extends unknown[]>(fn: (...a: A) => SpanParent) =>
    (...a: A): SpanParent =>
      guard(core, () => fn(...a), noSpan)
  const flushAll = async (which: 'forceFlush' | 'shutdown'): Promise<void> => {
    if (which === 'shutdown') heartbeat.stop()
    try {
      await tracerProvider?.[which]()
      await loggerProvider?.[which]()
    } catch (e) {
      report(e)
    }
  }

  const methods = {
    settings,
    run: {
      started: s((o?: run.StartRun) => {
        // A run another process started is carried on, not started again.
        const ref = carryOn(core, o ?? {}) ?? run.started(core, o)
        if (core.enabled) heartbeat.start()
        return ref
      }),
      ended: g((o?: run.EndRun) => {
        heartbeat.stop()
        run.ended(core, o)
      }),
      alive: g(() => run.alive(core)),
      stageChanged: g((c: { from?: run.Stage; to: run.Stage; round?: number }) => run.stageChanged(core, c)),
      paused: s((o?: run.Pause) => run.paused(core, o)),
      resumed: g((o: run.Resume) => run.resumed(core, o)),
      cancelled: g((d?: { round?: number; by?: string }) => run.cancelled(core, d)),
      retried: g((d?: { failed?: string; tries?: number; recovered?: boolean }) => run.retried(core, d)),
      stopRuleMet: g((d: { rule: run.StopRule }) => run.stopRuleMet(core, d)),
      exited: g((d: { kind: run.ExitKind; code?: number; errorType?: string }) => run.exited(core, d))
    },
    round: {
      started: s((o: round.StartRound) => round.started(core, o)),
      ended: g((o?: round.EndRound) => round.ended(core, o))
    },
    phase: { ended: g((o: round.PhaseEnded) => round.phaseEnded(core, o)) },
    agent: {
      sent: s((o: agent.AgentSent) => agent.sent(core, o)),
      stepStarted: s((o: agent.StepStarted) => agent.stepStarted(core, o)),
      stepEnded: g((step: SpanParent, o?: agent.StepEnded) => agent.stepEnded(core, step, o)),
      returned: g((o?: agent.AgentReturned) => agent.returned(core, o)),
      failed: g((o: agent.AgentFailed) => agent.failed(core, o)),
      confidenceStated: g((d?: agent.ConfidenceStated) => agent.confidenceStated(core, d))
    },
    usage: { recorded: g((u: agent.UsageRecorded) => agent.usageRecorded(core, u)) },
    review: {
      verdicts: g((d: review.ReviewVerdicts) => review.reviewVerdicts(core, d)),
      findingsCompared: g((d: review.FindingsCompared) => review.findingsCompared(core, d))
    },
    checks: {
      ran: g((d: checks.ChecksRan) => checks.ran(core, d)),
      notPassed: g((d: checks.CheckNotPassed) => checks.notPassed(core, d)),
      read: g((d: checks.ChecksRead) => checks.read(core, d)),
      local: g((d: checks.ChecksLocal) => checks.local(core, d)),
      ci: g((d: checks.ChecksCi) => checks.ci(core, d)),
      rerun: g((d: checks.ChecksRerun) => checks.rerun(core, d))
    },
    change: {
      saved: g((d?: change.ChangeSaved) => change.saved(core, d)),
      pushed: g((d: change.ChangePushed) => change.pushed(core, d)),
      opened: g((d: change.ChangeOpened) => change.opened(core, d)),
      conflicted: g((d?: change.ChangeConflicted) => change.conflicted(core, d)),
      recovered: g(() => change.recovered(core)),
      merged: g((d?: change.ChangeMerged) => change.merged(core, d)),
      reverted: g((d?: change.ChangeReverted) => change.reverted(core, d)),
      incident: g((d?: change.ChangeIncident) => change.incident(core, d)),
      closed: g((d?: change.ChangeClosed) => change.closed(core, d))
    },
    person: {
      asked: s((d: person.PersonAsked) => person.asked(core, d)),
      answered: g((d: person.PersonAnswered) => person.answered(core, d))
    },
    forge: {
      validated: g((d: outside.ForgeWrite) => outside.forgeValidated(core, d)),
      refused: g((d: outside.ForgeRefusal) => outside.forgeRefused(core, d)),
      written: g((d: outside.ForgeWrite) => outside.forgeWritten(core, d))
    },
    action: { verified: g((d: outside.ActionVerified) => outside.actionVerified(core, d)) },
    command: { completed: g((d: outside.CommandCompleted) => outside.commandCompleted(core, d)) },
    custom: {
      recorded: g((name: string, fields: Readonly<Record<string, unknown>>) => custom(core, declarations, name, fields))
    },
    writeSpan: g(
      (
        name: string,
        own: SpanParent,
        parent: SpanParent | undefined,
        start: TimeInput,
        end: TimeInput,
        attributes?: Attrs
      ) => writeWholeSpan(core, name, own, parent, start, end, attributes)
    ),
    flush: () => flushAll('forceFlush'),
    shutdown: () => flushAll('shutdown')
  }
  return {
    runId: core.runId,
    traceId: core.traceId,
    writerId: core.writerId,
    enabled: core.enabled,
    ...methods
  } as LogHandle
}
