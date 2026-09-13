/**
 * The Vinaya Log's typed event schema (Linear "Tech spec — The Vinaya Log",
 * rev 4, §5). Three families ship so far — `dispatch`, `dev_review_loop`,
 * and `forge_write` — the other three (`gate`, `command`, `tokens`) are out
 * of scope; `kind` is a closed union of only these three.
 *
 * One deviation from the spec, decided in this task's brief: the spec's
 * `subject.objectives_version` is `number`; the built form
 * (`vinaya-log-v1`'s own task 1, PR #423) hashes it to a `sha256` hex
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
 * § The flush) and is attacker-reachable via `VINAYA_RUN_ID` (security
 * review, PR #439) — a value carrying `-->` or a newline would close the
 * HTML comment early or break the fenced block once posted publicly.
 * Refusing it here, at write time, means an unsafe value never reaches the
 * outbox at all, rather than relying on a later reader to catch it.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

const HeaderMetaSchema = z
  .object({
    schema: z.literal(1),
    ts: z.string(),
    run_id: z.string().regex(RUN_ID_PATTERN),
    seq: z.number().int().nonnegative(),
    repo: z.string().nullable(),
    vinaya: z.string(),
    doctrine: z.string(),
    host: HostSchema,
    machine: z.string()
  })
  .strict()

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
      findings: z.array(z.object({ id: z.string(), severity: z.string(), state: z.string().optional() }).strict())
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
  z.object({ type: z.literal('archive'), provenance_comment_id: z.number().int() }).strict()
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

/** Shared by `outcome_received` and `dispatch_failed` (O10) — a run's token record survives the manner of its death, so the same nullable shape applies whether the run exited cleanly or was killed. */
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
// `dev_review_loop` family (§5.2) — eleven events, `loop_id` shared on each.

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
      blockers: z.number().int().nonnegative()
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
      // (dev-review-loop-v1 task 4, `#414`, O2 amendment 2026-09-06): a
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
      by: z.literal('principal')
    })
    .strict(),
  // (`doctrine-fixes-v1` task 1, `#543`, O2, round 2 review, MAJOR) The
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

/** The three families shipped so far. `kind: 'gate' | 'command' | 'tokens'` is refused — out of scope. */
export const LogEventSchema = z.union([DispatchEventSchema, DevReviewLoopEventSchema, ForgeWriteEventSchema])
export type LogEvent = z.infer<typeof LogEventSchema>
