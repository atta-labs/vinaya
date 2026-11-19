import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalCopyWriter } from './local-copy-writer.js'
import { createLogSink, type LogSinkOverrides } from './log-sink.js'
import { registerRole, restoreRoleRegistry, type RoleRegistrySnapshot, saveRoleRegistry } from './roles.js'
import { type LogEvent, LogEventSchema } from './schema.js'

let saved: RoleRegistrySnapshot
beforeAll(() => {
  saved = saveRoleRegistry()
  registerRole('developer', { reading: 'developer', title: 'Developer', reviews: false })
})
afterAll(() => restoreRoleRegistry(saved))

const fixtures = readFileSync(
  new URL('../../../packages/log-sdk/tests/fixtures/earlier-events.jsonl', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => LogEventSchema.parse(JSON.parse(line)))
const paused = fixtures.find((e) => e.kind === 'dev_review_loop' && e.event === 'paused') as LogEvent
const resumed = fixtures.find((e) => e.kind === 'dev_review_loop' && e.event === 'resumed') as LogEvent
const other =
  fixtures.find((e) => e.kind === 'dev_review_loop' && e.event === 'loop_started') ?? (fixtures[0] as LogEvent)
const RUN = 'run-historical'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'vinaya-local-copy-'))
const none = { kind: 'none' as const, reason: 'no address' }
const writerIn = (warn: (m: string) => void = () => {}) =>
  createLocalCopyWriter({ warn, home: () => '', address: () => none })

