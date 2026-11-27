/**
 * The OpenTelemetry routes' pure half (`src/otlp.ts`): splitting an export request into one-record documents,
 * record identities, the catalogue check on `vinaya.*` names and redaction (`apps/log-server/specs/server.md` §§ 3
 * and 5).
 *
 * Every request here starts from the Log SDK's own sender's bodies, captured for a recorded run in
 * `fixtures/sdk-export.json` — a record that must be refused or a team's own span is made by changing one field of a
 * captured record, never written from nothing.
 */

import { describe, expect, it } from 'vitest'
import fixture from './fixtures/sdk-export.json'
import { traceIdFor } from './log-sdk-contract'
import {
  exportResponse,
  isJsonContentType,
  MAX_RECORD_BYTES,
  MAX_SPLIT_BYTES,
  recordIdentity,
  runTraceId,
  splitExport
} from './otlp'

type Json = Record<string, any>

const exports = fixture.exports as { path: string; body: Json }[]
const traces = exports.filter((entry) => entry.path.endsWith('/v1/traces')).map((entry) => entry.body)
const logs = exports.filter((entry) => entry.path.endsWith('/v1/logs')).map((entry) => entry.body)

/** A deep copy of a captured body, to change one field of. */
function copy(body: Json): Json {
  return structuredClone(body)
}

function spanOf(body: Json): Json {
  return body.resourceSpans[0].scopeSpans[0].spans[0]
}

function logOf(body: Json): Json {
  return body.resourceLogs[0].scopeLogs[0].logRecords[0]
}

/** Every captured span in one request, under the first body's resource and scope. */
function allSpansInOne(): Json {
  const request = copy(traces[0] as Json)
  request.resourceSpans[0].scopeSpans[0].spans = traces.map((body) => spanOf(body))
  return request
}

describe('an export request splits into one document per record', () => {
  it('splits every captured traces and logs body into one stored record each, none refused', () => {
    for (const body of traces) {
      const split = splitExport('traces', body)
      expect(split).toMatchObject({ ok: true, refused: [] })
      if (!split.ok) continue
      expect(split.records).toHaveLength(1)
      expect(split.records[0]?.kind).toBe('span')
    }
    for (const body of logs) {
      const split = splitExport('logs', body)
      expect(split).toMatchObject({ ok: true, refused: [] })
      if (!split.ok) continue
      expect(split.records).toHaveLength(1)
      expect(split.records[0]?.kind).toBe('log')
    }
  })

  it('splits a request of several spans into one document per span, each keeping its resource and scope', () => {
    const request = allSpansInOne()
    const split = splitExport('traces', request)
    if (!split.ok) throw new Error(split.error)
    expect(split.records).toHaveLength(traces.length)
    for (const [index, record] of split.records.entries()) {
      const document = JSON.parse(record.line)
      expect(document.resourceSpans).toHaveLength(1)
      expect(document.resourceSpans[0].resource).toEqual(request.resourceSpans[0].resource)
      expect(document.resourceSpans[0].scopeSpans[0].scope).toEqual(request.resourceSpans[0].scopeSpans[0].scope)
      expect(document.resourceSpans[0].scopeSpans[0].spans).toEqual([spanOf(traces[index] as Json)])
    }
  })

  it('reads only the route’s own signal, and an empty request is no records', () => {
    expect(splitExport('logs', traces[0])).toEqual({ ok: true, records: [], refused: [] })
    expect(splitExport('traces', {})).toEqual({ ok: true, records: [], refused: [] })
  })

  it('refuses a request whose body, groups or scopes are not the encoding’s shape as a whole', () => {
    expect(splitExport('traces', [])).toMatchObject({ ok: false })
    expect(splitExport('traces', { resourceSpans: {} })).toMatchObject({ ok: false })
    expect(splitExport('traces', { resourceSpans: ['x'] })).toMatchObject({ ok: false })
    const scopes = copy(traces[0] as Json)
    scopes.resourceSpans[0].scopeSpans = 'x'
    expect(splitExport('traces', scopes)).toMatchObject({ ok: false })
  })
})

