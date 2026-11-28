import { afterEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { FINISHED_FILES, REQUESTS_IN_FLIGHT, sendLocalCopy, type SendLocalCopyOptions } from '../src/sender/send.js'

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

test('sets malformed UTF-8 aside and sends a valid large line unchanged', async () => {
  const options = fixture()
  const file = join(options.dir, 'run~writer~000000000000.logs.jsonl')
  const record = JSON.stringify({ body: 'a'.repeat(128 * 1024) })
  writeFileSync(file, Buffer.concat([Buffer.from('{"body":"'), Buffer.from([255]), Buffer.from(`"}\n${record}\n`)]))
  const report = await sendLocalCopy({
    ...options,
    deadline: Date.now() + 2000,
    fetch: async (_url, init) => {
      expect(await new Response(init.body).text()).toBe(record)
      return new Response()
    }
  })
  expect(report.sent).toBe(1)
  expect(report.failures).toEqual([])
  expect(report.setAside.map(({ reason }) => reason)).toEqual(['invalid JSON'])
})

test.each([0, 128 * 1024])('redacts posted values and keeps receipts with %i bytes of padding', async (padding) => {
  const options = fixture()
  const homeOption = padding > 0 ? { home: '/home/al' } : {}
  const home = homeOption.home ?? homedir()
  const file = join(options.dir, 'run~writer~000000000000.logs.jsonl')
  const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')
  const number = '9223372036854775807'
  const record = {
    resourceLogs: [],
    nested: [{ ['__proto__']: `opened "${home}/folder\\file"\n${token}`, intValue: 'exact-number' }],
    padding: 'a'.repeat(padding)
  }
  const local = `${JSON.stringify(record)
    .replace(token, `\\u0067${token.slice(1)}`)
    .replace('"exact-number"', number)}\n`
  writeFileSync(file, local)
  const posted: string[] = []
  const fetch: SendLocalCopyOptions['fetch'] = async (_url, init) => {
    posted.push(await new Response(init.body).text())
    return new Response(null, { status: 204 })
  }

  expect(await sendLocalCopy({ ...options, ...homeOption, fetch })).toEqual({ sent: 1, setAside: [], failures: [] })
  expect(await sendLocalCopy({ ...options, home: '/different/home', fetch })).toEqual({
    sent: 0,
    setAside: [],
    failures: []
  })
  const expected = {
    ...record,
    nested: [{ ['__proto__']: 'opened "~/folder\\file"\n<redacted>', intValue: 'exact-number' }]
  }
  expect(posted).toEqual([JSON.stringify(expected).replace('"exact-number"', number)])
  expect(readFileSync(file, 'utf8')).toBe(local)
})

test.each([10_000, 40_000])('sends valid records nested %i levels deep', async (depth) => {
  const options = fixture()
  const file = join(options.dir, 'run~writer~000000000000.logs.jsonl')
  const open = '{"nested":' + '['.repeat(depth)
  const close = ']'.repeat(depth) + '}'
  const local = open + '["PATH=/home/al:/usr/bin", 9223372036854775807]' + close
  const expected = open + '["PATH=~:/usr/bin", 9223372036854775807]' + close
  writeFileSync(file, local + '\n')
  const posted: string[] = []
  const report = await sendLocalCopy({
    ...options,
    home: '/home/al/',
    fetch: async (_url, init) => {
      posted.push(await new Response(init.body).text())
      return new Response(null, { status: 204 })
    }
  })
  expect(report).toEqual({ sent: 1, setAside: [], failures: [] })
  expect(posted).toEqual([expected])
  expect(readFileSync(file, 'utf8')).toBe(local + '\n')
})

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
  // Requests run side by side, so the order records are set aside in is not fixed.
  expect(initial.setAside.map((rejection) => rejection.reason).sort()).toEqual(['HTTP 400', 'invalid JSON'])
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

const segmentPath = (dir: string, index: number) =>
  join(dir, `run~writer~${String(index).padStart(12, '0')}.logs.jsonl`)
const markerPath = (dir: string, index: number, suffix: 'seen' | 'done') =>
  join(dir, '.otlp-delivery', `run~writer~${String(index).padStart(12, '0')}.logs.${suffix}`)
const record = (id: string) => JSON.stringify({ resourceLogs: [], id })
const accept: SendLocalCopyOptions['fetch'] = async () => new Response(null, { status: 204 })
const refuseAll: SendLocalCopyOptions['fetch'] = async () => {
  throw new Error('no record should be posted')
}

test('a later send opens no finished file, size marker or delivered receipt and rewrites no marker', async () => {
  const options = fixture()
  const count = 200
  for (let index = 0; index < count; index++) writeFileSync(segmentPath(options.dir, index), `${record(`r${index}`)}\n`)
  expect(await sendLocalCopy({ ...options, fetch: accept })).toEqual({ sent: count, setAside: [], failures: [] })

  const state = join(options.dir, '.otlp-delivery')
  const markers: string[] = []
  for (let index = 0; index < count; index++) {
    chmodSync(segmentPath(options.dir, index), 0)
    markers.push(markerPath(options.dir, index, 'seen'), markerPath(options.dir, index, 'done'))
  }
  for (const path of markers) chmodSync(path, 0)
  const sent = readdirSync(state).filter((name) => name.endsWith('.sent'))
  expect(sent).toHaveLength(count)
  for (const name of sent) chmodSync(join(state, name), 0)
  const inodes = markers.map((path) => statSync(path).ino)

  expect(await sendLocalCopy({ ...options, fetch: refuseAll })).toEqual({ sent: 0, setAside: [], failures: [] })
  expect(markers.map((path) => statSync(path).ino)).toEqual(inodes)
})

test('a file that grew has only its new record posted, without opening its delivered receipts', async () => {
  const options = fixture()
  const file = segmentPath(options.dir, 0)
  writeFileSync(file, `${record('a')}\n${record('b')}\n`)
  expect((await sendLocalCopy({ ...options, fetch: accept })).sent).toBe(2)
  const state = join(options.dir, '.otlp-delivery')
  for (const name of readdirSync(state).filter((name) => name.endsWith('.sent'))) chmodSync(join(state, name), 0)
  appendFileSync(file, `${record('c')}\n`)
  const posted: string[] = []
  const report = await sendLocalCopy({
    ...options,
    fetch: async (_url, init) => {
      posted.push(String(init.body))
      return new Response(null, { status: 204 })
    }
  })
  expect(report).toEqual({ sent: 1, setAside: [], failures: [] })
  expect(posted).toEqual([record('c')])
})

test('a send with its summary deleted posts no delivered record again and writes the summary back', async () => {
  const options = fixture()
  for (let index = 0; index < 5; index++) writeFileSync(segmentPath(options.dir, index), `${record(`r${index}`)}\n`)
  expect((await sendLocalCopy({ ...options, fetch: accept })).sent).toBe(5)
  const summary = join(options.dir, '.otlp-delivery', FINISHED_FILES)
  const written = readFileSync(summary, 'utf8')
  unlinkSync(summary)
  expect(await sendLocalCopy({ ...options, fetch: refuseAll })).toEqual({ sent: 0, setAside: [], failures: [] })
  expect(readFileSync(summary, 'utf8')).toBe(written)
})

test('a send posts the newest file first, before staging older files, and earlier-staged records after it', async () => {
  const options = fixture()
  const delivered = 50
  const base = Date.now() / 1000 - 10_000
  for (let index = 0; index < delivered; index++) {
    writeFileSync(segmentPath(options.dir, index), `${record(`old${index}`)}\n`)
    utimesSync(segmentPath(options.dir, index), base + index, base + index)
  }
  const waiting = segmentPath(options.dir, delivered)
  writeFileSync(waiting, `${record('waiting1')}\n${record('waiting2')}\n`)
  utimesSync(waiting, base + delivered, base + delivered)
  const first = await sendLocalCopy({
    ...options,
    fetch: async (_url, init) => new Response(null, { status: String(init.body).includes('waiting') ? 503 : 204 })
  })
  expect(first.sent).toBe(delivered)
  expect(first.failures.map(({ reason }) => reason)).toEqual(['HTTP 503', 'HTTP 503'])

  // Without the summary and their completion markers, the delivered files are staged again by this send.
  unlinkSync(join(options.dir, '.otlp-delivery', FINISHED_FILES))
  for (let index = 0; index < delivered; index++) unlinkSync(markerPath(options.dir, index, 'done'))
  const newest = segmentPath(options.dir, delivered + 1)
  writeFileSync(newest, `${record('new')}\n`)
  utimesSync(newest, base + 1000, base + 1000)

  const posted: string[] = []
  let oldestDoneAtFirstRequest: boolean | undefined
  const report = await sendLocalCopy({
    ...options,
    fetch: async (_url, init) => {
      oldestDoneAtFirstRequest ??= existsSync(markerPath(options.dir, 0, 'done'))
      posted.push(String(init.body))
      return new Response(null, { status: 204 })
    }
  })
  expect(report).toEqual({ sent: 3, setAside: [], failures: [] })
  expect(posted[0]).toBe(record('new'))
  expect(posted.slice(1).sort()).toEqual([record('waiting1'), record('waiting2')])
  expect(oldestDoneAtFirstRequest).toBe(false)
  expect(existsSync(markerPath(options.dir, 0, 'done'))).toBe(true)
})

test('a send keeps eight requests in flight and never nine, posting each record once', async () => {
  const options = fixture()
  const total = 20
  for (let index = 0; index < total; index++) writeFileSync(segmentPath(options.dir, index), `${record(`r${index}`)}\n`)
  const posted: string[] = []
  const held: Array<() => void> = []
  let inFlight = 0
  let most = 0
  let released = 0
  const report = await sendLocalCopy({
    ...options,
    fetch: async (_url, init) => {
      posted.push(String(init.body))
      inFlight++
      most = Math.max(most, inFlight)
      const answered = new Promise<void>((resolve) => held.push(resolve))
      // Hold every request until as many as can be in flight are, then give a ninth time to start.
      if (held.length === Math.min(REQUESTS_IN_FLIGHT, total - released)) {
        setTimeout(() => {
          for (const resolve of held.splice(0)) {
            released++
            inFlight--
            resolve()
          }
        }, 20)
      }
      await answered
      return new Response(null, { status: 204 })
    }
  })
  expect(REQUESTS_IN_FLIGHT).toBe(8)
  expect(most).toBe(8)
  expect(report).toEqual({ sent: total, setAside: [], failures: [] })
  expect(posted.sort()).toEqual(Array.from({ length: total }, (_, index) => record(`r${index}`)).sort())
})
