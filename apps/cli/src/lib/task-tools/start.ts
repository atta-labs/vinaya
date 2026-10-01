/**
 * `task_start` — the mutating handler that starts a run. It wraps the existing
 * `runTask` composition (`apps/cli/src/lib/task-run.ts`, `vinaya task run`) for
 * an explicitly selected, already-planned task, addressed either way a task is
 * addressed anywhere in this catalog — `{ tranche, id }` for a tranche task,
 * `{ issue }` for a standalone task Issue that carries no tranche label — and:
 *
 *   - requires an authenticated caller from the INVOCATION CONTEXT (the
 *     `CallerContext` the server resolved from its environment), and refuses
 *     with an `authority` error when that context is absent — MCP is a
 *     transport, not authorization, so the caller is never read from an
 *     argument (`server.ts`, `packages/aeg-core/src/task-tools.ts`).
 *   - refuses before claiming when the repository has no `dispatch.agent`
 *     configured (`precondition`) — this tool carries no agent input field of
 *     its own (that would be a catalog change, out of this task's surface),
 *     so it reads the SAME config the CLI's own `vinaya task run` command
 *     reads, and never launches a run that would exit on a missing `--agent`.
 *   - launches the SAME command the CLI already exposes for whichever address
 *     form was used: `task run <tranche> <id>` for a tranche task, `task run
 *     --issue <n>` for a standalone Issue — one launcher, one liveness
 *     confirmation, one `VINAYA_TASK_RUN_COMMAND` override, never a second
 *     launch path per form.
 *   - refuses (`precondition`) an `{ issue }` target that is not an open Issue,
 *     or that carries a `vinaya/tranche:*` label — the latter naming the
 *     tranche form to use instead. A task has exactly one address: accepting
 *     both for a tranche-labeled Issue would give it two request identities,
 *     and so two claims, and so two concurrent runs.
 *   - is idempotent per REQUEST IDENTITY — caller + repo + target + payload
 *     digest (`taskStartRequestIdentity`, `@attalabs/aeg-core`), with the
 *     address FORM folded into that identity, so `{ issue: 729 }` and a tranche
 *     ordinal resolving to Issue 729 can never share a claim. The repo
 *     component is the local checkout's git toplevel path (`repoRoot`,
 *     `../diff-evidence.js`), never a network-resolved GitHub owner/repo: a
 *     remote lookup can fail transiently and succeed on retry, which would
 *     silently change the identity between two calls meant to collapse into
 *     one run — the local path is synchronous and deterministic for the
 *     lifetime of this server process, so it can never do that, and it still
 *     tells two different checkouts on the same machine apart. The first call
 *     claims the identity in a durable store and launches; a second call with
 *     the same identity finds the claim and replays it — UNLESS the claim is
 *     old enough that its own launch must already have concluded one way or
 *     the other, and neither the process that launch spawned nor the task it
 *     names has a live pid, in which case it is superseded: released and
 *     re-claimed, and this call launches again (O3). A claim whose own
 *     launched process is still alive is never superseded, however old it
 *     is: that is a run whose preparation is taking longer than any wait,
 *     and relaunching it would put a second developer on one branch. Because the claim is written before the launch, a client
 *     that disconnects mid-call leaves at most one run — a reconnect replays
 *     the claim, it does not start again.
 *   - refuses (`precondition`) a task whose run is in a state another tool
 *     owns, naming that tool — and ONLY when that tool would really move it.
 *     A LIVE driver is `task_status`'s to watch. A PAUSED run is
 *     `task_resume`'s only while it is still asking for a decision. Two
 *     others are started here instead, because `task_resume` launches
 *     nothing for either (`PauseDisposition`): a pause already resolved as
 *     resume, for which it answers `already_resumed` — an ok result, not a
 *     refusal — and an in-bound infrastructure pause, which it refuses
 *     `authority` for want of a ruling nobody posts for an automatic
 *     hiccup. A pause resolved as cancel is continued by neither, and says
 *     so; so is one whose record this host cannot read. Every other state this tool
 *     starts — a task never dispatched, a run that EXITED (killed, crashed,
 *     ended by a signal, no pause written), and a published one — because
 *     `runTask` re-attaches to the task's own open pull request when no
 *     driver is live, so starting an exited run continues it rather than
 *     duplicating it. The state is read through the SAME `deriveLoopState`
 *     derivation `task_status` reports from, so the refusal and the state an
 *     Operator was just shown can never disagree; reading a raw pause record
 *     for the STATE would refuse a task that paused, resumed and published
 *     long ago, since a pause record is never cleared.
 *   - reports a start only once the launched run is CONFIRMED ALIVE: it
 *     resolves the task's forge Issue — a standalone target names its own
 *     Issue, a tranche target is resolved over the open tranche-labeled Issues,
 *     frozen or not — the same read `vinaya task run`'s own preparation uses
 *     to find an ordinal's Issue (`resolveOpenTaskIssueForRef`, beside
 *     `handlers.ts`'s frozen-brief-filtered `resolveIssueForRef`) — launches
 *     the run detached, and waits, bounded, for that Issue's own driver lock
 *     (`driver.pid.json`) to appear and name a live pid — the observable
 *     `devReviewLoop` itself produces once its entry gate clears, right after
 *     `runTask`'s own preparation step (which can take several seconds of
 *     forge calls, and can itself refuse — e.g. a checkout behind the default
 *     branch). Only a run that EXITS first — a missing `--agent` binary
 *     path, a refused preparation, an ENOENT on the launcher — is reported as
 *     a failed start, carrying that run's own captured stderr, and only then
 *     is the claim released so an identical retry launches again. A launch
 *     whose process is still alive when that bounded wait ends is a run whose
 *     preparation simply outlasted the wait, not a failed start: it is
 *     reported as started and KEEPS its claim, so the run that is coming up
 *     can never be launched a second time by a repeat call. Its confirmation
 *     arrives where confirmation is actually observable — the driver lock
 *     `task_status` reads on the next call.
 *
 * Attended mode only, the caller's own credentials: the detached run inherits
 * this server's environment, which in attended mode is the operator's own. There
 * is no unattended path and no attended bypass — an unattended start waits on
 * the worker-isolation boundary and a capability flag a later tranche adds
 * (`task_start`'s own catalog boundaries; `apps/cli/specs/self-hosting.md`,
 * `apps/cli/specs/loop.md`).
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  defaultControlStoreDeps,
  principalRulingMarker,
  readLoopState,
  readResolution,
  TaskStartInputSchema,
  type TaskResumeResult,
  type TaskStartResult,
  type TaskToolError,
  type TaskToolRef,
  taskStartRequestIdentity,
  taskToolError
} from '@attalabs/aeg-core'
import { loadConfig } from '../config.js'
import {
  type AgentVendor,
  captureSettledChildSnapshot,
  getProcessSnapshot,
  isAgentVendor,
  matchesCapturedIdentity,
  type ProcessSnapshot
} from '../dispatch.js'
import {
  escalationIdFor,
  isDriverPidAlive,
  pauseStatePath,
  readDriverLock,
  readEscalationRecord,
  readPauseState,
  rulingAuthenticatesResume
} from '../dev-review-loop/pause-resume.js'
import {
  fetchIssueRulings,
  fetchNewestIssueRulingOrdinal,
  fetchNewestRulingOrdinal,
  fetchRulings
} from '../dev-review-loop/developer-dispatch.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo, tasksExecutionRoot } from '../run-paths.js'
import { repoRoot as gitRepoRoot } from '../diff-evidence.js'
import {
  deriveLoopState,
  newestPublishedRound,
  readStartClaim,
  type TaskAddress,
  type TaskLoopState
} from '../task-status.js'
import { describeTaskRef, readTaskIssueFacts, resolveOpenTaskIssueForRef } from './handlers.js'
import type { TaskIssueFacts, TaskToolCallResult } from './handlers.js'
import { defaultTaskResumeHandler } from './resume.js'
import type { CallerContext } from './server.js'

/** The durable claim one `task_start` request writes before it launches — the record a duplicate start (same request identity) replays instead of starting again, unless the run it names is found dead and superseded. `target` is the address the call used, so a replay answers in the same form it was asked. */
export type StartRecord = {
  requestId: string
  caller: string
  target: TaskToolRef
  startedAt: string
  /** The pid of the process this claim's own launch spawned, recorded once the launch is known alive — absent on a claim written by a build that recorded none, and on one whose launch has not returned yet. It is what tells a still-preparing run (alive, no driver lock yet) apart from a dead claim, so the supersede path never relaunches a task that is already coming up. */
  pid?: number
  /** When this launch's own driver lock was observed alive inside the confirm wait — the moment the run this claim started stopped being a start still coming up. Absent on a claim whose wait ended first (a real, still-preparing launch) and on one written before this field existed. A claim carrying it is no longer evidence about a start at all: whatever the run did afterwards, its driver DID appear, and the records that run wrote are what describe it. */
  confirmedAt?: string
  /** `ps lstart` for {@link StartRecord.pid}, captured at the moment that pid joined this claim — `null` when the snapshot could not be read. Compared against a live re-read before the pid is ever trusted as this launch's own child, so an OS-recycled pid is not mistaken for a start still coming up. */
  childStartedAt?: string | null
  /** `ps comm` for {@link StartRecord.pid}, captured with {@link StartRecord.childStartedAt} and checked the same way. */
  childCommand?: string | null
}

