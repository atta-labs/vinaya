/**
 * The Developer's turn result, from the vendor stream to the round — the one
 * production path the structured-output proof (`task-tools/result-proof.ts`)
 * established, shared by the loop and that proof so the two can never differ.
 *
 *  - **Adapter** — each CLI's native structured final output: Claude Code's
 *    terminal `result` event's `structured_output` (`--json-schema`), Codex's
 *    last `agent_message` before `turn.completed` (`--output-schema`). One
 *    authority per adapter; nothing else is read as the result, and no Stop
 *    hook stores, selects, accepts or rejects it.
 *  - **Controller** — the driver alone accepts a result. The adapter's value
 *    is shape-checked against the schema the provider was given, then judged
 *    against this turn's own context: finding ids from this handoff only, the
 *    fields the round and status allow, a ruling request naming a permissible
 *    decision, and a `sourceUses` entry — backed by a counted read — for every
 *    required Documentation source the dispatch delivered.
 *  - **Records** — every attempt is written once, never rewritten
 *    (`turn-result-<attempt>.json` in the round's Developer folder, outside
 *    the agent's sandbox), bound to the run, round, head and an attempt
 *    ordinal the driver assigns. Confidence, the round marker comment and
 *    `vinaya task status` read only accepted records.
 *
 * `reportedChecks` is the agent's own account of what it ran: shown as
 * context, never evidence, and never read by a transition guard.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONFIDENCE_REASON_MAX_LENGTH, type Confidence, type PauseReason } from '@attalabs/aeg-core'
import {
  BLOCKER_KINDS,
  DEVELOPER_TURN_RESULT_SCHEMA_VERSION,
  type DeveloperTurnResult,
  type DeveloperTurnSchemaContext,
  parseDeveloperTurnResult,
  semanticErrors
} from '../developer-turn-result.js'
import { runPath } from '../run-paths.js'

// --- adapter ----------------------------------------------------------------

/** What one invocation's stream yielded at the adapter boundary. */
export type TurnRead = {
  /** The provider session id the stream reported (Claude `session_id`, Codex `thread_id`). */
  sessionId: string | null
  /** Every structured result the model emitted along the way, accepted or not. */
  emissions: unknown[]
  /** How many terminal events carried a structured result — "exactly one accepted" is this equal to one. */
  terminalResults: number
  /** The terminal event's own outcome (`success`, `error_during_execution`, `turn.completed`, `turn.failed`, …). */
  terminal: string | null
  /** The event the result was read from, or `null` when none was. */
  event: string | null
  /** The value read, before any validation — `null` when the stream carried none. */
  raw: unknown
  /** Error text the stream itself reported, for display. */
  errors: string[]
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(value)
    } catch {
      // not a JSON line
    }
  }
  return out
}

/**
 * Claude's `stream-json`: the model hands its structured output over through
 * the `StructuredOutput` tool (each call is an emission), and the terminal
 * `result` event carries the one the CLI settled on as `structured_output` —
 * only on a `success` result that is not an error. That field is the only
 * thing read as the turn's result.
 */
export function readClaudeTurnOutput(stdout: string): TurnRead {
  const read: TurnRead = {
    sessionId: null,
    emissions: [],
    terminalResults: 0,
    terminal: null,
    event: null,
    raw: null,
    errors: []
  }
  for (const event of jsonLines(stdout)) {
    if (typeof event.session_id === 'string') read.sessionId = event.session_id
    if (event.type === 'assistant') {
      const message = event.message as { content?: unknown } | undefined
      const content = Array.isArray(message?.content) ? message.content : []
      for (const block of content as Record<string, unknown>[]) {
        if (block?.type === 'tool_use' && block.name === 'StructuredOutput') read.emissions.push(block.input)
      }
    }
    if (event.type === 'result') {
      const subtype = typeof event.subtype === 'string' ? event.subtype : 'unknown'
      read.terminal = `${subtype}${event.is_error === true ? ' (is_error)' : ''}`
      if (Array.isArray(event.errors)) read.errors.push(...event.errors.map((e) => String(e)))
      if (event.is_error === true && typeof event.result === 'string') read.errors.push(event.result)
      if (subtype === 'success' && event.is_error !== true && event.structured_output !== undefined) {
        read.terminalResults += 1
        read.raw = event.structured_output
        read.event = 'result (subtype success) .structured_output'
      }
    }
  }
  return read
}

