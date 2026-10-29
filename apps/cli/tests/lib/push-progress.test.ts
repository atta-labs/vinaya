import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendProgressBytes,
  appendProgressRecord,
  BunProgressParser,
  containedProgressDir,
  copyCaptureTail,
  type FileProgress,
  PROGRESS_SUMMARY_INTERVAL_MS,
  ProgressReader,
  progressMarkerText,
  resolveProgressDir,
  TestRunTally,
  testFileLine,
  testSummaryLine
} from '../../src/lib/push-progress'

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'push-progress')
const HEADER_THEN_LONG = readFileSync(join(FIXTURES, 'bun-output-header-then-long-test.log'), 'utf8')
const ABORTED = readFileSync(join(FIXTURES, 'bun-output-aborted-final-file.log'), 'utf8')

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'push-progress-'))
})
afterEach(() => {
  chmodSync(base, 0o700)
  rmSync(base, { recursive: true, force: true })
})

/** A runtime directory holding task 7's run directory and its progress directory. */
function runtimeWithProgress(): { runtime: string; dir: string } {
  const runtime = join(base, 'runtime')
  const dir = join(runtime, 'engine-runs', '7', 'progress')
  mkdirSync(dir, { recursive: true })
  return { runtime, dir }
}

describe('the closed-block rule', () => {
  it('a header followed by a long-running test is not complete until the next header or the summary', () => {
    const parser = new BunProgressParser()
    const closed = parser.feed(HEADER_THEN_LONG)
    // The fast file closed when the slow file's header arrived; the slow file is still open.
    expect(closed).toEqual([{ file: 'tests/fast.test.ts', outcome: 'pass', firstFailure: null, ms: 3 }])
    expect(parser.feed('(pass) slow second [5.00ms]\n')).toEqual([])
    expect(parser.feed('\n 4 pass\n 0 fail\nRan 4 tests across 2 files. [20.00ms]\n')).toEqual([
      { file: 'tests/slow.test.ts', outcome: 'pass', firstFailure: null, ms: 8 }
    ])
  })

  it('a line split across two chunks is read once it is whole', () => {
    const parser = new BunProgressParser()
    expect(parser.feed('tests/a.test.ts:\n(fail) breaks [1.0')).toEqual([])
    expect(parser.feed('0ms]\nRan 1 test across 1 file. [2.00ms]\n')).toEqual([
      { file: 'tests/a.test.ts', outcome: 'fail', firstFailure: 'breaks', ms: 1 }
    ])
  })

  it('an aborted final file reads interrupted, with an unknown outcome', () => {
    const parser = new BunProgressParser()
    const closed = [...parser.feed(ABORTED), ...parser.end()]
    expect(closed).toEqual([
      { file: 'tests/first.test.ts', outcome: 'fail', firstFailure: 'first breaks', ms: 10 },
      { file: 'tests/aborted.test.ts', outcome: 'interrupted' }
    ])
    expect(testFileLine(closed[1] as FileProgress, null)).toBe(
      'test progress: tests/aborted.test.ts interrupted — outcome unknown'
    )
  })
})

describe('the wording', () => {
  const pass: FileProgress = { file: 'tests/a.test.ts', outcome: 'pass', firstFailure: null, ms: 1500 }
  const fail: FileProgress = { file: 'tests/b.test.ts', outcome: 'fail', firstFailure: 'it breaks', ms: 250 }

  it('a known total gives each file its N/M, and the 60-second line an estimate for the files left', () => {
    const tally = new TestRunTally(4)
    tally.add(pass)
    expect(testFileLine(pass, tally.position)).toBe('test progress: 1/4 tests/a.test.ts ✓, 1.5 s')
    tally.add(fail)
    expect(testFileLine(fail, tally.position)).toBe(
      'test progress: 2/4 tests/b.test.ts ✗, 250 ms — first failing test: it breaks'
    )
    expect(testSummaryLine(tally)).toBe(
      'test progress: 2/4 files done, 1 failing, 0.9 s per file, about 1.8 s left for 2 files'
    )
  })

  it('no total means no N/M and no estimate', () => {
    const tally = new TestRunTally(null)
    tally.add(pass)
    expect(testFileLine(pass, tally.position)).toBe('test progress: 1 tests/a.test.ts ✓, 1.5 s')
    expect(testSummaryLine(tally)).toBe('test progress: 1 files done, 0 failing, 1.5 s per file')
  })
})

describe('the reader', () => {
  it('writes each closed file as it appears, and the 60-second line only while the run is open', () => {
    const { dir } = runtimeWithProgress()
    let now = 1_000
    const lines: string[] = []
    const reader = new ProgressReader(
      dir,
      (line) => lines.push(line),
      () => now
    )
    appendProgressRecord(dir, 'tests-1.ndjson', {
      v: 1,
      kind: 'tests-start',
      stream: 'tests-1',
      total: 3,
      label: 'selected tests'
    })
    appendProgressBytes(dir, 'tests-1.out', HEADER_THEN_LONG)
    reader.scan()
    reader.tick()
    expect(lines).toEqual(['test progress: 1/3 tests/fast.test.ts ✓, 3 ms'])
    now += PROGRESS_SUMMARY_INTERVAL_MS
    reader.tick()
    expect(lines.at(-1)).toBe('test progress: 1/3 files done, 0 failing, 0.0 s per file, about 6 ms left for 2 files')
    appendProgressRecord(dir, 'tests-1.ndjson', { v: 1, kind: 'tests-end', stream: 'tests-1' })
    reader.scan()
    expect(lines.at(-1)).toBe('test progress: tests/slow.test.ts interrupted — outcome unknown')
    const count = lines.length
    now += 2 * PROGRESS_SUMMARY_INTERVAL_MS
    reader.tick()
    expect(lines).toHaveLength(count)
  })

  it('reads a copy to its end before an end record that landed first, so no closed file is lost', () => {
    const { dir } = runtimeWithProgress()
    const lines: string[] = []
    const reader = new ProgressReader(dir, (line) => lines.push(line))
    appendProgressBytes(dir, 'tests-2.out', 'tests/a.test.ts:\n(pass) one [1.00ms]\n')
    reader.scan()
    // The rest of the copy and its end record land between two scans.
    appendProgressBytes(dir, 'tests-2.out', '\ntests/b.test.ts:\n(pass) two [1.00ms]\nRan 2 tests across 2 files.\n')
    appendProgressRecord(dir, 'tests-2.ndjson', { v: 1, kind: 'tests-end', stream: 'tests-2' })
    reader.scan()
    expect(lines).toEqual(['test progress: 1 tests/a.test.ts ✓, 1 ms', 'test progress: 2 tests/b.test.ts ✓, 1 ms'])
  })
})

