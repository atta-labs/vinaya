import { expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../src/index.js'

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
    handle.startRun()
    expect(read()).toEqual([[1, 'vinaya.run.started']])
    handle.alive()
    expect(read()).toHaveLength(2)
    handle.endRun()
    expect(read()).toHaveLength(3)
    handle.stageChanged({ to: 'done' })
    expect(read()).toEqual([
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
    handle.startRun()
    handle.alive()
    handle.endRun()
    expect(existsSync(join(runtimeDir, 'logs'))).toBe(false)
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true })
  }
})
