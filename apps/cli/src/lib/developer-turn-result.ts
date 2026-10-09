/**
 * The Developer's turn result — the one structured value a Developer turn ends
 * with, delivered as each CLI's native structured final output (Claude Code
 * `--json-schema`, Codex `--output-schema`) rather than parsed out of prose.
 *
 * Versioned (`schemaVersion`) and discriminated by `status`:
 *
 *  - `completed` — `summary`, `confidence` (a whole percent),
 *    `confidenceExplanation`, `addressedFindingIds`, `sourceUses`, and the
 *    optional `reportedChecks`;
 *  - `blocked` — `summary`, a typed `blocker`, optional `sourceUses`;
 *  - `needs_ruling` — `summary`, a typed `rulingRequest`, optional `sourceUses`.
 *
 * Confidence exists only on `completed`. `sourceUses` is required on
 * `completed` when the brief names required sources, and is optional
 * diagnostic context on the other two.
 *
 * One schema serves both vendors, so it is written to the strictest common
 * shape: OpenAI structured outputs (which Codex's `--output-schema` uses)
 * refuse a root that is not a plain object and refuse an optional property, so
 * the union sits under one root key, `turnResult`, and every "optional" field
 * is a required, nullable one. The same zod value generates the JSON Schema
 * the CLIs receive and validates what comes back, so the two can never drift.
 *
 * Validation runs in two steps. `parseDeveloperTurnResult` is the shape check
 * (the schema the provider was given); `validateDeveloperTurnResult` adds the
 * semantic check against the turn's own context — a finding id the round never
 * raised, a ruling request naming no decision the Principal may take, a
 * required source left unreported — which a schema cannot express.
 */

import { CONFIDENCE_REASON_MAX_LENGTH } from '@attalabs/aeg-core'
import { z } from 'zod/v4'

/** The one schema version this module produces and accepts. */
export const DEVELOPER_TURN_RESULT_SCHEMA_VERSION = 1

/** What stopped a `blocked` turn — the Developer doctrine's own stop conditions, typed. */
export const BLOCKER_KINDS = [
  'dependency_unmerged',
  'conflict_open',
  'preflight_failed',
  'premise_stale',
  'brief_contradicts_code',
  'outside_surface',
  'test_failure',
  'destructive_unauthorized',
  'tooling_unavailable'
] as const

const schemaVersion = z.literal(DEVELOPER_TURN_RESULT_SCHEMA_VERSION)
const summary = z.string().min(1)

const SourceUseSchema = z
  .object({
    /** The required source exactly as the brief names it (a URL or an in-repo path). */
    source: z.string().min(1),
    /** What the source decided in this turn's work. */
    use: z.string().min(1)
  })
  .strict()

const ReportedCheckSchema = z
  .object({
    command: z.string().min(1),
    outcome: z.enum(['pass', 'fail'])
  })
  .strict()

export type DeveloperTurnSchemaContext = Pick<DeveloperTurnContext, 'knownFindingIds' | 'requiredSources'>

/**
 * Builds the provider schema from the same handoff and Documentation manifest
 * the controller will later judge. `max` rather than a schema `contains`
 * constraint is intentional: both vendors accept enum/length constraints,
 * while the controller retains the coverage check for a duplicate source.
 */
