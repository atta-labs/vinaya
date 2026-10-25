// Re-run only what failed: a refused push records its failing test files at
// that commit; the next push runs only those plus the files affected by what
// changed since. Pure decisions are tested directly; the recorder is driven
// for real against a throwaway git repository.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chooseTests,
  type FailedTestsRecord,
  parseFailedTestFiles,
  parseRecord,
  recordFromRun
} from '../../src/lib/pre-push-failed-tests'

const RECORDER = join(import.meta.dir, '..', '..', 'src', 'lib', 'pre-push-record-tests.ts')

const BUN_LOG = `bun test v1.4.2

a.test.ts:
error: expect(received).toBe(expected)

(fail) a fails [0.14ms]

sub/c.test.ts:
(pass) c ok
(fail) c fails [0.01ms]

d.test.ts:

# Unhandled error between tests
-------------------------------
error: boom

 2 pass
 3 fail
Ran 5 tests across 4 files.
`

describe('parseFailedTestFiles', () => {
  it('names every file whose block holds a failure or an unhandled error, resolved against cwd', () => {
    expect(parseFailedTestFiles(BUN_LOG, '/repo', true)).toEqual([
      '/repo/a.test.ts',
      '/repo/d.test.ts',
      '/repo/sub/c.test.ts'
    ])
  })

  it('keeps absolute headers as they are', () => {
    expect(parseFailedTestFiles('/abs/x.test.ts:\n(fail) t\n', '/repo', true)).toEqual(['/abs/x.test.ts'])
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
  it('runs the failed files that still exist plus the files affected since the refused commit', () => {
    const note = chooseTests({ ...base, record: record() })
    expect(note.mode).toBe('rerun')
    expect(note.selected).toEqual(['/r/a.test.ts', '/r/c.test.ts'])
    expect(note.rerunOf).toBe('old')
    expect(note.rerunFailed).toEqual(['/r/a.test.ts'])
    expect(note.fullCount).toBe(4)
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
    expect(r).toEqual({ version: 1, head: 'h', branch: 'b', failed: ['/x.test.ts'], recordedAt: now.toISOString() })
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
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-failed-tests-'))
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, env: cleanEnv(), stdio: 'ignore' })
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
    execFileSync('bun', [RECORDER, 'failed', log, '12'], { cwd: dir, env: cleanEnv({ VINAYA_PUSH_MODE: 'ready' }) })
    const recordPath = join(dir, '.git', 'vinaya', 'pre-push-failed-tests.json')
    const resultPath = join(dir, '.git', 'vinaya', 'pre-push-last-result.json')
    const written = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(written.branch).toBe('task/7')
    expect(written.failed).toHaveLength(3)
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    expect(result.mode).toBe('ready')
    expect(result.outcome).toBe('failed')
    expect(result.elapsedSeconds).toBe(12)

    execFileSync('bun', [RECORDER, 'passed', '', '0'], { cwd: dir, env: cleanEnv() })
    expect(existsSync(recordPath)).toBe(false)
    expect(JSON.parse(readFileSync(resultPath, 'utf8')).outcome).toBe('passed')
  })
})
