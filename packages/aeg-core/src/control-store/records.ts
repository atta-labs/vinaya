/**
 * Versioned control-store record schemas. Four record
 * kinds — run, input, ownership, transition — each `.strict()` and
 * carrying its own `version` literal, the same discipline
 * `packages/aeg-core/src/log/schema.ts` already uses for the Vinaya Log.
 *
 * `parse*Record` is the one thing every storage implementation must route
 * a read through: it returns a three-way `ParsedRecord<T>` rather than a
 * nullable value, because a nullable read cannot tell "no record was ever
 * written" apart from "a record exists but is corrupt" — the exact defect
 * class the pid-lock/pause-state/effect-record side files this store
 * replaces all share (`JSON.parse` wrapped in `catch { return null }`,
 * indistinguishable from absence). An unknown `version` or torn/invalid
 * JSON both resolve to `'corrupt'`, never `'absent'` and never a thrown
 * exception — a caller that must special-case "nothing here yet" from
 * "something here I can't trust" gets to do so honestly.
 *
 * Pure — no `fs`, no clock, no process access. `local.ts` is the one
 * storage implementation that turns disk bytes (or their absence) into the
 * `raw: string | undefined` these parsers accept.
 */

import { z } from 'zod'

export const CONTROL_RECORD_VERSION = 1 as const

const isoTimestamp = z.string().min(1)
const taskId = z.number().int().positive()
const epochNumber = z.number().int().nonnegative()

/**
 * One execution attempt against a task — written once, at start, immutable
 * thereafter. `childStartedAt`/`childCommand` are the same process-identity
 * pair `apps/cli/src/lib/dispatch.ts`'s `LaunchRecord` already captures for
 * a dispatched role's child — reused
 * here, under the identical field names, so `matchesCapturedIdentity` (which
 * only requires `Pick<LaunchRecord, 'childStartedAt' | 'childCommand'>`)
 * applies to a controller's own run record unchanged. `.optional()` since a
 * `run` record written before this task carries neither — a reader falls
 * back to "nothing captured, nothing to fail closed on" exactly as
 * `matchesCapturedIdentity` already does for a pre-existing `LaunchRecord`.
 */
export const RunRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('run'),
    task: taskId,
    runId: z.string().min(1),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    startedAt: isoTimestamp,
    childStartedAt: z.string().min(1).nullable().optional(),
    childCommand: z.string().min(1).nullable().optional()
  })
  .strict()
export type RunRecord = z.infer<typeof RunRecordSchema>

/**
 * What began or resumed a run — a fresh dispatch or a `--resume` against a
 * known PR — recorded so a later reader can tell what a run was actually
 * told to do, distinct from the transitions it went on to produce.
 */
export const InputRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('input'),
    task: taskId,
    runId: z.string().min(1),
    source: z.union([z.literal('fresh'), z.literal('resume')]),
    pr: z.number().int().positive().nullable(),
    round: z.number().int().nonnegative(),
    recordedAt: isoTimestamp
  })
  .strict()
export type InputRecord = z.infer<typeof InputRecordSchema>

/**
 * The fencing token: which epoch is current for a task, and who holds it.
 * Immutable per epoch once validly written — `local.ts` never overwrites an
 * `ownership/epoch-<n>.json` file, only creates the next one.
 */
export const OwnershipRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('ownership'),
    task: taskId,
    epoch: epochNumber,
    ownerId: z.string().min(1),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    acquiredAt: isoTimestamp
  })
  .strict()
export type OwnershipRecord = z.infer<typeof OwnershipRecordSchema>

/** One state change, stamped with the epoch that produced it — the durable history a resume/audit reads back. */
export const TransitionRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('transition'),
    task: taskId,
    epoch: epochNumber,
    seq: z.number().int().nonnegative(),
    from: z.string().min(1),
    to: z.string().min(1),
    detail: z.string().optional(),
    at: isoTimestamp
  })
  .strict()
export type TransitionRecord = z.infer<typeof TransitionRecordSchema>

