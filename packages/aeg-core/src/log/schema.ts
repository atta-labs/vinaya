/**
 * The Vinaya Log's typed event schema (Linear "Tech spec — The Vinaya Log").
 * This module versions the envelope to `schema: 2` and widens `kind` past
 * the first three families it originally shipped with.
 *
 * Three families shipped first — `dispatch`, `dev_review_loop`, and
 * `forge_write`. This task adds six more — `gate`, `operation`,
 * `usage`, `role_attempt`, `handoff`, `effect` — and extends the
 * `dispatch` family's `verdict` outcome with severity-scale/policy-
 * treatment/confidence fields on each finding (O3). `kind` remains a
 * closed union; `command`/`tokens` stay out of scope (`command` folds into
 * `operation` above, `tokens` into `usage`).
 *
 * `meta.schema` is now a discriminated union: `1` (unchanged from before
 * this task — every field it ever had, still required, still meaning the
 * same thing) or `2` (adds `event_id`, `process_id`, `lineage`,
 * `input_versions`, `provenance` — O1's "task/run/attempt/parent lineage,
 * producer sequence, opaque role and process identifiers, input versions
 * and trust provenance") or `3` (adds `work`, `flow`, `runtime`, `source`).
 * `buildHeader` (`envelope.ts`) builds `3` for every event; `1` and `2`
 * exist so a line already on disk
 * (or a fixture recorded before this task) keeps parsing, never a schema
 * violation just because it predates these fields (O1's "compatible").
 * Absent per-field data on a `2` header is `null`, never invented — the
 * lineage/input-version identities declared here are a real producer's job
 * to fill in later; this module ships the typed slot, honestly empty until
 * then.
 *
 * `subject.role` keeps its EXISTING closed-`Role`-or-`'unattributed'`
 * meaning unchanged — it is relied on outside this module (`dispatch.ts`,
 * `commands/dispatch.ts`'s argv validation) and this task does not touch
 * it. The new `meta.actor_id` (v2 only) is the opaque, unvalidated
 * identifier O1 asks for: whatever the environment claims, never checked
 * against `ROLE_VALUES` — the two are deliberately different fields with
 * different trust levels, not a replacement of one by the other.
 *
 * One deviation from the spec, decided in a prior task's brief: the spec's
 * `subject.objectives_version` is `number`; the built form
 * hashes it to a `sha256` hex
 * string, so this schema types it `string`, superseding the spec.
 *
 * Every object here is `.strict()` — an extra key anywhere (including
 * inside `payload`) is a schema violation, not a tolerated passthrough.
 */

import { z } from 'zod'
import {
  CUSTOM_EVENT_MAX_FIELDS,
  CUSTOM_EVENT_NAME_MAX_LENGTH,
  CUSTOM_EVENT_NAME_PATTERN,
  CUSTOM_FIELD_NAME_MAX_LENGTH,
  CUSTOM_FIELD_NAME_PATTERN,
  CUSTOM_TEXT_MAX_LENGTH
} from './custom'

/**
 * The one bound shared by `gate_result_read.confidence_reason` below and the
 * parser that captures it (`parseConfidenceReply`,
 * `apps/cli/src/lib/dev-review-loop/round-assess.ts`) — exported so the
 * capture side can truncate to the exact same length rather than only
 * bounding it here: a reason captured longer than this would fail this
 * schema at write time and drop the whole event, round/head/green included.
 */
export const CONFIDENCE_REASON_MAX_LENGTH = 280

/** Every dispatchable doctrine role, spelled exactly as the spec's Role union (§5.1) — the doctrine-facing name (`code-reviewer`), not the `reviewer.md` filename `resolveDoctrineRootInfo` resolves it to. */
export const ROLE_VALUES = [
  'planner',
  'developer',
  'code-reviewer',
  'security',
  'principal',
  'archivist',
  'architect'
] as const

export const RoleSchema = z.enum(ROLE_VALUES)
export type Role = z.infer<typeof RoleSchema>

export const HOST_VALUES = ['hook', 'ci', 'cli', 'loop'] as const
export const HostSchema = z.enum(HOST_VALUES)
export type Host = z.infer<typeof HostSchema>