describe('record identity', () => {
  it('is the trace id and span id for a span, in lower case, never its name or times', () => {
    const body = traces[0] as Json
    const span = spanOf(body)
    expect(recordIdentity('span', body, span)).toBe(`span:${span.traceId}:${span.spanId}`)

    const renamed = copy(body)
    Object.assign(spanOf(renamed), {
      name: 'another name',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      traceId: String(span.traceId).toUpperCase(),
      spanId: String(span.spanId).toUpperCase()
    })
    expect(recordIdentity('span', renamed, spanOf(renamed))).toBe(`span:${span.traceId}:${span.spanId}`)
  })

  it('refuses a span with no trace id and span id', () => {
    const body = copy(traces[0] as Json)
    spanOf(body).spanId = '0000000000000000'
    const split = splitExport('traces', body)
    expect(split).toMatchObject({
      ok: true,
      records: [],
      refused: [{ kind: 'span', reason: expect.stringMatching(/^invalid:/) }]
    })
  })

  it('gives equal log records one identity, and the same record under another resource or scope another', () => {
    const body = logs[0] as Json
    const first = splitExport('logs', body)
    const again = splitExport('logs', copy(body))
    if (!first.ok || !again.ok) throw new Error('the captured logs body did not split')
    expect(again.records[0]?.recordId).toBe(first.records[0]?.recordId)
    expect(first.records[0]?.recordId).toMatch(/^log:[0-9a-f]{64}$/)

    const otherResource = copy(body)
    otherResource.resourceLogs[0].resource.attributes.push({ key: 'service.instance.id', value: { stringValue: 'b' } })
    const otherScope = copy(body)
    otherScope.resourceLogs[0].scopeLogs[0].scope.name = 'another-scope'
    const ids = [otherResource, otherScope].map((changed) => {
      const split = splitExport('logs', changed)
      if (!split.ok) throw new Error(split.error)
      return split.records[0]?.recordId
    })
    expect(new Set([first.records[0]?.recordId, ...ids]).size).toBe(3)
  })

  it('a started event and its span are two records with two identities', () => {
    const started = logs.find((body) => logOf(body).eventName === 'vinaya.agent.started') as Json
    const span = traces.find((body) => String(spanOf(body).name).startsWith('invoke_agent')) as Json
    const a = splitExport('logs', started)
    const b = splitExport('traces', span)
    if (!a.ok || !b.ok) throw new Error('the captured bodies did not split')
    expect(a.records[0]?.recordId).not.toBe(b.records[0]?.recordId)
  })

  it('selects a run by the trace id the Log SDK derives from its run id', () => {
    expect(runTraceId(fixture.runId)).toBe(traceIdFor(fixture.runId))
    expect(spanOf(traces[0] as Json).traceId).toBe(runTraceId(fixture.runId))
  })
})

