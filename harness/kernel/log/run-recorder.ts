import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  connect,
  EVENT_NAMES,
  type LogHandle,
  type NarratableRecord,
  type ReadableLogRecord,
  type ReadableSpan,
  SPAN_NAMES,
  type SpanParent
} from '../../../packages/log-sdk/src/index.js'
import type { AgentStep } from '../adapters/agents/agent-stream.js'
import type { LocalCopyPlace, LocalCopySender } from './local-copy-writer.js'
import { currentRunId, processLocalCopyPlace, processLocalCopySender, registerLogDrain } from './log-sink.js'
import { registeredCliVersion } from './run-identity.js'

/** Where a run's local copy is kept. */
export type LocalCopyTarget = LocalCopyPlace

/** What ran the run, as the process knows it; a part it does not know is absent, and is never written. */
export type RunIdentityParts = {
  runnerName?: string
  runnerVersion?: string
  cliVersion?: string
  flowId?: string
  flowVersion?: string
  processDigest?: string
}

/** The effort an agent turn records when its run named none. */
export const DEFAULT_TURN_EFFORT = 'medium'

/** The repository's settings file, read from the run's working directory. */
const SETTINGS_FILE = 'vinaya.config.json'

/** The SHA-256, in hex, of the settings file's bytes as the run reads them; `undefined` when there is no such file. */
function settingsDigestOf(root: string): string | undefined {
  try {
    return createHash('sha256')
      .update(readFileSync(join(root, SETTINGS_FILE)))
      .digest('hex')
  } catch {
    return undefined
  }
}

export type RunRecorderDeps = {
  /** The id every record of this process's run carries: the one the sink stamps as `meta.run_id`. */
  runId: () => string
  /** The task the process works on, when it works on one. */
  workRef: () => string | undefined
  /** The repository the run belongs to, as `owner/repo`, when the process knows it. */
  repository: () => string | undefined
  /** The local copy's place for a repository, from the process's own settings; `undefined` when recording is off. */
  place: (repository: string | undefined) => LocalCopyPlace | undefined
  /** The name and version of the process the run is governed by, carried on every record. */
  processIdentity: () => { name: string; version: string } | undefined
  /** What ran the run, written on the resource of every record; absent parts are not written. */
  runIdentity?: () => RunIdentityParts
  /** Sends the local copy to the OpenTelemetry address; the recorder asks after each turn ends and at the drain. */
  sender: () => Pick<LocalCopySender, 'request' | 'remember' | 'drain'>
  home: () => string
  cwd: () => string
  /** Called once per process with the first failure; the recorder never throws. */
  onError: (error: unknown) => void
  connect?: typeof connect
}

/** What a dispatch hands its stream renderer: steps in, and an end for any step the stream left open. */
export type StepRecording = { observe: (step: AgentStep) => void; close: () => void }

/** One agent turn: an `invoke_agent {seat}` span, with its steps and its usage under it. */
export type AgentTurn = {
  /** The span's reference; `undefined` when nothing is recorded. */
  readonly ref: SpanParent | undefined
  /** Records the turn's steps under the span, and ends any step the stream left open. */
  readonly steps: StepRecording
  /** Tokens on the span; usage that is not known is recorded with its reason, never as zero. */
  usage: (usage: {
    inputTokens?: number | null
    outputTokens?: number | null
    cacheReadInputTokens?: number | null
    unknownReason?: string | null
  }) => void
  /** Ends the span with what came out of the turn. */
  returned: (end?: { outcome?: string; attempt?: number | null; responseModel?: string; endTime?: number }) => void
  /** Ends the span with an error type. */
  failed: (end: { errorType: string; resetAt?: string; attempt?: number | null; endTime?: number }) => void
}

export type AgentTurnStart = {
  /** The seat the agent sits in. */
  seat: string
  provider?: string
  model?: string
  codingAgent?: string
  codingAgentVersion?: string
  round?: number | null
  /** Names the span within the run, so a start written twice is one span. */
  key?: string
  startTime?: number
  runId?: string
  repository?: string
  /** The work this turn belongs to; the process's own when absent. */
  workRef?: string
  /** The effort the agent was launched with; the run's own when absent, `medium` when the run named none. */
  effort?: string
  /** Narrates this turn's records as they are written; the process's own narrator when absent. */
  narrate?: AgentRecordNarrator
}

type OpenStep = { ref: SpanParent; startedAt: number }

/** Takes each agent record as it is written, to narrate it; the same record the local copy holds. */
export type AgentRecordNarrator = (record: NarratableRecord) => void

const nanosOf = (time: readonly [number, number]): string =>
  (BigInt(time[0]) * 1_000_000_000n + BigInt(time[1])).toString()

