import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendProgressBytes,
  appendProgressRecord,
  BunProgressParser,
  checkLine,
  plainText,
  containedProgressDir,
  copyCaptureTail,
  type FileProgress,
  PROGRESS_SUMMARY_INTERVAL_MS,
  ProgressReader,
  progressMarkerText,
  resolveProgressDir,
  TestOutputParser,
  TestRunTally,
  testFileLine,
  testGroupEndLine,
  testGroupStartLine,
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

  it('the end-of-run failure recap closes the last file and is never counted against it', () => {
    // An earlier file failed, the last one passed, then Bun repeats every failure under its recap line.
    const output = [
      'tests/first.test.ts:',
      '(fail) first breaks [6.00ms]',
      '',
      'tests/last.test.ts:',
      '(pass) last one [2.00ms]',
      '',
      '1 tests failed:',
      '(fail) first breaks [6.00ms]',
      '',
      ' 1 pass',
      ' 1 fail',
      'Ran 2 tests across 2 files. [20.00ms]',
      ''
    ].join('\n')
    const parser = new BunProgressParser()
    const closed = [...parser.feed(output), ...parser.end()]
    expect(closed).toEqual([
      { file: 'tests/first.test.ts', outcome: 'fail', firstFailure: 'first breaks', ms: 6 },
      { file: 'tests/last.test.ts', outcome: 'pass', firstFailure: null, ms: 2 }
    ])
    const tally = new TestRunTally(2)
    for (const file of closed) tally.add(file)
    expect(tally.failed).toBe(1)
  })
})

