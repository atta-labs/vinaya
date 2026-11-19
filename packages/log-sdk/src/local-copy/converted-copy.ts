import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { ATTRIBUTE_NAMES as A, SDK_VERSION } from '../contract/catalogue.js'
import type { ConvertedEarlierRecord, EarlierOpenStart } from '../contract/convert-live.js'
import { spanIdFor } from '../contract/ids.js'
import { MAX_COMPONENT_BYTES, repoSegment } from '../writer/settings.js'

const MAX_BYTES = 8 * 1024 * 1024
const INDEX_WIDTH = 12
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
const SCOPE = { name: '@attalabs/vinaya-log-sdk', version: SDK_VERSION }

type Signal = 'traces' | 'logs'
type Json = Record<string, unknown>

export type ConvertedCopyOptions = {
  runId: string
  /** Names this writer's files; one per process, never shared. */
  writerId: string
  repository: string | undefined
  /** The Log folder; the repository's own directory is made inside it. */
  folder: string
}

function runSegment(runId: string, writerId: string): string {
  const suffix = Buffer.byteLength(`~${writerId}~${'0'.repeat(INDEX_WIDTH)}.traces.jsonl`)
  return SAFE_SEGMENT.test(runId) && !runId.includes('..') && Buffer.byteLength(runId) + suffix <= MAX_COMPONENT_BYTES
    ? runId
    : 'unresolved'
}

function stringAttribute(attributes: unknown, key: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined
  for (const attribute of attributes as Json[]) {
    if (attribute.key !== key) continue
    const value = attribute.value as Json | undefined
    return typeof value?.stringValue === 'string' ? value.stringValue : undefined
  }
  return undefined
}

/**
 * Writes already-converted records to one writer's own files of a run's local copy, in the naming and layout
 * the sender reads, and reads back the starts other writers left open for the same run.
 */
