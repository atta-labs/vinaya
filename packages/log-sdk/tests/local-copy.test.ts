import { expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'
import { resetCleanedFolders } from '../src/local-copy/file-exporters.js'
import { deliveryStateOf, FINISHED_FILES, sendLocalCopy } from '../src/sender/send.js'

type Attribute = { key: string; value: { stringValue?: string; intValue?: number | string } }
type RecordData = {
  name?: string
  eventName?: string
  kind?: number
  traceId: string
  spanId: string
  timeUnixNano?: string
  startTimeUnixNano?: string
  attributes: Attribute[]
}
type Document = {
  resourceLogs?: { resource: { attributes: Attribute[] }; scopeLogs: { logRecords: RecordData[] }[] }[]
  resourceSpans?: { resource: { attributes: Attribute[] }; scopeSpans: { spans: RecordData[] }[] }[]
}

test('the local copy is synchronous OTLP JSON in record order', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-local-'))
  const folder = join(runtimeDir, 'logs', 'acme-widgets')
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      () => {
        throw new Error('unexpected network call')
      },
      { preconnect: globalThis.fetch.preconnect }
    )
  )
  const errors: unknown[] = []
  try {
    const handle = connect({
      runId: 'run-1',
      repository: 'acme/widgets',
      repoRoot: join(runtimeDir, 'repo'),
      runtimeDir,
      destination: { url: 'https://collector.example' },
      processName: 'local-test',
      serviceVersion: 'test-version',
      onError: (error) => errors.push(error)
    })
    const read = () =>
      readdirSync(folder)
        .sort()
        .flatMap((file) => {
          expect(file).toStartWith(`run-1~${handle.writerId}~`)
          const text = readFileSync(join(folder, file), 'utf8')
          expect(text).toEndWith('\n')
          return text
            .trimEnd()
            .split('\n')
            .map((line) => {
              const doc = JSON.parse(line) as Document
              expect(Object.keys(doc)).toEqual([file.endsWith('.logs.jsonl') ? 'resourceLogs' : 'resourceSpans'])
              const groups = doc.resourceLogs ?? doc.resourceSpans ?? []
              expect(groups).toHaveLength(1)
              const group = groups[0]!
              expect(group.resource.attributes).toContainEqual({
                key: 'service.name',
                value: { stringValue: 'local-test' }
              })
              expect(group.resource.attributes).toContainEqual({
                key: 'service.version',
                value: { stringValue: 'test-version' }
              })
              const records =
                'scopeLogs' in group
                  ? group.scopeLogs.flatMap((scope) => scope.logRecords)
                  : group.scopeSpans.flatMap((scope) => scope.spans)
              expect(records).toHaveLength(1)
              const record = records[0]!
              expect(record.traceId).toBe(handle.traceId)
              expect(record.spanId).toMatch(/^[a-f0-9]{16}$/)
              expect(record.attributes).toContainEqual({
                key: 'vinaya.writer.id',
                value: { stringValue: handle.writerId }
              })
              expect(record.timeUnixNano ?? record.startTimeUnixNano).toMatch(/^\d+$/)
              if (record.name) expect(Number.isInteger(record.kind)).toBe(true)
              return [
                Number(record.attributes.find(({ key }) => key === 'vinaya.seq')?.value.intValue),
                record.eventName ?? record.name
              ]
            })
        })
    handle.run.started()
    expect(read()).toEqual([[1, 'vinaya.run.started']])
    handle.run.alive()
    expect(read()).toHaveLength(2)
    handle.run.ended()
    expect(read()).toHaveLength(3)
    handle.run.stageChanged({ to: 'done' })
    // One file per signal: the event after the span joins the events file, so record order is the sequence number.
    expect(readdirSync(folder).sort()).toEqual([
      `run-1~${handle.writerId}~000000000000.logs.jsonl`,
      `run-1~${handle.writerId}~000000000001.traces.jsonl`
    ])
    expect(read().sort(([a], [b]) => Number(a) - Number(b))).toEqual([
      [1, 'vinaya.run.started'],
      [2, 'vinaya.run.alive'],
      [3, 'invoke_workflow'],
      [4, 'vinaya.run.stage_changed']
    ])
    expect(errors).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    fetch.mockRestore()
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('recording off creates no local copy', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-off-'))
  try {
    const handle = connect({ runId: 'off', repoRoot: join(runtimeDir, 'repo'), runtimeDir, destination: false })
    handle.run.started()
    handle.run.alive()
    handle.run.ended()
    expect(existsSync(join(runtimeDir, 'logs'))).toBe(false)
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('opening a handle deletes old local-copy files with their delivery state, once per process per folder', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-clean-'))
  const logs = join(runtimeDir, 'logs')
  const folder = join(logs, 'acme-widgets')
  const state = join(folder, '.otlp-delivery')
  const outside = join(runtimeDir, 'outside')
  try {
    mkdirSync(state, { recursive: true })
    mkdirSync(outside)
    const old = 'old~w1~000000000000.traces.jsonl'
    const recent = 'new~w1~000000000000.traces.jsonl'
    const line = '{"resourceSpans":[]}\n'
    writeFileSync(join(folder, old), line)
    writeFileSync(join(folder, recent), line)
    const { markers, lineKeys } = deliveryStateOf(old, Buffer.from(line))
    const receipts = [...markers, `${lineKeys[0]}.traces.pending`, `${lineKeys[0]}.abc.sent`]
    for (const name of receipts) writeFileSync(join(state, name), 'x')
    const keptMarker = deliveryStateOf(recent, Buffer.from(line)).markers[0] as string
    writeFileSync(join(state, keptMarker), 'x')
    const longAgo = new Date(Date.now() - 100 * 86_400_000)
    utimesSync(join(folder, old), longAgo, longAgo)
    // Outside the folder: a sibling file, and a symbolic link in the folder pointing out of it.
    const beside = join(logs, 'beside~w1~000000000000.traces.jsonl')
    const target = join(outside, 'target~w1~000000000000.traces.jsonl')
    const linkName = 'link~w1~000000000000.traces.jsonl'
    writeFileSync(beside, line)
    writeFileSync(target, line)
    utimesSync(beside, longAgo, longAgo)
    utimesSync(target, longAgo, longAgo)
    symlinkSync(target, join(folder, linkName))

    const errors: unknown[] = []
    const open = () =>
      connect({
        runId: 'run-9',
        repository: 'acme/widgets',
        repoRoot: join(runtimeDir, 'repo'),
        runtimeDir,
        onError: (e) => errors.push(e)
      })
    resetCleanedFolders()
    const handle = open()
    handle.run.started()
    expect(existsSync(join(folder, old))).toBe(false)
    for (const name of receipts) expect(existsSync(join(state, name))).toBe(false)
    expect(existsSync(join(folder, recent))).toBe(true)
    expect(existsSync(join(state, keptMarker))).toBe(true)
    expect(readdirSync(folder).some((f) => f.startsWith(`run-9~${handle.writerId}~`))).toBe(true)
    expect(existsSync(beside)).toBe(true)
    expect(existsSync(target)).toBe(true)
    expect(lstatSync(join(folder, linkName)).isSymbolicLink()).toBe(true)

    // A second handle in the same process does not clean again.
    const second = 'again~w1~000000000000.logs.jsonl'
    writeFileSync(join(folder, second), line)
    utimesSync(join(folder, second), longAgo, longAgo)
    open()
    expect(existsSync(join(folder, second))).toBe(true)
    expect(errors).toEqual([])
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('cleaning removes the delivery state a real send wrote for an old file', async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-sent-'))
  const logs = join(runtimeDir, 'logs')
  const folder = join(logs, 'acme-widgets')
  try {
    mkdirSync(folder, { recursive: true })
    const name = 'sent~w1~000000000000.logs.jsonl'
    writeFileSync(join(folder, name), '{"resourceLogs":[]}\n{"resourceLogs":[]}\n')
    const report = await sendLocalCopy({
      folder: logs,
      repository: 'acme/widgets',
      url: 'https://collector.example',
      fetch: async () => new Response(null, { status: 200 })
    })
    expect(report.sent).toBe(2)
    const state = join(folder, '.otlp-delivery')
    expect(readdirSync(state).length).toBeGreaterThan(0)
    const longAgo = new Date(Date.now() - 100 * 86_400_000)
    utimesSync(join(folder, name), longAgo, longAgo)
    resetCleanedFolders()
    connect({ runId: 'run-s', repository: 'acme/widgets', repoRoot: join(runtimeDir, 'repo'), runtimeDir })
    expect(existsSync(join(folder, name))).toBe(false)
    // Only the sender's summary of finished files stays; the next send drops the removed file from it.
    expect(readdirSync(state)).toEqual([FINISHED_FILES])
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})

test('a window passed to connect decides what is old', () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-window-'))
  const folder = join(runtimeDir, 'logs', 'acme-widgets')
  try {
    mkdirSync(folder, { recursive: true })
    const name = 'mid~w1~000000000000.logs.jsonl'
    writeFileSync(join(folder, name), '{}\n')
    const tenDays = new Date(Date.now() - 10 * 86_400_000)
    utimesSync(join(folder, name), tenDays, tenDays)
    resetCleanedFolders()
    connect({ runId: 'run-w', repository: 'acme/widgets', repoRoot: join(runtimeDir, 'repo'), runtimeDir, keepDays: 5 })
    expect(existsSync(join(folder, name))).toBe(false)
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})
