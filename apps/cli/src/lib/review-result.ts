/**
 * The reviewer's result — the one structured value a reviewer session ends
 * with, delivered as each CLI's native structured final output (Claude Code
 * `--json-schema`, Codex `--output-schema`) rather than three result files.
 *
 * Versioned (`schemaVersion`) and discriminated by `status`:
 *
 *  - `completed` — `role`, the `headSha` and `manifestDigest` the review is
 *    bound to, `summary`, `findings` (a role-specific `severity`, a `file`, an
 *    optional `line` and `description`) and `objectiveResults`;
 *  - `blocked` — `role`, the same two bindings, `summary` and a typed `blocker`.
 *
 * There is no `needs_ruling` status: a reviewer never asks for a ruling.
 *
 * One schema serves both vendors, so it is written to the strictest common
 * shape (see `developer-turn-result.ts`): the union sits under one root key,
 * `reviewResult`, and every "optional" field is a required, nullable one. The
 * same zod value generates the JSON Schema the CLIs receive and validates what
 * comes back, so the two can never drift. The schema handed to a provider is
 * built for ONE role (`reviewResultJsonSchema(role)`): its `role` is that
 * role's literal and its severities are that role's scale.
 *
 * Nothing the agent writes decides anything about who it is. `role` is a
 * claim, validated against the controller's own `ReviewBinding`; so are
 * `headSha` and `manifestDigest`. Validation runs in two steps:
 * `parseReviewResult` is the shape check, `semanticErrors` the check against
 * the binding. `classifyReviewOutcome` turns a whole run — result or not —
 * into either a review or "no review"; only a review can ever count, and a
 * missing, malformed, stale, blocked, cancelled, context-exhausted or
 * provider-errored run is never approval.
 */

import { createHash } from 'node:crypto'
import { CODE_REVIEW_SEVERITY_ORDER, type ReviewInputManifest, SECURITY_SEVERITY_ORDER } from '@attalabs/aeg-core'
import { z } from 'zod/v4'

/** The one schema version this module produces and accepts. */
export const REVIEW_RESULT_SCHEMA_VERSION = 1

export const REVIEWER_ROLES = ['code-reviewer', 'security-reviewer'] as const
export type ReviewerRole = (typeof REVIEWER_ROLES)[number]

/** Each role's own severity scale — the scales the review policy already orders against. */
export const REVIEWER_SEVERITIES: Record<ReviewerRole, readonly string[]> = {
  'code-reviewer': CODE_REVIEW_SEVERITY_ORDER,
  'security-reviewer': SECURITY_SEVERITY_ORDER
}

const ALL_SEVERITIES = [...CODE_REVIEW_SEVERITY_ORDER, ...SECURITY_SEVERITY_ORDER] as [string, ...string[]]

/** What stopped a `blocked` review, typed. */
export const REVIEW_BLOCKER_KINDS = [
  'input_missing',
  'input_unreadable',
  'diff_unavailable',
  'tooling_unavailable',
  'scope_unclear'
] as const

export const OBJECTIVE_STATUSES = ['MET', 'NOT MET'] as const

const schemaVersion = z.literal(REVIEW_RESULT_SCHEMA_VERSION)
const summary = z.string().min(1)

const FindingSchema = (severity: z.ZodType<string>) =>
  z
    .object({
      severity,
      /** The file the finding is about — required: a finding that names no file cannot be acted on. */
      file: z.string().min(1),
      /** `null` when the finding is about the file as a whole. */
      line: z.number().int().min(1).nullable(),
      description: z.string().min(1).nullable()
    })
    .strict()

const ObjectiveResultSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(OBJECTIVE_STATUSES),
    evidence: z.string().min(1)
  })
  .strict()

const BlockerSchema = z.object({ kind: z.enum(REVIEW_BLOCKER_KINDS), detail: z.string().min(1) }).strict()

function variantSchemas(role: z.ZodType<string>, severity: z.ZodType<string>) {
  const bound = { schemaVersion, role, headSha: z.string().min(1), manifestDigest: z.string().min(1), summary }
  return [
    z
      .object({
        ...bound,
        status: z.literal('completed'),
        findings: z.array(FindingSchema(severity)),
        objectiveResults: z.array(ObjectiveResultSchema)
      })
      .strict(),
    z.object({ ...bound, status: z.literal('blocked'), blocker: BlockerSchema }).strict()
  ] as const
}

