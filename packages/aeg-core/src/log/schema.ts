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
 * and trust provenance"). `buildHeader` (`envelope.ts`) builds `2` for
 * every event from this task forward; `1` exists so a line already on disk
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

const HeaderMetaSchema = z.discriminatedUnion('schema', [HeaderMetaV1Schema, HeaderMetaV2Schema])
export { HeaderMetaV1Schema, HeaderMetaV2Schema, LineageSchema, InputVersionsSchema, ProvenanceSchema }
export type HeaderMetaV1 = z.infer<typeof HeaderMetaV1Schema>
export type HeaderMetaV2 = z.infer<typeof HeaderMetaV2Schema>
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
// `dev_review_loop` family (§5.2) — twelve events (a later addition added
// `cancelled`), `loop_id` shared on each.

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
      green: z.boolean()
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
      findings: z.array(ReviewFindingSchema).optional()
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
      condition: z.enum([
        'green',
        'max_rounds',
        'no_progress',
        'escalated',
        'principal_stop',
        'confidence',
        'reappearance'
      ])
    })
    .strict(),
  z
    .object({
      ...loopShared,
      event: z.literal('paused'),
      round: z.number().int(),
      reason: z.enum(['escalation', 'principal_item', 'refreeze_needed'])
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
// `gate` family (O2) — one gate runner's attempted check. `loop` (the
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
      error_class: z.string().nullable()
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
// external effect's attempted/observed/verified outcome, including failure
// and uncertainty. This is additive to, and does not replace, the existing
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

/** Every family shipped so far: the first three (`dispatch`, `dev_review_loop`, `forge_write`) plus this task's six (`gate`, `operation`, `usage`, `role_attempt`, `handoff`, `effect`). `kind: 'command' | 'tokens'` is still refused — `command` folds into `operation`, `tokens` into `usage`, so neither name is a separate family. */
export const LogEventSchema = z.union([
  DispatchEventSchema,
  DevReviewLoopEventSchema,
  ForgeWriteEventSchema,
  GateEventSchema,
  OperationEventSchema,
  UsageEventSchema,
  RoleAttemptEventSchema,
  HandoffEventSchema,
  EffectEventSchema
])
export type LogEvent = z.infer<typeof LogEventSchema>
