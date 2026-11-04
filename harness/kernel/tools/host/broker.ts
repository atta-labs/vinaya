/**
 * The parent broker — the one chokepoint a task-effect request passes
 * through before `effects.ts`'s `EffectExecutor` ever runs a poster.
 * `effects.ts` already answers "has this exact write already happened"
 * (idempotent, identity-fenced); this module answers the question standing
 * in front of it — "is the caller who says it is role R, doing operation O
 * against target T at task N, actually allowed to ask for that" — before
 * the caller's own poster closure is ever invoked.
 *
 * "Parent" names where this runs: the trusted process
 * (`harness/kernel/isolation/isolation.md` §1) — the trusted `vinaya` CLI code, never
 * inside a dispatched child itself. A caller-supplied claim of role
 * authenticates nothing on its own (the same posture `task-tools/router.ts`'s
 * own module doc states for its seat's tool grant): `VINAYA_ROLE` is read
 * from the CALLER's own environment, so a compromised or merely buggy Worker
 * (an "untrusted execution surface" running arbitrary Bash, per
 * `isolation.md`) could set it to anything before invoking a `vinaya`
 * command. `authenticateWorkerInvocation` accepts only a role the broker's
 * role policy maps to the Worker grant — every other value, recognized or
 * not, is refused here, never silently mapped to a default grant.
 *
 * Policies: the broker names no role and no repository path. A broker is
 * built (`createBroker`) from three policies the process supplies — a
 * protected-path policy, a launch-record verifier and a role policy — and
 * building one without any of them is refused (`MissingBrokerPolicyError`),
 * never defaulted to no protection or to an unchecked task claim.
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

import { acquireOwnership, type ControlStoreDeps, readEffect } from '../../connectors/checkpoint/control-store/index'
import { normalizeTouchedPath } from './touched-path.js'
import { createEffectExecutor, type EffectReconciler, sha256Hex } from '../../effects/effects.js'
import { log as defaultLogEvent, type LogEventInput } from '../../log/log-sink.js'

/**
 * Every `operation` log line this module emits (O1: "normalized invocation,
 * authorization ... outcomes"): one call for authenticating the invocation
 * context itself (`authenticate*Invocation`), one for the grant/target/
 * replay checks `requestEffect` runs before ever reaching the effect
 * executor (whose own `attempted`/`observed`/`verified` sequence,
 * `effects.ts`, picks up from there). Threaded as an optional trailing
 * parameter, defaulting to the real global sink.
 */
export type BrokerLogEvent = (e: LogEventInput) => void

// --- the policies a broker is built from -----------------------------------

/**
 * Answers whether a touched path is a protected administrative path. The
 * broker normalizes every touched path (`normalizeTouchedPath`) BEFORE asking,
 * so `isProtected` only ever sees a normalized path.
 */
export type ProtectedPathPolicy = {
  isProtected: (normalizedPath: string) => boolean
}

/**
 * Answers whether the trusted launcher durably recorded launching run `runId`
 * as `role` for `task` before the child was spawned — the cross-check that
 * keeps a child from claiming a task it was not launched for.
 */
export type LaunchRecordVerifier = {
  matchesRun: (runId: string, role: string, task: number) => boolean
}

/** The role facts the broker reads: the closed set of roles an invocation may name at all, which of them hold the Worker grant, and who a protected-path refusal sends the path to. */
export type BrokerRolePolicy = {
  readonly recognizedRoles: readonly string[]
  readonly workerRoles: readonly string[]
  /** Who adds a path to a task's Surface, as the protected-path refusal names them. */
  readonly surfaceOwner: string
}

export type BrokerPolicies = {
  protectedPaths: ProtectedPathPolicy
  launchRecords: LaunchRecordVerifier
  roles: BrokerRolePolicy
}

/** Thrown by `createBroker` when a policy is missing or malformed — a broker is never built with no protection, no launch-record check or no role set. */
export class MissingBrokerPolicyError extends Error {
  constructor(readonly policy: keyof BrokerPolicies) {
    super(`broker: refusing to build without its ${BROKER_POLICY_NAMES[policy]} (${policy})`)
    this.name = 'MissingBrokerPolicyError'
  }
}

const BROKER_POLICY_NAMES: Readonly<Record<keyof BrokerPolicies, string>> = {
  protectedPaths: 'protected-path policy',
  launchRecords: 'launch-record verifier',
  roles: 'role policy'
}