/**
 * The idempotency store: an atomic claim keyed by request identity. `claim`
 * returns `{ claimed: true }` the first time an id is seen (the caller then
 * launches), and `{ claimed: false, record }` every time after (the caller
 * replays the recorded run, or — O3 — supersedes it first when it is dead).
 * Injectable so a fixture can observe claims without touching disk; the
 * default is a machine-local file store.
 */
export type RequestStore = {
  claim: (record: StartRecord) => { claimed: boolean; record: StartRecord }
  /** Rewrites a record this caller already claimed — how a launch's own child pid joins the claim it was launched under. Never creates a claim: a request identity nobody holds is left alone. */
  update: (record: StartRecord) => void
  release: (requestId: string) => void
}

/**
 * What launching a run and waiting for its own confirmation produced — three
 * outcomes, never two:
 *
 *   - `confirmed` — the run's driver lock appeared and named a live pid
 *     inside the bounded wait.
 *   - `starting` — the wait ended first and the launched process is STILL
 *     ALIVE. `task run` renders and posts the frozen brief and runs its
 *     start-of-run sweep before the loop writes that lock, so on a real
 *     repository a launch routinely outlasts any fixed wait. A live process
 *     is a run coming up, so this is a started run, not a failed one, and
 *     raising the wait would only move the same cliff.
 *   - `exited` — the process exited, or never spawned, before either. The
 *     ONLY outcome that is a failed start, and the only one whose claim is
 *     released.
 *
 * `pid` is the launched child's own pid, recorded on the claim so a later
 * call can re-check liveness against the process itself and not only against
 * a driver lock that a still-preparing run has not written yet.
 */
export type LaunchResult =
  | { status: 'confirmed'; pid: number | null }
  | { status: 'starting'; pid: number | null }
  | { status: 'exited'; error: Error }

export type TaskStartDeps = {
  /** The local checkout's stable identity for the request-identity computation — never network-resolved, see this file's own header. */
  repoRoot: () => string | null
  store: RequestStore
  /** The repository's configured launch agent, or `null` when none is set — see this file's own header on why this tool reads config rather than accepting an agent field. */
  agent: () => AgentVendor | null
  /** A target → its Issue. `{ issue }` names its own; `{tranche, id}` resolves over the open tranche-labeled Issues, frozen or not — the SAME resolution `vinaya task run` preparation performs for an ordinal (`handlers.ts`'s `resolveOpenTaskIssueForRef`), NOT the frozen-brief-filtered `resolveIssueForRef` `task_status`/`task_resume` use. `null` when no open task matches. */
  resolveIssue: (ref: TaskToolRef) => number | null
  /** What the forge says about a standalone `{ issue }` target — open, and which tranche (if any) claims it. Read ONLY for that form: a tranche target's own resolution already proves its Issue is open and labeled. */
  issueFacts: (issue: number) => TaskIssueFacts
  /** Is a live driver currently running this Issue? The SAME observable (`driver.pid.json`) a fresh launch is confirmed against. */
  isRunAlive: (issue: number) => boolean
  /**
   * The task's current loop state, read through the SAME derivation
   * `task_status` reports from (`deriveLoopState`, `../task-status.js`) —
   * never a raw pause-record read, which is never cleared on resume and so
   * would refuse a task that paused and published long ago. It is what decides
   * whether this start belongs to another tool.
   *
   * Takes the REF as well as the Issue: a start claim written against a
   * tranche ordinal names that ordinal, not the Issue number, so a read that
   * passed no address could never match a claim for the address form every
   * tranche task uses — and the gate's own `starting` refusal would then be
   * dead code for exactly the tasks it exists to protect.
   *
   * And the calling request's OWN identity, which the reading excludes: this
   * call's claim is on disk before any state is read, so a read that counted
   * it would find a start coming up for every start — this one — and refuse
   * every launch as a duplicate of itself.
   */
  loopState: (issue: number, ref: TaskToolRef, ownRequestId: string) => TaskLoopState
  /** For a paused task, what that pause is waiting for — read from the same records the continuation reads, so this gate never names a tool that would not move the run. See `PauseDisposition`. */
  pauseDisposition: (issue: number) => PauseDisposition
  /** The agent a held run was dispatched with, from its own pause record — `null` when there is no pause record or it names none. What a CONTINUATION must be relaunched under; the loop refuses any other. */
  heldAgent: (issue: number) => AgentVendor | null
  /**
   * O1: the `task_resume` handler, to which this tool HANDS a `ruled` pause —
   * one a Principal ruling already posted authorizes. Delegating rather than
   * relaunching through {@link TaskStartDeps.launch} is deliberate: it records
   * the SAME resolution and emits the SAME `operation: task_resume` Log event a
   * resume records, and re-applies the SAME ordinal-freshness check (the loop's
   * own `--resume` entry checks ruling PRESENCE but not freshness), so a
   * continuation `task_start` takes can never bypass an authentication
   * `task_resume` makes. Injectable so a fixture asserts the hand-off without a
   * second handler; the default is the bound `task_resume` handler.
   */
  resume: (input: { task: TaskToolRef }, ctx: CallerContext) => Promise<TaskToolCallResult<TaskResumeResult>>
  /** O2: where a ruling for a still-`awaiting_ruling` pause goes and the ordinal it must carry — read ONLY to build that refusal, so it names the place, the marker and the command. `null` when this host could not resolve it. */
  rulingPlacement: (issue: number) => RulingPlacement | null
  /** Is this pid still running? Asked of the pid a claim's own launch recorded — the one liveness signal that exists BEFORE a driver lock does, and so the one that tells a still-preparing run apart from a dead claim. */
  isPidAlive: (pid: number) => boolean
  /** A live re-read of a pid's own identity, for {@link claimLaunchIsAlive} — what keeps a recycled pid from reading as this launch's child. `null` when no process answers at that pid. */
  processSnapshot: (pid: number) => ProcessSnapshot | null
  /**
   * The identity RECORDED on a claim when its launch reports alive — the
   * settling read, never the plain one. A vendor CLI installed behind a
   * `#!/usr/bin/env node` shebang performs a second, user-space `execve`, so
   * `comm` read too early captures `env`'s own identity rather than the image
   * that survives; a capture taken mid-exec-chain can never match a later
   * re-read, and `claimLaunchIsAlive` would then call a live launch gone and
   * let the supersede path start a second one. `dispatch.ts` added this read
   * for exactly that spawn-then-capture shape, and `task-run-background.ts`
   * already uses it on the same one.
   */
  captureChildSnapshot: (pid: number) => ProcessSnapshot | null
  /** Drops the claims this machine can prove are dead, before this call writes another one — see {@link pruneDeadStartClaims}. A write path is the only place that may delete a claim, and this is the only one that ever creates one. */
  pruneClaims: () => void
  /**
   * Starts the run detached and resolves once its own driver lock confirms it
   * alive, or it exits/errors first, or the bounded wait ends with the process
   * still alive — never by sleeping and assuming. The claim this call already
   * wrote is kept for either live outcome and released by the caller only for
   * an exited one, so a later call never inherits a claim under a live run,
   * and never inherits a claim under a dead one.
   */
  launch: (
    target: { ref: TaskToolRef; agent: AgentVendor; issue: number },
    meta: { requestId: string; caller: string }
  ) => Promise<LaunchResult>
  now: () => string
}

// --- default durable file store ---------------------------------------------

/**
 * `.../unscoped/control/start-request-<requestId>.json` — the request
 * identity already folds in caller, repo and target, so a flat per-id file
 * is unambiguous.
 *
 * The UNSCOPED folder, deliberately: a start request names a tranche and an
 * ordinal, not a forge Issue, so at claim time there is no task number to
 * key a folder by — resolving one is the very thing the launch it claims
 * goes on to do. The scope grammar already reserves this folder for exactly
 * that case (`run-paths.ts`'s `RunScope`), so the record stays inside the
 * layout instead of keeping a machine-wide directory of its own. Owner-only,
 * same hardening posture as `dispatch.ts`'s own machine-local records.
 */
const START_RECORD_PREFIX = 'start-request-'
const START_RECORD_SUFFIX = '.json'

/**
 * A request identity is a hex digest (`taskStartRequestIdentity`), and this
 * store turns one straight into a FILE NAME — so nothing else may ever be
 * treated as one. Every caller that could reach a path with it goes through
 * this predicate: `startRecordPath` itself, the parser that reads an identity
 * out of a claim's own CONTENTS, and `release`, which passes one to `rmSync`.
 * Without it a claim body carrying `../../..` would delete a file outside the
 * control folder, and a reader that parses every file in that folder is
 * exactly what widens who can put a string there.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/

export function isSafeRequestId(value: string): boolean {
  return SAFE_REQUEST_ID.test(value)
}

function startRecordPath(requestId: string, root: string = runtimeDirForThisRepo()): string {
  if (!isSafeRequestId(requestId)) {
    throw new Error(`task_start: refusing to build a claim path from an unsafe request identity: ${requestId}`)
  }
  return runPath(root, 'unscoped', {
    area: 'control',
    file: `${START_RECORD_PREFIX}${requestId}${START_RECORD_SUFFIX}`
  })
}

/** The request identity a claim file's own name carries, or `null` for a file this store never wrote — the inverse of `startRecordPath`'s naming, kept beside it so the two can never disagree about the shape. */
function requestIdFromRecordFilename(name: string): string | null {
  if (!name.startsWith(START_RECORD_PREFIX) || !name.endsWith(START_RECORD_SUFFIX)) return null
  const requestId = name.slice(START_RECORD_PREFIX.length, name.length - START_RECORD_SUFFIX.length)
  return isSafeRequestId(requestId) ? requestId : null
}