/**
 * Letters, digits, dot, underscore, hyphen — deliberately excludes `<`, `>`,
 * `/`, whitespace and newlines. `run_id` is spliced raw into a flush's
 * `<!-- aeg:log:<run_id>:<seq_from>-<seq_to> -->` marker (`apps/cli/specs/log.md`
 * § The flush) and is attacker-reachable via `VINAYA_RUN_ID` (a security
 * review finding) — a value carrying `-->` or a newline would close the
 * HTML comment early or break the fenced block once posted publicly.
 * Refusing it here, at write time, means an unsafe value never reaches the
 * outbox at all, rather than relying on a later reader to catch it.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

const headerMetaCore = {
  ts: z.string(),
  run_id: z.string().regex(RUN_ID_PATTERN),
  seq: z.number().int().nonnegative(),
  repo: z.string().nullable(),
  vinaya: z.string(),
  doctrine: z.string(),
  host: HostSchema,
  machine: z.string()
}

const HeaderMetaV1Schema = z
  .object({
    schema: z.literal(1),
    ...headerMetaCore
  })
  .strict()

/** Task/run/attempt/parent lineage (O1). Each identity is `null` until a real producer fills it in — declared here, enforced by a later producer. `task` is not repeated here — `subject.issue` already carries it. */
const LineageSchema = z
  .object({
    run: z.string().nullable(),
    attempt: z.number().int().nullable(),
    parent: z.string().nullable()
  })
  .strict()

/** Mirrors `review-input-manifest.ts`'s own field set (`briefHash`, `objectivesVersion`, `rulingOrdinal`, `policyDigest`) — the "input versions" O1 asks the envelope to carry, snake_cased to match every other envelope field. Independent of `subject.objectives_version` (kept, unchanged, for backward compatibility); a producer may set either, both, or neither. */
const InputVersionsSchema = z
  .object({
    objectives_version: z.string().nullable(),
    brief_hash: z.string().nullable(),
    ruling_ordinal: z.number().int().nullable(),
    policy_digest: z.string().nullable()
  })
  .strict()

/**
 * Trust ordering the spec names explicitly: parent-generated dispatch/effect
 * attribution is stronger than worker-controlled environment correlation;
 * self-reported "Cast by" text or shared-credential authorship proves no
 * authorization. `'unavailable'` is the honest default — `buildHeader` is a
 * pure function with no way to confirm WHO set an environment variable, so
 * it never upgrades itself to `'parent_attributed'` on its own; a future
 * caller that structurally knows it just spawned this exact child
 * (`dispatch.ts`) is the one place that could honestly assert it.
 */
const ProvenanceSchema = z.enum(['parent_attributed', 'env_correlated', 'self_reported', 'unavailable'])

const HeaderMetaV2Schema = z
  .object({
    schema: z.literal(2),
    ...headerMetaCore,
    event_id: z.string().min(1),
    process_id: z.string().min(1),
    actor_id: z.string().nullable(),
    lineage: LineageSchema,
    input_versions: InputVersionsSchema,
    provenance: ProvenanceSchema
  })
  .strict()

/** The unit of work an event belongs to (schema 3). `ref` is opaque — an Issue number as text, a ticket key, a branch name; the log never parses it. Each part is `null` until a caller names it, never guessed. */
const WorkSchema = z
  .object({
    ref: z.string().nullable(),
    repo: z.string().nullable(),
    change: z.string().nullable(),
    revision: z.string().nullable()
  })
  .strict()

/** The way of working an event belongs to (schema 3): an opaque id and a version. Vinaya's own process reads `id: 'vinaya'`; a foreign one names itself or stays `null`. */
const FlowSchema = z
  .object({
    id: z.string().nullable(),
    version: z.string().nullable()
  })
  .strict()

/** Schema 3 = every schema 2 field, unchanged, plus `work`, `flow`, `runtime` and `source`. A new version rather than extra fields on 2: a server that knows only 1 and 2 keeps a 3 line as an unknown-version record, where an extra field on 2 would be rejected as invalid. */
const HeaderMetaV3Schema = z
  .object({
    schema: z.literal(3),
    ...headerMetaCore,
    event_id: z.string().min(1),
    process_id: z.string().min(1),
    actor_id: z.string().nullable(),
    lineage: LineageSchema,
    input_versions: InputVersionsSchema,
    provenance: ProvenanceSchema,
    work: WorkSchema,
    flow: FlowSchema,
    runtime: z.string().nullable(),
    source: z.string().nullable()
  })
  .strict()

const HeaderMetaSchema = z.discriminatedUnion('schema', [HeaderMetaV1Schema, HeaderMetaV2Schema, HeaderMetaV3Schema])
export {
  HeaderMetaV1Schema,
  HeaderMetaV2Schema,
  HeaderMetaV3Schema,
  WorkSchema,
  FlowSchema,
  LineageSchema,
  InputVersionsSchema,
  ProvenanceSchema
}
export type HeaderMetaV1 = z.infer<typeof HeaderMetaV1Schema>
export type HeaderMetaV2 = z.infer<typeof HeaderMetaV2Schema>
export type HeaderMetaV3 = z.infer<typeof HeaderMetaV3Schema>
export type Work = z.infer<typeof WorkSchema>
export type Flow = z.infer<typeof FlowSchema>
export type Lineage = z.infer<typeof LineageSchema>
export type InputVersions = z.infer<typeof InputVersionsSchema>
export type Provenance = z.infer<typeof ProvenanceSchema>