function developerTurnResultSchema(context: DeveloperTurnSchemaContext) {
  const sourceUses =
    context.requiredSources.length === 0
      ? z.array(SourceUseSchema).length(0)
      : z
          .array(SourceUseSchema.extend({ source: z.enum(context.requiredSources as [string, ...string[]]) }))
          .length(context.requiredSources.length)
  const addressedFindingIds = z
    .array(
      context.knownFindingIds.length === 0
        ? z.string().min(1)
        : z.enum(context.knownFindingIds as [string, ...string[]])
    )
    .max(context.knownFindingIds.length)

  const CompletedSchema = z
    .object({
      schemaVersion,
      status: z.literal('completed'),
      summary,
      confidence: z.number().int().min(0).max(100),
      confidenceExplanation: z.string().min(1).max(CONFIDENCE_REASON_MAX_LENGTH),
      addressedFindingIds,
      sourceUses,
      reportedChecks: z.array(ReportedCheckSchema).nullable()
    })
    .strict()

  const BlockedSchema = z
    .object({
      schemaVersion,
      status: z.literal('blocked'),
      summary,
      blocker: z
        .object({
          kind: z.enum(BLOCKER_KINDS),
          detail: z.string().min(1)
        })
        .strict(),
      sourceUses: z.array(SourceUseSchema).nullable()
    })
    .strict()

  const NeedsRulingSchema = z
    .object({
      schemaVersion,
      status: z.literal('needs_ruling'),
      summary,
      rulingRequest: z
        .object({
          question: z.string().min(1),
          /** The decisions the Developer asks the Principal to choose between — each must be one the turn permits. */
          decisions: z.array(z.string().min(1))
        })
        .strict(),
      sourceUses: z.array(SourceUseSchema).nullable()
    })
    .strict()

  /** The discriminated union itself — the value a turn reports. */
  return z.discriminatedUnion('status', [CompletedSchema, BlockedSchema, NeedsRulingSchema])
}

/** The unconstrained type schema, used only for TypeScript inference. */
export const DeveloperTurnResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      schemaVersion,
      status: z.literal('completed'),
      summary,
      confidence: z.number().int().min(0).max(100),
      confidenceExplanation: z.string().min(1).max(CONFIDENCE_REASON_MAX_LENGTH),
      addressedFindingIds: z.array(z.string().min(1)),
      sourceUses: z.array(SourceUseSchema).nullable(),
      reportedChecks: z.array(ReportedCheckSchema).nullable()
    })
    .strict(),
  z
    .object({
      schemaVersion,
      status: z.literal('blocked'),
      summary,
      blocker: z.object({ kind: z.enum(BLOCKER_KINDS), detail: z.string().min(1) }).strict(),
      sourceUses: z.array(SourceUseSchema).nullable()
    })
    .strict(),
  z
    .object({
      schemaVersion,
      status: z.literal('needs_ruling'),
      summary,
      rulingRequest: z.object({ question: z.string().min(1), decisions: z.array(z.string().min(1)) }).strict(),
      sourceUses: z.array(SourceUseSchema).nullable()
    })
    .strict()
])

/** The structured output the provider is asked for: the union under one root key (see the module comment). */
export const DeveloperTurnOutputSchema = z.object({ turnResult: DeveloperTurnResultSchema }).strict()

export type DeveloperTurnResult = z.infer<typeof DeveloperTurnResultSchema>
export type DeveloperTurnOutput = z.infer<typeof DeveloperTurnOutputSchema>

/**
 * The JSON Schema handed to the vendor CLI — generated from the same zod value
 * that validates the reply. `$schema` is dropped: neither CLI needs it, and a
 * provider that rejects unknown root keywords would refuse the whole schema.
 */
export function developerTurnResultJsonSchema(context: DeveloperTurnSchemaContext): Record<string, unknown> {
  const output = z.object({ turnResult: developerTurnResultSchema(context) }).strict()
  const { $schema: _dropped, ...schema } = z.toJSONSchema(output, { target: 'draft-7' }) as Record<string, unknown>
  return schema
}

/** What the semantic check needs from the turn it judges. */
export type DeveloperTurnContext = {
  /** Every finding id the round handed the Developer — `addressedFindingIds` may name only these. */
  readonly knownFindingIds: readonly string[]
  /** The brief's required documentation sources — a `completed` turn must report a use for each. */
  readonly requiredSources: readonly string[]
  /** The decisions a ruling request may ask the Principal for. */
  readonly permissibleDecisions: readonly string[]
}

