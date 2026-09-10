/**
 * `vinaya task status` — the reader (`commands/task-status.ts` does argv
 * parsing and rendering only). One read-only pass over the forge (open task
 * Issues carrying a frozen `aeg:brief:v<k>` comment, the open pull request
 * per branch) and the outbox (`<outboxRoot>/dev-review-loop/<task>/`'s
 * driver pid record, pause record, and publish effect markers) — never a
 * `ps` scan (Traps to avoid), never a re-parse of posted verdict comments to
 * decide `published` (same).
 *
 * Task 7 (`review-validity-v1`, `#498`, merged as `a52619e9`)'s driver pid
 * record and `#415`'s pause/effect-marker shapes both live as private state
 * in `dev-review-loop.ts` — this file re-reads those exact same on-disk
 * paths and JSON shapes rather than exporting new surface from that file
 * (out of this task's Surface).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveNewestFrozenBrief, type PauseReason } from '@attalabs/aeg-core'
import { resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'
import { findOpenPrForBranch, outboxRoot } from './dev-review-loop.js'

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// --- task list (forge) -------------------------------------------------

type TaskRef = { tranche: string; id: string; issue: number }

type RawIssue = { number: number; title: string; labels: Array<{ name: string }> }

/** Generous, not a bound (Traps to avoid: this is a glance, not a dashboard) — every repo this shipped against carries far fewer than this many simultaneously open task Issues. */
const OPEN_ISSUE_LIST_LIMIT = 200

/**
 * Every open Issue whose title and labels resolve to a Vinaya task
 * (`resolveTaskIssueRef` — the same `[<slug>] <n> — …` title shape plus
 * `vinaya/tranche:<slug>` label authoritative-membership discipline
 * `list-tasks.ts` documents), across every tranche — one `gh issue list`
 * call, no tranche slug known in advance.
 */
function listOpenTaskIssues(): TaskRef[] {
  const raw = sh('gh', [
    'issue',
    'list',
    '--state',
    'open',
    '--json',
    'number,title,labels',
    '--limit',
    String(OPEN_ISSUE_LIST_LIMIT)
  ])
  const issues = JSON.parse(raw) as RawIssue[]
  const refs: TaskRef[] = []
  for (const issue of issues) {
    const ref = resolveTaskIssueRef(
      issue.title,
      issue.labels.map((l) => l.name)
    )
    if (ref) refs.push({ tranche: ref.trancheSlug, id: ref.taskId, issue: issue.number })
  }
  return refs
}

type RawComment = { body: string; author?: { login?: string } | null }

function fetchIssueComments(issue: number): { body: string; author: string | null }[] {
  const raw = sh('gh', ['issue', 'view', String(issue), '--json', 'comments'])
  const parsed = JSON.parse(raw) as { comments: RawComment[] }
  return parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
}

/** Computed once per command invocation and threaded through — not re-fetched per task, unlike a naive per-task `loadTrustAnchorConfig()` call, which would cost one redundant forge round trip (and warning line, on failure) per open task Issue. */
function principalAllowlist(): string[] {
  return resolvePrincipalAllowlist(loadTrustAnchorConfig())
}

/** True iff the Issue carries a principal-authored, frozen `aeg:brief:v<k>` comment — the same resolver `dev-review-loop.ts`'s own `fetchFrozenBrief` uses, read here for its presence rather than its content. */
function hasFrozenBrief(issue: number, allowlist: readonly string[]): boolean {
  return resolveNewestFrozenBrief(fetchIssueComments(issue), allowlist as string[]) !== null
}

/** The open pull request on this task's `task/<tranche>/<n>` branch, or `null` — `findOpenPrForBranch` unchanged, the branch name derived the same way every other reader in this codebase derives it. */
function findPrForTask(tranche: string, id: string): { number: number } | null {
  const pr = findOpenPrForBranch(`task/${tranche}/${id}`)
  return pr ? { number: pr.number } : null
}

// --- outbox reads --------------------------------------------------------

function taskOutboxDir(root: string, task: number): string {
  return join(root, 'dev-review-loop', String(task))
}

type DriverLock = { pid: number; startedAt: string }

function readDriverLock(root: string, task: number): DriverLock | null {
  const raw = readIfExists(join(taskOutboxDir(root, task), 'driver.pid.json'))
  if (!raw) return null
  try {
    return JSON.parse(raw) as DriverLock
  } catch {
    return null
  }
}

/** Same signal-0 liveness idiom `dev-review-loop.ts`'s own `isDriverPidAlive` uses — sends no real signal, throws iff the pid is gone. */
function isDriverPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type PauseState = {
  task: number
  round: number
  head: string
  branch: string
  prNumber: number
  reason: PauseReason
  detail?: string
  pausedAt: string
}