/**
 * The most a single claim file may weigh before this reader will parse it.
 *
 * A claim is a handful of short fields; anything larger is not one, and
 * reading it into memory just to fail to parse is the cost a reader that
 * enumerates a whole folder should not pay. Generous by orders of magnitude
 * against a real record.
 */
const MAX_CLAIM_FILE_BYTES = 64 * 1024

/**
 * Every start claim this machine currently holds — read through the SAME path
 * builder and the SAME parser the store above writes and replays them with, so
 * the claim layout stays known in exactly one place. A reader that listed the
 * control directory and parsed the JSON itself would be a second copy of that
 * layout, free to drift from this one (as a flat effect-record glob once drifted
 * from the control store's own `effect/` layout).
 *
 * This is the one read that must enumerate: a claim is keyed by request
 * identity — caller, repo, target and payload digest, hashed — so a reader
 * holding a task number has no path to derive. `root` defaults to this repo's
 * own runtime directory and is overridable so a fixture reads a temp tree.
 *
 * A file that does not parse, or parses to neither record shape, is skipped
 * rather than raised: to a reader an unreadable claim is no claim at all, the
 * same reading `claim`'s own replay path already takes.
 *
 * Two things are checked before the read, and both are about this folder being
 * a wider input surface than the writer that fills it:
 *
 *   - It must be a REGULAR file. `statSync` follows a symlink and reports `0`
 *     for a FIFO or a character device, so the size bound below passed exactly
 *     the inputs that hurt: reading a FIFO blocks with no timeout — hanging
 *     the whole synchronous status read, and with it `task_status` — and a
 *     symlink to `/dev/zero` allocates until the process dies. `lstatSync`
 *     does not follow, and anything that is not a plain file is not a claim.
 *   - Its CONTENTS must name the identity its NAME does. The identity in the
 *     body reaches a path — `release` and `pruneDeadStartClaims` both hand one
 *     to `rmSync` — so a body naming a different identity would delete another
 *     claim's file, possibly a live one, and leave the file it was read from
 *     in place to do it again on the next pass. The writer only ever puts a
 *     record at its own identity's path, so this rejects nothing this store
 *     wrote, and it is what makes `startRecordPath(record.requestId)` provably
 *     the file each record came from.
 */
export function readStartClaims(root: string = runtimeDirForThisRepo()): StartRecord[] {
  let entries: string[]
  try {
    entries = readdirSync(runPath(root, 'unscoped', { area: 'control' }))
  } catch {
    return []
  }
  const records: StartRecord[] = []
  for (const name of entries) {
    const requestId = requestIdFromRecordFilename(name)
    if (requestId === null) continue
    try {
      const path = startRecordPath(requestId, root)
      const entry = lstatSync(path)
      if (!entry.isFile() || entry.size > MAX_CLAIM_FILE_BYTES) continue
      const record = normalizeStartRecord(JSON.parse(readFileSync(path, 'utf8')))
      if (record !== null && record.requestId === requestId) records.push(record)
    } catch {
      // Unreadable or malformed — see this function's own doc comment.
    }
  }
  return records
}

/**
 * Deletes the claims this machine can prove are dead, and answers how many.
 *
 * A claim is only ever released by a failed launch or the supersede path, so
 * the folder otherwise grows by one file per distinct start request for the
 * life of the checkout — and every status read that reaches a claim parses all
 * of them. Called from the start handler (a write path already, and the only
 * place a claim is ever created), so a read never deletes.
 *
 * "Dead" here is strictly weaker than the supersede path's own test and is
 * never the claim this call is about to write: past
 * `START_CLAIM_REPORTING_WINDOW_MS` — so past the stale grace too — with no
 * live launch behind it. A claim that far gone already reports nothing and is
 * already supersedable; removing the file only saves the next reader from
 * parsing it. A claim whose own accepted-at cannot be aged at all is past
 * that window by {@link claimIsPastReporting}'s own reading, which is what
 * keeps the one record no bound can hold from accumulating here forever.
 *
 * The path deleted is rebuilt from the record's identity, and that is the file
 * it was read from: `readStartClaims` skips any claim whose contents name an
 * identity other than the one its file name carries, so the two cannot differ.
 */
export function pruneDeadStartClaims(
  root: string = runtimeDirForThisRepo(),
  now: () => string = () => new Date().toISOString(),
  isPidAlive: (pid: number) => boolean = isDriverPidAlive,
  snapshotOf: (pid: number) => ProcessSnapshot | null = getProcessSnapshot
): number {
  let pruned = 0
  for (const record of readStartClaims(root)) {
    if (!claimIsPastReporting(record, now)) continue
    if (claimLaunchIsAlive(record, isPidAlive, snapshotOf)) continue
    try {
      rmSync(startRecordPath(record.requestId, root), { force: true })
      pruned += 1
    } catch {
      // Best-effort: a claim that will not delete only costs the next read its
      // own parse, exactly as before this pruning existed.
    }
  }
  return pruned
}

/**
 * A record read back off disk, in either shape it has ever been written: the
 * current `{ target }` one, or the flat `{ tranche, id }` one written before a
 * standalone Issue was startable. The migration is not hypothetical — a tranche
 * target's request identity is deliberately unchanged by that widening
 * (`taskStartRequestIdentity`), so a claim an older build wrote is found at the
 * very same path by this one, and reading it as a `{ target }` record would
 * leave `target` undefined: a replay answering with no run identity at all, and
 * a stale-claim check resolving nothing. `null` for anything that is neither
 * shape, which the caller treats as "no readable record" rather than trusting it.
 */
export function normalizeStartRecord(parsed: unknown): StartRecord | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  if (typeof raw.requestId !== 'string' || typeof raw.caller !== 'string' || typeof raw.startedAt !== 'string') {
    return null
  }
  // The identity in a claim's own CONTENTS reaches a path — `release` hands it
  // to `rmSync` — so a body carrying a traversal sequence is not a record this
  // store will read back at all. See `isSafeRequestId`.
  if (!isSafeRequestId(raw.requestId)) return null
  // A pid is only usable as a liveness signal when it names a process: `0` and
  // any negative value address a process GROUP in `process.kill`, which answers
  // alive unconditionally and would pin a claim to "still coming up" forever.
  // Rejected here, in the store's own parser, so the reader and the supersede
  // path are both fixed by one predicate rather than each guarding separately.
  const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? { pid: raw.pid } : {}
  const confirmedAt = typeof raw.confirmedAt === 'string' ? { confirmedAt: raw.confirmedAt } : {}
  const childStartedAt =
    typeof raw.childStartedAt === 'string' || raw.childStartedAt === null ? { childStartedAt: raw.childStartedAt } : {}
  const childCommand =
    typeof raw.childCommand === 'string' || raw.childCommand === null ? { childCommand: raw.childCommand } : {}
  const base = {
    requestId: raw.requestId,
    caller: raw.caller,
    startedAt: raw.startedAt,
    ...pid,
    ...confirmedAt,
    ...childStartedAt,
    ...childCommand
  }
  const target = raw.target
  if (target !== null && typeof target === 'object') {
    const ref = target as Record<string, unknown>
    if (typeof ref.tranche === 'string' && typeof ref.id === 'string') {
      return { ...base, target: { tranche: ref.tranche, id: ref.id } }
    }
    if (typeof ref.issue === 'number') return { ...base, target: { issue: ref.issue } }
    return null
  }
  if (typeof raw.tranche === 'string' && typeof raw.id === 'string') {
    return { ...base, target: { tranche: raw.tranche, id: raw.id } }
  }
  return null
}

export const defaultRequestStore: RequestStore = {
  claim(record) {
    const path = startRecordPath(record.requestId)
    try {
      ensureRunDir(dirname(path), runtimeDirForThisRepo())
      // `wx` is the atomic claim: it creates the file only if it does not exist,
      // so two racing starts for the same identity cannot both succeed here.
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      return { claimed: true, record }
    } catch {
      // Already claimed (EEXIST) — read the record back and replay it. A read
      // that itself fails degrades to the record we were handed, never a second
      // launch: the safe direction is always "do not start twice."
      try {
        const existing = normalizeStartRecord(JSON.parse(readFileSync(path, 'utf8')))
        return { claimed: false, record: existing ?? record }
      } catch {
        return { claimed: false, record }
      }
    }
  },
  update(record) {
    const path = startRecordPath(record.requestId)
    try {
      // `r+` writes only an EXISTING file: a record this call does not already
      // hold is never conjured into a claim by an update, and a release that
      // raced this write is not undone by it.
      const fd = openSync(path, 'r+')
      try {
        const body = `${JSON.stringify(record, null, 2)}\n`
        writeFileSync(fd, body)
        ftruncateSync(fd, Buffer.byteLength(body))
      } finally {
        closeSync(fd)
      }
    } catch {
      // Best-effort: a pid that fails to land only costs the supersede path
      // its extra liveness signal, it never starts a run twice.
    }
  },
  release(requestId) {
    // Best-effort: only removed when a launch failed, or O3 superseded a
    // dead claim, so a genuine retry can reclaim the identity. Never throws —
    // a stale record only ever refuses a retry, it never starts a run twice.
    try {
      rmSync(startRecordPath(requestId), { force: true })
    } catch {
      // ignore
    }
  }
}

