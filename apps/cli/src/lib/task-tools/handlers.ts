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
 * `resolveOpenTaskIssueForRef` — the start-side variant `task_start` uses to
 * resolve a PLANNED task whose brief is not frozen yet, over the open
 * tranche-labeled Issues the way `task run` preparation does; see that
 * function's own comment for why the two resolutions read differently.
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
import { resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
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

function refDescription(ref: TaskToolRef): string {
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
    return fail(taskToolError('precondition', `no open task matches ${refDescription(task)}`))
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
 */
export function resolveIssueForRef(ref: TaskToolRef): number | null {
  if ('issue' in ref) return ref.issue
  const row = currentTaskStatusRows().find((r) => r.tranche === ref.tranche && r.id === ref.id)
  return row ? row.issue : null
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
 * `resolveIssueForRef` resolves through the task-status list, which skips
 * every task with no frozen brief (`task-status.ts`'s `buildRow` returns null
 * without one) — the reading `task_status`/`task_escalation_read`/
 * `task_resume`/`task_cancel` intend, since those only ever act on a task
 * that has already been prepared or has a run. `task_start` is the one tool
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

export function taskEscalationReadHandler(input: unknown): TaskToolCallResult<TaskEscalationReadResult> {
  const parsed = TaskEscalationReadInputSchema.safeParse(input)
  if (!parsed.success) return fail(taskToolError('validation', parsed.error.issues[0]?.message ?? 'invalid input'))
  const { task, cursor, limit } = parsed.data

  const issue = resolveIssueForRef(task)
  if (issue === null) return fail(taskToolError('precondition', `no open task matches ${refDescription(task)}`))

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