function assertBrokerPolicies(policies: BrokerPolicies | undefined): BrokerPolicies {
  if (typeof policies?.protectedPaths?.isProtected !== 'function') throw new MissingBrokerPolicyError('protectedPaths')
  if (typeof policies.launchRecords?.matchesRun !== 'function') throw new MissingBrokerPolicyError('launchRecords')
  if (
    !Array.isArray(policies.roles?.recognizedRoles) ||
    !Array.isArray(policies.roles?.workerRoles) ||
    typeof policies.roles?.surfaceOwner !== 'string'
  ) {
    throw new MissingBrokerPolicyError('roles')
  }
  return policies
}

function operationEvent(
  operation: string,
  target: string | null,
  result: 'ok' | 'refused' | 'error',
  errorClass: string | null
): LogEventInput {
  return { kind: 'operation', event: 'completed', payload: {}, operation, target, result, error_class: errorClass }
}

// --- invocation context (O1) ------------------------------------------------

/**
 * The two grantable invocation channels this broker authorizes
 * (`isolation.md` §1): the Worker channel, for a dispatched child whose role
 * the role policy maps to it, and the task-tool seat's channel. Every other
 * party never requests an effect through here: a read-only child holds no
 * forge-write grant at all, and the trusted process CALLS this module rather
 * than being granted by it.
 */
export type BrokerRole = 'worker' | 'operator'

/** A role the role policy maps to the Worker channel. Every other recognized role is a real role that simply holds no Worker grant. */
function brokerRoleFor(roles: BrokerRolePolicy, role: string): BrokerRole | undefined {
  return roles.workerRoles.includes(role) ? 'worker' : undefined
}

/** Whether `value` is in the role policy's closed vocabulary at all. */
function isRecognizedRole(roles: BrokerRolePolicy, value: string | undefined): value is string {
  return value !== undefined && roles.recognizedRoles.includes(value)
}

/** Thrown by both `authenticate*Invocation` functions — an invocation context that cannot be trusted is refused before any grant is even looked up, never defaulted to the least-privileged role silently (silently downgrading would hide a forged claim rather than surfacing it). */
export class ForgedInvocationError extends Error {
  constructor(readonly reason: string) {
    super(`broker: refusing to authenticate invocation context — ${reason}`)
    this.name = 'ForgedInvocationError'
  }
}

/**
 * Runtime brand, set only by `mintInvocationContext` below and read only by
 * `assertAuthenticatedContext` — never exported, so no file outside this
 * module can name the key at all, whether by typing an object literal as
 * `InvocationContext`, casting one with `as`, or building the shape in
 * plain JS with no TypeScript in the picture. `requestEffect` refuses any
 * context missing a `true` value here before `context.role` is ever looked
 * up in the grant table — a hand-declared `{ role: 'operator', task: N }`
 * object, however it was typed, is never mistaken for an authenticated one.
 */
const CONTEXT_BRAND: unique symbol = Symbol('broker.InvocationContext')

export type InvocationContext = {
  role: BrokerRole
  task: number
  readonly [CONTEXT_BRAND]: true
}

/** The only place an `InvocationContext` is built — both `authenticate*Invocation` functions below call this, nothing else does. */
function mintInvocationContext(role: BrokerRole, task: number): InvocationContext {
  const context = { role, task } as InvocationContext
  Object.defineProperty(context, CONTEXT_BRAND, { value: true, enumerable: false })
  return context
}

/** Refuses a context that was never minted by `mintInvocationContext` — a hand-built `{role, task}` object, however it was typed or cast, carries no value at this key and is refused here before any grant is looked up. */
function assertAuthenticatedContext(context: InvocationContext): void {
  if (context[CONTEXT_BRAND] !== true) {
    throw new ForgedInvocationError(
      'invocation context was not produced by authenticateWorkerInvocation/authenticateOperatorInvocation'
    )
  }
}

function assertPositiveTaskId(task: number, raw: unknown): number {
  if (!Number.isInteger(task) || task <= 0) {
    throw new ForgedInvocationError(`task id ${JSON.stringify(raw)} is not a positive integer`)
  }
  return task
}

