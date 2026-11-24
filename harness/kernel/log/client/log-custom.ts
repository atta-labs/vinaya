/**
 * Records a consumer's own declared log event (`harness/kernel/log/log.md`
 * § Custom events). Reads the declarations from the loaded config's
 * `logs.events`, checks the event against them with the Log SDK's
 * `checkCustomEvent`, and writes through the process's own run handle.
 *
 * A declared event with every field present and of its declared type is one
 * `log.custom.recorded` record: the event `<namespace>.<name>` carrying its
 * declared fields. Anything else writes no custom record: one
 * `log.command.completed` record for the command `log.emit` with result
 * `refused` and the refusal code as its error kind records why — never a field
 * name or value, since a rejected value may be the secret — and the caller
 * receives the refusal with the field names.
 */

import {
  type CustomEventDeclarations,
  type CustomEventRefusalReason,
  CUSTOM_EVENT_NAME_MAX_LENGTH,
  CUSTOM_EVENT_NAME_PATTERN,
  checkCustomEvent
} from '../custom'
import { configProvider } from '../../config/loader/config-provider.js'
import { type RunRecorder, runRecorder } from '../run-recorder.js'

/** The run handle the record is written through; `undefined` while recording is off. */
type RunHandle = ReturnType<RunRecorder['handle']>

export type EmitCustomEventResult =
  | { ok: true; name: string }
  | { ok: false; reason: CustomEventRefusalReason; fieldNames: string[] }

export type EmitCustomEventDeps = {
  /** The declarations in force; defaults to the loaded config's `logs.events`. */
  declarations: () => CustomEventDeclarations
  /** The run handle the record is written through; `undefined` while recording is off. */
  handle: (scope: { repository?: string; workRef?: string }) => RunHandle
  /** The repository the record is filed under, as `owner/repo`, when the caller knows it. */
  repository?: string
  /** The work reference the record belongs to, when the caller has one outside Vinaya. */
  workRef?: string
}

/** The command a refused custom event is recorded as. */
export const LOG_EMIT_COMMAND = 'log.emit'

const defaultDeps: EmitCustomEventDeps = {
  // The composed schema validated `logs.events` against `CustomEventDeclarationsSchema`.
  declarations: () =>
    ((configProvider().loadConfig()?.logs || undefined)?.events as CustomEventDeclarations | undefined) ?? {},
  handle: (scope) => runRecorder().handle(undefined, scope.repository, scope.workRef)
}

export function emitCustomEvent(
  name: string,
  fields: Readonly<Record<string, unknown>>,
  deps: Partial<EmitCustomEventDeps> = {}
): EmitCustomEventResult {
  const { declarations, handle, repository, workRef } = { ...defaultDeps, ...deps }
  const checked = checkCustomEvent(declarations(), name, fields)
  const scope = {
    ...(repository === undefined ? {} : { repository }),
    ...(workRef === undefined ? {} : { workRef })
  }
  if (checked.ok) {
    handle(scope)?.custom.recorded(checked.name, checked.fields)
    return { ok: true, name: checked.name }
  }
  handle(scope)?.command.completed({
    action: LOG_EMIT_COMMAND,
    // The name only when it is shaped like one — an undeclared name is the
    // caller's own text and could be anything.
    ...(name.length <= CUSTOM_EVENT_NAME_MAX_LENGTH && CUSTOM_EVENT_NAME_PATTERN.test(name) ? { target: name } : {}),
    result: 'refused',
    errorType: checked.reason
  })
  return { ok: false, reason: checked.reason, fieldNames: checked.fieldNames }
}