const SubjectSchema = z
  .object({
    issue: z.number().int().nullable(),
    pr: z.number().int().optional(),
    sha: z.string().optional(),
    role: z.union([RoleSchema, z.literal('unattributed')]),
    round: z.number().int().optional(),
    // Deviation from spec (see module doc): string, not number.
    objectives_version: z.string().optional()
  })
  .strict()

/** `buildHeader`'s return shape — the two envelope fields it fills, not the whole log line. */
export const HeaderSchema = z
  .object({
    meta: HeaderMetaSchema,
    subject: SubjectSchema
  })
  .strict()
export type Header = z.infer<typeof HeaderSchema>
export type Subject = z.infer<typeof SubjectSchema>

/** Every family's shared envelope tail: present on every event, alongside `meta`/`subject`/`kind`/`event`. */
const envelopeTail = {
  duration_ms: z.number().nonnegative().optional(),
  // The generic body §5.1 reserves for families that need one; `dispatch`
  // and `dev_review_loop` carry their real content in named fields instead,
  // so it ships empty — `.strict()` still refuses a smuggled key in it.
  payload: z.object({}).strict()
}

// ---------------------------------------------------------------------------
// Review finding metadata (O3) — `id` is this finding's identity AS
// REPORTED in one round's comment; it is stable within that comment only.
// A reviewer's own positional numbering (`F1`, `F2`, …) is NOT advertised
// as stable across rounds by this schema — a caller comparing findings
// across rounds needs its own reconciliation, never an assumption that the
// same `id` string names the same finding two rounds apart (Traps to
// avoid). `severity` is the value as reported — its meaning depends on
// `severity_scale` (deliberately a free string, not a closed enum: this
// doctrine already has two different scales, code-review's and security's,
// and a third reviewer type should never require a schema change to name
// its own). `policy_treatment` is a SEPARATE fact from `severity` — the
// same reported severity can bind or not bind a verdict depending on the
// effective review policy's threshold at review time; conflating the two
// is exactly what left "review reconstruction lacks severity and
// confidence data" (this task's own Boundary). `confidence` is optional,
// self-reported, and never treated as calibrated correctness — capturing
// it is not the same as trusting it.
const ReviewFindingSchema = z
  .object({
    id: z.string(),
    severity: z.string(),
    state: z.string().optional(),
    severity_scale: z.string().optional(),
    policy_treatment: z.enum(['blocking', 'non_blocking', 'unavailable']).optional(),
    confidence: z.number().min(0).max(1).optional(),
    confidence_scale: z.string().optional(),
    confidence_source: z.string().optional()
  })
  .strict()
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>

// ---------------------------------------------------------------------------
// `dispatch` family (§5.2)

const DispatchOutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pr_opened'), pr: z.number().int(), head: z.string() }).strict(),
  z
    .object({
      type: z.literal('round_pushed'),
      pr: z.number().int(),
      head: z.string(),
      comment_id: z.number().int()
    })
    .strict(),
  z
    .object({
      type: z.literal('verdict'),
      verdict: z.enum(['APPROVE', 'REQUEST CHANGES', 'PASS', 'FAIL']),
      head: z.string(),
      comment_id: z.number().int(),
      objectives: z.array(z.object({ id: z.string(), met: z.boolean() }).strict()),
      findings: z.array(ReviewFindingSchema)
    })
    .strict(),
  z
    .object({
      type: z.literal('escalation'),
      class: z.enum(['authority', 'strategy', 'product']),
      comment_id: z.number().int()
    })
    .strict(),
  z.object({ type: z.literal('brief'), comment_id: z.number().int(), hash: z.string() }).strict(),
  z.object({ type: z.literal('plan'), issues: z.array(z.number().int()) }).strict(),
  z.object({ type: z.literal('archive'), provenance_comment_id: z.number().int() }).strict(),
  // The generic "the process exited cleanly with no
  // specific, identifiable forge outcome" member the module doc of
  // `apps/cli/src/lib/dispatch.ts` used to name as missing — no
  // role/action-specific identifier is fabricated; a successful dispatch
  // that produced no PR, comment, or archive fact reports this instead of a
  // placeholder borrowed from an unrelated variant.
  z.object({ type: z.literal('completed') }).strict()
])
export type DispatchOutcome = z.infer<typeof DispatchOutcomeSchema>

/** `target_role`/`model`/`round?`/`effect_id` are shared across every `dispatch` event (§5.2). */
const dispatchShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('dispatch'),
  ...envelopeTail,
  target_role: RoleSchema,
  model: z.string(),
  round: z.number().int().optional(),
  effect_id: z.string()
}

