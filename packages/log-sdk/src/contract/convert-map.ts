import { ATTRIBUTE_NAMES as A, EARLIER_EVENT_PREFIX, EVENT_NAMES as E, SPAN_NAMES as S, spanName } from './catalogue.js'
import { spanIdFor } from './ids.js'
import { CUSTOM_EVENT_RESERVED_NAMESPACE } from './custom.js'
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
const people = new Set(['authority', 'strategy', 'product'])
/** Where the earlier checks ran, named as the handle names it. */
const checkWhere = { hook: 'hook', cli: 'local', loop: 'local', ci: 'ci' } as const
const stopRules = {
  green: 'approved',
  max_rounds: 'round_limit',
  no_progress: 'no_progress',
  escalated: 'escalated',
  principal_stop: 'person_stop',
  confidence: 'confidence',
  reappearance: 'fixed_finding_returned',
  repeat_finding: 'same_finding',
  repeat_failure: 'same_failure',
  time_budget: 'time_budget'
} as const
const exitKinds = {
  finished: 'finished',
  paused: 'paused',
  reexec: 'restarted',
  error: 'error',
  signal: 'signal'
} as const

/** A team's field may not take a name the converter stamps or the catalogue owns; such a key is moved under the earlier namespace. */
function teamFields(fields: Fields): Fields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key.startsWith('vinaya.') || key.startsWith('gen_ai.') ? `${EARLIER_EVENT_PREFIX}${key}` : key,
      value
    ])
  )
}

export function agentSpanIdFor(runId: string, effectId: string): string {
  return spanIdFor(runId, agentKey(effectId))
}

