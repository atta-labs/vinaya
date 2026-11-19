import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createLineReader } from './lines.js'
import type { OtelRecord } from './records.js'
import type { RecordSource, SourceProblem } from './source.js'

const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const NEWLINE = 0x0a

export type FolderSourceOptions = {
  /** The Log folder holding the local copy's files. */
  folder: string
  /** The run whose files are read. */
  runId: string
  name?: string
  /** Defaults to `false`: the local copy is the SDK's own. */
  foreign?: boolean
  home?: string
  /** Runs after the folder is listed and before any file is opened; a test's way to let a writer move in between. */
  afterListing?: () => void | Promise<void>
  /** The caller already resolved the folder and expects it to remain at this path. */
  canonicalFolder?: boolean
}

/** A writer's place: the index of the file it was reading and the byte offset after the last whole line read there. */
type Place = readonly [index: number, offset: number]

function runSegment(runId: string): string {
  return SAFE_SEGMENT.test(runId) && !runId.includes('..') ? runId : 'unresolved'
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readPosition(position: string | undefined): Map<string, Place> {
  const places = new Map<string, Place>()
  if (position === undefined) return places
  try {
    const parsed: unknown = JSON.parse(position)
    const writers = (parsed as { w?: Record<string, unknown> } | null)?.w
    if (writers === undefined || writers === null || typeof writers !== 'object') return places
    for (const [writer, place] of Object.entries(writers)) {
      if (
        Array.isArray(place) &&
        Number.isInteger(place[0]) &&
        Number.isInteger(place[1]) &&
        place[0] >= 0 &&
        place[1] >= 0
      )
        places.set(writer, [place[0], place[1]])
    }
  } catch {
    // An unreadable position reads from the start.
  }
  return places
}

function writePosition(places: Map<string, Place>): string {
  const w: Record<string, Place> = {}
  for (const writer of [...places.keys()].sort()) w[writer] = places.get(writer) as Place
  return JSON.stringify({ v: 1, w })
}

type Segment = { writer: string; index: number; file: string }

async function bytesFrom(path: string, offset: number): Promise<{ bytes: Buffer; size: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || (await realpath(path)) !== path) {
      throw new Error('Unsafe local Log segment')
    }
    const entry = await lstat(path, { bigint: true })
    if (entry.dev !== stat.dev || entry.ino !== stat.ino || (await realpath(path)) !== path) {
      throw new Error('Local Log segment changed while opening')
    }
    const size = Number(stat.size)
    if (size <= offset) return { bytes: Buffer.alloc(0), size }
    const bytes = Buffer.alloc(size - offset)
    let filled = 0
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, offset + filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    return { bytes: bytes.subarray(0, filled), size }
  } finally {
    await handle.close()
  }
}

/**
 * A run's local copy in a Log folder, read without changing anything in it.
 *
 * The writer of each process appends to files named
 * `<run>~<writer>~<index>.<signal>.jsonl`, moving to the next index when the
 * signal changes, when a file is full or after a failed write. The source
 * keeps one place per writer, the index of the file it was reading and the
 * byte offset after the last whole line it read there, so a poll reads on
 * from there: the rest of that file, then every later file of the writer, and
 * never a line twice. A last line without its newline is left unread until
 * the writer finishes it; when the writer has moved on to a later file the
 * line is abandoned and reported. A numbered file that is missing is reported.
 */
export function createFolderSource(options: FolderSourceOptions): RecordSource {
  const name = options.name ?? `local copy of ${options.runId}`
  const lines = createLineReader(name, options.home === undefined ? {} : { home: options.home })
  const pattern = new RegExp(
    `^${escaped(runSegment(options.runId))}~([A-Za-z0-9._-]+)~(\\d{12})\\.(?:traces|logs)\\.jsonl$`
  )

  async function segments(): Promise<Map<string, Segment[]>> {
    let names: string[]
    try {
      names = await readdir(options.folder)
    } catch {
      return new Map()
    }
    const byWriter = new Map<string, Segment[]>()
    for (const file of names) {
      const match = pattern.exec(file)
      if (match === null) continue
      const writer = match[1] as string
      const list = byWriter.get(writer) ?? []
      list.push({ writer, index: Number(match[2]), file })
      byWriter.set(writer, list)
    }
    for (const list of byWriter.values()) list.sort((a, b) => a.index - b.index)
    return byWriter
  }

  return {
    name,
    foreign: options.foreign ?? false,
    async read(position) {
      const places = readPosition(position)
      const records: OtelRecord[] = []
      const problems: SourceProblem[] = []
      const folder = options.canonicalFolder
        ? options.folder
        : await realpath(options.folder).catch(() => options.folder)
      const byWriter = await segments()
      await options.afterListing?.()

      for (const writer of [...byWriter.keys()].sort()) {
        const list = byWriter.get(writer) as Segment[]
        const last = list[list.length - 1] as Segment
        const place = places.get(writer)
        let expected = place === undefined ? 0 : place[0] + 1
        for (const segment of list) {
          if (place !== undefined && segment.index < place[0]) continue
          const current = place !== undefined && segment.index === place[0]
          if (!current) {
            if (segment.index > expected) {
              problems.push({
                kind: 'file_missing',
                writerId: writer,
                place: `writer ${writer} files ${expected}${segment.index - 1 > expected ? `–${segment.index - 1}` : ''}`,
                detail: `the files of writer ${writer} numbered before ${segment.index} are gone from the folder`
              })
            }
            expected = segment.index + 1
          }
          const path = join(folder, segment.file)
          const offset = place !== undefined && segment.index === place[0] ? place[1] : 0
          let read: { bytes: Buffer; size: number }
          try {
            read = await bytesFrom(path, offset)
          } catch {
            problems.push({
              kind: 'file_missing',
              writerId: writer,
              place: segment.file,
              detail: `${segment.file} was listed but could not be read`
            })
            // Keep the offset already read when this is the file being read on.
            if (!(place !== undefined && segment.index === place[0])) places.set(writer, [segment.index, 0])
            continue
          }
          const { bytes } = read
          let consumed = 0
          let start = 0
          for (;;) {
            const end = bytes.indexOf(NEWLINE, start)
            if (end === -1) break
            const text = bytes.subarray(start, end).toString('utf8').trim()
            if (text !== '') {
              const result = lines.readLine(text)
              records.push(...result.records)
              if (result.problem !== null) {
                problems.push({
                  kind: 'unreadable_line',
                  writerId: writer,
                  place: `${segment.file}@${offset + start}`,
                  detail: result.problem.detail
                })
              }
            }
            start = end + 1
            consumed = start
          }
          if (start < bytes.length && segment !== last) {
            // The writer finished this file with a half-written line and went on in a later one.
            problems.push({
              kind: 'unreadable_line',
              writerId: writer,
              place: `${segment.file}@${offset + start}`,
              detail: 'a last line was left half-written and the writer continued in a later file'
            })
            consumed = bytes.length
          }
          places.set(writer, [segment.index, offset + consumed])
        }
      }
      return { records, problems, position: writePosition(places) }
    }
  }
}
