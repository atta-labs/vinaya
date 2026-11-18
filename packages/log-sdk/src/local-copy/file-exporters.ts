import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { repoSegment, type ResolvedSettings } from '../writer/settings.js'

const MAX_BYTES = 8 * 1024 * 1024
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

export function createFileExporters(options: FileCopyOptions): { spans: SpanExporter; logs: LogRecordExporter } {
  const { writerId, settings } = options
  const run = safeSegment(options.runId) ? options.runId : 'unresolved'
  const repository = repoSegment(options.repository)
  let nextIndex = 0
  let active: Segment | undefined

  function directory(): string {
    const root = resolve(options.repoRoot)
    const physicalRoot = physicalPath(root)
    const configured = (settings.logs || undefined)?.folder
    const folder =
      configured && !inside(configured, root) && !inside(physicalPath(configured), physicalRoot)
        ? configured
        : join(settings.runtimeDir, 'logs')
    const target = join(physicalPath(resolve(folder)), repository)
    if (inside(target, physicalRoot)) throw new Error(`Log directory is inside the repository: ${target}`)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    if (!lstatSync(target).isDirectory() || realpathSync(target) !== target)
      throw new Error(`Unsafe Log directory: ${target}`)
    return target
  }

  function append(signal: Signal, payload: Uint8Array | undefined): void {
    if (!safeSegment(writerId)) throw new Error('Unsafe Log writer identifier')
    if (payload === undefined) throw new Error('OTLP JSON serializer returned no payload')
    const line = Buffer.concat([payload, Buffer.from('\n')])
    const folder = directory()
    const previous = active
    const reuse = previous !== undefined && previous.signal === signal && previous.bytes + line.length <= MAX_BYTES
    const index = String(nextIndex).padStart(12, '0')
    const path = reuse ? previous.path : join(folder, `${run}~${writerId}~${index}.${signal}.jsonl`)
    if (dirname(path) !== folder) throw new Error(`Log directory changed: ${path}`)
    const fd = openSync(path, reuse ? APPEND_FLAGS : APPEND_FLAGS | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      const stat = fstatSync(fd, { bigint: true })
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        (reuse && (stat.dev !== previous.dev || stat.ino !== previous.ino || stat.size !== BigInt(previous.bytes)))
      ) {
        throw new Error(`Unsafe Log file: ${path}`)
      }
      // Start a new file on a signal change so filename order preserves record order.
      // An oversized record occupies one whole file, and the next record rolls over.
      if (!reuse) nextIndex += 1
      active = undefined
      writeFileSync(fd, line)
      active = { path, signal, bytes: Number(stat.size) + line.length, dev: stat.dev, ino: stat.ino }
    } finally {
      closeSync(fd)
    }
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
