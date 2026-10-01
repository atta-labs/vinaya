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
 * that phase (measured from that record's own timestamp), the newest
 * confidence any record still carries, and what the same phase has typically
 * taken on this repository's recently merged tasks (`task-status-history.ts`
 * — history, never a forecast). Every one of those is `null` when no record
 * carries it; none of them is ever estimated.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import {
  DEFAULT_PAGE_LIMIT,
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
  type TaskNextAction,
  type TaskPhaseHistory
} from '@attalabs/aeg-core'
import { resolveTaskIssueRef } from '@attalabs/aeg-forge-state'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'
import { findOpenPrForBranch, runtimeDir } from './dev-review-loop.js'
import { DRIVER_LOCK_FILENAME, runPath, tasksExecutionRoot } from './run-paths.js'
import { loopLogPathFor, loopsRoot, type LoopLogRepo } from './loop-log.js'
import { CONFIDENCE_FILE_NAME, parseConfidenceReply } from './dev-review-loop/round-assess.js'
import {
  phaseHistoryLookup,
  prCommentReaderForOneStatusRead,
  type PhaseHistoryLookup,
  type PrCommentReader
} from './task-status-history.js'
import { findRecordedControllerRun } from './task-run-background.js'
import {
  claimIsPastReporting,
  claimIsStale,
  claimLaunchIsAlive,
  readStartClaims,
  resolvePauseDisposition,
  type PauseDisposition,
  type StartRecord
} from './task-tools/start.js'
import {
  GH_STATUS_READ_TIMEOUT_MS,
  MAX_GH_STATUS_OUTPUT_BYTES,
  readTaskPrFacts,
  sanitizeForgeText,
  type TaskPrFacts,
  type TaskPrRead
} from './task-tools/pr-facts.js'
import { getProcessSnapshot, type ProcessSnapshot } from './dispatch.js'

/**
 * The ceiling on one `gh` read this file makes — the SAME bounds
 * `task-status-history.ts` raises for its own, and for the same reason: these
 * reads are synchronous (one `gh issue list`, plus one `gh issue view` per open
 * task), and the long-lived task-tool server chains every request through one
 * promise, so a `gh` that hangs here would hold every other task's queued call
 * behind it. A task Issue's comment payload also passes `execFileSync`'s own
 * 1 MiB default, which is why the buffer is raised rather than left to throw.
 */
const GH_READ_TIMEOUT_MS = 20_000
const MAX_GH_OUTPUT_BYTES = 64 * 1024 * 1024

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_GH_OUTPUT_BYTES,
    timeout: GH_READ_TIMEOUT_MS
  }).trim()
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

/**
 * The open Issues whose comments mention a frozen brief's marker — ONE forge
 * query however many there are, so a listing finds the planned backlog tasks
 * without reading the comments of every open Issue. A candidate list, not a
 * claim: the phrase can also sit in an ordinary comment, so a row is shown only
 * once `hasFrozenBrief` has read that Issue's own brief. A failed query finds
 * none — the listing then shows what the outbox accounts for, as it did before.
 */