/** Shared by `outcome_received` and `dispatch_failed` — a run's token record survives the manner of its death, so the same nullable shape applies whether the run exited cleanly or was killed. */
const dispatchUsageField = z
  .object({ input: z.number().nonnegative(), output: z.number().nonnegative() })
  .strict()
  .nullable()

export const DispatchEventSchema = z.discriminatedUnion('event', [
  z.object({ ...dispatchShared, event: z.literal('dispatched'), prompt_hash: z.string() }).strict(),
  z
    .object({
      ...dispatchShared,
      event: z.literal('outcome_received'),
      outcome: DispatchOutcomeSchema,
      usage: dispatchUsageField
    })
    .strict(),
  z
    .object({
      ...dispatchShared,
      event: z.literal('dispatch_failed'),
      reason: z.enum(['timeout', 'crash', 'refused', 'unattributed_write']),
      usage: dispatchUsageField
    })
    .strict()
])
export type DispatchEvent = z.infer<typeof DispatchEventSchema>

// ---------------------------------------------------------------------------
// `dev_review_loop` family (§5.2) — `loop_id` shared on each. Later
// additions widened it past the spec's original set: `cancelled`,
// `infrastructure_retry`, and the `driver_heartbeat`/`driver_exited`
// liveness pair that lets a reader tell a running loop from a dead one.

/**
 * A short code token: letters, digits, dot, dash, underscore, 64 characters
 * at most. The shape carries no path separator, no whitespace and no room for
 * a sentence, so a pause code or an error class can never hold a path or a
 * message. Used by `paused.reason_code` and `driver_exited.error_class`.
 */
export const CODE_TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const CodeTokenSchema = z.string().regex(CODE_TOKEN_PATTERN)

/** One reviewer role's outcome in a round's `verdicts_read`: the role, one of three words, and how many blocking verdicts it contributed (0 or 1). */
const ReviewerVerdictSchema = z
  .object({
    role: RoleSchema,
    outcome: z.enum(['approve', 'changes_requested', 'not_reviewed']),
    blockers: z.number().int().nonnegative()
  })
  .strict()
export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>

const loopShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('dev_review_loop'),
  ...envelopeTail,
  loop_id: z.string()
}

