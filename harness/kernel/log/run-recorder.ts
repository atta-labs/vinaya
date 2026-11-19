import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSpanIdFor } from '../../../packages/log-sdk/src/contract/convert-map.js'
import { type SpanParent, traceIdFor } from '../../../packages/log-sdk/src/contract/ids.js'
import { connect, type LogHandle } from '../../../packages/log-sdk/src/writer/connect.js'
import type { AgentStep } from '../adapters/agents/agent-stream.js'
import { localCopyTarget } from './local-copy-writer.js'
import { currentRunId } from './log-sink.js'

/** Where a run's local copy is kept, as the sink resolved it. */
export type LocalCopyTarget = { folder: string; repository: string | undefined }

export type RunRecorderDeps = {
  /** The id every record of this process's run carries: the one the sink stamps as `meta.run_id`. */
  runId: () => string
  /** The task the process works on, when it works on one. */
  workRef: () => string | undefined
  /** The local copy's place; `undefined` while the sink has recorded nothing, or records nothing. */
  target: () => LocalCopyTarget | undefined
  home: () => string
  cwd: () => string
  /** Called once per process with the first failure; the recorder never throws. */
  onError: (error: unknown) => void
  connect?: typeof connect
}

/** What a dispatch hands its stream renderer: steps in, and an end for any step the stream left open. */
export type StepRecording = { observe: (step: AgentStep) => void; close: () => void }

type OpenStep = { ref: SpanParent; startedAt: number }

/**
 * One Log SDK handle for the process, recording the two things only the OpenTelemetry side carries: each agent
 * step of a dispatch, and each change of a run's stage. Every record is governed and carries the run's trace id
 * and the task the process works on.
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

  const handles = new Map<string, LogHandle>()
  function current(runId: string): LogHandle | undefined {
    const target = deps.target()
    if (target === undefined) return undefined
    const key = `${runId}\0${target.folder}`
    const known = handles.get(key)
    if (known !== undefined) return known
    const home = deps.home()
    const workRef = deps.workRef()
    const made = (deps.connect ?? connect)({
      runId,
      ...(target.repository === undefined ? {} : { repository: target.repository }),
      repoRoot: deps.cwd(),
      destination: { folder: target.folder },
      vinayaHome: join(home, '.vinaya'),
      home,
      provenance: 'governed',
      trust: 'parent_attributed',
      ...(workRef === undefined ? {} : { workRef }),
      onError: report
    })
    handles.set(key, made)
    return made
  }

  return {
    /** Records the steps of one dispatch under that dispatch's agent span; with no effect id, records nothing. */
    steps(effectId: string | undefined, runId: string = deps.runId()): StepRecording {
      const open = new Map<string, OpenStep>()
      const parentOf = (): SpanParent | undefined => {
        if (effectId === undefined || effectId === '') return undefined
        return { traceId: traceIdFor(runId), spanId: agentSpanIdFor(runId, effectId) }
      }
      return {
        observe(step) {
          try {
            const parent = parentOf()
            if (parent === undefined) return
            const log = current(runId)
            if (log === undefined) return
            if (step.type === 'start') {
              if (open.has(step.id)) return
              const ref = log.agent.stepStarted({
                tool: step.tool,
                callId: step.id,
                kind: step.kind,
                target: step.target,
                parent,
                key: `step:${effectId}:${step.id}`,
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
            const log = current(runId)
            for (const [id, started] of open) {
              open.delete(id)
              log?.agent.stepEnded(started.ref, { errorType: 'interrupted' })
            }
          } catch (error) {
            report(error)
          }
        }
      }
    },
    /** Records a change of the run's stage as a stage-changed event with the round. */
    stageChanged(change: { stage: string; round: number }, runId: string = deps.runId()): void {
      try {
        current(runId)?.run.stageChanged({ to: change.stage, round: change.round })
      } catch (error) {
        report(error)
      }
    }
  }
}

export type RunRecorder = ReturnType<typeof createRunRecorder>

let shared: RunRecorder | undefined

/** This process's one recorder, for the run the default sink records. */
export function runRecorder(): RunRecorder {
  shared ??= createRunRecorder({
    runId: currentRunId,
    workRef: () => process.env.VINAYA_TASK || undefined,
    target: localCopyTarget,
    home: () => homedir(),
    cwd: () => process.cwd(),
    onError: (error) =>
      void process.stderr.write(
        `vinaya: the OpenTelemetry run recorder failed — ${error instanceof Error ? error.message : String(error)}\n`
      )
  })
  return shared
}