export function mapEarlierEvent(event: LogEvent): Mapping {
  const round = ('round' in event ? event.round : undefined) ?? event.subject.round
  const process = event.meta.schema === 4 ? event.meta.process.id : undefined
  // One run span and one span per round number: the loop's own events and a dispatch's
  // parent derive the same ids from the run id and the round alone.
  const runKey = 'run'
  const roundKey = round === undefined ? runKey : `${runKey}:round:${round}`
  const point = (name: string, attributes: Fields = {}, key = runKey): Mapping => ({
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
  const pause = (key: string, start: boolean, attributes: Fields): Mapping => ({
    ...span(
      start ? 'start' : 'end',
      start ? E.pauseStarted : S.pause,
      key,
      { [A.roundNumber]: round, ...attributes },
      runKey
    ),
    repeatable: true
  })
  const person = (kind: string, key: string, start: boolean, attributes: Fields): Mapping => ({
    ...span(
      start ? 'start' : 'end',
      start ? E.personAsked : spanName(S.person, kind),
      key,
      { [A.questionKind]: kind, ...attributes },
      runKey
    ),
    repeatable: true
  })

  switch (event.kind) {
    case 'dev_review_loop':
      switch (event.event) {
        case 'loop_started':
          return span(
            'start',
            E.runStarted,
            runKey,
            { [A.operationName]: 'invoke_workflow', [A.processName]: process },
            ''
          )
        case 'journal_finalized':
          return span(
            'end',
            spanName(S.run, process),
            runKey,
            {
              [A.operationName]: 'invoke_workflow',
              [A.processName]: process,
              [A.runRounds]: event.rounds,
              [A.runTotalMs]: event.total_wall_ms,
              [A.runTimeToGreenMs]: event.time_to_green_ms ?? undefined,
              [A.runFilesChanged]: event.files_changed_total,
              [A.runOutcome]: event.result === 'merged_ready' ? 'ready' : 'stopped',
              [A.commit]: event.final_head
            },
            ''
          )
        case 'round_started':
          return span('start', E.roundStarted, roundKey, { [A.roundNumber]: round }, runKey)
        case 'round_ended':
          return span(
            'end',
            spanName(S.round, round),
            roundKey,
            {
              [A.roundNumber]: round,
              [A.roundFilesChanged]: event.files_changed,
              [A.roundLinesAdded]: event.insertions,
              [A.roundLinesRemoved]: event.deletions,
              [A.roundOutcome]: event.outcome,
              [A.commit]: event.head
            },
            runKey
          )
        case 'paused':
          return pause(`${roundKey}:pause`, true, { [A.pauseWhy]: event.reason_code ?? event.reason })
        case 'resumed':
          return pause(`${roundKey}:pause`, false, { [A.pauseBy]: event.by === 'principal' ? 'person' : 'run' })
        case 'cancelled':
          return point(E.cancelled, { [A.roundNumber]: round, [A.actor]: 'person' })
        case 'gate_result_read':
          return point(E.checkRead, { [A.roundNumber]: round, [A.checksGreen]: event.green }, roundKey)
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
          return point(E.stopRuleMet, { [A.rule]: stopRules[event.condition] }, roundKey)
        case 'unpushed_work_resume':
          return point(E.changeRecovered, { [A.branch]: event.branch })
        case 'infrastructure_retry':
          return point(E.retried, {
            [A.retryTries]: event.attempts,
            [A.retryFailed]: event.failure_kind,
            [A.retryRecovered]: event.outcome === 'recovered'
          })
        case 'driver_heartbeat':
          return point(E.alive, { [A.roundNumber]: round, [A.phaseName]: event.phase })
        case 'conflict_reentry':
          return point(E.changeConflicted, { [A.change]: String(event.pr), [A.changeReentry]: event.attempt })
        case 'storage_push':
          return point(E.changeSaved, { [A.branch]: event.branch, [A.commit]: event.head })
        case 'local_checks_run':
          return standalone(
            spanName(S.checks, 'local'),
            {
              [A.checkWhere]: 'local',
              [A.commit]: event.head ?? undefined,
              [A.result]: event.passed ? 'passed' : 'failed'
            },
            event.wall_ms
          )
        case 'ready_push':
          return point(E.changePushed, {
            [A.result]: event.outcome,
            [A.changeTestsPicked]: event.selected,
            [A.changeTestsFailed]: event.failed,
            [A.changePushMs]: event.wall_ms,
            [A.commit]: event.head
          })
        case 'failed_tests_rerun':
          return standalone(spanName(S.checks, 'rerun'), {
            [A.rerunFailed]: event.failed_files,
            [A.rerunAffected]: event.affected_files,
            [A.rerunTotal]: event.full_count,
            [A.commit]: event.head
          })
        case 'pr_opened':
          return point(E.changeOpened, { [A.change]: String(event.pr), [A.commit]: event.head })
        case 'ci_result_read':
          return standalone(
            spanName(S.checks, 'ci'),
            {
              [A.checkWhere]: 'ci',
              [A.result]: event.conclusion,
              [A.failedNames]: event.failing_checks,
              [A.waitMs]: event.wait_ms
            },
            event.wait_ms
          )
        case 'phase_time':
          return standalone(
            spanName(S.phase, event.phase),
            { [A.phaseName]: event.phase, [A.phaseStep]: event.step },
            event.wall_ms
          )
        case 'driver_exited':
          return point(E.exited, {
            [A.exitKind]: exitKinds[event.reason],
            [A.exitCode]: event.exit_code,
            [A.errorType]: event.error_class
          })
      }
      break
    case 'dispatch':
    case 'role_attempt': {
      const seat = event.kind === 'dispatch' ? event.target_role : event.subject.role
      const name = spanName(S.agent, seat)
      const attrs = {
        [A.operationName]: 'invoke_agent',
        [A.agentId]: event.effect_id,
        [A.agentName]: seat,
        [A.roundNumber]: round
      }
      const key = agentKey(event.effect_id)
      if (event.event === 'dispatched') return span('start', E.agentStarted, key, attrs)
      const result =
        event.kind === 'role_attempt'
          ? span(
              'span',
              name,
              key,
              {
                ...attrs,
                [A.agentOutcome]: event.outcome,
                [A.actor]: event.actor ?? undefined,
                [A.attempt]: event.attempt ?? undefined
              },
              roundKey,
              event.duration_ms
            )
          : span('end', name, key, {
              ...attrs,
              [A.agentOutcome]: event.event === 'outcome_received' ? event.outcome.type : event.reason,
              [A.errorType]: event.event === 'dispatch_failed' ? event.reason : undefined
            })
      if (event.event !== 'dispatch_failed' && event.usage !== null) {
        result.usage = { effectId: event.effect_id, ...event.usage }
      }
      return result
    }
    case 'forge_write':
      return point(
        event.event === 'validated' ? E.forgeValidated : event.event === 'refused' ? E.forgeRefused : E.forgeWritten,
        {
          [A.action]: event.op,
          [A.target]: String(event.target.issue ?? event.target.pr ?? ''),
          [A.reason]: event.event === 'refused' ? event.reason : undefined
        }
      )
    case 'gate': {
      const where = checkWhere[event.meta.host]
      return event.event === 'checked'
        ? point(
            event.outcome === 'pass' || event.outcome === 'skip' ? E.checkRead : E.checkNotPassed,
            event.outcome === 'pass' || event.outcome === 'skip'
              ? { [A.roundNumber]: round, [A.checksGreen]: event.outcome === 'pass' }
              : { [A.checkName]: event.check, [A.result]: event.outcome, [A.reason]: event.reason },
            roundKey
          )
        : standalone(
            spanName(S.checks, where),
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
    case 'handoff': {
      const kind = people.has(event.class) ? event.class : 'authority'
      return person(
        kind,
        `handoff:${spanIdFor(event.meta.run_id, JSON.stringify([event.class, event.subject.issue, event.reason]))}`,
        event.event === 'raised',
        {
          [A.personWhy]: event.reason,
          [A.answeredBy]: event.event === 'resolved' ? (event.resolved_by ?? undefined) : undefined
        }
      )
    }
    case 'effect':
      return point(E.actionVerified, {
        [A.action]: event.target.kind,
        [A.target]: event.target.ref,
        [A.result]: event.event === 'attempted' ? event.event : event.outcome
      })
    case 'usage':
      return point(`${EARLIER_EVENT_PREFIX}usage.observed`)
    case 'custom':
      return event.name.startsWith(`${CUSTOM_EVENT_RESERVED_NAMESPACE}.`)
        ? point(`${EARLIER_EVENT_PREFIX}custom.recorded`, {
            ...teamFields(event.fields),
            [`${EARLIER_EVENT_PREFIX}name`]: event.name
          })
        : point(event.name, teamFields(event.fields))
  }
  const unhandled: never = event
  throw new Error(`Unhandled earlier event: ${JSON.stringify(unhandled)}`)
}
