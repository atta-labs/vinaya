/**
 * The review coordinator: the rules that make a plan review count.
 *
 * A review counts only if it ran, ran on the exact plan, and ends. Those are
 * rules, so the harness holds them — neither the Planner nor the reviewer does.
 * The coordinator starts a round only on a draft checked as a whole at its
 * current fingerprint, runs one fresh round, validates the answer, derives the
 * verdict and stores the result with the draft's own state on this machine.
 *
 * What is stored survives a revision, a resubmission and a new chat, because it
 * lives in a file keyed by the tranche, never in a session:
 *
 * - the rounds spent, each with the fingerprint it judged, its validated
 *   answer and its verdict. The count of rounds is the length of that list; a
 *   changed fingerprint makes an earlier approval stale, it never resets the
 *   count.
 * - every finding the reviewer made, `open` until a later round's valid
 *   confirmation with evidence resolves it, or a `note`, which never blocks.
 * - the Principal's decisions at the round limit, each for one fingerprint.
 *
 * A later round judges only what is left to judge: each finding still open, the
 * tasks whose text changed since the last round, and the tasks related to those
 * by a dependency or a conflict, in either direction. A task that did not
 * change and was approved keeps its approval.
 */

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { ensureRunDir, runPath } from '@harness/kernel/run-paths'
import type { DraftCheckReport } from '../plan-draft/check'
import { type DraftTask, draftFingerprint, type PlanDraft, resolveDraftEdges } from '../plan-draft/draft'
import {
  type OpenFindingBrief,
  PLAN_REVIEW_AGENTS,
  type PlanReviewAgent,
  type PlanRoundOutcome,
  type RoundLauncher,
  runPlanReviewRound
} from './launch'
import { type PlanReview, PlanReviewSchema, type PlanReviewScope, type PlanVerdict } from './result'
import { z } from 'zod/v4'

export const REVIEW_STATE_SCHEMA_VERSION = 1
const STATE_FILE = 'review.json'

export const DECISION_CHOICES = ['allow_one_more', 'stop'] as const
export type DecisionChoice = (typeof DECISION_CHOICES)[number]

// --- stored state -----------------------------------------------------------------

const StoredFindingSchema = z
  .object({
    /** Given by the harness when the finding is stored; a confirmation names it. */
    id: z.string().min(1),
    round: z.number().int().min(1),
    question: z.number().int().min(1).max(6),
    task: z.number().int().min(1).nullable(),
    /** `open` and `resolved` are blocking findings; a `note` never blocks. */
    state: z.enum(['open', 'resolved', 'note']),
    resolution: z.string().min(1),
    evidence: z.array(z.unknown()),
    /** The round whose valid confirmation resolved it. */
    resolvedInRound: z.number().int().min(1).nullable()
  })
  .strict()

const RoundSchema = z
  .object({
    round: z.number().int().min(1),
    fingerprint: z.string().min(1),
    agent: z.enum(PLAN_REVIEW_AGENTS),
    /** `null` for the first round, which judges the whole draft. */
    scope: z
      .object({ tasks: z.array(z.number().int()), openFindings: z.array(z.string()) })
      .strict()
      .nullable(),
    review: PlanReviewSchema,
    verdict: z.enum(['approved', 'not_approved']),
    /** Tasks with no blocking finding open and a judgment (this round's or a carried one) of their current text. */
    approvedTasks: z.array(z.number().int()),
    /** The text fingerprint of each task as this round saw it, by task number. */
    taskHashes: z.record(z.string(), z.string())
  })
  .strict()

const DecisionSchema = z
  .object({
    fingerprint: z.string().min(1),
    choice: z.enum(DECISION_CHOICES),
    /** The rounds spent when the decision was recorded. */
    afterRounds: z.number().int().min(0)
  })
  .strict()

const ReviewStateSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_STATE_SCHEMA_VERSION),
    tranche: z.string().min(1),
    rounds: z.array(RoundSchema),
    findings: z.array(StoredFindingSchema),
    decisions: z.array(DecisionSchema)
  })
  .strict()

export type StoredFinding = z.infer<typeof StoredFindingSchema>
export type RoundRecord = z.infer<typeof RoundSchema>
export type ReviewDecision = z.infer<typeof DecisionSchema>
export type ReviewState = z.infer<typeof ReviewStateSchema>

export const emptyReviewState = (tranche: string): ReviewState => ({
  schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
  tranche,
  rounds: [],
  findings: [],
  decisions: []
})

