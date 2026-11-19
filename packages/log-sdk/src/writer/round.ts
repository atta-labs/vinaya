import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import type { SpanParent } from '../contract/ids.js'
import { endSpan, runSpanRef, startSpan, type WriterCore, wholeSpan } from './attributes.js'
import type { EndOptions } from './run.js'

export type StartRound = {
  number: number
  startingCommit?: string
  spanId?: string
  key?: string
  startTime?: TimeInput
}

export type EndRound = EndOptions & {
  filesChanged?: number
  linesAdded?: number
  linesRemoved?: number
  outcome?: string
}

export type PhaseEnded = {
  /** developer, local checks, review, push, CI or other */
  phase: string
  step?: string
  startTime?: TimeInput
  endTime?: TimeInput
  errorType?: string
}

/** A round is a `vinaya.round {n}` span under the run. */
export function started(core: WriterCore, options: StartRound): SpanParent {
  core.moment.round = options.number
  const ref = startSpan(core, {
    name: spanName(S.round, options.number),
    startedEvent: E.roundStarted,
    attrs: { [A.roundNumber]: options.number, [A.roundStartCommit]: options.startingCommit },
    parent: runSpanRef(core),
    spanId: options.spanId,
    key: options.key,
    startTime: options.startTime
  })
  core.current.round = ref
  return ref
}

export function ended(core: WriterCore, options: EndRound = {}): void {
  const ref = core.current.round
  if (ref === undefined) throw new Error('no round is open')
  endSpan(
    core,
    ref,
    {
      [A.roundFilesChanged]: options.filesChanged,
      [A.roundLinesAdded]: options.linesAdded,
      [A.roundLinesRemoved]: options.linesRemoved,
      [A.roundOutcome]: options.outcome
    },
    options.endTime,
    options.errorType
  )
}

/** A phase is a `vinaya.phase {phase}` span under the open round, else under the run, written when it ends. */
export function phaseEnded(core: WriterCore, options: PhaseEnded): void {
  wholeSpan(
    core,
    spanName(S.phase, options.phase),
    core.current.round ?? runSpanRef(core),
    { [A.phaseName]: options.phase, [A.phaseStep]: options.step },
    options
  )
}
