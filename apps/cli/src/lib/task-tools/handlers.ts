/**
 * The `task_status` and `task_escalation_read` handlers named in the
 * catalog's own `handlerBinding` (`packages/aeg-core/src/task-tools.ts`).
 * Both validate their input against the catalog's own schema first, then
 * compose two sources: `task-status.ts`'s forge-touching reader (task
 * identity, PR number, frozen-brief presence — "the status reader" O2
 * names) and `read.ts`'s pure outbox reads (the timestamped, fresh/stale/
 * unknown observations). Neither handler writes anything or starts a
 * process.
 *
 * `task_start` (`start.ts`), `task_resume` (`resume.ts`) and `task_cancel`
 * (`cancel.ts`) are real handlers of their own, each in its own module —
 * this file also exports `resolveIssueForRef`, the SAME `TaskToolRef`
 * resolution `task_status`/`task_escalation_read` use, so those two mutating
 * handlers resolve a `{ tranche, id }` ref through the identical forge read
 * rather than a second, divergent implementation. It also exports
 * `readTaskIssueFacts` — the state-and-labels read `task_start` refuses a
 * standalone `{ issue }` target on — and
 * `resolveOpenTaskIssueForRef` — the start-side variant `task_start` uses to
 * resolve a PLANNED task whose brief is not frozen yet, over the open
 * tranche-labeled Issues the way `task run` preparation does; see that
 * function's own comment for why the two resolutions read differently. And
 * it exports `resolveRowForRef` — the whole status row behind a ref, which
 * `pr-read.ts`'s `task_pr_read` resolves its pull request from.
 */

