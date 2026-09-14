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
 *   - is idempotent per REQUEST IDENTITY — caller + repo + target + payload
 *     digest (`taskStartRequestIdentity`, `@attalabs/aeg-core`). The repo
 *     component is the local checkout's git toplevel path (`repoRoot`,
 *     `../diff-evidence.js`), never a network-resolved GitHub owner/repo: a
 *     remote lookup can fail transiently and succeed on retry, which would
 *     silently change the identity between two calls meant to collapse into
 *     one run — the local path is synchronous and deterministic for the
 *     lifetime of this server process, so it can never do that, and it still
 *     tells two different checkouts on the same machine apart. The first call
 *     claims the identity in a durable store and starts the run detached; a
 *     second call with the same identity finds the claim and returns the same
 *     durable run identity WITHOUT starting a second run. Because the claim is
 *     durable and written before the launch, a client that disconnects mid-call
 *     leaves at most one run — a reconnect replays the claim, it does not start
 *     again.
 *   - starts the run DETACHED and returns immediately with the durable run
 *     identity (the task's tranche/id — its `task/<tranche>/<n>` branch is the
 *     addressing scheme every other tool resolves through). The run itself
 *     continues independently; its PR is discoverable through `task_status`.
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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { TaskStartInputSchema, type TaskStartResult, taskStartRequestIdentity, taskToolError } from '@attalabs/aeg-core'
import { GLOBAL_VINAYA_HOME } from '../config.js'
import { repoRoot as gitRepoRoot } from '../diff-evidence.js'
import type { TaskToolCallResult } from './handlers.js'
import type { CallerContext } from './server.js'

/** The durable claim one `task_start` request writes before it launches — the record a duplicate start (same request identity) replays instead of starting again. */
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
 * replays the recorded run). Injectable so a fixture can observe claims without
 * touching disk; the default is a machine-local file store.
 */
export type RequestStore = {
  claim: (record: StartRecord) => { claimed: boolean; record: StartRecord }
  release: (requestId: string) => void
}

export type TaskStartDeps = {
  /** The local checkout's stable identity for the request-identity computation — never network-resolved, see this file's own header. */
  repoRoot: () => string | null
  store: RequestStore
  /** Starts the run detached — it must not block on the run's completion, and it must survive this process exiting. */
  launch: (target: { tranche: string; id: string }, meta: { requestId: string; caller: string }) => void
  now: () => string
}

// --- default durable file store ---------------------------------------------

/** `~/.vinaya/task-start/<requestId>.json` — the request-identity already folds in caller, repo and target, so a flat per-id file is unambiguous. Owner-only, same hardening posture as `dispatch.ts`'s own machine-local records. */
function startRecordPath(requestId: string): string {
  return join(GLOBAL_VINAYA_HOME, 'task-start', `${requestId}.json`)
}

export const defaultRequestStore: RequestStore = {
  claim(record) {
    const path = startRecordPath(record.requestId)
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      chmodSync(dirname(path), 0o700)
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
    // Best-effort: only removed when a launch failed synchronously right after
    // the claim, so a genuine retry can reclaim the identity. Never throws — a
    // stale record only ever refuses a retry, it never starts a run twice.
    try {
      rmSync(startRecordPath(requestId), { force: true })
    } catch {
      // ignore
    }
  }
}

// --- default detached launcher ----------------------------------------------

/**
 * The command the default launcher spawns, resolvable through
 * `VINAYA_TASK_RUN_COMMAND` for an operator who wraps the loop launch (a
 * supervisor, a scheduler) — otherwise the `vinaya` binary on PATH, the same
 * resolvable-`vinaya` assumption the agent-native commands already make
 * (`apps/cli/src/lib/artifacts.ts`). The fixture sets this to a recording
 * script so a protocol test can prove exactly one launch.
 */
export const TASK_RUN_COMMAND_ENV = 'VINAYA_TASK_RUN_COMMAND'

export function defaultLaunch(target: { tranche: string; id: string }): void {
  const program = process.env[TASK_RUN_COMMAND_ENV]?.trim() || 'vinaya'
  const child = spawn(program, ['task', 'run', target.tranche, target.id], {
    detached: true,
    stdio: 'ignore'
  })
  // Unref so the run outlives this server process — the whole point of a
  // detached start.
  child.unref()
}

export const defaultTaskStartDeps: TaskStartDeps = {
  // Never null in practice: falls back to the server's own cwd (constant for
  // the process lifetime) when the git lookup itself fails, so the identity
  // is always deterministic even outside a git checkout.
  repoRoot: () => gitRepoRoot() ?? process.cwd(),
  store: defaultRequestStore,
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

    const { tranche, id } = parsed.data
    const requestId = taskStartRequestIdentity({
      caller: ctx.caller.id,
      repo: deps.repoRoot(),
      tranche,
      id,
      payloadDigest: payloadDigestOf({ tranche, id })
    })

    const record: StartRecord = { requestId, caller: ctx.caller.id, tranche, id, startedAt: deps.now() }
    const claim = deps.store.claim(record)

    if (claim.claimed) {
      try {
        deps.launch({ tranche, id }, { requestId, caller: ctx.caller.id })
      } catch (err) {
        // A synchronous launch failure (a missing launcher binary) must not
        // leave a claimed-but-never-started identity that blocks every retry —
        // release it and report an infrastructure failure.
        deps.store.release(requestId)
        return {
          ok: false,
          error: taskToolError('infrastructure', `task_start could not launch the run: ${(err as Error).message}`)
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
