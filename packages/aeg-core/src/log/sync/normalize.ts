/**
 * The one normaliser: a stored log line in, exactly one dataset row or
 * exactly one quarantine record out (`apps/cli/specs/log-sync.md`).
 * Validation, schema-version handling and redaction are
 * `classifyStoredLine`'s; this module only maps its three outcomes. Pure —
 * `node:crypto` is the one import outside this package.
 */

import { createHash } from 'node:crypto'
import type { Provenance } from '../schema'
import { classifyStoredLine } from '../store'
import {
  type DatasetRow,
  type JsonObject,
  LOW_TRUST_BELOW_VERSION,
  type NormalizedLine,
  type RowOrigin,
  type RowTrust,
  type UnknownableField
} from './row'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' ? (value as JsonObject) : {}
}

function has(obj: JsonObject, key: string): boolean {
  return Object.hasOwn(obj, key)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

type ParsedVersion = { core: [number, number, number]; prerelease: boolean }

function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(text.trim())
  if (match === null) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] !== undefined }
}

/** `true` when `version` names no readable CLI version, or one below `LOW_TRUST_BELOW_VERSION` (a pre-release of the threshold itself counts as below it). */
export function isLowTrustVersion(version: string): boolean {
  const parsed = parseVersion(version)
  const floor = parseVersion(LOW_TRUST_BELOW_VERSION) as ParsedVersion
  if (parsed === null) return true
  for (let i = 0; i < 3; i++) {
    const a = parsed.core[i] as number
    const b = floor.core[i] as number
    if (a !== b) return a < b
  }
  return parsed.prerelease
}

/**
 * Normalises one stored line. `origin` records where it was read from and
 * is carried on the result unchanged — it never feeds the identity or the
 * content hash.
 */
export function normalizeStoredLine(raw: string, origin: RowOrigin | null = null): NormalizedLine {
  const classified = classifyStoredLine(raw, '')
  if (classified.status !== 'ok') {
    return {
      type: 'quarantine',
      record: {
        status: classified.status,
        identity: classified.identity,
        schema: classified.status === 'unknown_version' ? classified.schema : null,
        reason: classified.reason,
        raw: classified.raw,
        contentHash: sha256(classified.raw),
        origin
      }
    }
  }

  const stored = asObject(JSON.parse(classified.postLine))
  const meta = asObject(stored.meta)
  const subject = asObject(stored.subject)
  const schema = classified.schema
  const unknown: Partial<Record<UnknownableField, string>> = {}
  const missing = (field: UnknownableField, headerField: string): null => {
    unknown[field] = `a schema ${schema} header has no ${headerField}`
    return null
  }

  const work = asObject(meta.work)
  const flow = asObject(meta.flow)
  const workRef = has(meta, 'work') ? stringOrNull(work.ref) : missing('workRef', 'work.ref')
  const actor = has(meta, 'actor_id') ? stringOrNull(meta.actor_id) : missing('actor', 'actor_id')
  const flowId = has(meta, 'flow') ? stringOrNull(flow.id) : missing('flowId', 'flow.id')
  const flowVersion = has(meta, 'flow') ? stringOrNull(flow.version) : missing('flowVersion', 'flow.version')
  const provenance = has(meta, 'provenance')
    ? (stringOrNull(meta.provenance) as Provenance | null)
    : missing('provenance', 'provenance')

  const cliVersion = typeof meta.vinaya === 'string' ? meta.vinaya : ''
  let trust: RowTrust | null
  if (isLowTrustVersion(cliVersion)) trust = 'low'
  else if (provenance !== null) trust = provenance
  else {
    trust = null
    unknown.trust = `a schema ${schema} header declares no provenance`
  }

  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (key !== 'meta' && key !== 'subject' && key !== 'kind' && key !== 'event') payload[key] = value
  }

  const row: DatasetRow = {
    identity: classified.identity,
    schema,
    kind: String(stored.kind),
    event: String(stored.event),
    time: String(meta.ts),
    runId: classified.runId,
    seq: classified.seq,
    workRef,
    actor,
    cliVersion,
    doctrine: String(meta.doctrine),
    flowId,
    flowVersion,
    host: String(meta.host),
    repo: stringOrNull(meta.repo),
    provenance,
    trust,
    issue: integerOrNull(subject.issue),
    pr: integerOrNull(subject.pr),
    round: integerOrNull(subject.round),
    commit: stringOrNull(subject.sha),
    role: String(subject.role),
    objectivesVersion: stringOrNull(subject.objectives_version),
    header: { meta, subject },
    payload,
    contentHash: sha256(classified.postLine),
    origin,
    unknown
  }
  return { type: 'row', row }
}
