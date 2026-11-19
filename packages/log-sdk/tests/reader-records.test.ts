import { expect, test } from 'bun:test'
import {
  ATTRIBUTE_NAMES as A,
  createLineReader,
  createLiveEarlierConverter,
  EVENT_NAMES as E,
  identityOf,
  LogEventSchema,
  readOtlpDocument
} from '../src/index.js'

const earlierLines = (await Bun.file(new URL('./fixtures/earlier-events.jsonl', import.meta.url)).text())
  .trim()
  .split('\n')

function kv(key: string, value: string | number | boolean) {
  const encoded =
    typeof value === 'string'
      ? { stringValue: value }
      : typeof value === 'number'
        ? { intValue: String(value) }
        : { boolValue: value }
  return { key, value: encoded }
}

const tracesLine = JSON.stringify({
  resourceSpans: [
    {
      resource: { attributes: [kv('service.name', 'vinaya'), kv(A.repository, 'acme/widgets')] },
      scopeSpans: [
        {
          scope: {},
          spans: [
            {
              traceId: 'AABBCCDDEEFF00112233445566778899',
              spanId: '0102030405060708',
              parentSpanId: '1112131415161718',
              name: 'vinaya.round 2',
              kind: 1,
              startTimeUnixNano: '1000',
              endTimeUnixNano: 5000,
              attributes: [
                kv(A.seq, 4),
                kv(A.writerId, 'w-1'),
                kv(A.provenance, 'governed'),
                kv(A.roundNumber, 2),
                { key: 'nested', value: { kvlistValue: { values: [kv('a', true)] } } },
                { key: 'list', value: { arrayValue: { values: [{ stringValue: 'x' }, { intValue: '7' }] } } },
                { key: 'absent', value: {} }
              ]
            }
          ]
        }
      ]
    }
  ]
})

const logsLine = JSON.stringify({
  resourceLogs: [
    {
      resource: { attributes: [kv('service.name', 'vinaya')] },
      scopeLogs: [
        {
          scope: {},
          logRecords: [
            {
              eventName: E.roundStarted,
              traceId: 'aabbccddeeff00112233445566778899',
              spanId: '0102030405060708',
              timeUnixNano: '900',
              attributes: [kv(A.seq, 3), kv(A.writerId, 'w-1'), kv(A.eventId, 'w-1:3')]
            },
            { timeUnixNano: '950', body: { stringValue: 'plain log' }, attributes: [] }
          ]
        }
      ]
    }
  ]
})

test('a traces line reads into the record model', () => {
  const { records, problem } = createLineReader('copy').readLine(tracesLine)
  expect(problem).toBeNull()
  expect(records).toHaveLength(1)
  const [span] = records
  expect(span).toMatchObject({
    kind: 'span',
    traceId: 'aabbccddeeff00112233445566778899',
    spanId: '0102030405060708',
    parentSpanId: '1112131415161718',
    name: 'vinaya.round 2',
    startTime: '1000',
    time: '5000',
    seq: 4,
    writerId: 'w-1',
    eventId: null,
    provenance: 'governed',
    source: 'copy'
  })
  expect(span?.attributes.nested).toEqual({ a: true })
  expect(span?.attributes.list).toEqual(['x', 7])
  expect(span?.attributes.absent).toBeNull()
  expect(span?.resource['service.name']).toBe('vinaya')
})

test('a logs line reads started events and plain events, and a record that states no provenance is reported', () => {
  const { records } = createLineReader('copy').readLine(logsLine)
  expect(records.map(({ kind, name }) => [kind, name])).toEqual([
    ['started', E.roundStarted],
    ['event', 'plain log']
  ])
  expect(records[0]).toMatchObject({
    seq: 3,
    writerId: 'w-1',
    eventId: 'w-1:3',
    provenance: 'reported',
    parentSpanId: null
  })
  expect(identityOf(records[0] as never)).toBe('started:w-1:3')
})

test('an earlier stored line reads to the records the live converter gives for it', () => {
  const reader = createLineReader('copy')
  const converter = createLiveEarlierConverter('run-historical')
  for (const line of earlierLines.slice(0, 12)) {
    const converted = converter.convert(LogEventSchema.parse(JSON.parse(line)))
    const { records, problem } = reader.readLine(line)
    expect(problem).toBeNull()
    expect(records).toHaveLength(1)
    const [record] = records
    expect(record?.name).toBe(converted.type === 'span' ? converted.record.name : converted.record.eventName)
    expect(record?.kind === 'span').toBe(converted.type === 'span')
    expect(record?.traceId).toBe(converted.record.traceId)
    expect(record?.spanId).toBe(converted.record.spanId)
    expect(record?.seq).toEqual(Number(JSON.parse(line).meta.seq))
    expect(record?.writerId).toBe('earlier:run-historical')
    expect(record?.provenance).toBe('governed')
  }
})

test('a line that is neither is reported and never thrown', () => {
  const reader = createLineReader('copy')
  const unknownVersion = JSON.stringify({
    meta: { schema: 99, run_id: 'r', seq: 1 },
    secret: `${['sk', 'ant', 'api03'].join('-')}-abcdefghijklmnopqrstuvwxyz`
  })
  const invalid = JSON.stringify({ meta: { schema: 1, run_id: 'r', seq: 1 }, kind: 'nothing' })
  const lines = ['{"half":', '', '[1,2]', '42', '{"nothing":true}', '{"resourceMetrics":[]}', unknownVersion, invalid]
  const reasons = lines.map((line) => {
    const result = reader.readLine(line)
    expect(result.records).toEqual([])
    expect(JSON.stringify(result.problem)).not.toContain('sk-ant')
    return result.problem?.reason
  })
  expect(reasons).toEqual([
    'not_json',
    'not_json',
    'not_a_log_line',
    'not_a_log_line',
    'not_a_log_line',
    'not_a_log_line',
    'unknown_version',
    'invalid_earlier_line'
  ])
})

test('a document with no span or log record is empty and one of another signal is not a document', () => {
  expect(readOtlpDocument({ resourceSpans: [] }, 's')).toEqual([])
  expect(readOtlpDocument({ resourceMetrics: [] }, 's')).toBeNull()
  expect(readOtlpDocument('text', 's')).toBeNull()
})

test('two spans with empty ids from another tool keep distinct identities', () => {
  const doc = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              { traceId: '', spanId: '', name: 'a', startTimeUnixNano: '1', endTimeUnixNano: '2' },
              { traceId: '', spanId: '', name: 'b', startTimeUnixNano: '1', endTimeUnixNano: '2' }
            ]
          }
        ]
      }
    ]
  }
  const [a, b] = readOtlpDocument(doc, 's') ?? []
  expect(identityOf(a as never)).not.toBe(identityOf(b as never))
})
