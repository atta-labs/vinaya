/**
 * The parent broker — the one chokepoint a task-effect request passes
 * through before `effects.ts`'s `EffectExecutor` ever runs a poster.
 * `effects.ts` already answers "has this exact write already happened"
 * (idempotent, identity-fenced); this module answers the question standing
 * in front of it — "is the caller who says it is role R, doing operation O
 * against target T at task N, actually allowed to ask for that" — before
 * the caller's own poster closure is ever invoked.
 *
 * "Parent" names where this runs: the Controller process
 * (`apps/cli/specs/isolation.md` §1, "Controller" row) — the trusted `vinaya`
 * CLI code, never inside a dispatched Worker/Reviewer child itself. A
 * caller-supplied claim of role authenticates nothing on its own (the same
 * posture `task-tools/router.ts`'s own module doc states for the Operator's
 * tool grant): `VINAYA_ROLE` is read from the CALLER's own environment, so a
 * compromised or merely buggy Worker (an "untrusted execution surface"
 * running arbitrary Bash, per `isolation.md`) could set it to anything
 * before invoking a `vinaya` command. `authenticateWorkerInvocation` accepts
 * only the one dispatched role `isolation.md`'s boundary table actually
 * names as Worker (`developer`) — every other value, including `principal`
 * (never itself a dispatched child; `isolation.md`'s Operator row is the
 * human, not a `VINAYA_ROLE` a controller ever spawns), is refused here,
 * never silently mapped to a default grant.
 *
 * Grant vocabulary reuses `EffectIdentity`'s own shape (`effects.ts`): an
 * operation, a target, an input version — the exact four-field identity
 * `EffectExecutor` already binds a write to, so the broker's grant check and
 * the effect executor's own idempotency check are never two competing
 * descriptions of "what is this write" — one grant table, not two.
 *
 * Scope note: `isolation.md` §1's Broker row also names a DIFFERENT, larger
 * job — minting the one scoped, short-lived forge-write credential a Worker
 * needs, and resolving each dispatched child's model-runtime credential.
 * This module builds the grant-checking authorization gate `isolation.md`'s
 * text anticipated in front of that credential material, not the credential
 * material itself; no minting code, no scoped-token API call, ships here.
 * Real credential minting stays future work, not yet assigned anywhere.
 */

import { acquireOwnership, type ControlStoreDeps, readEffect } from '@attalabs/aeg-core'
import { createEffectExecutor, type EffectReconciler, sha256Hex } from './effects.js'

// --- invocation context (O1) ------------------------------------------------

/**
 * The two grantable invocation contexts this broker authorizes. Reviewer,
 * Controller and Repository-subprocess (`isolation.md` §1) never request an
 * effect through here: a Reviewer holds no forge-write grant at all (it is
 * never a broker role), and Controller/Repository-subprocess are the
 * trusted code that CALLS this module, not a role granted BY it.
 */
export type BrokerRole = 'worker' | 'operator'

/** The one dispatched `VINAYA_ROLE` value that maps to the Worker broker role — `isolation.md` §1's own "Worker" row ("The dispatched Developer role's ... child process"). Every other role value dispatch ever sets (`code-reviewer`, `security`) is a real, legitimately dispatched role that simply holds no Worker grant; `principal`/`planner`/`archivist`/`architect` are never dispatched-child values at all. */
const DISPATCHED_ROLE_TO_BROKER_ROLE: Readonly<Record<string, BrokerRole>> = {
  developer: 'worker'
}

/** Thrown by both `authenticate*Invocation` functions — an invocation context that cannot be trusted is refused before any grant is even looked up, never defaulted to the least-privileged role silently (silently downgrading would hide a forged claim rather than surfacing it). */
export class ForgedInvocationError extends Error {
  constructor(readonly reason: string) {
    super(`broker: refusing to authenticate invocation context — ${reason}`)
    this.name = 'ForgedInvocationError'
  }
}

export type InvocationContext = {
  role: BrokerRole
  task: number
}

function assertPositiveTaskId(task: number, raw: unknown): number {
  if (!Number.isInteger(task) || task <= 0) {
    throw new ForgedInvocationError(`task id ${JSON.stringify(raw)} is not a positive integer`)
  }
  return task
}

/**
 * Authenticates a Worker's invocation context from the SAME two attribution
 * variables `dispatchRole` sets on every spawned child's own environment
 * (`dispatch.ts`, `VINAYA_ROLE`/`VINAYA_TASK`) — never a value the caller
 * passes as a function argument, since an argument is exactly the
 * self-asserted claim `task-tools/router.ts`'s own module doc says
 * authenticates nothing. `VINAYA_ROLE=developer` is the only value this
 * maps to a grantable role; anything else — a forged `principal`, a real
 * but ungranted `code-reviewer`, a missing or empty value — is refused.
 */