describe('the catalogue check and redaction', () => {
  it('refuses a record with a vinaya name outside the catalogue, with its reason, and stores the rest', () => {
    const request = copy(logs[0] as Json)
    const unknown = copy(logOf(request))
    unknown.eventName = 'vinaya.not.in.the.catalogue'
    request.resourceLogs[0].scopeLogs[0].logRecords.push(unknown)
    const split = splitExport('logs', request)
    if (!split.ok) throw new Error(split.error)
    expect(split.records).toHaveLength(1)
    expect(split.refused).toHaveLength(1)
    expect(split.refused[0]?.reason).toBe(
      'contract:event name "vinaya.not.in.the.catalogue" is not in the Log\'s contract'
    )

    const attribute = copy(traces[0] as Json)
    spanOf(attribute).attributes.push({ key: 'vinaya.unknown.attribute', value: { stringValue: 'x' } })
    const refused = splitExport('traces', attribute)
    expect(refused).toMatchObject({
      ok: true,
      records: [],
      refused: [{ reason: 'contract:span attribute "vinaya.unknown.attribute" is not in the Log\'s contract' }]
    })
  })

  it('stores a record with only standard or other names, such as a team’s own tracing', () => {
    const team = copy(traces[0] as Json)
    team.resourceSpans[0].resource.attributes = team.resourceSpans[0].resource.attributes.filter(
      (attribute: Json) => !String(attribute.key).startsWith('vinaya.')
    )
    Object.assign(spanOf(team), {
      name: 'GET /widgets',
      attributes: [
        { key: 'http.request.method', value: { stringValue: 'GET' } },
        { key: 'team.feature', value: { stringValue: 'widgets' } }
      ]
    })
    const split = splitExport('traces', team)
    expect(split).toMatchObject({ ok: true, refused: [] })
    if (split.ok) expect(JSON.parse(split.records[0]?.line ?? '{}')).toEqual(team)
  })

  it('passes every string value through the Log’s redaction before it is stored', () => {
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
    const body = copy(traces[0] as Json)
    spanOf(body).attributes.push({ key: 'team.note', value: { stringValue: `pushed with ${token}` } })
    const split = splitExport('traces', body)
    if (!split.ok) throw new Error(split.error)
    expect(split.records[0]?.line).not.toContain(token)
    expect(split.records[0]?.line).toContain('pushed with <redacted>')
  })
})

describe('what one request may cost to split', () => {
  it('refuses a record over 1 MiB with its resource and scope, keeping the record alone and storing the rest', () => {
    const request = copy(traces[0] as Json)
    const big = copy(spanOf(request))
    big.spanId = 'abcdefabcdefabcd'
    big.attributes.push({ key: 'team.blob', value: { stringValue: 'a'.repeat(MAX_RECORD_BYTES) } })
    request.resourceSpans[0].scopeSpans[0].spans.push(big)
    const split = splitExport('traces', request)
    if (!split.ok) throw new Error(split.error)
    expect(split.records).toHaveLength(1)
    expect(split.refused).toHaveLength(1)
    expect(split.refused[0]?.reason).toMatch(/^too_large:\d+$/)
    expect(split.refused[0]?.line.length).toBeLessThanOrEqual(64 * 1024)
    expect(split.refused[0]?.line).not.toContain('resourceSpans')
  })

  it('answers 413 as a whole when a large resource repeated for many small records passes the bound', () => {
    const request = copy(traces[0] as Json)
    request.resourceSpans[0].resource.attributes.push({
      key: 'team.large',
      value: { stringValue: 'r'.repeat(512 * 1024) }
    })
    const span = spanOf(request)
    const count = Math.ceil(MAX_SPLIT_BYTES / (512 * 1024)) + 1
    request.resourceSpans[0].scopeSpans[0].spans = Array.from({ length: count }, (_, n) => ({
      ...span,
      spanId: n.toString(16).padStart(16, '1')
    }))
    expect(splitExport('traces', request)).toEqual({ ok: false, status: 413, error: expect.stringContaining('32 MiB') })
  })
})

describe('the export response', () => {
  it('is empty when nothing was refused, and a partial success naming the count and reason otherwise', () => {
    expect(exportResponse('traces', [])).toEqual({})
    const refused = [{ kind: 'span' as const, reason: 'contract:x', line: '{}' }]
    expect(exportResponse('traces', refused)).toEqual({
      partialSuccess: { rejectedSpans: '1', errorMessage: expect.stringContaining('contract:x') }
    })
    expect(exportResponse('logs', [...refused, ...refused])).toEqual({
      partialSuccess: { rejectedLogRecords: '2', errorMessage: expect.stringContaining('2 records were refused') }
    })
  })

  it('takes application/json with or without parameters, and nothing else', () => {
    expect(isJsonContentType('application/json')).toBe(true)
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true)
    expect(isJsonContentType('application/x-protobuf')).toBe(false)
    expect(isJsonContentType('application/x-ndjson')).toBe(false)
    expect(isJsonContentType(null)).toBe(false)
  })
})
