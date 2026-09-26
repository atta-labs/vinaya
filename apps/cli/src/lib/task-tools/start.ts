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
 *     the other, and the task it names now has no live driver, in which case
 *     it is superseded: released and re-claimed, and this call launches
 *     again (O3). Because the claim is written before the launch, a client
 *     that disconnects mid-call leaves at most one run — a reconnect replays
 *     the claim, it does not start again.
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
 *     branch). A run that exits first — a missing `--agent` binary path, a
 *     refused preparation, an ENOENT on the launcher — is reported as a
 *     failed start carrying that run's own captured stderr, and the claim is
 *     released so an identical retry launches again.
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
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { describeTaskRef, readTaskIssueFacts, resolveOpenTaskIssueForRef } from './handlers.js'
import type { TaskIssueFacts, TaskToolCallResult } from './handlers.js'
import type { CallerContext } from './server.js'

/** The durable claim one `task_start` request writes before it launches — the record a duplicate start (same request identity) replays instead of starting again, unless the run it names is found dead and superseded. `target` is the address the call used, so a replay answers in the same form it was asked. */
export type StartRecord = {
  requestId: string
  caller: string
  target: TaskToolRef
  startedAt: string
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
  release: (requestId: string) => void
}

/** What launching a run and waiting for its own confirmation produced. */
export type LaunchResult = { alive: true } | { alive: false; error: Error }

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
   * Starts the run detached and resolves once EITHER its own driver lock
   * confirms it alive, or it exits/errors first — never by sleeping and
   * assuming. Because this resolves only after confirmation, the claim this
   * call already wrote either stays (confirmed) or is released by the caller
   * (dead) — there is no third, ambiguous state for a later call to inherit.
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
function normalizeStartRecord(parsed: unknown): StartRecord | null {
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  if (typeof raw.requestId !== 'string' || typeof raw.caller !== 'string' || typeof raw.startedAt !== 'string') {
    return null
  }
  const base = { requestId: raw.requestId, caller: raw.caller, startedAt: raw.startedAt }
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
    const finishAlive = () => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      child.removeAllListeners('error')
      child.removeAllListeners('exit')
      // The run is confirmed and must outlive this server — unref only now,
      // never before confirmation, so a premature exit is still observed.
      child.unref()
      resolve({ alive: true })
    }
    const finishDead = (reason: string) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      resolve({ alive: false, error: new Error(`${reason}${readCapturedStderr(stderrPath)}`) })
    }
    child.on('error', (err) => finishDead(`spawn failed: ${err instanceof Error ? err.message : String(err)}`))
    child.on('exit', (code, signal) =>
      finishDead(
        `process exited before its driver confirmed alive (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      )
    )
    const poll = setInterval(() => {
      const lock = readDriverLock(root, issue)
      if (lock && isDriverPidAlive(lock.pid)) finishAlive()
    }, pollMs)
    const timer = setTimeout(() => finishDead(`driver lock did not appear within ${timeoutMs}ms`), timeoutMs)
  })
}

/**
 * `root` defaults to this repo's own resolution but is overridable so a test
 * can point the confirm-wait at a temporary tree without touching the real
 * one (`defaultTaskStartDeps.launch` never overrides it).
 */
export function defaultLaunch(
  target: { ref: TaskToolRef; agent: AgentVendor; issue: number },
  meta: { requestId: string; caller: string },
  root: string = runtimeDirForThisRepo()
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
  return waitForLiveDriver(child, root, target.issue, stderrPath, START_CONFIRM_TIMEOUT_MS, START_CONFIRM_POLL_MS)
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
    // one way or the other, naming a task with no live driver, is dead — it
    // never replays as a started run forever after. Superseded: released and
    // re-claimed, so this call launches again exactly as a fresh claim would.
    // A claim still within its own confirm window is never touched here — it
    // may simply not have written its driver lock yet, and is not thereby
    // dead (Traps to avoid: idempotency against a live run is the point).
    if (!claim.claimed && claimIsStale(claim.record, deps.now)) {
      const staleIssue = deps.resolveIssue(claim.record.target)
      // An Issue that fails to resolve here is a transient forge read, not
      // proof of death — treated as alive so a glitch never doubles a launch.
      const staleAlive = staleIssue === null || deps.isRunAlive(staleIssue)
      if (!staleAlive) {
        deps.store.release(claim.record.requestId)
        claim = deps.store.claim(buildRecord())
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
      if (!outcome.alive) {
        // The launch never confirmed alive — release the claim so an
        // identical retry, once the underlying problem is fixed, launches
        // again instead of replaying a start that never happened.
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
