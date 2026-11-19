import { ATTRIBUTE_NAMES as A, EARLIER_EVENT_PREFIX, EVENT_NAMES as E, SPAN_NAMES as S } from './catalogue.js'
import { spanIdFor } from './ids.js'
import type { LogEvent } from './schema.js'
import { recordIdentity } from './store.js'

export type Fields = Record<string, unknown>
type Usage = { effectId: string; input: number; output: number }
type Mapping = {
  mode: 'event' | 'start' | 'end' | 'span'
  name: string
  key: string
  parent?: string
  attributes: Fields
  durationMs?: number
  usage?: Usage
  repeatable?: true
}

const agentKey = (effectId: string) => `agent:${effectId}`
const people = { authority: S.personAuthority, strategy: S.personStrategy, product: S.personProduct }
const checks = { hook: S.checkHook, cli: S.checkLocal, loop: S.checkLocal, ci: S.checkCi }

export function agentSpanIdFor(runId: string, effectId: string): string {
  return spanIdFor(runId, agentKey(effectId))
}

export function mapEarlierEvent(event: LogEvent): Mapping {
  const round = ('round' in event ? event.round : undefined) ?? event.subject.round
  const roundKey = round === undefined ? 'run' : `round:${round}`
  const point = (name: string, attributes: Fields = {}, key = 'run'): Mapping => ({
    mode: 'event',
    name,
    key,
    attributes
  })
  const span = (
    mode: 'start' | 'end' | 'span',
    name: string,
    key: string,
    attributes: Fields,
    parent = roundKey,
    durationMs?: number
  ): Mapping => ({
    mode,
    name,
    key,
    attributes,
    ...(parent === '' ? {} : { parent }),
    ...(durationMs === undefined ? {} : { durationMs })
  })
  const standalone = (name: string, attributes: Fields, durationMs?: number) =>
    span('span', name, `${name}:${recordIdentity(event)}`, attributes, roundKey, durationMs)
  const person = (kind: keyof typeof people, key: string, start: boolean, attributes: Fields): Mapping => ({
    ...span(
      start ? 'start' : 'end',
      start ? E.personAsked : people[kind],
      key,
      { [A.questionKind]: kind, ...attributes },
      'run'
    ),
    repeatable: true
  })

  switch (event.kind) {
    case 'dev_review_loop':
      switch (event.event) {
        case 'loop_started':
          return span('start', E.runStarted, 'run', { [A.operationName]: S.run }, '')
        case 'journal_finalized':
          return span(
            'end',
            S.run,
            'run',
            { [A.operationName]: S.run, [A.result]: event.result, [A.commit]: event.final_head },
            ''
          )
        case 'round_started':
          return span('start', E.roundStarted, roundKey, { [A.roundNumber]: round }, 'run')
        case 'round_ended':
          return span(
            'end',
            S.round,
            roundKey,
            { [A.roundNumber]: round, [A.result]: event.outcome, [A.commit]: event.head },
            'run'
          )
        case 'paused':
          return person('strategy', `pause:${round}`, true, { [A.reason]: event.reason_code ?? event.reason })
        case 'resumed':
          return person('strategy', `pause:${round}`, false, { [A.answeredBy]: event.by })
        case 'cancelled':
          return point(E.cancelled, { [A.actor]: event.by })
        case 'gate_result_read':
          return point(
            E.checkResultRead,
            {
              [A.checkName]: 'gate',
              [A.result]: event.green ? 'green' : 'red',
              [A.commit]: event.head,
              [A.confidence]: event.confidence_value
            },
            roundKey
          )
        case 'verdicts_read':
          return point(
            E.reviewVerdicts,
            {
              [A.blockingCount]: event.blockers,
              [A.seats]: event.reviewers?.map((reviewer) => reviewer.role),
              [A.findingIds]: event.findings?.map((finding) => finding.id),
              [A.findingSeverities]: event.findings?.map((finding) => finding.severity)
            },
            roundKey
          )
        case 'findings_compared':
          return point(
            E.findingsCompared,
            {
              [A.findingsOpen]: event.open,
              [A.findingsResolved]: event.resolved,
              [A.findingsNew]: event.new,
              [A.findingsRecurring]: event.recurring
            },
            roundKey
          )
        case 'stop_condition_met':
          return point(E.stopRuleMet, { [A.rule]: event.condition }, roundKey)
        case 'unpushed_work_resume':
          return point(E.changeRecovered, { [A.branch]: event.branch, [A.reason]: event.detail })
        case 'infrastructure_retry':
          return point(E.retried, {
            [A.attempt]: event.attempts,
            [A.reason]: event.failure_kind,
            [A.result]: event.outcome
          })
        case 'driver_heartbeat':
          return point(E.alive, { [A.roundNumber]: round, [A.phaseName]: event.phase })
        case 'conflict_reentry':
          return point(E.changeConflicted, { [A.change]: String(event.pr), [A.attempt]: event.attempt })
        case 'storage_push':
          return point(E.changePushed, { [A.branch]: event.branch, [A.commit]: event.head })
        case 'local_checks_run':
          return standalone(
            S.checkLocal,
            {
              [A.checkWhere]: 'local',
              [A.commit]: event.head ?? undefined,
              [A.result]: event.passed ? 'passed' : 'failed'
            },
            event.wall_ms
          )
        case 'ready_push':
          return standalone(
            S.checkPush,
            {
              [A.checkWhere]: 'push',
              [A.commit]: event.head,
              [A.result]: event.outcome,
              [A.checksRan]: event.selected,
              [A.checksFailed]: event.failed
            },
            event.wall_ms
          )
        case 'failed_tests_rerun':
          return point(E.retried, { [A.reason]: event.event, [A.commit]: event.head }, roundKey)
        case 'pr_opened':
          return point(E.changeOpened, { [A.change]: String(event.pr), [A.commit]: event.head })
        case 'ci_result_read':
          return point(
            E.checkResultRead,
            {
              [A.checkName]: 'ci',
              [A.result]: event.conclusion,
              [A.failedNames]: event.failing_checks,
              [A.waitMs]: event.wait_ms
            },
            roundKey
          )
        case 'phase_time':
          return standalone(S.phase, { [A.phaseName]: event.phase }, event.wall_ms)
        case 'driver_exited':
          return point(E.exited, {
            [A.exitCode]: event.exit_code,
            [A.reason]: event.reason,
            [A.errorType]: event.error_class
          })
      }
      break
    case 'dispatch':
    case 'role_attempt': {
      const attrs = {
        [A.operationName]: S.agent,
        [A.agentId]: event.effect_id,
        [A.agentName]: event.kind === 'dispatch' ? event.target_role : event.subject.role
      }
      const key = agentKey(event.effect_id)
      if (event.event === 'dispatched') return span('start', E.agentStarted, key, attrs)
      const result =
        event.kind === 'role_attempt'
          ? span(
              'span',
              S.agent,
              `attempt:${event.effect_id}:${recordIdentity(event)}`,
              {
                ...attrs,
                [A.result]: event.outcome,
                [A.actor]: event.actor ?? undefined,
                [A.attempt]: event.attempt ?? undefined
              },
              key,
              event.duration_ms
            )
          : span('end', S.agent, key, {
              ...attrs,
              [A.result]: event.event === 'outcome_received' ? event.outcome.type : event.reason,
              [A.errorType]: event.event === 'dispatch_failed' ? event.reason : undefined
            })
      if (event.usage !== null) result.usage = { effectId: event.effect_id, ...event.usage }
      return result
    }
    case 'forge_write':
      return point(E.forgeAction, {
        [A.action]: event.op,
        [A.target]: String(event.target.issue ?? event.target.pr ?? ''),
        [A.result]: event.event,
        [A.reason]: event.event === 'refused' ? event.reason : undefined
      })
    case 'gate': {
      const where = event.meta.host === 'cli' || event.meta.host === 'loop' ? 'local' : event.meta.host
      return event.event === 'checked'
        ? point(
            event.outcome === 'pass' || event.outcome === 'skip' ? E.checkResultRead : E.checkNotPassed,
            {
              [A.checkName]: event.check,
              [A.result]: event.outcome,
              [A.checkWhere]: where,
              [A.reason]: event.reason
            },
            roundKey
          )
        : standalone(
            checks[event.meta.host],
            {
              [A.checkWhere]: where,
              [A.checksRan]: event.ran,
              [A.checksPassed]: event.passed,
              [A.checksFailed]: event.failed,
              [A.checksSkipped]: event.skipped,
              [A.failedNames]: event.failed_checks
            },
            event.duration_ms
          )
    }
    case 'operation':
      return point(E.commandCompleted, {
        [A.action]: event.operation,
        [A.target]: event.target ?? undefined,
        [A.result]: event.result,
        [A.errorType]: event.error_class ?? undefined
      })
    case 'handoff':
      return person(event.class, `handoff:${event.class}:${event.subject.issue ?? ''}`, event.event === 'raised', {
        [A.reason]: event.reason,
        [A.answeredBy]: event.event === 'resolved' ? (event.resolved_by ?? undefined) : undefined
      })
    case 'effect':
      return point(E.verifiedAction, {
        [A.action]: event.target.kind,
        [A.target]: event.target.ref,
        [A.result]: event.event === 'attempted' ? event.event : event.outcome
      })
    case 'usage':
      return point(`${EARLIER_EVENT_PREFIX}usage.observed`)
    case 'custom':
      return point(event.name, event.fields)
  }
  const unhandled: never = event
  throw new Error(`Unhandled earlier event: ${JSON.stringify(unhandled)}`)
}
