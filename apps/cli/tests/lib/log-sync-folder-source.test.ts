import { describe, expect, it } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogSink, type LogSinkDeps } from '../../src/lib/log-sink.js'
import { createFolderLogSource } from '../../src/lib/log-sync-folder-source.js'

// The folder source is proven against REAL temporary folders, written for
// the most part by the sink's own hardened append (O6) — no fake
// filesystem, so every case below exercises the exact bytes a live reader
// would see.

const REPO = { owner: 'atta-labs', repo: 'vinaya' }

const DISPATCHED = {
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100))

function sinkDeps(dir: string, issue: number, overrides: Partial<LogSinkDeps> = {}): Partial<LogSinkDeps> {
  return {
    outboxRoot: () => join(dir, 'outbox'),
    resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
    home: () => dir,
    hostname: () => 'test-host',
    cwd: () => dir,
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    env: () => ({ VINAYA_ROLE: 'developer', VINAYA_TASK: String(issue) }),
    resolveRepo: () => Promise.resolve(REPO),
    resolveBranchIssue: () => Promise.resolve(null),
    vinayaVersion: () => '0.24.1',
    stderr: () => {},
    ...overrides
  }
}

/** Writes `count` real, valid lines to the `issue`'s stream via the sink's own hardened append. */
async function writeRealLines(dir: string, issue: number, count: number): Promise<void> {
  const { log } = createLogSink(sinkDeps(dir, issue))
  for (let i = 0; i < count; i++) log(DISPATCHED)
  await flush()
}

function repoDir(dir: string): string {
  return join(dir, 'outbox', 'atta-labs-vinaya')
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'vinaya-log-sync-folder-'))
}

describe('log-sync-folder-source — stream listing (O1)', () => {
  it('lists every stream the repo folder holds and reads each from the start', async () => {
    const dir = tmpDir()
    await writeRealLines(dir, 101, 2)
    await writeRealLines(dir, 202, 3)

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page = await source.readPage(null, 100)
    expect(page.lines).toHaveLength(5)
    expect(page.gaps).toEqual([])
  })

  it("the source's id is stable for the same folder and repository", () => {
    const dir = tmpDir()
    const a = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const b = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    expect(a.id).toBe(b.id)
  })

  it('treats a work-less stream (none.ndjson) like any other (O5)', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    writeFileSync(join(repoDir(dir), 'none.ndjson'), `${JSON.stringify({ a: 1 })}\n`)

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page = await source.readPage(null, 10)
    expect(page.lines.map((l) => JSON.parse(l.raw))).toEqual([{ a: 1 }])
  })
})

describe('log-sync-folder-source — the opaque per-stream cursor (O1)', () => {
  it('a second readPage with the returned cursor reads only what is new', async () => {
    const dir = tmpDir()
    await writeRealLines(dir, 303, 2)
    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })

    const page1 = await source.readPage(null, 100)
    expect(page1.lines).toHaveLength(2)

    await writeRealLines(dir, 303, 1)
    const page2 = await source.readPage(page1.next, 100)
    expect(page2.lines).toHaveLength(1)
  })

  it('a page limit lower than the available lines is honored, and the next call resumes past exactly what was taken', async () => {
    const dir = tmpDir()
    await writeRealLines(dir, 404, 5)
    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })

    const page1 = await source.readPage(null, 2)
    expect(page1.lines).toHaveLength(2)
    const page2 = await source.readPage(page1.next, 2)
    expect(page2.lines).toHaveLength(2)
    const page3 = await source.readPage(page2.next, 2)
    expect(page3.lines).toHaveLength(1)
  })
})

describe('log-sync-folder-source — complete lines only (O2)', () => {
  it('a final line with no newline yet is left for the next run, never read and never quarantined', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const path = join(repoDir(dir), '505.ndjson')
    writeFileSync(path, `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}`) // no trailing newline

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page = await source.readPage(null, 100)
    expect(page.lines.map((l) => JSON.parse(l.raw))).toEqual([{ a: 1 }])

    // Completing the torn line makes it readable on the next run, from the
    // SAME cursor — it was never consumed as a half-written line.
    appendFileSync(path, '\n')
    const page2 = await source.readPage(page.next, 100)
    expect(page2.lines.map((l) => JSON.parse(l.raw))).toEqual([{ a: 2 }])
  })

  it('an empty stream file reports no lines and advances nothing', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    writeFileSync(join(repoDir(dir), '606.ndjson'), '')

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page = await source.readPage(null, 100)
    expect(page.lines).toEqual([])
  })
})

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function rotatedPath(dir: string, name: string): string {
  return join(repoDir(dir), `${name}.1.ndjson`)
}

