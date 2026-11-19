import { expect, test } from 'bun:test'
import { ATTRIBUTE_NAMES as A, createOtlpSource, createReader, type OtlpPage } from '../src/index.js'

function logDocument(seq: number, writerId = 'w') {
  return {
    resourceLogs: [
      {
        resource: { attributes: [] },
        scopeLogs: [
          {
            logRecords: [
              {
                eventName: 'something.happened',
                traceId: 'a'.repeat(32),
                spanId: 'b'.repeat(16),
                timeUnixNano: String(1000 + seq),
                attributes: [
                  { key: A.seq, value: { intValue: String(seq) } },
                  { key: A.writerId, value: { stringValue: writerId } },
                  { key: A.eventId, value: { stringValue: `${writerId}:${seq}` } },
                  { key: A.provenance, value: { stringValue: 'governed' } }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
}

/** A supplier over a list of documents, `cursor` being how many it has handed. */
function supplierOf(documents: unknown[], calls: (string | undefined)[] = []) {
  return async (cursor: string | undefined): Promise<OtlpPage> => {
    calls.push(cursor)
    const from = cursor === undefined ? 0 : Number(cursor)
    return { documents: documents.slice(from), cursor: String(documents.length) }
  }
}

test("a caller's supplier is read from a cursor and followed with no repeat", async () => {
  const documents: unknown[] = [logDocument(0), logDocument(1)]
  const calls: (string | undefined)[] = []
  const source = createOtlpSource({ name: 'tool', supply: supplierOf(documents, calls), foreign: false })
  const reader = createReader(source)
  expect((await reader.pull()).records.map(({ seq }) => seq)).toEqual([0, 1])
  expect((await reader.pull()).records).toEqual([])
  documents.push(logDocument(2))
  expect((await reader.pull()).records.map(({ seq }) => seq)).toEqual([2])
  expect(calls).toEqual([undefined, '2', '2'])
  expect(reader.position()).toBe('3')
})

test("a reader resumes from the caller's cursor after a restart without repeating a record", async () => {
  const documents = [logDocument(0), logDocument(1), logDocument(2)]
  const first = createReader(createOtlpSource({ name: 'tool', supply: supplierOf(documents.slice(0, 2)) }))
  await first.pull()
  const kept = first.position()
  const second = createReader(createOtlpSource({ name: 'tool', supply: supplierOf(documents) }), { position: kept })
  expect((await second.pull()).records.map(({ seq }) => seq)).toEqual([2])
})

test('a failing supplier is reported and retried from the same cursor', async () => {
  const cursors: (string | undefined)[] = []
  let failing = true
  const source = createOtlpSource({
    name: 'tool',
    supply: async (cursor) => {
      cursors.push(cursor)
      if (failing)
        throw new Error(`connection refused with token ${['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')}`)
      return { documents: [logDocument(0)], cursor: '1' }
    }
  })
  const reader = createReader(source, { position: 'kept' })
  const failed = await reader.pull()
  expect(failed.records).toEqual([])
  expect(failed.gaps).toHaveLength(1)
  expect(failed.gaps[0]?.kind).toBe('source_unavailable')
  expect(JSON.stringify(failed.gaps)).not.toContain('ghp_')
  expect(reader.position()).toBe('kept')
  failing = false
  expect((await reader.pull()).records).toHaveLength(1)
  expect(cursors).toEqual(['kept', 'kept'])
})

test('a document that is not OTLP traces or logs is reported, and JSON text is read as a document', async () => {
  const source = createOtlpSource({
    name: 'tool',
    supply: async () => ({
      documents: [{ resourceMetrics: [] }, 'not json', JSON.stringify(logDocument(0))],
      cursor: '3'
    })
  })
  const update = await createReader(source).pull()
  expect(update.records).toHaveLength(1)
  expect(update.gaps.map(({ kind, place }) => [kind, place])).toEqual([
    ['unrecognised_document', 'tool document 0'],
    ['unrecognised_document', 'tool document 1']
  ])
})

test('a source is foreign by default and its records are reported, whatever they claim', async () => {
  const supply = supplierOf([logDocument(0)])
  expect((await createReader(createOtlpSource({ name: 'tool', supply })).pull()).records[0]?.provenance).toBe(
    'reported'
  )
  expect(
    (await createReader(createOtlpSource({ name: 'own', supply, foreign: false })).pull()).records[0]?.provenance
  ).toBe('governed')
})