/** The agent span's end, as the narration reads a record. */
function spanRecordOf(span: ReadableSpan): NarratableRecord {
  return {
    kind: 'span',
    name: span.name,
    startTime: nanosOf(span.startTime),
    time: nanosOf(span.endTime),
    attributes: span.attributes
  }
}

/** The agent's started event, as the narration reads a record. */
function startedRecordOf(record: ReadableLogRecord): NarratableRecord {
  return {
    kind: 'started',
    name: String(record.eventName ?? ''),
    startTime: null,
    time: nanosOf(record.hrTime),
    attributes: record.attributes
  }
}

/**
 * One Log SDK handle per run for the process: the agent turns, their steps and usage, and each change of a run's
 * stage, with every later subject of the harness writing through the same handle. Every record is governed and
 * carries the run's trace id, the task the process works on, and the process's name and version. The recorder opens
 * its handle from the process's own settings, so it depends on no earlier-format write, and it asks the shared
 * sender to send the local copy as turns end.
 */
export function createRunRecorder(deps: RunRecorderDeps) {
  let reported = false
  const report = (error: unknown): void => {
    if (reported) return
    reported = true
    try {
      deps.onError(error)
    } catch {
      // A report that cannot be written is not a failure of what it reports.
    }
  }

  /** The run and repository the process named for its own records, and who narrates its agent records. */
  const bound: { runId?: string; repository?: string; narrate?: AgentRecordNarrator; effort?: string } = {}
  /** Who narrates a turn's records: the narrator its start named, else the process's own. */
  const narrators = new Map<string, AgentRecordNarrator | undefined>()
  /** Set while a turn's start is written, which emits the started event before the span's id is known. */
  let starting: { narrate: AgentRecordNarrator | undefined } | undefined
  const narrateRecord = (record: NarratableRecord, spanId: string | undefined): void => {
    try {
      const narrate =
        starting !== undefined
          ? starting.narrate
          : spanId !== undefined && narrators.has(spanId)
            ? narrators.get(spanId)
            : bound.narrate
      narrate?.(record)
    } catch (error) {
      report(error)
    }
  }
  const idleProcessor = { forceFlush: async () => {}, shutdown: async () => {} }
  const runIdNow = (): string => bound.runId ?? deps.runId()

  const handles = new Map<string, { log: LogHandle; place: LocalCopyPlace }>()
  function open(
    runId: string,
    repository?: string,
    workRefOverride?: string
  ): { log: LogHandle; place: LocalCopyPlace } | undefined {
    const repo = repository ?? bound.repository ?? deps.repository()
    const place = deps.place(repo)
    if (place === undefined) return undefined
    const key = `${runId}\0${place.folder}\0${repo ?? ''}\0${workRefOverride ?? ''}`
    const known = handles.get(key)
    if (known !== undefined) return known
    const home = deps.home()
    const workRef = workRefOverride ?? deps.workRef()
    const identity = deps.processIdentity()
    const parts = deps.runIdentity?.() ?? {}
    const settingsDigest = settingsDigestOf(deps.cwd())
    const runIdentity = {
      ...(parts.runnerName ? { runnerName: parts.runnerName } : {}),
      ...(parts.runnerVersion ? { runnerVersion: parts.runnerVersion } : {}),
      ...(parts.cliVersion ? { cliVersion: parts.cliVersion } : {}),
      ...(parts.flowId ? { flowId: parts.flowId } : {}),
      ...(parts.flowVersion ? { flowVersion: parts.flowVersion } : {}),
      ...(parts.processDigest ? { processDigest: parts.processDigest } : {}),
      ...(settingsDigest === undefined ? {} : { settingsDigest })
    }
    const log = (deps.connect ?? connect)({
      runId,
      ...(repo === undefined ? {} : { repository: repo }),
      repoRoot: deps.cwd(),
      destination: { folder: place.folder },
      vinayaHome: join(home, '.vinaya'),
      home,
      provenance: 'governed',
      trust: 'parent_attributed',
      identity: runIdentity,
      ...(identity === undefined ? {} : { processName: identity.name, serviceVersion: identity.version }),
      ...(workRef === undefined ? {} : { workRef }),
      // The agent's records are narrated as the handle writes them: the started event, and the span's end.
      spanProcessors: [
        {
          ...idleProcessor,
          onStart: () => {},
          onEnd: (span: ReadableSpan) => {
            if (span.name === SPAN_NAMES.agent || span.name.startsWith(`${SPAN_NAMES.agent} `))
              narrateRecord(spanRecordOf(span), span.spanContext().spanId)
          }
        }
      ],
      logRecordProcessors: [
        {
          ...idleProcessor,
          onEmit: (record: ReadableLogRecord) => {
            if (record.eventName === EVENT_NAMES.agentStarted)
              narrateRecord(startedRecordOf(record), record.spanContext?.spanId)
          }
        }
      ],
      onError: report
    })
    const made = { log, place }
    handles.set(key, made)
    return made
  }

  const absent: StepRecording = { observe: () => {}, close: () => {} }

  function stepsUnder(
    opened: { log: LogHandle; place: LocalCopyPlace } | undefined,
    parent: SpanParent | undefined,
    key: string
  ): StepRecording {
    if (opened === undefined || parent === undefined) return absent
    const { log } = opened
    const open = new Map<string, OpenStep>()
    return {
      observe(step) {
        try {
          if (step.type === 'start') {
            if (open.has(step.id)) return
            const ref = log.agent.stepStarted({
              tool: step.tool,
              callId: step.id,
              kind: step.kind,
              target: step.target,
              parent,
              key: `step:${key}:${step.id}`,
              startTime: step.at
            })
            open.set(step.id, { ref, startedAt: step.at })
            return
          }
          const started = open.get(step.id)
          if (started === undefined) return
          open.delete(step.id)
          // Only the outcome and a test run's failed count: the translator's error line excerpts tool output.
          log.agent.stepEnded(started.ref, {
            endTime: started.startedAt + step.durationMs,
            ...(step.ok ? {} : { errorType: step.failedTests === undefined ? 'failed' : 'tests_failed' }),
            ...(step.ok || step.failedTests === undefined ? {} : { errorLine: `${step.failedTests} failed` })
          })
        } catch (error) {
          report(error)
        }
      },
      close() {
        try {
          for (const [id, started] of open) {
            open.delete(id)
            log.agent.stepEnded(started.ref, { errorType: 'interrupted' })
          }
        } catch (error) {
          report(error)
        }
      }
    }
  }

  const sendSoon = (place: LocalCopyPlace): void => {
    try {
      deps.sender().request(place)
    } catch (error) {
      report(error)
    }
  }

  return {
    /** Names the run and repository this process's records belong to, for every call that names neither. */
    bind(run: { runId?: string; repository?: string; narrate?: AgentRecordNarrator; effort?: string }): void {
      bound.runId = run.runId
      bound.repository = run.repository
      bound.narrate = run.narrate
      bound.effort = run.effort
    },
    /** The run's handle, for every subject the harness writes through it; `undefined` while recording is off. */
    handle(runId: string = runIdNow(), repository?: string): LogHandle | undefined {
      try {
        return open(runId, repository)?.log
      } catch (error) {
        report(error)
        return undefined
      }
    },
    /** Starts one agent turn: its span opens now, and ends with `returned` or `failed`. */
    turn(start: AgentTurnStart): AgentTurn {
      const runId = start.runId ?? runIdNow()
      let opened: { log: LogHandle; place: LocalCopyPlace } | undefined
      let ref: SpanParent | undefined
      try {
        opened = open(runId, start.repository, start.workRef)
        starting = { narrate: start.narrate ?? bound.narrate }
        ref =
          opened?.log.agent.sent({
            seat: start.seat,
            ...(start.provider === undefined ? {} : { provider: start.provider }),
            ...(start.model === undefined ? {} : { model: start.model }),
            ...(start.codingAgent === undefined ? {} : { codingAgent: start.codingAgent }),
            ...(start.codingAgentVersion === undefined ? {} : { codingAgentVersion: start.codingAgentVersion }),
            ...(start.round === undefined || start.round === null ? {} : { round: start.round }),
            effort: start.effort ?? bound.effort ?? DEFAULT_TURN_EFFORT,
            ...(start.key === undefined ? {} : { key: `agent:${start.key}` }),
            ...(start.startTime === undefined ? {} : { startTime: start.startTime })
          }) ?? undefined
      } catch (error) {
        report(error)
      } finally {
        if (ref !== undefined) narrators.set(ref.spanId, start.narrate ?? bound.narrate)
        starting = undefined
      }
      const steps = stepsUnder(opened, ref, start.key ?? `${start.seat}:${Date.now()}`)
      const guarded = (work: (log: LogHandle, agent: SpanParent) => void): void => {
        try {
          if (opened === undefined || ref === undefined) return
          work(opened.log, ref)
        } catch (error) {
          report(error)
        }
      }
      return {
        ref,
        steps,
        usage(usage) {
          guarded((log, agent) => {
            const known = (value: number | null | undefined): number | undefined =>
              value === null || value === undefined ? undefined : value
            const unknownReason =
              usage.unknownReason ??
              (known(usage.inputTokens) === undefined && known(usage.outputTokens) === undefined
                ? 'no usage was reported'
                : undefined)
            log.usage.recorded({
              agent,
              ...(unknownReason === undefined || unknownReason === null ? {} : { unknownReason }),
              ...(known(usage.inputTokens) === undefined ? {} : { inputTokens: known(usage.inputTokens) as number }),
              ...(known(usage.outputTokens) === undefined ? {} : { outputTokens: known(usage.outputTokens) as number }),
              ...(known(usage.cacheReadInputTokens) === undefined
                ? {}
                : { cacheReadInputTokens: known(usage.cacheReadInputTokens) as number })
            })
          })
        },
        returned(end = {}) {
          steps.close()
          guarded((log, agent) => {
            log.agent.returned({
              agent,
              ...(end.outcome === undefined ? {} : { outcome: end.outcome }),
              ...(end.attempt === undefined || end.attempt === null ? {} : { attempt: end.attempt }),
              ...(end.responseModel === undefined ? {} : { responseModel: end.responseModel }),
              ...(end.endTime === undefined ? {} : { endTime: end.endTime })
            })
            if (opened !== undefined) sendSoon(opened.place)
          })
        },
        failed(end) {
          steps.close()
          guarded((log, agent) => {
            log.agent.failed({
              agent,
              errorType: end.errorType,
              ...(end.resetAt === undefined ? {} : { resetAt: end.resetAt }),
              ...(end.attempt === undefined || end.attempt === null ? {} : { attempt: end.attempt }),
              ...(end.endTime === undefined ? {} : { endTime: end.endTime })
            })
            if (opened !== undefined) sendSoon(opened.place)
          })
        }
      }
    },
    /** Records a change of the run's stage as a stage-changed event with the round. */
    stageChanged(change: { stage: string; round: number }, runId: string = runIdNow()): void {
      try {
        open(runId)?.log.run.stageChanged({ to: change.stage, round: change.round })
      } catch (error) {
        report(error)
      }
    },
    /** Everything written is in the local copy, and the local copy is sent for at most the sender's bound. */
    async drain(): Promise<void> {
      try {
        const places: LocalCopyPlace[] = []
        for (const { log, place } of handles.values()) {
          await log.flush().catch(report)
          places.push(place)
        }
        const last = places[places.length - 1]
        if (last === undefined) return
        deps.sender().remember(last)
        await deps.sender().drain()
      } catch (error) {
        report(error)
      }
    }
  }
}

