import { afterAll, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTRIBUTE_NAMES as A, createFolderSource, createReader, type OtelRecord } from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'log-sdk-folder-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let counter = 0

function folder(): string {
  const path = join(root, `case-${counter++}`)
  mkdirSync(path)
  return path
}

function line(writer: string, seq: number, time: number): string {
  return `${JSON.stringify({
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
                timeUnixNano: String(time),
                attributes: [
                  { key: A.seq, value: { intValue: String(seq) } },
                  { key: A.writerId, value: { stringValue: writer } },
                  { key: A.eventId, value: { stringValue: `${writer}:${seq}` } }
                ]
              }
            ]
          }
        ]
      }
    ]
  })}\n`
}

const name = (writer: string, index: number, signal = 'logs', run = 'run-1') =>
  `${run}~${writer}~${String(index).padStart(12, '0')}.${signal}.jsonl`

const labels = (records: OtelRecord[]) => records.map(({ writerId, seq }) => `${writerId}${seq}`)

function snapshot(path: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(path).map((file) => [
      `${file}:${statSync(join(path, file)).size}`,
      readFileSync(join(path, file), 'utf8')
    ])
  )
}

test("a run's local copy is read whole, in each writer's order, across every file of each writer", async () => {
  const path = folder()
  writeFileSync(join(path, name('a', 0)), line('a', 0, 10) + line('a', 1, 30))
  writeFileSync(join(path, name('a', 1, 'traces')), line('a', 2, 40))
  writeFileSync(join(path, name('a', 2)), line('a', 3, 50))
  writeFileSync(join(path, name('b', 0)), line('b', 0, 20) + line('b', 1, 35))
  writeFileSync(join(path, name('c', 0, 'logs', 'other-run')), line('c', 0, 1))
  writeFileSync(join(path, 'notes.txt'), 'not a log file')
  const before = snapshot(path)
  const update = await createReader(createFolderSource({ folder: path, runId: 'run-1' })).readAll()
  expect(update.gaps).toEqual([])
  expect(labels(update.records)).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'a3'])
  expect(snapshot(path)).toEqual(before)
})

test('a follow hands each new record once while writers append, continue in further files and leave a half-written line', async () => {
  const path = folder()
  const reader = createReader(createFolderSource({ folder: path, runId: 'run-1' }))
  expect((await reader.pull()).records).toEqual([])

  writeFileSync(join(path, name('a', 0)), line('a', 0, 1))
  expect(labels((await reader.pull()).records)).toEqual(['a0'])
  expect((await reader.pull()).records).toEqual([])

  // The writer is part-way through a line.
  const whole = line('a', 1, 2)
  appendFileSync(join(path, name('a', 0)), whole.slice(0, 40))
  expect((await reader.pull()).records).toEqual([])
  appendFileSync(join(path, name('a', 0)), whole.slice(40))
  const finished = await reader.pull()
  expect(labels(finished.records)).toEqual(['a1'])
  expect(finished.gaps).toEqual([])

  // The writer continues in a further file; a second writer starts.
  writeFileSync(join(path, name('a', 1, 'traces')), line('a', 2, 3))
  writeFileSync(join(path, name('b', 0)), line('b', 0, 4))
  expect(labels((await reader.pull()).records).sort()).toEqual(['a2', 'b0'])
  appendFileSync(join(path, name('b', 0)), line('b', 1, 5))
  appendFileSync(join(path, name('a', 1, 'traces')), line('a', 3, 6))
  expect(labels((await reader.pull()).records).sort()).toEqual(['a3', 'b1'])
  expect((await reader.pull()).records).toEqual([])
})

test("a follow resumes from the caller's position after a restart with no record skipped or repeated", async () => {
  const path = folder()
  writeFileSync(join(path, name('a', 0)), line('a', 0, 1) + line('a', 1, 2))
  writeFileSync(join(path, name('b', 0)), line('b', 0, 3))
  const first = createReader(createFolderSource({ folder: path, runId: 'run-1' }))
  expect(labels((await first.pull()).records)).toEqual(['a0', 'a1', 'b0'])
  const kept = first.position()
  expect(kept).toBeDefined()

  appendFileSync(join(path, name('a', 0)), line('a', 2, 4))
  writeFileSync(join(path, name('a', 1)), line('a', 3, 5))
  appendFileSync(join(path, name('b', 0)), line('b', 1, 6))
  const second = createReader(createFolderSource({ folder: path, runId: 'run-1' }), { position: kept as string })
  const resumed = await second.pull()
  expect(resumed.gaps).toEqual([])
  expect(labels(resumed.records).sort()).toEqual(['a2', 'a3', 'b1'])
  expect((await second.pull()).records).toEqual([])
})