function livePath(dir: string, name: string): string {
  return join(repoDir(dir), `${name}.ndjson`)
}

describe('log-sync-folder-source — rotation is followed, from the recorded offset (O3)', () => {
  it('a clean rotation reads the unread tail from the slot, then continues into the new live file', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const live = livePath(dir, '707')
    writeFileSync(live, jsonLine({ n: 1 }) + jsonLine({ n: 2 }) + jsonLine({ n: 3 }))

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 1) // consumes only { n: 1 }; cursor trails inside the still-live generation
    expect(page1.lines.map((l) => JSON.parse(l.raw))).toEqual([{ n: 1 }])

    // The generation the cursor still points into (3 lines) rotates into the
    // slot untouched; a fresh live file starts.
    renameSync(live, rotatedPath(dir, '707'))
    writeFileSync(live, jsonLine({ n: 4 }))

    const page2 = await source.readPage(page1.next, 100)
    expect(page2.lines.map((l) => JSON.parse(l.raw))).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }])
    expect(page2.gaps).toEqual([])
  })

  it('a rotation with no retained slot is a retention gap, never a silent reset', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const live = livePath(dir, '808')
    writeFileSync(live, jsonLine({ n: 1 }) + jsonLine({ n: 2 }) + jsonLine({ n: 3 }))

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 1)
    expect(page1.lines).toHaveLength(1)

    // The live file is replaced with no `.1.ndjson` ever created — a bare
    // truncation, not a rotation the sink performed.
    writeFileSync(live, jsonLine({ n: 'fresh' }))

    const page2 = await source.readPage(page1.next, 100)
    expect(page2.lines.map((l) => JSON.parse(l.raw))).toEqual([{ n: 'fresh' }])
    expect(page2.gaps).toHaveLength(1)
    expect(page2.gaps[0]?.reason).toContain('no retained slot')
    expect(page2.gaps[0]?.lost).toEqual({ known: false, reason: expect.any(String) })
  })

  it('a slot overwritten by a second rotation before this reader reached it is a retention gap with its bounds (O6)', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const live = livePath(dir, '909')
    writeFileSync(live, jsonLine({ gen: 'A', n: 1 }) + jsonLine({ gen: 'A', n: 2 }) + jsonLine({ gen: 'A', n: 3 }))

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 1) // reads gen A's first line only
    expect(page1.lines.map((l) => JSON.parse(l.raw))).toEqual([{ gen: 'A', n: 1 }])

    // Generation A rotates into the slot (its unread tail — lines 2 and 3 —
    // still sits there, never read).
    renameSync(live, rotatedPath(dir, '909'))
    writeFileSync(live, jsonLine({ gen: 'B', n: 1 }))
    // Generation B itself rotates before anything ever reads it, overwriting
    // the slot and destroying generation A's unread tail with it.
    renameSync(live, rotatedPath(dir, '909'))
    writeFileSync(live, jsonLine({ gen: 'C', n: 1 }))

    const page2 = await source.readPage(page1.next, 100)
    expect(page2.gaps).toHaveLength(1)
    expect(page2.gaps[0]?.source).toBe(source.id)
    expect(page2.gaps[0]?.from).toContain('909:')
    expect(page2.gaps[0]?.to).toBeNull()
    expect(page2.gaps[0]?.reason).toContain('overwritten by a later rotation')
    expect(page2.gaps[0]?.lost).toEqual({ known: false, reason: expect.any(String) })
    // Reading still continues into whatever is live now — the loss is
    // reported, not fatal.
    expect(page2.lines.map((l) => JSON.parse(l.raw))).toEqual([{ gen: 'C', n: 1 }])
  })
})

