/**
 * `vinaya task status` — the reader (`commands/task-status.ts` does argv
 * parsing and rendering only). One read-only pass over the forge (open task
 * Issues carrying a frozen `aeg:brief:v<k>` comment, the open pull request
 * per branch) and the outbox (`<outboxRoot>/dev-review-loop/<task>/`'s
 * driver pid record, pause record, and publish effect markers) — never a
 * `ps` scan (Traps to avoid), never a re-parse of posted verdict comments to
 * decide `published` (same).
 *
 * The driver pid record (merged as `a52619e9`) and the pause/
 * effect-marker shapes both live as private state in
 * `dev-review-loop.ts` — this file re-reads those exact same on-disk paths
 * and JSON shapes rather than exporting new surface from that file (out of
 * this task's Surface).
 *
 * Each row also carries WHERE the run is, not only that it is running: the
 * round and phase from the loop's own control record, how long it has been in
 * that phase (measured from that record's own timestamp), and the newest
 * confidence any record still carries. Every one of those is `null` when no
 * record carries it; none of them is ever estimated.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import {
  defaultControlStoreDeps,
  isPrincipal,
  isPublishedSummaryComment,
  parseSummaryConfidenceRows,
  readEffect,
  readLoopState,
  resolveNewestFrozenBrief,
  taskPhaseLabel,
  type PauseReason,
  type TaskConfidence,
  type TaskPhaseHistory
} from '@attalabs/aeg-core'
import { resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'
import { findOpenPrForBranch, runtimeDir } from './dev-review-loop.js'
import { DRIVER_LOCK_FILENAME, runPath, tasksExecutionRoot } from './run-paths.js'
import { loopLogPathFor, loopsRoot, type LoopLogRepo } from './loop-log.js'
import { CONFIDENCE_FILE_NAME, parseConfidenceReply } from './dev-review-loop/round-assess.js'
import { findRecordedControllerRun } from './task-run-background.js'

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
  return runPath(root, task, { area: 'task' })
}

type DriverLock = { pid: number; startedAt: string }

function readDriverLock(root: string, task: number): DriverLock | null {
  const raw = readIfExists(runPath(root, task, { area: 'task', file: DRIVER_LOCK_FILENAME }))
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

// --- The role log's own `driver_exited` trace ------------------------------

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
  agent?: string
  model?: string
}

function readPauseState(root: string, task: number): PauseState | null {
  const raw = readIfExists(runPath(root, task, { area: 'control', file: 'pause-state.json' }))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PauseState
  } catch {
    return null
  }
}

/**
 * The highest round for which BOTH the reviewer and security verdict effect
 * records read `status: 'verified'` — `publishRound`'s own two-post contract,
 * read back through the control store's own `readEffect` (Traps to avoid:
 * never glob file names — the effect layout already moved once, from a flat
 * `control/effect-<key>.json` to the store's own `control/effect/<key>.json`;
 * and never read PR comments to decide `published`). `null` when no round has
 * published cleanly.
 *
 * The control store advances a published verdict effect to `verified` — the
 * one status this reads as published. A `verified` write is the record the
 * `EffectExecutor` leaves once the comment's own return value was recorded or
 * a recovery reconciled it against the remote (`EffectRecordSchema`). A
 * `started` verdict effect is a post whose confirmation was interrupted — the
 * write was persisted but never verified — and is NOT yet published;
 * `uncertain` is a recovery that could not reconcile at all, likewise not
 * published. Only `verified` counts.
 *
 * The single reader shared by `deriveLoopState` here and the task-tools read
 * module (`task-tools/read.ts` imports this rather than keeping a second
 * copy). Rounds are bounded above by the durable `loop_state` record's own
 * `round` — the driver writes it at every transition, `publish` included
 * (`persistCurrentLoopState('publish')` runs right after `publishRound`), so
 * it is never below a round that actually published — and each round is read
 * through `readEffect`, never enumerated off disk. No `loop_state` record
 * means no run ever persisted state for this task, so nothing has published.
 */