/** The one file holding the review state of `tranche`, beside its draft. */
export function reviewStatePath(runtimeDir: string, tranche: string): string {
  return runPath(runtimeDir, { plan: tranche }, { area: 'task', file: STATE_FILE })
}

/** The stored state of `tranche`; empty when none was stored. A stored file that is not valid state is an error, never an empty state: a reset would hand back spent rounds. */
export function readReviewState(runtimeDir: string, tranche: string): ReviewState {
  let text: string
  try {
    text = readFileSync(reviewStatePath(runtimeDir, tranche), 'utf8')
  } catch {
    return emptyReviewState(tranche)
  }
  const parsed = ReviewStateSchema.safeParse(JSON.parse(text))
  if (!parsed.success) {
    throw new Error(
      `the stored review state of "${tranche}" is not valid (${parsed.error.issues[0]?.message ?? 'unreadable'}); it is not reset, because that would forget the rounds spent`
    )
  }
  return parsed.data
}

/** Replaces the stored state whole and atomically. */
export function writeReviewState(runtimeDir: string, state: ReviewState): void {
  const file = reviewStatePath(runtimeDir, state.tranche)
  ensureRunDir(runPath(runtimeDir, { plan: state.tranche }, { area: 'task' }), runtimeDir)
  const staging = `${file}.${process.pid}.tmp`
  writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(staging, file)
}

// --- the rules over state ---------------------------------------------------------

