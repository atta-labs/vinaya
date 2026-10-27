// Re-run only what failed: a refused push records its failing test files at
// that commit; the next push runs only those plus the files affected by what
// changed since. Pure decisions are tested directly; the recorder is driven
// for real against a throwaway git repository.
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  completedTestSelection,
  TEST_SELECTION_COMPLETE,
  changedBetween,
  chooseTests,
  type FailedTestsRecord,
  parseFailedTestFiles,
  parseRecord,
  recordFromRun
} from '../../src/lib/pre-push-failed-tests'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

const RECORDER = join(import.meta.dir, '..', '..', 'src', 'lib', 'pre-push-record-tests.ts')

const BUN_LOG =
  `bun test v1.4.2

a.test.ts:
error: expect(received).toBe(expected)

(fail) a fails [0.14ms]

sub/c.test.ts:
(pass) c ok
(fail) c fails [0.01ms]

b.test.ts:
(pass) b ok

d.test.ts:

# Unhandled error between tests
-------------------------------
error: boom

 2 pass
 3 fail
Ran 5 tests across 4 files.
` +
  TEST_SELECTION_COMPLETE +
  JSON.stringify({ files: ['a.test.ts', 'sub/c.test.ts', 'b.test.ts', 'd.test.ts'], exitCode: 1 }) +
  '\n'

describe('parseFailedTestFiles', () => {
  it('a named failure followed by an unfinished test run forces the entire selection', () => {
    const interrupted = 'a.test.ts:\n(fail) a fails\nb.test.ts:\n'
    const failed = parseFailedTestFiles(interrupted, '/repo', true)
    expect(failed).toBe('all')
    expect(chooseTests({ ...base, record: record({ failed }), fullSelection: FULL }).mode).toBe('full')
  })

  it('names every file whose block holds a failure or an unhandled error, resolved against cwd', () => {
    expect(parseFailedTestFiles(BUN_LOG, '/repo', true)).toEqual([
      '/repo/a.test.ts',
      '/repo/d.test.ts',
      '/repo/sub/c.test.ts'
    ])
  })

  it('keeps absolute headers as they are', () => {
    expect(
      parseFailedTestFiles(
        '/abs/x.test.ts:\n(fail) t\nRan 1 test across 1 file.\n' +
          TEST_SELECTION_COMPLETE +
          JSON.stringify({ files: ['/abs/x.test.ts'], exitCode: 1 }) +
          '\n',
        '/repo',
        true
      )
    ).toEqual(['/abs/x.test.ts'])
  })

  it("a failed run that names no file is 'all', never an empty re-run", () => {
    expect(parseFailedTestFiles('error: Cannot find module\n', '/repo', true)).toBe('all')
  })

  it('a green log names nothing', () => {
    expect(parseFailedTestFiles('ok.test.ts:\n(pass) fine\n', '/repo', false)).toEqual([])
  })
})

const record = (over: Partial<FailedTestsRecord> = {}): FailedTestsRecord => ({
  version: 1,
  selectionCompleted: true,
  head: 'old',
  branch: 'task/1',
  failed: ['/r/a.test.ts', '/r/gone.test.ts'],
  recordedAt: '2026-10-26T00:00:00.000Z',
  ...over
})
const FULL = ['/r/a.test.ts', '/r/b.test.ts', '/r/c.test.ts', '/r/d.test.ts']
const base = {
  head: 'new',
  branch: 'task/1',
  recordIsAncestor: true,
  fullSelection: FULL,
  affectedSince: ['/r/c.test.ts'],
  exists: (p: string) => p !== '/r/gone.test.ts'
}

describe('chooseTests', () => {
  it('runs the failed files plus the files affected since the refused commit', () => {
    const note = chooseTests({ ...base, record: record({ failed: ['/r/a.test.ts'] }) })
    expect(note.mode).toBe('rerun')
    expect(note.selected).toEqual(['/r/a.test.ts', '/r/c.test.ts'])
    expect(note.rerunOf).toBe('old')
    expect(note.rerunFailed).toEqual(['/r/a.test.ts'])
    expect(note.fullCount).toBe(4)
  })

  it('a failed test file deleted since runs the full selection, never a re-run without it', () => {
    const note = chooseTests({ ...base, record: record({ failed: ['/r/gone.test.ts'] }), affectedSince: [] })
    expect(note.mode).toBe('full')
    expect(note.selected).toEqual(FULL)
  })

  it('a recorded refusal whose re-run comes out empty runs the full selection', () => {
    const note = chooseTests({ ...base, record: record({ failed: [] }), affectedSince: [] })
    expect(note.mode).toBe('full')
    expect(note.selected).toEqual(FULL)
  })

  it('no record runs the full selection', () => {
    const note = chooseTests({ ...base, record: null })
    expect(note.mode).toBe('full')
    expect(note.selected).toEqual(FULL)
  })

  it("a record of 'all' runs the full selection", () => {
    expect(chooseTests({ ...base, record: record({ failed: 'all' }) }).mode).toBe('full')
  })

  it('a record from another branch runs the full selection', () => {
    expect(chooseTests({ ...base, record: record({ branch: 'task/2' }) }).mode).toBe('full')
  })

  it('a record whose commit left the history (rebase, reset) runs the full selection', () => {
    expect(chooseTests({ ...base, recordIsAncestor: false, record: record() }).mode).toBe('full')
  })
})