export function newestPublishedRound(root: string, task: number): number | null {
  const deps = defaultControlStoreDeps(() => tasksExecutionRoot(root))
  const loopState = readLoopState(deps, task)
  if (loopState.status !== 'ok') return null
  let newest: number | null = null
  for (let round = 1; round <= loopState.value.round; round++) {
    const reviewer = readEffect(deps, task, `${round}-reviewer-verdict`)
    const security = readEffect(deps, task, `${round}-security-verdict`)
    if (
      reviewer.status === 'ok' &&
      reviewer.value.status === 'verified' &&
      security.status === 'ok' &&
      security.value.status === 'verified'
    ) {
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
  // O4: an open task Issue whose brief is not frozen yet — planned, never
  // started. Distinct from `no_driver` (a brief WAS frozen, but nothing runs):
  // `buildRow` sets it without reading the outbox at all, since a run freezes
  // the brief in preparation before it ever writes a driver lock, so no frozen
  // brief means no run has begun. `deriveLoopState` itself never returns it.
  | { kind: 'not_started' }
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
 * A DEAD driver lock is itself the signal that the last run
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
  // Falls through here in the brief window between a `--background` start
  // (`task-run-background.ts`) acknowledging controller ownership and its
  // detached child reaching its OWN `driver.pid.json` write above — or after
  // that child's own lock is somehow cleared while it is genuinely still
  // running. `findRecordedControllerRun` never overrides a live legacy
  // lock (checked first, unchanged) and never claims 'running' for a
  // controller this host cannot itself verify (O2's "task status attaches
  // by run identity").
  const controller = findRecordedControllerRun(task)
  if (controller) return { kind: 'running', pid: controller.pid, startedAt: controller.startedAt }
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
export function resumeCommandFor(prNumber: number, agent?: string, model?: string): string {
  return `vinaya dev-review-loop --resume ${prNumber}${agent ? ` --agent ${agent}` : ''}${model ? ` --model ${model}` : ''}`
}

// --- O2: last round's verdict lines ---------------------------------------

export type RoundVerdictLines = { round: number; reviewer: string | null; security: string | null }

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim()
}

/**
 * The last round this task's folder carries a verdict file for —
 * `rounds/<n>/reviewer.md` / `rounds/<n>/security.md`, whichever is highest —
 * read regardless of whether that round has since published: `publishRound`
 * only ever reads these files, it never moves or deletes them, so held and
 * published verdicts are the same file, told apart only by
 * `deriveLoopState`'s own published/paused reading.
 */
export function lastRoundVerdictLines(root: string, task: number): RoundVerdictLines | null {
  let entries: string[]
  try {
    entries = readdirSync(runPath(root, task, { area: 'rounds' }))
  } catch {
    return null
  }
  let round: number | null = null
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const n = Number(name)
    const hasVerdict =
      readIfExists(runPath(root, task, { area: 'round', round: n, file: 'reviewer.md' })) !== null ||
      readIfExists(runPath(root, task, { area: 'round', round: n, file: 'security.md' })) !== null
    if (hasVerdict && (round === null || n > round)) round = n
  }
  if (round === null) return null
  const reviewerText = readIfExists(runPath(root, task, { area: 'round', round, file: 'reviewer.md' }))
  const securityText = readIfExists(runPath(root, task, { area: 'round', round, file: 'security.md' }))
  return {
    round,
    reviewer: reviewerText ? firstLine(reviewerText) : null,
    security: securityText ? firstLine(securityText) : null
  }
}

// --- where the run is: round, phase, time in phase -------------------------

/**
 * The loop's own control record, read as a place rather than a state word:
 * which round, which phase (as a reader sees it — `taskPhaseLabel`, one-to-one
 * with the phase the loop recorded), the recorded phase itself (what the
 * history lookup compares against), and how long the run has been there.
 *
 * "How long" is measured from the record's OWN `recordedAt` — the driver
 * writes it at every transition — never from a lock's start time, a file's
 * mtime, or any other wall-clock stand-in for when the phase began. `null`
 * when no `loop_state` record exists: no run ever persisted state for this
 * task, so there is no phase to report.
 */
export type LoopPhaseReading = {
  round: number
  recordedPhase: string
  phase: string
  minutesInPhase: number
}

export function readLoopPhase(root: string, task: number, now: () => Date = () => new Date()): LoopPhaseReading | null {
  const deps = defaultControlStoreDeps(() => tasksExecutionRoot(root))
  const record = readLoopState(deps, task)
  if (record.status !== 'ok') return null
  const recordedAtMs = Date.parse(record.value.recordedAt)
  const elapsedMs = Number.isFinite(recordedAtMs) ? now().getTime() - recordedAtMs : Number.NaN
  return {
    round: record.value.round,
    recordedPhase: record.value.phase,
    phase: taskPhaseLabel(record.value.phase),
    // A clock that reads behind the record (a machine whose time moved, a
    // record written by another host) reports zero, never a negative age.
    minutesInPhase: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs / 60_000)) : 0
  }
}