/**
 * Codex's `exec --json`: under `--output-schema` the final `agent_message`
 * item IS the structured output, as JSON text. It is read only when the turn
 * ended in `turn.completed`; a `turn.failed`, an `error` event with no
 * completion, or a stream that simply stops yields no result.
 */
export function readCodexTurnOutput(stdout: string): TurnRead {
  const read: TurnRead = {
    sessionId: null,
    emissions: [],
    terminalResults: 0,
    terminal: null,
    event: null,
    raw: null,
    errors: []
  }
  let lastMessage: string | null = null
  for (const event of jsonLines(stdout)) {
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'thread.started' && typeof event.thread_id === 'string') read.sessionId = event.thread_id
    if (type === 'error' && typeof event.message === 'string') read.errors.push(event.message)
    if (type === 'turn.failed') {
      read.terminal = 'turn.failed'
      const error = event.error as { message?: unknown } | undefined
      if (typeof error?.message === 'string') read.errors.push(error.message)
      lastMessage = null
    }
    if (type === 'turn.started') lastMessage = null
    const item = (event.item ?? null) as Record<string, unknown> | null
    if (type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      read.emissions.push(item.text)
      lastMessage = item.text
    }
    if (type === 'turn.completed') {
      read.terminal = 'turn.completed'
      if (lastMessage !== null) {
        read.terminalResults += 1
        read.event = 'item.completed (agent_message) before turn.completed'
        try {
          read.raw = JSON.parse(lastMessage)
        } catch {
          read.raw = lastMessage
        }
      }
    }
  }
  return read
}

/** The structured-output flag each adapter passes, or `null` for a vendor with none (Gemini). */
export type TurnResultAdapter = 'claude --json-schema' | 'codex --output-schema'

/**
 * What a Developer dispatch hands the controller: the adapter that requested
 * the result (`null` when the vendor offers no native structured output), and
 * the value that adapter read off the stream — `event: null` when none.
 */
export type DeveloperTurnOutput = {
  adapter: TurnResultAdapter | null
  raw: unknown
  event: string | null
}

/**
 * The Documentation sources the dispatch delivered to the session (its
 * per-run manifest) and the ones its read gate counted as read — the driver's
 * own read receipts from `fetch_documentation`, plus the hook-recorded fetches
 * the gate grades. Both normalized (`normalizeSourceIdentity`).
 */
export type DeliveredDocumentation = {
  sources: readonly string[]
  countedReads: readonly string[]
}

// --- controller -------------------------------------------------------------

/**
 * The decisions a ruling request may ask the Principal for — the outcomes a
 * ruling on a paused task can take. A `needs_ruling` result naming anything
 * else is rejected: the Developer may ask, never invent the menu.
 */
export const PERMISSIBLE_RULING_DECISIONS = [
  'proceed_as_briefed',
  'amend_brief',
  'widen_surface',
  'supersede_task',
  'stop_task'
] as const

/** The same identity the read gate and the receipts use: trimmed, no fragment, no trailing slash. */
export function normalizeSourceIdentity(source: string): string {
  return source.trim().split('#')[0]!.replace(/\/+$/, '')
}

function isUrlSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim())
}

/** Is this a C0 control character (newlines included) or DEL? */
export function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return code <= 0x1f || code === 0x7f
}

/** The longest `reportedChecks[].command` the controller accepts — a command line, not a log. */
export const REPORTED_CHECK_COMMAND_MAX_LENGTH = 300

