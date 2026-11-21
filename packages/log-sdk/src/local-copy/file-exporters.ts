import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { MAX_COMPONENT_BYTES, repoSegment, type ResolvedSettings } from '../writer/settings.js'

const MAX_BYTES = 8 * 1024 * 1024
const INDEX_WIDTH = 12
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK

type Signal = 'traces' | 'logs'
type Segment = { path: string; signal: Signal; bytes: number; dev: bigint; ino: bigint }

function safeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes('..')
}

function inside(candidate: string, root: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

// Resolve symlinks in existing ancestors even when the configured directory is new.
function physicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error
    return join(physicalPath(dirname(path)), basename(path))
  }
}

type FileCopyOptions = {
  runId: string
  writerId: string
  repository: string | undefined
  repoRoot: string
  settings: ResolvedSettings
}

function runSegment(runId: string, writerId: string): string {
  const suffixBytes = Buffer.byteLength(`~${writerId}~${'0'.repeat(INDEX_WIDTH)}.traces.jsonl`)
  return safeSegment(runId) && Buffer.byteLength(runId) + suffixBytes <= MAX_COMPONENT_BYTES ? runId : 'unresolved'
}

/** The name every file of this run's local copy starts with, whichever writer wrote it. */
export function copyFilePrefix(runId: string, writerId: string): string {
  return `${runSegment(runId, writerId)}~`
}

/** The folder a repository's local copy is written to; nothing is created or checked. */
export function copyFolder(options: Pick<FileCopyOptions, 'repository' | 'repoRoot' | 'settings'>): string {
  const root = resolve(options.repoRoot)
  const physicalRoot = physicalPath(root)
  const configured = (options.settings.logs || undefined)?.folder
  const folder =
    configured && !inside(configured, root) && !inside(physicalPath(configured), physicalRoot)
      ? configured
      : join(options.settings.runtimeDir, 'logs')
  const target = join(physicalPath(resolve(folder)), repoSegment(options.repository))
  if (inside(target, physicalRoot)) throw new Error(`Log directory is inside the repository: ${target}`)
  return target
}

export function createFileExporters(options: FileCopyOptions): { spans: SpanExporter; logs: LogRecordExporter } {
  const { writerId } = options
  const suffixBytes = Buffer.byteLength(`~${writerId}~${'0'.repeat(INDEX_WIDTH)}.traces.jsonl`)
  const run = runSegment(options.runId, writerId)
  let nextIndex = 0
  let active: Segment | undefined

  function directory(): string {
    const target = copyFolder(options)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    if (!lstatSync(target).isDirectory() || realpathSync(target) !== target)
      throw new Error(`Unsafe Log directory: ${target}`)
    return target
  }

  function write(folder: string, signal: Signal, line: Buffer, previous?: Segment): void {
    const index = String(nextIndex).padStart(INDEX_WIDTH, '0')
    if (index.length > INDEX_WIDTH) throw new Error('Log file sequence exhausted')
    const path = previous?.path ?? join(folder, `${run}~${writerId}~${index}.${signal}.jsonl`)
    if (dirname(path) !== folder) throw new Error(`Log directory changed: ${path}`)
    const parent = lstatSync(folder, { bigint: true })
    if (!parent.isDirectory() || realpathSync(folder) !== folder) throw new Error(`Unsafe Log directory: ${folder}`)
    const fd = openSync(path, previous ? APPEND_FLAGS : APPEND_FLAGS | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      const stat = fstatSync(fd, { bigint: true })
      const currentParent = lstatSync(folder, { bigint: true })
      const entry = lstatSync(path, { bigint: true })
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        !currentParent.isDirectory() ||
        currentParent.dev !== parent.dev ||
        currentParent.ino !== parent.ino ||
        realpathSync(folder) !== folder ||
        entry.dev !== stat.dev ||
        entry.ino !== stat.ino ||
        (previous && (stat.dev !== previous.dev || stat.ino !== previous.ino || stat.size !== BigInt(previous.bytes)))
      ) {
        throw new Error(`Unsafe Log file: ${path}`)
      }
      // Start a new file on a signal change so filename order preserves record order.
      // An oversized record occupies one whole file, and the next record rolls over.
      if (!previous) nextIndex += 1
      // If a write fails, leave any partial line at the end of this file.
      // Later records start a new segment and retain their original sequence numbers.
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

  function append(signal: Signal, payload: Uint8Array | undefined): void {
    if (!safeSegment(writerId) || suffixBytes + 'unresolved'.length > MAX_COMPONENT_BYTES)
      throw new Error('Unsafe Log writer identifier')
    if (payload === undefined) throw new Error('OTLP JSON serializer returned no payload')
    const line = Buffer.concat([payload, Buffer.from('\n')])
    const folder = directory()
    const reuse = active?.signal === signal && active.bytes + line.length <= MAX_BYTES ? active : undefined
    write(folder, signal, line, reuse)
  }

  function exporter<Record>(signal: Signal, serialize: (records: Record[]) => Uint8Array | undefined) {
    return {
      export(records: Record[], callback: Parameters<SpanExporter['export']>[1]) {
        try {
          for (const record of records) append(signal, serialize([record]))
        } catch (error) {
          callback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) })
          return
        }
        callback({ code: 0 })
      },
      forceFlush: () => Promise.resolve(),
      shutdown: () => Promise.resolve()
    }
  }

  return {
    spans: exporter<ReadableSpan>('traces', (records) => JsonTraceSerializer.serializeRequest(records)),
    logs: exporter<ReadableLogRecord>('logs', (records) => JsonLogsSerializer.serializeRequest(records))
  }
}
