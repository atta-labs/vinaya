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
  SDK_VERSION
} from '../contract/catalogue.js'
import { createRunIdGenerator, type SpanParent, traceIdFor } from '../contract/ids.js'
import * as agent from './agent.js'
import { type Attrs, guard, type WriterCore } from './attributes.js'
import * as round from './round.js'
import * as run from './run.js'
import { type LogsSetting, type PassedSettings, resolveSettings, type ResolvedSettings } from './settings.js'
import { writeWholeSpan } from './whole-span.js'

export type ConnectOptions = {
  /** The run every record belongs to; the trace id derives from it alone. */
  runId: string
  /** `owner/repo`, for the resource and the default runtime directory. */
  repository?: string
  /** Where `log.config.json` and `vinaya.config.json` sit; the working directory by default. */
  repoRoot?: string
  runtimeDir?: string
  destination?: LogsSetting
  headers?: Record<string, string>
  /** Carried on every record as vinaya.work.ref. */
  workRef?: string
  /** `governed` only when the caller says so; the default is `reported`. */
  provenance?: RecordProvenance
  processName?: string
  serviceVersion?: string
  /** Where spans go; with none passed they go nowhere. */
  spanProcessors?: SpanProcessor[]
  /** Where events go; with none passed they go nowhere. */
  logRecordProcessors?: LogRecordProcessor[]
  /** Called once per failure; no handle function ever throws. */
  onError?: (error: unknown) => void
  /** The home directory redaction rewrites to `~`. */
  home?: string
  /** The Vinaya home, for the default runtime directory. */
  vinayaHome?: string
}

const NO_SPAN_ID = '0000000000000000'

export type LogHandle = WriterCore & {
  /** The resolved settings; `undefined` when the handle records nothing. */
  readonly settings: ResolvedSettings | undefined
  startRun(options?: run.StartRunOptions): SpanParent
  endRun(options?: run.EndOptions): void
  alive(): void
  stageChanged(change: { from?: string; to: string }): void
  cancelled(detail?: { reason?: string }): void
  retried(detail?: { attempt?: number; reason?: string }): void
  stopRuleMet(detail: { rule: string; reason?: string }): void
  exited(detail?: { code?: number; reason?: string }): void
  startRound(options: round.StartRoundOptions): SpanParent
  endRound(options?: run.EndOptions): void
  startPhase(options: round.StartPhaseOptions): SpanParent
  endPhase(options?: run.EndOptions): void
  startAgent(options: agent.StartAgentOptions): SpanParent
  recordUsage(usage: agent.TokenUsage, agentRef?: SpanParent): void
  endAgent(options?: run.EndOptions & { usage?: agent.TokenUsage }): void
  startStep(options: agent.StartStepOptions): SpanParent
  endStep(step: SpanParent, options?: run.EndOptions): void
  confidenceStated(detail: { confidence: number; agent?: SpanParent }): void
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

export type { ReadableLogRecord }

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
  if (options.headers !== undefined) passed.headers = options.headers
  if (options.runtimeDir !== undefined) passed.runtimeDir = options.runtimeDir

  let settings: ResolvedSettings | undefined
  try {
    const resolved = resolveSettings({
      repoRoot: options.repoRoot ?? process.cwd(),
      ...(options.repository !== undefined ? { repository: options.repository } : {}),
      ...(options.vinayaHome !== undefined ? { vinayaHome: options.vinayaHome } : {}),
      passed
    })
    if (resolved.ok) settings = resolved.settings
    else report(resolved.error)
  } catch (e) {
    report(e)
  }

  const runId = String(options.runId)
  const idGenerator = createRunIdGenerator(runId)
  const enabled = settings !== undefined && settings.logs !== false

  let tracerProvider: BasicTracerProvider | undefined
  let loggerProvider: LoggerProvider | undefined
  let tracer: WriterCore['tracer']
  let logger: WriterCore['logger']
  if (enabled) {
    try {
      const resource = resourceFromAttributes({
        [ATTRIBUTE_NAMES.serviceName]: options.processName ?? basename(process.argv[1] ?? 'vinaya'),
        [ATTRIBUTE_NAMES.serviceVersion]: options.serviceVersion ?? SDK_VERSION,
        ...(options.repository !== undefined ? { [ATTRIBUTE_NAMES.repository]: options.repository } : {}),
        [ATTRIBUTE_NAMES.hostId]: createHash('sha256').update(hostname()).digest('hex').slice(0, 32),
        [ATTRIBUTE_NAMES.sdkVersion]: SDK_VERSION,
        [ATTRIBUTE_NAMES.semconvVersion]: GENAI_CONVENTIONS_VERSION
      })
      tracerProvider = new BasicTracerProvider({
        resource,
        idGenerator,
        sampler: new AlwaysOnSampler(),
        spanProcessors: (options.spanProcessors ?? []).map((p) => safeSpanProcessor(p, report))
      })
      loggerProvider = new LoggerProvider({
        resource,
        processors: (options.logRecordProcessors ?? []).map((p) => safeLogProcessor(p, report))
      })
      tracer = tracerProvider.getTracer('@attalabs/vinaya-log-sdk', SDK_VERSION)
      logger = loggerProvider.getLogger('@attalabs/vinaya-log-sdk', SDK_VERSION)
    } catch (e) {
      report(e)
    }
  }

  const core: WriterCore = {
    enabled: enabled && tracer !== undefined && logger !== undefined,
    runId,
    traceId: traceIdFor(runId),
    writerId: randomUUID(),
    provenance: options.provenance === 'governed' ? 'governed' : 'reported',
    workRef: options.workRef,
    home: options.home ?? homedir(),
    idGenerator,
    tracer,
    logger,
    open: new Map(),
    current: {},
    seq: 0,
    report
  }

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
    try {
      await tracerProvider?.[which]()
      await loggerProvider?.[which]()
    } catch (e) {
      report(e)
    }
  }

  const methods = {
    settings,
    startRun: s((o?: run.StartRunOptions) => run.startRun(core, o)),
    endRun: g((o?: run.EndOptions) => run.endRun(core, o)),
    alive: g(() => run.alive(core)),
    stageChanged: g((c: { from?: string; to: string }) => run.stageChanged(core, c)),
    cancelled: g((d?: { reason?: string }) => run.cancelled(core, d)),
    retried: g((d?: { attempt?: number; reason?: string }) => run.retried(core, d)),
    stopRuleMet: g((d: { rule: string; reason?: string }) => run.stopRuleMet(core, d)),
    exited: g((d?: { code?: number; reason?: string }) => run.exited(core, d)),
    startRound: s((o: round.StartRoundOptions) => round.startRound(core, o)),
    endRound: g((o?: run.EndOptions) => round.endRound(core, o)),
    startPhase: s((o: round.StartPhaseOptions) => round.startPhase(core, o)),
    endPhase: g((o?: run.EndOptions) => round.endPhase(core, o)),
    startAgent: s((o: agent.StartAgentOptions) => agent.startAgent(core, o)),
    recordUsage: g((u: agent.TokenUsage, a?: SpanParent) => agent.recordUsage(core, u, a)),
    endAgent: g((o?: run.EndOptions & { usage?: agent.TokenUsage }) => agent.endAgent(core, o)),
    startStep: s((o: agent.StartStepOptions) => agent.startStep(core, o)),
    endStep: g((step: SpanParent, o?: run.EndOptions) => agent.endStep(core, step, o)),
    confidenceStated: g((d: { confidence: number; agent?: SpanParent }) => agent.confidenceStated(core, d)),
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
  return Object.assign(core, methods) as LogHandle
}
