/**
 * The folder source (`apps/cli/specs/log-sync.md`): the effects-layer
 * adapter that reads a log folder's streams over the layout the sink itself
 * writes — `<folder>/<owner>-<repo>/<work>.ndjson`, rotated once at 8 MiB
 * into a single overwritten `<work>.1.ndjson` slot (`log-sink.ts`). The
 * `LogSource` contract itself (`@attalabs/aeg-core`) is pure policy and
 * stays untouched; this file is the one place that opens a file descriptor
 * for it. The repository folder's own name is derived from the sink's own
 * exported `outboxPathFor`, never re-derived, so this source can never drift
 * from how the sink names a stream.
 *
 * The cursor this source hands the engine is opaque JSON: a map from stream
 * name (the file's basename without `.ndjson`) to the byte offset read so
 * far into what is, at rest, the LIVE file, plus a sha256 fingerprint of
 * that live file's first complete line — the only way to tell a rotation
 * from a truncation once the same byte offset can name different bytes
 * (`apps/cli/specs/log-sync.md`, "The hard cases").
 */

import { createHash } from 'node:crypto'
import { constants as fsConstants, closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  unknownBecause,
  type LogSource,
  type SourceCursor,
  type SourceGap,
  type SourceLine,
  type SourcePage
} from '@attalabs/aeg-core'
import { outboxPathFor } from './log-sink.js'

const ROTATED_SUFFIX = '.1.ndjson'
const LIVE_SUFFIX = '.ndjson'

/** One stream's read position: the live file's own byte offset, and a fingerprint of its first complete line — `null` while that line is still unread or the stream is empty. */
type StreamCursorState = {
  offset: number
  firstLineFingerprint: string | null
}

type FolderCursorState = Record<string, StreamCursorState>

/** The folder source's own extension over `LogSource` (O4): a bounded re-read of each known stream's current tail, independent of `readPage`'s own cursor. */
export interface FolderLogSource extends LogSource {
  readPage(cursor: SourceCursor | null, limit: number): Promise<SourcePage>
  /** Re-reads the last `span` complete lines of each stream the cursor already knows, with their CURRENT content — an edited line comes back edited, a vanished file returns nothing for it. */
  lookback(cursor: SourceCursor | null, span: number): Promise<SourcePage>
}

export type FolderSourceDeps = {
  /** The resolved `logs.folder` root — the same value `log()` itself appends under. */
  folderRoot: string
  repo: { owner: string; repo: string } | null
}

function parseCursor(cursor: SourceCursor | null): FolderCursorState {
  if (cursor === null) return {}
  try {
    const parsed = JSON.parse(cursor) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as FolderCursorState) : {}
  } catch {
    return {}
  }
}