export function authenticateWorkerInvocation(env: Readonly<Record<string, string | undefined>>): InvocationContext {
  const role = env.VINAYA_ROLE
  const mapped = role === undefined ? undefined : DISPATCHED_ROLE_TO_BROKER_ROLE[role]
  if (mapped === undefined) {
    throw new ForgedInvocationError(
      `VINAYA_ROLE ${JSON.stringify(role ?? null)} does not map to a broker-grantable Worker role`
    )
  }
  const taskRaw = env.VINAYA_TASK
  const task = taskRaw === undefined ? Number.NaN : Number.parseInt(taskRaw, 10)
  return { role: mapped, task: assertPositiveTaskId(task, taskRaw ?? null) }
}

/**
 * Authenticates an Operator's invocation context through the SAME channel
 * `task-tools/server.ts` already authenticates an Operator's MCP session
 * with — `VINAYA_MCP_CALLER` — rather than a second identity scheme: #557's
 * own sizing note is "one agent holds one broker and one grant table," and
 * inventing a parallel Operator credential here would be exactly the second
 * table that note rules out. `task` is the task the Operator's request
 * names (its own `task_start`/`task_status` argument) — not read from this
 * env, since an Operator's channel carries no per-dispatch `VINAYA_TASK`.
 */
export function authenticateOperatorInvocation(
  env: Readonly<Record<string, string | undefined>>,
  task: number
): InvocationContext {
  const callerId = env.VINAYA_MCP_CALLER
  if (callerId === undefined || callerId.trim().length === 0) {
    throw new ForgedInvocationError('no VINAYA_MCP_CALLER on this invocation — the Operator channel requires one')
  }
  return { role: 'operator', task: assertPositiveTaskId(task, task) }
}

// --- operations and the grant table (O2, O3) --------------------------------

/** Branch and change operations — what O2 calls "required branch and change operations." */
export const WORKER_OPERATIONS = ['branch-push', 'pr-open', 'pr-comment'] as const
export type WorkerOperation = (typeof WORKER_OPERATIONS)[number]

/** Selected-task execution and observation only — O3's own words. */
export const OPERATOR_OPERATIONS = ['task-execute', 'task-observe'] as const
export type OperatorOperation = (typeof OPERATOR_OPERATIONS)[number]

export type Operation = WorkerOperation | OperatorOperation

/**
 * Named here, exported, so a denial test asserts against the EXACT string
 * being refused rather than an ad hoc literal — and so this list stays the
 * one place documenting what NO role's grant may ever include, regardless
 * of how `GRANTS` below is later edited. A ruling, a criteria edit, a
 * protected merge and a review-approval publication are O2's named Worker
 * denials; human resolution of a paused/escalated run (a resume/cancel
 * decision, or the ruling that unblocks one) is O3's — it belongs to the
 * Principal's own forge-identity-gated channel (`forge-write.ts`'s
 * `refuseUnlessPrincipal`), a DIFFERENT authenticated channel than this
 * broker, never something this broker's own grant table extends to either
 * role.
 */
export const NEVER_GRANTED_OPERATIONS = [
  'ruling-post',
  'criteria-edit',
  'protected-merge',
  'review-publish',
  'human-resolve'
] as const

const GRANTS: Readonly<Record<BrokerRole, readonly Operation[]>> = {
  worker: WORKER_OPERATIONS,
  operator: OPERATOR_OPERATIONS
}

export class UngrantedOperationError extends Error {
  constructor(
    readonly role: BrokerRole,
    readonly operation: string
  ) {
    super(`broker: role '${role}' is not granted operation '${operation}'`)
    this.name = 'UngrantedOperationError'
  }
}

/**
 * The membership test every request is refused or admitted by.
 * `operation` is deliberately typed as `string`, not the closed `Operation`
 * union, on the request shape below — a real caller is exactly the
 * adversarial case the brief's O3 denial tests exercise, and a union type
 * only constrains code written against this module in good faith. This
 * runtime check is the actual enforcement; the union exists so a legitimate
 * call site gets the closed vocabulary at the type level too.
 */
function assertGranted(role: BrokerRole, operation: string): void {
  const grant = GRANTS[role]
  if (!(grant as readonly string[]).includes(operation)) {
    throw new UngrantedOperationError(role, operation)
  }
}

// --- target binding and administrative-path protection (O2) ----------------

export class UnboundTargetError extends Error {
  constructor(
    readonly task: number,
    readonly targetTask: number
  ) {
    super(`broker: a request for task ${targetTask} is not bound to the invocation's own task ${task}`)
    this.name = 'UnboundTargetError'
  }
}

const PROTECTED_ADMIN_PATHS = ['vinaya.config.json', '.vinaya/doc-owners', '.github/', 'aeg-root/'] as const

export class ProtectedPathError extends Error {
  constructor(readonly path: string) {
    super(`broker: refusing an operation that touches a protected administrative policy path: ${path}`)
    this.name = 'ProtectedPathError'
  }
}

function isProtectedAdminPath(path: string): boolean {
  return PROTECTED_ADMIN_PATHS.some((prefix) => path === prefix || path.startsWith(prefix))
}

