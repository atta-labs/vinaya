import { describe, expect, it } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
