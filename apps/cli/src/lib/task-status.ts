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
  type StartRecord
} from './task-tools/start.js'
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
 * `renderTaskStatusTable`'s fixed-width rows and into the `task_status` state
 * string — the exact string the Operator doctrine keys its single action off.
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
 * A start claim is the LEAST authoritative signal here and is read last, on the
 * one path that used to end in `no_driver`: every state above it is backed by a
 * record of something that actually happened to a run — a live lock, a pause, a
 * published round, a driver that exited — while a claim only says a start was
 * accepted. So a live driver still reads `running` whatever a claim says, a
 * pause still reads `paused`, and the claim decides only where there was
 * otherwise nothing to read. `startClaim` is a thunk for that reason: the claim
 * directory is listed only when the read reaches it, so a running task pays
 * nothing for it.
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
  const claim = startClaim()
  if (claim === null) return { kind: 'no_driver' }
  // A driver lock is proof a driver appeared — but only for the run that wrote
  // it. A lock this claim POSTDATES belongs to an earlier run (the
  // SIGKILL/OOM/reboot case leaves one behind with no `driver_exited` trace to
  // read), and says nothing about a start accepted after it; `task run` clears
  // and rewrites that file only after its forge-bound brief render, so the old
  // one sits on disk for the whole window this state exists to describe.
  // A lock at or after the claim's own accepted-at IS this start's own driver,
  // or a later one: either way the driver appeared and the claim stops
  // speaking. An unreadable timestamp on either side takes the same silent
  // branch, since a comparison that cannot be made is not evidence for the
  // louder reading.
  // The claim's `startedAt` is the canonical spelling of the very instant its
  // record carries (`displayClaimTimestamp`), never a narrowed rendering of
  // the characters — so this compares the two records' times, not two display
  // strings, whatever shape the claim on disk spelled its own time in.
  if (lock && !claimPostdatesLock(claim.startedAt, lock.startedAt)) return { kind: 'no_driver' }
  return claim
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
  readComments: PrCommentReader
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
 * The stated file wins over the summary when both exist: it is the newer of
 * the two by construction (the summary is written at publish; a statement
 * still on disk has not been consumed since). The summary is read only for a
 * run that has PUBLISHED — the one state in which a summary exists at all —
 * so an in-flight row costs no extra forge call for this field.
 */
export function readLastConfidence(
  root: string,
  task: number,
  published: { prNumber: number; allowlist: readonly string[]; readComments: PrCommentReader } | null
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
    case 'starting':
      return `starting (start request ${state.requestId})`
    case 'start_did_not_come_up':
      return `start did not come up (start request ${state.requestId}, accepted ${state.startedAt})`
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
  if (unread) return 'not read'
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

function cellsFor(row: TaskStatusRow): string[] {
  return [
    `[${row.tranche}] ${row.id}`,
    `#${row.issue}`,
    row.pr ? `#${row.pr.number}` : NO_VALUE,
    renderStateText(row.state),
    row.round === null ? NO_VALUE : String(row.round),
    phaseCell(row),
    row.minutesInPhase === null ? NO_VALUE : `${row.minutesInPhase}m`,
    confidenceCell(row.lastConfidence, row.lastConfidenceUnread),
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

function buildRow(
  ref: TaskRef,
  allowlist: readonly string[],
  history: PhaseHistoryLookup,
  readComments: PrCommentReader,
  claimDeps: StartClaimDeps
): { row: TaskStatusRow; briefFrozen: boolean } {
  const started = hasFrozenBrief(ref.issue, allowlist)
  const root = runtimeDir()
  const base = {
    tranche: ref.kind === 'tranche' ? ref.tranche : 'backlog',
    id: ref.kind === 'tranche' ? ref.id : String(ref.issue),
    issue: ref.issue
  }
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
        phaseHistory: null
      }
    }
  }
  const pr = findPrForRef(ref)
  const state = deriveLoopState(root, ref.issue, undefined, startClaim)
  const phase = readLoopPhase(root, ref.issue)
  const confidence = readLastConfidence(
    root,
    ref.issue,
    state.kind === 'published' && pr ? { prNumber: pr.number, allowlist, readComments } : null
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
      phaseHistory: phase !== null && phaseIsCurrent === true ? history(phase.recordedPhase) : null
    }
  }
}

// --- command-facing entry points --------------------------------------

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
export function gatherTaskStatusList(): TaskStatusListView {
  const allowlist = principalAllowlist()
  const root = runtimeDir()
  const history = phaseHistoryLookup(allowlist)
  const readComments = prCommentReaderForOneStatusRead()
  const claimDeps = claimDepsForOneRead()
  const rows: TaskStatusRow[] = []
  const briefFrozenIssues = new Set<number>()
  for (const ref of listOpenTaskIssues()) {
    // A backlog ref only ever becomes a candidate once the loop has
    // already written it an outbox directory — see `hasOutboxDir`'s own doc
    // comment. A tranche-labeled ref carries no such gate: O4 lists every open
    // tranche task Issue, a not-yet-frozen (planned) one as `not started`.
    if (ref.kind === 'backlog' && !hasOutboxDir(root, ref.issue)) continue
    const built = buildRow(ref, allowlist, history, readComments, claimDeps)
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
    claimDepsForOneRead()
  )

  const root = runtimeDir()
  const verdictLines = lastRoundVerdictLines(root, ref.issue)
  const pause = readPauseState(root, ref.issue)
  const resumeCommand =
    row.state.kind === 'paused' && row.pr ? resumeCommandFor(row.pr.number, pause?.agent, pause?.model) : null
  return { kind: 'ok', row, table: renderTaskStatusTable([row]), verdictLines, resumeCommand }
}