/** The records of one run's local copy, by signal, in file order. */
function copyOf(folder: string, signal: 'traces' | 'logs'): Array<Record<string, any>> {
  const directory = join(folder, 'atta-labs-vinaya')
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${RUN}~`) && name.endsWith(`.${signal}.jsonl`))
    .sort()
    .flatMap((name) =>
      readFileSync(join(directory, name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    )
}
const logRecords = (folder: string) =>
  copyOf(folder, 'logs').flatMap((r) =>
    r.resourceLogs.flatMap((g: any) => g.scopeLogs.flatMap((s: any) => s.logRecords))
  )
const spans = (folder: string) =>
  copyOf(folder, 'traces').flatMap((r) =>
    r.resourceSpans.flatMap((g: any) => g.scopeSpans.flatMap((s: any) => s.spans))
  )

describe('the local copy writer', () => {
  test('two processes writing one run leave every record once, none lost or duplicated', () => {
    const folder = tmp()
    const a = writerIn()
    const b = writerIn()
    const events = fixtures.filter((e) => e.kind === 'dev_review_loop' || e.kind === 'dispatch')
    for (const [i, event] of events.entries()) (i % 2 === 0 ? a : b).recordSync(event, folder)
    const ids = logRecords(folder).map(
      (r) => r.attributes.find((x: any) => x.key === 'vinaya.event.id')?.value.stringValue
    )
    expect(new Set(ids).size).toBe(ids.length)
    const written = readdirSync(join(folder, 'atta-labs-vinaya')).filter((n) => n.startsWith(`${RUN}~`))
    expect(new Set(written.map((n) => n.split('~')[1])).size).toBe(2)
    expect(logRecords(folder).length + spans(folder).length).toBeGreaterThanOrEqual(events.length - 1)
  })

  test('a round started by one process and ended by a second becomes one span with the first start time', () => {
    const folder = tmp()
    const first = writerIn()
    const second = writerIn()
    // The second process has seen the run before the start is written.
    second.recordSync(other, folder)
    first.recordSync(paused, folder)
    const start = logRecords(folder).find((r) => r.eventName === 'vinaya.pause.started')
    expect(start).toBeDefined()
    second.recordSync(resumed, folder)
    const pause = spans(folder).find((s) => s.name === 'vinaya.pause')
    expect(pause).toBeDefined()
    expect(pause.startTimeUnixNano).toBe(start.timeUnixNano)
  })

  test('a start written before the second process first saw the run is found too', () => {
    const folder = tmp()
    writerIn().recordSync(paused, folder)
    const start = logRecords(folder).find((r) => r.eventName === 'vinaya.pause.started')
    writerIn().recordSync(resumed, folder)
    expect(spans(folder).find((s) => s.name === 'vinaya.pause').startTimeUnixNano).toBe(start.timeUnixNano)
  })

  test('a failure is reported once and never thrown', () => {
    const folder = join(tmp(), 'not-a-folder')
    writeFileSync(folder, 'a file where the folder should be')
    const reports: string[] = []
    const writer = writerIn((m) => reports.push(m))
    writer.recordSync(paused, folder)
    writer.recordSync(resumed, folder)
    expect(reports).toHaveLength(1)
  })
})

describe('the sink writes both formats', () => {
  const deps = (dir: string, destination: any, extra: Partial<LogSinkOverrides> = {}): LogSinkOverrides => ({
    outboxRoot: () => join(dir, 'outbox'),
    resolveLogDestination: () => destination,
    unresolvedLogDestination: () => destination,
    readConfig: () => null,
    home: () => dir,
    hostname: () => 'test-host',
    cwd: () => dir,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: '404' }),
    resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
    resolveBranchIssue: () => Promise.resolve(null),
    vinayaVersion: () => '0.0.0',
    stderr: () => {},
    runId: 'run-sink',
    otlp: { address: () => none },
    ...extra
  })
  const event = {
    kind: 'dispatch' as const,
    event: 'dispatched' as const,
    payload: {},
    target_role: 'developer' as const,
    model: 'sonnet',
    effect_id: 'e1',
    prompt_hash: 'sha256:abc'
  }
  const copyDirectory = (dir: string) => join(dir, '.vinaya', 'runtime', 'atta-labs-vinaya', 'logs', 'atta-labs-vinaya')
  const copyFiles = (dir: string) => {
    try {
      return readdirSync(copyDirectory(dir)).filter((n) => n.startsWith('run-sink~'))
    } catch {
      return []
    }
  }

  test("a folder destination keeps today's line and adds the same event as records in the local copy", async () => {
    const dir = tmp()
    const sink = createLogSink(deps(dir, { kind: 'folder', folder: join(dir, 'out') }))
    sink.log(event)
    await sink.drain()
    const line = readFileSync(join(dir, 'out', 'atta-labs-vinaya', '404.ndjson'), 'utf8')
    const today = JSON.parse(line.trim())
    expect(today.meta.run_id).toBe('run-sink')
    expect(readdirSync(join(dir, 'out', 'atta-labs-vinaya'))).toEqual(['404.ndjson'])
    const files = copyFiles(dir)
    expect(files.length).toBeGreaterThan(0)
    const records = files.flatMap((name) =>
      readFileSync(join(copyDirectory(dir), name), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    )
    const text = JSON.stringify(records)
    expect(text).toContain(today.meta.event_id ?? today.meta.run_id)
    expect(text).toContain('"vinaya.provenance"')
  })

  test("a server destination keeps today's line in the retry queue and writes the local copy", async () => {
    const dir = tmp()
    const sink = createLogSink(deps(dir, { kind: 'server', url: 'http://127.0.0.1:9/ingest' }))
    sink.log(event)
    await sink.drain()
    expect(
      readFileSync(join(dir, 'outbox', 'atta-labs-vinaya', '404.ndjson'), 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(1)
    expect(copyFiles(dir).length).toBeGreaterThan(0)
  })

  test('recording off writes neither', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'out'), { recursive: true })
    const sink = createLogSink(deps(dir, { kind: 'none', reason: 'off' }))
    sink.log(event)
    sink.logSync(event)
    await sink.drain()
    expect(readdirSync(join(dir, 'out'))).toEqual([])
    expect(copyFiles(dir)).toEqual([])
  })

  test("a local copy that cannot be written is reported once and today's line still lands", async () => {
    const dir = tmp()
    // A file where the local copy's folder must be.
    mkdirSync(join(dir, '.vinaya', 'runtime', 'atta-labs-vinaya'), { recursive: true })
    writeFileSync(join(dir, '.vinaya', 'runtime', 'atta-labs-vinaya', 'logs'), 'blocked')
    const reports: string[] = []
    const sink = createLogSink(
      deps(dir, { kind: 'folder', folder: join(dir, 'out') }, { stderr: (m) => reports.push(m) })
    )
    sink.log(event)
    sink.log(event)
    await sink.drain()
    expect(reports).toHaveLength(1)
    expect(
      readFileSync(join(dir, 'out', 'atta-labs-vinaya', '404.ndjson'), 'utf8')
        .trim()
        .split('\n')
    ).toHaveLength(2)
  })
})