// --- O3: a claim old enough that its own launch must have concluded --------

/**
 * `defaultLaunch`'s own bounded confirm-wait, below, plus a margin for the
 * claim write and the JSON round trip either side of it — long enough that a
 * record still younger than this can only be one call's own launch still in
 * flight, never a candidate for O3's supersede path. Superseding a claim
 * that young would race the very call that owns it: it may not have written
 * its driver lock yet, and is not thereby dead.
 */
export const START_CONFIRM_TIMEOUT_MS = 30_000
const START_CONFIRM_POLL_MS = 250
export const START_STALE_CLAIM_GRACE_MS = START_CONFIRM_TIMEOUT_MS + 15_000

/**
 * The Issue a start will be confirmed against, or the refusal that stops it
 * before any launch. A tranche target resolves over the open tranche-labeled
 * Issues, exactly as `task run` preparation does, and an ordinal that names no
 * open task Issue is refused. A standalone target NAMES its Issue, so there is
 * nothing to resolve — instead the number itself is checked: it must be an open
 * Issue, and it must carry no `vinaya/tranche:*` label, because a tranche task
 * already has an address of its own and accepting a second one for it would
 * split its claims between two request identities.
 */
function resolveStartTarget(
  ref: TaskToolRef,
  deps: TaskStartDeps
): { ok: true; issue: number } | { ok: false; error: TaskToolError } {
  if (!('issue' in ref)) {
    const issue = deps.resolveIssue(ref)
    if (issue === null) {
      return {
        ok: false,
        error: taskToolError(
          'infrastructure',
          `task_start: ${ref.tranche}/${ref.id} has no resolvable Issue to confirm a launch against — refusing to start blind.`
        )
      }
    }
    return { ok: true, issue }
  }

  const facts = deps.issueFacts(ref.issue)
  if (facts.kind === 'not_found') {
    return {
      ok: false,
      error: taskToolError('precondition', `task_start: Issue #${ref.issue} does not exist — nothing to start.`)
    }
  }
  if (facts.kind === 'unreadable') {
    return {
      ok: false,
      error: taskToolError(
        'infrastructure',
        `task_start: Issue #${ref.issue} could not be read, so this start cannot be confirmed against it: ${facts.detail}`,
        facts.detail
      )
    }
  }
  if (!facts.open) {
    return {
      ok: false,
      error: taskToolError(
        'precondition',
        `task_start: Issue #${ref.issue} is closed — only an open task Issue can be started.`
      )
    }
  }
  if (facts.tranche !== null) {
    return {
      ok: false,
      error: taskToolError(
        'precondition',
        `task_start: Issue #${ref.issue} belongs to tranche \`${facts.tranche}\`, which addresses it as { tranche, id } — start it that way instead. A task has one address: starting it by Issue number too would give it a second request identity, and so a second claim.`
      )
    }
  }
  return { ok: true, issue: ref.issue }
}

/**
 * The loop's own `MAX_INFRASTRUCTURE_RETRIES`, restated rather than imported.
 *
 * Importing it would pull the loop's round-assessment module into this one's
 * import graph, and the pre-push selector walks that graph at `depth: 'one'`
 * to decide which tests a change runs: the extra edge pushed three pinned
 * reference change-sets past their own time budget
 * (`test-selector.test.ts`). A restated literal is only safe if it cannot
 * drift, so it does not rest on care — `operator-state-actions.test.ts`
 * asserts this equals the loop's own constant, and a change to either side
 * alone fails there.
 */
export const INFRASTRUCTURE_RETRY_BOUND = 5

/**
 * What a paused run is actually waiting for — the fact that decides whether
 * `task_resume` can move it, or whether this tool is the one that can.
 *
 *   - `awaiting_ruling` — a pause nobody has decided yet, and no ruling
 *     authenticating one is posted where this pause's comment went.
 *     `task_resume`'s case: it waits for the Principal to post a ruling, then
 *     authenticates and continues from it.
 *   - `ruled` — a pause whose decision is NOT yet consumed into a resolution
 *     record, but a Principal ruling NEWER than the one this escalation was
 *     raised under is already posted where its comment went (the pull request,
 *     or the Issue when there is none). The authentication `task_resume` would
 *     perform has, in effect, already passed — so `task_start` finishes what
 *     that posted ruling authorizes, by handing the continuation to the
 *     `task_resume` handler itself (reusing its exact check, resolution write
 *     and Log event, never a second copy). Computed by `resolvePauseDisposition`
 *     only — `defaultPauseDisposition` never reads the forge and never returns
 *     it, so an `awaiting_ruling` with no ruling-aware reader stays that.
 *   - `resolved_resume` — a ruling was already given and consumed into a
 *     resolution record, and the continuing driver then died. `task_resume`
 *     answers `already_resumed` and launches nothing — an ok result, not a
 *     refusal; `runTask`'s own replayed-resolution recovery re-attaches and
 *     carries on.
 *   - `resolved_cancel` — the run was stopped on a Principal decision.
 *     Neither tool continues it, and neither should.
 *   - `self_resuming` — a recoverable infrastructure hiccup, self-resuming
 *     only INSIDE the loop's retry bound, which this reader computes the
 *     loop's way. At or past that bound the pause reads `awaiting_ruling`.
 *     Inside it, `task_resume` has no such waiver and refuses `authority`
 *     for a ruling nobody posts for an automatic hiccup, so this tool is the
 *     one that moves it.
 *   - `unreadable` — a pause record or a resolution that could not be read
 *     or did not parse. Not the same as "no decision recorded": we do not
 *     know whose the run is, so the gate refuses rather than guessing, and
 *     says what it could not read.
 *   - `none` — no pause holding this run: no pause record at all, or one a
 *     later published round has already superseded.
 */

export type PauseDisposition =
  | 'awaiting_ruling'
  | 'ruled'
  | 'resolved_resume'
  | 'resolved_cancel'
  | 'self_resuming'
  | 'unreadable'
  | 'none'

/**
 * Reads the disposition from the SAME two records the continuation itself
 * reads — the pause record and the escalation's resolution — so this gate
 * and the tool it redirects to can never disagree about who owns a pause.
 * `root` defaults to this repo's own resolution and is overridable so a test
 * can drive every disposition off real records in a temporary tree, exactly
 * as `defaultLaunch` below takes its own root.
 *
 * The `infrastructure` reason self-resumes only INSIDE the loop's own retry
 * bound, computed the same way the loop computes it — the control store's
 * recorded count floored against the one the pause record carries, and a
 * control-store record that will not parse counted as past the bound. An
 * earlier version took the reason at face value and left the bound to the
 * loop, on the reasoning that the loop would refuse a past-bound resume
 * itself. It does not, reliably: past the bound the loop falls through to a
 * gate that refuses only when the pull request carries NO ruling comment at
 * all, with none of the ordinal-freshness check `task_resume` applies, so
 * any older ruling still sitting on the pull request would have
 * authenticated a continuation past the very bound the loop's own message
 * says needs a fresh one. At or past the bound this reads
 * `awaiting_ruling`, which is the truth: a ruling is owed, and
 * `task_resume` is the tool that authenticates one.
 */