/** What the controller judges one result against — every field the driver's own, none the agent's. */
export type TurnResultControllerContext = {
  round: number
  /** Every finding id this round's handoff carried — `addressedFindingIds` may name only these. */
  knownFindingIds: readonly string[]
  /** This dispatch handed the Developer findings to answer, so a `completed` result must name at least one. */
  requireAddressedFindings: boolean
  documentation: DeliveredDocumentation
}

export type ControllerVerdict = { ok: true; result: DeveloperTurnResult } | { ok: false; failures: string[] }

/**
 * The controller's whole acceptance check. The adapter's value must exist and
 * match the schema; then the schema module's semantic rules run against this
 * turn's context, and the round, handoff and documentation rules below run on
 * top. Only `ok: true` is ever recorded as accepted.
 */
export function judgeTurnOutput(
  output: DeveloperTurnOutput | undefined,
  context: TurnResultControllerContext
): ControllerVerdict {
  if (output === undefined || output.adapter === null) {
    return {
      ok: false,
      failures: ['turnResult: this dispatch requested no native structured output, so it delivered no turn result']
    }
  }
  if (output.event === null) {
    return { ok: false, failures: ['turnResult: the turn ended without a structured result'] }
  }
  const required = context.documentation.sources
  const shaped = parseDeveloperTurnResult(output.raw, {
    knownFindingIds: context.knownFindingIds,
    requiredSources: required
  })
  if (!shaped.ok) return { ok: false, failures: shaped.errors }
  const result = shaped.result
  const failures = semanticErrors(result, {
    knownFindingIds: context.knownFindingIds,
    requiredSources: required,
    permissibleDecisions: PERMISSIBLE_RULING_DECISIONS
  })
  if (result.status === 'completed') {
    if (context.round === 1 && result.addressedFindingIds.length > 0) {
      failures.push('addressedFindingIds: must be empty in round 1 — no review has handed over findings yet')
    }
    if (context.requireAddressedFindings && result.addressedFindingIds.length === 0) {
      failures.push('addressedFindingIds: required — name the finding ids from this handoff that this turn addressed')
    }
    // The driver posts these commands in a comment under its own identity, so
    // one must stay a single plain line: a newline or control character could
    // break out of its code span and forge gate grammar in a trusted comment.
    for (const check of result.reportedChecks ?? []) {
      if ([...check.command].some(isControlCharacter)) {
        failures.push('reportedChecks: a command must be one line, with no newline or control character')
      } else if (check.command.length > REPORTED_CHECK_COMMAND_MAX_LENGTH) {
        failures.push(`reportedChecks: a command must be at most ${REPORTED_CHECK_COMMAND_MAX_LENGTH} characters`)
      }
    }
  }
  const delivered = new Set(required.map(normalizeSourceIdentity))
  const counted = new Set(context.documentation.countedReads.map(normalizeSourceIdentity))
  for (const use of result.sourceUses ?? []) {
    const identity = normalizeSourceIdentity(use.source)
    if (!delivered.has(identity)) {
      failures.push(`sourceUses: ${use.source} is not a required source of this brief`)
    } else if (result.status === 'completed' && isUrlSource(use.source) && !counted.has(identity)) {
      failures.push(
        `sourceUses: ${use.source} has no counted read — read it with the fetch_documentation tool before reporting its use`
      )
    }
  }
  return failures.length > 0 ? { ok: false, failures } : { ok: true, result }
}

/**
 * The instruction every Developer dispatch carries: what the turn ends with.
 * It asks for a short explanation of the confidence figure, never for the
 * model's reasoning.
 */
