/**
 * The OpenTelemetry routes' pure half (`apps/log-server/specs/server.md` §§ 3 and 5, "OpenTelemetry"): an OTLP/HTTP
 * JSON export request split into one-record documents, each with its identity, checked against the Log SDK's
 * catalogue of `vinaya.*` names, and with every string value passed through the Log's redaction.
 *
 * Nothing here touches storage: `RepoLog` stores what this module returns, in one transaction per request. The OTLP
 * JSON encoding is read as plain objects — no OpenTelemetry package is bundled into the Worker — and a field this
 * module does not know is carried through unchanged, as the encoding requires of a receiver.
 */

import { createHash } from 'node:crypto'
import { checkReservedNames, describeContractFailure, redact, reservedNamesOf, traceIdFor } from './log-sdk-contract'

export type OtlpSignal = 'traces' | 'logs'
export type OtlpRecordKind = 'span' | 'log'

/** One record ready to store: its identity, its trace, and the record as a one-record OTLP JSON document. */
export type OtlpRecord = { kind: OtlpRecordKind; recordId: string; traceId: string | null; line: string }

/** One record the server refuses, with the reason it is kept under. */
export type OtlpRefusal = { kind: OtlpRecordKind; reason: string; line: string }

/** An export request's records, or why the request as a whole cannot be read. */
export type OtlpSplit =
  | { ok: true; records: OtlpRecord[]; refused: OtlpRefusal[] }
  | { ok: false; status?: 413; error: string }

/** A record over this size is refused rather than stored, as an event line over it is (spec § 3). */
export const MAX_RECORD_BYTES = 1024 * 1024

/**
 * The most bytes the one-record documents of one request may come to together, each counted at most at
 * `MAX_RECORD_BYTES`. A request past it is `413` as a whole, and nothing of it is stored.
 */
export const MAX_SPLIT_BYTES = 32 * 1024 * 1024

/** How much of an oversized record its refusal keeps; the refusal record keeps at most 64 KiB of any line. */
const REFUSED_LINE_CHARS = 64 * 1024

/**
 * `redact(value, home)` rewrites absolute paths under `home` to `~/…`. The server is not the machine that produced
 * the record, so it passes the empty string: every secret pattern still runs and no path is rewritten, exactly as for
 * an event line (spec § 3).
 */
const NO_HOME = ''

const ALL_ZERO = /^0+$/
const encoder = new TextEncoder()

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The keys of each signal's three levels: the request's groups, a group's scopes, a scope's records. */
const LEVELS = {
  traces: { groups: 'resourceSpans', scopes: 'scopeSpans', records: 'spans', kind: 'span' },
  logs: { groups: 'resourceLogs', scopes: 'scopeLogs', records: 'logRecords', kind: 'log' }
} as const

/**
 * A trace or span id as the encoding carries it — case-insensitive hex of a fixed width — in lower case, or `null`
 * when it is absent, malformed or all zeros, which the encoding uses for "no id".
 */
function hexId(value: unknown, width: 32 | 16): string | null {
  if (typeof value !== 'string' || value.length !== width || !/^[0-9a-fA-F]+$/.test(value)) return null
  return ALL_ZERO.test(value) ? null : value.toLowerCase()
}

/** JSON with every object's keys sorted, arrays in order: the same content always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * A record's identity (spec § 3). A span is `span:<traceId>:<spanId>`, so its start and its end, or a resend, are
 * one record — never its name or its times. A log record is `log:<sha256 of the canonical one-record document>`: the
 * record with its resource and its scope, so the same record resent is one record, and the same record from another
 * resource or scope is another.
 */
export function recordIdentity(kind: OtlpRecordKind, document: Json, record: Json): string | null {
  if (kind === 'span') {
    const traceId = hexId(record.traceId, 32)
    const spanId = hexId(record.spanId, 16)
    return traceId === null || spanId === null ? null : `span:${traceId}:${spanId}`
  }
  return `log:${createHash('sha256').update(canonicalJson(document)).digest('hex')}`
}

/** The trace id `run=<run id>` selects on the records route: the one the Log SDK derives from that run id. */
export function runTraceId(runId: string): string {
  return traceIdFor(runId)
}

/**
 * Split one export request for `signal` into one-record documents. A request whose body, groups or scopes are not
 * the encoding's shape cannot be split, and answers `400` as a whole, and one whose records with their resources and scopes come to more than `MAX_SPLIT_BYTES` answers `413`; a record that is refused is one of
 * `refused`, and every other record of the request is still returned to be stored.
 */
