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
 *     owns, naming that tool: a LIVE driver is `task_status`'s to watch, and
 *     a PAUSED run is `task_resume`'s to continue behind a Principal ruling.
 *     Every other state this tool starts — a task never dispatched, a run
 *     that EXITED (killed, crashed, ended by a signal, no pause written), and
 *     a published one — because `runTask` re-attaches to the task's own open
 *     pull request when no driver is live, so starting an exited run
 *     continues it rather than duplicating it. The state is read through the
 *     SAME `deriveLoopState` derivation `task_status` reports from, so the
 *     refusal and the state an Operator was just shown can never disagree;
 *     reading a raw pause record instead would refuse a task that paused,
 *     resumed and published long ago, since a pause record is never cleared.
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
import { closeSync, ftruncateSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  TaskStartInputSchema,
  type TaskStartResult,
  type TaskToolError,
  type TaskToolRef,
  taskStartRequestIdentity,
  taskToolError
} from '@attalabs/aeg-core'
import { loadConfig } from '../config.js'
import { type AgentVendor, isAgentVendor } from '../dispatch.js'
import { isDriverPidAlive, readDriverLock } from '../dev-review-loop/pause-resume.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo } from '../run-paths.js'
import { repoRoot as gitRepoRoot } from '../diff-evidence.js'
import { deriveLoopState, type TaskLoopState } from '../task-status.js'
import { describeTaskRef, readTaskIssueFacts, resolveOpenTaskIssueForRef } from './handlers.js'
import type { TaskIssueFacts, TaskToolCallResult } from './handlers.js'
import type { CallerContext } from './server.js'

/** The durable claim one `task_start` request writes before it launches — the record a duplicate start (same request identity) replays instead of starting again, unless the run it names is found dead and superseded. `target` is the address the call used, so a replay answers in the same form it was asked. */
export type StartRecord = {
  requestId: string
  caller: string
  target: TaskToolRef
  startedAt: string
  /** The pid of the process this claim's own launch spawned, recorded once the launch is known alive — absent on a claim written by a build that recorded none, and on one whose launch has not returned yet. It is what tells a still-preparing run (alive, no driver lock yet) apart from a dead claim, so the supersede path never relaunches a task that is already coming up. */
  pid?: number
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
  /** The task's current loop state, read through the SAME derivation `task_status` reports from (`deriveLoopState`, `../task-status.js`) — never a raw pause-record read, which is never cleared on resume and so would refuse a task that paused and published long ago. It is what decides whether this start belongs to another tool. */
  loopState: (issue: number) => TaskLoopState
  /** Is this pid still running? Asked of the pid a claim's own launch recorded — the one liveness signal that exists BEFORE a driver lock does, and so the one that tells a still-preparing run apart from a dead claim. */
  isPidAlive: (pid: number) => boolean
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
function startRecordPath(requestId: string): string {
  return runPath(runtimeDirForThisRepo(), 'unscoped', {
    area: 'control',
    file: `start-request-${requestId}.json`
  })
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
  const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) ? { pid: raw.pid } : {}
  const base = { requestId: raw.requestId, caller: raw.caller, startedAt: raw.startedAt, ...pid }
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
 * The one state gate: is this task's run another tool's to act on?
 *
 * `null` means `task_start` owns this state and may launch. A refusal names
 * the tool that does own it, so an Operator handed one is never left without
 * a next action — the failure this gate exists to close was a state with NO
 * working tool at all, and a refusal that names none recreates it.
 *
 * Only two states are refused. A run that EXITED — killed, crashed, ended by
 * a signal, with no pause record written — is deliberately NOT one of them:
 * `runTask` re-attaches to the task's own open pull request whenever no
 * driver is live, so starting it continues that run rather than opening a
 * second one, and it is the only tool that can (`task_resume` refuses a run
 * with no pause to resume from). `not_started`, `no_driver` and `published`
 * take the same launch path for the same reason.
 */
export function startRefusalForState(state: TaskLoopState, target: TaskToolRef): TaskToolError | null {
  if (state.kind === 'running') {
    return taskToolError(
      'precondition',
      `task_start: ${describeTaskRef(target)} already has a live driver (pid ${state.pid}) — refusing to start a second developer on one branch. Watch the run it already has with \`task_status\`.`
    )
  }
  if (state.kind === 'paused') {
    return taskToolError(
      'precondition',
      `task_start: ${describeTaskRef(target)}'s run is paused (${state.reason}) — a paused run is continued by \`task_resume\`, which requires a Principal ruling posted on the run's own pull request. \`task_start\` never resumes past a pause.`
    )
  }
  return null
}

function claimIsStale(record: StartRecord, now: () => string): boolean {
  const startedAt = Date.parse(record.startedAt)
  const current = Date.parse(now())
  return Number.isFinite(startedAt) && Number.isFinite(current) && current - startedAt > START_STALE_CLAIM_GRACE_MS
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
  loopState: (issue) => deriveLoopState(runtimeDirForThisRepo(), issue),
  isPidAlive: isDriverPidAlive,
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
      const launchedPid = claim.record.pid
      const childAlive = launchedPid !== undefined && deps.isPidAlive(launchedPid)
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
      const refusal = startRefusalForState(deps.loopState(issue), target)
      if (refusal !== null) {
        deps.store.release(requestId)
        return { ok: false, error: refusal }
      }
      let outcome: LaunchResult
      try {
        outcome = await deps.launch({ ref: target, agent, issue }, { requestId, caller: caller.id })
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
      if (outcome.pid !== null) {
        claim = { claimed: true, record: { ...claim.record, pid: outcome.pid } }
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
