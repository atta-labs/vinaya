/**
 * The bodies the sender posts for one recorded run, captured and compared with the Log server's committed fixture
 * (`apps/log-server/src/fixtures/sdk-export.json`), which the server's own tests post to its OpenTelemetry routes.
 *
 * The run is written through `connect()` into a local copy and sent with `sendLocalCopy` and a capturing `fetch`, so
 * the fixture holds exactly what a harness process delivers, never a hand-written body. A fresh capture must match the
 * fixture in everything but ids and times — trace, span and writer ids, and every time field — so a change to what the
 * sender posts fails here until the fixture is captured again: `VINAYA_CAPTURE_SDK_EXPORT=1 bun test` on this file
 * rewrites it.
 */
import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect } from '../src/index.js'
import { sendLocalCopy } from '../src/sender/send.js'

const FIXTURE = resolve(import.meta.dir, '../../../apps/log-server/src/fixtures/sdk-export.json')

/** The run the fixture records, and the repository and address it is delivered to. */
const RUN_ID = 'sdk-export-fixture-run'
const REPOSITORY = 'acme/widgets'
const ADDRESS = 'https://log.example/v1/repos/acme/widgets/otlp'

export type CapturedExport = { path: string; contentType: string | null; body: unknown }
type Fixture = { runId: string; repository: string; address: string; exports: CapturedExport[] }

/** Write one run through `connect()` and capture every request `sendLocalCopy` makes for it. */
async function capture(): Promise<Fixture> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-capture-'))
  const folder = join(runtimeDir, 'logs')
  // The handle must never reach the network itself: only the sender's capturing fetch below posts anything.
  const network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      () => {
        throw new Error('unexpected network call')
      },
      { preconnect: globalThis.fetch.preconnect }
    )
  )
  try {
    const errors: unknown[] = []
    const handle = connect({
      runId: RUN_ID,
      repository: REPOSITORY,
      repoRoot: join(runtimeDir, 'repo'),
      runtimeDir,
      destination: { folder },
      processName: 'sdk-export-fixture',
      serviceVersion: '1.0.0',
      home: '/home/fixture',
      workRef: '42',
      onError: (error) => errors.push(error)
    })
    handle.run.started()
    handle.run.stageChanged({ to: 'working', round: 1 })
    handle.round.started({ number: 1 })
    handle.agent.sent({ seat: 'developer', provider: 'anthropic', model: 'fixture-model' })
    handle.usage.recorded({ inputTokens: 1200, outputTokens: 300 })
    handle.agent.returned()
    handle.round.ended()
    handle.run.ended()
    await handle.shutdown()
    expect(errors).toEqual([])

    const exports: CapturedExport[] = []
    const report = await sendLocalCopy({
      folder,
      repository: REPOSITORY,
      url: ADDRESS,
      headers: { authorization: 'Bearer fixture' },
      home: '/home/fixture',
      fetch: async (url, init) => {
        exports.push({
          path: new URL(url).pathname,
          contentType: new Headers(init.headers).get('content-type'),
          body: JSON.parse(String(init.body))
        })
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
    })
    expect(report.failures).toEqual([])
    expect(report.setAside).toEqual([])
    expect(report.sent).toBe(exports.length)
    exports.sort((a, b) => orderKey(a).localeCompare(orderKey(b)))
    return { runId: RUN_ID, repository: REPOSITORY, address: ADDRESS, exports }
  } finally {
    network.mockRestore()
    rmSync(runtimeDir, { recursive: true, force: true })
  }
}

/** A record's `vinaya.seq`, the writer's own order, which the sender's file walk does not keep. */
function seqOf(body: unknown): number {
  const text = JSON.stringify(body)
  const match = /"key":"vinaya\.seq","value":\{"intValue":"?(\d+)"?\}/.exec(text)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function orderKey(entry: CapturedExport): string {
  return `${String(seqOf(entry.body)).padStart(12, '0')} ${entry.path}`
}

/**
 * Keys whose values are ids or times: a fresh capture may differ from the fixture in these and in nothing else. The
 * host's own id, operating system and CI flag, and the SDK's released version, identify where and with what the
 * capture ran rather than what the sender posts, so they count as ids too: the same capture on a CI runner or after a
 * version bump has the same shape.
 */
const ID_KEYS = new Set(['traceId', 'spanId', 'parentSpanId'])
const TIME_KEY = /UnixNano$/
const ID_ATTRIBUTES = new Set([
  'vinaya.writer.id',
  'vinaya.event.id',
  'vinaya.span.parent_id',
  'host.id',
  'os.type',
  'vinaya.ci',
  'vinaya.sdk.version'
])

/** The shape of one capture: every value kept except ids and times, which become placeholders. */
function shapeOf(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => shapeOf(item))
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (typeof object.key === 'string' && ID_ATTRIBUTES.has(object.key)) return { key: object.key, value: '<id>' }
    if (key === 'scope') return { ...object, version: '<id>' }
    return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, shapeOf(v, k)]))
  }
  if (key !== undefined && ID_KEYS.has(key)) return typeof value === 'string' && value !== '' ? '<id>' : value
  if (key !== undefined && TIME_KEY.test(key)) return '<time>'
  return value
}

test('the sender posts each recorded record to the address’s /v1/traces or /v1/logs as OTLP JSON', async () => {
  const fresh = await capture()
  expect(fresh.exports.length).toBeGreaterThan(0)
  for (const entry of fresh.exports) {
    expect(['/v1/repos/acme/widgets/otlp/v1/traces', '/v1/repos/acme/widgets/otlp/v1/logs']).toContain(entry.path)
    expect(entry.contentType).toBe('application/json')
  }
  expect(fresh.exports.some((entry) => entry.path.endsWith('/v1/traces'))).toBe(true)
  expect(fresh.exports.some((entry) => entry.path.endsWith('/v1/logs'))).toBe(true)
})

test('a fresh capture of the sender’s bodies matches the committed fixture in everything but ids and times', async () => {
  const fresh = await capture()
  if (process.env.VINAYA_CAPTURE_SDK_EXPORT === '1') {
    // The capturing machine's own host id is never committed: it is replaced with a fixed one.
    const text = JSON.stringify(fresh, null, 2).replace(
      /("key": "host\.id",\s*"value": \{\s*"stringValue": )"[^"]*"/g,
      `$1"${'0'.repeat(32)}"`
    )
    writeFileSync(FIXTURE, `${text}\n`)
  }
  const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
  expect(shapeOf(fresh)).toEqual(shapeOf(committed))
})