export type RunRecorder = ReturnType<typeof createRunRecorder>

let shared: RunRecorder | undefined

/** The name and version the run is governed by, as the driver or the dispatching process handed them down in its environment. */
function identityFromEnvironment(): { name: string; version: string } | undefined {
  const name = process.env.VINAYA_PROCESS_ID
  const version = process.env.VINAYA_PROCESS_VERSION
  return name && version ? { name, version } : undefined
}

/** What ran the run, as the runner handed it down in its environment, and the program's own version. */
function runIdentityFromEnvironment(): RunIdentityParts {
  const { VINAYA_RUNNER_ID, VINAYA_RUNNER_VERSION, VINAYA_FLOW, VINAYA_FLOW_VERSION, VINAYA_PROCESS_DIGEST } =
    process.env
  const cliVersion = registeredCliVersion()
  return {
    ...(VINAYA_RUNNER_ID ? { runnerName: VINAYA_RUNNER_ID } : {}),
    ...(VINAYA_RUNNER_VERSION ? { runnerVersion: VINAYA_RUNNER_VERSION } : {}),
    ...(cliVersion === undefined ? {} : { cliVersion }),
    ...(VINAYA_FLOW ? { flowId: VINAYA_FLOW } : {}),
    ...(VINAYA_FLOW_VERSION ? { flowVersion: VINAYA_FLOW_VERSION } : {}),
    ...(VINAYA_PROCESS_DIGEST ? { processDigest: VINAYA_PROCESS_DIGEST } : {})
  }
}

/** This process's one recorder, for the run the default sink records. */
export function runRecorder(): RunRecorder {
  shared ??= createRunRecorder({
    runId: currentRunId,
    workRef: () => process.env.VINAYA_TASK || undefined,
    repository: () => process.env.VINAYA_REPO || undefined,
    place: processLocalCopyPlace,
    processIdentity: identityFromEnvironment,
    runIdentity: runIdentityFromEnvironment,
    sender: processLocalCopySender,
    home: () => homedir(),
    cwd: () => process.cwd(),
    onError: (error) =>
      void process.stderr.write(
        `vinaya: the OpenTelemetry run recorder failed — ${error instanceof Error ? error.message : String(error)}\n`
      )
  })
  const recorder = shared
  registerLogDrain(() => recorder.drain())
  return shared
}