export function turnResultInstruction(round: number, documentation: readonly string[] = []): string {
  return [
    `End this turn with your turn result as your structured output, schemaVersion ${DEVELOPER_TURN_RESULT_SCHEMA_VERSION}, under the root key \`turnResult\`. The driver reads nothing else as your result, so write no result file.`,
    '- `status: "completed"` when this turn\'s work is done: `summary` (one sentence), `confidence` (a whole number from 0 to 100 for how sure you are the work is right), `confidenceExplanation` (one short sentence explaining that figure), ' +
      `\`addressedFindingIds\` (${round === 1 ? 'empty in round 1' : "the finding ids from this round's handoff you addressed"}), \`sourceUses\` (one entry per required Documentation source of the brief: its \`source\` exactly as the brief names it and the decision it informed — an empty list when the brief names none), and \`reportedChecks\` (the checks you ran, each as one command line with its outcome, or \`null\`).`,
    `- \`status: "blocked"\` when a stop condition halts the work: \`summary\` and a \`blocker\` whose \`kind\` is one of ${BLOCKER_KINDS.join(', ')}, with a one-sentence \`detail\`.`,
    `- \`status: "needs_ruling"\` when only the Principal can decide: \`summary\` and a \`rulingRequest\` with your \`question\` and the \`decisions\` to choose between, each one of ${PERMISSIBLE_RULING_DECISIONS.join(', ')}.`,
    ...(documentation.length > 0 ? [`Required Documentation sources: ${documentation.join(', ')}.`] : [])
  ].join('\n')
}

/**
 * The one correction prompt a rejected first result earns: only the typed
 * failures and the current authoritative context — never the rejected value
 * itself, and nothing to publish.
 */
export function turnResultCorrectionPrompt(
  failures: readonly string[],
  context: { round: number; attempt: number; head: string | null; knownFindingIds: readonly string[] }
): string {
  return [
    `The driver rejected your turn result (round ${context.round}, attempt ${context.attempt}, head ${context.head ?? 'unknown'}):`,
    failures.map((f) => `- ${f}`).join('\n'),
    context.knownFindingIds.length > 0
      ? `This round's handoff carries these finding ids:\n${context.knownFindingIds.map((id) => `- ${id}`).join('\n')}`
      : 'This round handed over no finding ids.',
    'Report a corrected turn result as your structured output. Change, commit or publish nothing for this — it is not a new turn of work.'
  ].join('\n\n')
}

/** A rejected attempt's value as recorded: the result when it at least matched the schema, else `null`. */
export function schemaValidTurnResult(raw: unknown, context: DeveloperTurnSchemaContext): DeveloperTurnResult | null {
  const shaped = parseDeveloperTurnResult(raw, context)
  return shaped.ok ? shaped.result : null
}

// --- records ----------------------------------------------------------------

/** One attempt, written once by the driver and never rewritten. */
export type TurnResultRecord = {
  version: 1
  runId: string
  round: number
  /** The driver's own ordinal for this round's attempts — never supplied by the agent. */
  attempt: number
  /** The worktree head the result was bound to, when one could be read. */
  head: string | null
  outcome: 'accepted' | 'rejected'
  /** The accepted result, or the schema-valid rejected one; `null` when nothing schema-valid arrived. */
  result: DeveloperTurnResult | null
  failures: string[]
  recordedAt: string
}

const RECORD_FILE = /^turn-result-(\d+)\.json$/

export function turnResultRecordPath(root: string, task: number, round: number, attempt: number): string {
  return runPath(root, task, { area: 'developer', round, file: `turn-result-${String(attempt).padStart(3, '0')}.json` })
}

/** This round's attempt records, oldest first; an unreadable file is skipped, never guessed. */
export function readTurnResultRecords(root: string, task: number, round: number): TurnResultRecord[] {
  let names: string[]
  try {
    names = readdirSync(runPath(root, task, { area: 'developer', round }))
  } catch {
    return []
  }
  const records: TurnResultRecord[] = []
  for (const name of names) {
    if (!RECORD_FILE.test(name)) continue
    try {
      const value = JSON.parse(
        readFileSync(runPath(root, task, { area: 'developer', round, file: name }), 'utf8')
      ) as TurnResultRecord
      if (value?.version === 1 && typeof value.attempt === 'number') records.push(value)
    } catch {
      // unreadable — not a record
    }
  }
  return records.sort((a, b) => a.attempt - b.attempt)
}