// --- the newest confidence on record ---------------------------------------

/**
 * The newest round whose confidence is still readable, from the two records
 * that carry one:
 *
 *   - the developer's own statement for a round the driver has not consumed
 *     yet (`.vinaya-confidence`, under that round's own Developer folder), and
 *   - the run's published summary table, which records every round's
 *     confidence at publish.
 *
 * A round the driver has already read and cleared, and never published, leaves
 * NO confidence record behind — this reports nothing for it rather than
 * carrying an older round's figure forward under a newer round's number.
 */
function readStatedConfidence(root: string, task: number): TaskConfidence | null {
  let entries: string[]
  try {
    entries = readdirSync(runPath(root, task, { area: 'rounds' }))
  } catch {
    return null
  }
  const rounds = entries
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => b - a)
  for (const round of rounds) {
    const raw = readIfExists(runPath(root, task, { area: 'developer', round, file: CONFIDENCE_FILE_NAME }))
    if (raw === null) continue
    const parsed = parseConfidenceReply(raw)
    return { round, percent: parsed === 'absent' ? null : parsed.value, source: 'stated' }
  }
  return null
}

/** The comments of one pull request, or `null` when the read failed — a forge hiccup costs the confidence column, never the row. */
function fetchPrComments(prNumber: number): { body: string; author: string | null }[] | null {
  try {
    const raw = sh('gh', ['pr', 'view', String(prNumber), '--json', 'comments'])
    const parsed = JSON.parse(raw) as { comments: RawComment[] }
    return parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
  } catch {
    return null
  }
}

/** The highest round the run's own published summary recorded a confidence for — principal-authored comments only, the same trust boundary every other forge read here applies. */
function publishedSummaryConfidence(prNumber: number, allowlist: readonly string[]): TaskConfidence | null {
  const comments = fetchPrComments(prNumber)
  if (comments === null) return null
  let newest: TaskConfidence | null = null
  for (const comment of comments) {
    if (!isPrincipal(comment.author, allowlist as string[])) continue
    if (!isPublishedSummaryComment(comment.body)) continue
    for (const row of parseSummaryConfidenceRows(comment.body)) {
      if (newest === null || row.round >= newest.round) {
        newest = { round: row.round, percent: row.percent, source: 'published-summary' }
      }
    }
  }
  return newest
}

/**
 * The stated file wins over the summary when both exist: it is the newer of
 * the two by construction (the summary is written at publish; a statement
 * still on disk has not been consumed since). The summary is read only for a
 * run that has PUBLISHED — the one state in which a summary exists at all —
 * so an in-flight row costs no extra forge call for this field.
 */
export function readLastConfidence(
  root: string,
  task: number,
  published: { prNumber: number; allowlist: readonly string[] } | null
): TaskConfidence | null {
  const stated = readStatedConfidence(root, task)
  if (stated !== null) return stated
  if (published === null) return null
  return publishedSummaryConfidence(published.prNumber, published.allowlist)
}

// --- rendering -------------------------------------------------------------

