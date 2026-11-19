import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../contract/catalogue.js'
import { spanIdFor, traceIdFor } from '../contract/ids.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'

const names = {
  saved: E.changeSaved,
  pushed: E.changePushed,
  opened: E.changeOpened,
  conflicted: E.changeConflicted,
  recovered: E.changeRecovered,
  merged: E.changeMerged,
  reverted: E.changeReverted,
  incident: E.changeIncident
}

export type Change = {
  kind: keyof typeof names
  change: string
  branch?: string
  commit?: string
  by?: string
  reason?: string
  severity?: string
  runId?: string
}

export function recordChange(core: WriterCore, detail: Change): void {
  const independent = detail.kind === 'merged' || detail.kind === 'reverted' || detail.kind === 'incident'
  const runId = detail.runId
  const ref = independent
    ? runId === undefined
      ? undefined
      : { traceId: traceIdFor(runId), spanId: spanIdFor(runId, 'run') }
    : runSpanRef(core)
  emitEvent(
    core,
    names[detail.kind],
    {
      [A.change]: detail.change,
      [A.branch]: detail.branch,
      [A.commit]: detail.commit,
      [A.actor]: detail.by,
      [A.reason]: detail.reason,
      [A.severity]: detail.severity,
      [A.runId]: independent ? runId : core.runId
    },
    ref
  )
}
