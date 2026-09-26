/**
 * `task_start` (O2) — the one mutating handler this task lands. It wraps the
 * existing `runTask` composition (`apps/cli/src/lib/task-run.ts`, `vinaya task
 * run`) for an explicitly selected, already-frozen task, and:
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
 *   - is idempotent per REQUEST IDENTITY — caller + repo + target + payload
 *     digest (`taskStartRequestIdentity`, `@attalabs/aeg-core`). The repo
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
 *   - reports a start only once the launched run is CONFIRMED ALIVE (O1): it
 *     resolves the task's forge Issue (the same read `task_resume`/
 *     `task_status` already use, `resolveIssueForRef`), launches the run
 *     detached, and waits, bounded, for that Issue's own driver lock
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
import { TaskStartInputSchema, type TaskStartResult, taskStartRequestIdentity, taskToolError } from '@attalabs/aeg-core'
import { loadConfig } from '../config.js'
import { type AgentVendor, isAgentVendor } from '../dispatch.js'
import { isDriverPidAlive, readDriverLock } from '../dev-review-loop/pause-resume.js'
import { ensureRunDir, runPath, runtimeDirForThisRepo } from '../run-paths.js'
import { repoRoot as gitRepoRoot } from '../diff-evidence.js'
import { resolveIssueForRef } from './handlers.js'
import type { TaskToolCallResult } from './handlers.js'
import type { CallerContext } from './server.js'

/** The durable claim one `task_start` request writes before it launches — the record a duplicate start (same request identity) replays instead of starting again, unless O3 finds the run it names dead and supersedes it. */
export type StartRecord = {
  requestId: string
  caller: string
  tranche: string
  id: string
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
  /** The SAME `{tranche, id}` → Issue resolution `task_resume`/`task_status` already use (`handlers.ts`'s `resolveIssueForRef`) — `null` when no open task matches. */
  resolveIssue: (tranche: string, id: string) => number | null
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
    target: { tranche: string; id: string; agent: AgentVendor; issue: number },
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
        const existing = JSON.parse(readFileSync(path, 'utf8')) as StartRecord
        return { claimed: false, record: existing }
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
  target: { tranche: string; id: string; agent: AgentVendor; issue: number },
  meta: { requestId: string; caller: string },
  root: string = runtimeDirForThisRepo()
): Promise<LaunchResult> {
  const program = process.env[TASK_RUN_COMMAND_ENV]?.trim() || 'vinaya'
  const stderrPath = runPath(root, target.issue, { area: 'output', file: `task-start-${meta.requestId}.stderr.log` })
  ensureRunDir(dirname(stderrPath), root)
  const stderrFd = openSync(stderrPath, 'a')
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(program, ['task', 'run', target.tranche, target.id, '--agent', target.agent], {
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

function defaultResolveIssue(tranche: string, id: string): number | null {
  return resolveIssueForRef({ tranche, id })
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
  resolveIssue: defaultResolveIssue,
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

    const { tranche, id } = parsed.data
    const caller = ctx.caller
    const requestId = taskStartRequestIdentity({
      caller: caller.id,
      repo: deps.repoRoot(),
      tranche,
      id,
      payloadDigest: payloadDigestOf({ tranche, id })
    })
    const buildRecord = (): StartRecord => ({ requestId, caller: caller.id, tranche, id, startedAt: deps.now() })

    let claim = deps.store.claim(buildRecord())

    // O3: a claim old enough that its own launch must already have concluded
    // one way or the other, naming a task with no live driver, is dead — it
    // never replays as a started run forever after. Superseded: released and
    // re-claimed, so this call launches again exactly as a fresh claim would.
    // A claim still within its own confirm window is never touched here — it
    // may simply not have written its driver lock yet, and is not thereby
    // dead (Traps to avoid: idempotency against a live run is the point).
    if (!claim.claimed && claimIsStale(claim.record, deps.now)) {
      const staleIssue = deps.resolveIssue(claim.record.tranche, claim.record.id)
      // An Issue that fails to resolve here is a transient forge read, not
      // proof of death — treated as alive so a glitch never doubles a launch.
      const staleAlive = staleIssue === null || deps.isRunAlive(staleIssue)
      if (!staleAlive) {
        deps.store.release(claim.record.requestId)
        claim = deps.store.claim(buildRecord())
      }
    }

    if (claim.claimed) {
      const issue = deps.resolveIssue(tranche, id)
      if (issue === null) {
        deps.store.release(requestId)
        return {
          ok: false,
          error: taskToolError(
            'infrastructure',
            `task_start: ${tranche}/${id} has no resolvable Issue to confirm a launch against — refusing to start blind.`
          )
        }
      }
      let outcome: LaunchResult
      try {
        outcome = await deps.launch({ tranche, id, agent, issue }, { requestId, caller: caller.id })
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
            `task_start: ${tranche}/${id} did not confirm alive: ${outcome.error.message}`,
            outcome.error.message
          )
        }
      }
    }

    return {
      ok: true,
      result: {
        requestId: claim.record.requestId,
        run: { tranche: claim.record.tranche, id: claim.record.id },
        started: claim.claimed,
        startedAt: claim.record.startedAt,
        mode: 'attended'
      }
    }
  }
}

/** The default `task_start` handler the server binds (`server.ts`) — real deps, ready to launch. */
export const defaultTaskStartHandler = createTaskStartHandler()