export function defaultPauseDisposition(issue: number, root: string = runtimeDirForThisRepo()): PauseDisposition {
  try {
    // "No pause record" and "a pause record that will not parse" are the
    // same `null` from `readPauseState`, and they must not be the same
    // answer here: `writePauseState` is a plain non-atomic write, so a kill
    // or a full disk mid-write — the very crash this gate exists for — can
    // leave a truncated record, and reading that as `none` would launch
    // straight past a hold, as a FRESH dispatch rather than a resume, since
    // `runTask`'s own `hasPauseState` reads the identical null. So the file's
    // own existence is checked first, separately from its contents.
    if (!existsSync(pauseStatePath(root, issue))) return 'none'
    const held = readPauseState(root, issue)
    if (held === null) return 'unreadable'
    // A pause record is never cleared on resume, so one naming a round the
    // control store has since published past is history, not a hold — the SAME
    // supersede rule `deriveLoopState` applies before it will report
    // `paused` at all. Without it, reading the record directly (which the
    // gate must, see below) would refuse a task that paused, resumed and
    // published rounds ago.
    const published = newestPublishedRound(root, issue)
    if (published !== null && held.round <= published) return 'none'

    const csDeps = defaultControlStoreDeps(() => tasksExecutionRoot(root))
    const escalationId = held.escalationId ?? escalationIdFor(issue, held.round, held.head)
    const resolution = readResolution(csDeps, issue, escalationId)
    // `absent` is a real answer — nobody has decided yet. `corrupt` is not:
    // a resolution that will not parse might be the `cancel` this gate
    // exists to protect, so it is never read as "no decision recorded".
    if (resolution.status === 'corrupt') return 'unreadable'
    if (resolution.status === 'ok') {
      return resolution.value.decision === 'cancel' ? 'resolved_cancel' : 'resolved_resume'
    }
    // `infrastructure` alone, deliberately: it is the one reason the loop's
    // own gate continues without a ruling. `stale_driver` reads as a
    // bounded automatic retry in the loop's watcher, but its bare-resume
    // gate still demands a ruling for it, so classing it self-resuming here
    // would launch a run the loop then refuses. Awaiting a ruling is the
    // truthful answer for it, and `task_resume` does move it once one is
    // posted.
    if (held.reason !== 'infrastructure') return 'awaiting_ruling'
    // …and only inside the loop's own bound, computed its way: the control
    // store's recorded count floored against the one this pause carries, a
    // record that will not parse counted as past the bound.
    const recorded = readLoopState(csDeps, issue)
    const storeRetries =
      recorded.status === 'ok'
        ? recorded.value.budgets.infrastructureRetries
        : recorded.status === 'corrupt'
          ? Number.POSITIVE_INFINITY
          : 0
    const retriesSoFar = Math.max(storeRetries, held.infrastructureRetries ?? 0)
    return retriesSoFar < INFRASTRUCTURE_RETRY_BOUND ? 'self_resuming' : 'awaiting_ruling'
  } catch {
    // Every read above can throw on a real filesystem error (`readIfExists`
    // rethrows anything that is not ENOENT). Throwing out of here would
    // escape the handler with its start claim already written and nothing
    // launched, so every identical retry inside the stale window would
    // replay `started: false` for a run that never began. Refusing is the
    // answer that keeps the claim releasable and tells the Operator the
    // truth.
    return 'unreadable'
  }
}

/**
 * The agent a held run was dispatched with, read off its own pause record —
 * the same field `task_resume` resolves its continuation's agent from, so
 * the two continuations of one paused run can never disagree about which
 * agent it belongs to. `null` for no pause record, one that will not parse,
 * or one recording no agent (a legacy pause), each of which the loop
 * tolerates by falling back to the agent it is handed.
 */
export function defaultHeldAgent(issue: number, root: string = runtimeDirForThisRepo()): AgentVendor | null {
  try {
    const held = readPauseState(root, issue)
    if (held?.agent === undefined) return null
    return isAgentVendor(held.agent) ? held.agent : null
  } catch {
    return null
  }
}

// --- the ruling-aware disposition: awaiting_ruling → ruled ------------------

/**
 * The forge reads the ruling-aware disposition needs — the SAME four readers
 * `task_resume` authenticates a continuation through (`developer-dispatch.ts`),
 * so the `ruled` this computes and the resume that then continues read the
 * ruling off the same source under the same principal allowlist. Injectable so
 * a fixture drives `ruled`/`awaiting_ruling` with no `gh` on `PATH`.
 */
export type PauseRulingDeps = {
  fetchRulings: (pr: number) => string[]
  fetchNewestRulingOrdinal: (pr: number) => number
  fetchIssueRulings: (issue: number) => string[]
  fetchNewestIssueRulingOrdinal: (issue: number) => number
}

export const defaultPauseRulingDeps: PauseRulingDeps = {
  fetchRulings,
  fetchNewestRulingOrdinal,
  fetchIssueRulings,
  fetchNewestIssueRulingOrdinal
}

/**
 * Where a ruling for this pause goes, and the ordinal the next one must carry —
 * everything the refusal for a still-unruled pause names so the Planner can
 * post it without looking anything up (O2). `pr` is the pull request the pause
 * posted its comment on, or `null` when it paused before one existed and the
 * ruling goes on the Issue; `nextOrdinal` is one past the newest ruling already
 * posted there, the `<k>` the marker must carry to postdate this pause's own.
 */
export type RulingPlacement = {
  pr: number | null
  issue: number
  nextOrdinal: number
}

type RulingAssessment = { authenticated: boolean; placement: RulingPlacement }

/**
 * Reads the pause and its escalation record, then the ruling posted where that
 * pause's comment went — once, so the disposition upgrade and the refusal's own
 * placement are the SAME reading. `null` when there is no pause or no durable
 * escalation to compare a ruling against, which is never read as authenticated:
 * a pause this host cannot bind a ruling to is one `task_resume` would refuse
 * too. A non-positive `prNumber` is the pre-pull-request sentinel, normalized to
 * `null` the same way every other reader of this record normalizes it.
 */
function assessPostedRuling(issue: number, root: string, deps: PauseRulingDeps): RulingAssessment | null {
  const held = readPauseState(root, issue)
  if (held === null) return null
  const pr = typeof held.prNumber === 'number' && held.prNumber > 0 ? held.prNumber : null
  const csDeps = defaultControlStoreDeps(() => tasksExecutionRoot(root))
  const escalationId = held.escalationId ?? escalationIdFor(issue, held.round, held.head)
  const escalation = readEscalationRecord(issue, escalationId, csDeps)
  if (escalation === null) return null
  const rulings = pr === null ? deps.fetchIssueRulings(issue) : deps.fetchRulings(pr)
  const newestOrdinal = pr === null ? deps.fetchNewestIssueRulingOrdinal(issue) : deps.fetchNewestRulingOrdinal(pr)
  return {
    authenticated: rulingAuthenticatesResume(rulings.length, newestOrdinal, escalation.rulingOrdinal),
    placement: { pr, issue, nextOrdinal: newestOrdinal + 1 }
  }
}

/**
 * The ONE disposition `task_start` and `task_status` both read (the brief's
 * "one disposition shared by two readers"): `defaultPauseDisposition`'s
 * pure-local answer, with the one case that hangs on the forge resolved —
 * `awaiting_ruling` becomes `ruled` when a Principal ruling that postdates this
 * pause is already posted (the exact check `task_resume` makes, reused). Every
 * other disposition is returned unchanged and makes no forge read at all, so
 * only a genuinely undecided pause pays for the ruling read.
 *
 * A forge read that throws never UPGRADES a pause to `ruled`: the safe
 * direction is always to keep waiting for a ruling this host can confirm, so a
 * read failure reads as `awaiting_ruling`, exactly the refusal `task_resume`
 * would give.
 */
export function resolvePauseDisposition(
  issue: number,
  root: string = runtimeDirForThisRepo(),
  deps: PauseRulingDeps = defaultPauseRulingDeps
): PauseDisposition {
  const base = defaultPauseDisposition(issue, root)
  if (base !== 'awaiting_ruling') return base
  try {
    return assessPostedRuling(issue, root, deps)?.authenticated ? 'ruled' : 'awaiting_ruling'
  } catch {
    return 'awaiting_ruling'
  }
}

/** Where the Planner posts the ruling that would unblock a still-awaiting pause (O2) — `null` when there is no pause or no escalation to place it against. */
export function defaultRulingPlacement(
  issue: number,
  root: string = runtimeDirForThisRepo(),
  deps: PauseRulingDeps = defaultPauseRulingDeps
): RulingPlacement | null {
  try {
    return assessPostedRuling(issue, root, deps)?.placement ?? null
  } catch {
    return null
  }
}

/**
 * The one state gate: is this task's run another tool's to act on?
 *
 * `null` means `task_start` owns this state and may launch. A refusal names
 * the tool that does own it, so an Operator handed one is never left without
 * a next action — the failure this gate exists to close was a state with NO
 * working tool at all, and a refusal that names none recreates it.
 *
 * A live driver and a start still coming up are the two refusals the derived
 * STATE decides — a run that exists, and a run being brought into existence.
 * `starting` is the only signal there is in the window before a driver lock:
 * the claim behind it makes this call's own REQUEST idempotent, but a start
 * from another caller, or for the same task under a different payload, has a
 * different identity, finds no claim to replay, and used to read past a state
 * that was already saying a launch was in flight. Refusing it narrows the
 * duplicate-developer race by exactly the span the claim can see. The one
 * claim this reading never counts is the calling request's own: it is written
 * before any state is read, so counting it would make every start a duplicate
 * of itself. And the refusal is
 * bounded from both ends: the claim stops reading `starting` once its process
 * is gone and its grace has passed, and `start_did_not_come_up` is not refused
 * at all, so the Operator is never left with nothing that starts the task.
 * Everything
 * else is decided by the pause record's DISPOSITION, and deliberately NOT by
 * whether the state reads `paused`: a pause is not one situation, and — the
 * reason this is not merely tidier — a paused run whose driver is then
 * killed does not read as `paused` at all. `task run` composes the watching
 * driver, which retains its lock at EVERY pause reason, so a killed pause
 * leaves a dead lock plus an exit trace, and `deriveLoopState` answers
 * `exited` while the pause record is still on disk holding the run. Gating
 * on the state name let that pause launch straight past the very ruling the
 * refusal below exists to require. The disposition reads the record itself,
 * so it sees the hold whatever the state is called.
 *
 * `none` — no pause record, or one a later published round superseded — is
 * what lets `not_started`, `no_driver`, `published` and a genuinely
 * pause-less `exited` run launch: `runTask` re-attaches to the task's own
 * open pull request whenever no driver is live, so starting one continues it
 * rather than opening a second, and for an exited run it is the only tool
 * that can (`task_resume` refuses a run with no pause to resume from).
 *
 * Refusing every pause was itself a way of stranding a run: two of the
 * shapes need no Principal act at all, and `task_resume` launches nothing
 * for either, so refusing them named a tool that would not move.
 *
 * **What this gate is not.** It is a check-then-act read, not a lock, and
 * the claim it sits behind is keyed by request identity — caller included —
 * so it is per-request idempotency rather than per-task exclusion. Two
 * different callers reading a non-running state at the same moment can both
 * reach the launch before either driver lock exists — and before either
 * claim is on disk, which is the part the `starting` refusal above cannot
 * reach: it closes the window where one claim is already written, not the
 * instant where neither is. Narrowing that window
 * is all this layer does: `runTask` re-reads the same fact, and the loop's
 * own round-1 entry re-reads it again immediately before it would dispatch.
 * Closing it needs a real cross-process reservation per task, which is
 * infrastructure this tool does not own — the same accepted race `runTask`
 * already records against its own open-pull-request check.
 */
