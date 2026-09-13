/**
 * `vinaya task status` — the reader (`commands/task-status.ts` does argv
 * parsing and rendering only). One read-only pass over the forge (open task
 * Issues carrying a frozen `aeg:brief:v<k>` comment, the open pull request
 * per branch) and the outbox (`<outboxRoot>/dev-review-loop/<task>/`'s
 * driver pid record, pause record, and publish effect markers) — never a
 * `ps` scan (Traps to avoid), never a re-parse of posted verdict comments to
 * decide `published` (same).
 *
 * The driver pid record (`#498`, merged as `a52619e9`) and the pause/
 * effect-marker shapes (`#415`) both live as private state in
 * `dev-review-loop.ts` — this file re-reads those exact same on-disk paths
 * and JSON shapes rather than exporting new surface from that file (out of
 * this task's Surface).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveNewestFrozenBrief, type PauseReason } from '@attalabs/aeg-core'
import { resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'
import { findOpenPrForBranch, outboxRoot } from './dev-review-loop.js'
import { loopLogPathFor, loopsRoot, type LoopLogRepo } from './loop-log.js'

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

/**
 * A tranche-labeled Issue carries its identity in its own
 * title/label (`resolveTaskIssueRef`); a backlog Issue (no `vinaya/tranche:*`
 * label at all) carries none — it is identified by its Issue number alone,
 * the same identity `developerBranchFor`'s own `task/issue-<n>` branch and
 * the outbox's `<outboxRoot>/dev-review-loop/<n>/` directory already key by.
 * Never derived from the title for a backlog Issue (Traps to avoid) — only
 * the label decides which variant applies, same rule `developerBranchFor`
 * itself already enforces.
 */
type TaskRef = { kind: 'tranche'; tranche: string; id: string; issue: number } | { kind: 'backlog'; issue: number }

type RawIssue = { number: number; title: string; labels: Array<{ name: string }> }

/** Generous, not a bound (Traps to avoid: this is a glance, not a dashboard) — every repo this shipped against carries far fewer than this many simultaneously open task Issues. */
const OPEN_ISSUE_LIST_LIMIT = 200

/**
 * Every open Issue, tagged by which identity it carries
 * (`resolveTaskIssueRef`'s tranche shape, or backlog when that resolution
 * fails) — one `gh issue list` call, no tranche slug known in advance. A
 * backlog tag here is not yet a claim that the Issue is a real dispatched
 * task — `gatherTaskStatusList` narrows that with a cheap, local pre-filter
 * before ever asking the forge whether one carries a frozen brief.
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
    refs.push(
      ref
        ? { kind: 'tranche', tranche: ref.trancheSlug, id: ref.taskId, issue: issue.number }
        : { kind: 'backlog', issue: issue.number }
    )
  }
  return refs
}

/** The branch this ref's developer worked on — `task/<tranche>/<id>` for a tranche task, `task/issue-<n>` for a backlog one — the same two shapes `developerBranchFor` derives, mirrored here rather than reached for (that function is `async`-shaped around a live label/title fetch this file already has in hand). */
function branchForRef(ref: TaskRef): string {
  return ref.kind === 'tranche' ? `task/${ref.tranche}/${ref.id}` : `task/issue-${ref.issue}`
}

/**
 * A cheap, local, network-free pre-filter: a backlog Issue only
 * ever becomes a candidate row when the loop has already written it an
 * outbox directory (`<outboxRoot>/dev-review-loop/<n>/`) — the driver lock,
 * pause record, or verdict files a real dispatched run leaves behind (Traps
 * to avoid: never derive a backlog task's identity from its title). Without
 * this, every open backlog Issue in the repo — bug reports and feature
 * requests included — would cost one `gh issue view --json comments` call
 * just to learn it carries no frozen brief. A tranche-labeled Issue carries
 * no such gate: its identity is already real, the same as before this task.
 */
