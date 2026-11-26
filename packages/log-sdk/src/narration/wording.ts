/**
 * The Log's narration wording: every sentence, the reason table and the
 * confidence clause, built from plain values (a seat's reading, a round, a
 * reason code). Pure code with no import at all, so the terminal, Mission
 * Control's feed and Studio's bundle say the same words from the same table.
 * Reading a record or an earlier event into those plain values is the
 * caller's work.
 */

export const NARRATION_KINDS = [
  'starting',
  'working',
  'done',
  'failed',
  'waiting',
  'paused',
  'blocked',
  'information'
] as const
export type NarrationKind = (typeof NARRATION_KINDS)[number]

export type NarrationLine = { kind: NarrationKind; text: string }

/** Why the loop stops or pauses, in words, and whether a person has to act. A reason absent from this table reads as paused, with its code. */
const REASONS: Record<string, { words: string; person: boolean }> = {
  escalation: { words: 'a role escalated a question', person: true },
  approved_repairs_spent: { words: 'the approved repair turns ran out without a green CI', person: true },
  ready_push_failed: { words: 'the ready push failed three consecutive times', person: true },
  max_rounds: { words: 'the round limit was reached', person: true },
  no_progress: { words: 'the rounds made no progress', person: true },
  confidence: { words: 'the stated confidence collapsed', person: true },
  reappearance: { words: 'a finding marked resolved came back', person: true },
  repeat_finding: { words: 'the same blocking finding stayed open two rounds in a row', person: true },
  repeat_failure: { words: 'the same mechanical failure happened twice in a row', person: true },
  time_budget: { words: 'the time budget was passed', person: true },
  infrastructure: { words: 'a role or file the round needed was missing', person: true },
  no_push: { words: 'work was left unpushed', person: true },
  objectives_changed: { words: 'the objectives changed during the round', person: false },
  ruling_posted: { words: 'a ruling was posted during the round', person: false },
  stale_driver: { words: 'the base branch moved past the driver code', person: false },
  brief_superseded: { words: 'the brief was replaced during the round', person: false },
  policy_changed: { words: 'the review policy changed during the round', person: false },
  sandbox_refused: { words: "the agent's sandbox could not run a command on this host", person: true },
  missing_source: { words: 'a required source could not be prepared', person: true },
  principal_stop: { words: 'an item needs a person to decide', person: true },
  escalated: { words: 'a role escalated a question', person: true }
}

/** Reasons a pause record names without a code. */
const PAUSE_WITHOUT_CODE: Record<string, string> = {
  escalation: 'escalation',
  principal_item: 'principal_stop'
}

const CODE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/

export function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function wholeOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

export function codeOf(value: unknown): string | null {
  return typeof value === 'string' && CODE_TOKEN.test(value) ? value : null
}

/** A seat as a noun phrase: "the <reading>" for a seat with a reading, "a role" for one without. */
export function subjectFor(reading: string | null): string {
  return reading === null ? 'a role' : `the ${reading}`
}

function startOfSentence(phrase: string): string {
  return `${phrase[0]?.toUpperCase() ?? ''}${phrase.slice(1)}`
}

export function roundLabel(round: number | null): string {
  return round === null ? 'The round' : `Round ${round}`
}

