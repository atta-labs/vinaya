/**
 * Records a consumer's own declared log event (`apps/cli/specs/log.md`
 * § Custom events). Reads the declarations from the loaded config's
 * `logs.events`, checks the event against them (`checkCustomEvent`, pure, in
 * `@attalabs/aeg-core/log`), and writes through `log()` — so the header,
 * the destination and redaction are exactly every other event's.
 *
 * A declared event with every field present and of its declared type
 * becomes one `custom` line. Anything else writes no `custom` line: one
 * `operation` event named `log.emit` with result `refused` records the
 * reason class and the field names — never a value, since a rejected value
 * may be the secret — and the caller receives the refusal.
 */

import {
  type CustomEventDeclarations,
  type CustomEventRefusalReason,
  CUSTOM_EVENT_NAME_MAX_LENGTH,
  CUSTOM_EVENT_NAME_PATTERN,
  checkCustomEvent
} from '@attalabs/aeg-core/log'
import { loadConfig } from './config.js'
import { log } from './log-sink.js'

export type EmitCustomEventResult =
  | { ok: true; name: string }
  | { ok: false; reason: CustomEventRefusalReason; fieldNames: string[] }

export type EmitCustomEventDeps = {
  /** The declarations in force; defaults to the loaded config's `logs.events`. */
  declarations: () => CustomEventDeclarations
  emit: typeof log
}

const defaultDeps: EmitCustomEventDeps = {
  declarations: () => loadConfig()?.logs?.events ?? {},
  emit: log
}

export function emitCustomEvent(
  name: string,
  fields: Readonly<Record<string, unknown>>,
  deps: Partial<EmitCustomEventDeps> = {}
): EmitCustomEventResult {
  const { declarations, emit } = { ...defaultDeps, ...deps }
  const checked = checkCustomEvent(declarations(), name, fields)
  if (checked.ok) {
    emit({
      kind: 'custom',
      event: 'recorded',
      name: checked.name,
      fields: checked.fields,
      payload: {}
    })
    return { ok: true, name: checked.name }
  }
  emit({
    kind: 'operation',
    event: 'completed',
    operation: 'log.emit',
    // The name only when it is shaped like one — an undeclared name is the
    // caller's own text and could be anything.
    target: name.length <= CUSTOM_EVENT_NAME_MAX_LENGTH && CUSTOM_EVENT_NAME_PATTERN.test(name) ? name : null,
    result: 'refused',
    error_class: checked.reason,
    field_names: checked.fieldNames,
    payload: {}
  })
  return { ok: false, reason: checked.reason, fieldNames: checked.fieldNames }
}