describe('log-sync-folder-source — the look-back read (O4)', () => {
  it('re-reads the last lines of a known stream, an edited line coming back with its new text', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const live = livePath(dir, '111')
    writeFileSync(live, jsonLine({ n: 1 }) + jsonLine({ n: 2 }) + jsonLine({ n: 3 }))

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 100)
    expect(page1.lines).toHaveLength(3)

    // A line inside the look-back window is hand-edited on disk.
    writeFileSync(live, jsonLine({ n: 1 }) + jsonLine({ n: 'EDITED' }) + jsonLine({ n: 3 }))

    const back = await source.lookback(page1.next, 2)
    expect(back.lines.map((l) => JSON.parse(l.raw))).toEqual([{ n: 'EDITED' }, { n: 3 }])
  })

  it('a stream whose file has vanished returns nothing for the identities the cache holds inside the span', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const liveA = livePath(dir, '222')
    const liveB = livePath(dir, '333')
    writeFileSync(liveA, jsonLine({ n: 1 }))
    writeFileSync(liveB, jsonLine({ n: 1 }))

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 100)
    expect(page1.lines).toHaveLength(2)

    rmSync(liveA)
    const back = await source.lookback(page1.next, 10)
    // Only the stream that still exists reports lines; the vanished one
    // reports none, rather than throwing or inventing an empty record.
    expect(back.lines.map((l) => JSON.parse(l.raw))).toEqual([{ n: 1 }])
  })

  it('does not advance the stored cursor — it is a side read, not a resumption point', async () => {
    const dir = tmpDir()
    await writeRealLines(dir, 444, 2)
    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 100)
    const back = await source.lookback(page1.next, 1)
    expect(back.next).toBe(page1.next)
  })
})

describe('log-sync-folder-source — refuses a symlink or a non-regular file (O5)', () => {
  it('never follows a symlinked stream — it is excluded from the listing entirely', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const elsewhere = join(dir, 'elsewhere.ndjson')
    writeFileSync(elsewhere, jsonLine({ secret: true }))
    symlinkSync(elsewhere, livePath(dir, '555'))

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page = await source.readPage(null, 100)
    expect(page.lines).toEqual([])
  })

  it('refuses a rotated slot that is a symlink, reporting the gap rather than following it', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    const live = livePath(dir, '666')
    writeFileSync(live, jsonLine({ n: 1 }) + jsonLine({ n: 2 }))

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 1)
    expect(page1.lines).toHaveLength(1)

    const elsewhere = join(dir, 'elsewhere-2.ndjson')
    writeFileSync(elsewhere, jsonLine({ secret: true }))
    renameSync(live, join(dir, 'moved-aside.ndjson')) // keep the real unread tail off to the side, unread
    symlinkSync(elsewhere, rotatedPath(dir, '666'))
    writeFileSync(live, jsonLine({ n: 'fresh' }))

    const page2 = await source.readPage(page1.next, 100)
    expect(page2.gaps).toHaveLength(1)
    expect(page2.lines.map((l) => JSON.parse(l.raw))).toEqual([{ n: 'fresh' }])
  })

  it('a non-regular entry named like a stream (a directory) is skipped, not read', async () => {
    const dir = tmpDir()
    mkdirSync(repoDir(dir), { recursive: true })
    mkdirSync(livePath(dir, '777')) // a directory at the stream's own path

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page = await source.readPage(null, 100)
    expect(page.lines).toEqual([])
  })
})

describe('log-sync-folder-source — proven against real folders (O6)', () => {
  it('a deleted stream file reports nothing and never throws — readPage, not only look-back', async () => {
    const dir = tmpDir()
    await writeRealLines(dir, 999, 2)
    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page1 = await source.readPage(null, 1)
    expect(page1.lines).toHaveLength(1)

    rmSync(livePath(dir, '999'))

    const page2 = await source.readPage(page1.next, 100)
    expect(page2.lines).toEqual([])
    expect(page2.gaps).toEqual([])
  })

  it("reads only the repository's own folder — a foreign repository's streams are never touched (O5, O6)", async () => {
    const dir = tmpDir()
    const foreign = { owner: 'other-corp', repo: 'other-repo' }
    await writeRealLines(dir, 1, 2) // atta-labs/vinaya, via REPO's own resolveRepo
    const { log: foreignLog } = createLogSink(sinkDeps(dir, 1, { resolveRepo: () => Promise.resolve(foreign) }))
    foreignLog(DISPATCHED)
    foreignLog(DISPATCHED)
    await flush()

    const foreignDir = join(dir, 'outbox', 'other-corp-other-repo')
    const before = readFileSync(join(foreignDir, '1.ndjson'), 'utf8')

    const source = createFolderLogSource({ folderRoot: join(dir, 'outbox'), repo: REPO })
    const page = await source.readPage(null, 100)
    expect(page.lines).toHaveLength(2) // only this repo's own two lines

    // The foreign repository's own file is exactly as it was — never opened
    // for write, renamed or truncated by a source scoped to a different repo.
    expect(readFileSync(join(foreignDir, '1.ndjson'), 'utf8')).toBe(before)
  })
})