/** The shape check's own schema: either role, any role's severity — which role and scale applies is the controller's call. */
export const ReviewResultSchema = z.discriminatedUnion('status', [
  ...variantSchemas(z.enum(REVIEWER_ROLES), z.enum(ALL_SEVERITIES))
])

/** The structured output the provider is asked for, for either role: the union under one root key. */
export const ReviewOutputSchema = z.object({ reviewResult: ReviewResultSchema }).strict()

export type ReviewResult = z.infer<typeof ReviewResultSchema>
export type CompletedReview = Extract<ReviewResult, { status: 'completed' }>

function roleOutputSchema(role: ReviewerRole) {
  return z
    .object({
      reviewResult: z.discriminatedUnion('status', [
        ...variantSchemas(z.literal(role), z.enum(REVIEWER_SEVERITIES[role] as [string, ...string[]]))
      ])
    })
    .strict()
}

/**
 * The JSON Schema handed to the vendor CLI. With a `role` it is that role's:
 * its literal `role` and its severity scale. Without one it admits either
 * role, which is how the proof lets a model attempt a role or severity the
 * controller must then refuse. `$schema` is dropped: neither CLI needs it.
 */
export function reviewResultJsonSchema(role?: ReviewerRole): Record<string, unknown> {
  const schema = role === undefined ? ReviewOutputSchema : roleOutputSchema(role)
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  return rest
}

/** What the controller knows about one reviewer's dispatch — never read from the agent. */
export type ReviewBinding = {
  readonly role: ReviewerRole
  /** The round's judged head. */
  readonly headSha: string
  /** `manifestDigest` of the one review-input manifest both reviewers were dispatched against. */
  readonly manifestDigest: string
  /** The objective ids the frozen brief carries. */
  readonly objectiveIds: readonly string[]
}

/** The digest the controller binds a review to: SHA-256 over the manifest's fields in a fixed key order. */
export function manifestDigest(manifest: ReviewInputManifest): string {
  const ordered = {
    headSha: manifest.headSha,
    baseSha: manifest.baseSha,
    briefHash: manifest.briefHash,
    objectivesVersion: manifest.objectivesVersion,
    rulingOrdinal: manifest.rulingOrdinal,
    policyDigest: manifest.policyDigest
  }
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export type ReviewValidation =
  | { ok: true; result: ReviewResult }
  | { ok: false; stage: 'schema' | 'semantic'; errors: string[] }

/** The shape check alone: does `value` match the schema the provider was given? Returns the unwrapped result. */
export function parseReviewResult(value: unknown): ReviewValidation {
  const parsed = ReviewOutputSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      stage: 'schema',
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    }
  }
  return { ok: true, result: parsed.data.reviewResult }
}

/** Errors that make a result belong to another review than this one — a stale or crossed result. */
export function bindingErrors(result: ReviewResult, binding: ReviewBinding): string[] {
  const errors: string[] = []
  if (result.role !== binding.role) {
    errors.push(`role: the result names ${result.role} but this dispatch is ${binding.role}`)
  }
  if (result.headSha !== binding.headSha) {
    errors.push(`headSha: the result is bound to ${result.headSha}, the judged head is ${binding.headSha}`)
  }
  if (result.manifestDigest !== binding.manifestDigest) {
    errors.push('manifestDigest: the result is bound to a different review-input manifest')
  }
  return errors
}

/** The rules a schema cannot express, checked against the controller's own binding. */
export function semanticErrors(result: ReviewResult, binding: ReviewBinding): string[] {
  const errors = bindingErrors(result, binding)
  if (result.status !== 'completed') return errors
  const severities = REVIEWER_SEVERITIES[binding.role]
  for (const [i, finding] of result.findings.entries()) {
    if (!severities.includes(finding.severity)) {
      errors.push(
        `findings.${i}.severity: ${JSON.stringify(finding.severity)} is not on the ${binding.role} scale (${severities.join('|')})`
      )
    }
    if (finding.file.trim().length === 0) errors.push(`findings.${i}.file: a finding must name a file`)
  }
  const known = new Set(binding.objectiveIds)
  for (const objective of result.objectiveResults) {
    if (!known.has(objective.id)) {
      errors.push(`objectiveResults: unknown objective id ${JSON.stringify(objective.id)} (not in the brief)`)
    }
  }
  return errors
}