describe('recordFromRun / parseRecord', () => {
  it('a green run leaves no record; a refused one records head, branch and files', () => {
    const now = new Date('2026-10-26T01:00:00Z')
    expect(recordFromRun('passed', [], 'h', 'b', now)).toBeNull()
    const r = recordFromRun('failed', ['/x.test.ts'], 'h', 'b', now)
    expect(r).toEqual({
      version: 1,
      head: 'h',
      branch: 'b',
      failed: ['/x.test.ts'],
      recordedAt: now.toISOString(),
      selectionCompleted: true
    })
    expect(parseRecord(JSON.stringify(r))).toEqual(r)
  })

  it('rejects anything not of the record shape', () => {
    expect(parseRecord(null)).toBeNull()
    expect(parseRecord('{nope')).toBeNull()
    expect(parseRecord(JSON.stringify({ version: 2, head: 'h', branch: 'b', failed: [] }))).toBeNull()
    expect(parseRecord(JSON.stringify({ version: 1, head: 'h', branch: 'b', failed: 'x' }))).toBeNull()
  })
})

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...stripVinayaEnv(), ...extra }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-failed-tests-'))
  const run = (args: string[]) => {
    const r = spawnSyncBudgeted('git', args, { cwd: dir, env: cleanEnv(), encoding: 'utf8' })
    expect(r.status).toBe(0)
  }
  run(['init', '-q', '-b', 'task/7'])
  run(['config', 'user.email', 'fixture@example.invalid'])
  run(['config', 'user.name', 'fixture'])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'init'])
  return dir
}

describe('pre-push-record-tests (real git repository)', () => {
  it('a refused run writes the record and the last-push summary; the next green run clears the record', () => {
    const dir = fixtureRepo()
    const log = join(dir, 'log.txt')
    writeFileSync(log, BUN_LOG)
    expect(
      spawnSyncBudgeted('bun', [RECORDER, 'failed', log, '12'], {
        cwd: dir,
        env: cleanEnv({ VINAYA_PUSH_MODE: 'ready' }),
        encoding: 'utf8'
      }).status
    ).toBe(0)
    const recordPath = join(dir, '.git', 'vinaya', 'pre-push-failed-tests.json')
    const resultPath = join(dir, '.git', 'vinaya', 'pre-push-last-result.json')
    const written = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(written.branch).toBe('task/7')
    expect(written.failed).toHaveLength(3)
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    expect(result.mode).toBe('ready')
    expect(result.outcome).toBe('failed')
    expect(result.elapsedSeconds).toBe(12)

    writeFileSync(
      join(dir, '.git', 'vinaya', 'pre-push-selection.json'),
      JSON.stringify({ version: 1, head: written.head, selected: [] })
    )
    expect(
      spawnSyncBudgeted('bun', [RECORDER, 'passed', '', '0'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' }).status
    ).toBe(0)
    expect(existsSync(recordPath)).toBe(false)
    expect(JSON.parse(readFileSync(resultPath, 'utf8')).outcome).toBe('passed')
  })
})

describe('changedBetween (real git repository)', () => {
  it('counts a deleted file among the changes', () => {
    const dir = fixtureRepo()
    const git = (args: string[]) =>
      spawnSyncBudgeted('git', args, { cwd: dir, env: cleanEnv(), encoding: 'utf8' }).stdout?.toString().trim() ?? ''
    const from = git(['rev-parse', 'HEAD'])
    git(['rm', '-q', 'a.txt'])
    git(['commit', '-q', '-m', 'delete'])
    expect(changedBetween(dir, from, git(['rev-parse', 'HEAD']))).toEqual([join(dir, 'a.txt')])
  })
})

describe('selection supervisor', () => {
  for (const signal of ['SIGTERM', 'SIGKILL'])
    it(`a real ${signal} after a named failure forces a full rerun`, () => {
      const dir = fixtureRepo()
      const a = join(dir, 'a.test.ts')
      const b = join(dir, 'b.test.ts')
      writeFileSync(a, "import { test, expect } from 'bun:test'; test('a fails', () => expect(1).toBe(2));")
      writeFileSync(
        b,
        `import { test } from 'bun:test'; test('b interrupted', () => process.kill(process.pid, '${signal}'));`
      )
      const result = spawnSyncBudgeted('bun', [RECORDER, 'run', a, b], { cwd: dir, env: cleanEnv(), encoding: 'utf8' })
      const log = result.stdout + result.stderr
      expect(result.status).not.toBe(0)
      expect(log).toContain('(fail) a fails')
      expect(completedTestSelection(log, dir, [a, b])).toBe(false)
      expect(parseFailedTestFiles(log, dir, true, [a, b])).toBe('all')
    })

  it('a complete ordinary failure can narrow only when every selected file completed', () => {
    expect(
      completedTestSelection(BUN_LOG, '/repo', [
        '/repo/a.test.ts',
        '/repo/b.test.ts',
        '/repo/sub/c.test.ts',
        '/repo/d.test.ts'
      ])
    ).toBe(true)
    expect(
      completedTestSelection(BUN_LOG, '/repo', [
        '/repo/a.test.ts',
        '/repo/b.test.ts',
        '/repo/sub/c.test.ts',
        '/repo/d.test.ts',
        '/repo/missing.test.ts'
      ])
    ).toBe(false)
    expect(parseFailedTestFiles(BUN_LOG, '/repo', true, ['/repo/missing.test.ts'])).toBe('all')
    expect(chooseTests({ ...base, record: record({ selectionCompleted: false }) }).mode).toBe('full')
  })
})
