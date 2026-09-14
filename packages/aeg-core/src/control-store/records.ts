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

/** One execution attempt against a task — written once, at start, immutable thereafter. */
export const RunRecordSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('run'),
    task: taskId,
    runId: z.string().min(1),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    startedAt: isoTimestamp
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

export type ControlRecord = RunRecord | InputRecord | OwnershipRecord | TransitionRecord

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