/** The next attempt ordinal for this round: one past the highest on disk. */
export function nextTurnResultAttempt(root: string, task: number, round: number): number {
  const records = readTurnResultRecords(root, task, round)
  return records.length === 0 ? 1 : records[records.length - 1]!.attempt + 1
}

/**
 * Writes one attempt record, exclusively (`wx`): an attempt already on disk is
 * never overwritten, so an accepted result is accepted exactly once and a
 * rejected one stays as it was rejected.
 */
export function writeTurnResultRecord(root: string, task: number, record: TurnResultRecord): void {
  const path = turnResultRecordPath(root, task, record.round, record.attempt)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function acceptedCompleted(
  records: readonly TurnResultRecord[]
): Extract<DeveloperTurnResult, { status: 'completed' }>[] {
  const out: Extract<DeveloperTurnResult, { status: 'completed' }>[] = []
  for (const r of records) {
    if (r.outcome === 'accepted' && r.result?.status === 'completed') out.push(r.result)
  }
  return out
}

/**
 * The round's confidence: the newest accepted result's, when it is
 * `completed`; `'absent'` otherwise — never made up. The explanation is cut
 * to the bound `gate_result_read.confidence_reason` enforces, so an
 * over-length one can never drop the whole event.
 */
export function confidenceFromRecords(records: readonly TurnResultRecord[]): Confidence {
  const newest = [...records].reverse().find((r) => r.outcome === 'accepted')
  if (newest?.result?.status !== 'completed') return 'absent'
  const reason = newest.result.confidenceExplanation.trim().slice(0, CONFIDENCE_REASON_MAX_LENGTH)
  return reason ? { value: newest.result.confidence, reason } : { value: newest.result.confidence }
}

/** Every finding id the round's accepted `completed` results addressed, first-cited order, once each. */
export function addressedFindingIdsFromRecords(records: readonly TurnResultRecord[]): string[] {
  const ids: string[] = []
  for (const result of acceptedCompleted(records)) {
    for (const id of result.addressedFindingIds) if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** The newest accepted `completed` result's own `reportedChecks` — agent-reported context, `[]` when none. */
export function reportedChecksFromRecords(
  records: readonly TurnResultRecord[]
): { command: string; outcome: 'pass' | 'fail' }[] {
  const completed = acceptedCompleted(records)
  return completed[completed.length - 1]?.reportedChecks ?? []
}

// --- the typed pause --------------------------------------------------------

export type TurnResultPauseKind = 'blocked' | 'needs_ruling' | 'rejected' | 'stale' | 'no_adapter'

/**
 * The round pauses on its turn result: the Developer reported `blocked` or
 * `needs_ruling` (an escalation for the Principal), or no result could be
 * accepted (`rejected` twice, `stale` against a moved head, or `no_adapter`
 * for a vendor with no native structured output).
 */
export class DeveloperTurnResultPause extends Error {
  constructor(
    readonly kind: TurnResultPauseKind,
    detail: string
  ) {
    super(detail)
    this.name = 'DeveloperTurnResultPause'
  }

  get pauseReason(): PauseReason {
    return this.kind === 'blocked' || this.kind === 'needs_ruling' ? 'escalation' : 'infrastructure'
  }

  /** The Log's `paused.reason_code` for this pause. */
  get reasonCode(): string {
    return `developer_turn_${this.kind}`
  }
}

/** The pause an accepted `blocked`/`needs_ruling` result raises; `null` for `completed`. */
export function pauseForAcceptedResult(result: DeveloperTurnResult): DeveloperTurnResultPause | null {
  if (result.status === 'blocked') {
    return new DeveloperTurnResultPause(
      'blocked',
      `the Developer reported the task blocked (${result.blocker.kind}): ${result.blocker.detail} — ${result.summary}`
    )
  }
  if (result.status === 'needs_ruling') {
    return new DeveloperTurnResultPause(
      'needs_ruling',
      `the Developer asks for a ruling: ${result.rulingRequest.question} (decisions: ${result.rulingRequest.decisions.join(', ')}) — ${result.summary}`
    )
  }
  return null
}
