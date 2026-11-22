import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkRecordContract,
  connect,
  convertEarlierEvents,
  createFolderSource,
  createReader,
  LogEventSchema,
  type OtelRecord,
  sendLocalCopy
} from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'log-sdk-recheck-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let counter = 0

const str = (key: string, value: string) => ({ key, value: { stringValue: value } })
const ids = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }

const writerStamp = str('vinaya.writer.id', 'writer')

function eventLine(name: string, attributes: ReturnType<typeof str>[] = [], resource = [str('service.name', 'x')]) {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: resource },
        scopeLogs: [
          {
            logRecords: [
              {
                eventName: name,
                ...ids,
                timeUnixNano: String(1_000 + counter++),
                attributes: [writerStamp, ...attributes]
              }
            ]
          }
        ]
      }
    ]
  })
}

function spanLine(name: string, attributes: ReturnType<typeof str>[] = []) {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'x')] },
        scopeSpans: [
          {
            spans: [
              {
                name,
                traceId: ids.traceId,
                spanId: String(1000 + counter++).padStart(16, '0'),
                startTimeUnixNano: '1',
                endTimeUnixNano: '2',
                attributes: [writerStamp, ...attributes]
              }
            ]
          }
        ]
      }
    ]
  })
}

/** A local copy in its own folder holding the given lines, and what sending it and reading it say. */
async function run(lines: string[], signal: 'logs' | 'traces' = 'logs') {
  const folder = join(root, `case-${counter++}`)
  const directory = join(folder, 'acme-widgets')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, `run-1~writer~000000000000.${signal}.jsonl`), lines.map((line) => `${line}\n`).join(''))
  const posted: string[] = []
  const report = await sendLocalCopy({
    folder,
    repository: 'acme/widgets',
    url: 'https://collector.example',
    fetch: async (_url, init) => {
      posted.push(String(init.body))
      return new Response(null, { status: 204 })
    }
  })
  const again: string[] = []
  await sendLocalCopy({
    folder,
    repository: 'acme/widgets',
    url: 'https://collector.example',
    fetch: async (_url, init) => {
      again.push(String(init.body))
      return new Response(null, { status: 204 })
    }
  })
  const update = await createReader(createFolderSource({ folder: directory, runId: 'run-1' })).readAll()
  return { report, posted, again, update, contractGaps: update.gaps.filter((gap) => gap.kind === 'contract') }
}

async function expectFits(lines: string[], signal: 'logs' | 'traces' = 'logs') {
  const result = await run(lines, signal)
  expect(result.report.setAside).toEqual([])
  expect(result.report.sent).toBe(lines.length)
  expect(result.posted).toEqual(lines)
  expect(result.contractGaps).toEqual([])
  // A line may hold several records.
  expect(result.update.records.length).toBeGreaterThanOrEqual(lines.length)
  return result
}

async function expectFails(failing: string, name: string, signal: 'logs' | 'traces' = 'logs') {
  const make = signal === 'logs' ? eventLine : spanLine
  const before = make('team.before')
  const after = make('team.after')
  const result = await run([before, failing, after], signal)
  // The failing line is set aside with its name, never posted, and not posted again.
  expect(result.report.setAside).toHaveLength(1)
  expect(result.report.setAside[0]?.reason).toContain(`"${name}"`)
  expect(result.posted).toEqual([before, after])
  expect(result.again).toEqual([])
  // Read: withheld, reported as a gap of its own kind; the records around it are handed.
  expect(result.contractGaps).toHaveLength(1)
  const gap = result.contractGaps[0]
  expect(gap?.detail).toContain(`"${name}"`)
  expect(gap?.place).toContain('run-1')
  expect(gap?.writerId).toBe('writer')
  expect(result.update.records.map((record) => record.name)).toEqual(['team.before', 'team.after'])
}

test('a record the SDK writes passes at send and at read', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-recheck-sdk-'))
  try {
    const errors: unknown[] = []
    const handle = connect({
      runId: 'run-1',
      repository: 'acme/widgets',
      repoRoot: join(runtimeDir, 'repo'),
      runtimeDir,
      destination: { url: 'https://collector.example' },
      onError: (error) => errors.push(error)
    })
    handle.run.started()
    handle.run.alive()
    handle.run.ended()
    expect(errors).toEqual([])
    const folder = join(runtimeDir, 'logs')
    const posted: string[] = []
    const report = await sendLocalCopy({
      folder,
      repository: 'acme/widgets',
      url: 'https://collector.example',
      fetch: async (_url, init) => {
        posted.push(String(init.body))
        return new Response(null, { status: 204 })
      }
    })
    const lines = readdirSync(join(folder, 'acme-widgets'))
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) =>
        readFileSync(join(folder, 'acme-widgets', file), 'utf8')
          .trimEnd()
          .split('\n')
      )
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(report.setAside).toEqual([])
    expect(posted.sort()).toEqual([...lines].sort())
    const update = await createReader(
      createFolderSource({ folder: join(folder, 'acme-widgets'), runId: 'run-1' })
    ).readAll()
    expect(update.gaps.filter((gap) => gap.kind === 'contract')).toEqual([])
    expect(update.records.length).toBeGreaterThanOrEqual(3)
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('every earlier fixture event, converted, passes at send and at read', async () => {
  const events = (await Bun.file(new URL('./fixtures/earlier-events.jsonl', import.meta.url)).text())
    .trim()
    .split('\n')
    .map((line) => LogEventSchema.parse(JSON.parse(line)))
  const { traces, logs } = convertEarlierEvents(events)
  const spanLines = traces.resourceSpans.map((group) => JSON.stringify({ resourceSpans: [group] }))
  const logLines = logs.resourceLogs.map((group) => JSON.stringify({ resourceLogs: [group] }))
  expect(spanLines.length + logLines.length).toBeGreaterThan(0)
  const checked = await Promise.all([
    spanLines.length > 0 ? expectFits(spanLines, 'traces') : undefined,
    logLines.length > 0 ? expectFits(logLines, 'logs') : undefined
  ])
  expect(checked.length).toBe(2)
})