function hasOutboxDir(root: string, task: number): boolean {
  try {
    readdirSync(taskOutboxDir(root, task))
    return true
  } catch {
    return false
  }
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

/** The open pull request on this ref's developer branch, or `null` — `findOpenPrForBranch` unchanged, `branchForRef` deriving the tranche or backlog branch name the same way every other reader in this codebase derives it. */
function findPrForRef(ref: TaskRef): { number: number } | null {
  const pr = findOpenPrForBranch(branchForRef(ref))
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

// --- O2 (`#548` v3): the role log's own `driver_exited` trace ------------

/**
 * The `{owner,repo}` `loopLogPathFor` needs, resolved synchronously and
 * locally rather than via `@attalabs/aeg-forge-state`'s own `resolveRepo`
 * (which this file's `sh()`-based, synchronous read style deliberately
 * mirrors instead of importing — `resolveRepo` is `async`, and this file's
 * two command-facing entry points are called synchronously today by
 * `commands/task-status.ts`, out of this task's Surface; making them
 * `async` would force an edit there too). Same resolution order and same
 * URL shapes `resolve-repo.ts` parses — `AEG_REPO` first, then `git remote
 * get-url origin` — duplicated in miniature rather than shared, since the
 * shared version is the one thing here that can't be reused without an
 * out-of-surface ripple.
 */
function resolveRepoSync(): LoopLogRepo {
  const fromEnv = process.env.AEG_REPO
  if (fromEnv) {
    const m = /^([^/]+)\/(.+)$/.exec(fromEnv)
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  }
  let url: string
  try {
    url = sh('git', ['remote', 'get-url', 'origin'])
  } catch {
    return null
  }
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

/**
 * `deriveLoopState`'s own doc comment says it "take[s] an explicit `root`"
 * so tests never touch the real `~/.vinaya` tree — the role log lives under
 * a DIFFERENT root (`loopsRoot()`, a sibling of `outboxRoot()`) and is keyed
 * by repo, not by the outbox's own `root`, so it needs its own explicit
 * lookup rather than being derived from `root` alone. Threaded as one
 * parameter (never resolved internally by `deriveLoopState`/
 * `readLastDriverExited` themselves) so a caller — production
 * (`buildRow`, resolving the real repo once per invocation) or a test
 * (pointing straight at a temp dir, `repo: null`) — decides once, explicitly,
 * instead of a hidden default silently shelling out to real `git` on every
 * call a test never asked for.
 */
export type LoopLogLookup = { repo: LoopLogRepo; loopsRoot: string }

export type DriverExitReason = 'reexec' | 'error' | 'signal'
export type DriverExitTrace = { reason: DriverExitReason; lastDecision: string }

const DRIVER_EXITED_LINE = /^\[dev-review-loop\] driver_exited: reason=(reexec|error|signal) last_decision=(.*)$/

/**
 * The LAST `driver_exited` line in the task's role log — `dev-review-
 * loop.ts`'s own `recordDriverExited` appends one per unrecorded exit, never
 * more than one per run, so the last line in the file is always the most
 * recent run's own trace, whether or not a later run has since taken over
 * the (dead) lock. `null` when the log doesn't exist or never carries one.
 */
function readLastDriverExited(issue: number, loopLog: LoopLogLookup): DriverExitTrace | null {
  const raw = readIfExists(loopLogPathFor(loopLog.repo, issue, loopLog.loopsRoot))
  if (!raw) return null
  let found: DriverExitTrace | null = null
  for (const line of raw.split('\n')) {
    const m = DRIVER_EXITED_LINE.exec(line)
    if (m) found = { reason: m[1] as DriverExitReason, lastDecision: m[2] as string }
  }
  return found
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
  | { kind: 'exited'; reason: DriverExitReason; lastDecision: string }
  | { kind: 'no_driver' }

/**
 * `pause-state.json` is written on every pause but never cleared on resume
 * (today's outbox shape — a future consolidated control store is expected to
 * change this) — so it can still be sitting on disk naming an old round
 * after that same task later resumed and published cleanly. A published
 * round at or past the paused round means that pause was resumed past;
 * `published` (derived from the effect markers alone) wins over a stale
 * `paused` reading in that case.
 *
 * O2 (`#548` v3): a DEAD driver lock is itself the signal that the last run
 * exited abnormally — every normal exit path (a decided `pause`, a
 * `publish`, or a clean `no_driver`-since-never-run) either clears the lock
 * (the outer `finally`) or never wrote one crediting the current run. So a
 * lock naming a dead pid, checked BEFORE the published/paused reading below,
 * means the last run's own `driver_exited` role-log trace — if one exists —
 * is more informative than a possibly much older pause/publish record.
 */
export function deriveLoopState(
  root: string,
  task: number,
  loopLog: LoopLogLookup = { repo: resolveRepoSync(), loopsRoot: loopsRoot() }
): TaskLoopState {
  const lock = readDriverLock(root, task)
  if (lock && isDriverPidAlive(lock.pid)) return { kind: 'running', pid: lock.pid, startedAt: lock.startedAt }
  if (lock) {
    const trace = readLastDriverExited(task, loopLog)
    if (trace) return { kind: 'exited', reason: trace.reason, lastDecision: trace.lastDecision }
  }

  const published = newestPublishedRound(root, task)
  const pause = readPauseState(root, task)
  if (pause && (published === null || pause.round > published)) {
    return { kind: 'paused', reason: pause.reason, detail: pause.detail, round: pause.round }
  }
  if (published !== null) return { kind: 'published', round: published }
  return { kind: 'no_driver' }
}

/** `vinaya dev-review-loop --resume <pr>` — the exact string `renderPauseComment`/`task run` already print, rendered fresh from the pr number rather than duplicated as a literal in each caller. */
export function resumeCommandFor(prNumber: number): string {
  return `vinaya dev-review-loop --resume ${prNumber}`
}

// --- O2: last round's verdict lines ---------------------------------------

export type RoundVerdictLines = { round: number; reviewer: string | null; security: string | null }

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim()
}

/**
 * The last round this task's outbox carries a verdict file for —
 * `round-<n>-reviewer.md` / `round-<n>-security.md`, whichever is highest —
 * read regardless of whether that round has since published: `publishRound`
 * only ever reads these files, it never moves or deletes them, so held and
 * published verdicts are the same file, told apart only by
 * `deriveLoopState`'s own published/paused reading.
 */
export function lastRoundVerdictLines(root: string, task: number): RoundVerdictLines | null {
  let entries: string[]
  try {
    entries = readdirSync(taskOutboxDir(root, task))
  } catch {
    return null
  }
  let round: number | null = null
  for (const name of entries) {
    const m = /^round-(\d+)-(?:reviewer|security)\.md$/.exec(name)
    if (m) {
      const n = Number(m[1])
      if (round === null || n > round) round = n
    }
  }
  if (round === null) return null
  const reviewerText = readIfExists(join(taskOutboxDir(root, task), `round-${round}-reviewer.md`))
  const securityText = readIfExists(join(taskOutboxDir(root, task), `round-${round}-security.md`))
  return {
    round,
    reviewer: reviewerText ? firstLine(reviewerText) : null,
    security: securityText ? firstLine(securityText) : null
  }
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
    case 'exited':
      return `exited (${state.reason}) — last decision: ${state.lastDecision}`
    case 'no_driver':
      return 'no driver'
  }
}

/** One stable line per task (O3): `[<tranche>] <id> — Issue #<n> — PR #<n>|— — <state>`. */
export function renderTaskStatusRow(row: TaskStatusRow): string {
  const prText = row.pr ? `PR #${row.pr.number}` : 'PR —'
  return `[${row.tranche}] ${row.id} — Issue #${row.issue} — ${prText} — ${renderStateText(row.state)}`
}

/** A backlog ref renders through the SAME row shape as a tranche one — `tranche` reads `backlog`, `id` reads the Issue number, everything else (PR lookup, loop state) already generalizes over `TaskRef`'s two kinds via `branchForRef`. */
function buildRow(ref: TaskRef, allowlist: readonly string[]): TaskStatusRow | null {
  if (!hasFrozenBrief(ref.issue, allowlist)) return null
  return {
    tranche: ref.kind === 'tranche' ? ref.tranche : 'backlog',
    id: ref.kind === 'tranche' ? ref.id : String(ref.issue),
    issue: ref.issue,
    pr: findPrForRef(ref),
    state: deriveLoopState(outboxRoot(), ref.issue)
  }
}

// --- command-facing entry points --------------------------------------

export type TaskStatusListRow = { row: TaskStatusRow; line: string }

/**
 * O1/O3, the entire read for the list form — the ONE function
 * `commands/task-status.ts` calls for it (`apps/cli/specs/surface.md`'s
 * one-command-one-function discipline; every smaller piece above stays
 * unexported and reachable only from here or `gatherSingleTaskStatus`,
 * same file, so it costs no extra boundary call there).
 */
export function gatherTaskStatusList(): TaskStatusListRow[] {
  const allowlist = principalAllowlist()
  const root = outboxRoot()
  const rows: TaskStatusListRow[] = []
  for (const ref of listOpenTaskIssues()) {
    // A backlog ref only ever becomes a candidate once the loop has
    // already written it an outbox directory — see `hasOutboxDir`'s own doc
    // comment. A tranche-labeled ref carries no such gate.
    if (ref.kind === 'backlog' && !hasOutboxDir(root, ref.issue)) continue
    const row = buildRow(ref, allowlist)
    if (row) rows.push({ row, line: renderTaskStatusRow(row) })
  }
  return rows
}

export type SingleTaskStatus =
  | { kind: 'not_found' }
  | { kind: 'no_brief' }
  | {
      kind: 'ok'
      row: TaskStatusRow
      line: string
      verdictLines: RoundVerdictLines | null
      resumeCommand: string | null
    }

/** O2's entire read for the single-task form — the ONE function `commands/task-status.ts` calls for it, same discipline as `gatherTaskStatusList`. */
export function gatherSingleTaskStatus(tranche: string, id: string): SingleTaskStatus {
  const ref = listOpenTaskIssues().find((r) => r.kind === 'tranche' && r.tranche === tranche && r.id === id)
  if (!ref) return { kind: 'not_found' }

  const row = buildRow(ref, principalAllowlist())
  if (!row) return { kind: 'no_brief' }

  const root = outboxRoot()
  const verdictLines = lastRoundVerdictLines(root, ref.issue)
  const resumeCommand = row.state.kind === 'paused' && row.pr ? resumeCommandFor(row.pr.number) : null
  return { kind: 'ok', row, line: renderTaskStatusRow(row), verdictLines, resumeCommand }
}
