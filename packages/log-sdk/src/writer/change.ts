import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../contract/catalogue.js'
import { spanIdFor, traceIdFor } from '../contract/ids.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'

/** An event that happens after the run, linked to its trace by the run id. */
type Independent = { runId?: string; when?: TimeInput }

export type ChangeSaved = { branch?: string; commit?: string }
export type ChangePushed = { result: 'passed' | 'refused'; picked?: number; failed?: number; ms?: number }
export type ChangeOpened = { change: string; commit?: string }
export type ChangeConflicted = { reentry?: number }
export type ChangeMerged = Independent & { by?: string }
/** The change was closed without merging. */
export type ChangeClosed = Independent & { by?: string }
export type ChangeReverted = Independent & { reason?: string }
export type ChangeIncident = Independent & { severity?: string; link?: string }

function onRun(core: WriterCore, name: string, attrs: Record<string, string | number | undefined>): void {
  emitEvent(core, name, { ...attrs, [A.runId]: core.runId }, runSpanRef(core))
}

/** Linked to the run the caller names, else to this handle's own run. */
function afterRun(core: WriterCore, name: string, d: Independent, attrs: Record<string, string | undefined>): void {
  const runId = d.runId ?? core.runId
  const ref = { traceId: traceIdFor(runId), spanId: spanIdFor(runId, 'run') }
  emitEvent(core, name, { ...attrs, [A.runId]: runId }, ref, d.when)
}

export function saved(core: WriterCore, d: ChangeSaved = {}): void {
  onRun(core, E.changeSaved, { [A.branch]: d.branch, [A.commit]: d.commit })
}

export function pushed(core: WriterCore, d: ChangePushed): void {
  onRun(core, E.changePushed, {
    [A.result]: d.result,
    [A.changeTestsPicked]: d.picked,
    [A.changeTestsFailed]: d.failed,
    [A.changePushMs]: d.ms
  })
}

/** The change is named from here on: every later record carries it as the work's change. */
export function opened(core: WriterCore, d: ChangeOpened): void {
  core.work.change = d.change
  if (d.commit !== undefined) core.work.commit = d.commit
  onRun(core, E.changeOpened, { [A.change]: d.change, [A.commit]: d.commit })
}

export function conflicted(core: WriterCore, d: ChangeConflicted = {}): void {
  onRun(core, E.changeConflicted, { [A.changeReentry]: d.reentry })
}

export function recovered(core: WriterCore): void {
  onRun(core, E.changeRecovered, {})
}

export function merged(core: WriterCore, d: ChangeMerged = {}): void {
  afterRun(core, E.changeMerged, d, { [A.actor]: d.by })
}

export function reverted(core: WriterCore, d: ChangeReverted = {}): void {
  afterRun(core, E.changeReverted, d, { [A.reason]: d.reason })
}

export function closed(core: WriterCore, d: ChangeClosed = {}): void {
  afterRun(core, E.changeClosed, d, { [A.actor]: d.by })
}

export function incident(core: WriterCore, d: ChangeIncident = {}): void {
  afterRun(core, E.changeIncident, d, { [A.severity]: d.severity, [A.changeLink]: d.link })
}