/** Minutes and seconds, rounded to the second. */
function duration(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function reasonKey(reasonCode: string | null, fallbackReason: string | null): string | null {
  return reasonCode ?? (fallbackReason ? (PAUSE_WITHOUT_CODE[fallbackReason] ?? null) : null)
}

/**
 * Who a pause or stop reason waits on, read from the same table the lines
 * use: `'person'` when a person has to act, `'loop'` when the loop answers it
 * itself, `null` when the table does not hold the reason. `reasonCode` is a
 * pause's reason code or a stop's condition; `fallbackReason` is a pause's
 * three-value reason, read only when no code is given.
 */
export function reasonWaitsOn(
  reasonCode: string | null,
  fallbackReason: string | null = null
): 'person' | 'loop' | null {
  const key = reasonKey(reasonCode, fallbackReason)
  const known = key ? REASONS[key] : undefined
  if (!known) return null
  return known.person ? 'person' : 'loop'
}

export function roundStartedLine(round: number | null): NarrationLine {
  return { kind: 'starting', text: `${roundLabel(round)} started.` }
}

export function checksLine(round: number | null, green: boolean): NarrationLine {
  return green
    ? { kind: 'done', text: `${roundLabel(round)}: the checks passed.` }
    : { kind: 'failed', text: `${roundLabel(round)}: the checks failed.` }
}

export function pausedLine(reasonCode: string | null, fallbackReason: string | null): NarrationLine {
  const key = reasonKey(reasonCode, fallbackReason)
  const known = key ? REASONS[key] : undefined
  if (known) {
    return known.person
      ? { kind: 'blocked', text: `The loop paused for a person: ${known.words}.` }
      : { kind: 'paused', text: `The loop paused itself: ${known.words}.` }
  }
  const named = reasonCode ?? codeOf(fallbackReason)
  return { kind: 'paused', text: named ? `Paused: ${named}.` : 'Paused.' }
}

/** A pause that records one reason as a single value: the code when it is one, else the reason it names. */
export function pausedForValue(why: string | null): NarrationLine {
  if (why === null) return pausedLine(null, null)
  return pausedLine(why in PAUSE_WITHOUT_CODE ? null : codeOf(why), why)
}

export function stoppedLine(condition: unknown): NarrationLine | null {
  const name = codeOf(condition)
  if (!name) return null
  if (name === 'green') return { kind: 'done', text: 'The loop stopped: every check and review passed.' }
  const known = REASONS[name]
  if (!known) return { kind: 'information', text: `Stopped: ${name}.` }
  return known.person
    ? { kind: 'blocked', text: `The loop stopped itself: ${known.words}. A person has to act.` }
    : { kind: 'paused', text: `The loop stopped itself: ${known.words}.` }
}

/** What a round's own gate read recorded about confidence. */
export type ConfidenceRead = { unavailable: boolean; value: unknown; extraTurn: boolean }

/** The confidence in words; `null` when no gate read of the round was supplied, so nothing is claimed. */
export function confidenceClause(read: ConfidenceRead | null): string | null {
  if (!read) return null
  if (read.unavailable) return 'Confidence: not given.'
  const value = read.value
  if (wholeOf(value) !== null && (value as number) >= 0 && (value as number) <= 100)
    return `Confidence: ${value}${read.extraTurn ? ' (after the extra turn)' : ''}.`
  return 'Confidence: —.'
}

export type VerdictEntry = {
  /** The seat as a noun phrase, from `subjectFor` or the seat as recorded. */
  subject: string
  outcome: unknown
  blockers: number | null
}

export function verdictsLine(detail: {
  round: number | null
  blockers: number | null
  allApprove: boolean
  reviewers: readonly VerdictEntry[]
}): NarrationLine {
  const label = roundLabel(detail.round)
  const parts: string[] = []
  for (const entry of detail.reviewers) {
    const who = parts.length === 0 ? startOfSentence(entry.subject) : entry.subject
    if (entry.outcome === 'approve') parts.push(`${who} approved`)
    else if (entry.outcome === 'changes_requested')
      parts.push(`${who} asked for changes (${entry.blockers ?? 0} blocking)`)
    else if (entry.outcome === 'not_reviewed') parts.push(`${who} did not review`)
  }
  const approved = detail.allApprove
  const text = parts.length > 0 ? parts.join('; ') : approved ? 'approved' : `${detail.blockers ?? 0} blocking`
  return { kind: approved ? 'done' : 'information', text: `${label} verdicts: ${text}.` }
}

export function roundEndedLine(detail: {
  round: number | null
  wallMs: unknown
  outcome: unknown
  confidence: string | null
}): NarrationLine {
  const label = roundLabel(detail.round)
  const took = duration(detail.wallMs)
  const [kind, words]: [NarrationKind, string] =
    detail.outcome === 'green'
      ? ['done', 'approved']
      : detail.outcome === 'changes_requested'
        ? ['information', 'changes requested']
        : detail.outcome === 'escalated'
          ? ['blocked', 'a role escalated, a person has to decide']
          : ['information', 'ended']
  return {
    kind,
    text: `${label} ended${took ? ` after ${took}` : ''}: ${words}.${detail.confidence ? ` ${detail.confidence}` : ''}`
  }
}

export function driverExitedLine(detail: {
  reason: unknown
  exitCode: number | null
  errorClass: string | null
}): NarrationLine {
  const exitWords = detail.exitCode === null ? '' : ` (exit code ${detail.exitCode})`
  switch (detail.reason) {
    case 'finished':
      return { kind: 'done', text: `The driver finished${exitWords}.` }
    case 'paused':
      return { kind: 'paused', text: `The driver stopped because the loop paused${exitWords}.` }
    case 'reexec':
      return { kind: 'information', text: 'The driver restarted itself on updated code.' }
    case 'error':
      return {
        kind: 'failed',
        text: `The driver stopped on an error${detail.errorClass ? ` (${detail.errorClass})` : ''}${exitWords}.`
      }
    case 'signal':
      return { kind: 'failed', text: `The driver was stopped by a signal${exitWords}.` }
    default: {
      const named = codeOf(detail.reason)
      return { kind: 'information', text: `The driver exited${named === null ? '' : `: ${named}`}${exitWords}.` }
    }
  }
}

export function conflictReentryLine(detail: {
  pr: number | null
  attempt: number | null
  bound: number | null
}): NarrationLine {
  const count =
    detail.attempt !== null && detail.bound !== null ? ` (re-entry ${detail.attempt} of ${detail.bound})` : ''
  return {
    kind: 'working',
    text: `${detail.pr === null ? 'The pull request' : `Pull request #${detail.pr}`} fell into conflict with the default branch after it was published: the loop re-entered by itself to send it back to the Developer${count}.`
  }
}

export function dispatchedLine(detail: { subject: string; reviewing: boolean; round: number | null }): NarrationLine {
  const { reviewing, round } = detail
  return {
    kind: 'working',
    text: `${startOfSentence(detail.subject)} is ${reviewing ? 'reviewing' : 'working'}${round === null ? '' : `${reviewing ? '' : ' on'} round ${round}`}.`
  }
}

export function turnEndedLine(detail: { subject: string; escalation: { class: string | null } | null }): NarrationLine {
  const who = startOfSentence(detail.subject)
  if (detail.escalation) {
    const kind = detail.escalation.class
    return {
      kind: 'blocked',
      text: `${who} raised an escalation${kind ? ` (${kind})` : ''}. A person has to decide.`
    }
  }
  return { kind: 'done', text: `${who} finished its turn.` }
}

const line = (kind: NarrationKind, text: string): NarrationLine => ({ kind, text })

/** The stage words the loop's follow view uses, by stage code. */
const STAGE_WORDS: Record<string, string> = {
  develop: 'develop',
  local_checks: 'local checks',
  review: 'review',
  ready_push: 'ready push',
  focused_checks: 'focused checks at ready',
  pr_opened: 'pull request opened',
  required_ci: 'waiting on required CI',
  waiting_merge: 'waiting for merge',
  paused_developer: 'paused for the Developer',
  paused_operator: 'paused for the Operator',
  paused_principal: 'paused for the Principal'
}

/** The step-kind words the agent line uses, by step kind, as a continuing action. */
const STEP_WORDS: Record<string, string> = {
  reading: 'reading',
  searching: 'searching',
  editing: 'editing',
  creating: 'creating',
  removing: 'removing',
  running_tests: 'running tests',
  type_checking: 'type-checking',
  git: 'running git',
  github: 'using GitHub',
  tool_request: 'requesting tool',
  skill: 'using skill',
  fetching: 'fetching',
  delegating: 'delegating'
}

/** What a person is asked to decide, in words, by decision code. A decision absent here reads as its code. */
const DECISION_WORDS: Record<string, string> = { ruling: 'a ruling is owed' }

function pullRequest(change: string | null): string {
  return change === null ? 'The pull request' : `Pull request ${change}`
}

export function runStartedLine(): NarrationLine {
  return line('starting', 'The run started.')
}

export function runEndedLine(outcome: string | null): NarrationLine {
  if (outcome === 'ready') return line('done', 'The run ended: the work is ready.')
  return line('information', outcome === null ? 'The run ended.' : `The run ended: ${outcome}.`)
}

export function aliveLine(round: number | null): NarrationLine {
  return line('working', `${round === null ? 'The run' : roundLabel(round)} is still going.`)
}

export function stageChangedLine(stage: string | null, round: number | null): NarrationLine {
  const code = codeOf(stage)
  const words = code === null ? null : (STAGE_WORDS[code] ?? code)
  const text = words === null ? `${roundLabel(round)}: the stage changed.` : `${roundLabel(round)}: ${words}.`
  return line(code !== null && code.startsWith('paused_') && code in STAGE_WORDS ? 'waiting' : 'information', text)
}

export function pauseEndedLine(by: string | null): NarrationLine {
  return line('information', `The pause ended${by === null ? '' : ` (${by})`}.`)
}

export function cancelledLine(by: string | null): NarrationLine {
  return line('information', `The run was cancelled${by === null ? '' : ` by ${by}`}.`)
}

export function retriedLine(detail: {
  failed: string | null
  tries: number | null
  recovered: boolean
}): NarrationLine {
  const what = detail.failed ?? 'a step'
  const tries = detail.tries === null ? '' : ` after ${detail.tries} ${detail.tries === 1 ? 'try' : 'tries'}`
  return detail.recovered
    ? line('information', `Retried ${what}: it recovered${tries}.`)
    : line('failed', `Retried ${what}: it did not recover${tries}.`)
}

export function phaseEndedLine(phase: string | null, errorType: string | null): NarrationLine {
  const label = phase === null ? 'The phase' : `The ${phase} phase`
  return errorType === null ? line('done', `${label} ended.`) : line('failed', `${label} failed (${errorType}).`)
}

export function agentFailedLine(subject: string, errorType: string | null): NarrationLine {
  return line(
    'failed',
    `${startOfSentence(subject)} stopped on an error${errorType === null ? '' : ` (${errorType})`}.`
  )
}

export function stepStartedLine(subject: string, kind: string | null, target: string | null): NarrationLine {
  const doing = (kind === null ? undefined : STEP_WORDS[kind]) ?? 'working'
  return line('working', `${startOfSentence(subject)} is ${doing}${target === null ? '' : ` ${target}`}.`)
}

export function stepEndedLine(tool: string | null, errorType: string | null): NarrationLine {
  const label = tool === null ? 'A step' : `The ${tool} step`
  return errorType === null ? line('done', `${label} finished.`) : line('failed', `${label} failed (${errorType}).`)
}

export function confidenceStatedLine(round: number | null, value: unknown): NarrationLine {
  const stated = wholeOf(value) !== null ? `${value}` : '—'
  return line('information', `${roundLabel(round)}: confidence stated as ${stated}.`)
}

export function usageRecordedLine(detail: {
  input: number | null
  output: number | null
  unknownReason: string | null
  cost?: number | null
  costKind?: string | null
  costUnknownReason?: string | null
}): NarrationLine {
  if (detail.input === null && detail.output === null)
    return line('information', `Usage was not known${detail.unknownReason ? `: ${detail.unknownReason}` : ''}.`)
  const parts: string[] = []
  if (detail.input !== null) parts.push(`${detail.input} tokens in`)
  if (detail.output !== null) parts.push(`${detail.output} out`)
  let tail = ''
  if (detail.cost !== null && detail.cost !== undefined)
    tail = `; cost ${detail.cost}${detail.costKind ? ` (${detail.costKind})` : ''}`
  else if (detail.costUnknownReason) tail = `; cost unknown: ${detail.costUnknownReason}`
  return line('information', `Usage recorded: ${parts.join(', ')}${tail}.`)
}

export function findingsComparedLine(count: {
  open: number
  resolved: number
  fresh: number
  recurring: number
}): NarrationLine {
  return line(
    'information',
    `Findings compared: ${count.open} open, ${count.resolved} resolved, ${count.fresh} new, ${count.recurring} recurring.`
  )
}

export function checksEndedLine(detail: {
  where: string | null
  result: string | null
  ran: number | null
  failed: number | null
}): NarrationLine {
  const where = detail.where === null ? 'The' : `The ${detail.where}`
  const { result } = detail
  if (result === 'passed' || result === 'green') return line('done', `${where} checks passed.`)
  if (result === 'failed' || result === 'red') return line('failed', `${where} checks failed.`)
  if (result === 'pending') return line('waiting', `${where} checks are pending.`)
  if (result === null && detail.ran !== null && detail.failed !== null)
    return detail.failed === 0 ? line('done', `${where} checks passed.`) : line('failed', `${where} checks failed.`)
  return line('information', `${where} checks ended${result === null ? '' : `: ${result}`}.`)
}

export function checkNotPassedLine(name: string | null, result: string | null): NarrationLine {
  return line(
    'failed',
    `${name === null ? 'A check' : `Check ${name}`} did not pass${result === null ? '' : ` (${result})`}.`
  )
}

export function changeSavedLine(branch: string | null): NarrationLine {
  return line('information', `The work was saved${branch === null ? '' : ` on branch ${branch}`}.`)
}

export function changePushedLine(result: string | null): NarrationLine {
  if (result === 'passed') return line('done', 'The push passed its checks.')
  if (result === 'refused') return line('failed', 'The push was refused.')
  return line('information', 'The work was pushed.')
}

export function changeOpenedLine(change: string | null): NarrationLine {
  return line('done', change === null ? 'Ready: a pull request.' : `Ready: pull request ${change}.`)
}

export function changeRecoveredLine(): NarrationLine {
  return line('information', 'The pull request recovered from its conflict.')
}

export function changeMergedLine(change: string | null): NarrationLine {
  return line('done', `${pullRequest(change)} was merged.`)
}

export function changeClosedLine(change: string | null): NarrationLine {
  return line('information', `${pullRequest(change)} was closed without merging.`)
}

export function changeRevertedLine(change: string | null): NarrationLine {
  return line('information', `${pullRequest(change)} was reverted.`)
}

export function changeIncidentLine(change: string | null, severity: string | null): NarrationLine {
  return line('failed', `${pullRequest(change)} caused an incident${severity === null ? '' : ` (${severity})`}.`)
}

export function personAskedLine(decision: string | null, why: string | null): NarrationLine {
  const code = codeOf(decision) ?? codeOf(why)
  if (code === null) return line('waiting', 'Waiting for a person.')
  return line('waiting', `Waiting for a person: ${DECISION_WORDS[code] ?? code}.`)
}

export function personAnsweredLine(answer: string | null): NarrationLine {
  return line('information', `A person answered${answer === null ? '' : `: ${answer}`}.`)
}

function outside(action: string | null, target: string | null): string {
  return [action, target].filter((part) => part !== null).join(' ') || 'an outside action'
}

export function forgeValidatedLine(action: string | null, target: string | null): NarrationLine {
  return line('information', `Checked a forge write: ${outside(action, target)}.`)
}

export function forgeRefusedLine(action: string | null, target: string | null, why: string | null): NarrationLine {
  return line('blocked', `A forge write was refused: ${outside(action, target)}${why === null ? '' : ` (${why})`}.`)
}

export function forgeWrittenLine(action: string | null, target: string | null): NarrationLine {
  return line('done', `Wrote to the forge: ${outside(action, target)}.`)
}

export function actionVerifiedLine(action: string | null, target: string | null, result: string | null): NarrationLine {
  const what = outside(action, target)
  if (result === 'success') return line('done', `Verified: ${what}.`)
  if (result === 'failure') return line('failed', `Verification failed: ${what}.`)
  return line('information', `Could not be sure of: ${what}.`)
}

export function commandCompletedLine(
  action: string | null,
  target: string | null,
  result: string | null
): NarrationLine {
  const what = outside(action, target)
  if (result === 'ok') return line('done', `Command finished: ${what}.`)
  if (result === 'error') return line('failed', `Command failed: ${what}.`)
  if (result === 'timeout') return line('failed', `Command timed out: ${what}.`)
  return line('information', `Command ended${result === null ? '' : ` (${result})`}: ${what}.`)
}

export function customEventLine(name: string): NarrationLine {
  return line('information', `Event ${name} was recorded.`)
}