import { execFileSync } from 'node:child_process'
import {
  DEFAULT_PAGE_LIMIT,
  TaskEscalationReadInputSchema,
  TaskStatusInputSchema,
  taskToolError,
  type TaskEscalationReadResult,
  type TaskStatusResult,
  type TaskToolError,
  type TaskToolRef
} from '@attalabs/aeg-core'
import { findTrancheSlug, resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
import { runtimeDir } from '../dev-review-loop.js'
import { gatherTaskStatusList, type TaskStatusRow } from '../task-status.js'
import { classifyStateFreshness, describeTaskLoopState, paginate, readEscalationPacket } from './read.js'

export type TaskToolCallResult<T> = { ok: true; result: T } | { ok: false; error: TaskToolError }

function ok<T>(result: T): TaskToolCallResult<T> {
  return { ok: true, result }
}

function fail<T>(error: TaskToolError): TaskToolCallResult<T> {
  return { ok: false, error }
}

function refMatchesRow(ref: TaskToolRef, row: TaskStatusRow): boolean {
  return 'issue' in ref ? row.issue === ref.issue : row.tranche === ref.tranche && row.id === ref.id
}

/** How a ref reads in a refusal message — `Issue #729` or `[a-tranche] 3`. Exported so `start.ts` names a target the same way this file's own refusals do, rather than formatting one of its own. */
export function describeTaskRef(ref: TaskToolRef): string {
  return 'issue' in ref ? `Issue #${ref.issue}` : `[${ref.tranche}] ${ref.id}`
}

// --- task_status -------------------------------------------------------------

/** `task-status.ts`'s own forge-touching entry point, called once per handler invocation — the identical cost `vinaya task status` already pays for the same information. */
function currentTaskStatusRows(): TaskStatusRow[] {
  return gatherTaskStatusList().map((entry) => entry.row)
}

export function taskStatusHandler(input: unknown): TaskToolCallResult<TaskStatusResult> {
  const parsed = TaskStatusInputSchema.safeParse(input)
  if (!parsed.success) return fail(taskToolError('validation', parsed.error.issues[0]?.message ?? 'invalid input'))
  const { task, cursor, limit } = parsed.data

  const rows = currentTaskStatusRows()
  const matching = task ? rows.filter((row) => refMatchesRow(task, row)) : rows
  if (task && matching.length === 0) {
    return fail(taskToolError('precondition', `no open task matches ${describeTaskRef(task)}`))
  }

  const page = paginate(matching, cursor, limit ?? DEFAULT_PAGE_LIMIT)
  const observedAt = new Date().toISOString()
  const items = page.items.map((row) => ({
    task: row.tranche === 'backlog' ? { issue: row.issue } : { tranche: row.tranche, id: row.id },
    issue: row.issue,
    pr: row.pr ? row.pr.number : null,
    state: describeTaskLoopState(row.state),
    observedAt,
    freshness: classifyStateFreshness(row.state)
  }))

  return ok({ items, nextCursor: page.nextCursor })
}

// --- task_escalation_read ------------------------------------------------

/**
 * `{ issue }` needs no forge call at all — the outbox is keyed by Issue
 * number directly. `{ tranche, id }` is resolved through the same rows
 * `task_status` reads, so a tranche-shaped ref that names no open task fails
 * the same way in every tool. Exported (not just used by
 * `task_escalation_read` below) so `resume.ts`/`cancel.ts` resolve a
 * `TaskToolRef` through this identical read rather than a second,
 * divergent implementation.
 *
 * A `not_started` row (a planned task whose brief `task run`'s preparation has
 * not frozen yet — now LISTED by `task_status` rather than omitted) is
 * deliberately not resolvable here: this resolver serves
 * `task_escalation_read`/`task_resume`/`task_cancel`, which only ever act on a
 * task that has already been prepared or has a run, and a planned task has
 * neither pause nor escalation to read. Only `task_start` acts on a planned
 * Issue, through its own `resolveOpenTaskIssueForRef` below — so a planned task
 * appears in the status list yet still fails these three the same "no open task
 * matches" way it always has.
 */
export function resolveIssueForRef(ref: TaskToolRef): number | null {
  if ('issue' in ref) return ref.issue
  const row = currentTaskStatusRows().find(
    (r) => r.tranche === ref.tranche && r.id === ref.id && r.state.kind !== 'not_started'
  )
  return row ? row.issue : null
}

/**
 * The whole status row behind a `TaskToolRef`, not just its Issue — the same
 * rows `task_status` reports, matched by the same two ref shapes, so a ref
 * that names no open task resolves to `null` here exactly as it does
 * everywhere else. Exported for `pr-read.ts`, which needs the row's PULL
 * REQUEST as well as its Issue: `task_pr_read` resolves the pull request it
 * reads from the selected task's own branch, and this row is where that
 * branch's open pull request is already recorded (`task-status.ts`'s
 * `findPrForRef`).
 *
 * Deliberately NOT what `resolveIssueForRef` above is built on: that function
 * short-circuits an `{ issue }` ref to its own number with no forge call at
 * all, which is what lets `task_escalation_read` answer a bare Issue straight
 * out of the outbox. A pull request cannot be read out of the outbox, so this
 * one always reads the rows.
 */
export function resolveRowForRef(ref: TaskToolRef): TaskStatusRow | null {
  return currentTaskStatusRows().find((row) => refMatchesRow(ref, row)) ?? null
}

// --- start-side resolution: open tranche-labeled Issues, frozen or not -------

/** Generous, not a bound — the same ceiling `task-status.ts`'s own open-Issue read uses; every repo this shipped against carries far fewer than this many simultaneously open task Issues. */
const OPEN_ISSUE_LIST_LIMIT = 200

type RawTaskIssue = { number: number; title: string; labels: Array<{ name: string }> }

/**
 * `{ tranche, id }` → Issue over EVERY open tranche-labeled Issue, whether or
 * not its brief has been frozen yet — the SAME resolution `vinaya task run
 * <tranche> <n>` preparation performs to find the Issue for an ordinal (an
 * open Issue labeled `vinaya/tranche:<slug>` whose title's ordinal matches
 * `<n>`), reusing the identical title/label parser (`resolveTaskIssueRef`,
 * `@attalabs/aeg-forge-state`) rather than a second regex.
 *
 * This lives BESIDE `resolveIssueForRef` deliberately, and reads differently:
 * `resolveIssueForRef` resolves through the task-status list but skips its
 * `not_started` rows (a task with no frozen brief — now LISTED by `task_status`
 * as not started, but still not resolvable by that reader) — the reading
 * `task_status`/`task_escalation_read`/`task_resume`/`task_cancel` intend, since
 * those only ever act on a task that has already been prepared or has a run.
 * `task_start` is the one tool
 * that starts a task from a PLANNED Issue whose brief `task run`'s own
 * preparation has not frozen yet — so it must resolve over the pre-freeze
 * list, exactly as preparation does, or it could never confirm a launch it is
 * about to make. Changing `resolveIssueForRef` to do this instead would widen
 * what every other tool lists — so the two stay separate.
 *
 * `null` when no open tranche-labeled Issue resolves to this `{ tranche, id }`.
 * A raw `{ issue }` ref needs no forge read at all — it names its own Issue.
 */
export function resolveOpenTaskIssueForRef(ref: TaskToolRef): number | null {
  if ('issue' in ref) return ref.issue
  const raw = execFileSync(
    'gh',
    ['issue', 'list', '--state', 'open', '--json', 'number,title,labels', '--limit', String(OPEN_ISSUE_LIST_LIMIT)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
  const issues = JSON.parse(raw) as RawTaskIssue[]
  for (const issue of issues) {
    const resolved = resolveTaskIssueRef(
      issue.title,
      issue.labels.map((l) => l.name)
    )
    if (resolved && resolved.trancheSlug === ref.tranche && resolved.taskId === ref.id) return issue.number
  }
  return null
}

/**
 * What the forge says about one Issue number, for a caller that was HANDED the
 * number rather than resolving it: whether it is still open, and the tranche it
 * belongs to (`null` for a standalone task Issue — the case `task_start`'s
 * `{ issue }` form accepts). `not_found` and `unreadable` are kept apart because
 * they mean opposite things to a caller: the first is a refusal the caller can
 * fix by naming a real Issue, the second is a forge read that failed and may
 * succeed on retry, and collapsing them would report a transient outage as a
 * bad input.
 */
export type TaskIssueFacts =
  | { kind: 'issue'; open: boolean; tranche: string | null }
  | { kind: 'not_found' }
  | { kind: 'unreadable'; detail: string }

/** GitHub's own words when the number names nothing — matched (case-insensitively) rather than trusting the exit code, which is the same for a missing Issue and a failed network call. */
const ISSUE_NOT_FOUND_PATTERNS = ['could not resolve to an issue', 'not found', 'no issue found']

/**
 * One `gh issue view` read — state and labels only. The tranche is read from
 * the LABEL alone (`findTrancheSlug`), never from the title: the label is what
 * decides a task's identity everywhere else in this codebase
 * (`task-status.ts`'s own `TaskRef`, `developerBranchFor`'s branch shape), and a
 * title that happens to look like `[slug] 3` on an unlabeled Issue must not
 * turn it into a tranche task.
 */
export function readTaskIssueFacts(issue: number): TaskIssueFacts {
  let raw: string
  try {
    raw = execFileSync('gh', ['issue', 'view', String(issue), '--json', 'state,labels'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    const detail = errorOutputOf(err)
    const haystack = detail.toLowerCase()
    if (ISSUE_NOT_FOUND_PATTERNS.some((pattern) => haystack.includes(pattern))) return { kind: 'not_found' }
    return { kind: 'unreadable', detail }
  }
  try {
    const parsed = JSON.parse(raw) as { state: string; labels: Array<{ name: string }> }
    return {
      kind: 'issue',
      open: parsed.state.toUpperCase() === 'OPEN',
      tranche: findTrancheSlug(parsed.labels.map((l) => l.name))
    }
  } catch (err) {
    return { kind: 'unreadable', detail: `could not parse gh issue view output: ${(err as Error).message}` }
  }
}

/** `execFileSync`'s own thrown error carries the child's stderr on `.stderr`; a plain `message` is the fallback for a spawn that never ran. */
function errorOutputOf(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | null)?.stderr
  const text = typeof stderr === 'string' ? stderr : stderr instanceof Buffer ? stderr.toString('utf8') : ''
  return (text.trim() || (err instanceof Error ? err.message : String(err))).trim()
}

export function taskEscalationReadHandler(input: unknown): TaskToolCallResult<TaskEscalationReadResult> {
  const parsed = TaskEscalationReadInputSchema.safeParse(input)
  if (!parsed.success) return fail(taskToolError('validation', parsed.error.issues[0]?.message ?? 'invalid input'))
  const { task, cursor, limit } = parsed.data

  const issue = resolveIssueForRef(task)
  if (issue === null) return fail(taskToolError('precondition', `no open task matches ${describeTaskRef(task)}`))

  // A task with no pause record ever written is not an error (the catalog's
  // own boundary note) — it answers with an empty, unknown-freshness page.
  const packet = readEscalationPacket(runtimeDir(), issue)
  const items = packet ? [packet] : []
  const page = paginate(items, cursor, limit ?? DEFAULT_PAGE_LIMIT)
  return ok({
    items: page.items,
    nextCursor: page.nextCursor,
    observedAt: packet?.observedAt ?? new Date().toISOString(),
    freshness: packet?.freshness ?? 'unknown'
  })
}

// `task_start` (`start.ts`), `task_resume` (`resume.ts`) and `task_cancel`
// (`cancel.ts`) are real, caller-context-aware handlers of their own — see
// each module's header for why they live apart from the two pure reads
// above.
