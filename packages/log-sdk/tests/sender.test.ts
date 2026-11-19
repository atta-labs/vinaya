import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendLocalCopy, type SendLocalCopyOptions } from '../src/sender/send.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'otlp-send-'))
  roots.push(folder)
  const dir = join(folder, 'acme-repo')
  mkdirSync(dir)
  return { dir, folder, repository: 'acme/repo', url: 'https://collector.example/base' }
}

test('sends both signals from each writer and run without changing their files', async () => {
  const options = fixture()
  const expected: string[] = []
  const actual: string[] = []
  const files = new Map<string, string>()
  for (const run of ['run1', 'run2']) {
    for (const writer of ['writer1', 'writer2']) {
      for (const signal of ['traces', 'logs']) {
        const path = join(options.dir, `${run}~${writer}~000000000000.${signal}.jsonl`)
        const body = JSON.stringify({ [signal === 'traces' ? 'resourceSpans' : 'resourceLogs']: [], id: [run, writer] })
        files.set(path, `${body}\n`)
        expected.push(`/base/v1/${signal} ${body}`)
        writeFileSync(path, `${body}\n`)
      }
    }
  }
  const fetch: SendLocalCopyOptions['fetch'] = async (url, init) => {
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    actual.push(`${new URL(url).pathname} ${init.body}`)
    return new Response(null, { status: 204 })
  }
  const send = () => sendLocalCopy({ ...options, headers: { authorization: 'Bearer test' }, fetch })
  expect(await send()).toEqual({ sent: 8, setAside: [], failures: [] })
  expect(actual.sort()).toEqual(expected.sort())
  expect((await send()).sent).toBe(0)
  for (const [path, content] of files) expect(readFileSync(path, 'utf8')).toBe(content)
})

test('retries transient failures and isolates rejected and unfinished lines', async () => {
  const options = fixture()
  const file = join(options.dir, 'run~writer~000000000000.logs.jsonl')
  writeFileSync(file, '{"id":1}\n{"id":2}\ninvalid\n{"id":3')
  const posted: number[] = []
  let first = true
  const send = () =>
    sendLocalCopy({
      ...options,
      fetch: async (_url, init) => {
        const { id } = JSON.parse(String(init.body))
        posted.push(id)
        return new Response(null, { status: id === 1 && first ? 503 : id === 2 ? 400 : 200 })
      }
    })
  const initial = await send()
  expect(initial.sent).toBe(0)
  expect(initial.failures.map((failure) => failure.reason)).toEqual(['HTTP 503'])
  expect(initial.setAside.map((rejection) => rejection.reason)).toEqual(['HTTP 400', 'invalid JSON'])
  expect(posted).toEqual([1, 2])
  appendFileSync(file, '}\n')
  first = false
  expect(await send()).toEqual({ sent: 2, setAside: [], failures: [] })
  expect(posted).toEqual([1, 2, 1, 3])
})

test('a writer can append while a request stalls and the deadline leaves both lines pending', async () => {
  const options = fixture()
  const file = join(options.dir, 'run~writer~000000000000.traces.jsonl')
  writeFileSync(file, '{"resourceSpans":[]}\n')
  const report = await sendLocalCopy({
    ...options,
    deadline: Date.now() + 100,
    fetch: async () => {
      appendFileSync(file, '{"resourceSpans":[]}\n')
      return new Promise<Response>(() => {})
    }
  })
  expect(report.sent).toBe(0)
  expect(report.failures.some(({ reason }) => reason === 'deadline reached')).toBe(true)
  expect((await sendLocalCopy({ ...options, fetch: async () => new Response() })).sent).toBe(2)
})
