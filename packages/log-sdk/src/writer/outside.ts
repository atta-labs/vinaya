import { ATTRIBUTE_NAMES as A, type EVENT_NAMES as E } from '../contract/catalogue.js'
import { emitEvent, runSpanRef, type WriterCore } from './attributes.js'

export type OutsideAction = { action: string; target: string; result: string; errorType?: string }

export function outsideAction(
  core: WriterCore,
  name: typeof E.forgeAction | typeof E.verifiedAction | typeof E.commandCompleted,
  detail: OutsideAction
): void {
  emitEvent(
    core,
    name,
    {
      [A.action]: detail.action,
      [A.target]: detail.target,
      [A.result]: detail.result,
      [A.errorType]: detail.errorType
    },
    runSpanRef(core)
  )
}