function readPauseState(root: string, task: number): PauseState | null {
  const raw = readIfExists(join(taskOutboxDir(root, task), 'pause-state.json'))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PauseState
  } catch {
    return null
  }
}

type ForgeEffectRecord = { effectId: string; status: 'started' | 'posted'; url?: string }

function readEffect(root: string, task: number, key: string): ForgeEffectRecord | null {
  const raw = readIfExists(join(taskOutboxDir(root, task), `effect-${key}.json`))
  if (!raw) return null
  try {
    return JSON.parse(raw) as ForgeEffectRecord
  } catch {
    return null
  }
}

/**
 * The highest round for which BOTH the reviewer and security verdict effect
 * markers read `status: 'posted'` — `publishRound`'s own two-post contract,
 * read back from the outbox rather than the forge (Traps to avoid: never
 * read PR comments to decide `published`). `null` when no round has
 * published cleanly.
 */
function newestPublishedRound(root: string, task: number): number | null {
  let entries: string[]
  try {
    entries = readdirSync(taskOutboxDir(root, task))
  } catch {
    return null
  }
  const candidateRounds = new Set<number>()
  for (const name of entries) {
    const m = /^effect-(\d+)-reviewer-verdict\.json$/.exec(name)
    if (m) candidateRounds.add(Number(m[1]))
  }
  let newest: number | null = null
  for (const round of candidateRounds) {
    const reviewer = readEffect(root, task, `${round}-reviewer-verdict`)
    const security = readEffect(root, task, `${round}-security-verdict`)
    if (reviewer?.status === 'posted' && security?.status === 'posted' && (newest === null || round > newest)) {
      newest = round
    }
  }
  return newest
}

export type TaskLoopState =
  | { kind: 'running'; pid: number; startedAt: string }
  | { kind: 'paused'; reason: PauseReason; detail?: string; round: number }
  | { kind: 'published'; round: number }
  | { kind: 'no_driver' }

/**
 * `pause-state.json` is written on every pause but never cleared on resume
 * (today's outbox shape, ahead of the `control-store-v1` tranche that
 * consolidates it) — so it can still be sitting on disk naming an old round
 * after that same task later resumed and published cleanly. A published
 * round at or past the paused round means that pause was resumed past;
 * `published` (derived from the effect markers alone) wins over a stale
 * `paused` reading in that case.
 */
export function deriveLoopState(root: string, task: number): TaskLoopState {
  const lock = readDriverLock(root, task)
  if (lock && isDriverPidAlive(lock.pid)) return { kind: 'running', pid: lock.pid, startedAt: lock.startedAt }

  const published = newestPublishedRound(root, task)
  const pause = readPauseState(root, task)
  if (pause && (published === null || pause.round > published)) {
    return { kind: 'paused', reason: pause.reason, detail: pause.detail, round: pause.round }
  }
  if (published !== null) return { kind: 'published', round: published }
  return { kind: 'no_driver' }
}

// --- rendering -------------------------------------------------------------

export type TaskStatusRow = {
  tranche: string
  id: string
  issue: number
  pr: { number: number } | null
  state: TaskLoopState
}

function renderStateText(state: TaskLoopState): string {
  switch (state.kind) {
    case 'running':
      return `running (pid ${state.pid})`
    case 'paused':
      return `paused (${state.reason})`
    case 'published':
      return 'published'
    case 'no_driver':
      return 'no driver'
  }
}

/** One stable line per task (O3): `[<tranche>] <id> — Issue #<n> — PR #<n>|— — <state>`. */
export function renderTaskStatusRow(row: TaskStatusRow): string {
  const prText = row.pr ? `PR #${row.pr.number}` : 'PR —'
  return `[${row.tranche}] ${row.id} — Issue #${row.issue} — ${prText} — ${renderStateText(row.state)}`
}

function buildRow(ref: TaskRef, allowlist: readonly string[]): TaskStatusRow | null {
  if (!hasFrozenBrief(ref.issue, allowlist)) return null
  return {
    tranche: ref.tranche,
    id: ref.id,
    issue: ref.issue,
    pr: findPrForTask(ref.tranche, ref.id),
    state: deriveLoopState(outboxRoot(), ref.issue)
  }
}

// --- command-facing entry points --------------------------------------

export type TaskStatusListRow = { row: TaskStatusRow; line: string }

/**
 * O1/O3, the entire read for the list form — the ONE function
 * `commands/task-status.ts` calls for it (`apps/cli/specs/surface.md`'s
 * one-command-one-function discipline).
 */
export function gatherTaskStatusList(): TaskStatusListRow[] {
  const allowlist = principalAllowlist()
  const rows: TaskStatusListRow[] = []
  for (const ref of listOpenTaskIssues()) {
    const row = buildRow(ref, allowlist)
    if (row) rows.push({ row, line: renderTaskStatusRow(row) })
  }
  return rows
}
