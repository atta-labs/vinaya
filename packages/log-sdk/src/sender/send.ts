import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { checkReservedNames, describeContractFailure, type ReservedName, reservedNamesOf } from '../contract/check.js'
import { redact } from '../contract/redact.js'
import { repoSegment } from '../writer/settings.js'

type Signal = 'traces' | 'logs'
const segmentName = /^([a-zA-Z0-9][a-zA-Z0-9._-]*~([a-zA-Z0-9][a-zA-Z0-9._-]*))~(\d{12})\.(traces|logs)\.jsonl$/
const retryableClientStatuses = new Set([401, 403, 404, 408, 429])
const requestTimeoutMs = 30_000

export type SendLocalCopyOptions = {
  folder: string
  repository?: string
  url: string
  headers?: Record<string, string>
  /** Home directory to shorten in posted values. Defaults to the process's home directory. */
  home?: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Absolute deadline in Unix milliseconds. */
  deadline?: number
}

export type LocalCopyReport = {
  sent: number
  setAside: Array<{ file: string; offset: number; reason: string }>
  failures: Array<{ file?: string; offset?: number; reason: string }>
}

export function otlpSignalUrl(base: string, signal: Signal): string {
  const url = new URL(base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Expected an HTTP(S) address')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/${signal}`
  url.hash = ''
  return url.toString()
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function nextNewline(data: Buffer, offset: number, signal: AbortSignal): Promise<number> {
  const block = 64 * 1024
  for (let start = offset; start < data.length && !signal.aborted; start += block) {
    const index = data.subarray(start, start + block).indexOf(10)
    if (index !== -1) return start + index
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return -1
}

/** The hash every per-line receipt key is built from: the line's file and offset, then its bytes. */
function lineHash(identity: { file: string; offset: number }) {
  return createHash('sha256').update(JSON.stringify(identity))
}

async function lineKey(identity: { file: string; offset: number }, line: Buffer, signal: AbortSignal) {
  const hash = lineHash(identity)
  const block = 64 * 1024
  for (let start = 0; start < line.length; start += block) {
    if (signal.aborted) return undefined
    hash.update(line.subarray(start, start + block))
    if (line.length > block) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return hash.digest('hex')
}

/** The folder under a repository's local copy that holds the sender's delivery state. */
export const DELIVERY_STATE_DIRECTORY = '.otlp-delivery'

/**
 * The names of the delivery state the sender keeps for one local-copy file: its two size markers, and the key
 * every per-line receipt (`<key>.<signal>.pending`, `<key>.<hash>.sent`, `<key>.rejected.json`) starts with.
 * `data` is the file's bytes; only lines ended by a newline are ever keyed.
 */
export function deliveryStateOf(name: string, data: Buffer): { markers: string[]; lineKeys: string[] } {
  const lineKeys: string[] = []
  let offset = 0
  for (;;) {
    const end = data.indexOf(10, offset)
    if (end === -1) break
    lineKeys.push(lineHash({ file: name, offset }).update(data.subarray(offset, end)).digest('hex'))
    offset = end + 1
  }
  const stem = name.slice(0, -'.jsonl'.length)
  return { markers: [`${stem}.seen`, `${stem}.done`], lineKeys }
}

function rejectedBeforePost(path: string): boolean {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe rejection receipt')
    return stat.size > 0
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

async function list(directory: string) {
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Unsafe local copy directory')
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
}

async function snapshot(path: string): Promise<Buffer | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
  if (!file) return undefined
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe local copy')
    const bytes = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}

async function hasReceipt(path: string): Promise<boolean> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe delivery receipt')
      return stat.size > 0
    } finally {
      await file.close()
    }
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

async function recordReceipt(path: string, content: string | Uint8Array): Promise<void> {
  const temp = join(dirname(path), `${randomUUID()}.tmp`)
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

type Inspection = { valid: false } | { valid: true; names: ReservedName[]; body: string }

/** Read the original contract names and serialize the redacted values. A worker can run this for large lines. */
function inspectLine(
  bytes: Uint8Array,
  home: string,
  collect: typeof reservedNamesOf,
  redactValue: typeof redact
): Inspection {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return { valid: false }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { valid: false }
  }
  const names = collect(document)

  // Reserialize only changed string values in the validated JSON. Scanning the
  // tokens needs no recursion and keeps number literals at their original precision.
  const quoteOrEscape = /["\\]/g
  const propertySeparator = /[ \t\r\n]*:/y
  let body = ''
  let copiedThrough = 0
  let start = text.indexOf('"')
  while (start !== -1) {
    quoteOrEscape.lastIndex = start + 1
    for (let match = quoteOrEscape.exec(text); match?.[0] === '\\'; match = quoteOrEscape.exec(text)) {
      quoteOrEscape.lastIndex++
    }
    const end = quoteOrEscape.lastIndex
    propertySeparator.lastIndex = end
    if (!propertySeparator.test(text)) {
      const value = JSON.parse(text.slice(start, end)) as string
      const redacted = redactValue(value, home)
      if (redacted !== value) {
        body += text.slice(copiedThrough, start) + JSON.stringify(redacted)
        copiedThrough = end
      }
    }
    start = text.indexOf('"', end)
  }
  return { valid: true, names, body: body + text.slice(copiedThrough) }
}

function inspectLargeLine(line: Buffer, home: string, signal: AbortSignal): Promise<Inspection> {
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const { line, home } = workerData;
     parentPort.postMessage((${inspectLine.toString()})(line, home, (${reservedNamesOf.toString()}), (${redact.toString()})));`,
    { eval: true, workerData: { line, home } }
  )
  const abort = () => void worker.terminate()
  return new Promise<Inspection>((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error('line inspection ended')))
    signal.addEventListener('abort', abort, { once: true })
  }).finally(() => {
    signal.removeEventListener('abort', abort)
    void worker.terminate()
  })
}

async function checkState(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('Unsafe delivery state directory')
  } catch (error) {
    if (!missing(error)) throw error
  }
}

async function post(
  fetcher: NonNullable<SendLocalCopyOptions['fetch']>,
  url: string,
  headers: Headers,
  body: string,
  deadline: number
): Promise<number | 'deadline reached' | 'request timed out' | 'no answer'> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return 'deadline reached'
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<'deadline reached' | 'request timed out'>((resolve) => {
      timer = setTimeout(
        () => {
          resolve(remaining <= requestTimeoutMs ? 'deadline reached' : 'request timed out')
          abort.abort()
        },
        Math.min(remaining, requestTimeoutMs)
      )
    })
    const response = fetcher(url, { method: 'POST', headers, body, redirect: 'manual', signal: abort.signal })
      .then((answer) => {
        void answer.body?.cancel().catch(() => {})
        return answer.status
      })
      .catch(() => 'no answer' as const)
    return await Promise.race([timeout, response])
  } catch {
    return 'no answer'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The one file in the delivery folder that lists each local-copy file staged to its end, with the size it had then.
 * A send reads it once instead of opening two size markers per file, and rebuilds it from those markers when it is
 * missing or unreadable.
 */
export const FINISHED_FILES = 'finished-files.json'
/** How many records a send has posted and not yet heard back about, at most. */
export const REQUESTS_IN_FLIGHT = 8
/** How many staged records may wait for a request before staging pauses. */
const queuedRecordsBound = 1024

type Queued = {
  name: string
  key: string
  signal: Signal
  identity: { file: string; offset: number }
  /** The staged line with its newline, when this send staged it; otherwise read from the pending receipt. */
  bytes?: Buffer
}

function readFinishedFiles(bytes: Buffer): Map<string, number> {
  const document = JSON.parse(bytes.toString('utf8')) as { files?: unknown }
  const files = document.files
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new Error('Unreadable summary')
  const sizes = new Map<string, number>()
  for (const [name, size] of Object.entries(files)) {
    if (!segmentName.test(name) || !Number.isSafeInteger(size) || (size as number) < 0)
      throw new Error('Unreadable summary')
    sizes.set(name, size as number)
  }
  return sizes
}

/** Send immutable, newline-terminated records without taking a writer or sender lock. */
export async function sendLocalCopy(options: SendLocalCopyOptions): Promise<LocalCopyReport> {
  const directory = join(options.folder, repoSegment(options.repository))
  const state = join(directory, '.otlp-delivery')
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY
  const report: LocalCopyReport = { sent: 0, setAside: [], failures: [] }
  let stopped = false
  const stop = new AbortController()

  async function send(): Promise<void> {
    const home = options.home ?? homedir()
    const endpoints = { traces: otlpSignalUrl(options.url, 'traces'), logs: otlpSignalUrl(options.url, 'logs') }
    const endpointHashes = {
      traces: createHash('sha256').update(endpoints.traces).digest('hex'),
      logs: createHash('sha256').update(endpoints.logs).digest('hex')
    }
    const headers = new Headers(options.headers)
    headers.set('content-type', 'application/json')
    const files = await list(directory)
    await checkState(state)
    const entries = await list(state)
    // Receipts are judged by the listing: a record whose `.sent` or rejected receipt is listed is not opened.
    const listed = new Set<string>()
    for (const entry of entries) if (entry.isFile()) listed.add(entry.name)
    const observed = new Map<string, string>()
    const writers = new Map<string, Set<number>>()
    const seen = new Set<string>()
    const markerName = (name: string, suffix: string) => `${name.slice(0, -6)}.${suffix}`
    const marker = (name: string, suffix: string) => join(state, markerName(name, suffix))
    const sentName = (key: string, signal: Signal) => `${key}.${endpointHashes[signal]}.sent`
    const finishedRecord = (key: string, signal: Signal) =>
      listed.has(sentName(key, signal)) || listed.has(`${key}.rejected.json`)
    async function fullyStaged(name: string): Promise<boolean> {
      const size = await snapshot(marker(name, 'seen'))
      const complete = await snapshot(marker(name, 'done'))
      return size !== undefined && complete !== undefined && Number(complete.toString()) >= Number(size.toString())
    }
    function remember(name: string, onDisk: boolean) {
      const match = segmentName.exec(name)
      if (!match?.[1] || !match[2]) return
      const index = Number(match[3])
      const positions = writers.get(match[1]) ?? new Set<number>()
      positions.add(index)
      writers.set(match[1], positions)
      if (onDisk) seen.add(name)
      observed.set(name, match[2])
    }
    for (const entry of files) if (entry.isFile()) remember(entry.name, true)
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (entry.name.endsWith('.seen')) remember(`${entry.name.slice(0, -5)}.jsonl`, false)
    }

    // One read of the summary replaces two marker opens per finished file. Without a readable summary, a file's
    // own markers say how far it was staged, and the summary is written back from them below.
    const summaryPath = join(state, FINISHED_FILES)
    let summary = new Map<string, number>()
    let summaryText: string | undefined
    try {
      const bytes = await snapshot(summaryPath)
      if (bytes) {
        summary = readFinishedFiles(bytes)
        summaryText = bytes.toString('utf8')
      }
    } catch {
      summary = new Map()
    }
    async function stagedThrough(name: string): Promise<number | undefined> {
      const listedSize = summary.get(name)
      if (listedSize !== undefined) return listedSize
      if (!listed.has(markerName(name, 'seen')) || !listed.has(markerName(name, 'done'))) return undefined
      try {
        const size = await snapshot(marker(name, 'seen'))
        const complete = await snapshot(marker(name, 'done'))
        if (size === undefined || complete === undefined) return undefined
        const through = Number(complete.toString())
        return Number.isSafeInteger(through) && through >= Number(size.toString()) ? through : undefined
      } catch {
        return undefined
      }
    }
    // A stat opens nothing: it gives each file's size, to skip what is finished, and its last write, to stage the
    // newest first.
    const onDisk = new Map<string, { size: number; modified: number }>()
    const finished = new Map<string, number>()
    for (const name of seen) {
      if (stopped || Date.now() >= deadline) return
      const stat = await lstat(join(directory, name)).catch((error) => {
        if (missing(error)) return undefined
        throw error
      })
      if (!stat?.isFile()) continue
      onDisk.set(name, { size: stat.size, modified: stat.mtimeMs })
      if ((await stagedThrough(name)) === stat.size) finished.set(name, stat.size)
    }

    async function lost(name: string, writer: string) {
      const failure = { file: join(directory, name), reason: `lost segment from writer ${writer}` }
      const key = createHash('sha256').update(name).digest('hex')
      await mkdir(state, { recursive: true, mode: 0o700 })
      await recordReceipt(join(state, `${key}.lost.json`), JSON.stringify(failure))
      if (!stopped) report.failures.push(failure)
    }
    for (const [name, writer] of observed) {
      if (stopped || Date.now() >= deadline) return
      if (finished.has(name)) continue
      if (seen.has(name)) {
        await mkdir(state, { recursive: true, mode: 0o700 })
        const stat = onDisk.get(name)
        if (stat) await recordReceipt(marker(name, 'seen'), String(stat.size))
        else if (!summary.has(name) && !(await fullyStaged(name))) await lost(name, writer)
      } else if (!summary.has(name) && !(await fullyStaged(name)) && !(await hasReceipt(join(directory, name)))) {
        await lost(name, writer)
      }
    }
    // The writer (local-copy/file-exporters.ts) numbers one run's files per writer from 0 with one
    // counter shared by both signals, advanced only after a file is created, so a missing index
    // below the highest one seen is a file that was removed.
    for (const [prefix, positions] of writers) {
      let expected = 0
      for (const index of [...positions].sort((a, b) => a - b)) {
        if (stopped || Date.now() >= deadline) return
        if (index > expected) {
          const slot = (value: number) => String(value).padStart(12, '0')
          const range = index === expected + 1 ? slot(expected) : `${slot(expected)}–${slot(index - 1)}`
          // The missing file's signal is unknown, so the path is a pattern, not a real file.
          await lost(
            `${prefix}~${range}.{traces,logs}.jsonl`,
            `${prefix.split('~')[1] ?? prefix} (a pattern: the signal is unknown)`
          )
        }
        expected = index + 1
      }
    }

    // Requests start as soon as a record is staged; staging goes on while up to REQUESTS_IN_FLIGHT are answered.
    const queue: Queued[] = []
    const queued = new Set<string>()
    let staging = true
    let wakeWorkers = () => {}
    let workAvailable = new Promise<void>((resolve) => (wakeWorkers = resolve))
    let wakeStager = () => {}
    let spaceAvailable = new Promise<void>((resolve) => (wakeStager = resolve))
    const halted = () => stopped || Date.now() >= deadline
    function notifyWorkers() {
      const wake = wakeWorkers
      workAvailable = new Promise<void>((resolve) => (wakeWorkers = resolve))
      wake()
    }
    function notifyStager() {
      const wake = wakeStager
      spaceAvailable = new Promise<void>((resolve) => (wakeStager = resolve))
      wake()
    }
    function enqueue(item: Queued) {
      if (queued.has(item.name)) return
      queued.add(item.name)
      queue.push(item)
      notifyWorkers()
    }

    async function deliver({ name, key, signal, identity, bytes: staged }: Queued): Promise<void> {
      try {
        const rejected = join(state, `${key}.rejected.json`)
        const delivered = join(state, sentName(key, signal))
        let bytes = staged
        if (!bytes) {
          if ((await hasReceipt(rejected)) || (await hasReceipt(delivered))) return
          bytes = await snapshot(join(state, name))
          if (!bytes || halted()) return
        }
        const line = bytes.subarray(0, -1)
        const large = line.length > 64 * 1024
        const inspection = large
          ? await inspectLargeLine(line, home, stop.signal)
          : inspectLine(line, home, reservedNamesOf, redact)
        if (halted()) return
        const failure = inspection.valid ? checkReservedNames(inspection.names) : null
        let reason: string
        if (!inspection.valid) reason = 'invalid JSON'
        else if (failure) reason = `contract: ${describeContractFailure(failure)}`
        else {
          if (rejectedBeforePost(rejected)) return
          const status = await post(options.fetch ?? fetch, endpoints[signal], headers, inspection.body, deadline)
          if (stopped) return
          if (typeof status !== 'number') {
            report.failures.push({ ...identity, reason: status })
            return
          }
          if (status >= 200 && status < 300) {
            await mkdir(state, { recursive: true, mode: 0o700 })
            await recordReceipt(delivered, 'sent\n')
            if (!stopped) report.sent++
            return
          }
          reason = `HTTP ${status}`
          if (status < 400 || status >= 500 || retryableClientStatuses.has(status)) {
            report.failures.push({ ...identity, reason })
            return
          }
        }
        const refusal = { ...identity, reason }
        await mkdir(state, { recursive: true, mode: 0o700 })
        // The immutable pending bytes also retain rejected lines verbatim.
        await recordReceipt(rejected, JSON.stringify({ ...refusal, payload: name }))
        if (!stopped) report.setAside.push(refusal)
      } catch {
        if (!stopped) report.failures.push({ ...identity, reason: 'local copy or delivery state unavailable' })
      }
    }

    async function worker(): Promise<void> {
      try {
        for (;;) {
          if (halted()) return
          const item = queue.shift()
          if (!item) {
            if (!staging) return
            await workAvailable
            continue
          }
          notifyStager()
          // Each request carries one record and gets its own receipt.
          await deliver(item)
        }
      } finally {
        notifyStager()
      }
    }
    const workers = Array.from({ length: REQUESTS_IN_FLIGHT }, worker)

    async function stage(name: string): Promise<void> {
      const match = segmentName.exec(name)
      const signal = match?.[4] as Signal | undefined
      if (!signal) return
      try {
        const data = await snapshot(join(directory, name))
        if (!data) {
          if (!summary.has(name) && !(await fullyStaged(name))) await lost(name, match?.[2] ?? 'unknown')
          return
        }
        let offset = 0
        while (offset < data.length) {
          if (halted()) return
          const end = await nextNewline(data, offset, stop.signal)
          if (end === -1) break
          const identity = { file: name, offset }
          const line = data.subarray(offset, end)
          offset = end + 1
          // A replacement with different bytes gets its own receipt. No position
          // in this file can mark a different file or an earlier line delivered.
          const key = await lineKey(identity, line, stop.signal)
          if (!key || halted()) return
          if (finishedRecord(key, signal)) continue
          const pendingName = `${key}.${signal}.pending`
          if (!listed.has(pendingName)) {
            if (await hasReceipt(join(state, `${key}.rejected.json`))) continue
            if (await hasReceipt(join(state, sentName(key, signal)))) continue
            await mkdir(state, { recursive: true, mode: 0o700 })
            // Include the newline so even an empty invalid line has a nonempty receipt.
            await recordReceipt(join(state, pendingName), data.subarray(identity.offset, offset))
          }
          while (queue.length >= queuedRecordsBound && !halted()) await spaceAvailable
          enqueue({
            name: pendingName,
            key,
            signal,
            identity,
            bytes: Buffer.from(data.subarray(identity.offset, offset))
          })
        }
        if (!stopped && offset === data.length) {
          await recordReceipt(marker(name, 'done'), String(data.length))
          finished.set(name, data.length)
        }
      } catch {
        if (!stopped) report.failures.push({ file: name, reason: 'local copy or delivery state unavailable' })
      }
    }

    try {
      const newestFirst = [...onDisk]
        .filter(([name]) => !finished.has(name))
        .sort(([a, x], [b, y]) => y.modified - x.modified || (a < b ? 1 : a > b ? -1 : 0))
        .map(([name]) => name)
      for (const name of newestFirst) {
        if (halted()) return
        await stage(name)
      }
      if (halted()) return

      // The summary is replaced whole. A removed file it lists stays listed while its size marker remains.
      const summaryFiles: Record<string, number> = {}
      for (const name of [...new Set([...finished.keys(), ...summary.keys()])].sort()) {
        const size = finished.get(name) ?? (onDisk.has(name) ? undefined : summary.get(name))
        if (size === undefined) continue
        if (!onDisk.has(name) && !listed.has(markerName(name, 'seen'))) continue
        summaryFiles[name] = size
      }
      const text = JSON.stringify({ files: summaryFiles })
      if (text !== summaryText) {
        try {
          await mkdir(state, { recursive: true, mode: 0o700 })
          await recordReceipt(summaryPath, text)
        } catch {
          // The summary saves work only; without it the next send reads the markers again.
        }
      }

      // Records staged by an earlier send go after this send's own.
      for (const name of listed) {
        if (halted()) return
        const match = /^([a-f0-9]{64})\.(traces|logs)\.pending$/.exec(name)
        if (!match?.[1]) continue
        const signal = match[2] as Signal
        if (queued.has(name) || finishedRecord(match[1], signal)) continue
        while (queue.length >= queuedRecordsBound && !halted()) await spaceAvailable
        enqueue({ name, key: match[1], signal, identity: { file: match[1], offset: 0 } })
      }
    } finally {
      staging = false
      notifyWorkers()
      await Promise.all(workers)
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const work = send().catch(() => {
    if (!stopped) report.failures.push({ reason: 'could not prepare OpenTelemetry delivery' })
  })
  try {
    if (deadline === Number.POSITIVE_INFINITY) await work
    else {
      const expired = new Promise<void>((resolve) => {
        const check = () => {
          const remaining = deadline - Date.now()
          if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647))
          else {
            stopped = true
            stop.abort()
            report.failures.push({ reason: 'deadline reached' })
            resolve()
          }
        }
        check()
      })
      await Promise.race([work, expired])
      if (!stopped && Date.now() >= deadline) report.failures.push({ reason: 'deadline reached' })
    }
    return report
  } finally {
    clearTimeout(timer)
  }
}