function listBriefCandidateIssues(): Set<number> {
  try {
    const raw = sh('gh', [
      'issue',
      'list',
      '--state',
      'open',
      '--search',
      '"aeg:brief" in:comments',
      '--json',
      'number',
      '--limit',
      String(OPEN_ISSUE_LIST_LIMIT)
    ])
    return new Set((JSON.parse(raw) as Array<{ number: number }>).map((issue) => issue.number))
  } catch {
    return new Set()
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
  /** `null` for a pause recorded before any pull request existed — kept in step with `dev-review-loop/pause-resume.ts`'s own `PauseState`, the record this parses. */
  prNumber: number | null
  reason: PauseReason
  detail?: string
  pausedAt: string
  agent?: string
  model?: string
}

/** This file's own narrow copy of the pause read (its header's split between forge-touching entry points and pure outbox reads), including the shared reader's non-positive-sentinel normalization — a record already on disk can carry `-1` for "no pull request", and a second reader that disagreed about that value is how the sentinel survived being fixed in one place. */
function readPauseState(root: string, task: number): PauseState | null {
  const raw = readIfExists(runPath(root, task, { area: 'control', file: 'pause-state.json' }))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PauseState
    const pr = parsed.prNumber
    return typeof pr === 'number' && pr <= 0 ? { ...parsed, prNumber: null } : parsed
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

// --- a start that was accepted, before its driver is confirmed --------------

/**
 * What a start claim says about a task no driver lock accounts for yet.
 *
 * `task_start` answers as soon as the process it launched is alive, and keeps
 * its claim; the run's own driver lock appears only after `task run` has
 * rendered and posted the frozen brief and run its start-of-run sweep — forge-
 * bound steps that routinely take tens of seconds. Reading nothing in that
 * window and reporting `no driver` told a caller its successful start had not
 * happened, and the obvious next thing to do about that is start the task
 * again.
 *
 * `startedAt` is the claim's own accepted-at timestamp, `requestId` the start
 * request it belongs to — the same identity `task_start` returned to whoever
 * asked for the start, so a reader can tie the two together.
 */
export type StartClaimState =
  | { kind: 'starting'; requestId: string; startedAt: string }
  | { kind: 'start_did_not_come_up'; requestId: string; startedAt: string }

/** This task's tranche address, for matching a claim written against an ordinal — `null` for a task addressed only by its Issue number. */
export type TaskAddress = { tranche: string; id: string } | null

export type StartClaimDeps = {
  /** The claims this machine holds, through the start handler's own store (`task-tools/start.ts`'s `readStartClaims`) — never a second listing of the control directory. */
  claims: (root: string) => StartRecord[]
  /** Is the process a claim's own launch spawned still running? The one liveness signal that exists BEFORE a driver lock does. */
  isPidAlive: (pid: number) => boolean
  /** A live re-read of that pid's own identity, compared against the one the claim captured — see `task-tools/start.ts`'s `claimLaunchIsAlive`. */
  snapshot: (pid: number) => ProcessSnapshot | null
  now: () => string
}

export const defaultStartClaimDeps: StartClaimDeps = {
  claims: readStartClaims,
  isPidAlive: isDriverPidAlive,
  snapshot: getProcessSnapshot,
  now: () => new Date().toISOString()
}

/**
 * The most a claim's own strings may say in a status cell.
 *
 * `requestId` and `startedAt` come off a file on disk and are rendered into
 * `renderTaskStatusTable`'s padded markdown rows and into the `task_status`
 * state string — the exact string the Operator doctrine keys its single action
 * off.
 * Replacing only the non-printable characters is not enough: the whole
 * printable range includes the punctuation the state phrases themselves are
 * built from, so a `requestId` reading `abc) — running (pid 4242` would render
 * `starting (start request abc) — running (pid 4242)` and name a state the
 * machine is not in. So `requestId` is narrowed to the alphabet its real
 * values use — a hex identity — everything else becomes `?`, and the length is
 * bounded.
 *
 * `startedAt` is not narrowed but RE-RENDERED, from the instant it names
 * rather than from the characters it carries (`displayClaimTimestamp`): a
 * string built out of a parsed number can carry nothing to escape from, and —
 * the reason this is not merely another way to be safe — an alphabet silently
 * changed the VALUE. `2026-09-27 12:00:00Z` is a time `Date.parse` accepts and
 * that alphabet turned into `2026-09-27?12:00:00Z`, which parses to nothing;
 * `deriveLoopState` then compared that against the driver lock, failed to read
 * it, and let an old dead lock suppress a live claim — the `no driver` this
 * state exists to remove, reappearing for exactly one timestamp shape.
 *
 * This is display-side only. The store's parser rejects a `requestId` that
 * could name a path (see `start.ts`'s `isSafeRequestId`) but still accepts any
 * `startedAt`: an odd claim is still a claim, and refusing to READ one would
 * cost the accurate reading this whole state exists to give.
 */
const CLAIM_FIELD_DISPLAY_MAX = 64

/** Hex digests and the `-`/`_` a hand-written or older identity may carry — never a space, a bracket or a dash-like punctuation the state phrases use. */
const REQUEST_ID_DISPLAY_ALPHABET = /[^A-Za-z0-9._-]/g

function displaySafeClaimField(value: string, alphabet: RegExp): string {
  const narrowed = value.replace(alphabet, '?')
  return narrowed.length > CLAIM_FIELD_DISPLAY_MAX ? `${narrowed.slice(0, CLAIM_FIELD_DISPLAY_MAX)}…` : narrowed
}

/**
 * A claim's accepted-at as the canonical spelling of the instant it names —
 * the same instant every window predicate ages it by, so what a reader is
 * shown and what the machine decided on are one time, however the claim
 * happened to spell it. See {@link CLAIM_FIELD_DISPLAY_MAX}'s own note.
 *
 * Unreachable through `readStartClaim`, which answers `null` for a claim whose
 * time does not parse (`claimIsPastReporting`), but total anyway: a renderer
 * that cannot be handed an arbitrary string is one no later caller has to
 * remember to sanitize for.
 */
function displayClaimTimestamp(value: string): string {
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : 'an unreadable time'
}

/**
 * A claim names a task the way the call that wrote it addressed one: a
 * standalone target carries the Issue number itself, a tranche target carries
 * the ordinal it was started by. Matching the ordinal needs this task's own
 * address, which the caller already holds — resolving it here would be a forge
 * read inside a reader whose whole contract is that it makes none.
 */
function claimMatchesTask(record: StartRecord, task: number, address: TaskAddress): boolean {
  const target = record.target
  if ('issue' in target) return target.issue === task
  return address !== null && target.tranche === address.tranche && target.id === address.id
}

/**
 * The newest start claim for this task, read as a state — or `null` when no
 * claim names it at all, which is the one case that is genuinely `no_driver`.
 *
 * A claim still inside the start handler's own stale-claim window is a start
 * coming up (`starting`), and so is one past that window whose launched process
 * is still alive: that is a preparation outlasting any fixed wait, exactly the
 * reading `task_start`'s own supersede path takes of the same record (its
 * `claimIsStale` and its `claimLaunchIsAlive`, shared rather than re-derived,
 * so both places mean one window and one liveness test). A claim past the
 * window whose process is gone, with no driver lock to show for it, is a start
 * that did not come up — reported as that, naming its request, rather than as
 * the absence it looks like.
 *
 * TWO kinds of claim say nothing about a start at all, and both read `null`
 * here — the caller's `no_driver`, exactly as before this state existed:
 *
 *   - A claim whose launch was CONFIRMED. That outcome means the run's own
 *     driver lock appeared and named a live pid, so the run this claim started
 *     did come up. Whatever became of it afterwards is the business of the
 *     records that run wrote, never of the claim.
 *   - A claim past `START_CLAIM_REPORTING_WINDOW_MS`. A successful start never
 *     releases its claim, so the file outlives its run by hours; past that
 *     bound it cannot tell a launch that never came up from a run that came up,
 *     worked, and left nothing behind. Asserting the first about the second is
 *     the same false report — with the sign flipped — that `no driver` was.
 *
 * `exceptRequestId` drops one claim from the reading: the caller's OWN. A
 * writer that asks this question asks it about OTHER starts — `task_start`
 * writes its claim before it reads any state, so without this it would find
 * the claim it wrote a moment ago and refuse its own launch as a duplicate of
 * itself. A pure reader passes none, and sees every claim.
 */
export function readStartClaim(
  root: string,
  task: number,
  address: TaskAddress,
  deps: StartClaimDeps = defaultStartClaimDeps,
  exceptRequestId?: string
): StartClaimState | null {
  let newest: { record: StartRecord; at: number } | null = null
  for (const record of deps.claims(root)) {
    if (record.requestId === exceptRequestId) continue
    if (!claimMatchesTask(record, task, address)) continue
    const parsed = Date.parse(record.startedAt)
    // A record whose own timestamp does not parse sorts oldest, so it never
    // outranks a claim that carries a readable time — and if it is the only
    // one, `claimIsPastReporting` answers for it below: a claim with no
    // measurable age says nothing about the present.
    const at = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
    if (newest === null || at >= newest.at) newest = { record, at }
  }
  if (newest === null) return null
  const record = newest.record
  if (record.confirmedAt !== undefined) return null
  if (claimIsPastReporting(record, deps.now)) return null
  const alive = claimLaunchIsAlive(record, deps.isPidAlive, deps.snapshot)
  const kind = !claimIsStale(record, deps.now) || alive ? 'starting' : 'start_did_not_come_up'
  return {
    kind,
    requestId: displaySafeClaimField(record.requestId, REQUEST_ID_DISPLAY_ALPHABET),
    startedAt: displayClaimTimestamp(record.startedAt)
  }
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
  // A start this machine accepted, before its driver lock exists — the two
  // readings above are the only records that can say so, and they are consulted
  // last, where nothing else carries a fact about this task at all.
  | StartClaimState
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
 *
 * But a FRESH start claim — one accepted strictly after that dead lock was
 * written — is newer still, and outranks the exit trace: it belongs to a run
 * started AFTER the one that exited, a start coming up whose own driver lock has
 * not appeared yet, not the run that wrote the trace. Reporting a start the
 * Operator had just accepted as `exited` sent it to start the task again, and
 * the run already coming up then had a second developer put on its branch — the
 * exact failure this precedence closes. Freshness is measured the SAME way,
 * against the same lock, whether the claim overrides the exit trace here or is
 * the last-resort reading below (`claimPostdatesLock`), so "outranks the exit
 * record" and "outranks the empty fallback" can never come to mean two
 * different comparisons; and a start that REPLACED an earlier failed one for
 * this task changes nothing, since `readStartClaim` reads the newest claim, so
 * it is the replacement's own accepted-at that is compared, never the one it
 * replaced.
 *
 * A start claim is otherwise the LEAST authoritative signal here: a live driver
 * still reads `running` whatever a claim says, and a pause or a published round
 * still wins over it, because each is backed by a record of something that
 * actually happened to a run while a claim only says a start was accepted. So a
 * claim decides only two things — it overrides the previous run's exit trace
 * when it is fresh, and it is the one reading left where nothing else describes
 * the task at all. `startClaim` is a thunk read ONCE and only after a live
 * driver is ruled out, so a running task pays nothing for the claim directory
 * listing.
 */
export function deriveLoopState(
  root: string,
  task: number,
  loopLog: LoopLogLookup = { repo: resolveRepoSync(), loopsRoot: loopsRoot() },
  startClaim: () => StartClaimState | null = () => readStartClaim(root, task, null)
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

  // The start claim, read once now that a live driver is ruled out (a running
  // task returned above and never pays for it) and consulted on two paths
  // below. It is FRESH when it postdates this task's most recent driver lock —
  // or when there is no lock at all: such a claim was accepted after the run
  // that wrote the lock, so it speaks for a start still coming up, not for that
  // earlier run. A lock the claim does NOT postdate is this start's own driver,
  // or a later one — the driver appeared and the claim stops speaking. An
  // unreadable timestamp on either side is not fresh: a comparison that cannot
  // be made is not evidence for the louder reading. The claim's `startedAt` is
  // the canonical spelling of the instant its record carries
  // (`displayClaimTimestamp`), never a narrowed rendering of the characters, so
  // this compares two records' times, not two display strings, whatever shape
  // the claim on disk spelled its own time in.
  const claim = startClaim()
  const freshClaim: StartClaimState | null =
    claim !== null && (lock === null || claimPostdatesLock(claim.startedAt, lock.startedAt)) ? claim : null

  if (lock) {
    const trace = readLastDriverExited(task, loopLog)
    if (trace) {
      // A fresh start outranks the previous run's exit trace — see this
      // function's own header for why, and for why a replaced earlier failed
      // start does not change which time is compared.
      if (freshClaim !== null) return freshClaim
      return { kind: 'exited', reason: trace.reason, lastDecision: trace.lastDecision }
    }
  }

  const published = newestPublishedRound(root, task)
  const pause = readPauseState(root, task)
  if (pause && (published === null || pause.round > published)) {
    return { kind: 'paused', reason: pause.reason, detail: pause.detail, round: pause.round }
  }
  if (published !== null) return { kind: 'published', round: published }
  // The last-resort reading: on the one path that otherwise ends in
  // `no_driver`, a fresh start claim is the only record that says anything about
  // this task at all.
  return freshClaim ?? { kind: 'no_driver' }
}

/** Was this claim accepted strictly after that driver lock was written? `false` whenever either timestamp does not parse — see {@link deriveLoopState}. */
function claimPostdatesLock(claimStartedAt: string, lockStartedAt: string): boolean {
  const claimAt = Date.parse(claimStartedAt)
  const lockAt = Date.parse(lockStartedAt)
  return Number.isFinite(claimAt) && Number.isFinite(lockAt) && claimAt > lockAt
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
  /** `null` when the record's own timestamp does not parse — an unrecorded fact, reported as one rather than as a zero the record never carried. */
  minutesInPhase: number | null
}

export function readLoopPhase(root: string, task: number, now: () => Date = () => new Date()): LoopPhaseReading | null {
  const deps = defaultControlStoreDeps(() => tasksExecutionRoot(root))
  const record = readLoopState(deps, task)
  if (record.status !== 'ok') return null
  const recordedAtMs = Date.parse(record.value.recordedAt)
  return {
    round: record.value.round,
    recordedPhase: record.value.phase,
    phase: taskPhaseLabel(record.value.phase),
    // A clock that reads behind the record (a machine whose time moved, a
    // record written by another host) reports zero, never a negative age. A
    // timestamp that does not parse at all reports NOTHING: the record's
    // `isoTimestamp` is only a non-empty string, so a corrupted or hand-edited
    // record reaches here, and inventing `0m` for it would state an age no
    // record carries.
    minutesInPhase: Number.isFinite(recordedAtMs)
      ? Math.max(0, Math.round((now().getTime() - recordedAtMs) / 60_000))
      : null
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

/**
 * The highest round a run's own published summary recorded a confidence FOR —
 * principal-authored comments only, the same trust boundary every other forge
 * read here applies. Pure over the comments it is handed, so the rule below is
 * unit-testable without a forge.
 *
 * A row the loop never asked for a confidence at all is SKIPPED rather than
 * reported: round 1 is never asked, so its own summary cell is the table's
 * not-asked glyph, and reporting that as a confidence would tell a reader the
 * developer skipped a statement nothing ever requested.
 */
export function confidenceFromSummaryComments(
  comments: readonly { body: string; author: string | null }[],
  allowlist: readonly string[]
): TaskConfidence | null {
  let newest: TaskConfidence | null = null
  for (const comment of comments) {
    if (!isPrincipal(comment.author, allowlist as string[])) continue
    if (!isPublishedSummaryComment(comment.body)) continue
    for (const row of parseSummaryConfidenceRows(comment.body)) {
      if (!row.asked) continue
      if (newest === null || row.round >= newest.round) {
        newest = { round: row.round, percent: row.percent, source: 'published-summary' }
      }
    }
  }
  return newest
}

/**
 * The forge half of the read above, through ONE status read's own comment
 * reader (`task-status-history.ts`'s `prCommentReaderForOneStatusRead`):
 * remembered per pull request across reads, and capped within a single read, so
 * a listing with many published tasks cannot spawn an unbounded number of
 * synchronous subprocesses and an Operator polling `task_status` re-pays
 * nothing. `null` — no confidence — when the read failed or the budget is
 * spent.
 */
function publishedSummaryConfidence(
  prNumber: number,
  allowlist: readonly string[],
  readComments: SummaryCommentReader
): LastConfidence {
  const answer = readComments(prNumber)
  if (answer.kind === 'unread') return { kind: 'unread' }
  if (answer.kind === 'failed') return { kind: 'none' }
  const confidence = confidenceFromSummaryComments(answer.comments, allowlist)
  return confidence === null ? { kind: 'none' } : { kind: 'confidence', confidence }
}

/**
 * What the confidence column knows about a row. `none` is a real absence — no
 * record carries a figure — while `unread` is an UNKNOWN: a bound stopped this
 * status read from asking at all, and reporting that as an absence would be the
 * one invented fact every other cell in this table avoids.
 */
export type LastConfidence = { kind: 'confidence'; confidence: TaskConfidence } | { kind: 'none' } | { kind: 'unread' }

/**
 * What this column needs of a comment reader: a body and an author, and the
 * same three answers `PrCommentReader` gives (read, failed, or never asked).
 *
 * Narrower than `PrCommentReader` on purpose. That reader's own comments carry a
 * `createdAt` the history read needs and this one never looks at, and a reader
 * built out of comments a pull request's OWN facts read already fetched has no
 * `createdAt` to offer — so typing this column's dependency by what it actually
 * reads is what lets one forge read serve both columns
 * (`buildRow`). `prCommentReaderForOneStatusRead` still satisfies it unchanged.
 */
export type SummaryCommentReader = (
  pr: number
) =>
  | { kind: 'read'; comments: readonly { body: string; author: string | null }[] }
  | { kind: 'failed' }
  | { kind: 'unread' }

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
  published: { prNumber: number; allowlist: readonly string[]; readComments: SummaryCommentReader } | null
): LastConfidence {
  const stated = readStatedConfidence(root, task)
  if (stated !== null) return { kind: 'confidence', confidence: stated }
  if (published === null) return { kind: 'none' }
  return publishedSummaryConfidence(published.prNumber, published.allowlist, published.readComments)
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
  /** `false` when no driver is running: the phase is the last one the run RECORDED, not a place it is in now, and `minutesInPhase` is time since that record. `null` with no control record at all. */
  phaseIsCurrent: boolean | null
  lastConfidence: TaskConfidence | null
  /** `true` when a bound stopped this row's confidence from being READ at all — an unknown, not the absence `lastConfidence: null` reports. */
  lastConfidenceUnread: boolean
  /** What this phase has typically taken on this repository's recently merged tasks — history, never a forecast; `null` for a phase with no comparable history or too few past intervals. */
  phaseHistory: TaskPhaseHistory | null
  /**
   * What this row's own pull request reports on its head — `null` both for a
   * row with no pull request and for a read that failed, told apart by `pr`
   * itself: a row with a pull request and no facts is an unread pull request,
   * which the table says rather than showing an absence the forge never
   * reported.
   */
  prFacts: TaskPrFacts | null
  /**
   * For a paused row, what that pause is waiting for — the SAME reading
   * `task_start`'s own gate takes of the same two records
   * (`defaultPauseDisposition`), so the next action this table names and the
   * tool that would move the run can never disagree. `null` for every row that
   * is not paused.
   */
  pauseDisposition: PauseDisposition | null
}

/**
 * Whether the phase the control record names is where the run actually IS.
 *
 * A live driver is in its phase. A `paused` run is too — it waits there for a
 * person — but ONLY when the two records agree: `pause-state.json` is written at
 * every pause and never cleared on resume, so a task that paused at round 1, was
 * resumed, and then died mid-round still derives `paused` off that stale record
 * while `loop_state` reads the round it actually reached and the phase it was
 * working in. Reporting that phase as current would assert developing is
 * happening while no driver exists — the exact misstatement the marking exists
 * to prevent — so a pause whose own recorded phase is not `pause` is treated
 * like any other stopped run.
 *
 * Everything else is a phase nothing is in any more: a published run is
 * finished, and `no_driver`/`exited` mean the driver vanished mid-flight.
 */
export function phaseIsCurrentFor(state: TaskLoopState, recordedPhase: string): boolean {
  if (state.kind === 'running') return true
  return state.kind === 'paused' && recordedPhase === 'pause'
}

function renderStateText(state: TaskLoopState, disposition: PauseDisposition | null = null): string {
  switch (state.kind) {
    case 'running':
      return `running (pid ${state.pid})`
    case 'paused': {
      // O3: a paused row says what the pause is waiting for, read off the same
      // disposition the `next` column is. A run a ruling has already authorized
      // reads `ruled, start continues it` (and `next` is `start`), one still
      // owed a ruling reads `needs ruling` (and `next` is `rule`) — never
      // `exited`. Every other disposition keeps the bare reason, as before.
      const base = `paused (${state.reason})`
      if (disposition === 'awaiting_ruling') return `${base} — needs ruling`
      if (disposition === 'ruled') return `${base} — ruled, start continues it`
      return base
    }
    case 'published':
      return 'published'
    case 'exited':
      return `exited (${state.reason}) — last decision: ${state.lastDecision}`
    case 'not_started':
      return 'not started'
    case 'starting':
      return `starting (start request ${state.requestId})`
    case 'start_did_not_come_up':
      return `start did not come up (start request ${state.requestId}, accepted ${state.startedAt})`
    case 'no_driver':
      return 'no driver'
  }
}

// --- the one thing to do about this row next --------------------------------

/**
 * Every run state, mapped to what the Principal does about it next — the SAME
 * mapping `aeg-root/roles/operator.md`'s own state-to-action table gives, one
 * row per state, read off that table's `Next` column by a test rather than
 * kept in step by hand. It is a `Record` over the state kinds deliberately: a
 * state added to `TaskLoopState` without a next action beside it is a
 * typecheck error, not a row that silently renders nothing.
 *
 * `by_pause_disposition` is not an action — it is the one state whose answer
 * depends on what the pause is waiting for, resolved through
 * {@link NEXT_ACTION_BY_PAUSE_DISPOSITION} below, exactly as the doctrine's
 * own paused row resolves it.
 */
export const NEXT_ACTION_BY_STATE_KIND: Record<TaskLoopState['kind'], TaskNextAction | 'by_pause_disposition'> = {
  not_started: 'start',
  // A start already accepted needs nothing done about it: the doctrine's action
  // here is to read again, and the wait is bounded by the claim itself.
  starting: 'wait',
  start_did_not_come_up: 'start',
  running: 'wait',
  paused: 'by_pause_disposition',
  // A published round is the loop's own last act; what follows is the review
  // gate's answer, and the merge rule below is what turns this into `merge`.
  published: 'wait',
  exited: 'start',
  no_driver: 'start'
}

/**
 * A pause is not one situation, and its four dispositions route to four
 * different seats — the same four the doctrine's paused row already names, in
 * the same order, with the same tools behind them: a decision the Principal
 * owes (`task_resume` authenticates it), a decision already taken as resume or
 * a hiccup the loop resumes itself (`task_start` continues it), a decision
 * already taken as CANCEL (no continuation may reverse it), and a record this
 * host cannot read at all — a defect to report, never a state to act on.
 */
export const NEXT_ACTION_BY_PAUSE_DISPOSITION: Record<PauseDisposition, TaskNextAction> = {
  awaiting_ruling: 'rule',
  // A ruling is already posted that postdates this pause — `task_start`
  // continues it (by handing it to `task_resume`), so the action is `start`,
  // not another `rule`.
  ruled: 'start',
  resolved_resume: 'start',
  self_resuming: 'start',
  resolved_cancel: 'cancel',
  unreadable: 'investigate',
  // A pause record that reads as no hold at all (a round already published
  // past) leaves the continuation to `task_start`, which is what the state's
  // own doctrine row names.
  none: 'start'
}

/**
 * The one code-review verdict value that counts as clean here — `APPROVE`,
 * and nothing else.
 *
 * `LGTM` is a value the extractor's own pattern accepts, and it was in this set
 * until a review pointed out that the merge gate does not: `checkReviewGate`
 * treats only `APPROVE` as clean, so a row whose newest verdict read `LGTM`
 * would have named `merge` for a head the gate itself refuses. This set is
 * narrower than the extractor's vocabulary on purpose, and the direction of the
 * difference is the safe one.
 */
const CLEAN_CODE_REVIEW = new Set(['APPROVE'])

/**
 * Is this row's own head ready to merge? The review gate green AND both
 * verdicts on that head clean — never a re-derivation of the gate's own rule
 * (`checkReviewGate` reads labels, ruling ordinals and an input manifest this
 * reader never fetches), and never a verdict bound to some earlier head
 * (`taskPrFactsFrom` has already dropped those).
 *
 * The gate's own conclusion is the authority; the two verdict values are read
 * beside it so the cell a reader is shown and the action beside it rest on the
 * same facts, rather than on a green word whose reason is somewhere else.
 */
function headIsReadyToMerge(facts: TaskPrFacts | null): boolean {
  if (facts === null || facts.gate !== 'green') return false
  return CLEAN_CODE_REVIEW.has(facts.codeReview ?? '') && facts.security === 'PASS'
}

/**
 * Is a driver still working this task? Merge-readiness never overrides these
 * two states, because a live run can push another commit seconds from now: the
 * gate went green on the head this read saw, and telling the Principal to merge
 * races the very loop that is still working. `wait` is the truthful answer for
 * both, and the next read says `merge` once the run stops.
 */
function driverIsLive(state: TaskLoopState): boolean {
  return state.kind === 'running' || state.kind === 'starting'
}

/**
 * The one action the `Next` column names for a row.
 *
 * Merge-readiness wins over the state's own action, because it is the newer
 * fact: a run that has published and whose gate is green needs a merge, not
 * another read. Three answers it never overrides. Two are decisions already
 * made or unreadable: a pause resolved as CANCEL — telling the Principal to
 * merge what they already cancelled would reverse their own decision — and a
 * record this host could not read, where every reading is suspect and the only
 * honest instruction is to look. The third is a driver still working the task
 * (see {@link driverIsLive}), where the head this read judged is not the head
 * the run will finish on.
 */
export function nextActionFor(row: TaskStatusRow): TaskNextAction {
  const fromState = NEXT_ACTION_BY_STATE_KIND[row.state.kind]
  const action =
    fromState === 'by_pause_disposition'
      ? // A paused row whose disposition was not read is one a decision is owed
        // on, as far as this table can tell — the doctrine's own default for the
        // paused row, and the seat a reader is safest sent to.
        NEXT_ACTION_BY_PAUSE_DISPOSITION[row.pauseDisposition ?? 'awaiting_ruling']
      : fromState
  if (action === 'cancel' || action === 'investigate' || driverIsLive(row.state)) return action
  return headIsReadyToMerge(row.prFacts) ? 'merge' : action
}

/**
 * One table, one row per task — the same columns whether one task is named or
 * every open one is listed, and the same table `task_status` returns in its own
 * `table` field, rendered by this one function so the tool and the command can
 * never print different columns for the same records. A fact with no record
 * reads `—`: an empty cell is a recorded absence, never a zero or a guess.
 *
 * Markdown, and padded: the pipes make it a table wherever an Operator pastes
 * it as returned, and the padding keeps it readable in a terminal, so one
 * rendering serves both readers.
 *
 * The typical-time column is labelled as history in the header AND carries its
 * own sample count per row, so a reader can never mistake it for a forecast of
 * when this run leaves this phase. `renderTaskStatusHistoryNote` is the one
 * sentence that says so in words.
 *
 * The five pull-request columns are a SUMMARY of the head, not a diagnosis of
 * it: one word for CI, the newest verdict on that head from each reviewer, and
 * the review gate's own conclusion. Why a check failed is `task_pr_read`'s
 * answer, and a `red` word here is the reason to reach for it.
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
  'typical (history)',
  'head',
  'ci',
  'code review',
  'security',
  'gate',
  'next'
] as const

/** An absent cell. One glyph for every "no record carries this" case, so a reader learns it once. */
const NO_VALUE = '—'

/** A read this status read attempted and could not complete — an unknown, never the absence `NO_VALUE` states. */
const NOT_READ = 'not read'

/**
 * A `stated` figure is the developer's OWN statement for a round whose review
 * has not completed — the driver clears the statement the moment it assesses
 * the round — so the cell says so: read as a completed round's outcome it would
 * overstate what happened. A `published-summary` figure is a completed round's
 * own recorded confidence and needs no qualifier.
 *
 * A round the loop asked and whose statement was missing or unreadable reads
 * `absent`; a round it never asked never reaches this cell at all (it carries no
 * confidence record), so `absent` never blames a developer for a statement
 * nothing requested.
 */
function confidenceCell(confidence: TaskConfidence | null, unread: boolean): string {
  // A read this status read never made is not an absence: saying `—` here would
  // tell a reader no record carries a figure when nothing looked.
  if (unread) return NOT_READ
  if (confidence === null) return NO_VALUE
  const qualifier = confidence.source === 'stated' ? `round ${confidence.round}, stated` : `round ${confidence.round}`
  if (confidence.percent === null) return `absent (${qualifier})`
  return `${confidence.percent}% (${qualifier})`
}

/** The phase a run RECORDED, marked when no driver is running it any more — the state cell already says the driver is gone, and this stops the phase cell from asserting a place the run is still in. */
function phaseCell(row: TaskStatusRow): string {
  if (row.phase === null) return NO_VALUE
  return row.phaseIsCurrent === false ? `${row.phase} (last recorded)` : row.phase
}

function historyCell(history: TaskPhaseHistory | null): string {
  if (history === null) return NO_VALUE
  return `${history.typicalPhaseMinutes}m (n=${history.typicalPhaseSamples})`
}

/** The mark on a phase that has already run past twice what the same phase typically took here. A phase with no typical time never carries it — there is nothing to be twice OF, and a mark with no comparison behind it would be a judgement this table never makes. */
const OVER_TYPICAL_MARK = '⚠'

/**
 * Has this phase run past twice its own typical time? History compared against
 * history: both sides are recorded facts, and the comparison is still not a
 * forecast — it says where this run sits against what already merged, never
 * when it will finish.
 */
export function phaseIsPastTwiceTypical(row: TaskStatusRow): boolean {
  if (row.phaseHistory === null || row.minutesInPhase === null) return false
  return row.minutesInPhase > 2 * row.phaseHistory.typicalPhaseMinutes
}

function inPhaseCell(row: TaskStatusRow): string {
  if (row.minutesInPhase === null) return NO_VALUE
  return phaseIsPastTwiceTypical(row) ? `${row.minutesInPhase}m ${OVER_TYPICAL_MARK}` : `${row.minutesInPhase}m`
}

/**
 * How many characters of a head sha the table shows. A row is one line and a
 * pull request's head is the one fact on it a reader carries to another tool,
 * so it is abbreviated the way git itself abbreviates — never truncated to
 * something no command would resolve.
 */
const HEAD_DISPLAY_CHARS = 7

/** The pull-request columns, in the header's own order: head, CI, code review, security, gate. */
function prCells(row: TaskStatusRow): string[] {
  // A row with no pull request has nothing to report here, and a read that
  // failed has nothing it MANAGED to report — two different cells, because a
  // dash would claim the forge answered.
  if (row.pr === null) return [NO_VALUE, NO_VALUE, NO_VALUE, NO_VALUE, NO_VALUE]
  const facts = row.prFacts
  if (facts === null) return [NOT_READ, NOT_READ, NOT_READ, NOT_READ, NOT_READ]
  return [
    facts.head === null ? NO_VALUE : facts.head.slice(0, HEAD_DISPLAY_CHARS),
    facts.ci,
    facts.codeReview === null ? NO_VALUE : facts.codeReview.toLowerCase(),
    facts.security === null ? NO_VALUE : facts.security.toLowerCase(),
    facts.gate === null ? NO_VALUE : facts.gate
  ]
}

function cellsFor(row: TaskStatusRow): string[] {
  return [
    `[${row.tranche}] ${row.id}`,
    `#${row.issue}`,
    row.pr ? `#${row.pr.number}` : NO_VALUE,
    renderStateText(row.state, row.pauseDisposition),
    row.round === null ? NO_VALUE : String(row.round),
    phaseCell(row),
    inPhaseCell(row),
    confidenceCell(row.lastConfidence, row.lastConfidenceUnread),
    historyCell(row.phaseHistory),
    ...prCells(row),
    nextActionFor(row)
  ]
}

/** The sentence that keeps the typical-time column honest in words as well as in its header — printed only when at least one row actually carries a figure. */
export function renderTaskStatusHistoryNote(): string {
  return "typical (history) = median time this phase took on this repository's recently merged tasks, with the number of past rounds behind it — history, not a prediction of when this run finishes."
}

/**
 * What one read of this table was: when it was taken, on which machine, and how
 * many tasks it listed. Every claim in the rows above is as old as this line
 * says and no newer — which is the whole reason it is printed: a table pasted
 * into an answer carries its own read time with it, so nobody has to ask
 * whether they are looking at a fresh reading or an earlier one.
 *
 * The count is of the rows this table carries. A listing it lists every open
 * task in; a single-task read, the one row asked for.
 */
export function renderTaskStatusFooter(rowCount: number, at: Date, host: string): string {
  const tasks = rowCount === 1 ? '1 task' : `${rowCount} tasks`
  return `read ${at.toISOString()} (UTC) on ${host} — ${tasks} listed`
}

/** What the renderer needs that is not a row — injectable so a test asserts a fixed footer rather than the wall clock and this machine's own name. */
export type TaskStatusTableDeps = { now: () => Date; host: () => string }

export const defaultTaskStatusTableDeps: TaskStatusTableDeps = { now: () => new Date(), host: () => hostname() }

/**
 * The most one cell may say. The longest phrase this table renders is a start
 * that did not come up — a bounded request identity, a timestamp and their
 * labels — comfortably inside this, so no legitimate cell is ever shortened;
 * what it bounds is a value off a forge label or a record on disk, which is a
 * LABEL and never prose. The same reasoning `MAX_CHECK_NAME_CHARS` applies to a
 * check's own name in `task_pr_read`.
 */
const CELL_DISPLAY_MAX = 200

/**
 * Every cell's one exit before it is rendered, because a cell's value is not
 * this renderer's to trust and the table is relayed VERBATIM into the
 * Principal's view.
 *
 * Most cells come from a closed vocabulary, but some do not: the tranche slug is
 * whatever the forge label carried (`findTrancheSlug` slices the label prefix and
 * validates nothing at read time) and a state phrase can carry a pause reason or
 * a last-decision word off a record on disk. That is UNAUTHORED text in the same
 * sense `task_pr_read`'s own trust boundary means it — nobody to allowlist — so
 * it leaves through the same neutralization that boundary prescribes, and then
 * through the two characters that break a markdown table:
 *
 * 1. `sanitizeForgeText` — strip terminal colouring, redact secrets through this
 *    codebase's single `redact()` chokepoint, defang the two grammars that carry
 *    authority here (an AEG control comment's `<!--` opener, a line-anchored
 *    `VERDICT:` label), and cap. Without the defang, a label beginning `<!--`
 *    swallowed every cell and row after it in any markdown or HTML renderer —
 *    hiding columns from a reader while the Operator believed it had relayed the
 *    table intact — and the same cell could carry a control-comment shape into
 *    the Operator's own context.
 * 2. EVERY remaining `<` becomes `&lt;`, not just the comment opener. The opener
 *    is only the loudest of a family: `<span hidden>`, `<div
 *    style="display:none">`, `<style>` and `<script>` all fit inside a forge
 *    label's own length limit, and each hides the cells and rows after it in any
 *    renderer that honours raw HTML — the same harm, reached by a different tag.
 *    No legitimate cell this table renders contains an angle bracket, so this
 *    costs nothing a reader wanted.
 * 3. A vertical bar is ESCAPED (`\|`, which markdown renders as the bar itself)
 *    rather than dropped, so the value still reads as itself; one unescaped bar
 *    silently adds a column and the header stops naming what the row carries.
 * 4. A newline or carriage return becomes a space: no escape keeps a line break
 *    inside one cell, and a cell that ends its own row is the same defect.
 *
 * `&` is left alone deliberately: escaping it AFTER step 1 would turn that step's
 * own `&lt;!--` into visible `&amp;lt;!--`, and a bare ampersand renders as
 * itself in every reader this table reaches.
 */
function cellSafe(value: string): string {
  return sanitizeForgeText(value, CELL_DISPLAY_MAX)
    .replaceAll('<', '&lt;')
    .replaceAll('|', '\\|')
    .replaceAll(/[\r\n]+/g, ' ')
}

/** The table as lines: a header row, a markdown separator, then one row per task, every column padded to its widest cell, and one footer line last. */
export function renderTaskStatusTable(
  rows: readonly TaskStatusRow[],
  deps: TaskStatusTableDeps = defaultTaskStatusTableDeps
): string[] {
  // Escaped BEFORE the widths are measured, so a cell that grew by an escape
  // still pads to the column it is in.
  const body = rows.map((row) => cellsFor(row).map(cellSafe))
  const widths = TABLE_HEADERS.map((header, column) =>
    Math.max(header.length, ...body.map((cells) => (cells[column] as string).length))
  )
  const renderCells = (cells: readonly string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] as number)).join(' | ')} |`
  const separator = `| ${widths.map((width) => '-'.repeat(Math.max(3, width))).join(' | ')} |`
  const lines = [renderCells(TABLE_HEADERS), separator, ...body.map(renderCells)]
  if (rows.some((row) => row.phaseHistory !== null)) lines.push('', renderTaskStatusHistoryNote())
  lines.push('', renderTaskStatusFooter(rows.length, deps.now(), deps.host()))
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
/**
 * One claim listing for one status read, however many rows it has.
 *
 * `readStartClaims` lists and parses the whole unscoped control folder, and a
 * claim for a start that worked is never released — so that folder only grows,
 * and reading it once per row made a listing of N tasks pay N full scans of it.
 * The deps object built here is threaded through every row of the same read
 * instead, so the folder is listed at most once, and only if some row actually
 * reaches the claim (the thunk is still a thunk).
 */
export function claimDepsForOneRead(): StartClaimDeps {
  let cached: StartRecord[] | null = null
  return {
    ...defaultStartClaimDeps,
    claims: (root) => {
      cached ??= defaultStartClaimDeps.claims(root)
      return cached
    }
  }
}

/**
 * How many pull requests ONE status read will read facts for: the catalog's own
 * `DEFAULT_PAGE_LIMIT`, the size of the page `task_status` returns when a caller
 * names no limit — so a default-sized answer never carries a column nothing read.
 *
 * It IS a ceiling, and it exists for the reason a review named: these reads are
 * synchronous, and the long-lived task-tool server chains every request through
 * one promise, so an unbounded number of them would hold every other task's
 * queued call behind a listing of a busy repository, and a `gh` that hangs would
 * hold it behind one subprocess (bounded in turn by
 * `GH_STATUS_READ_TIMEOUT_MS`).
 *
 * It is deliberately HIGHER than the confidence column's own
 * `SUMMARY_CONFIDENCE_READS_PER_STATUS_READ`, which it was first borrowed from,
 * for two reasons. That reader asks about PUBLISHED rows only, while this one
 * asks about every row with a pull request — strictly more. And recovering a
 * truncated row costs MORE than reading it up front: reading it by name is one
 * Issue read plus one pull-request read, where the listing would have spent one.
 * A bound that makes the ordinary listing pay twice over is not a saving.
 *
 * Past the budget the remaining rows read `not read` — the word this table
 * already uses for a read nothing made — and the answer for the row an Operator
 * is actually acting on is to read that task by NAME. That is one row and always
 * inside the budget, but only because the reader FILTERS BEFORE IT BUILDS
 * (`gatherTaskStatusList`'s own selector): a named read that filtered afterwards
 * would have spent every slot in listing order first and then reported the named
 * row's own columns as unread, which is the promise this paragraph made before
 * that filter existed. The remedy itself is the same one the doctrine already
 * gives for a task missing from a listing.
 */
export const PR_FACTS_READS_PER_STATUS_READ = DEFAULT_PAGE_LIMIT

/**
 * The pull-request facts reader every row of ONE status read shares — one forge
 * read per pull request, made only for a row that actually has one, bounded at
 * {@link PR_FACTS_READS_PER_STATUS_READ} per read, and never remembered between
 * reads (see `readTaskPrFacts` on why a CI word must not be cached). Threaded as
 * a parameter so a test drives every column off fixtures with no `gh` on `PATH`.
 *
 * `null` covers both a read that failed and a read the budget stopped this
 * status read from making. The row renders both the same way — `not read`, an
 * unknown rather than an absence — and the confidence column falls back to its
 * own bounded, remembered reader in either case, so no fact is lost that the
 * older shape would have had.
 */
export type PrFactsReader = (pr: number) => TaskPrRead | null

export function prFactsReaderFor(
  allowlist: readonly string[],
  budget: number = PR_FACTS_READS_PER_STATUS_READ,
  /** The one forge read behind this reader — injectable so a test drives the budget and the memoization with no `gh` on `PATH`. */
  read: (pr: number, allowlist: readonly string[]) => TaskPrRead | null = readTaskPrFacts
): PrFactsReader {
  // Within ONE read only — the closure dies with the read, so nothing is
  // remembered across reads. It exists because two rows could name the same
  // pull request, and because `gatherSingleTaskStatus` and `gatherTaskStatusList`
  // must never pay twice for one row.
  const answered = new Map<number, TaskPrRead | null>()
  let reads = 0
  return (pr: number) => {
    const remembered = answered.get(pr)
    if (remembered !== undefined) return remembered
    if (reads >= budget) return null
    reads += 1
    const answer = read(pr, allowlist)
    answered.set(pr, answer)
    return answer
  }
}

/**
 * Whether a read fills the pull-request COLUMNS at all.
 *
 * `'skip'` is for a caller that wants a row's identity and its pull-request
 * NUMBER and nothing else — the two ref resolutions behind
 * `task_escalation_read`, `task_resume`, `task_cancel` and `task_pr_read`, which
 * read `issue` and `pr` off the row and discard the rest. Before this existed
 * every one of those paid a `gh pr view` per invocation whose whole payload was
 * thrown away, and `task_pr_read` then re-fetched the same comments and the same
 * rollup itself — a spare synchronous subprocess in front of every queued call on
 * the shared task-tool server, for four tools that never paid it before.
 *
 * A row from a `'skip'` read carries `prFacts: null`, which renders as `not
 * read`: true of it, and the reason such a read never renders a table.
 */
export type PrFactsReadMode = 'read' | 'skip'

/** The facts reader for a `'skip'` read — it makes no forge call and answers nothing, for every row. */
const noPrFactsRead: PrFactsReader = () => null

/** A reader over comments THIS read already has in hand — the second column served by the first column's own forge read, with no call of its own. */
function commentsAlreadyRead(comments: readonly { body: string; author: string | null }[]): SummaryCommentReader {
  return () => ({ kind: 'read', comments })
}

/** The three identity fields a row carries, derived from a ref the same way for every caller — `buildRow`'s own row and the selector that decides which refs are worth building at all. */
function rowIdentityFor(ref: TaskRef): TaskStatusIdentity {
  return {
    tranche: ref.kind === 'tranche' ? ref.tranche : 'backlog',
    id: ref.kind === 'tranche' ? ref.id : String(ref.issue),
    issue: ref.issue
  }
}

function buildRow(
  ref: TaskRef,
  allowlist: readonly string[],
  history: PhaseHistoryLookup,
  readComments: PrCommentReader,
  claimDeps: StartClaimDeps,
  readPrFacts: PrFactsReader
): { row: TaskStatusRow; briefFrozen: boolean } {
  const started = hasFrozenBrief(ref.issue, allowlist)
  const root = runtimeDir()
  const base = rowIdentityFor(ref)
  // A claim written against a tranche ordinal is matched by that ordinal — the
  // address this row already carries — so a start is never missed for want of a
  // forge read inside the outbox reader.
  const startClaim = () =>
    readStartClaim(root, ref.issue, ref.kind === 'tranche' ? { tranche: ref.tranche, id: ref.id } : null, claimDeps)
  if (!started) {
    // A start this machine has already accepted makes this task started,
    // whatever the forge says about its brief: `task run` renders and posts the
    // frozen brief inside its own preparation, so a launch that has not reached
    // that step yet would otherwise read as a task nobody had started. The
    // BRIEF is still not frozen, though, which is what the view reports
    // separately — see `TaskStatusListView.briefFrozenIssues`.
    return {
      briefFrozen: false,
      row: {
        ...base,
        pr: null,
        state: startClaim() ?? { kind: 'not_started' },
        round: null,
        phase: null,
        recordedPhase: null,
        minutesInPhase: null,
        phaseIsCurrent: null,
        lastConfidence: null,
        lastConfidenceUnread: false,
        phaseHistory: null,
        // A task whose brief is not frozen yet has no branch on the remote, so
        // no pull request to read and no pause to be waiting on either.
        prFacts: null,
        // A task whose brief is not frozen yet has no branch on the remote, so
        // no pull request to read and no pause to be waiting on either.
        pauseDisposition: null
      }
    }
  }
  const pr = findPrForRef(ref)
  const derived = deriveLoopState(root, ref.issue, undefined, startClaim)
  // O3: a pause holds the run whatever its driver did. `task run`'s watching
  // driver keeps its lock through a pause, so a pause whose driver was then
  // killed derives `exited` while its record still holds the run —
  // `deriveLoopState` reads the dead lock's exit trace before it looks at the
  // pause. So the row reads the SAME disposition `task_start` reads
  // (`resolvePauseDisposition`, ruling-aware), and when it names a live hold it
  // reports `paused` off the pause record rather than the `exited`/`no_driver`
  // the derivation alone would show — never `exited` for a run a pause still
  // holds. A live driver (`running`) and a start coming up (`starting`) are
  // already the truth and never a pause; a published round means the pause was
  // superseded, which the disposition reads as `none`.
  const disposition: PauseDisposition | null =
    derived.kind === 'running' || derived.kind === 'starting' ? null : resolvePauseDisposition(ref.issue, root)
  const held = disposition !== null && disposition !== 'none' ? readPauseState(root, ref.issue) : null
  const state: TaskLoopState =
    held !== null && derived.kind !== 'paused'
      ? { kind: 'paused', reason: held.reason, detail: held.detail, round: held.round }
      : derived
  const phase = readLoopPhase(root, ref.issue)
  // One read per pull request, and none at all for a row without one.
  const prRead = pr ? readPrFacts(pr.number) : null
  const confidence = readLastConfidence(
    root,
    ref.issue,
    state.kind === 'published' && pr
      ? {
          prNumber: pr.number,
          allowlist,
          // The facts read already fetched this pull request's comments, and the
          // summary this column wants is in them — so a published row costs ONE
          // forge read for both columns rather than two for the same payload.
          // Its own bounded, remembered reader is the fallback for a facts read
          // that failed or that the budget stopped.
          readComments: prRead ? commentsAlreadyRead(prRead.comments) : readComments
        }
      : null
  )
  const phaseIsCurrent = phase === null ? null : phaseIsCurrentFor(state, phase.recordedPhase)
  return {
    briefFrozen: true,
    row: {
      ...base,
      pr,
      state,
      round: phase?.round ?? null,
      phase: phase?.phase ?? null,
      recordedPhase: phase?.recordedPhase ?? null,
      minutesInPhase: phase?.minutesInPhase ?? null,
      phaseIsCurrent,
      lastConfidence: confidence.kind === 'confidence' ? confidence.confidence : null,
      lastConfidenceUnread: confidence.kind === 'unread',
      // A typical time answers "how long does THIS phase usually take" — a
      // question only a run actually in that phase is asking. A stopped run's
      // last recorded phase gets none, which is also what keeps the forge read
      // out of a listing where nothing is in flight.
      phaseHistory: phase !== null && phaseIsCurrent === true ? history(phase.recordedPhase) : null,
      prFacts: prRead === null ? null : prRead.facts,
      // The disposition is what a PAUSE is waiting for — carried only for a row
      // that reads `paused` (whether derived so or recovered from a killed
      // pause above), and already computed, never read twice.
      pauseDisposition: state.kind === 'paused' ? disposition : null
    }
  }
}

// --- command-facing entry points --------------------------------------

/** A row's own identity, the three fields every selector matches against. */
export type TaskStatusIdentity = { tranche: string; id: string; issue: number }

/**
 * Which task a status read is about: one named task, or (`null`) every open one.
 *
 * Structurally the same two shapes the task tools address a task by, so a caller
 * hands its own ref straight in rather than translating it.
 */
export type TaskStatusSelector = { tranche: string; id: string } | { issue: number } | null

/**
 * Does this identity answer that selector? The ONE rule every caller matches by
 * — the gather, which uses it to decide which refs are worth building, and the
 * task tools, which use it to pick the rows a call matched. An `{ issue }` ref
 * matches by Issue number alone, so a tranche task addressed by its own Issue
 * number still resolves; a `{ tranche, id }` ref matches a tranche row only,
 * since a backlog row's `tranche` is the literal `backlog`.
 */
export function taskStatusIdentityMatches(selector: NonNullable<TaskStatusSelector>, row: TaskStatusIdentity): boolean {
  return 'issue' in selector ? row.issue === selector.issue : row.tranche === selector.tranche && row.id === selector.id
}

/** The rows and the table rendered from them — returned together so the command prints what this reader rendered rather than calling a second boundary function of its own (`apps/cli/specs/surface.md`'s one-command-one-function discipline). */
export type TaskStatusListView = {
  rows: TaskStatusRow[]
  table: string[]
  /**
   * The Issues whose brief `task run`'s own preparation has already frozen.
   *
   * The fact behind "this task has been prepared or has a run", which
   * `resolveIssueForRef` gates `task_escalation_read`/`task_resume`/
   * `task_cancel` on. It rides on the VIEW rather than on `TaskStatusRow`
   * because `commands/task-status.ts` serializes a row verbatim into the
   * public `--json` envelope — a new row field would be a change to that
   * schema — while it destructures this view. And it cannot be inferred from
   * `state` any more: a planned task with an accepted start reads `starting`,
   * and so does a PREPARED one whose driver has not written its lock yet —
   * the same kind, opposite answers.
   */
  briefFrozenIssues: ReadonlySet<number>
}

/**
 * O1/O3, the entire read for the list form — the ONE function
 * `commands/task-status.ts` calls for it (`apps/cli/specs/surface.md`'s
 * one-command-one-function discipline; every smaller piece above stays
 * unexported and reachable only from here or `gatherSingleTaskStatus`,
 * same file, so it costs no extra boundary call there).
 *
 * The history read is made once for the whole list, lazily and at most once:
 * `phaseHistoryLookup` (`task-status-history.ts`) reads the forge only when a
 * row's phase actually has a history class, and caches a successful read for a
 * bounded lifetime — so a listing of ten tasks pays for it once, and a listing
 * in which nothing is in a comparable phase pays nothing at all.
 */
export function gatherTaskStatusList(
  selector: TaskStatusSelector = null,
  prFacts: PrFactsReadMode = 'read'
): TaskStatusListView {
  const allowlist = principalAllowlist()
  const root = runtimeDir()
  const history = phaseHistoryLookup(allowlist)
  const readComments = prCommentReaderForOneStatusRead()
  const claimDeps = claimDepsForOneRead()
  const readPrFacts = prFacts === 'read' ? prFactsReaderFor(allowlist) : noPrFactsRead
  const rows: TaskStatusRow[] = []
  const briefFrozenIssues = new Set<number>()
  let briefCandidates: Set<number> | null = null
  for (const ref of listOpenTaskIssues()) {
    // A named read builds ONLY the row it named — before any per-row read is
    // made, so the pull-request budget is spent on that row rather than on
    // whatever happened to list ahead of it. Filtering the rows AFTER building
    // them made the read-it-by-name remedy this file's own budget note promises
    // untrue: a named task listing sixth or later still read `not read` in every
    // pull-request column, with no way for an Operator to get them at all. It
    // also drops the forge cost of a named read from one Issue read per open task
    // to one.
    if (selector !== null && !taskStatusIdentityMatches(selector, rowIdentityFor(ref))) continue
    // A backlog ref is a candidate when the loop has already written it an
    // outbox directory (`hasOutboxDir`), when it was NAMED (the one read the
    // row costs anyway), or — in a full listing — when the one brief query
    // found it. A tranche-labeled ref carries no such gate: O4 lists every open
    // tranche task Issue, a not-yet-frozen (planned) one as `not started`.
    const unstartedBacklog = ref.kind === 'backlog' && !hasOutboxDir(root, ref.issue)
    if (unstartedBacklog && selector === null) {
      briefCandidates ??= listBriefCandidateIssues()
      if (!briefCandidates.has(ref.issue)) continue
    }
    let built: ReturnType<typeof buildRow>
    try {
      built = buildRow(ref, allowlist, history, readComments, claimDeps, readPrFacts)
    } catch (error) {
      // A search hit is only a candidate: one whose own read fails is not a
      // task this listing can show, and must not take the other rows with it.
      if (unstartedBacklog) continue
      throw error
    }
    // A backlog Issue with no frozen brief and no run is not a task: left out.
    if (unstartedBacklog && !built.briefFrozen) continue
    // Frozen but with no outbox directory and no start claim: nothing has run,
    // which is `not started`, not the `no driver` a vanished run reads as.
    if (unstartedBacklog && built.row.state.kind === 'no_driver') built.row.state = { kind: 'not_started' }
    rows.push(built.row)
    if (built.briefFrozen) briefFrozenIssues.add(built.row.issue)
  }
  return { rows, table: renderTaskStatusTable(rows), briefFrozenIssues }
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
      /** The same table the list form prints, one row wide — rendered here, for the same reason `TaskStatusListView` carries it. */
      table: string[]
      verdictLines: RoundVerdictLines | null
      resumeCommand: string | null
    }

/** O2's entire read for the single-task form — the ONE function `commands/task-status.ts` calls for it, same discipline as `gatherTaskStatusList`. O4: a planned task with no frozen brief reads as a `not_started` `ok` row here too, never the retired `no_brief` refusal. */
export function gatherSingleTaskStatus(tranche: string, id: string): SingleTaskStatus {
  const ref = listOpenTaskIssues().find((r) => r.kind === 'tranche' && r.tranche === tranche && r.id === id)
  if (!ref) return { kind: 'not_found' }

  const allowlist = principalAllowlist()
  const { row } = buildRow(
    ref,
    allowlist,
    phaseHistoryLookup(allowlist),
    prCommentReaderForOneStatusRead(),
    claimDepsForOneRead(),
    prFactsReaderFor(allowlist)
  )

  const root = runtimeDir()
  const verdictLines = lastRoundVerdictLines(root, ref.issue)
  const pause = readPauseState(root, ref.issue)
  const resumeCommand =
    row.state.kind === 'paused' && row.pr ? resumeCommandFor(row.pr.number, pause?.agent, pause?.model) : null
  return { kind: 'ok', row, table: renderTaskStatusTable([row]), verdictLines, resumeCommand }
}