/**
 * Authenticates a Worker's invocation context from the SAME attribution
 * variables the role launcher sets on every spawned child's own environment
 * (`VINAYA_ROLE`/`VINAYA_TASK`/`VINAYA_RUN_ID`) — never a value the caller
 * passes as a function argument, since an argument is exactly the
 * self-asserted claim `task-tools/router.ts`'s own module doc says
 * authenticates nothing. Only a role the role policy maps to the Worker
 * channel is grantable; anything else — a forged role outside the policy's
 * closed set, a real but ungranted role, a missing or empty value — is
 * refused.
 *
 * `VINAYA_ROLE` and `VINAYA_TASK` both come from the SAME caller-controlled
 * environment a compromised or merely buggy Worker can set to anything
 * (this module's own header doc) — accepting `VINAYA_TASK` at face value
 * would let a Worker genuinely dispatched for one task claim any other
 * task id and satisfy every downstream task-binding check with a forged
 * value. The launch-record verifier closes that: it looks for a launch
 * record the trusted launcher itself wrote, before this child was ever
 * spawned, naming the presented `(runId, role, task)` triple exactly — a
 * forged task finds no such record (the real one sits at the child's true
 * task), so the claim is refused before a grant is ever checked. `runId`
 * is the launcher's own generated identifier, never a value the child
 * chooses.
 */
function authenticateWorkerInvocation(
  policies: BrokerPolicies,
  env: Readonly<Record<string, string | undefined>>,
  logEvent: BrokerLogEvent = defaultLogEvent
): InvocationContext {
  try {
    const role = env.VINAYA_ROLE
    if (!isRecognizedRole(policies.roles, role)) {
      throw new ForgedInvocationError(
        `VINAYA_ROLE ${JSON.stringify(role ?? null)} is not a recognized dispatched role at all`
      )
    }
    const mapped = brokerRoleFor(policies.roles, role)
    if (mapped === undefined) {
      throw new ForgedInvocationError(
        `VINAYA_ROLE ${JSON.stringify(role)} does not map to a broker-grantable Worker role`
      )
    }
    const taskRaw = env.VINAYA_TASK
    const task = taskRaw === undefined ? Number.NaN : Number.parseInt(taskRaw, 10)
    const validTask = assertPositiveTaskId(task, taskRaw ?? null)

    const runId = env.VINAYA_RUN_ID
    if (runId === undefined || runId.trim().length === 0) {
      throw new ForgedInvocationError('no VINAYA_RUN_ID on this invocation — cannot cross-check the claimed task')
    }
    if (!policies.launchRecords.matchesRun(runId, role, validTask)) {
      throw new ForgedInvocationError(
        `no launch record names run ${JSON.stringify(runId)} as role ${JSON.stringify(role)} for task ${validTask} — the claimed task does not match what dispatchRole actually launched this child for`
      )
    }
    logEvent(operationEvent('authenticate-invocation', `task:${validTask}`, 'ok', null))
    return mintInvocationContext(mapped, validTask)
  } catch (err) {
    logEvent(
      operationEvent(
        'authenticate-invocation',
        null,
        'refused',
        err instanceof Error ? err.constructor.name : 'UnknownError'
      )
    )
    throw err
  }
}

/**
 * Authenticates an Operator's invocation context through the SAME channel
 * `task-tools/server.ts` already authenticates an Operator's MCP session
 * with — `VINAYA_MCP_CALLER` — rather than a second identity scheme: this
 * module holds one broker and one grant table, and inventing a parallel
 * Operator credential here would be exactly the second table that sizing
 * constraint rules out. `task` is the task the Operator's request
 * names (its own `task_start`/`task_status` argument) — not read from this
 * env, since an Operator's channel carries no per-dispatch `VINAYA_TASK`.
 */
export function authenticateOperatorInvocation(
  env: Readonly<Record<string, string | undefined>>,
  task: number,
  logEvent: BrokerLogEvent = defaultLogEvent
): InvocationContext {
  try {
    const callerId = env.VINAYA_MCP_CALLER
    if (callerId === undefined || callerId.trim().length === 0) {
      throw new ForgedInvocationError('no VINAYA_MCP_CALLER on this invocation — the Operator channel requires one')
    }
    const context = mintInvocationContext('operator', assertPositiveTaskId(task, task))
    logEvent(operationEvent('authenticate-invocation', `task:${context.task}`, 'ok', null))
    return context
  } catch (err) {
    logEvent(
      operationEvent(
        'authenticate-invocation',
        null,
        'refused',
        err instanceof Error ? err.constructor.name : 'UnknownError'
      )
    )
    throw err
  }
}