export const DevReviewLoopEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...loopShared,
      event: z.literal('loop_started'),
      task: z.number().int(),
      policy: z
        .object({
          max_rounds: z.number().int().nonnegative(),
          reviewers: z.array(RoleSchema),
          models: z.record(RoleSchema, z.string())
        })
        .strict()
    })
    .strict(),
  z
    .object({ ...loopShared, event: z.literal('round_started'), round: z.number().int(), base_head: z.string() })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('gate_result_read'),
      round: z.number().int(),
      head: z.string(),
      green: z.boolean(),
      // The developer's stated confidence — read from round 2 on, on a
      // green gate only; round 1 and a red gate set none of the four fields
      // below. `confidence_value`/`confidence_reason` are the whole-number
      // value and one-line reason as stated at the read; `confidence_unavailable:
      // true` records a missing or malformed statement explicitly — never a
      // fabricated `confidence_value` of 0. `extra_turn_spent` tells a first
      // statement apart from one made after the confidence rule's one extra
      // developer turn. All four optional, so a `gate_result_read` line
      // logged before this field set existed still parses.
      confidence_value: z.number().int().min(0).max(100).optional(),
      confidence_reason: z.string().max(CONFIDENCE_REASON_MAX_LENGTH).optional(),
      confidence_unavailable: z.boolean().optional(),
      extra_turn_spent: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('verdicts_read'),
      round: z.number().int(),
      head: z.string(),
      all_approve: z.boolean(),
      blockers: z.number().int().nonnegative(),
      // Every finding from every verdict this round
      // read, carrying its own severity_scale/policy_treatment/confidence —
      // the full per-review metadata `blockers` alone could never retain
      // (see `journal-reconstruction.ts`'s own doc on this gap). `blockers`
      // stays, unchanged, as the cheap coarse count every existing reader
      // already trusts. Optional, not required: a real `verdicts_read` line
      // logged before this task carries no such field at all, and
      // `log/compat.test.ts` proves that a line logged before this field existed still parses
      // — a schema change is additive here, never a reason an old line on
      // disk starts reading as corrupt. This task's own producer
      // (`assess-round.ts`) always sets it explicitly, `[]` included.
      findings: z.array(ReviewFindingSchema).optional(),
      // One entry per reviewer role the loop held or expected a verdict from,
      // so a reader tells a role that approved with no findings from one that
      // never reported. The entries' `blockers` add up to `blockers` above.
      // Optional: a line recorded before it existed still parses.
      reviewers: z.array(ReviewerVerdictSchema).optional()
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('findings_compared'),
      round: z.number().int(),
      open: z.array(z.string()),
      resolved: z.array(z.string()),
      new: z.array(z.string()),
      recurring: z.array(z.string())
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('stop_condition_met'),
      round: z.number().int(),
      // `confidence` and `reappearance` widen this enum additively
      // (a 2026-09-06 amendment): a
      // confidence collapse and a finding-id reappearance are each their own
      // condition, distinguished from the generic `no_progress` stall and
      // from each other, rather than collapsing all three into one value.
      // `repeat_finding` and `repeat_failure` widen it the same way: a
      // blocking finding open for two consecutive reviewed rounds, and two
      // consecutive attempts ending on the same mechanical failure, are each
      // their own condition too — never folded into `no_progress`, whose own
      // (removed) rule paused on any round that resolved nothing.
      // `time_budget` widens it once more, and is the only member that counts
      // neither rounds nor findings: the task's wall clock passed its
      // configured budget, whatever the time went to.
      condition: z.enum([
        'green',
        'max_rounds',
        'no_progress',
        'escalated',
        'principal_stop',
        'confidence',
        'reappearance',
        'repeat_finding',
        'repeat_failure',
        'time_budget'
      ])
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('paused'),
      round: z.number().int(),
      reason: z.enum(['escalation', 'principal_item', 'refreeze_needed']),
      // The loop's own pause reason code (`confidence`, `max_rounds`,
      // `infrastructure`, …) as a short string, never prose and never a closed
      // list: a new pause reason needs no schema change. Optional: a line
      // recorded before it existed still parses.
      reason_code: CodeTokenSchema.optional()
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('resumed'),
      round: z.number().int(),
      // `'principal'` — an authenticated ruling resolved the pause.
      // `'driver'` (O2) — a bare `'infrastructure'`
      // recoverable-hiccup resume, authenticated as the driver's own
      // recovery rather than a Principal decision (`resolveEscalation`'s
      // `authenticatedBy: 'driver-self'` path, `dev-review-loop.ts`) — never
      // silently reported as `'principal'` when no ruling was ever read.
      by: z.enum(['principal', 'driver'])
    })
    .strict(),
  // (O2) The cancellation twin of `resumed` above — a
  // paused escalation's OTHER resolution (`resolveEscalation`'s
  // `decision: 'cancel'` path, `cancelDevReviewLoop`). Always
  // principal-authenticated (a cancel always requires a posted ruling,
  // unlike an infrastructure resume) — no `'driver'` member here.
  z
    .object({
      ...loopShared,
      event: z.literal('cancelled'),
      round: z.number().int(),
      by: z.literal('principal')
    })
    .strict(),
  // A round-2 review MAJOR finding: the
  // driver's own mid-round resume of a developer who stopped without
  // pushing — distinct from `resumed` above, which is `by: 'principal'`
  // only (a Principal resuming a PAUSED loop). This is the driver acting on
  // its own, still inside the same round, never a pause/resume pair: the
  // round simply continues once the developer's next turn produces a new
  // head. Named `unpushed_work_resume` per the objective's own wording so a
  // Principal reading the journal can tell "stopped after real, uncommitted
  // or unpushed work" apart from every other mid-round event.
  z
    .object({
      ...loopShared,
      event: z.literal('unpushed_work_resume'),
      round: z.number().int(),
      branch: z.string(),
      detail: z.string()
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('round_ended'),
      round: z.number().int(),
      base_head: z.string(),
      head: z.string(),
      files_changed: z.number().int().nonnegative(),
      insertions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      wall_ms: z.number().nonnegative(),
      outcome: z.enum(['green', 'changes_requested', 'escalated'])
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('journal_finalized'),
      rounds: z.number().int().nonnegative(),
      total_wall_ms: z.number().nonnegative(),
      time_to_green_ms: z.number().nonnegative().nullable(),
      files_changed_total: z.number().int().nonnegative(),
      final_head: z.string(),
      result: z.enum(['merged_ready', 'stopped'])
    })
    .strict(),
  // (O3) A retry episode around one of the
  // driver's own infrastructure-class hiccups — a pause/escalation comment
  // post that failed at least once (O1), or a developer dispatch that ended
  // on the launcher's own `'connection-failed'` classification (O2) — named
  // by `kind`, so a run that survived a network drop can be told apart from
  // one that did not. A NEW event, additive to the family: a pre-change
  // line carries none of these, and parses exactly as it always did (no
  // existing event's own required fields changed). Logged ONCE per episode,
  // after the last attempt concludes — `'recovered'` when a later attempt
  // eventually succeeded (whether or not a pause is ever reached: O2's own
  // re-dispatch often lets the round continue to publish with no pause at
  // all), `'exhausted'` once the shared `MAX_INFRASTRUCTURE_RETRIES` bound
  // is reached with no success — never one line per attempt, which would
  // make `attempts` redundant with the line count itself.
  z
    .object({
      ...loopShared,
      event: z.literal('infrastructure_retry'),
      round: z.number().int(),
      // Named `failure_kind`, never bare `kind` — `loopShared` already
      // fixes THIS object's own `kind` at the literal `'dev_review_loop'`
      // (the family discriminator every `LogEventSchema` union member
      // carries); a second `kind` field here would silently shadow it.
      failure_kind: z.enum(['pause_comment_post', 'developer_connection']),
      attempts: z.number().int().positive(),
      outcome: z.enum(['recovered', 'exhausted'])
    })
    .strict(),
  // (O1/O3) A liveness ping the driver emits at most every five
  // minutes while its process is alive — the Log's one positive signal that
  // a loop is running, as opposed to finished, paused or dead. Before it, a
  // loop in its first Developer turn and one that died before pushing both
  // looked identical from the Log (`loop_started` with nothing after). A NEW,
  // additive member: a line written before this task carries none of these
  // fields and parses exactly as it always did. `task` is the task Issue
  // (the same number `subject.issue` carries, repeated here so a reader has
  // it without resolving the envelope); `pr` is the pull request once one
  // exists (absent on a first turn before any PR has opened); `round` and
  // `phase` are the loop's current round and phase (`phase` the same
  // free-form string the control store's own `loop_state.phase` carries —
  // `dispatch_developer`, `publish`, `pause`, …). The machine it runs on is
  // `meta.machine`, on every line already.
  z
    .object({
      ...loopShared,
      event: z.literal('driver_heartbeat'),
      task: z.number().int(),
      pr: z.number().int().positive().optional(),
      round: z.number().int(),
      phase: z.string()
    })
    .strict(),
  // (O2/O3) Emitted exactly once when a review-loop driver process
  // ends, on every exit path the driver already traces in its role log
  // (a re-exec hand-off, an uncaught error, an OS signal) plus a normal
  // return (a clean `publish` is `finished`, a decided pause is `paused`).
  // The twin of `driver_heartbeat` above: a heartbeat says "still alive," a
  // `driver_exited` says "stopped, and why." `last_decision` is the driver's
  // last decision in the same form its role-log line records it — `publish`,
  // or `pause(<reason>)`. A NEW, additive member; an earlier line parses
  // unchanged.
  z
    .object({
      ...loopShared,
      event: z.literal('driver_exited'),
      task: z.number().int(),
      reason: z.enum(['finished', 'paused', 'reexec', 'error', 'signal']),
      last_decision: z.string(),
      // The process exit code when the driver ends with one, and — when it
      // ends on an error — the error's own code or constructor name, never its
      // message. Both optional: a line recorded before them still parses.
      exit_code: z.number().int().optional(),
      error_class: CodeTokenSchema.optional()
    })
    .strict()
])
export type DevReviewLoopEvent = z.infer<typeof DevReviewLoopEventSchema>

