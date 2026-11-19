import { expect, test } from 'bun:test'
import {
  ATTRIBUTE_NAMES as A,
  applyTrust,
  createReader,
  FORBIDDEN_CONTENT_ATTRIBUTES,
  type OtelRecord,
  type RecordSource
} from '../src/index.js'

function record(attributes: OtelRecord['attributes'], overrides: Partial<OtelRecord> = {}): OtelRecord {
  return {
    kind: 'event',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'something.happened',
    startTime: null,
    time: '10',
    attributes,
    resource: {},
    seq: null,
    writerId: null,
    eventId: null,
    provenance: 'reported',
    source: 's',
    ...overrides
  }
}

const SECRET = `${['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')}`

test("a record that states no provenance is reported and one that states governed keeps it from the Log's own source", () => {
  expect(applyTrust(record({}), { foreign: false }).provenance).toBe('reported')
  expect(
    applyTrust(record({ [A.provenance]: 'governed' }, { provenance: 'governed' }), { foreign: false }).provenance
  ).toBe('governed')
})

test('every record of a foreign source is reported, whatever it claims', () => {
  const claimed = record({ [A.provenance]: 'governed' }, { provenance: 'governed' })
  expect(applyTrust(claimed, { foreign: true }).provenance).toBe('reported')
})

test('the GenAI content attributes are dropped and kept nowhere in the record', () => {
  const content = Object.fromEntries(FORBIDDEN_CONTENT_ATTRIBUTES.map((key) => [key, 'the prompt text']))
  const trusted = applyTrust(
    record({ ...content, 'gen_ai.agent.name': 'reviewer', nested: { 'gen_ai.input.messages': 'deep prompt' } }),
    { foreign: false }
  )
  expect(Object.keys(trusted.attributes).sort()).toEqual(['gen_ai.agent.name', 'nested'])
  expect(JSON.stringify(trusted)).not.toContain('prompt')
  const resource = applyTrust(record({}, { resource: { 'gen_ai.output.messages': 'answer text' } }), { foreign: false })
  expect(JSON.stringify(resource)).not.toContain('answer')
})

test('a secret-shaped string value is redacted wherever it sits, and the home directory is shortened', () => {
  const trusted = applyTrust(
    record(
      { token: SECRET, list: [`Bearer ${SECRET}`], nested: { path: '/home/someone/work', keep: 7 } },
      { name: `with ${SECRET}`, resource: { secret: `password=${'x'.repeat(20)}` } }
    ),
    { foreign: false, home: '/home/someone' }
  )
  const text = JSON.stringify(trusted)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain('x'.repeat(20))
  expect(trusted.attributes.token).toBe('<redacted>')
  expect(trusted.attributes.nested).toEqual({ path: '~/work', keep: 7 })
})

test('a reader applies trust and redaction to every record it hands', async () => {
  const source: RecordSource = {
    name: 'other tool',
    foreign: true,
    read: async () => ({
      records: [
        record(
          { [A.provenance]: 'governed', 'gen_ai.input.messages': 'prompt', token: SECRET },
          { provenance: 'governed' }
        )
      ],
      problems: [],
      position: 'p1'
    })
  }
  const { records } = await createReader(source).pull()
  expect(records).toHaveLength(1)
  expect(records[0]?.provenance).toBe('reported')
  expect(JSON.stringify(records)).not.toContain('prompt')
  expect(JSON.stringify(records)).not.toContain(SECRET)
})

test('identity and source fields are redacted too', () => {
  const trusted = applyTrust(
    record({}, { writerId: SECRET, eventId: `${SECRET}:1`, source: SECRET, spanId: SECRET, traceId: SECRET }),
    { foreign: true }
  )
  expect(JSON.stringify(trusted)).not.toContain(SECRET)
})