export function startRefusalForState(
  state: TaskLoopState,
  target: TaskToolRef,
  disposition: PauseDisposition,
  /** Where a ruling for this pause goes and the ordinal it must carry — read only for the `awaiting_ruling` refusal, so it names the place, the marker and the command (O2). `null` when this host could not resolve it, which falls back to the generic phrasing. */
  placement: RulingPlacement | null = null
): TaskToolError | null {
  if (state.kind === 'running') {
    return taskToolError(
      'precondition',
      `task_start: ${describeTaskRef(target)} already has a live driver (pid ${state.pid}) — refusing to start a second developer on one branch. Watch the run it already has with \`task_status\`.`
    )
  }
  if (state.kind === 'starting') {
    return taskToolError(
      'precondition',
      `task_start: ${describeTaskRef(target)} already has a start coming up (start request ${state.requestId}, accepted ${state.startedAt}) whose driver has not written its lock yet — refusing to start a second developer on one branch. Watch it with \`task_status\`: a start that never comes up stops reading as one on its own, and \`task_start\` starts it again then.`
    )
  }
  if (disposition === 'unreadable') {
    return taskToolError(
      'precondition',
      `task_start: ${describeTaskRef(target)} has a pause record or resolution this host could not read, so which tool owns this run cannot be decided — refusing rather than guessing past a decision that may already have been made. Read the run with \`task_status\` and \`task_escalation_read\`, and route the unreadable record to the Principal.`
    )
  }
  if (disposition === 'awaiting_ruling') {
    const reasonSuffix =
      state.kind === 'paused'
        ? ` (${state.reason})`
        : ' (its driver has since exited, but the pause still holds the run)'
    // O2: name WHERE the ruling goes, the exact marker the next one must carry,
    // and the command that posts it — so the Planner posts it without looking
    // anything up. `null` placement (this host could not resolve it) falls back
    // to the generic phrasing rather than inventing a number.
    let whereAndHow =
      "against a Principal ruling posted on the run's own pull request. `task_start` never resumes past a pause that is still asking for one."
    if (placement !== null) {
      const marker = principalRulingMarker(placement.pr ?? placement.issue, placement.nextOrdinal)
      whereAndHow =
        placement.pr !== null
          ? `against a Principal ruling posted on PR #${placement.pr}. Post it with \`vinaya pr rule ${placement.pr} --file <ruling.md>\`, which stamps the next marker \`${marker}\` itself. \`task_start\` never resumes past a pause that is still asking for one.`
          : `against a Principal ruling posted on Issue #${placement.issue} (this pause predates any pull request). Post it as a principal comment on Issue #${placement.issue} whose first line is the marker \`${marker}\`. \`task_start\` never resumes past a pause that is still asking for one.`
    }
    return taskToolError(
      'precondition',
      `task_start: ${describeTaskRef(target)} is held by a pause awaiting a decision${reasonSuffix} — a pause nobody has ruled on is continued by \`task_resume\`, which authenticates it ${whereAndHow}`
    )
  }
  if (disposition === 'resolved_cancel') {
    return taskToolError(
      'precondition',
      `task_start: ${describeTaskRef(target)}'s pause was already resolved as 'cancel' — that run was stopped deliberately, and restarting it here would reverse a Principal decision. \`task_cancel\` reports the cancellation again if you need to read it.`
    )
  }
  // `resolved_resume`, `self_resuming` and `ruled` all continue through THIS
  // tool: the decision they needed has already been made (a ruling consumed
  // into a resolution record), is one the loop makes for itself (a recoverable
  // infrastructure hiccup, within its own retry bound), or is a ruling already
  // posted that postdates this pause (`ruled`) — the very check `task_resume`
  // makes, having passed before this call. `task_resume` launches nothing for
  // the first two — it replays `already_resumed` for one and refuses
  // `authority` for the other — so refusing here would leave those runs with
  // no tool; the `ruled` continuation is `task_resume`'s own, which the handler
  // hands to it directly rather than relaunching past the authentication.
  return null
}

/**
 * Whether a claim is old enough that its own launch must already have concluded
 * one way or the other. Exported because the status reader asks the very same
 * question of the very same records (`task-status.ts`'s `readStartClaim`): a
 * claim this predicate calls fresh is a start still coming up, and one it calls
 * stale is a start whose outcome is decided. Sharing the predicate — not just
 * `START_STALE_CLAIM_GRACE_MS` — is what keeps "starting" and "supersedable"
 * from ever meaning two different windows.
 */
export function claimIsStale(record: StartRecord, now: () => string): boolean {
  const age = claimAgeMs(record, now)
  return age === null || age > START_STALE_CLAIM_GRACE_MS
}

/**
 * How long ago this claim was accepted, by the reader's own clock — or `null`
 * when it has no age this clock can measure, which both windows below read as
 * past their own bound rather than as fresh.
 *
 * Two records have no measurable age, and they fail the same way: one whose
 * `startedAt` does not parse, and one dated further in the FUTURE than the
 * stale grace itself — which a backward host clock step leaves behind (a VM
 * suspend and resume, an NTP step correction, a claim written while the clock
 * was ahead), since every later read then subtracts to a negative age.
 *
 * Read as FRESH, those two pinned a task at `starting` for the life of the
 * checkout: no bound ever aged them out, so the status reader reported a start
 * still coming up on every read, `pruneDeadStartClaims` never deleted the file
 * (it only deletes what it can call past-reporting), and the supersede path
 * never replaced it — while the doctrine's action for `starting` is to read
 * again. A task with no driver at all then had nothing that would ever restart
 * it: the same false report these states exist to remove, with the sign
 * flipped. So an unmeasurable age is past every bound instead. The cost is the
 * other direction — a genuine start in flight whose clock jumped reads
 * `no driver`, and `task_start` starts it again, which is a working action.
 *
 * A `now()` this reader cannot parse is not the claim's fault and is not
 * decided here: it answers `0` — an age no window has passed — leaving the
 * record exactly as untouched as it was before these bounds compared anything.
 */
function claimAgeMs(record: StartRecord, now: () => string): number | null {
  const current = Date.parse(now())
  if (!Number.isFinite(current)) return 0
  const startedAt = Date.parse(record.startedAt)
  if (!Number.isFinite(startedAt)) return null
  const age = current - startedAt
  return age < -START_STALE_CLAIM_GRACE_MS ? null : age
}

/**
 * How long after it was accepted a claim still says anything about the present.
 *
 * A claim is never deleted after a start that WORKED — only a failed launch and
 * the supersede path release one — so the file outlives the run it started, by
 * hours.
 *
 * Two narrower signals already cover most of that: a launch the handler saw
 * CONFIRMED marks its own claim, and a driver lock the claim predates is proof
 * the driver appeared. What neither covers is the launch whose confirm wait
 * ended with the process merely alive (no `confirmedAt` written), whose run
 * then DID come up and later ended leaving no lock behind at all — an uncaught
 * error clears the lock in its `finally` without writing a `driver_exited`
 * trace, and a sweep removes the task folder outright. From the claim alone
 * that is indistinguishable from a launch that never came up, and reporting
 * the second for the first is the mirror of the false `no driver` this state
 * exists to remove. So past this bound the reader stops believing the claim.
 *
 * The cost is the other direction: a genuine failed start read more than this
 * long afterwards falls back to `no driver` rather than naming its request.
 * Both readings send the Operator to `task_start`, so the action is the same
 * either way — what is lost is the request identity in the phrase, not a
 * correct next step.
 *
 * Generous against the thing it measures and small against the thing it must
 * not outlive: a start's own outcome is decided inside
 * `START_STALE_CLAIM_GRACE_MS`, while the shortest real review round is tens of
 * minutes. An operator who started a task and walked away still finds the
 * failure named; nothing that ran is ever described by a claim this old.
 */
export const START_CLAIM_REPORTING_WINDOW_MS = 10 * 60_000

/** Is this claim too old to describe the present at all? See {@link START_CLAIM_REPORTING_WINDOW_MS}. A claim with no age this clock can measure counts as past it — see {@link claimAgeMs} for why that direction and not the other. */
export function claimIsPastReporting(record: StartRecord, now: () => string): boolean {
  const age = claimAgeMs(record, now)
  return age === null || age > START_CLAIM_REPORTING_WINDOW_MS
}

