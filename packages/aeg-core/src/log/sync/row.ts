/**
 * The normalised shape every reader of the Vinaya Log shares
 * (`apps/cli/specs/log-sync.md`): one dataset row per stored line that
 * validated, one quarantine record per line that did not. A row keeps the
 * fields a question filters or groups by as columns and the rest of the
 * event as JSON, so a family added later — a consumer's own declared event
 * included — is stored and read back without a code change here.
 *
 * Nothing in this module names an event kind or an event name: `kind` and
 * `event` are plain text, and the family body is an untyped JSON object.
 */

import type { Provenance } from '../schema'

/** Where a line was read from: the source's stable id and the line's opaque position inside it. Provenance only — never part of a row's identity, since two sources can hold the same event. */
export type RowOrigin = {
  source: string
  position: string
}

/**
 * How far a row's attribution can be trusted. `'low'` for a line written by
 * a CLI older than `LOW_TRUST_BELOW_VERSION`, or naming no readable CLI
 * version; otherwise the provenance the line's own header declares.
 */
export type RowTrust = 'low' | Provenance

/** A JSON object as parsed from a stored line — a row's header or family body. */
export type JsonObject = { readonly [key: string]: unknown }

/** The row columns that can read as unknown: each one a field some schema version's header does not have. */
export type UnknownableField = 'workRef' | 'actor' | 'flowId' | 'flowVersion' | 'provenance' | 'trust'

/** One stored line that fully validated, normalised. */
export type DatasetRow = {
  /** The line's stable identity: its `event_id`, or `<run_id>:<seq>` for a schema 1 line. */
  identity: string
  schema: number
  kind: string
  event: string
  /** `meta.ts` as written. */
  time: string
  runId: string
  seq: number
  /** `meta.work.ref` — schema 3 onward; unknown before. */
  workRef: string | null
  /** `meta.actor_id` — schema 2 onward; unknown before. */
  actor: string | null
  /** `meta.vinaya`, the CLI version that wrote the line. */
  cliVersion: string
  doctrine: string
  /** `meta.flow.id` / `meta.flow.version` — schema 3 onward; unknown before. */
  flowId: string | null
  flowVersion: string | null
  host: string
  repo: string | null
  /** `meta.provenance` — schema 2 onward; unknown before. */
  provenance: Provenance | null
  /** `'low'` or the declared provenance; unknown when neither applies (a schema 1 line from a trusted CLI version). */
  trust: RowTrust | null
  issue: number | null
  pr: number | null
  round: number | null
  /** `subject.sha`. */
  commit: string | null
  role: string
  objectivesVersion: string | null
  /** The line's `meta` and `subject` exactly as validated — every header field, including the ones with no column. */
  header: { meta: JsonObject; subject: JsonObject }
  /** Every field of the event outside `meta`, `subject`, `kind` and `event` — the family body, as JSON. */
  payload: JsonObject
  /** sha256 (hex) of the line as the read boundary serialises it after redaction. */
  contentHash: string
  origin: RowOrigin | null
  /**
   * Each column whose value the line's schema cannot state, with the reason.
   * A column named here is `null` and means "not recorded", never "none" —
   * a column absent from this map carries the line's own value, `null`
   * included.
   */
  unknown: Readonly<Partial<Record<UnknownableField, string>>>
}

/** One stored line that did not validate: an unknown schema version, or a known one that failed validation. It produces no row. */
export type QuarantineRecord = {
  status: 'unknown_version' | 'invalid'
  /** The line's identity when one could be read from it, else `null`. */
  identity: string | null
  /** `meta.schema` when readable, else `null`. */
  schema: number | null
  reason: string
  /** The line's text after redaction — a secret in a line that failed validation never reaches a cache. */
  raw: string
  /** sha256 (hex) of `raw` — what keys a quarantine record, since `identity` can be absent. */
  contentHash: string
  origin: RowOrigin | null
}

/** A stored line after normalisation: exactly one row or exactly one quarantine record. */
export type NormalizedLine = { type: 'row'; row: DatasetRow } | { type: 'quarantine'; record: QuarantineRecord }

/** A line written by a CLI version below this one is low-trust: attribution before it was not recorded reliably. */
export const LOW_TRUST_BELOW_VERSION = '0.33.0'
