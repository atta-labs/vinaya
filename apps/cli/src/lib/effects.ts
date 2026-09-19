/**
 * The shared effect executor — replaces
 * `dev-review-loop/publication.ts`'s `postForgeEffectOnce`'s own local
 * `ForgeEffectRecord` file for the two writers migrated onto it
 * (`publication.ts`'s `publishRound`, `pause-resume.ts`'s pause posts).
 * `postForgeEffectOnce`'s bug: it trusts a local `'posted'` flag alone: a
 * process that dies between the forge accepting a write and that flag
 * landing leaves the record at `'started'`, and the next attempt reposts —
 * remote success followed by a lost local acknowledgement duplicates the
 * write.
 *
 * `EffectExecutor` closes this by persisting an effect's identity —
 * `operation`, `target`, `inputVersion`, `payloadDigest` — through
 * `@attalabs/aeg-core`'s control store BEFORE ever calling the poster
 * (O1), and, on finding a prior `'started'` record at the SAME identity,
 * reconciling against the remote before doing anything else (O2): a
 * caller-supplied `reconcile` either confirms the write already landed (no
 * repost), confirms it is genuinely absent (safe to post now, completing
 * the interrupted attempt), or cannot tell — recorded `'uncertain'` and
 * refused, never blindly retried. A DIFFERENT identity found under the same
 * `key` is a changed intent, not a retry of the old one, and is posted
 * fresh with no reconciliation at all (O3's "changed payload → new
 * identity" — a marker alone is insufficient once its target or content
 * differs). Every write is fenced by the caller's control-store epoch —
 * `StaleEpochWriteError` propagates unchanged from a caller who no longer
 * holds it (O3's "stale ownership rejected").
 *
 * This is a distinct mechanism from the Vinaya Log's own `effect` event
 * family (`apps/cli/specs/log.md`, "the spec's 'shared effect executor'"):
 * that family is fail-open telemetry — an `attempted`/`observed`/`verified`
 * OBSERVATION that never blocks anything — while this is the fail-closed
 * durable control store this module is built on. Neither replaces the other.
 */

import { createHash } from 'node:crypto'
import { acquireOwnership, type ControlStoreDeps, readEffect, writeEffect } from '@attalabs/aeg-core'
import { log as logEvent, type LogEventInput } from './log-sink.js'
import { runtimeDirForThisRepo, tasksExecutionRoot } from './run-paths.js'

/**
 * The control store's one root: the directory holding one folder per task
 * (`run-paths.ts`'s `tasksExecutionRoot`). The store appends the task and
 * its own `control/` segment itself, so a task's records land beside its
 * session records, its raw output and its per-round reviewer files rather
 * than in a tree of their own.
 *
 * There used to be TWO roots — this one, and a second that
 * `dev-review-loop/reviewer-dispatch.ts` derived from the telemetry outbox
 * — so a manifest record and an ownership epoch for the same task could sit
 * in different places on disk. They are one root now; no record's own
 * filename, content or version changed in the process.
 */
