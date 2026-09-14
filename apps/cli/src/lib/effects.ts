/**
 * The shared effect executor (Issue #552) — replaces
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
import { join } from 'node:path'
import { acquireOwnership, type ControlStoreDeps, readEffect, writeEffect } from '@attalabs/aeg-core'
import { GLOBAL_VINAYA_HOME } from './config.js'

/** `join(GLOBAL_VINAYA_HOME, 'control-store')` — a sibling of `outboxRoot()` (`dev-review-loop/reviewer-dispatch.ts`), never nested inside the legacy outbox tree this store replaces. */
export function controlStoreRoot(): string {
  return join(GLOBAL_VINAYA_HOME, 'control-store')
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

export class EffectExecutor {
  constructor(
    private readonly deps: ControlStoreDeps,
    private readonly task: number,
    private readonly epoch: number
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
      // never silently as if nothing had ever been attempted.
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
      return recorded.url
    }
    if (recorded.status === 'uncertain') {
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
      return result.url
    }
    if (result.outcome === 'ambiguous') {
      writeEffect(this.deps, this.task, this.epoch, key, { ...identity, status: 'uncertain', recordedAt: now })
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
    const url = poster()
    const verifiedAt = this.deps.now().toISOString()
    writeEffect(this.deps, this.task, this.epoch, key, { ...identity, status: 'verified', url, recordedAt: verifiedAt })
    return url
  }
}

/** Acquires the task's next control-store epoch and returns an `EffectExecutor` bound to it — the convenience entry point every production call site uses; a unit test that wants to construct a stale epoch directly calls `acquireOwnership`/`new EffectExecutor` itself instead. */
export function createEffectExecutor(deps: ControlStoreDeps, task: number, ownerId: string): EffectExecutor {
  const acquired = acquireOwnership(deps, task, ownerId)
  if (!acquired.acquired) {
    throw new Error(
      `effects: could not acquire a control-store epoch for task ${task} — epoch ${acquired.currentEpoch} is currently held by ${acquired.currentOwnerId ?? 'unknown'}`
    )
  }
  return new EffectExecutor(deps, task, acquired.epoch)
}