/**
 * Is the process this claim's own launch spawned still running AND still that
 * same process?
 *
 * Liveness alone is `process.kill(pid, 0)`, which answers for whatever holds
 * the pid now — and pids are recycled. Left at that, an unrelated process
 * inheriting the number reads as the launch still coming up, which no later
 * read ever corrects. So a claim that captured its child's identity has that
 * identity re-read and compared through `matchesCapturedIdentity`, the same
 * guard the dispatch layer already applies wherever a pid is treated as a
 * launch's own child; a claim that captured none (written before the fields
 * existed) has nothing to check and is trusted as before.
 *
 * Shared by the status reader and this file's own supersede path, for the same
 * reason `claimIsStale` is: the doctrine's action for a start that did not come
 * up is `task_start`, and that only starts something if this tool agrees the
 * launch is gone.
 */
export function claimLaunchIsAlive(
  record: StartRecord,
  isPidAlive: (pid: number) => boolean,
  snapshotOf: (pid: number) => ProcessSnapshot | null
): boolean {
  const pid = record.pid
  if (pid === undefined || !isPidAlive(pid)) return false
  if (record.childStartedAt == null && record.childCommand == null) return true
  const snapshot = snapshotOf(pid)
  if (snapshot === null) return false
  return matchesCapturedIdentity(
    { childStartedAt: record.childStartedAt ?? null, childCommand: record.childCommand ?? null },
    snapshot
  )
}

// --- default detached launcher, confirmed on the driver lock ----------------

/**
 * The command the default launcher spawns, resolvable through
 * `VINAYA_TASK_RUN_COMMAND` for an operator who wraps the loop launch (a
 * supervisor, a scheduler) — otherwise the `vinaya` binary on PATH, the same
 * resolvable-`vinaya` assumption the agent-native commands already make
 * (`apps/cli/src/lib/artifacts.ts`). The fixture sets this to a recording
 * script so a protocol test can prove exactly one launch.
 */
export const TASK_RUN_COMMAND_ENV = 'VINAYA_TASK_RUN_COMMAND'

/** The `vinaya task run` invocation for a target — the SAME two forms the command itself accepts (`apps/cli/src/commands/task-run.ts`), never a third. */
function taskRunArgsFor(ref: TaskToolRef): string[] {
  return 'issue' in ref ? ['task', 'run', '--issue', String(ref.issue)] : ['task', 'run', ref.tranche, ref.id]
}

function readCapturedStderr(path: string): string {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    return raw ? ` — captured stderr:\n${raw}` : ''
  } catch {
    return ''
  }
}

/**
 * Races the spawned child's own `error`/`exit` against its Issue's driver
 * lock appearing and naming a live pid — never a sleep-then-assume. Whichever
 * happens first decides the outcome; the loser's listeners/timers are torn
 * down so this never resolves twice.
 *
 * The wait itself running out decides NOTHING about the run: the child is
 * still alive (its own `exit` would have won the race otherwise), so the
 * outcome is `starting`, not a failure. That is the whole point of three
 * outcomes — the previous two forced a live process to be reported as a
 * failed start, and raising `timeoutMs` would only move the cliff, since a
 * slow forge or a large start-of-run sweep can outlast any fixed wait.
 */