export function splitExport(signal: OtlpSignal, body: unknown): OtlpSplit {
  const level = LEVELS[signal]
  if (!isObject(body)) return { ok: false, error: 'the body is not an OTLP JSON export request object' }
  const groups = body[level.groups]
  if (groups === undefined) return { ok: true, records: [], refused: [] }
  if (!Array.isArray(groups)) return { ok: false, error: `${level.groups} is not an array` }

  const records: OtlpRecord[] = []
  const refused: OtlpRefusal[] = []
  // Every one-record document repeats its resource and scope, so the documents a request splits into can be far
  // larger than the request. Each record's size is reckoned before its document is built or redacted, and the
  // documents together are bounded, so one request can never make the object hold more than that bound.
  let total = 0
  for (const group of groups) {
    if (!isObject(group)) return { ok: false, error: `an entry of ${level.groups} is not an object` }
    const scopes = group[level.scopes] ?? []
    if (!Array.isArray(scopes)) return { ok: false, error: `${level.scopes} is not an array` }
    const groupBytes = jsonBytes({ ...group, [level.scopes]: [] })
    for (const scope of scopes) {
      if (!isObject(scope)) return { ok: false, error: `an entry of ${level.scopes} is not an object` }
      const entries = scope[level.records] ?? []
      if (!Array.isArray(entries)) return { ok: false, error: `${level.records} is not an array` }
      const contextBytes = groupBytes + jsonBytes({ ...scope, [level.records]: [] })
      for (const record of entries) {
        const size = contextBytes + jsonBytes(record)
        total += Math.min(size, MAX_RECORD_BYTES)
        if (total > MAX_SPLIT_BYTES) {
          return {
            ok: false,
            status: 413,
            error: 'the request’s records, each with its resource and scope, come to more than 32 MiB'
          }
        }
        if (size > MAX_RECORD_BYTES) {
          // Kept with the record alone, never its resource and scope: the size is what refused it.
          refused.push({ kind: level.kind, reason: `too_large:${size}`, line: oversizedLine(record) })
          continue
        }
        const document = { [level.groups]: [{ ...group, [level.scopes]: [{ ...scope, [level.records]: [record] }] }] }
        const outcome = oneRecord(level.kind, document, record)
        if (outcome.ok) records.push(outcome.record)
        else refused.push(outcome.refusal)
      }
    }
  }
  return { ok: true, records, refused }
}

/** The UTF-8 size of a value's JSON, before any redaction. */
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? 'null').byteLength
}

/** An oversized record as its refusal keeps it: redacted, then cut to what the refusal record holds. */
function oversizedLine(record: unknown): string {
  const text = JSON.stringify(redact(record, NO_HOME)) ?? 'null'
  return text.length <= REFUSED_LINE_CHARS ? text : text.slice(0, REFUSED_LINE_CHARS)
}

function oneRecord(
  kind: OtlpRecordKind,
  document: Json,
  record: unknown
): { ok: true; record: OtlpRecord } | { ok: false; refusal: OtlpRefusal } {
  const redacted = redact(document, NO_HOME)
  const line = JSON.stringify(redacted)
  const refuse = (reason: string) => ({ ok: false as const, refusal: { kind, reason, line } })

  if (!isObject(record)) return refuse(`invalid:the ${kind} is not an object`)
  const size = encoder.encode(line).byteLength
  if (size > MAX_RECORD_BYTES) return refuse(`too_large:${size}`)

  const failure = checkReservedNames(reservedNamesOf(document))
  if (failure !== null) return refuse(`contract:${describeContractFailure(failure)}`)

  // Identity is read from the record as it arrived: redaction is applied to what is stored, and two records that
  // differ only in a secret are two records.
  const recordId = recordIdentity(kind, document, record)
  if (recordId === null) return refuse('invalid:the span has no trace id and span id')

  return { ok: true, record: { kind, recordId, traceId: hexId(record.traceId, 32), line } }
}

/**
 * The OTLP export response body (spec § 5): `{}` when every record was stored or a duplicate, and a partial success
 * naming how many records were refused and why when some were. The count is a decimal string, as the encoding writes
 * a 64-bit integer.
 */
export function exportResponse(signal: OtlpSignal, refused: readonly OtlpRefusal[]): Json {
  if (refused.length === 0) return {}
  const counted = signal === 'traces' ? 'rejectedSpans' : 'rejectedLogRecords'
  const reasons = [...new Set(refused.map((refusal) => refusal.reason))]
  const shown = reasons.slice(0, 5).join('; ')
  const more = reasons.length > 5 ? `; and ${reasons.length - 5} more reasons` : ''
  const noun = refused.length === 1 ? 'record was' : 'records were'
  return {
    partialSuccess: {
      [counted]: String(refused.length),
      errorMessage: `${refused.length} ${noun} refused and kept in the server's OpenTelemetry refusal record: ${shown}${more}`
    }
  }
}

/** Whether a `content-type` header names OTLP's JSON encoding, `application/json`, with or without parameters. */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false
  return header.split(';')[0]?.trim().toLowerCase() === 'application/json'
}

/**
 * One stored OpenTelemetry record as the records route returns it. `line` is already a JSON document, so the line is
 * assembled by concatenation rather than parsed and re-serialized once per record.
 */
export function recordLine(seq: number, kind: string, line: string): string {
  return `{"seq":${seq},"kind":${JSON.stringify(kind)},"record":${line}}`
}