test('a half-written last line the writer left behind is reported once when it continued in a later file', async () => {
  const path = folder()
  writeFileSync(join(path, name('a', 0)), line('a', 0, 1) + line('a', 1, 2).slice(0, 30))
  const reader = createReader(createFolderSource({ folder: path, runId: 'run-1' }), { patience: 1 })
  expect(labels((await reader.pull()).records)).toEqual(['a0'])
  writeFileSync(join(path, name('a', 1)), line('a', 2, 3))
  const next = await reader.pull()
  // The lost line's number is a sequence gap as well.
  expect(next.gaps.filter(({ kind }) => kind === 'sequence').map(({ place }) => place)).toEqual(['writer a sequence 1'])
  expect(labels(next.records)).toEqual(['a2'])
  expect(next.gaps.filter(({ kind }) => kind === 'unreadable_line').map(({ place }) => place)).toEqual([
    `${name('a', 0)}@${line('a', 0, 1).length}`
  ])
  const flushed = await reader.pull()
  expect(flushed.gaps.filter(({ kind }) => kind === 'unreadable_line')).toEqual([])
})

test('a writer that continues in a further file between the listing and the opening loses nothing and repeats nothing', async () => {
  const path = folder()
  writeFileSync(join(path, name('a', 0)), line('a', 0, 1) + line('a', 1, 2).slice(0, 25))
  let moved = false
  const reader = createReader(
    createFolderSource({
      folder: path,
      runId: 'run-1',
      afterListing: () => {
        if (moved) return
        moved = true
        // The writer abandons its half line and goes on in the next file, after the folder was listed.
        writeFileSync(join(path, name('a', 1)), line('a', 2, 3))
      }
    }),
    { patience: 1 }
  )
  const first = await reader.pull()
  expect(labels(first.records)).toEqual(['a0'])
  const second = await reader.pull()
  expect(labels(second.records)).toEqual(['a2'])
  expect(second.gaps.map(({ kind }) => kind).sort()).toEqual(['sequence', 'unreadable_line'])
  expect((await reader.pull()).records).toEqual([])

  // A complete line appended after the listing is read in the same pass or the next, once.
  const again = folder()
  writeFileSync(join(again, name('a', 0)), line('a', 0, 1))
  let appended = false
  const follower = createReader(
    createFolderSource({
      folder: again,
      runId: 'run-1',
      afterListing: () => {
        if (appended) return
        appended = true
        appendFileSync(join(again, name('a', 0)), line('a', 1, 2))
        writeFileSync(join(again, name('a', 1)), line('a', 2, 3))
      }
    })
  )
  const seen = [...labels((await follower.pull()).records), ...labels((await follower.pull()).records)]
  expect(seen).toEqual(['a0', 'a1', 'a2'])
})

test('an unreadable line and a file gone from the folder are reported with their place', async () => {
  const path = folder()
  writeFileSync(join(path, name('a', 0)), `${line('a', 0, 1)}this is not json\n`)
  writeFileSync(join(path, name('a', 3)), line('a', 1, 2))
  mkdirSync(join(path, name('a', 4)))
  const update = await createReader(createFolderSource({ folder: path, runId: 'run-1' })).readAll()
  expect(labels(update.records)).toEqual(['a0', 'a1'])
  expect(update.gaps.map(({ kind, place }) => [kind, place])).toEqual([
    ['unreadable_line', `${name('a', 0)}@${line('a', 0, 1).length}`],
    ['file_missing', 'writer a files 1–2'],
    ['file_missing', name('a', 4)]
  ])
})

test('a folder that does not exist yet reads as empty, and a position it cannot read starts from the beginning', async () => {
  const path = join(root, 'not-there')
  const reader = createReader(createFolderSource({ folder: path, runId: 'run-1' }), { position: '{"w":' })
  expect((await reader.pull()).records).toEqual([])
  mkdirSync(path)
  writeFileSync(join(path, name('a', 0)), line('a', 0, 1))
  expect(labels((await reader.pull()).records)).toEqual(['a0'])
})

test('following yields each update that holds a record until it is stopped', async () => {
  const path = folder()
  writeFileSync(join(path, name('a', 0)), line('a', 0, 1))
  const controller = new AbortController()
  const reader = createReader(createFolderSource({ folder: path, runId: 'run-1' }))
  const seen: string[] = []
  for await (const update of reader.follow({ intervalMs: 5, signal: controller.signal })) {
    seen.push(...labels(update.records))
    if (seen.length === 1) appendFileSync(join(path, name('a', 0)), line('a', 1, 2))
    if (seen.length === 2) controller.abort()
  }
  expect(seen).toEqual(['a0', 'a1'])
})

test("a file listed but unreadable keeps the offset already read in the writer's current file", async () => {
  const path = folder()
  const file = join(path, name('a', 0))
  writeFileSync(file, line('a', 0, 1))
  const source = createFolderSource({ folder: path, runId: 'run-1' })
  const first = await source.read()
  rmSync(file)
  mkdirSync(file)
  const second = await source.read(first.position)
  expect(second.records).toEqual([])
  expect(second.position).toBe(first.position)
})

