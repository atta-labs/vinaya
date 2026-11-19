import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S } from '../contract/catalogue.js'
import type { SpanParent } from '../contract/ids.js'
import { emitEvent, endSpan, runSpanRef, startSpan, type WriterCore } from './attributes.js'

const names = { hook: S.checkHook, local: S.checkLocal, push: S.checkPush, ci: S.checkCi }

export type StartChecks = { where: keyof typeof names; startTime?: TimeInput }
export type EndChecks = {
  ran: number
  passed: number
  failed: number
  skipped: number
  failedNames: readonly string[]
  waitMs?: number
  reruns?: number
  endTime?: TimeInput
}
export type CheckResult = { name: string; result: string; checks?: SpanParent }

export function startChecks(core: WriterCore, detail: StartChecks): SpanParent {
  return startSpan(core, {
    name: names[detail.where],
    startedEvent: E.checksStarted,
    attrs: { [A.checkWhere]: detail.where },
    parent: core.current.round ?? runSpanRef(core),
    startTime: detail.startTime
  })
}

export function endChecks(core: WriterCore, ref: SpanParent, detail: EndChecks): void {
  endSpan(
    core,
    ref,
    {
      [A.checksRan]: detail.ran,
      [A.checksPassed]: detail.passed,
      [A.checksFailed]: detail.failed,
      [A.checksSkipped]: detail.skipped,
      [A.failedNames]: [...detail.failedNames],
      [A.waitMs]: detail.waitMs,
      [A.reruns]: detail.reruns
    },
    detail.endTime
  )
}

export function checkResult(
  core: WriterCore,
  name: typeof E.checkNotPassed | typeof E.checkResultRead,
  detail: CheckResult
): void {
  emitEvent(
    core,
    name,
    {
      [A.checkName]: detail.name,
      [A.result]: detail.result
    },
    detail.checks ?? core.current.round ?? runSpanRef(core)
  )
}