/**
 * The review-input manifest a round was dispatched against, persisted
 * durably — the record the "Deferred, deliberately" paragraph in `loop.md`
 * named as waiting for this store: base
 * identity and a durable policy history now have a home. One immutable
 * snapshot per (task, round), built by the parent before it dispatches
 * reviewers, binding the complete identity of everything a verdict is judged
 * against: repository and work (the PR/branch this round belongs to), base and
 * candidate (`baseSha`/`headSha`), instruction and criteria versions
 * (`briefHash`/`objectivesVersion`), rulings (`rulingOrdinal`), and the
 * complete effective policy identity (`policyDigest`, which folds in the
 * round-policy field). `baseSha`/`briefHash`/`objectivesVersion` are nullable
 * exactly where the manifest itself is (`review-input-manifest.ts`'s own
 * `null` = "nothing resolvable to bind against"); `rulingOrdinal`/
 * `policyDigest` are never null, the same as on the manifest.
 */
export const ManifestRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('manifest'),
    task: taskId,
    round: epochNumber,
    /** Repository identity — `owner/repo`. */
    repository: z.string().min(1),
    /** Work identity — the PR this round's candidate lives on. */
    pr: z.number().int().positive(),
    /** Work identity — the branch under review. */
    branch: z.string().min(1),
    /** Base identity — the commit the candidate is judged against; `null` when none was resolvable. */
    baseSha: z.string().min(1).nullable(),
    /** Candidate identity — the round's judged head. */
    headSha: z.string().min(1),
    /** Instruction version — the frozen brief's hash; `null` when none was resolvable. */
    briefHash: z.string().min(1).nullable(),
    /** Criteria version — the objectives version; `null` pre-cutover or when none resolvable. */
    objectivesVersion: z.string().min(1).nullable(),
    /** Rulings — the newest principal ruling ordinal at dispatch (`0` when none). */
    rulingOrdinal: epochNumber,
    /** Policy identity — the complete effective review policy's digest. */
    policyDigest: z.string().min(1),
    recordedAt: isoTimestamp
  })
  .strict()
export type ManifestRecord = z.infer<typeof ManifestRecordSchema>

/** A round's identity — which round, on which head — shared by `heldResult` and `deliveredFindings` below. */
const roundHeadIdentity = z.object({ round: z.number().int().positive(), head: z.string().min(1) }).strict()
export type RoundHeadIdentity = z.infer<typeof roundHeadIdentity>

export const LoopBudgetsSchema = z
  .object({
    /** The mechanical gate-red/conflict-retry stall bound (`MAX_GATE_STALLED_TURNS` in `apps/cli`) — consecutive developer turns that produced no push on one head. */
    mechanicalRetries: z.number().int().nonnegative(),
    /** The substantive review-round count — bounded by `ReviewPolicy.maxRounds`. */
    reviewRounds: z.number().int().nonnegative(),
    /** The cumulative count of `'infrastructure'`/`'stale_driver'` pauses this task has ever hit — never reset by a restart, unlike the in-memory counters above (`apps/cli/specs/loop.md`). */
    infrastructureRetries: z.number().int().nonnegative()
  })
  .strict()
export type LoopBudgets = z.infer<typeof LoopBudgetsSchema>

/**
 * The dev-review-loop's own authoritative recovery record — phase, round,
 * budgets, held-result and delivered-findings identity, written by the driver
 * (`apps/cli/src/lib/dev-review-loop/round-assess.ts`'s `persistLoopState`)
 * on every round transition and read back on start, attach and resume
 * (`pause-resume.ts`'s `recoverLoopState`), replacing the driver's prior
 * reliance on the task's optional, forge-flushed event history for round-
 * number and budget recovery. One record per task, overwritten in place —
 * deliberately NOT epoch-fenced, the same precedent `ManifestRecordSchema`
 * sets: the driver's own cutover to acquired-epoch ownership over this
 * task's mutable state is separate, later adoption work (`loop.md`); this
 * record's real concurrency guard is still the pid-lock one-driver-per-task
 * check the driver already runs before touching anything.
 */