function serializeCursor(state: FolderCursorState): SourceCursor {
  return JSON.stringify(state)
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The one repository folder this source is scoped to — the directory half of `outboxPathFor`'s own layout, never re-derived (O5). */
function repoDirFor(deps: FolderSourceDeps): string {
  return dirname(outboxPathFor({ outboxRoot: () => deps.folderRoot }, deps.repo, null))
}

/**
 * The size of `path`, refusing a symlink (`O_NOFOLLOW`, atomic — no separate
 * `lstat`-then-open race) and anything that is not, once open, a regular
 * file (O5). `null` on any refusal or a missing path — never throws, since a
 * hand-edited or vanished file is an ordinary case for a reader racing a
 * live writer and a human operator, not an error. Always closes its own
 * descriptor.
 */
function regularFileSize(path: string): number | null {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const stat = fstatSync(fd)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** Reads `[from, to)` of `path`, under the same refusal rules as {@link regularFileSize}. `null` when the file cannot be read as a regular file. */
function readRangeOf(path: string, from: number, to: number): string | null {
  if (to <= from) return ''
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    if (!fstatSync(fd).isFile()) return null
    const length = to - from
    const buffer = Buffer.alloc(length)
    let readTotal = 0
    while (readTotal < length) {
      const n = readSync(fd, buffer, readTotal, length - readTotal, from + readTotal)
      if (n === 0) break
      readTotal += n
    }
    return buffer.toString('utf8', 0, readTotal)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** One complete line read from a stream file, with the byte range it occupied (newline included) so a caller can advance its offset exactly. */
type CompleteLine = { text: string; startByte: number; endByte: number }

/**
 * Splits `content` (read starting at file byte `baseOffset`) into complete
 * lines — a line with no trailing `\n` yet is the torn tail and is never
 * returned (O2): the sink's append writes a line and its newline in one
 * write, but a reader can still observe a partial one while the writer is
 * mid-write.
 */
function completeLinesOf(content: string, baseOffset: number): CompleteLine[] {
  const lines: CompleteLine[] = []
  let consumed = 0
  for (;;) {
    const newlineAt = content.indexOf('\n', consumed)
    if (newlineAt === -1) break
    lines.push({
      text: content.slice(consumed, newlineAt),
      startByte: baseOffset + consumed,
      endByte: baseOffset + newlineAt + 1
    })
    consumed = newlineAt + 1
  }
  return lines
}

/** Reads at most `maxLines` complete lines of `path` starting at byte `offset`, and the new offset to resume from. `null` when the file cannot be opened/is not regular (O5). */
function readCompleteLinesFrom(
  path: string,
  offset: number,
  maxLines: number
): { lines: CompleteLine[]; newOffset: number; size: number } | null {
  const size = regularFileSize(path)
  if (size === null) return null
  const safeOffset = Math.min(offset, size)
  const content = readRangeOf(path, safeOffset, size)
  if (content === null) return null
  const all = completeLinesOf(content, safeOffset)
  const taken = all.slice(0, Math.max(0, maxLines))
  const newOffset = taken.length > 0 ? (taken[taken.length - 1] as CompleteLine).endByte : safeOffset
  return { lines: taken, newOffset, size }
}

/** The sha256 of `path`'s first complete line, or `null` when it has none yet (missing file, empty file, or an unterminated first line). */
function firstLineFingerprintOf(path: string): string | null {
  const read = readCompleteLinesFrom(path, 0, 1)
  if (read === null || read.lines.length === 0) return null
  return sha256((read.lines[0] as CompleteLine).text)
}

/** Every live stream name the folder currently holds — the file's basename with `.ndjson` stripped, `.1.ndjson` rotation slots excluded (O1). Symlinked or non-regular entries are refused, never listed (O5). */
function listLiveStreamNames(repoDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(repoDir)
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith(LIVE_SUFFIX) || entry.endsWith(ROTATED_SUFFIX)) continue
    if (regularFileSize(join(repoDir, entry)) === null) continue
    names.push(entry.slice(0, -LIVE_SUFFIX.length))
  }
  return names
}

function livePathFor(repoDir: string, name: string): string {
  return join(repoDir, `${name}${LIVE_SUFFIX}`)
}

function rotatedPathFor(repoDir: string, name: string): string {
  return join(repoDir, `${name}${ROTATED_SUFFIX}`)
}

export function createFolderLogSource(deps: FolderSourceDeps): FolderLogSource {
  const repoDir = repoDirFor(deps)
  const id = `folder:${repoDir}`

  /** One stream's share of one `readPage` call. */
  function readStream(
    name: string,
    state: StreamCursorState,
    remaining: number
  ): { lines: SourceLine[]; gap: SourceGap | null; next: StreamCursorState } {
    const livePath = livePathFor(repoDir, name)
    const rotatedPath = rotatedPathFor(repoDir, name)
    const liveSize = regularFileSize(livePath)

    if (liveSize === null) {
      // The live file is gone or unreadable — nothing new for this pass.
      // The cursor is left exactly as it was: a reader that comes back once
      // the file exists again resumes from there.
      return { lines: [], gap: null, next: state }
    }

    const liveFirstLineFingerprint = firstLineFingerprintOf(livePath)
    const rotated =
      liveSize < state.offset ||
      (state.firstLineFingerprint !== null &&
        liveFirstLineFingerprint !== null &&
        liveFirstLineFingerprint !== state.firstLineFingerprint)

    const lines: SourceLine[] = []
    let gap: SourceGap | null = null
    let liveStartOffset = state.offset

    if (rotated) {
      const rotatedFirstLineFingerprint = firstLineFingerprintOf(rotatedPath)
      const slotHoldsOurTail =
        rotatedFirstLineFingerprint !== null &&
        state.firstLineFingerprint !== null &&
        rotatedFirstLineFingerprint === state.firstLineFingerprint

      if (slotHoldsOurTail) {
        const read = readCompleteLinesFrom(rotatedPath, state.offset, Number.POSITIVE_INFINITY)
        if (read !== null) {
          for (const line of read.lines) lines.push({ raw: line.text, position: `${name}:rotated:${line.startByte}` })
        }
      } else {
        gap = {
          source: id,
          from: `${name}:${state.offset}`,
          to: null,
          reason:
            rotatedFirstLineFingerprint === null
              ? 'the stream rotated with no retained slot to recover its unread tail from'
              : 'the rotated slot was overwritten by a later rotation before this reader reached it',
          lost: unknownBecause('the overwritten bytes are gone; only the sink could have counted them at rotation time')
        }
      }
      liveStartOffset = 0
    }

    const remainingForLive = remaining - lines.length
    if (remainingForLive > 0) {
      const liveRead = readCompleteLinesFrom(livePath, liveStartOffset, remainingForLive)
      if (liveRead !== null) {
        for (const line of liveRead.lines) lines.push({ raw: line.text, position: `${name}:live:${line.startByte}` })
        const fingerprint = rotated
          ? (firstLineFingerprintOf(livePath) ?? null)
          : (state.firstLineFingerprint ?? firstLineFingerprintOf(livePath))
        return { lines, gap, next: { offset: liveRead.newOffset, firstLineFingerprint: fingerprint } }
      }
    }

    const fingerprint = rotated ? liveFirstLineFingerprint : state.firstLineFingerprint
    return { lines, gap, next: { offset: liveStartOffset, firstLineFingerprint: fingerprint } }
  }

  function readPage(cursor: SourceCursor | null, limit: number): Promise<SourcePage> {
    const state = parseCursor(cursor)
    const names = [...new Set([...Object.keys(state), ...listLiveStreamNames(repoDir)])].sort()

    const nextState: FolderCursorState = { ...state }
    const lines: SourceLine[] = []
    const gaps: SourceGap[] = []
    let remaining = limit

    for (const name of names) {
      if (remaining <= 0) break
      const streamState = state[name] ?? { offset: 0, firstLineFingerprint: null }
      const result = readStream(name, streamState, remaining)
      nextState[name] = result.next
      if (result.gap !== null) gaps.push(result.gap)
      for (const line of result.lines) lines.push(line)
      remaining -= result.lines.length
    }

    return Promise.resolve({ lines, next: serializeCursor(nextState), gaps })
  }

  function lookback(cursor: SourceCursor | null, span: number): Promise<SourcePage> {
    const state = parseCursor(cursor)
    const names = [...new Set([...Object.keys(state), ...listLiveStreamNames(repoDir)])].sort()
    const lines: SourceLine[] = []

    for (const name of names) {
      const livePath = livePathFor(repoDir, name)
      const size = regularFileSize(livePath)
      if (size === null) continue // a vanished stream returns nothing for its identities (O4)
      const content = readRangeOf(livePath, 0, size)
      if (content === null) continue
      const all = completeLinesOf(content, 0)
      const tail = all.slice(Math.max(0, all.length - span))
      for (const line of tail) lines.push({ raw: line.text, position: `${name}:live:${line.startByte}` })
    }

    return Promise.resolve({ lines, next: cursor, gaps: [] })
  }

  return { id, readPage, lookback }
}