test("a follow polled between a span in one of a writer's files and an event in the other hands both, each once, with no gap", async () => {
  const path = folder()
  const reader = createReader(createFolderSource({ folder: path, runId: 'run-1' }))
  writeFileSync(join(path, name('a', 0)), line('a', 1, 1))
  expect(labels((await reader.pull()).records)).toEqual(['a1'])
  writeFileSync(join(path, name('a', 1, 'traces')), line('a', 2, 2))
  expect(labels((await reader.pull()).records)).toEqual(['a2'])
  // The writer goes back to its events file, which is still growing below the later spans file.
  appendFileSync(join(path, name('a', 0)), line('a', 3, 3))
  const event = await reader.pull()
  expect(labels(event.records)).toEqual(['a3'])
  expect(event.gaps).toEqual([])
  // A span half-written while the events file grows is waited for, then handed whole.
  const span = line('a', 4, 4)
  appendFileSync(join(path, name('a', 1, 'traces')), span.slice(0, 40))
  appendFileSync(join(path, name('a', 0)), line('a', 5, 5))
  const between = await reader.pull()
  expect(between.gaps.filter(({ kind }) => kind === 'unreadable_line')).toEqual([])
  appendFileSync(join(path, name('a', 1, 'traces')), span.slice(40))
  const finished = await reader.pull()
  expect(finished.gaps).toEqual([])
  expect([...labels(between.records), ...labels(finished.records)]).toEqual(['a4', 'a5'])
  expect((await reader.pull()).records).toEqual([])
  expect((await reader.readAll()).gaps).toEqual([])
})

test('a position the earlier source saved, resumed on a folder in the earlier layout, skips and repeats no record', async () => {
  const path = folder()
  // The earlier writer moved to the next index on every signal change, so only its last file grew.
  writeFileSync(join(path, name('a', 0)), line('a', 1, 1) + line('a', 2, 2))
  writeFileSync(join(path, name('a', 1, 'traces')), line('a', 3, 3))
  writeFileSync(join(path, name('a', 2)), line('a', 4, 4))
  writeFileSync(join(path, name('b', 0, 'traces')), line('b', 1, 5))
  // The earlier source's position after reading a4 and b1: one place per writer.
  const earlier = JSON.stringify({ v: 1, w: { a: [2, line('a', 4, 4).length], b: [0, line('b', 1, 5).length] } })
  appendFileSync(join(path, name('a', 2)), line('a', 5, 6))
  writeFileSync(join(path, name('a', 3, 'traces')), line('a', 6, 7))
  writeFileSync(join(path, name('b', 1)), line('b', 2, 8))
  const reader = createReader(createFolderSource({ folder: path, runId: 'run-1' }), { position: earlier, patience: 1 })
  const resumed = await reader.pull()
  expect(resumed.gaps).toEqual([])
  expect(labels(resumed.records).sort()).toEqual(['a5', 'a6', 'b2'])
  expect((await reader.pull()).records).toEqual([])
  appendFileSync(join(path, name('a', 3, 'traces')), line('a', 7, 9))
  expect(labels((await reader.pull()).records)).toEqual(['a7'])
  expect((await reader.readAll()).gaps).toEqual([])
})

test("a half-written last line in a writer's span file is not abandoned while the only later file is its event file", async () => {
  const path = folder()
  writeFileSync(join(path, name('a', 0, 'traces')), line('a', 1, 1) + line('a', 2, 2).slice(0, 30))
  writeFileSync(join(path, name('a', 1)), line('a', 3, 3))
  // Patient enough that the records behind the half line stay held until the end.
  const reader = createReader(createFolderSource({ folder: path, runId: 'run-1' }), { patience: 10 })
  const first = await reader.pull()
  expect(first.gaps.filter(({ kind }) => kind === 'unreadable_line')).toEqual([])
  expect(labels(first.records)).toEqual(['a1'])
  appendFileSync(join(path, name('a', 1)), line('a', 4, 4))
  expect((await reader.pull()).gaps.filter(({ kind }) => kind === 'unreadable_line')).toEqual([])
  // The writer goes on in a later span file: the half line is abandoned, reported once.
  writeFileSync(join(path, name('a', 2, 'traces')), line('a', 5, 5))
  const abandoned = await reader.pull()
  expect(abandoned.gaps.filter(({ kind }) => kind === 'unreadable_line').map(({ place }) => place)).toEqual([
    `${name('a', 0, 'traces')}@${line('a', 1, 1).length}`
  ])
  expect((await reader.pull()).gaps.filter(({ kind }) => kind === 'unreadable_line')).toEqual([])
  const flushed = await reader.readAll()
  expect(flushed.gaps.map(({ place }) => place)).toEqual(['writer a sequence 2'])
  expect(labels(flushed.records)).toEqual(['a3', 'a4', 'a5'])
})