export const LoopStateRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('loop_state'),
    task: taskId,
    round: z.number().int().positive(),
    /** Mirrors `Decision['type']` (`packages/aeg-core/src/dev-review-loop/types.ts`) — a plain string here so this record stays independent of that package's own type, the same discipline `TransitionRecord.from`/`to` already uses for state names. */
    phase: z.string().min(1),
    /** Set only while `phase === 'pause'`. */
    pauseReason: z.string().min(1).nullable(),
    budgets: LoopBudgetsSchema,
    /** The round whose verdict is currently held on disk, awaiting delivery or publish — `null` once nothing is held. */
    heldResult: roundHeadIdentity.nullable(),
    /** The round+head whose findings have already been delivered to the developer once — `null` until a delivery happens; read back so a later attach never redelivers the same (round, head) pair. */
    deliveredFindings: roundHeadIdentity.nullable(),
    recordedAt: isoTimestamp
  })
  .strict()
export type LoopStateRecord = z.infer<typeof LoopStateRecordSchema>

/**
 * One external effect's identity and reconciliation state, keyed by a
 * caller-chosen `key` (one file per key, overwritten in place as the
 * effect's status advances — unlike `run`/`input`, which are written once).
 * `operation`/`target`/`inputVersion`/`payloadDigest` together are the
 * identity `apps/cli/src/lib/effects.ts`'s `EffectExecutor` binds a write
 * to before ever attempting it: a later read finding a DIFFERENT identity
 * under the same `key` is a changed intent, not a retry of this one.
 * `'started'` — intent persisted, the external write has not yet been
 * confirmed. `'verified'` — either the write's own return value was
 * recorded (`url` present), or a recovery reconciled this identity against
 * the remote and found it already landed. `'uncertain'` — a recovery could
 * not reconcile (the remote read itself failed) — refused rather than
 * blindly retried, until a later recovery attempt resolves it.
 */
export const EffectRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('effect'),
    task: taskId,
    key: z.string().min(1),
    operation: z.string().min(1),
    target: z.string().min(1),
    inputVersion: z.number().int().nonnegative(),
    payloadDigest: z.string().min(1),
    status: z.union([z.literal('started'), z.literal('verified'), z.literal('uncertain')]),
    url: z.string().optional(),
    recordedAt: isoTimestamp
  })
  .strict()
export type EffectRecord = z.infer<typeof EffectRecordSchema>
export type EffectStatus = EffectRecord['status']

/**
 * Everything a paused run's human decision needs without chat history
 * (O1) — one immutable record per pause instance, keyed by `escalationId`
 * (`<task>-<round>-<head>`, the same
 * round+head granularity `pause-resume.ts`'s own pause-comment idempotency
 * key already uses, since two real pauses are told apart the identical way).
 * `runId`/`pid`/`host` are the run identity; `briefHash`/`objectivesVersion`/
 * `rulingOrdinal`/`policyDigest` are the input versions the round was
 * judged against (the same four fields `ManifestRecord` binds a verdict to,
 * reused here to bind an ESCALATION to instead); `evidence` is the last
 * round's held verdict text or the pause's own `detail`, whichever the
 * caller had in hand; `attemptedRecovery`/`recipient` come from the fixed
 * per-`reason` profile `pause-resume.ts` owns. `pr` is nullable for the one
 * pre-push escalation shape (`renderNoPushStopComment`) that has no PR yet.
 * `agent` is the vendor this run was actually dispatched under (code review,
 * round 2, MAJOR: `cancelDevReviewLoop` used to trust the operator-typed
 * `--agent` flag with nothing persisted to cross-check it against) —
 * `.optional()` since an escalation record written before this field existed
 * never carries it; a reader falls back to the operator-supplied value only
 * for that legacy case, never for a genuine mismatch.
 */
export const EscalationRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('escalation'),
    task: taskId,
    escalationId: z.string().min(1),
    round: epochNumber,
    head: z.string().min(1),
    branch: z.string().min(1),
    pr: z.number().int().positive().nullable(),
    runId: z.string().min(1),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    agent: z.string().min(1).optional(),
    reason: z.string().min(1),
    detail: z.string().optional(),
    evidence: z.string().optional(),
    attemptedRecovery: z.string().min(1),
    requestedDecision: z.string().min(1),
    recipient: z.string().min(1),
    briefHash: z.string().min(1).nullable(),
    objectivesVersion: z.string().min(1).nullable(),
    rulingOrdinal: epochNumber,
    policyDigest: z.string().min(1),
    recordedAt: isoTimestamp
  })
  .strict()
