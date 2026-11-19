import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E } from '../contract/catalogue.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'

/** A forge write: what was written and where. */
export type ForgeWrite = { action: string; target: string }
/** A refused forge write, and why as a short code. */
export type ForgeRefusal = ForgeWrite & { why: string }
/** One outside action, checked after the fact. */
export type ActionVerified = {
  action: string
  target: string
  result: 'success' | 'failure' | 'uncertain'
  errorType?: string
}
/** A command that finished. */
export type CommandCompleted = {
  action: string
  target?: string
  result: 'ok' | 'error' | 'refused' | 'timeout' | 'cancelled' | 'unavailable'
  errorType?: string
}

export function forgeValidated(core: WriterCore, d: ForgeWrite): void {
  emitEvent(core, E.forgeValidated, { [A.action]: d.action, [A.target]: d.target }, runSpanRef(core))
}

export function forgeRefused(core: WriterCore, d: ForgeRefusal): void {
  emitEvent(core, E.forgeRefused, { [A.action]: d.action, [A.target]: d.target, [A.reason]: d.why }, runSpanRef(core))
}

export function forgeWritten(core: WriterCore, d: ForgeWrite): void {
  emitEvent(core, E.forgeWritten, { [A.action]: d.action, [A.target]: d.target }, runSpanRef(core))
}

export function actionVerified(core: WriterCore, d: ActionVerified): void {
  emitEvent(
    core,
    E.actionVerified,
    { [A.action]: d.action, [A.target]: d.target, [A.result]: d.result, [A.errorType]: d.errorType },
    runSpanRef(core)
  )
}

export function commandCompleted(core: WriterCore, d: CommandCompleted): void {
  emitEvent(
    core,
    E.commandCompleted,
    { [A.action]: d.action, [A.target]: d.target, [A.result]: d.result, [A.errorType]: d.errorType },
    runSpanRef(core)
  )
}