test('a team standard OpenTelemetry attributes and declared custom event pass unchanged', async () => {
  const lines = [
    eventLine('team.deploy_finished', [str('gen_ai.request.model', 'a-model'), str('http.request.method', 'GET')]),
    eventLine('gen_ai.client.inference.operation.details', [str('http.request.method', 'POST')]),
    eventLine(
      'team.custom_event',
      [str('team_field', 'value')],
      [str('service.name', 'x'), str('deployment.environment', 'ci')]
    )
  ]
  const result = await expectFits(lines)
  const kept = result.update.records.find((record) => record.name === 'team.deploy_finished')
  expect(kept?.attributes['gen_ai.request.model']).toBe('a-model')
  expect(kept?.attributes['http.request.method']).toBe('GET')
  await expectFits([spanLine('team.checkout', [str('http.request.method', 'GET')])], 'traces')
})

test('an unknown vinaya.* attribute fails at send and at read', async () => {
  await expectFails(eventLine('team.fine', [str('vinaya.made_up', 'x')]), 'vinaya.made_up')
  await expectFails(spanLine('team.span', [str('vinaya.made_up', 'x')]), 'vinaya.made_up', 'traces')
  await expectFails(
    eventLine('team.fine', [], [str('service.name', 'x'), str('vinaya.made_up_resource', 'x')]),
    'vinaya.made_up_resource'
  )
})

test('an unknown vinaya.* event name fails at send and at read', async () => {
  await expectFails(eventLine('vinaya.made_up_event'), 'vinaya.made_up_event')
})

test('an unknown vinaya.* span name fails at send and at read', async () => {
  await expectFails(spanLine('vinaya.made_up_span'), 'vinaya.made_up_span', 'traces')
})

test('the check keeps the catalogue, filled-in span names and the earlier namespace', () => {
  const record = (over: Partial<OtelRecord>) => ({
    kind: 'event' as const,
    name: 'team.x',
    attributes: {},
    resource: {},
    ...over
  })
  expect(checkRecordContract(record({ kind: 'span', name: 'vinaya.round 3' }))).toBeNull()
  expect(
    checkRecordContract(record({ name: 'vinaya.earlier.something', attributes: { 'vinaya.earlier.field': 1 } }))
  ).toBeNull()
  expect(checkRecordContract(record({ kind: 'span', name: 'vinaya.round3' }))?.name).toBe('vinaya.round3')
})

test('a withheld record from a sequenced writer leaves no hole: the records around it are handed at once', async () => {
  const folder = join(root, `case-${counter++}`)
  mkdirSync(folder, { recursive: true })
  const sequenced = (seq: number, name: string, extra: ReturnType<typeof str>[] = []) =>
    JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                {
                  eventName: name,
                  ...ids,
                  timeUnixNano: String(5_000 + seq),
                  attributes: [
                    str('vinaya.writer.id', 'seq-writer'),
                    { key: 'vinaya.seq', value: { intValue: String(seq) } },
                    str('vinaya.event.id', `seq-writer:${seq}`),
                    ...extra
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
  writeFileSync(
    join(folder, 'run-1~seq-writer~000000000000.logs.jsonl'),
    [sequenced(0, 'team.a'), sequenced(1, 'team.b', [str('vinaya.made_up', 'x')]), sequenced(2, 'team.c')]
      .map((line) => `${line}\n`)
      .join('')
  )
  const update = await createReader(createFolderSource({ folder, runId: 'run-1' })).pull()
  expect(update.records.map((record) => record.name)).toEqual(['team.a', 'team.c'])
  expect(update.gaps.map((gap) => gap.kind)).toEqual(['contract'])
})

test('a large line that fails is set aside by name, and a large line that fits is posted', async () => {
  const filler = 'x'.repeat(80 * 1024)
  const big = (name: string) => eventLine(name, [str('team.filler', filler)])
  const fits = big('team.big')
  const fails = big('vinaya.made_up_big')
  const result = await run([fits, fails])
  expect(result.report.setAside).toHaveLength(1)
  expect(result.report.setAside[0]?.reason).toContain('"vinaya.made_up_big"')
  expect(result.posted).toEqual([fits])
})