export type TurnResultValidation =
  | { ok: true; result: DeveloperTurnResult }
  | { ok: false; stage: 'schema' | 'semantic'; errors: string[] }

/**
 * Providers receive the narrower per-turn schema, while this shape check
 * accepts the shared representation so semantic diagnostics can name the
 * missing sources or unexpected findings rather than a generic array bound.
 */
export function parseDeveloperTurnResult(value: unknown, _context: DeveloperTurnSchemaContext): TurnResultValidation {
  const parsed = DeveloperTurnOutputSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      stage: 'schema',
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    }
  }
  return { ok: true, result: parsed.data.turnResult }
}

/** The semantic rules a schema cannot express, checked against the turn's own context. */
export function semanticErrors(result: DeveloperTurnResult, context: DeveloperTurnContext): string[] {
  const errors: string[] = []
  if (result.status === 'completed') {
    const known = new Set(context.knownFindingIds)
    if (result.addressedFindingIds.length > context.knownFindingIds.length) {
      errors.push(
        `addressedFindingIds: expected at most ${context.knownFindingIds.length} finding ids; valid finding ids: ${context.knownFindingIds.map((value) => JSON.stringify(value)).join(', ') || '(none)'}`
      )
    }
    for (const id of result.addressedFindingIds) {
      if (!known.has(id))
        errors.push(
          `addressedFindingIds: unknown finding id ${JSON.stringify(id)}; valid finding ids: ${context.knownFindingIds.map((value) => JSON.stringify(value)).join(', ') || '(none)'}`
        )
    }
    if (result.confidenceExplanation.length > CONFIDENCE_REASON_MAX_LENGTH) {
      errors.push(`confidenceExplanation: longer than ${CONFIDENCE_REASON_MAX_LENGTH} characters`)
    }
    const reportedUses = result.sourceUses ?? []
    if (context.requiredSources.length === 0) {
      if (result.sourceUses === null || reportedUses.length > 0)
        errors.push('sourceUses: expected an empty list because this turn has no required sources')
    } else {
      if (reportedUses.length !== context.requiredSources.length) {
        errors.push(
          `sourceUses: expected exactly ${context.requiredSources.length} uses for sources: ${context.requiredSources.map((value) => JSON.stringify(value)).join(', ')}`
        )
      }
      const required = new Set(context.requiredSources)
      for (const use of reportedUses) {
        if (!required.has(use.source))
          errors.push(
            `sourceUses: unexpected source ${JSON.stringify(use.source)}; expected sources: ${context.requiredSources.map((value) => JSON.stringify(value)).join(', ')}`
          )
      }
      const reported = new Set(reportedUses.map((u) => u.source))
      for (const source of context.requiredSources) {
        if (!reported.has(source))
          errors.push(
            `sourceUses: no use reported for required source ${JSON.stringify(source)}; expected sources: ${context.requiredSources.map((value) => JSON.stringify(value)).join(', ')}`
          )
      }
    }
  }
  if (result.status === 'needs_ruling') {
    const permissible = new Set(context.permissibleDecisions)
    if (!result.rulingRequest.decisions.some((d) => permissible.has(d))) {
      errors.push('rulingRequest.decisions: names no permissible decision')
    }
    for (const d of result.rulingRequest.decisions) {
      if (!permissible.has(d))
        errors.push(`rulingRequest.decisions: ${JSON.stringify(d)} is not a permissible decision`)
    }
  }
  return errors
}

/** The driver's whole acceptance check: the shape, then the semantics. Only an `ok: true` result is ever accepted. */
export function validateDeveloperTurnResult(value: unknown, context: DeveloperTurnContext): TurnResultValidation {
  const parsed = parseDeveloperTurnResult(value, context)
  if (!parsed.ok) return parsed
  const errors = semanticErrors(parsed.result, context)
  return errors.length > 0 ? { ok: false, stage: 'semantic', errors } : parsed
}