// --- operations and the grant table (O2, O3) --------------------------------

/**
 * Branch and change operations — what O2 calls "required branch and change
 * operations." `branch-lease-push` is the force-with-lease push of the task's
 * own branch after the driver rebased it onto the default branch; only the
 * driver's own publication code requests it (no agent tool names it), and
 * `requestEffect` refuses it for any target outside `refs/heads/task/`.
 */
export const WORKER_OPERATIONS = ['branch-push', 'branch-lease-push', 'pr-open', 'pr-comment'] as const
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
 * human owner's own forge-identity-gated channel (`forge-write.ts`), a
 * DIFFERENT authenticated channel than this
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
    readonly target: string
  ) {
    super(`broker: target ${JSON.stringify(target)} is not scoped to the invocation's own task ${task}`)
    this.name = 'UnboundTargetError'
  }
}

/**
 * Every target this broker will act on MUST name its own task explicitly,
 * as a `<task>:` prefix — a caller never gets to supply a bare identity
 * string (a branch name, a PR ref) and a SEPARATE numeric task field the
 * broker trusts without cross-checking the two against each other. A
 * separate `targetTask` field, checked only against `context.task` and
 * never against `target`'s own text, is exactly how a request naming a
 * DIFFERENT task's branch or PR could still pass the binding check as long
 * as its numeric field happened to match — found on review. Folding the
 * task into `target` itself, and parsing it back out here, makes "which
 * task does this write belong to" answerable only one way.
 */
export function scopeTarget(task: number, identity: string): string {
  return `${task}:${identity}`
}

const SCOPED_TARGET = /^(\d+):(.*)$/

/** Parses a `scopeTarget`-shaped string back into its task and identity halves, or refuses — never returns a partial/best-effort parse. */
function assertTargetScopedToTask(task: number, target: string): void {
  const match = SCOPED_TARGET.exec(target)
  if (match === null || Number.parseInt(match[1] as string, 10) !== task) {
    throw new UnboundTargetError(task, target)
  }
}

export class LeasePushTargetError extends Error {
  constructor(readonly target: string) {
    super(
      `broker: refusing a 'branch-lease-push' to ${JSON.stringify(target)} — a lease push may only target the task's own refs/heads/task/ branch`
    )
    this.name = 'LeasePushTargetError'
  }
}

/** A lease push rewrites a ref, so its target identity must be a task branch — never the default branch or any other ref, whatever task prefix it carries. */
function assertLeasePushTarget(operation: string, target: string): void {
  if (operation !== 'branch-lease-push') return
  const identity = SCOPED_TARGET.exec(target)?.[2] ?? ''
  if (!identity.startsWith('refs/heads/task/') || identity.includes('..')) throw new LeasePushTargetError(target)
}

export class ProtectedPathError extends Error {
  /** `surfaceOwner` is the role policy's name for who widens a task's Surface, as the refusal prints it. */
  constructor(
    readonly path: string,
    surfaceOwner: string
  ) {
    super(
      `broker: refusing an operation that touches a protected administrative policy path: ${path} — the task's Surface does not cover it; ${surfaceOwner} must add the path to the task's Surface`
    )
    this.name = 'ProtectedPathError'
  }
}