export type EscalationRecord = z.infer<typeof EscalationRecordSchema>

/**
 * The authenticated human decision an escalation resolves to — `'resume'`
 * or `'cancel'` — written AT MOST ONCE per `escalationId` (`local.ts`'s
 * `consumeResolutionOnce` claims the file exclusively, the same `linkSync`
 * discipline an ownership epoch uses, so a second attempt at the SAME
 * `escalationId` collides rather than overwriting: single consumption is a
 * storage guarantee here, not an application-level check). `authenticatedBy`
 * is the principal login the decision was authenticated against (or
 * `'driver-self'` for the two recoverable-hiccup reasons that resume without
 * a ruling); `authenticatedFrom` names the ruling marker (`<pr>-<k>`) or the
 * self-recovery tag it came from.
 */
export const ResolutionRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('resolution'),
    task: taskId,
    escalationId: z.string().min(1),
    decision: z.union([z.literal('resume'), z.literal('cancel')]),
    authenticatedBy: z.string().min(1),
    authenticatedFrom: z.string().min(1),
    consumedAt: isoTimestamp
  })
  .strict()
export type ResolutionRecord = z.infer<typeof ResolutionRecordSchema>

export type ControlRecord =
  | RunRecord
  | InputRecord
  | OwnershipRecord
  | TransitionRecord
  | ManifestRecord
  | LoopStateRecord
  | EffectRecord
  | EscalationRecord
  | ResolutionRecord

/**
 * `'absent'` — nothing was ever written at this path.
 * `'corrupt'` — something was written, but it doesn't parse as this record:
 * torn JSON, a schema violation, or (since `version` is a closed literal)
 * an unsupported version. Never conflated with `'absent'`.
 */
export type ParsedRecord<T> = { status: 'ok'; value: T } | { status: 'absent' } | { status: 'corrupt'; reason: string }

function parseWith<T>(schema: z.ZodType<T>, raw: string | undefined): ParsedRecord<T> {
  if (raw === undefined) return { status: 'absent' }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return {
      status: 'corrupt',
      reason: `invalid JSON (torn write?): ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.join('.') || '(root)'
    return { status: 'corrupt', reason: `${path}: ${issue?.message ?? 'schema violation'}` }
  }
  return { status: 'ok', value: parsed.data }
}

export function parseRunRecord(raw: string | undefined): ParsedRecord<RunRecord> {
  return parseWith(RunRecordSchema, raw)
}

export function parseInputRecord(raw: string | undefined): ParsedRecord<InputRecord> {
  return parseWith(InputRecordSchema, raw)
}

export function parseOwnershipRecord(raw: string | undefined): ParsedRecord<OwnershipRecord> {
  return parseWith(OwnershipRecordSchema, raw)
}

export function parseTransitionRecord(raw: string | undefined): ParsedRecord<TransitionRecord> {
  return parseWith(TransitionRecordSchema, raw)
}

export function parseManifestRecord(raw: string | undefined): ParsedRecord<ManifestRecord> {
  return parseWith(ManifestRecordSchema, raw)
}

export function parseLoopStateRecord(raw: string | undefined): ParsedRecord<LoopStateRecord> {
  return parseWith(LoopStateRecordSchema, raw)
}

export function parseEffectRecord(raw: string | undefined): ParsedRecord<EffectRecord> {
  return parseWith(EffectRecordSchema, raw)
}

export function parseEscalationRecord(raw: string | undefined): ParsedRecord<EscalationRecord> {
  return parseWith(EscalationRecordSchema, raw)
}

export function parseResolutionRecord(raw: string | undefined): ParsedRecord<ResolutionRecord> {
  return parseWith(ResolutionRecordSchema, raw)
}
