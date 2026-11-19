import { checkCustomEvent, type CustomEventDeclarations } from '../contract/custom.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'

export function custom(
  core: WriterCore,
  declarations: CustomEventDeclarations,
  name: string,
  fields: Readonly<Record<string, unknown>>
): void {
  if (!core.enabled) return
  const checked = checkCustomEvent(declarations, name, fields)
  if (!checked.ok) {
    core.report(new Error(`custom event refused (${checked.reason}) [${checked.fieldNames.join(', ')}]`))
    return
  }
  emitEvent(core, checked.name, {}, runSpanRef(core), undefined, checked.fields)
}
