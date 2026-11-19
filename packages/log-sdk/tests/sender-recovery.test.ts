import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendLocalCopy, type SendLocalCopyOptions } from '../src/sender/send.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'otlp-recovery-'))
  roots.push(folder)
  const dir = join(folder, 'acme-repo')
  mkdirSync(dir)
  const options = { folder, repository: 'acme/repo', url: 'https://collector.example/base' }
  const observed = new Set<string>()
  const fetch: NonNullable<SendLocalCopyOptions['fetch']> = async (_url, init) => {
    observed.add(String(init.body))
    return new Response()
  }
  function segment(index: number, ...records: string[]) {
    const name = `run~writer~${String(index).padStart(12, '0')}.${index % 2 === 0 ? 'traces' : 'logs'}.jsonl`
    const path = join(dir, name)
    writeFileSync(path, `${records.join('\n')}\n`)
    return path
  }
  return { options, fetch, observed, segment }
}

const trace = '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"f00d","spanId":"beef"}]}]}]}'
const event =
  '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[{"key":"vinaya.event.id","value":{"stringValue":"event1"}}]}]}]}]}'

test.each(['before', 'during', 'after'])('recovers after a sender is killed %s a request', async (phase) => {
  const { options, fetch, segment, observed } = fixture()
  segment(0, trace, trace.replace('beef', 'cafe'))
  segment(1, event)
  const moduleUrl = new URL('../src/sender/send.ts', import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import { writeSync } from 'node:fs';
       import { sendLocalCopy } from ${JSON.stringify(moduleUrl)};
       const phase = ${JSON.stringify(phase)};
       if (phase === 'before') process.kill(process.pid, 'SIGKILL');
       let requests = 0;
       await sendLocalCopy({ ...${JSON.stringify(options)}, fetch: async (_url, init) => {
         if (phase === 'after' && requests++ > 0) process.kill(process.pid, 'SIGKILL');
         writeSync(1, init.body + '\\n');
         if (phase === 'during') process.kill(process.pid, 'SIGKILL');
         return new Response();
       }});`
    ],
    { stdout: 'pipe', stderr: 'inherit' }
  )
  const output = await new Response(child.stdout).text()
  await child.exited
  expect(child.signalCode).toBe('SIGKILL')
  for (const record of output.trim().split('\n').filter(Boolean)) observed.add(record)
  expect((await sendLocalCopy({ ...options, fetch })).failures).toEqual([])
  expect(observed).toEqual(new Set([trace, trace.replace('beef', 'cafe'), event]))
})

test('retries staged records after their source segment is removed', async () => {
  const { options, fetch, segment, observed } = fixture()
  const source = segment(0, trace)
  const first = await sendLocalCopy({ ...options, fetch: async () => new Response(null, { status: 503 }) })
  expect(first.failures.map(({ reason }) => reason)).toEqual(['HTTP 503'])
  unlinkSync(source)
  expect((await sendLocalCopy({ ...options, fetch })).sent).toBe(1)
  expect(observed).toEqual(new Set([trace]))
})

test('reports a missing writer segment and still sends the later segment', async () => {
  const { options, fetch, segment, observed } = fixture()
  const missing = segment(0, trace)
  segment(1, event)
  unlinkSync(missing)
  const result = await sendLocalCopy({ ...options, fetch })
  expect(result.sent).toBe(1)
  expect(result.failures).toEqual([
    expect.objectContaining({
      file: expect.stringContaining('run~writer~000000000000'),
      reason: 'lost segment from writer writer'
    })
  ])
  expect(observed).toEqual(new Set([event]))
  expect((await sendLocalCopy({ ...options, fetch })).failures).toEqual(result.failures)
})

test('overlapping sends leave continuing segments eligible after old files are deleted', async () => {
  const { options, fetch, segment, observed } = fixture()
  const old = segment(0, trace)
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const first = sendLocalCopy({
    ...options,
    fetch: async (url, init) => {
      entered.resolve()
      await resume.promise
      return fetch(url, init)
    }
  })
  await entered.promise
  const continuing = segment(1, event)
  const second = await sendLocalCopy({ ...options, fetch })
  expect(second.sent).toBe(2)
  unlinkSync(old)
  unlinkSync(continuing)
  const finalTrace = trace.replace('beef', 'cafe')
  segment(2, finalTrace)
  resume.resolve()
  expect((await first).failures).toEqual([])
  expect((await sendLocalCopy({ ...options, fetch })).sent).toBe(1)
  expect(observed).toEqual(new Set([trace, event, finalTrace]))
})
