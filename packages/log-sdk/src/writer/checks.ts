import type { TimeInput } from '@opentelemetry/api'
import { ATTRIBUTE_NAMES as A, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from '../contract/catalogue.js'
import { emitEvent, runSpanRef, type WriterCore, wholeSpan } from './attributes.js'

type Times = { startTime?: TimeInput; endTime?: TimeInput }

export type ChecksRan = Times & {
  where: 'hook' | 'local' | 'push' | 'ci'
  ran: number
  passed: number
  failed: number
  skipped: number
  failedNames: readonly string[]
}
export type ChecksLocal = Times & { passed: boolean }
export type ChecksCi = Times & {
  result: 'green' | 'red' | 'pending' | 'skipped'
  failing?: readonly string[]
  waitMs?: number
}
export type ChecksRerun = Times & { failed: number; affected: number; total: number }
export type CheckNotPassed = { name: string; version?: string; result: string; reason?: string }
export type ChecksRead = { round?: number; green: boolean }

const underRound = (core: WriterCore) => core.current.round ?? runSpanRef(core)

/** One `vinaya.checks {where}` span: where the checks ran, how many, and which failed. */
export function ran(core: WriterCore, d: ChecksRan): void {
  wholeSpan(
    core,
    spanName(S.checks, d.where),
    underRound(core),
    {
      [A.checkWhere]: d.where,
      [A.checksRan]: d.ran,
      [A.checksPassed]: d.passed,
      [A.checksFailed]: d.failed,
      [A.checksSkipped]: d.skipped,
      [A.failedNames]: [...d.failedNames]
    },
    d
  )
}

export function local(core: WriterCore, d: ChecksLocal): void {
  wholeSpan(
    core,
    spanName(S.checks, 'local'),
    underRound(core),
    { [A.checkWhere]: 'local', [A.result]: d.passed ? 'passed' : 'failed' },
    d
  )
}

export function ci(core: WriterCore, d: ChecksCi): void {
  wholeSpan(
    core,
    spanName(S.checks, 'ci'),
    underRound(core),
    {
      [A.checkWhere]: 'ci',
      [A.result]: d.result,
      [A.failedNames]: d.failing === undefined ? undefined : [...d.failing],
      [A.waitMs]: d.waitMs
    },
    d
  )
}

export function rerun(core: WriterCore, d: ChecksRerun): void {
  wholeSpan(
    core,
    spanName(S.checks, 'rerun'),
    underRound(core),
    { [A.rerunFailed]: d.failed, [A.rerunAffected]: d.affected, [A.rerunTotal]: d.total },
    d
  )
}

export function notPassed(core: WriterCore, d: CheckNotPassed): void {
  emitEvent(
    core,
    E.checkNotPassed,
    {
      [A.checkName]: d.name,
      [A.checkVersion]: d.version,
      [A.result]: d.result,
      [A.reason]: d.reason
    },
    underRound(core)
  )
}

export function read(core: WriterCore, d: ChecksRead): void {
  emitEvent(
    core,
    E.checkRead,
    { [A.roundNumber]: d.round ?? core.moment.round, [A.checksGreen]: d.green },
    underRound(core)
  )
}