/** What a task's text is, for "did it change": its title, body, labels and Issue number. */
export function taskHash(task: DraftTask): string {
  const text = JSON.stringify({
    issue: task.issue,
    title: task.title.replace(/\r\n?/g, '\n'),
    body: task.body.replace(/\r\n?/g, '\n'),
    labels: [...task.labels].sort()
  })
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const hashesOf = (draft: PlanDraft): Record<string, string> =>
  Object.fromEntries(draft.tasks.map((t) => [String(t.number), taskHash(t)]))

/**
 * What a round after the first judges: the tasks whose text changed since the
 * last round, and every task related to one of them by a `Depends-on` or a
 * `Conflicts-with` edge in either direction, resolved by the draft's own
 * resolution of edges; and the ids of the findings still open.
 */
export function laterRoundScope(draft: PlanDraft, state: ReviewState): PlanReviewScope & { changed: number[] } {
  const last = state.rounds[state.rounds.length - 1]
  const now = hashesOf(draft)
  const changed = new Set(
    draft.tasks
      .filter((t) => last === undefined || last.taskHashes[String(t.number)] !== now[String(t.number)])
      .map((t) => t.number)
  )
  const known = new Set(draft.tasks.map((t) => t.number))
  const scope = new Set(changed)
  for (const e of resolveDraftEdges(draft)) {
    for (const n of [...e.dependsOnTasks, ...e.conflictsWithTasks]) {
      if (!known.has(n)) continue
      if (changed.has(e.task)) scope.add(n)
      if (changed.has(n)) scope.add(e.task)
    }
  }
  return {
    tasks: [...scope].sort((a, b) => a - b),
    openFindings: state.findings.filter((f) => f.state === 'open').map((f) => f.id),
    changed: [...changed].sort((a, b) => a - b)
  }
}

export type ReviewStatus = {
  tranche: string
  /** The fingerprint of the stored draft the status is for. */
  fingerprint: string
  roundsSpent: number
  /** The rounds allowed for this fingerprint: the limit, plus one for each allowance the Principal gave it. */
  roundsAllowed: number
  roundLimit: number
  /** `true` only when the latest round judged this exact fingerprint and approved it. */
  approved: boolean
  /** Rounds exist, but the latest one judged a different fingerprint: its verdict does not apply to this draft. */
  stale: boolean
  lastVerdict: PlanVerdict | null
  /** Tasks approved in the latest round whose text is unchanged since. */
  approvedTasks: number[]
  openFindings: StoredFinding[]
  notes: StoredFinding[]
  resolvedFindings: StoredFinding[]
  stopped: boolean
  /** Rounds spent reached the allowance without approval: only the Principal's decision lets review go on. */
  limitReached: boolean
  /** The next round's scope: absent before the first round, which judges the whole draft. */
  nextScope: (PlanReviewScope & { changed: number[] }) | null
  decisions: ReviewDecision[]
}

export function reviewStatus(draft: PlanDraft, state: ReviewState, roundLimit: number): ReviewStatus {
  const fingerprint = draftFingerprint(draft)
  const last = state.rounds[state.rounds.length - 1]
  const approved = last !== undefined && last.fingerprint === fingerprint && last.verdict === 'approved'
  const stopped = state.decisions.some((d) => d.fingerprint === fingerprint && d.choice === 'stop')
  const allows = state.decisions.filter((d) => d.fingerprint === fingerprint && d.choice === 'allow_one_more').length
  const roundsAllowed = roundLimit + allows
  const roundsSpent = state.rounds.length
  const now = hashesOf(draft)
  return {
    tranche: draft.tranche,
    fingerprint,
    roundsSpent,
    roundsAllowed,
    roundLimit,
    approved,
    stale: last !== undefined && last.fingerprint !== fingerprint,
    lastVerdict: last?.verdict ?? null,
    approvedTasks: (last?.approvedTasks ?? []).filter((n) => last?.taskHashes[String(n)] === now[String(n)]),
    openFindings: state.findings.filter((f) => f.state === 'open'),
    notes: state.findings.filter((f) => f.state === 'note'),
    resolvedFindings: state.findings.filter((f) => f.state === 'resolved'),
    stopped,
    limitReached: roundsSpent >= roundsAllowed && !approved && !stopped,
    nextScope: roundsSpent === 0 ? null : laterRoundScope(draft, state),
    decisions: state.decisions
  }
}

/**
 * Applies one validated round to the stored state: confirmations resolve or keep
 * open the findings they name, the round's own findings are stored with fresh ids,
 * and the verdict is derived from what is open afterwards. No answer decides it.
 */
export function applyRound(
  state: ReviewState,
  draft: PlanDraft,
  review: PlanReview,
  agent: PlanReviewAgent,
  scope: PlanReviewScope | null
): { state: ReviewState; record: RoundRecord } {
  const round = state.rounds.length + 1
  const confirmed = new Map(review.confirmations.map((c) => [c.finding, c.status]))
  const findings: StoredFinding[] = state.findings.map((f) =>
    f.state === 'open' && confirmed.get(f.id) === 'resolved' ? { ...f, state: 'resolved', resolvedInRound: round } : f
  )
  for (const [i, f] of review.findings.entries()) {
    findings.push({
      id: `r${round}-f${i + 1}`,
      round,
      question: f.question,
      task: f.task,
      state: f.kind === 'blocking' ? 'open' : 'note',
      resolution: f.resolution,
      evidence: f.evidence,
      resolvedInRound: null
    })
  }
  const open = findings.filter((f) => f.state === 'open')
  const hashes = hashesOf(draft)
  const last = state.rounds[state.rounds.length - 1]
  // A task is judged afresh when it is in scope, or when a finding about it was just confirmed resolved.
  const judged = new Set(scope === null ? draft.tasks.map((t) => t.number) : scope.tasks)
  for (const f of findings) if (f.resolvedInRound === round && f.task !== null) judged.add(f.task)
  const carried = new Set((last?.approvedTasks ?? []).filter((n) => last?.taskHashes[String(n)] === hashes[String(n)]))
  const approvedTasks = draft.tasks
    .map((t) => t.number)
    .filter((n) => (judged.has(n) || carried.has(n)) && !open.some((f) => f.task === n))
  const record: RoundRecord = {
    round,
    fingerprint: draftFingerprint(draft),
    agent,
    scope: scope === null ? null : { tasks: [...scope.tasks], openFindings: [...scope.openFindings] },
    review,
    verdict: open.length === 0 ? 'approved' : 'not_approved',
    approvedTasks,
    taskHashes: hashes
  }
  return { state: { ...state, rounds: [...state.rounds, record], findings }, record }
}

// --- which agent reviews ------------------------------------------------------------

/** The agent a review runs on: the Planner's own for `same`, the other vendor for `different`. */
export function resolveReviewerAgent(setting: 'same' | 'different', planner: PlanReviewAgent): PlanReviewAgent {
  if (setting === 'same') return planner
  return planner === 'claude-code' ? 'codex' : 'claude-code'
}

// --- starting a round ---------------------------------------------------------------

export type CoordinatorFinding = { check: string; message: string; recovery: string }

export type StartRefusal = 'no_draft' | 'unchecked' | 'stopped' | 'limit' | 'no_review' | 'draft_changed'

export type StartOutcome =
  | {
      ok: true
      round: number
      fingerprint: string
      agent: PlanReviewAgent
      verdict: PlanVerdict
      /** The findings this round made. */
      findings: StoredFinding[]
      /** Every blocking finding still open after the round. */
      openFindings: StoredFinding[]
      /** Findings this round resolved. */
      resolved: StoredFinding[]
      roundsSpent: number
      roundsAllowed: number
      scope: (PlanReviewScope & { changed: number[] }) | null
    }
  | { ok: false; reason: StartRefusal; findings: CoordinatorFinding[]; status?: ReviewStatus }

export type CoordinatorDeps = {
  runtimeDir: string
  readDraft: (tranche: string) => PlanDraft | null
  /** The whole-draft check; a round starts only when it ran on the current fingerprint and found nothing blocking. */
  check: (draft: PlanDraft) => Promise<DraftCheckReport>
  repoRoot: string
  roundLimit: number
  agent: PlanReviewAgent
  timeoutMs: number
  model?: string
  scratchParent?: string
  /** A fixture launcher stands in for the Engine offline. */
  launch?: RoundLauncher
}

const NO_DRAFT: CoordinatorFinding = {
  check: 'plan-review',
  message: 'no draft is stored for this tranche on this machine',
  recovery: 'Submit the draft with `plan_draft_submit` first.'
}

const describe = (f: StoredFinding): string =>
  `${f.id} (question ${f.question}, ${f.task === null ? 'the plan' : `task ${f.task}`}): ${f.resolution}`

function refuse(reason: StartRefusal, findings: CoordinatorFinding[], status?: ReviewStatus): StartOutcome {
  return { ok: false, reason, findings, ...(status === undefined ? {} : { status }) }
}

/** Starts, runs, validates and stores one review round — or refuses, naming why. */
export async function startPlanReview(deps: CoordinatorDeps, tranche: string): Promise<StartOutcome> {
  const draft = deps.readDraft(tranche)
  if (draft === null) return refuse('no_draft', [NO_DRAFT])
  const fingerprint = draftFingerprint(draft)

  const report = await deps.check(draft)
  if (report.fingerprint !== fingerprint) {
    return refuse('unchecked', [
      {
        check: 'plan-review',
        message: `the draft was checked at ${report.fingerprint}, its current fingerprint is ${fingerprint}`,
        recovery: 'Run `plan_draft_check` on the current draft, then start the round.'
      }
    ])
  }
  if (report.blocking) {
    return refuse('unchecked', [
      {
        check: 'plan-review',
        message: 'the draft has a blocking finding in its whole-draft check, so no review round starts',
        recovery: 'Run `plan_draft_check`, correct each blocking finding, submit the draft again, then start the round.'
      }
    ])
  }

  const state = readReviewState(deps.runtimeDir, tranche)
  const status = reviewStatus(draft, state, deps.roundLimit)
  if (status.stopped) {
    return refuse(
      'stopped',
      [
        {
          check: 'plan-review',
          message: 'the Principal stopped this plan at this fingerprint, so no round starts',
          recovery: 'Revise the plan and submit it again, then ask the Principal.'
        }
      ],
      status
    )
  }
  if (status.roundsSpent >= status.roundsAllowed) {
    return refuse(
      'limit',
      [
        {
          check: 'plan-review',
          message: `${status.roundsSpent} review rounds are spent (allowed: ${status.roundsAllowed}); review has stopped`,
          recovery:
            'Show the Principal the open findings from `plan_review_status`; only the Principal can allow one more round or stop the plan, recorded with `plan_review_decide`.'
        },
        ...status.openFindings.map((f) => ({
          check: 'plan-review',
          message: `open: ${describe(f)}`,
          recovery: 'Resolve it in the plan, or leave it to the Principal.'
        }))
      ],
      status
    )
  }

  const later = state.rounds.length > 0
  const scope = later ? laterRoundScope(draft, state) : null
  const briefs: OpenFindingBrief[] = state.findings
    .filter((f) => f.state === 'open')
    .map((f) => ({ id: f.id, question: f.question, task: f.task, resolution: f.resolution }))
  const outcome: PlanRoundOutcome = await runPlanReviewRound(
    {
      agent: deps.agent,
      draft,
      repoRoot: deps.repoRoot,
      timeoutMs: deps.timeoutMs,
      ...(scope === null
        ? {}
        : { scope: { tasks: scope.tasks, openFindings: scope.openFindings }, openFindings: briefs }),
      ...(deps.model === undefined ? {} : { model: deps.model }),
      ...(deps.scratchParent === undefined ? {} : { scratchParent: deps.scratchParent })
    },
    deps.launch
  )
  if (outcome.kind === 'no_review') {
    return refuse(
      'no_review',
      [
        {
          check: 'plan-review',
          message: `the round on ${outcome.agent} produced no review (${outcome.reason}): ${outcome.detail}. It is not counted.`,
          recovery: 'Start the round again.'
        }
      ],
      status
    )
  }

  // The round counts only for the plan it judged: re-read the stored state and draft, and refuse a result for a plan that moved.
  const current = deps.readDraft(tranche)
  if (current === null || draftFingerprint(current) !== fingerprint) {
    return refuse('draft_changed', [
      {
        check: 'plan-review',
        message: 'the stored draft changed while the round ran, so its result is not stored',
        recovery: 'Run `plan_draft_check`, then start the round on the current draft.'
      }
    ])
  }
  const fresh = readReviewState(deps.runtimeDir, tranche)
  if (fresh.rounds.length !== state.rounds.length) {
    return refuse('draft_changed', [
      {
        check: 'plan-review',
        message: 'another round was stored while this one ran, so this result is not stored',
        recovery: 'Read `plan_review_status`, then start a round if one is still allowed.'
      }
    ])
  }
  const applied = applyRound(
    fresh,
    draft,
    outcome.review,
    outcome.agent,
    scope === null ? null : { tasks: scope.tasks, openFindings: scope.openFindings }
  )
  writeReviewState(deps.runtimeDir, applied.state)
  const after = reviewStatus(draft, applied.state, deps.roundLimit)
  return {
    ok: true,
    round: applied.record.round,
    fingerprint,
    agent: outcome.agent,
    verdict: applied.record.verdict,
    findings: applied.state.findings.filter((f) => f.round === applied.record.round),
    openFindings: after.openFindings,
    resolved: applied.state.findings.filter((f) => f.resolvedInRound === applied.record.round),
    roundsSpent: after.roundsSpent,
    roundsAllowed: after.roundsAllowed,
    scope
  }
}

// --- reading the status ---------------------------------------------------------------

export type StatusOutcome = { ok: true; status: ReviewStatus } | { ok: false; findings: CoordinatorFinding[] }

export function planReviewStatus(
  deps: Pick<CoordinatorDeps, 'runtimeDir' | 'readDraft' | 'roundLimit'>,
  tranche: string
): StatusOutcome {
  const draft = deps.readDraft(tranche)
  if (draft === null) return { ok: false, findings: [NO_DRAFT] }
  return { ok: true, status: reviewStatus(draft, readReviewState(deps.runtimeDir, tranche), deps.roundLimit) }
}

// --- the Principal's decision ------------------------------------------------------------

export type DecideOutcome =
  | { ok: true; status: ReviewStatus; decision: ReviewDecision }
  | { ok: false; findings: CoordinatorFinding[] }

/**
 * Records that a decision was given and for which plan — not who gave it; no
 * caller is checked. Refused unless the round limit is reached for the
 * fingerprint it names, and that fingerprint is the stored draft's.
 */
export function decidePlanReview(
  deps: Pick<CoordinatorDeps, 'runtimeDir' | 'readDraft' | 'roundLimit'>,
  input: { tranche: string; fingerprint: string; choice: DecisionChoice }
): DecideOutcome {
  const draft = deps.readDraft(input.tranche)
  if (draft === null) return { ok: false, findings: [NO_DRAFT] }
  const refused = (message: string, recovery: string): DecideOutcome => ({
    ok: false,
    findings: [{ check: 'plan-review', message, recovery }]
  })
  const fingerprint = draftFingerprint(draft)
  if (input.fingerprint !== fingerprint) {
    return refused(
      `the decision names ${input.fingerprint}, the stored draft is ${fingerprint}`,
      'Read `plan_review_status` and give the decision for the current fingerprint.'
    )
  }
  const state = readReviewState(deps.runtimeDir, input.tranche)
  const status = reviewStatus(draft, state, deps.roundLimit)
  if (status.stopped) {
    return refused('the plan is already stopped at this fingerprint', 'Revise the plan and submit it again.')
  }
  if (!status.limitReached) {
    return refused(
      `the round limit is not reached for this fingerprint (${status.roundsSpent} of ${status.roundsAllowed} rounds spent${status.approved ? ', and the plan is approved' : ''})`,
      status.approved ? 'No decision is needed.' : 'Start the next round with `plan_review_start`.'
    )
  }
  const decision: ReviewDecision = { fingerprint, choice: input.choice, afterRounds: status.roundsSpent }
  const next = { ...state, decisions: [...state.decisions, decision] }
  writeReviewState(deps.runtimeDir, next)
  return { ok: true, status: reviewStatus(draft, next, deps.roundLimit), decision }
}