// ---------------------------------------------------------------------------
// `forge_write` family — every op `vinaya log flush` (and future forge-write
// call sites) can perform, spelled exactly as the Issue lists them.

export const ForgeOpSchema = z.enum([
  'pr.create',
  'pr.comment',
  'pr.body.replace',
  'pr.refreeze',
  'issue.create',
  'issue.edit',
  'issue.comment',
  'milestone.create',
  'milestone.edit',
  'milestone.close',
  'label.add',
  'label.remove'
])
export type ForgeOp = z.infer<typeof ForgeOpSchema>

const ForgeWriteTargetSchema = z
  .object({
    issue: z.number().int().optional(),
    pr: z.number().int().optional()
  })
  .strict()

const forgeWriteShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('forge_write'),
  ...envelopeTail,
  op: ForgeOpSchema,
  target: ForgeWriteTargetSchema
}

export const ForgeWriteEventSchema = z.discriminatedUnion('event', [
  z.object({ ...forgeWriteShared, event: z.literal('validated') }).strict(),
  z.object({ ...forgeWriteShared, event: z.literal('refused'), reason: z.string() }).strict(),
  z.object({ ...forgeWriteShared, event: z.literal('written'), comment_ids: z.array(z.string()) }).strict()
])
export type ForgeWriteEvent = z.infer<typeof ForgeWriteEventSchema>

// ---------------------------------------------------------------------------
// `gate` family (O2) — one gate runner's check run: a `summary` per run and a
// `checked` event for each check that did not pass. `loop` (the
// spec's "loop coordinator") is already typed by `dev_review_loop` above;
// this task does not introduce a second loop schema for it.

export const GateOutcomeSchema = z.enum([
  'pass',
  'fail',
  'wait',
  'skip',
  'invalid_input',
  'unavailable_dependency',
  'timeout',
  'cancelled'
])
export type GateOutcome = z.infer<typeof GateOutcomeSchema>

const gateShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('gate'),
  ...envelopeTail,
  check: z.string(),
  check_version: z.string().nullable(),
  policy_version: z.string().nullable(),
  input_fingerprint: z.string().nullable()
}