function assertNoProtectedPaths(paths: readonly string[] | undefined): void {
  for (const path of paths ?? []) {
    if (isProtectedAdminPath(path)) throw new ProtectedPathError(path)
  }
}

// --- replay/staleness of the input version (O1, O3) -------------------------

/**
 * Refused when a request's `inputVersion` is OLDER than one already
 * recorded for the same `(task, key)` — a captured or cached request from
 * an earlier round, replayed after the task's input has moved on, is
 * exactly O3's "replayed capability" case. `effects.ts`'s own identity
 * check treats a different `inputVersion` under the same key as a changed
 * intent and posts it fresh (correct for a genuinely NEWER version); this
 * check adds the direction that check does not cover — a request going
 * BACKWARDS is never a changed intent, it is staleness — and refuses
 * before `effects.ts` is ever reached.
 */
export class ReplayedInputVersionError extends Error {
  constructor(
    readonly key: string,
    readonly presented: number,
    readonly current: number
  ) {
    super(
      `broker: refusing '${key}' — presented inputVersion ${presented} is older than the already-recorded ${current} (a replayed or stale capability)`
    )
    this.name = 'ReplayedInputVersionError'
  }
}

function assertNoReplayedInputVersion(
  deps: Pick<ControlStoreDeps, 'root'>,
  task: number,
  key: string,
  inputVersion: number
): void {
  const existing = readEffect(deps, task, key)
  if (existing.status === 'ok' && inputVersion < existing.value.inputVersion) {
    throw new ReplayedInputVersionError(key, inputVersion, existing.value.inputVersion)
  }
}

// --- requesting an effect (O1) ----------------------------------------------

export type BrokerEffectRequest = {
  /** The operation being requested — checked against the invocation context's role grant. Typed `string`: see `assertGranted`'s own doc for why. */
  operation: string
  /** `EffectIdentity.target` — the free-form identity `effects.ts` binds the write to (a branch name, `pr:<n>`, whatever the operation naturally identifies its write by). */
  target: string
  /** The task this request is about — checked against the invocation context's own task (O2's "bind branch-writing grants to the current task"), never inferred from `target`'s own text. */
  targetTask: number
  /** `EffectIdentity.inputVersion` — see `assertNoReplayedInputVersion`. */
  inputVersion: number
  /** Repo-relative paths this operation would touch, when applicable (a `branch-push`'s changed files) — checked against `PROTECTED_ADMIN_PATHS` regardless of role or grant. */
  touchedPaths?: readonly string[]
  /** `EffectExecuteInput.key` — one control-store file per key. */
  key: string
  /** Hashed into `EffectIdentity.payloadDigest` via `sha256Hex` — never stored or logged raw by this module. */
  payload: string
  poster: () => string
  reconcile: EffectReconciler
}

/**
 * The one entry point: authenticate (already done, by the caller, via
 * `authenticate*Invocation` above), authorize, THEN call the effect
 * executor — never the other order. Deliberately does not accept a raw
 * `gh`/shell command or an unvalidated argv array (the brief's own trap:
 * "do not expose an unrestricted raw forge method or generic shell through
 * the broker") — `poster`/`reconcile` are caller-supplied closures composed
 * by a specific, named operation's own command code, never a string this
 * module interprets.
 *
 * Ownership: acquires a FRESH control-store epoch for this exact request
 * (the same `createEffectExecutor` pattern `dev-review-loop/publication.ts`
 * and `pause-resume.ts` already use — `dispatchRole` itself deliberately
 * does NOT claim a task-wide epoch at dispatch time, `dispatch.ts`'s own
 * `LaunchRecord` doc: "not a control-store ownership epoch the generic
 * launcher has no business claiming"). A write that loses the epoch mid-
 * flight (another broker request for the same task racing this one) is
 * refused by `effects.ts`'s own `assertCurrentEpoch`, exactly as it is for
 * every other control-store writer — this is O1's "ownership" check.
 */
export function requestEffect(
  deps: ControlStoreDeps,
  context: InvocationContext,
  request: BrokerEffectRequest
): string {
  assertGranted(context.role, request.operation)
  if (request.targetTask !== context.task) {
    throw new UnboundTargetError(context.task, request.targetTask)
  }
  assertNoProtectedPaths(request.touchedPaths)
  assertNoReplayedInputVersion(deps, context.task, request.key, request.inputVersion)

  const ownerId = `broker:${context.task}:${context.role}:${request.operation}:${request.key}`
  const executor = createEffectExecutor(deps, context.task, ownerId)
  return executor.execute({
    key: request.key,
    identity: {
      operation: request.operation,
      target: request.target,
      inputVersion: request.inputVersion,
      payloadDigest: sha256Hex(request.payload)
    },
    poster: request.poster,
    reconcile: request.reconcile
  })
}

// Re-exported so a caller that needs to pre-check ownership (rather than
// let `requestEffect` surface a mid-flight `StaleEpochWriteError`) has the
// same primitive `effects.ts`'s own callers already use — never a second,
// broker-local reimplementation of epoch acquisition.
export { acquireOwnership }