/** The controller's whole acceptance check: the shape, then the semantics. Only `ok: true` is ever a review. */
export function validateReviewResult(value: unknown, binding: ReviewBinding): ReviewValidation {
  const parsed = parseReviewResult(value)
  if (!parsed.ok) return parsed
  const errors = semanticErrors(parsed.result, binding)
  return errors.length > 0 ? { ok: false, stage: 'semantic', errors } : parsed
}

/** Why a run produced no review. */
export type NoReviewReason =
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'role_mismatch'
  | 'rejected'
  | 'blocked'
  | 'cancelled'
  | 'context_exhausted'
  | 'provider_error'
  | 'duplicate'

export type ReviewOutcome =
  | { kind: 'review'; result: CompletedReview }
  | { kind: 'no_review'; reason: NoReviewReason; detail: string }

/** What a finished reviewer run showed at the adapter boundary. */
export type ReviewRunFacts = {
  /** The run was killed before it finished. */
  cancelled: boolean
  /** The stream's own terminal outcome, when it reported one (`success`, `turn.failed`, …). */
  terminal: string | null
  /** Error text the stream or the process reported. */
  errors: readonly string[]
  /** Whether the stream carried a structured result at all. */
  hasResult: boolean
  /** The value read, before any validation. */
  raw: unknown
}

const CONTEXT_EXHAUSTED = /context (window|length)|prompt is too long|too many tokens|maximum context|token limit/i
const TERMINAL_FAILURE = /error|failed/i

/**
 * One run's outcome. Everything but a completed, schema-valid, bound,
 * semantically valid result is "no review" — the order below says which
 * reason wins when several apply, and none of them is approval.
 */
export function classifyReviewOutcome(facts: ReviewRunFacts, binding: ReviewBinding): ReviewOutcome {
  const noReview = (reason: NoReviewReason, detail: string): ReviewOutcome => ({ kind: 'no_review', reason, detail })
  const errorText = facts.errors.join(' | ')
  if (facts.cancelled) return noReview('cancelled', 'the run was cancelled before it finished')
  if (CONTEXT_EXHAUSTED.test(errorText)) return noReview('context_exhausted', errorText)
  if (!facts.hasResult) {
    const failed = (facts.terminal !== null && TERMINAL_FAILURE.test(facts.terminal)) || errorText.length > 0
    return failed
      ? noReview('provider_error', `${facts.terminal ?? 'the run'} ended with no result: ${errorText}`)
      : noReview('missing', 'the stream carried no structured result')
  }
  const parsed = parseReviewResult(facts.raw)
  if (!parsed.ok) return noReview('malformed', parsed.errors.join('; '))
  if (parsed.result.status === 'blocked') {
    return noReview('blocked', `${parsed.result.blocker.kind}: ${parsed.result.blocker.detail}`)
  }
  const errors = semanticErrors(parsed.result, binding)
  if (errors.length === 0) return { kind: 'review', result: parsed.result }
  if (parsed.result.role !== binding.role) return noReview('role_mismatch', errors.join('; '))
  if (bindingErrors(parsed.result, binding).length > 0) return noReview('stale', errors.join('; '))
  return noReview('rejected', errors.join('; '))
}

/**
 * One round's collection of reviews: each role holds at most one accepted
 * review, and a second offered for the same role is refused, never merged.
 */
export class RoundReviews {
  private readonly accepted = new Map<ReviewerRole, CompletedReview>()

  /** Offers a role's outcome; returns what the round recorded for it. */
  offer(role: ReviewerRole, outcome: ReviewOutcome): ReviewOutcome {
    if (outcome.kind !== 'review') return outcome
    if (this.accepted.has(role)) {
      return { kind: 'no_review', reason: 'duplicate', detail: `${role} already has an accepted review this round` }
    }
    this.accepted.set(role, outcome.result)
    return outcome
  }

  get(role: ReviewerRole): CompletedReview | undefined {
    return this.accepted.get(role)
  }

  get size(): number {
    return this.accepted.size
  }
}
