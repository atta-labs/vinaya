import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { repoSegment } from '../writer/settings.js'

type Signal = 'traces' | 'logs'
const segmentName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*~[a-zA-Z0-9][a-zA-Z0-9._-]*~\d{12}\.(traces|logs)\.jsonl$/
const retryableClientStatuses = new Set([401, 403, 404, 408, 429])
const requestTimeoutMs = 30_000

export type SendLocalCopyOptions = {
  folder: string
  repository?: string
  url: string
  headers?: Record<string, string>
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
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function validateJson(bytes: Uint8Array): boolean {
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    return true
  } catch {
    return false
  }
}

function validateLargeLine(line: Buffer, signal: AbortSignal): Promise<boolean> {
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     parentPort.postMessage((${validateJson.toString()})(workerData));`,
    { eval: true, workerData: line }
  )
  const abort = () => void worker.terminate()
  return new Promise<boolean>((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', () => reject(new Error('JSON validation ended')))
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
  body: BodyInit,
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

/** Send immutable, newline-terminated records without taking a writer or sender lock. */
export async function sendLocalCopy(options: SendLocalCopyOptions): Promise<LocalCopyReport> {
  const directory = join(options.folder, repoSegment(options.repository))
  const state = join(directory, '.otlp-delivery')
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY
  const report: LocalCopyReport = { sent: 0, setAside: [], failures: [] }
  let stopped = false
  const stop = new AbortController()

  async function send(): Promise<void> {
    const endpoints = { traces: otlpSignalUrl(options.url, 'traces'), logs: otlpSignalUrl(options.url, 'logs') }
    const headers = new Headers(options.headers)
    headers.set('content-type', 'application/json')
    const files = await list(directory)
    await checkState(state)
    const pending = new Map<string, { signal: Signal; file: string; offset: number }>()
    for (const entry of await list(state)) {
      const match = /^([a-f0-9]{64})\.(traces|logs)\.pending$/.exec(entry.name)
      if (match?.[1] && entry.isFile())
        pending.set(entry.name, { file: match[1], offset: 0, signal: match[2] as Signal })
    }
    for (const entry of files) {
      if (stopped || Date.now() >= deadline) return
      const signal = segmentName.exec(entry.name)?.[1] as Signal | undefined
      if (!signal || !entry.isFile()) continue
      try {
        const data = await snapshot(join(directory, entry.name))
        if (!data) continue
        for (let offset = 0, end = data.indexOf(10); end !== -1; end = data.indexOf(10, offset)) {
          if (stopped || Date.now() >= deadline) return
          const identity = { file: entry.name, offset }
          const line = data.subarray(offset, end)
          offset = end + 1
          // A replacement with different bytes gets its own receipt. No position
          // in this file can mark a different file or an earlier line delivered.
          const key = createHash('sha256').update(JSON.stringify(identity)).update(line).digest('hex')
          const name = `${key}.${signal}.pending`
          const path = join(state, name)
          if (!pending.has(name)) {
            if (await hasReceipt(join(state, `${key}.rejected.json`))) continue
            if (await hasReceipt(deliveryPath(key, signal))) continue
            await mkdir(state, { recursive: true, mode: 0o700 })
            // Include the newline so even an empty invalid line has a nonempty receipt.
            await recordReceipt(path, data.subarray(identity.offset, offset))
          }
          pending.set(name, { ...identity, signal })
        }
      } catch {
        if (!stopped) report.failures.push({ file: entry.name, reason: 'local copy or delivery state unavailable' })
      }
    }

    function deliveryPath(key: string, signal: Signal): string {
      return join(state, `${key}.${createHash('sha256').update(endpoints[signal]).digest('hex')}.sent`)
    }

    for (const [name, { signal, ...identity }] of pending) {
      if (stopped || Date.now() >= deadline) return
      try {
        const key = name.slice(0, 64)
        const rejected = join(state, `${key}.rejected.json`)
        const delivered = deliveryPath(key, signal)
        if ((await hasReceipt(rejected)) || (await hasReceipt(delivered))) continue
        const bytes = await snapshot(join(state, name))
        if (!bytes || stopped || Date.now() >= deadline) continue
        const line = bytes.subarray(0, -1)
        const large = line.length > 64 * 1024
        const valid = large ? await validateLargeLine(line, stop.signal) : validateJson(line)
        if (stopped || Date.now() >= deadline) return
        const body = large ? (line as Uint8Array<ArrayBuffer>) : line.toString('utf8')
        let reason = valid ? undefined : 'invalid JSON'
        if (!reason) {
          const status = await post(options.fetch ?? fetch, endpoints[signal], headers, body, deadline)
          if (stopped) return
          if (typeof status !== 'number') {
            report.failures.push({ ...identity, reason: status })
            continue
          }
          if (status >= 200 && status < 300) {
            await mkdir(state, { recursive: true, mode: 0o700 })
            await recordReceipt(delivered, 'sent\n')
            if (!stopped) report.sent++
            continue
          }
          reason = `HTTP ${status}`
          if (status < 400 || status >= 500 || retryableClientStatuses.has(status)) {
            report.failures.push({ ...identity, reason })
            continue
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
