import { checkCustomEvent, type CustomEventDeclarations } from '../contract/custom.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'

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
    core.report(new Error('custom event refused (wrong_type) []'))
    return
  }
  const checked = checkCustomEvent(declarations, name, snapshot)
  if (!checked.ok) {
    core.report(new Error(`custom event refused (${checked.reason}) [${checked.fieldNames.join(', ')}]`))
    return
  }
  emitEvent(core, checked.name, {}, runSpanRef(core), undefined, checked.fields)
}