function waitForLiveDriver(
  child: ReturnType<typeof spawn>,
  root: string,
  issue: number,
  stderrPath: string,
  timeoutMs: number,
  pollMs: number
): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let settled = false
    const finishAlive = (status: 'confirmed' | 'starting') => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      child.removeAllListeners('error')
      child.removeAllListeners('exit')
      // The run is alive and must outlive this server — unref only now, never
      // before the race is decided, so a premature exit is still observed.
      child.unref()
      resolve({ status, pid: child.pid ?? null })
    }
    const finishDead = (reason: string) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      resolve({ status: 'exited', error: new Error(`${reason}${readCapturedStderr(stderrPath)}`) })
    }
    child.on('error', (err) => finishDead(`spawn failed: ${err instanceof Error ? err.message : String(err)}`))
    child.on('exit', (code, signal) =>
      finishDead(
        `process exited before its driver confirmed alive (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      )
    )
    const poll = setInterval(() => {
      const lock = readDriverLock(root, issue)
      if (lock && isDriverPidAlive(lock.pid)) finishAlive('confirmed')
    }, pollMs)
    const timer = setTimeout(() => finishAlive('starting'), timeoutMs)
  })
}

/**
 * `root` defaults to this repo's own resolution but is overridable so a test
 * can point the confirm-wait at a temporary tree without touching the real
 * one; `timeoutMs` likewise, so a fixture can drive a REAL launcher that is
 * slower than its wait in a fraction of a second rather than the 30 the
 * shipped bound takes (`defaultTaskStartDeps.launch` overrides neither).
 */
export function defaultLaunch(
  target: { ref: TaskToolRef; agent: AgentVendor; issue: number },
  meta: { requestId: string; caller: string },
  root: string = runtimeDirForThisRepo(),
  timeoutMs: number = START_CONFIRM_TIMEOUT_MS
): Promise<LaunchResult> {
  const program = process.env[TASK_RUN_COMMAND_ENV]?.trim() || 'vinaya'
  const stderrPath = runPath(root, target.issue, { area: 'output', file: `task-start-${meta.requestId}.stderr.log` })
  ensureRunDir(dirname(stderrPath), root)
  const stderrFd = openSync(stderrPath, 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(program, [...taskRunArgsFor(target.ref), '--agent', target.agent], {
      detached: true,
      stdio: ['ignore', 'ignore', stderrFd]
    })
  } finally {
    // Spawn dup's the fd into the child; our own copy is safe to close
    // immediately, whether spawn succeeded or threw synchronously.
    closeSync(stderrFd)
  }
  return waitForLiveDriver(child, root, target.issue, stderrPath, timeoutMs, START_CONFIRM_POLL_MS)
}

function defaultAgent(): AgentVendor | null {
  const configured = loadConfig()?.dispatch?.agent
  return configured !== undefined && isAgentVendor(configured) ? configured : null
}

function defaultIsRunAlive(issue: number): boolean {
  const lock = readDriverLock(runtimeDirForThisRepo(), issue)
  return lock !== null && isDriverPidAlive(lock.pid)
}

/** The address a start claim for this target would have been WRITTEN against — the ordinal for a tranche task, and `null` for an Issue the claim names directly. The inverse of `claimMatchesTask` (`../task-status.js`), which is the only thing that reads it. */
function claimAddressFor(ref: TaskToolRef): TaskAddress {
  return 'issue' in ref ? null : { tranche: ref.tranche, id: ref.id }
}

export const defaultTaskStartDeps: TaskStartDeps = {
  // Never null in practice: falls back to the server's own cwd (constant for
  // the process lifetime) when the git lookup itself fails, so the identity
  // is always deterministic even outside a git checkout.
  repoRoot: () => gitRepoRoot() ?? process.cwd(),
  store: defaultRequestStore,
  agent: defaultAgent,
  resolveIssue: resolveOpenTaskIssueForRef,
  issueFacts: readTaskIssueFacts,
  isRunAlive: defaultIsRunAlive,
  loopState: (issue, ref, ownRequestId) => {
    const root = runtimeDirForThisRepo()
    return deriveLoopState(root, issue, undefined, () =>
      readStartClaim(root, issue, claimAddressFor(ref), undefined, ownRequestId)
    )
  },
  // The ruling-AWARE disposition: both this tool and `task_status` read the
  // one reader, so a run a ruling has already authorized reads `ruled` to both.
  pauseDisposition: (issue) => resolvePauseDisposition(issue),
  heldAgent: (issue) => defaultHeldAgent(issue),
  // Wrapped in an arrow, never referenced bare: `resume.js` reaches back here
  // through `task-status.js`, so this module can begin evaluating before
  // `defaultTaskResumeHandler` is bound — deferring the read to call time is
  // what keeps the cycle from capturing an undefined handler.
  resume: (input, ctx) => defaultTaskResumeHandler(input, ctx),
  rulingPlacement: (issue) => defaultRulingPlacement(issue),
  isPidAlive: isDriverPidAlive,
  processSnapshot: getProcessSnapshot,
  captureChildSnapshot: captureSettledChildSnapshot,
  pruneClaims: () => {
    pruneDeadStartClaims()
  },
  launch: defaultLaunch,
  now: () => new Date().toISOString()
}

// --- the handler ------------------------------------------------------------

function payloadDigestOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16)
}

/**
 * Builds the `task_start` handler over its deps. The server binds the default
 * deps; a fixture injects recording ones.
 */
export function createTaskStartHandler(
  deps: TaskStartDeps = defaultTaskStartDeps
): (input: unknown, ctx: CallerContext) => Promise<TaskToolCallResult<TaskStartResult>> {
  return async (input, ctx) => {
    const parsed = TaskStartInputSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, error: taskToolError('validation', parsed.error.issues[0]?.message ?? 'invalid input') }
    }
    if (!ctx.caller) {
      return {
        ok: false,
        error: taskToolError(
          'authority',
          'task_start requires an authenticated caller from the invocation context; none was present. MCP is a transport, not authorization — attended mode expects the operator to authenticate the session.'
        )
      }
    }

    const agent = deps.agent()
    if (agent === null) {
      return {
        ok: false,
        error: taskToolError(
          'precondition',
          'task_start requires `dispatch.agent` to be configured (vinaya.config.json) — none is set, and this tool carries no agent input field of its own to fall back from. Set `dispatch.agent` to `claude`, `codex` or `gemini`.'
        )
      }
    }

    const target = parsed.data
    const caller = ctx.caller
    const requestId = taskStartRequestIdentity({
      caller: caller.id,
      repo: deps.repoRoot(),
      target,
      payloadDigest: payloadDigestOf(target)
    })
    const buildRecord = (): StartRecord => ({ requestId, caller: caller.id, target, startedAt: deps.now() })

    // Before writing one more claim, drop the ones already proven dead: the
    // folder is otherwise append-only for the life of the checkout, and every
    // status read that reaches a claim parses all of it.
    deps.pruneClaims()

    let claim = deps.store.claim(buildRecord())

    // O3: a claim old enough that its own launch must already have concluded
    // one way or the other, naming a task with no live driver AND no live
    // launched process, is dead — it never replays as a started run forever
    // after. Superseded: released and re-claimed, so this call launches again
    // exactly as a fresh claim would. A claim still within its own confirm
    // window is never touched here — it may simply not have written its
    // driver lock yet, and is not thereby dead (Traps to avoid: idempotency
    // against a live run is the point).
    if (!claim.claimed && claimIsStale(claim.record, deps.now)) {
      // The process that claim's own launch spawned, asked FIRST and on its
      // own: a launch whose preparation outlasts even the stale grace is a
      // run still coming up — no driver lock yet, and a live pid saying so.
      // Superseding it would put a second developer on one branch, the exact
      // duplicate this tool exists to rule out (O2).
      // Identity-checked, not just alive: a recycled pid answering for an
      // unrelated process would refuse this supersede forever, which is the
      // same claim the status reader would be reporting as a start still
      // coming up. One predicate, so the two can never disagree.
      const childAlive = claimLaunchIsAlive(claim.record, deps.isPidAlive, deps.processSnapshot)
      if (!childAlive) {
        const staleIssue = deps.resolveIssue(claim.record.target)
        // An Issue that fails to resolve here is a transient forge read, not
        // proof of death — treated as alive so a glitch never doubles a launch.
        const staleAlive = staleIssue === null || deps.isRunAlive(staleIssue)
        if (!staleAlive) {
          deps.store.release(claim.record.requestId)
          claim = deps.store.claim(buildRecord())
        }
      }
    }

    if (claim.claimed) {
      const resolved = resolveStartTarget(target, deps)
      if (!resolved.ok) {
        // Refused before launching, so the claim this call just wrote must not
        // outlive it — a released identity is one a corrected retry can reclaim.
        deps.store.release(requestId)
        return { ok: false, error: resolved.error }
      }
      const issue = resolved.issue
      // The state gate, after the Issue is known and before anything is
      // launched. A refusal releases this call's own claim for the same
      // reason a target refusal does: the identity must stay reclaimable by
      // the call that finally does own this state.
      //
      // Both reads happen for every state but `running`, the disposition
      // included: a pause whose driver was killed derives `exited` while its
      // record still holds the run, so asking only when the state reads
      // `paused` is how that hold went unseen.
      let refusal: TaskToolError | null
      let disposition: PauseDisposition = 'none'
      try {
        const state = deps.loopState(issue, target, requestId)
        disposition = state.kind === 'running' ? 'none' : deps.pauseDisposition(issue)
        // O2: only a still-unruled pause needs its placement, so the refusal
        // can name where the ruling goes, the marker and the command.
        const placement = disposition === 'awaiting_ruling' ? deps.rulingPlacement(issue) : null
        refusal = startRefusalForState(state, target, disposition, placement)
      } catch (err) {
        // Neither read is allowed to escape past the claim this call already
        // wrote: an identity claimed with nothing launched replays
        // `started: false` for every retry inside the stale window, reporting
        // a run that never began. Release it, and say what failed.
        deps.store.release(requestId)
        return {
          ok: false,
          error: taskToolError(
            'infrastructure',
            `task_start could not read ${describeTaskRef(target)}'s current state: ${(err as Error).message}`
          )
        }
      }
      if (refusal !== null) {
        deps.store.release(requestId)
        return { ok: false, error: refusal }
      }

      // O1: a `ruled` pause is one a Principal ruling already posted
      // authorizes — the continuation is `task_resume`'s own, and this tool
      // HANDS it there rather than relaunching through `launch`. That is what
      // keeps the ordinal-freshness check the loop's bare `--resume` omits
      // (`dev-review-loop.ts`'s own resume gate checks ruling PRESENCE only),
      // and what records the same resolution and the same `operation:
      // task_resume` Log event a resume records — never a second copy. The
      // start claim this call already wrote STAYS (so a repeat of the same
      // request replays `started: false` rather than handing the same pause to
      // a second continuation) and is marked confirmed (so no later status read
      // calls it a start still coming up — the run `task_resume` launched is
      // the one with a driver lock). A refusal from the hand-off releases the
      // claim, so a corrected retry reclaims it.
      if (disposition === 'ruled') {
        const resumed = await deps.resume({ task: target }, ctx)
        if (!resumed.ok) {
          deps.store.release(requestId)
          return { ok: false, error: resumed.error }
        }
        claim = { claimed: true, record: { ...claim.record, confirmedAt: deps.now() } }
        deps.store.update(claim.record)
        return {
          ok: true,
          result: {
            requestId: claim.record.requestId,
            run: claim.record.target,
            // `already_resumed` means the continuation was already launched by
            // an earlier call — this one started nothing new.
            started: resumed.result.outcome === 'started',
            startedAt: claim.record.startedAt,
            mode: 'attended'
          }
        }
      }

      // Continuing a pause is not the same as starting fresh. `runTask` takes
      // its resume path for any task with a pause record, and the loop
      // refuses outright when the agent it is handed is not the one that
      // pause was dispatched with — so relaunching a held run under whatever
      // `dispatch.agent` the repository configures TODAY kills it on arrival,
      // and `task_resume` answers `already_resumed` without launching for a
      // ruled pause, leaving that state with nothing that moves it. The run's
      // own record is what says which agent it belongs to, the same source
      // `task_resume` reads; config is the fallback for a pause that records
      // none, which the loop accepts.
      const launchAgent =
        disposition === 'resolved_resume' || disposition === 'self_resuming' ? (deps.heldAgent(issue) ?? agent) : agent
      let outcome: LaunchResult
      try {
        outcome = await deps.launch({ ref: target, agent: launchAgent, issue }, { requestId, caller: caller.id })
      } catch (err) {
        // A synchronous launch failure (a missing launcher binary) must not
        // leave a claimed-but-never-started identity that blocks every
        // retry — release it and report an infrastructure failure.
        deps.store.release(requestId)
        return {
          ok: false,
          error: taskToolError('infrastructure', `task_start could not launch the run: ${(err as Error).message}`)
        }
      }
      if (outcome.status === 'exited') {
        // The ONLY failed start: the launched process is gone. Release the
        // claim so an identical retry, once the underlying problem is fixed,
        // launches again instead of replaying a start that never happened.
        // A wait that merely ran out never reaches here — a live process is a
        // started run, and releasing its claim is what let a repeat call put
        // a second developer on the same branch.
        deps.store.release(requestId)
        return {
          ok: false,
          error: taskToolError(
            'infrastructure',
            `task_start: ${describeTaskRef(target)} did not confirm alive: ${outcome.error.message}`,
            outcome.error.message
          )
        }
      }
      // Alive — confirmed, or still starting. Either way the claim STAYS, and
      // the launched pid joins it so a later call can re-check liveness
      // against the process itself while its driver lock is still unwritten.
      // `confirmed` also lands its own timestamp: that outcome means the driver
      // lock appeared, so this claim has stopped describing a start coming up
      // and the status reader must stop reading it as one.
      const confirmedAt = outcome.status === 'confirmed' ? { confirmedAt: deps.now() } : {}
      if (outcome.pid !== null) {
        // The child's identity, captured beside its pid at the one moment it is
        // certainly still that child, so a later liveness read can tell the
        // process apart from whatever inherits its number.
        const snapshot = deps.captureChildSnapshot(outcome.pid)
        claim = {
          claimed: true,
          record: {
            ...claim.record,
            pid: outcome.pid,
            childStartedAt: snapshot?.startedAt ?? null,
            childCommand: snapshot?.command ?? null,
            ...confirmedAt
          }
        }
        deps.store.update(claim.record)
      } else if (outcome.status === 'confirmed') {
        claim = { claimed: true, record: { ...claim.record, ...confirmedAt } }
        deps.store.update(claim.record)
      }
    }

    return {
      ok: true,
      result: {
        requestId: claim.record.requestId,
        run: claim.record.target,
        started: claim.claimed,
        startedAt: claim.record.startedAt,
        mode: 'attended'
      }
    }
  }
}

/** The default `task_start` handler the server binds (`server.ts`) — real deps, ready to launch. */
export const defaultTaskStartHandler = createTaskStartHandler()