export function controlStoreRoot(): string {
  return tasksExecutionRoot(runtimeDirForThisRepo())
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** What one external effect is: the operation, its target, the input version it was derived from, and a digest of the exact payload — the four facts a retry must reconcile before it is allowed to repeat a write. */
export type EffectIdentity = {
  operation: string
  target: string
  inputVersion: number
  payloadDigest: string
}

/**
 * `'confirmed'` — the remote already carries this exact identity; the URL
 * it can be found at. `'absent'` — the remote was read successfully and
 * genuinely does not carry it; safe to post now. `'ambiguous'` — the remote
 * could not be read (or its content could not be trusted); the caller
 * cannot tell, so the effect stays `'uncertain'` rather than retrying
 * blind.
 */
export type EffectReconcileResult =
  | { outcome: 'confirmed'; url: string }
  | { outcome: 'absent' }
  | { outcome: 'ambiguous'; reason: string }

export type EffectReconciler = (identity: EffectIdentity) => EffectReconcileResult

/** Thrown when a prior attempt at this identity recorded (or a reconciliation just produced) an `'uncertain'` outcome — the effect is refused, not retried, until something outside this executor resolves it (a later reconciliation attempt, or a Principal's own read of the target). */
export class EffectRetryRefusedError extends Error {
  constructor(
    readonly task: number,
    readonly key: string,
    readonly reason: string
  ) {
    super(`effects: refusing to retry '${key}' for task ${task} — a prior attempt's outcome is uncertain: ${reason}`)
    this.name = 'EffectRetryRefusedError'
  }
}

export type EffectExecuteInput = {
  /** One control-store file per key — the same key on a rerun is what lets this executor find (and reconcile) a prior attempt at all. */
  key: string
  identity: EffectIdentity
  /** Performs the real external write and returns its URL. Called at most once per genuinely new identity. */
  poster: () => string
  /** Consulted only when a prior `'started'` record at the SAME identity is found — never on a fresh key, never on a changed identity. */
  reconcile: EffectReconciler
}

function sameIdentity(a: EffectIdentity, b: EffectIdentity): boolean {
  return (
    a.operation === b.operation &&
    a.target === b.target &&
    a.inputVersion === b.inputVersion &&
    a.payloadDigest === b.payloadDigest
  )
}

/**
 * Builds this write's `effect` log family target (O1: "normalized ...
 * attempted, observed and verified outcomes"). `effect_id` is the
 * control-store `key` itself — the SAME idempotent identity every retry or
 * idempotent replay of this write already shares, so two log lines carrying
 * the same `effect_id` are provably the same effect observed twice, never a
 * coincidence of two unrelated writes (O3's "idempotent observation
 * identities").
 */
function effectLogTarget(
  key: string,
  identity: EffectIdentity
): { effect_id: string; target: { kind: string; ref: string } } {
  return { effect_id: key, target: { kind: identity.operation, ref: identity.target } }
}

export class EffectExecutor {
  constructor(
    private readonly deps: ControlStoreDeps,
    private readonly task: number,
    private readonly epoch: number,
    /**
     * Injectable for a test that wants to assert on the emitted sequence —
     * defaults to the real global sink every production call site relies on
     * implicitly, the same bare-singleton convention `dispatch.ts`/
     * `round-assess.ts` already use for the `dispatch`/`dev_review_loop`
     * families. Never throws (`log()`'s own contract) — a log failure never
     * fails the write it is only observing.
     */
    private readonly logEffectEvent: (e: LogEventInput) => void = logEvent
  ) {}

  execute(input: EffectExecuteInput): string {
    const { key, identity, poster, reconcile } = input
    const existing = readEffect(this.deps, this.task, key)

    if (existing.status === 'ok') {
      if (sameIdentity(existing.value, identity)) {
        return this.reconcileExisting(key, existing.value, poster, reconcile)
      }
      // A different operation/target/inputVersion/payloadDigest recorded
      // under this key: a changed intent, not a retry of the old one —
      // the old record is not evidence about THIS write, regardless of its
      // own status. Nothing to reconcile; post fresh.
      return this.postAndRecord(key, identity, poster)
    }

    if (existing.status === 'corrupt') {
      // Something is recorded but cannot be trusted — this is exactly the
      // "cannot tell" case O2 refuses to blindly replay past, so it is
      // treated the same as a reconciliation that came back ambiguous,
      // never silently as if nothing had ever been attempted — including
      // the SAME observed/uncertain log line that branch emits (round 2
      // review, MAJOR: this branch used to throw with no log event at all,
      // leaving a real refused-replay outcome invisible in the Vinaya Log).
      this.logEffectEvent({
        kind: 'effect',
        event: 'observed',
        outcome: 'uncertain',
        payload: {},
        ...effectLogTarget(key, identity)
      })
      throw new EffectRetryRefusedError(this.task, key, `existing effect record is corrupt: ${existing.reason}`)
    }

    // 'absent' — nothing was ever recorded for this key; safe to post fresh.
    return this.postAndRecord(key, identity, poster)
  }

  private reconcileExisting(
    key: string,
    recorded: {
      operation: string
      target: string
      inputVersion: number
      payloadDigest: string
      status: string
      url?: string
    },
    poster: () => string,
    reconcile: EffectReconciler
  ): string {
    if (recorded.status === 'verified') {
      if (!recorded.url) {
        throw new Error(
          `effects: '${key}' for task ${this.task} is recorded 'verified' with no url — this executor never writes that shape`
        )
      }
      // An idempotent replay of an already-completed write — no new
      // external effect happens, but O3 wants this observable too: a
      // second `log()` line at the SAME `effect_id`, reporting the SAME
      // true outcome, is what tells a reader "this ran twice and both
      // times agreed" apart from "this never ran a second time at all."
      this.logEffectEvent({
        kind: 'effect',
        event: 'verified',
        outcome: 'success',
        payload: {},
        ...effectLogTarget(key, recorded)
      })
      return recorded.url
    }
    if (recorded.status === 'uncertain') {
      this.logEffectEvent({
        kind: 'effect',
        event: 'observed',
        outcome: 'uncertain',
        payload: {},
        ...effectLogTarget(key, recorded)
      })
      throw new EffectRetryRefusedError(
        this.task,
        key,
        'a prior attempt recorded an ambiguous outcome and was never confirmed'
      )
    }

    // status === 'started' — an interrupted prior attempt at this SAME
    // identity: reconcile against the remote before doing anything.
    const identity: EffectIdentity = {
      operation: recorded.operation,
      target: recorded.target,
      inputVersion: recorded.inputVersion,
      payloadDigest: recorded.payloadDigest
    }
    const result = reconcile(identity)
    const now = this.deps.now().toISOString()
    if (result.outcome === 'confirmed') {
      writeEffect(this.deps, this.task, this.epoch, key, {
        ...identity,
        status: 'verified',
        url: result.url,
        recordedAt: now
      })
      this.logEffectEvent({
        kind: 'effect',
        event: 'observed',
        outcome: 'success',
        payload: {},
        ...effectLogTarget(key, identity)
      })
      this.logEffectEvent({
        kind: 'effect',
        event: 'verified',
        outcome: 'success',
        payload: {},
        ...effectLogTarget(key, identity)
      })
      return result.url
    }
    if (result.outcome === 'ambiguous') {
      writeEffect(this.deps, this.task, this.epoch, key, { ...identity, status: 'uncertain', recordedAt: now })
      this.logEffectEvent({
        kind: 'effect',
        event: 'observed',
        outcome: 'uncertain',
        payload: {},
        ...effectLogTarget(key, identity)
      })
      throw new EffectRetryRefusedError(this.task, key, result.reason)
    }
    // 'absent' — the intent was recorded but nothing actually landed
    // remotely: safe to actually post now, completing the interrupted
    // attempt.
    return this.postAndRecord(key, identity, poster)
  }

  private postAndRecord(key: string, identity: EffectIdentity, poster: () => string): string {
    const startedAt = this.deps.now().toISOString()
    writeEffect(this.deps, this.task, this.epoch, key, { ...identity, status: 'started', recordedAt: startedAt })
    this.logEffectEvent({ kind: 'effect', event: 'attempted', payload: {}, ...effectLogTarget(key, identity) })
    let url: string
    try {
      url = poster()
    } catch (err) {
      this.logEffectEvent({
        kind: 'effect',
        event: 'observed',
        outcome: 'failure',
        payload: {},
        ...effectLogTarget(key, identity)
      })
      throw err
    }
    this.logEffectEvent({
      kind: 'effect',
      event: 'observed',
      outcome: 'success',
      payload: {},
      ...effectLogTarget(key, identity)
    })
    const verifiedAt = this.deps.now().toISOString()
    writeEffect(this.deps, this.task, this.epoch, key, { ...identity, status: 'verified', url, recordedAt: verifiedAt })
    this.logEffectEvent({
      kind: 'effect',
      event: 'verified',
      outcome: 'success',
      payload: {},
      ...effectLogTarget(key, identity)
    })
    return url
  }
}

/** Acquires the task's next control-store epoch and returns an `EffectExecutor` bound to it — the convenience entry point every production call site uses; a unit test that wants to construct a stale epoch directly calls `acquireOwnership`/`new EffectExecutor` itself instead. */
export function createEffectExecutor(
  deps: ControlStoreDeps,
  task: number,
  ownerId: string,
  logEffectEvent: (e: LogEventInput) => void = logEvent
): EffectExecutor {
  const acquired = acquireOwnership(deps, task, ownerId)
  if (!acquired.acquired) {
    throw new Error(
      `effects: could not acquire a control-store epoch for task ${task} — epoch ${acquired.currentEpoch} is currently held by ${acquired.currentOwnerId ?? 'unknown'}`
    )
  }
  return new EffectExecutor(deps, task, acquired.epoch, logEffectEvent)
}