describe('names from a test run never carry control characters into the driver log', () => {
  it('escape sequences, carriage returns and newlines become spaces', () => {
    const esc = String.fromCharCode(27)
    const bell = String.fromCharCode(7)
    const file: FileProgress = {
      file: `tests/${esc}[2Ja.test.ts`,
      outcome: 'fail',
      firstFailure: `breaks${String.fromCharCode(13)}${esc}]0;title${bell}\nforged line`,
      ms: 1
    }
    const line = testFileLine(file, '1/1')
    expect(line).toBe(
      'test progress: 1/1 tests/ [2Ja.test.ts ✗, 1 ms — first failing test: breaks  ]0;title  forged line'
    )
    expect(checkLine(`lint${esc}[31m`, 'pass', 1)).toBe('push progress: check lint [31m ✓, 1 ms')
    expect(plainText(`a${String.fromCharCode(0x9b)}b`)).toBe('a b')
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

describe('a run of native runner groups', () => {
  const bunStart = testGroupStartLine({
    group: 'cli@default',
    runner: 'bun',
    cwd: 'apps/cli',
    tests: ['apps/cli/tests/a.test.ts', 'apps/cli/tests/b.test.ts', 'apps/cli/tests/c.test.ts']
  })
  const vitestStart = testGroupStartLine({
    group: 'aeg-core@default',
    runner: 'vitest',
    cwd: 'packages/aeg-core',
    tests: ['packages/aeg-core/src/x.test.ts', 'packages/aeg-core/src/y.test.ts']
  })
  // A Bun group whose second file runs an inner fixture that prints its own `a.test.ts:` and `b.test.ts:` headers,
  // and whose third file crashed before its header; then a Vitest group whose reporter prints one line per file.
  const output = [
    'vinaya schedule: cli@default — @attalabs/vinaya, bun in apps/cli, 3 file(s)',
    bunStart,
    'bun test v1.4.2',
    'tests/a.test.ts:',
    '(pass) one [2.00ms]',
    'tests/b.test.ts:',
    'a.test.ts:',
    '(fail) inner fixture failure',
    'b.test.ts:',
    '(pass) inner fixture pass',
    '(pass) runs a fixture [5.00ms]',
    ' 2 pass',
    'Ran 2 tests across 2 files.',
    testGroupEndLine({
      group: 'cli@default',
      executed: ['apps/cli/tests/a.test.ts', 'apps/cli/tests/b.test.ts'],
      failed: []
    }),
    'vinaya schedule: aeg-core@default — @attalabs/aeg-core, vitest in packages/aeg-core, 2 file(s)',
    vitestStart,
    ' ✓ src/x.test.ts (3 tests) 4ms',
    ' ❯ src/y.test.ts (2 tests | 1 failed) 7ms',
    '   × breaks 2ms',
    testGroupEndLine({
      group: 'aeg-core@default',
      executed: ['packages/aeg-core/src/x.test.ts', 'packages/aeg-core/src/y.test.ts'],
      failed: ['packages/aeg-core/src/y.test.ts']
    }),
    ''
  ].join('\n')

  it('counts only scheduled files, never an inner fixture header, and the Vitest file lines', () => {
    const parser = new TestOutputParser()
    const files = [...parser.feed(output), ...parser.end()].flatMap((e) => (e.kind === 'file' ? [e.file.file] : []))
    expect(files).toEqual([
      'apps/cli/tests/a.test.ts',
      'apps/cli/tests/b.test.ts',
      'packages/aeg-core/src/x.test.ts',
      'packages/aeg-core/src/y.test.ts'
    ])
  })

  it('a mixed Bun and Vitest run ends with its done count equal to the files its reports executed', () => {
    const { dir } = runtimeWithProgress()
    const now = 1_000
    const lines: string[] = []
    const reader = new ProgressReader(
      dir,
      (line) => lines.push(line),
      () => now
    )
    appendProgressRecord(dir, 'tests-3.ndjson', {
      v: 1,
      kind: 'tests-start',
      stream: 'tests-3',
      total: 5,
      label: 'selected tests'
    })
    appendProgressBytes(dir, 'tests-3.out', output)
    appendProgressRecord(dir, 'tests-3.ndjson', { v: 1, kind: 'tests-end', stream: 'tests-3' })
    reader.scan()
    expect(lines.filter((line) => line.includes('a.test.ts') && !line.includes('apps/cli'))).toEqual([])
    expect(lines).toEqual([
      'test progress: 1/5 apps/cli/tests/a.test.ts ✓, 2 ms',
      'test progress: 2/5 apps/cli/tests/b.test.ts ✗, 5 ms — first failing test: inner fixture failure',
      'test progress: 3/5 packages/aeg-core/src/x.test.ts ✓, 4 ms',
      'test progress: 4/5 packages/aeg-core/src/y.test.ts ✗, 7 ms'
    ])
    const tally = new TestRunTally(5)
    for (const event of new TestOutputParser().feed(output)) {
      if (event.kind === 'file') tally.add(event.file, event.group)
      else tally.reconcile(event.end.group, event.end.executed, event.end.failed)
    }
    // The inner fixture's failure line marked b live; its report did not, and the report decides.
    expect([tally.done, tally.failed]).toEqual([4, 1])
  })

  it('a group whose runner prints no file line moves its count when its report is read', () => {
    const tally = new TestRunTally(2)
    const silent = [
      vitestStart,
      testGroupEndLine({
        group: 'aeg-core@default',
        executed: ['packages/aeg-core/src/x.test.ts', 'packages/aeg-core/src/y.test.ts'],
        failed: []
      }),
      ''
    ].join('\n')
    for (const event of new TestOutputParser().feed(silent)) {
      if (event.kind === 'file') tally.add(event.file, event.group)
      else tally.reconcile(event.end.group, event.end.executed, event.end.failed)
    }
    expect(tally.done).toBe(2)
  })

  it('a header-shaped line outside every group, once groups started, is never counted', () => {
    const parser = new TestOutputParser()
    const events = parser.feed(
      [
        bunStart,
        testGroupEndLine({ group: 'cli@default', executed: [], failed: [] }),
        'stray.test.ts:',
        '(pass) x',
        'Ran 1 test across 1 file.',
        ''
      ].join('\n')
    )
    expect(events.filter((e) => e.kind === 'file')).toEqual([])
    expect(parser.end()).toEqual([])
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