/** Normalizes each touched path first, then asks the protected-path policy about the normalized form — never the raw one. */
function assertNoProtectedPaths(
  policies: BrokerPolicies,
  paths: readonly string[] | undefined,
  surfaceCoversPath: ((path: string) => boolean) | undefined
): void {
  for (const path of paths ?? []) {
    const normalized = normalizeTouchedPath(path)
    if (policies.protectedPaths.isProtected(normalized) && !surfaceCoversPath?.(normalized))
      throw new ProtectedPathError(path, policies.roles.surfaceOwner)
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
  /** Build with `scopeTarget(task, identity)` — the task MUST be encoded in this string itself and is parsed back out (`assertTargetScopedToTask`), never trusted from a separate numeric field a caller could set inconsistently with the identity it names. Passed through to `EffectIdentity.target` unchanged. */
  target: string
  /** `EffectIdentity.inputVersion` — see `assertNoReplayedInputVersion`. */
  inputVersion: number
  /** Repo-relative paths this operation would touch, when applicable (a `branch-push`'s changed files) — each normalized, then checked against the protected-path policy regardless of role or grant, unless `surfaceCoversPath` accepts the path. */
  touchedPaths?: readonly string[]
  /** Given a normalized protected path, `true` only when the task's frozen Surface names it. Absent (or no resolvable Surface) keeps every protected path refused; supplied by the driver from the task Issue, never from anything the agent writes. */
  surfaceCoversPath?: (path: string) => boolean
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
function requestEffect(
  policies: BrokerPolicies,
  deps: ControlStoreDeps,
  context: InvocationContext,
  request: BrokerEffectRequest,
  logEvent: BrokerLogEvent = defaultLogEvent
): string {
  try {
    assertAuthenticatedContext(context)
    assertGranted(context.role, request.operation)
    assertTargetScopedToTask(context.task, request.target)
    assertLeasePushTarget(request.operation, request.target)
    assertNoProtectedPaths(policies, request.touchedPaths, request.surfaceCoversPath)
    assertNoReplayedInputVersion(deps, context.task, request.key, request.inputVersion)
  } catch (err) {
    logEvent(
      operationEvent(
        request.operation,
        request.target,
        'refused',
        err instanceof Error ? err.constructor.name : 'UnknownError'
      )
    )
    throw err
  }
  // O1's "authorization" outcome — the four checks above all passed, before
  // the effect executor's own `attempted`/`observed`/`verified` sequence
  // (`effects.ts`) picks up the write itself.
  logEvent(operationEvent(request.operation, request.target, 'ok', null))

  // Publishing the same commit is the same intent even after the driver advances its round.
  // Keep the durable identity so an interrupted push is reconciled before any poster can run.
  const existing = readEffect(deps, context.task, request.key)
  const payloadDigest = sha256Hex(request.payload)
  const publication = request.operation === 'branch-push' || request.operation === 'branch-lease-push'
  const inputVersion =
    publication &&
    existing.status === 'ok' &&
    existing.value.operation === request.operation &&
    existing.value.target === request.target &&
    existing.value.payloadDigest === payloadDigest
      ? existing.value.inputVersion
      : request.inputVersion

  const ownerId = `broker:${context.task}:${context.role}:${request.operation}:${request.key}`
  const executor = createEffectExecutor(deps, context.task, ownerId, logEvent)
  return executor.execute({
    key: request.key,
    identity: {
      operation: request.operation,
      target: request.target,
      inputVersion,
      payloadDigest
    },
    poster: request.poster,
    reconcile: request.reconcile
  })
}

// --- building a broker -------------------------------------------------------

/** A broker bound to its policies: the Worker authentication that reads the role policy and launch-record verifier, and the effect request that reads the protected-path policy. */
export type Broker = {
  authenticateWorkerInvocation: (
    env: Readonly<Record<string, string | undefined>>,
    logEvent?: BrokerLogEvent
  ) => InvocationContext
  authenticateOperatorInvocation: typeof authenticateOperatorInvocation
  requestEffect: (
    deps: ControlStoreDeps,
    context: InvocationContext,
    request: BrokerEffectRequest,
    logEvent?: BrokerLogEvent
  ) => string
}

/**
 * Builds a broker from the policies the process supplies. Every policy is
 * required: a missing or malformed one is refused here
 * (`MissingBrokerPolicyError`, naming it), so no broker ever runs with no
 * protected-path check, no launch-record cross-check or no role set.
 */
export function createBroker(policies: BrokerPolicies): Broker {
  const bound = assertBrokerPolicies(policies)
  return {
    authenticateWorkerInvocation: (env, logEvent) => authenticateWorkerInvocation(bound, env, logEvent),
    authenticateOperatorInvocation,
    requestEffect: (deps, context, request, logEvent) => requestEffect(bound, deps, context, request, logEvent)
  }
}

// Re-exported so a caller that needs to pre-check ownership (rather than
// let `requestEffect` surface a mid-flight `StaleEpochWriteError`) has the
// same primitive `effects.ts`'s own callers already use — never a second,
// broker-local reimplementation of epoch acquisition.
export { acquireOwnership }