describe('the reserved progress directory', () => {
  const alive = () => true
  const marker = (task: number, expiresAt = new Date(Date.now() + 60_000).toISOString()) =>
    progressMarkerText({ task, driver: { pid: 1, startTime: 'x' }, expiresAt })

  it('resolves only beneath the runtime directory the writer resolved, for the marked task', () => {
    const { runtime, dir } = runtimeWithProgress()
    const deps = { runtimeDir: () => runtime, isDriverAlive: alive, now: () => Date.now() }
    expect(resolveProgressDir({ ...deps, readMarker: () => marker(7) })).toBe(containedProgressDir(runtime, 7))
    expect(containedProgressDir(runtime, 7)?.endsWith(join('engine-runs', '7', 'progress'))).toBe(true)
    expect(dir.endsWith(join('engine-runs', '7', 'progress'))).toBe(true)
  })

  it('a forged, expired or dead-driver marker resolves nothing', () => {
    const { runtime } = runtimeWithProgress()
    const deps = { runtimeDir: () => runtime, now: () => Date.now() }
    expect(resolveProgressDir({ ...deps, isDriverAlive: alive, readMarker: () => marker(8) })).toBeNull()
    expect(
      resolveProgressDir({ ...deps, isDriverAlive: alive, readMarker: () => '{"version":1,"task":"../7"}' })
    ).toBeNull()
    expect(
      resolveProgressDir({ ...deps, isDriverAlive: alive, readMarker: () => marker(7, '2000-01-01T00:00:00Z') })
    ).toBeNull()
    expect(resolveProgressDir({ ...deps, isDriverAlive: () => false, readMarker: () => marker(7) })).toBeNull()
    expect(resolveProgressDir({ ...deps, isDriverAlive: alive, readMarker: () => null })).toBeNull()
  })

  it('a symlinked parent is refused like a symlinked leaf', () => {
    const runtime = join(base, 'runtime')
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(join(elsewhere, 'progress'), { recursive: true })
    mkdirSync(join(runtime, 'engine-runs'), { recursive: true })
    symlinkSync(elsewhere, join(runtime, 'engine-runs', '7'))
    expect(containedProgressDir(runtime, 7)).toBeNull()

    const other = join(base, 'runtime-2')
    mkdirSync(join(other, 'engine-runs', '7'), { recursive: true })
    symlinkSync(join(elsewhere, 'progress'), join(other, 'engine-runs', '7', 'progress'))
    expect(containedProgressDir(other, 7)).toBeNull()
  })

  it('a symlinked record file is never written through, and an unwritable sink discards progress', () => {
    const { dir } = runtimeWithProgress()
    const target = join(base, 'target.txt')
    writeFileSync(target, 'untouched\n')
    symlinkSync(target, join(dir, 'checks-1.ndjson'))
    expect(
      appendProgressRecord(dir, 'checks-1.ndjson', { v: 1, kind: 'check', name: 'lint', outcome: 'pass', ms: 1 })
    ).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('untouched\n')
    expect(appendProgressRecord(dir, '../escape.ndjson', { v: 1, kind: 'commands-start', count: 1 })).toBe(false)

    chmodSync(dir, 0o500)
    try {
      expect(appendProgressRecord(dir, 'checks-2.ndjson', { v: 1, kind: 'commands-start', count: 1 })).toBe(false)
      const capture = join(base, 'capture.log')
      writeFileSync(capture, 'tests/a.test.ts:\n')
      expect(copyCaptureTail({ capture, dir, stream: 'tests-1', deadline: Date.now() + 1000 })).toBe(false)
      // The capture itself is only ever read.
      expect(readFileSync(capture, 'utf8')).toBe('tests/a.test.ts:\n')
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})

describe('the copy', () => {
  it('is a byte prefix of the capture, continued from its own size, up to the capture end', () => {
    const { dir } = runtimeWithProgress()
    const capture = join(base, 'capture.log')
    writeFileSync(capture, 'first\n')
    expect(copyCaptureTail({ capture, dir, stream: 'tests-1', deadline: Date.now() + 1000 })).toBe(true)
    writeFileSync(capture, 'first\nsecond\n')
    expect(copyCaptureTail({ capture, dir, stream: 'tests-1', deadline: Date.now() + 1000 })).toBe(true)
    expect(readFileSync(join(dir, 'tests-1.out'), 'utf8')).toBe('first\nsecond\n')
    expect(copyCaptureTail({ capture, dir, stream: '../x', deadline: Date.now() + 1000 })).toBe(false)
  })
})
