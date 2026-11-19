import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

async function recordReceipt(path: string, content: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, content, { flag: 'wx', mode: 0o600 })
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
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

/** Send immutable, newline-terminated records without taking a writer or sender lock. */
export async function sendLocalCopy(options: SendLocalCopyOptions): Promise<LocalCopyReport> {
  const directory = join(options.folder, repoSegment(options.repository))
  const state = join(directory, '.otlp-delivery')
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY
  const report: LocalCopyReport = { sent: 0, setAside: [], failures: [] }
  let stopped = false

  async function send(): Promise<void> {
    const endpoints = { traces: otlpSignalUrl(options.url, 'traces'), logs: otlpSignalUrl(options.url, 'logs') }
    const headers = new Headers(options.headers)
    headers.set('content-type', 'application/json')
    const files = await list(directory)
    await checkState(state)
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
          const receipt = join(state, key)
          const rejected = `${receipt}.rejected.json`
          const delivered = `${receipt}.${createHash('sha256').update(endpoints[signal]).digest('hex')}.sent`
          if ((await hasReceipt(rejected)) || (await hasReceipt(delivered))) continue
          if (stopped || Date.now() >= deadline) return
          const body = line.toString('utf8')
          let reason: string | undefined
          try {
            JSON.parse(body)
          } catch {
            reason = 'invalid JSON'
          }
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
          await recordReceipt(rejected, JSON.stringify({ ...refusal, line: body }))
          if (!stopped) report.setAside.push(refusal)
        }
      } catch {
        if (!stopped) report.failures.push({ file: entry.name, reason: 'local copy or delivery state unavailable' })
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