export const GateEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...gateShared,
      event: z.literal('checked'),
      outcome: GateOutcomeSchema,
      reason: z.string().optional()
    })
    .strict(),
  // One per check run. A run records this and a `checked` event only for a
  // check that did not pass, so the Log's volume tracks failures, not the
  // number of checks. `ran` counts the checks that executed (`passed` +
  // `failed`); `skipped` are not in it. `failed` is every executed check that
  // did not pass — a failure, a wait, a timeout or an error — and
  // `failed_checks` names them. The run's total time is the envelope's
  // `duration_ms`.
  z
    .object({
      meta: HeaderMetaSchema,
      subject: SubjectSchema,
      kind: z.literal('gate'),
      ...envelopeTail,
      event: z.literal('summary'),
      ran: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed_checks: z.array(z.string())
    })
    .strict()
])
export type GateEvent = z.infer<typeof GateEventSchema>

// ---------------------------------------------------------------------------
// `operation` family (O2) — the spec's "command dispatcher": a normalized
// operation/tool call, result and duration, never raw secret-bearing
// arguments (`redact()` still runs over the full event regardless).

export const OperationResultSchema = z.enum(['ok', 'error', 'refused', 'timeout', 'cancelled', 'unavailable'])
export type OperationResult = z.infer<typeof OperationResultSchema>

const operationShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('operation'),
  ...envelopeTail,
  operation: z.string(),
  target: z.string().nullable()
}

export const OperationEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...operationShared,
      event: z.literal('completed'),
      result: OperationResultSchema,
      error_class: z.string().nullable(),
      // The field NAMES an operation's outcome concerns — a refused `custom`
      // event's missing, extra or mistyped fields — never their values,
      // since a rejected value may be the secret. Optional: no other
      // operation sets it, and a line written before it existed still parses.
      field_names: z.array(z.string().max(CUSTOM_FIELD_NAME_MAX_LENGTH)).max(CUSTOM_EVENT_MAX_FIELDS).optional()
    })
    .strict()
])
export type OperationEvent = z.infer<typeof OperationEventSchema>

// ---------------------------------------------------------------------------
// `usage` family (O2) — the spec's "usage collector". Every unit is
// `nullable`, never defaulted to `0` — "unknown usage treated as zero" is
// the exact bug the spec calls out to fix; a producer with nothing observed
// reports `null` and, when it knows why, `unknown_reason`.

const UsageUnitsSchema = z
  .object({
    input: z.number().nonnegative().nullable(),
    output: z.number().nonnegative().nullable(),
    cache: z.number().nonnegative().nullable()
  })
  .strict()
export type UsageUnits = z.infer<typeof UsageUnitsSchema>

const usageShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('usage'),
  ...envelopeTail,
  model: z.string().nullable(),
  source: z.string(),
  semantics: z.enum(['cumulative', 'delta'])
}

export const UsageEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...usageShared,
      event: z.literal('observed'),
      units: UsageUnitsSchema,
      unknown_reason: z.string().nullable()
    })
    .strict()
])
export type UsageEvent = z.infer<typeof UsageEventSchema>

// ---------------------------------------------------------------------------
// `role_attempt` family (O2) — the spec's "role executor": a role
// ATTEMPT's own normalized outcome, distinct from the `dispatch` family's
// parent-side view of dispatching one. `actor` is deliberately an opaque
// string, never `RoleSchema` — this family, and the events it describes,
// are not limited to the closed doctrine `Role` union (this task's own
// title). Named `role_attempt`, not `role`, so it never collides with the
// existing `Role`/`RoleSchema` export from this same module.

export const RoleAttemptOutcomeSchema = z.enum([
  'completed',
  'incomplete',
  'infrastructure_failed',
  'cancelled',
  'timed_out',
  'capability_refused'
])
export type RoleAttemptOutcome = z.infer<typeof RoleAttemptOutcomeSchema>

const roleAttemptShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('role_attempt'),
  ...envelopeTail,
  actor: z.string().nullable(),
  attempt: z.number().int().nullable(),
  // `effect_id` mirrors the `dispatch` family's own
  // field, the same value, so one attempt's `role_attempt` line and its
  // `dispatch` lines are the evidence identity a reader joins on. `model` is
  // the runtime's own genuine receipt when the vendor gave one, else the
  // pre-completion request label — same precedence `dispatch.ts` already
  // applies to the `dispatch` family's own `model` field, never guessed here
  // a second way.
  effect_id: z.string(),
  model: z.string().nullable()
}

export const RoleAttemptEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...roleAttemptShared,
      event: z.literal('attempted'),
      outcome: RoleAttemptOutcomeSchema,
      usage: dispatchUsageField
    })
    .strict()
])
export type RoleAttemptEvent = z.infer<typeof RoleAttemptEventSchema>

