import {
  CUSTOM_EVENT_NAME_MAX_LENGTH,
  CUSTOM_EVENT_NAME_PATTERN,
  checkCustomEvent,
  type CustomEventDeclarations,
  type CustomEventRefusalReason
} from '../contract/custom.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'
import { commandCompleted } from './outside.js'

/** The command a refused custom event is recorded as. */
const EMIT_COMMAND = 'log.emit'

/**
 * Records the refusal of a custom event as one command record, then reports it.
 * The record holds the reason and, only when the name is shaped like a declared
 * name, the name; never a field name or value. It never throws.
 */
function refuse(core: WriterCore, name: unknown, reason: CustomEventRefusalReason, fieldNames: string[]): void {
  try {
    const shaped =
      typeof name === 'string' && name.length <= CUSTOM_EVENT_NAME_MAX_LENGTH && CUSTOM_EVENT_NAME_PATTERN.test(name)
    commandCompleted(core, {
      action: EMIT_COMMAND,
      ...(shaped ? { target: name } : {}),
      result: 'refused',
      errorType: reason
    })
  } catch (e) {
    core.report(e)
  }
  core.report(new Error(`custom event refused (${reason}) [${fieldNames.join(', ')}]`))
}

function snapshotFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(fields)) {
    // The checker examines field names first. Read each value only when
    // requested, and cache it for the length check and final copy.
    Object.defineProperty(snapshot, key, {
      configurable: true,
      enumerable: true,
      get() {
        let value: unknown
        try {
          value = fields[key]
        } catch {
          // An unreadable field has no valid value. Keep its error private.
        }
        Object.defineProperty(snapshot, key, { value, enumerable: true })
        return value
      }
    })
  }
  return snapshot
}

export function custom(
  core: WriterCore,
  declarations: CustomEventDeclarations,
  name: string,
  fields: Readonly<Record<string, unknown>>
): void {
  if (!core.enabled) return
  let snapshot: Record<string, unknown> = {}
  try {
    if (Object.hasOwn(declarations, name)) snapshot = snapshotFields(fields)
  } catch {
    refuse(core, name, 'wrong_type', [])
    return
  }
  const checked = checkCustomEvent(declarations, name, snapshot)
  if (!checked.ok) {
    refuse(core, name, checked.reason, checked.fieldNames)
    return
  }
  emitEvent(core, checked.name, {}, runSpanRef(core), undefined, checked.fields)
}