export type TaskStatusRow = {
  tranche: string
  id: string
  issue: number
  pr: { number: number } | null
  state: TaskLoopState
  /** The loop's own recorded round, or `null` when no control record exists for this task. */
  round: number | null
  /** The phase a reader sees, and the phase the loop recorded — both `null` with no control record. */
  phase: string | null
  recordedPhase: string | null
  minutesInPhase: number | null
  lastConfidence: TaskConfidence | null
  /** What this phase has typically taken on this repository's recently merged tasks — history, never a forecast; `null` for a phase with no comparable history or too few past intervals. */
  phaseHistory: TaskPhaseHistory | null
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
    case 'not_started':
      return 'not started'
    case 'no_driver':
      return 'no driver'
  }
}

/**
 * One table, one row per task (O3) — the same columns whether one task is
 * named or every open one is listed. A fact with no record reads `—`: an empty
 * cell is a recorded absence, never a zero or a guess.
 *
 * The typical-time column is labelled as history in the header AND carries its
 * own sample count per row, so a reader can never mistake it for a forecast of
 * when this run leaves this phase. `renderTaskStatusHistoryNote` is the one
 * sentence that says so in words.
 */
const TABLE_HEADERS = [
  'task',
  'issue',
  'pr',
  'state',
  'round',
  'phase',
  'in phase',
  'confidence',
  'typical (history)'
] as const

/** An absent cell. One glyph for every "no record carries this" case, so a reader learns it once. */
const NO_VALUE = '—'

function confidenceCell(confidence: TaskConfidence | null): string {
  if (confidence === null) return NO_VALUE
  // A round whose developer stated nothing readable: recorded as an absence by
  // the loop itself, reported as one here rather than as a substituted zero.
  if (confidence.percent === null) return `absent (round ${confidence.round})`
  return `${confidence.percent}% (round ${confidence.round})`
}

function historyCell(history: TaskPhaseHistory | null): string {
  if (history === null) return NO_VALUE
  return `${history.typicalPhaseMinutes}m (n=${history.typicalPhaseSamples})`
}

function cellsFor(row: TaskStatusRow): string[] {
  return [
    `[${row.tranche}] ${row.id}`,
    `#${row.issue}`,
    row.pr ? `#${row.pr.number}` : NO_VALUE,
    renderStateText(row.state),
    row.round === null ? NO_VALUE : String(row.round),
    row.phase ?? NO_VALUE,
    row.minutesInPhase === null ? NO_VALUE : `${row.minutesInPhase}m`,
    confidenceCell(row.lastConfidence),
    historyCell(row.phaseHistory)
  ]
}

/** The sentence that keeps the typical-time column honest in words as well as in its header — printed only when at least one row actually carries a figure. */
export function renderTaskStatusHistoryNote(): string {
  return "typical (history) = median time this phase took on this repository's recently merged tasks, with the number of past rounds behind it — history, not a prediction of when this run finishes."
}

/** The table as lines: a header row, then one row per task, every column padded to its widest cell. */
export function renderTaskStatusTable(rows: readonly TaskStatusRow[]): string[] {
  const body = rows.map(cellsFor)
  const widths = TABLE_HEADERS.map((header, column) =>
    Math.max(header.length, ...body.map((cells) => (cells[column] as string).length))
  )
  const renderCells = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] as number)))
      .join('  ')
      .trimEnd()
  const lines = [renderCells(TABLE_HEADERS), ...body.map(renderCells)]
  if (rows.some((row) => row.phaseHistory !== null)) lines.push('', renderTaskStatusHistoryNote())
  return lines
}

/**
 * A backlog ref renders through the SAME row shape as a tranche one —
 * `tranche` reads `backlog`, `id` reads the Issue number, everything else (PR
 * lookup, loop state) already generalizes over `TaskRef`'s two kinds via
 * `branchForRef`.
 *
 * O4: an open task Issue whose brief is not frozen yet is a PLANNED task, never
 * started — it gets a `not_started` row rather than being omitted (before this
 * task, returning `null` here made `task status` drop it and `task_status`
 * answer "no open task matches" for an open task, which an Operator read as the
 * tranche being finished). Only a frozen task reads the outbox for its real
 * loop state and open PR; a planned one has neither yet.
 *
 * Round, phase, time in phase, confidence and typical time are read for a
 * started task only: a planned one has no control record, no statement and no
 * phase to compare against history.
 */