export function createConvertedCopy(options: ConvertedCopyOptions) {
  const { runId, writerId } = options
  const run = runSegment(runId, writerId)
  let nextIndex = 0
  let active: { path: string; signal: Signal; bytes: number; dev: bigint; ino: bigint } | undefined
  let checkedDirectory: string | undefined

  function directory(): string {
    if (checkedDirectory !== undefined) {
      // A directory replaced since the last write is refused, never followed.
      const stat = lstatSync(checkedDirectory)
      if (stat.isDirectory() && realpathSync(checkedDirectory) === checkedDirectory) return checkedDirectory
      throw new Error(`Unsafe Log directory: ${checkedDirectory}`)
    }
    const target = join(options.folder, repoSegment(options.repository))
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const physical = realpathSync(target)
    if (!lstatSync(target).isDirectory()) throw new Error(`Unsafe Log directory: ${target}`)
    checkedDirectory = physical
    return physical
  }

  function appendLine(signal: Signal, line: Buffer): void {
    if (!SAFE_SEGMENT.test(writerId) || writerId.includes('..')) throw new Error('Unsafe Log writer identifier')
    const folder = directory()
    const reuse = active?.signal === signal && active.bytes + line.length <= MAX_BYTES ? active : undefined
    const index = String(nextIndex).padStart(INDEX_WIDTH, '0')
    if (index.length > INDEX_WIDTH) throw new Error('Log file sequence exhausted')
    const path = reuse?.path ?? join(folder, `${run}~${writerId}~${index}.${signal}.jsonl`)
    const fd = openSync(path, reuse ? APPEND_FLAGS : APPEND_FLAGS | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      const stat = fstatSync(fd, { bigint: true })
      if (!stat.isFile() || stat.nlink !== 1n) throw new Error(`Unsafe Log file: ${path}`)
      if (reuse && (stat.dev !== reuse.dev || stat.ino !== reuse.ino || stat.size !== BigInt(reuse.bytes))) {
        throw new Error(`Unsafe Log file: ${path}`)
      }
      // The sender counts a writer's files from zero, so the index advances only once a file exists.
      if (!reuse) nextIndex += 1
      // A failed write leaves its partial line at the end of this file; the next record starts a new one.
      active = undefined
      let offset = 0
      while (offset < line.length) {
        const count = writeSync(fd, line, offset, line.length - offset)
        if (count === 0) throw new Error(`Log append made no progress: ${path}`)
        offset += count
      }
      active = { path, signal, bytes: Number(stat.size) + line.length, dev: stat.dev, ino: stat.ino }
    } finally {
      closeSync(fd)
    }
  }

  // What other writers' files hold, read once and then only from where each file was read to.
  const consumed = new Map<string, number>()
  const starts = new Map<string, string>()
  const endedSpans = new Set<string>()

  function readNew(name: string, signal: Signal, own: boolean): void {
    const path = join(checkedDirectory ?? directory(), name)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return
      const from = consumed.get(name) ?? 0
      if (stat.size <= from) return
      const bytes = Buffer.allocUnsafe(stat.size - from)
      let got = 0
      while (got < bytes.length) {
        const count = readSync(fd, bytes, got, bytes.length - got, from + got)
        if (count === 0) break
        got += count
      }
      const end = bytes.subarray(0, got).lastIndexOf(10)
      if (end === -1) return
      consumed.set(name, from + end + 1)
      for (const text of bytes.subarray(0, end).toString('utf8').split('\n')) {
        if (text === '') continue
        let parsed: Json
        try {
          parsed = JSON.parse(text) as Json
        } catch {
          continue
        }
        if (signal === 'traces') {
          for (const group of (parsed.resourceSpans as Json[] | undefined) ?? [])
            for (const scope of (group.scopeSpans as Json[] | undefined) ?? [])
              for (const span of (scope.spans as Json[] | undefined) ?? [])
                if (typeof span.spanId === 'string') endedSpans.add(span.spanId)
        } else if (!own) {
          for (const group of (parsed.resourceLogs as Json[] | undefined) ?? [])
            for (const scope of (group.scopeLogs as Json[] | undefined) ?? [])
              for (const record of (scope.logRecords as Json[] | undefined) ?? []) {
                const key = stringAttribute(record.attributes, A.spanKey)
                if (key !== undefined && typeof record.timeUnixNano === 'string' && !starts.has(key)) {
                  starts.set(key, record.timeUnixNano)
                }
              }
        }
      }
    } finally {
      closeSync(fd)
    }
  }

  return {
    writerId,
    /** Writes one converted record as a one-record OTLP JSON request line. */
    append(converted: ConvertedEarlierRecord): void {
      if (converted.type === 'span') {
        const body = {
          resourceSpans: [{ resource: converted.resource, scopeSpans: [{ scope: SCOPE, spans: [converted.record] }] }]
        }
        appendLine('traces', Buffer.from(`${JSON.stringify(body)}\n`))
      } else {
        const body = {
          resourceLogs: [
            { resource: converted.resource, scopeLogs: [{ scope: SCOPE, logRecords: [converted.record] }] }
          ]
        }
        appendLine('logs', Buffer.from(`${JSON.stringify(body)}\n`))
      }
    },
    /**
     * The starts that other writers wrote to this run's files and nothing has ended yet. Starts this
     * writer wrote itself are the converter's own to track, so its files' starts are left out.
     */
    openStarts(): EarlierOpenStart[] {
      const folder = directory()
      const prefix = `${run}~`
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.startsWith(prefix)) continue
        const match = /^[^~]+~([^~]+)~\d{12}\.(traces|logs)\.jsonl$/.exec(entry.name)
        if (!match) continue
        readNew(entry.name, match[2] as Signal, match[1] === writerId)
      }
      const open: EarlierOpenStart[] = []
      for (const [spanKey, startTimeUnixNano] of starts) {
        const spanId = spanKey.startsWith('span:') ? spanKey.slice(5) : spanIdFor(runId, spanKey)
        if (!endedSpans.has(spanId)) open.push({ spanKey, startTimeUnixNano })
      }
      return open
    }
  }
}