// ---------------------------------------------------------------------------
// `handoff` family (O2) — a human handoff/escalation, raised and later
// resolved. `class` reuses the same three-value severity the `dispatch`
// family's `escalation` outcome already carries (`authority` / `strategy` /
// `product`) rather than inventing a second name for the identical concept.

const handoffShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('handoff'),
  ...envelopeTail,
  class: z.enum(['authority', 'strategy', 'product']),
  reason: z.string()
}

export const HandoffEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...handoffShared,
      event: z.literal('raised'),
      requested_decision: z.string().nullable()
    })
    .strict(),
  z
    .object({
      ...handoffShared,
      event: z.literal('resolved'),
      resolution: z.string().nullable(),
      resolved_by: z.string().nullable()
    })
    .strict()
])
export type HandoffEvent = z.infer<typeof HandoffEventSchema>

// ---------------------------------------------------------------------------
// `effect` family (O2) — the spec's "shared effect executor": a generic
// external effect's outcome, including failure and uncertainty. The
// executor records ONE `verified` event per write, carrying its final
// outcome; `attempted` and `observed` stay parseable so a line stored
// before that change still reads, but nothing emits them any more. This is additive to, and does not replace, the existing
// `forge_write` family, which stays exactly as it was — a forge write is
// one specific effect this schema does not yet generalize `forge_write`
// into; "telemetry never substitutes for required intent" (the spec's own
// words) is why this is fail-open observation, not a fail-closed control
// store.

const EffectTargetSchema = z
  .object({
    kind: z.string(),
    ref: z.string()
  })
  .strict()

const effectShared = {
  meta: HeaderMetaSchema,
  subject: SubjectSchema,
  kind: z.literal('effect'),
  ...envelopeTail,
  effect_id: z.string(),
  target: EffectTargetSchema
}

export const EffectEventSchema = z.discriminatedUnion('event', [
  z.object({ ...effectShared, event: z.literal('attempted') }).strict(),
  z
    .object({ ...effectShared, event: z.literal('observed'), outcome: z.enum(['success', 'failure', 'uncertain']) })
    .strict(),
  z
    .object({ ...effectShared, event: z.literal('verified'), outcome: z.enum(['success', 'failure', 'uncertain']) })
    .strict()
])
export type EffectEvent = z.infer<typeof EffectEventSchema>

// ---------------------------------------------------------------------------
// `custom` family — an event a consumer declared under `logs.events` in its
// own `vinaya.config.json` (`custom.ts`). `kind` and `event` are fixed; the
// declared name is data in `name`, and the values sit flat under `fields`,
// never nested. Whether `name` is declared and each value matches its
// declared type is the writer's check (`checkCustomEvent`) — this schema
// holds only the shape every declaration shares. Valid under a schema 3
// header only: the family is newer than 1 and 2, so a line claiming either
// with a `custom` body is not one this log ever wrote.

const CustomFieldValueSchema = z.union([z.string().max(CUSTOM_TEXT_MAX_LENGTH), z.number().finite(), z.boolean()])

const customShared = {
  meta: HeaderMetaV3Schema,
  subject: SubjectSchema,
  kind: z.literal('custom'),
  ...envelopeTail
}

export const CustomEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      ...customShared,
      event: z.literal('recorded'),
      name: z.string().max(CUSTOM_EVENT_NAME_MAX_LENGTH).regex(CUSTOM_EVENT_NAME_PATTERN),
      fields: z
        .record(z.string().max(CUSTOM_FIELD_NAME_MAX_LENGTH).regex(CUSTOM_FIELD_NAME_PATTERN), CustomFieldValueSchema)
        .refine((f) => Object.keys(f).length <= CUSTOM_EVENT_MAX_FIELDS, {
          message: `custom: at most ${CUSTOM_EVENT_MAX_FIELDS} fields`
        })
    })
    .strict()
])
export type CustomEvent = z.infer<typeof CustomEventSchema>

// ---------------------------------------------------------------------------

/** Every family shipped so far: the first three (`dispatch`, `dev_review_loop`, `forge_write`), the six after them (`gate`, `operation`, `usage`, `role_attempt`, `handoff`, `effect`), and `custom`, a consumer's own declared event. `kind: 'command' | 'tokens'` is still refused — `command` folds into `operation`, `tokens` into `usage`, so neither name is a separate family. */
export const LogEventSchema = z.union([
  DispatchEventSchema,
  DevReviewLoopEventSchema,
  ForgeWriteEventSchema,
  GateEventSchema,
  OperationEventSchema,
  UsageEventSchema,
  RoleAttemptEventSchema,
  HandoffEventSchema,
  EffectEventSchema,
  CustomEventSchema
])
export type LogEvent = z.infer<typeof LogEventSchema>