function buildRow(ref: TaskRef, allowlist: readonly string[]): TaskStatusRow {
  const started = hasFrozenBrief(ref.issue, allowlist)
  const root = runtimeDir()
  const base = {
    tranche: ref.kind === 'tranche' ? ref.tranche : 'backlog',
    id: ref.kind === 'tranche' ? ref.id : String(ref.issue),
    issue: ref.issue
  }
  if (!started) {
    return {
      ...base,
      pr: null,
      state: { kind: 'not_started' },
      round: null,
      phase: null,
      recordedPhase: null,
      minutesInPhase: null,
      lastConfidence: null,
      phaseHistory: null
    }
  }
  const pr = findPrForRef(ref)
  const state = deriveLoopState(root, ref.issue)
  const phase = readLoopPhase(root, ref.issue)
  const confidence = readLastConfidence(
    root,
    ref.issue,
    state.kind === 'published' && pr ? { prNumber: pr.number, allowlist } : null
  )
  return {
    ...base,
    pr,
    state,
    round: phase?.round ?? null,
    phase: phase?.phase ?? null,
    recordedPhase: phase?.recordedPhase ?? null,
    minutesInPhase: phase?.minutesInPhase ?? null,
    lastConfidence: confidence,
    phaseHistory: null
  }
}

// --- command-facing entry points --------------------------------------

/**
 * O1/O3, the entire read for the list form — the ONE function
 * `commands/task-status.ts` calls for it (`apps/cli/specs/surface.md`'s
 * one-command-one-function discipline; every smaller piece above stays
 * unexported and reachable only from here or `gatherSingleTaskStatus`,
 * same file, so it costs no extra boundary call there).
 *
 */
export function gatherTaskStatusList(): TaskStatusRow[] {
  const allowlist = principalAllowlist()
  const root = runtimeDir()
  const rows: TaskStatusRow[] = []
  for (const ref of listOpenTaskIssues()) {
    // A backlog ref only ever becomes a candidate once the loop has
    // already written it an outbox directory — see `hasOutboxDir`'s own doc
    // comment. A tranche-labeled ref carries no such gate: O4 lists every open
    // tranche task Issue, a not-yet-frozen (planned) one as `not started`.
    if (ref.kind === 'backlog' && !hasOutboxDir(root, ref.issue)) continue
    rows.push(buildRow(ref, allowlist))
  }
  return rows
}

export type SingleTaskStatus =
  | { kind: 'not_found' }
  // Retained for `commands/task-status.ts` (out of this task's Surface) — no
  // longer produced: O4 gives a planned task with no frozen brief the same
  // not-started `ok` row the list form does, rather than this refusal.
  | { kind: 'no_brief' }
  | {
      kind: 'ok'
      row: TaskStatusRow
      verdictLines: RoundVerdictLines | null
      resumeCommand: string | null
    }

/** O2's entire read for the single-task form — the ONE function `commands/task-status.ts` calls for it, same discipline as `gatherTaskStatusList`. O4: a planned task with no frozen brief reads as a `not_started` `ok` row here too, never the retired `no_brief` refusal. */
export function gatherSingleTaskStatus(tranche: string, id: string): SingleTaskStatus {
  const ref = listOpenTaskIssues().find((r) => r.kind === 'tranche' && r.tranche === tranche && r.id === id)
  if (!ref) return { kind: 'not_found' }

  const row = buildRow(ref, principalAllowlist())

  const root = runtimeDir()
  const verdictLines = lastRoundVerdictLines(root, ref.issue)
  const pause = readPauseState(root, ref.issue)
  const resumeCommand =
    row.state.kind === 'paused' && row.pr ? resumeCommandFor(row.pr.number, pause?.agent, pause?.model) : null
  return { kind: 'ok', row, verdictLines, resumeCommand }
}
