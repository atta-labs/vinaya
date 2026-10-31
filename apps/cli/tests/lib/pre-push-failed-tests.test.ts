// Re-run only what failed: a refused push records its failing test files at
// that commit; the next push runs only those plus the files affected by what
// changed since. Pure decisions are tested directly; the recorder is driven
// for real against a throwaway git repository.
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  completedTestSelection,
  TEST_SELECTION_COMPLETE,
  changedBetween,
  chooseNativeBase,
  chooseTests,
  computeVerificationContext,
  type NativeBaseInputs,
  nativePassingRecord,
  decideSelection,
  type FailedTestsRecord,
  parseFailedTestFiles,
  parsePassingRecord,
  parseRecord,
  type PassingRecord,
  passingRecordFromRun,
  readFailedTestsRecord,
  readPassingRecord,
  recordFromRun,
  type SelectionDeps,
  type SelectionNote,
  SELECTION_POLICY,
  verificationInputsDirty
} from '../../src/lib/pre-push-failed-tests'
import { prePushSelection } from '../../src/lib/pre-push-selection'
import {
  addedOrRenamedFilesSinceRemoteBase,
  changedFileDiffsSinceRemoteBase,
  changedFilesSinceRemoteBase,
  type ReadFailure,
  removedFilesSinceRemoteBase
} from '../../src/lib/remote-base'
import { ROOT_CONFIG_FILENAME } from '../../src/lib/test-selector'
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
    if (note.mode !== 'rerun') throw new Error(`expected a rerun note, got ${note.mode}`)
    expect(note.selected).toEqual(['/r/a.test.ts', '/r/c.test.ts'])
    expect(note.rerunOf).toBe('old')
    expect(note.recordedHead).toBe('old')
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

// ── Passing record and the since-green selection ────────────────────────────

const passing = (over: Partial<PassingRecord> = {}): PassingRecord => ({
  version: 2,
  kind: 'passed',
  head: 'old',
  branch: 'task/1',
  selection: FULL,
  selectionCompleted: true,
  context: 'ctx',
  recordedAt: '2026-10-26T00:00:00.000Z',
  ...over
})

function sinceGreenDeps(over: Partial<SelectionDeps<{ selected: string[] }>> = {}) {
  const calls = { full: 0, sinceGreen: 0 }
  const deps: SelectionDeps<{ selected: string[] }> = {
    repoRoot: '/r',
    head: 'new',
    branch: 'task/1',
    failed: null,
    passing: passing(),
    context: 'ctx',
    inputsClean: true,
    isAncestor: () => true,
    exists: () => true,
    changedBetween: () => ['/r/src/x.ts'],
    isAlwaysRun: (path) => path === '/r/always.test.ts',
    sinceGreen: () => {
      calls.sinceGreen++
      return { selected: ['/r/x.test.ts', '/r/always.test.ts'], readFailed: false }
    },
    affectedSince: () => ['/r/c.test.ts'],
    full: () => {
      calls.full++
      return { selected: FULL }
    },
    ...over
  }
  return { deps, calls }
}

describe('decideSelection after a passing run', () => {
  it('runs only the hook’s own selection since the passing head, and never computes the full selection', () => {
    const { deps, calls } = sinceGreenDeps()
    const { note, full } = decideSelection(deps)
    if (note.mode !== 'since-green') throw new Error(`expected since-green, got ${note.mode}`)
    expect(note.selected).toEqual(['/r/always.test.ts', '/r/x.test.ts'])
    expect(note.affectedSince).toEqual(['/r/x.test.ts'])
    expect(note.recordedHead).toBe('old')
    expect(note.fullCount).toBeNull()
    expect(note.context).toBe('ctx')
    expect(full).toBeNull()
    expect(calls).toEqual({ full: 0, sinceGreen: 1 })
  })

  const fallbacks: [string, Partial<SelectionDeps<{ selected: string[] }>>][] = [
    ['no record', { passing: null }],
    ['another branch', { passing: passing({ branch: 'task/2' }) }],
    ['a recorded head that is not an ancestor', { isAncestor: () => false }],
    ['an incomplete recorded selection', { passing: passing({ selectionCompleted: false as unknown as true }) }],
    ['a change to the root configuration file', { changedBetween: () => [`/r/${ROOT_CONFIG_FILENAME}`] }],
    [
      'an empty affected set after a change to a file the selector cannot trace',
      {
        changedBetween: () => ['/r/docs/readme.md'],
        sinceGreen: () => ({ selected: ['/r/always.test.ts'], readFailed: false })
      }
    ],
    ['a diff that cannot be read', { changedBetween: () => null }],
    [
      'a selection read that fails after a preliminary read that succeeded',
      { sinceGreen: () => ({ selected: ['/r/x.test.ts'], readFailed: true }) }
    ],
    ['a changed policy or execution context', { context: 'other' }],
    ['an unreadable context', { context: null }],
    ['a dirty verification input', { inputsClean: false }],
    ['verification inputs git cannot report on', { inputsClean: null }]
  ]
  for (const [name, over] of fallbacks)
    it(`${name} runs the full selection, computed once`, () => {
      const { deps, calls } = sinceGreenDeps(over)
      const { note } = decideSelection(deps)
      expect(note.mode).toBe('full')
      expect(note.selected).toEqual(FULL)
      expect(calls.full).toBe(1)
    })

  it('a change nothing traces still runs always-run files when the change is itself an always-run test', () => {
    const { deps } = sinceGreenDeps({ changedBetween: () => ['/r/always.test.ts'] })
    expect(decideSelection(deps).note.mode).toBe('since-green')
  })

  it('a failed-files record keeps its ordinary rerun and takes no since-green shortcut', () => {
    const { deps, calls } = sinceGreenDeps({
      failed: record({ failed: ['/r/a.test.ts'] }),
      passing: passing()
    })
    const { note } = decideSelection(deps)
    if (note.mode !== 'rerun') throw new Error(`expected rerun, got ${note.mode}`)
    expect(note.selected).toEqual(['/r/a.test.ts', '/r/c.test.ts'])
    expect(note.fullCount).toBe(4)
    expect(calls).toEqual({ full: 1, sinceGreen: 0 })
  })

  it('a rerun whose diff cannot be read runs the full selection, not an empty change list', () => {
    const { deps } = sinceGreenDeps({
      passing: null,
      failed: record({ failed: ['/r/a.test.ts'] }),
      changedBetween: () => null
    })
    const { note } = decideSelection(deps)
    expect(note.mode).toBe('full')
    expect(note.selected).toEqual(FULL)
  })

  it('no record at all runs the full selection with its numeric count', () => {
    const { deps } = sinceGreenDeps({ passing: null })
    const { note } = decideSelection(deps)
    if (note.mode !== 'full') throw new Error(`expected full, got ${note.mode}`)
    expect(note.fullCount).toBe(4)
  })

  it('a note carries no context when the inputs are dirty, so no passing record can follow', () => {
    const { deps } = sinceGreenDeps({ passing: null, inputsClean: false })
    expect(decideSelection(deps).note.context).toBeUndefined()
  })
})

describe('passing record shape', () => {
  it('reads only the versioned passing shape; the failed-files shape and old formats refuse', () => {
    const r = passing()
    expect(parsePassingRecord(JSON.stringify(r))).toEqual(r)
    expect(parsePassingRecord(JSON.stringify({ ...r, version: 1 }))).toBeNull()
    expect(parsePassingRecord(JSON.stringify({ ...r, kind: 'failed' }))).toBeNull()
    expect(parsePassingRecord(JSON.stringify(record()))).toBeNull()
    expect(parsePassingRecord('{nope')).toBeNull()
    expect(parseRecord(JSON.stringify(r))).toBeNull()
  })

  const verified = {
    outcome: 'passed' as const,
    selection: {
      version: 1,
      mode: 'full',
      head: 'h',
      fullCount: 1,
      selected: ['/r/a.test.ts'],
      context: 'ctx'
    } as SelectionNote,
    log: runLog(['/r/a.test.ts']),
    repoRoot: '/r',
    head: 'h',
    branch: 'task/1',
    context: 'ctx',
    inputsClean: true,
    now: new Date('2026-10-26T01:00:00Z')
  }

  it('a verified passing run records the head, branch, completed selection and context', () => {
    expect(passingRecordFromRun(verified)).toEqual({
      version: 2,
      kind: 'passed',
      head: 'h',
      branch: 'task/1',
      selection: ['/r/a.test.ts'],
      selectionCompleted: true,
      context: 'ctx',
      recordedAt: '2026-10-26T01:00:00.000Z'
    })
  })

  const refusals: [string, Partial<typeof verified>][] = [
    ['a refused run', { outcome: 'failed' as never }],
    ['no selection note', { selection: null as never }],
    ['a note naming another head', { head: 'moved' }],
    ['a log that does not show the whole selection completed', { log: runLog(['/r/other.test.ts']) }],
    ['an empty log', { log: '' }],
    ['a context that changed during the run', { context: 'changed' }],
    ['an unreadable context', { context: null as never }],
    ['a verification input made dirty during the run', { inputsClean: false }]
  ]
  for (const [name, over] of refusals)
    it(`${name} records nothing`, () => {
      expect(passingRecordFromRun({ ...verified, ...over })).toBeNull()
    })

  it('a one-file log does not stand in for a larger expected selection', () => {
    const selection = { ...verified.selection, selected: ['/r/a.test.ts', '/r/b.test.ts'] } as SelectionNote
    expect(passingRecordFromRun({ ...verified, selection })).toBeNull()
  })
})

function runLog(files: string[], failing: string[] = []): string {
  const blocks = files
    .map((file) => `${file}:\n${failing.includes(file) ? '(fail) t fails' : '(pass) t ok'}\n`)
    .join('\n')
  return (
    `${blocks}\n ${files.length - failing.length} pass\n ${failing.length} fail\n` +
    `Ran ${files.length} tests across ${files.length} files.\n` +
    TEST_SELECTION_COMPLETE +
    JSON.stringify({ files, exitCode: failing.length > 0 ? 1 : 0 }) +
    '\n'
  )
}

describe('verification context (real git repository)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')

  function contextFixture(): string {
    const dir = fixtureRepo()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', workspaces: ['packages/*'] }))
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ prePush: { alwaysRun: ['x.test.ts'] } }))
    writeFileSync(join(dir, 'bun.lock'), 'lock 1\n')
    writeFileSync(join(dir, 'src.ts'), 'export const a = 1\n')
    const run = (args: string[]) => spawnSyncBudgeted('git', args, { cwd: dir, env: cleanEnv(), encoding: 'utf8' })
    run(['add', '.'])
    run(['commit', '-q', '-m', 'inputs'])
    return dir
  }

  it('each of the input declarations, lockfile, runner configuration and environment changes the context on its own', () => {
    const dir = contextFixture()
    const env = { TZ: 'UTC' }
    const base = computeVerificationContext(dir, env)
    if (!base) throw new Error('context unreadable')
    const changed = (part: keyof typeof base.parts, edit: () => void, nextEnv = env) => {
      edit()
      const next = computeVerificationContext(dir, nextEnv)
      if (!next) throw new Error('context unreadable')
      expect(next.digest).not.toBe(base.digest)
      for (const key of Object.keys(base.parts) as (keyof typeof base.parts)[])
        if (key === part) expect(next.parts[key]).not.toBe(base.parts[key])
        else expect(next.parts[key]).toBe(base.parts[key])
    }
    changed('inputs', () =>
      writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ prePush: { alwaysRun: ['y.test.ts'] } }))
    )
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ prePush: { alwaysRun: ['x.test.ts'] } }))
    changed('lockfile', () => writeFileSync(join(dir, 'bun.lock'), 'lock 2\n'))
    writeFileSync(join(dir, 'bun.lock'), 'lock 1\n')
    changed('runner', () => writeFileSync(join(dir, 'bunfig.toml'), '[test]\nroot = "."\n'))
    rmSync(join(dir, 'bunfig.toml'))
    changed('environment', () => undefined, { TZ: 'Asia/Bangkok' })
    expect(computeVerificationContext(dir, env)?.parts.policy).toBe(sha(JSON.stringify(SELECTION_POLICY)))
    expect(SELECTION_POLICY.rootConfigFile).toBe(ROOT_CONFIG_FILENAME)
    expect(SELECTION_POLICY.depth).toBe('one')
  })

  it('a changed policy part changes the digest a record was made under, so the record refuses reuse', () => {
    const dir = contextFixture()
    const base = computeVerificationContext(dir, { TZ: 'UTC' })
    if (!base) throw new Error('context unreadable')
    const otherPolicy = sha(JSON.stringify({ ...base.parts, policy: sha('another selection policy') }))
    expect(otherPolicy).not.toBe(base.digest)
    const { deps } = sinceGreenDeps({ context: base.digest, passing: passing({ context: otherPolicy }) })
    expect(decideSelection(deps).note.mode).toBe('full')
  })

  it('ordinary subject-source changes and new commits leave the context as it was', () => {
    const dir = contextFixture()
    const env = { TZ: 'UTC' }
    const before = computeVerificationContext(dir, env)
    writeFileSync(join(dir, 'src.ts'), 'export const a = 2\n')
    writeFileSync(join(dir, 'new.ts'), 'export const n = 1\n')
    spawnSyncBudgeted('git', ['add', '.'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' })
    spawnSyncBudgeted('git', ['commit', '-q', '-m', 'subject'], { cwd: dir, env: cleanEnv(), encoding: 'utf8' })
    expect(computeVerificationContext(dir, env)).toEqual(before)
  })

  it('an unreadable input makes the context unavailable', () => {
    const dir = contextFixture()
    writeFileSync(join(dir, 'vinaya.config.json'), '{nope')
    expect(computeVerificationContext(dir, { TZ: 'UTC' })).toBeNull()
  })

  it('an uncommitted edit to a verification input is dirty; subject sources and a clean tree are not', () => {
    const dir = contextFixture()
    expect(verificationInputsDirty(dir)).toBe(false)
    writeFileSync(join(dir, 'src.ts'), 'export const a = 3\n')
    expect(verificationInputsDirty(dir)).toBe(false)
    writeFileSync(join(dir, 'bun.lock'), 'lock edited\n')
    expect(verificationInputsDirty(dir)).toBe(true)
    expect(verificationInputsDirty(join(tmpdir(), 'vinaya-no-such-repo-dir'))).toBeNull()
  })
})

// ── The hook's selector and recorder, end to end ────────────────────────────

const SELECTOR = join(import.meta.dir, '..', '..', 'src', 'lib', 'pre-push-select-tests.ts')

/** A throwaway repository with two source files, their tests and one always-run test, on a task branch. */
function selectorFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vinaya-since-green-')))
  const env = cleanEnv()
  const git = (...args: string[]) => {
    const r = spawnSyncBudgeted('git', args, { cwd: dir, env, encoding: 'utf8' })
    expect(r.status).toBe(0)
    return (r.stdout ?? '').toString().trim()
  }
  const write = (relative: string, text: string) => {
    mkdirSync(dirname(join(dir, relative)), { recursive: true })
    writeFileSync(join(dir, relative), text)
  }
  const commit = (message: string, edits: Record<string, string>) => {
    for (const [file, text] of Object.entries(edits)) write(file, text)
    git('add', '.')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q', '-b', 'task/9')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'fixture')
  const testFor = (name: string) =>
    `import { test } from 'bun:test'\nimport { ${name} } from '../src/${name}'\ntest('${name}', () => void ${name})\n`
  commit('base', {
    'package.json': JSON.stringify({ name: 'fx', private: true, workspaces: ['packages/*'] }),
    'vinaya.config.json': JSON.stringify({ prePush: { alwaysRun: ['packages/p/tests/always.test.ts'] } }),
    'packages/p/package.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
    'packages/p/src/a.ts': 'export const a = 0\n',
    'packages/p/src/b.ts': 'export const b = 0\n',
    'packages/p/tests/a.test.ts': testFor('a'),
    'packages/p/tests/b.test.ts': testFor('b'),
    'packages/p/tests/always.test.ts': "import { test } from 'bun:test'\ntest('always', () => {})\n"
  })
  const test = (name: string) => join(dir, 'packages', 'p', 'tests', `${name}.test.ts`)
  const select = () => {
    const r = spawnSyncBudgeted('bun', [SELECTOR], { cwd: dir, env, encoding: 'utf8' })
    expect(r.status).toBe(0)
    const note = JSON.parse(
      readFileSync(join(dir, '.git', 'vinaya', 'pre-push-selection.json'), 'utf8')
    ) as SelectionNote
    return { note, stdout: (r.stdout ?? '').toString().split('\n').filter(Boolean), stderr: `${r.stderr}` }
  }
  const record = (
    outcome: 'passed' | 'failed',
    files: string[],
    failing: string[] = [],
    log = runLog(files, failing)
  ) => {
    const logPath = join(dir, '.git', 'run.log')
    writeFileSync(logPath, log)
    const r = spawnSyncBudgeted('bun', [RECORDER, outcome, logPath, '1'], { cwd: dir, env, encoding: 'utf8' })
    expect(r.status).toBe(0)
  }
  const recordPath = join(dir, '.git', 'vinaya', 'pre-push-failed-tests.json')
  return { dir, git, write, commit, select, record, test, recordPath }
}

describe('the since-green selection, end to end (real git repository)', () => {
  it('a one-file change after a passing run selects only that file’s tests plus the always-run files', () => {
    const fx = selectorFixture()
    const first = fx.commit('first', {
      'packages/p/src/a.ts': 'export const a = 1\n',
      'packages/p/src/b.ts': 'export const b = 1\n'
    })
    const full = fx.select()
    expect(full.note.mode).toBe('full')
    expect(full.stdout.sort()).toEqual([fx.test('a'), fx.test('always'), fx.test('b')].sort())
    fx.record('passed', full.note.selected)
    expect(readPassingRecord(fx.dir)).toMatchObject({ head: first, branch: 'task/9', selectionCompleted: true })
    expect(readFailedTestsRecord(fx.dir)).toBeNull()

    fx.commit('second', { 'packages/p/src/a.ts': 'export const a = 2\n' })
    const since = fx.select()
    if (since.note.mode !== 'since-green') throw new Error(`expected since-green, got ${since.note.mode}`)
    expect(since.note.recordedHead).toBe(first)
    expect(since.note.fullCount).toBeNull()
    expect(since.stdout.sort()).toEqual([fx.test('a'), fx.test('always')].sort())
    expect(since.note.affectedSince).toEqual([fx.test('a')])
    expect(since.stderr).toContain('running only what changed since the passing run')
  }, 90_000)

  it('passing, then failing, then fixed: the failed file reruns and the fixed head leaves a passing record', () => {
    const fx = selectorFixture()
    fx.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n', 'packages/p/src/b.ts': 'export const b = 1\n' })
    fx.record('passed', fx.select().note.selected)

    fx.commit('break', { 'packages/p/src/a.ts': 'export const a = 2\n' })
    const second = fx.select()
    expect(second.note.mode).toBe('since-green')
    fx.record('failed', second.note.selected, [fx.test('a')])
    expect(readPassingRecord(fx.dir)).toBeNull()
    expect(readFailedTestsRecord(fx.dir)?.failed).toEqual([fx.test('a')])

    const fixed = fx.commit('fix', { 'packages/p/src/a.ts': 'export const a = 3\n' })
    const third = fx.select()
    if (third.note.mode !== 'rerun') throw new Error(`expected rerun, got ${third.note.mode}`)
    expect(third.stdout).toEqual([fx.test('a')])
    expect(third.note.rerunFailed).toEqual([fx.test('a')])
    fx.record('passed', third.note.selected)
    expect(readFailedTestsRecord(fx.dir)).toBeNull()
    expect(readPassingRecord(fx.dir)).toMatchObject({ head: fixed, selection: [fx.test('a')] })
  }, 120_000)

  it('a rewritten history and another branch run the full selection', () => {
    const fx = selectorFixture()
    fx.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n' })
    fx.record('passed', fx.select().note.selected)
    fx.commit('second', { 'packages/p/src/a.ts': 'export const a = 2\n' })
    fx.git('reset', '-q', '--hard', 'HEAD~2')
    fx.commit('rewritten', { 'packages/p/src/a.ts': 'export const a = 9\n' })
    expect(fx.select().note.mode).toBe('full')

    const other = selectorFixture()
    other.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n' })
    other.record('passed', other.select().note.selected)
    other.git('checkout', '-q', '-b', 'task/other')
    other.commit('second', { 'packages/p/src/a.ts': 'export const a = 2\n' })
    expect(other.select().note.mode).toBe('full')
  }, 120_000)

  it('a changed root configuration file, lockfile or dirty input runs the full selection', () => {
    const fx = selectorFixture()
    fx.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n' })
    fx.record('passed', fx.select().note.selected)
    fx.commit('config', {
      'vinaya.config.json': JSON.stringify({ prePush: { alwaysRun: ['packages/p/tests/always.test.ts'] }, note: 1 })
    })
    expect(fx.select().note.mode).toBe('full')

    const dirty = selectorFixture()
    dirty.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n' })
    dirty.record('passed', dirty.select().note.selected)
    dirty.commit('second', { 'packages/p/src/a.ts': 'export const a = 2\n' })
    writeFileSync(join(dirty.dir, 'bun.lock'), 'uncommitted lock\n')
    const note = dirty.select().note
    expect(note.mode).toBe('full')
    expect(note.context).toBeUndefined()
  }, 120_000)

  const unverified: [string, (fx: ReturnType<typeof selectorFixture>, selected: string[]) => void][] = [
    ['a missing selection note', (fx) => rmSync(join(fx.dir, '.git', 'vinaya', 'pre-push-selection.json'))],
    [
      'a selection note that does not parse',
      (fx) => writeFileSync(join(fx.dir, '.git', 'vinaya', 'pre-push-selection.json'), '{not json')
    ],
    [
      'a selection note naming another head',
      (fx) =>
        writeFileSync(
          join(fx.dir, '.git', 'vinaya', 'pre-push-selection.json'),
          JSON.stringify({ version: 1, mode: 'full', head: 'f'.repeat(40), fullCount: 1, selected: [fx.test('a')] })
        )
    ]
  ]
  for (const [name, spoil] of unverified)
    it(`a passing run with ${name} writes no passing record and the next push reruns the failed files`, () => {
      const fx = selectorFixture()
      const refused = fx.commit('refused', { 'packages/p/src/a.ts': 'export const a = 1\n' })
      fx.record('failed', fx.select().note.selected, [fx.test('a')])
      const seeded = readFileSync(fx.recordPath, 'utf8')
      fx.commit('next', { 'packages/p/src/b.ts': 'export const b = 1\n' })
      const next = fx.select()
      spoil(fx, next.note.selected)
      fx.record('passed', next.note.selected)
      expect(readPassingRecord(fx.dir)).toBeNull()
      expect(readFileSync(fx.recordPath, 'utf8')).toBe(seeded)
      const after = fx.select()
      if (after.note.mode !== 'rerun') throw new Error(`expected rerun, got ${after.note.mode}`)
      expect(after.note.recordedHead).toBe(refused)
    }, 120_000)

  it('an unverified passing run with no failed-files record leaves nothing and the next push is full', () => {
    const fx = selectorFixture()
    fx.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n' })
    const note = fx.select().note
    fx.record('passed', note.selected)
    expect(readPassingRecord(fx.dir)).not.toBeNull()
    fx.commit('second', { 'packages/p/src/a.ts': 'export const a = 2\n' })
    const since = fx.select()
    expect(since.note.mode).toBe('since-green')
    fx.record('passed', since.note.selected, [], 'no completion marker in this log\n')
    expect(readPassingRecord(fx.dir)).toBeNull()
    expect(existsSync(fx.recordPath)).toBe(false)
    expect(fx.select().note.mode).toBe('full')
  }, 120_000)

  it('writes a note that names each mode and the recorded head it builds on', () => {
    const fx = selectorFixture()
    const first = fx.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n' })
    const full = fx.select().note
    expect(full.mode).toBe('full')
    expect(typeof (full as { fullCount: number }).fullCount).toBe('number')
    fx.record('passed', full.selected)
    fx.commit('second', { 'packages/p/src/a.ts': 'export const a = 2\n' })
    const since = fx.select().note
    expect(since).toMatchObject({ mode: 'since-green', recordedHead: first, fullCount: null })
    fx.record('failed', since.selected, [fx.test('a')])
    fx.commit('third', { 'packages/p/src/a.ts': 'export const a = 3\n' })
    expect(fx.select().note).toMatchObject({ mode: 'rerun', recordedHead: expect.any(String) })
  }, 120_000)
})

describe('failed git reads are never an empty change list (real git repository)', () => {
  it('changedBetween reports an unreadable difference as null, apart from an empty one', () => {
    const fx = selectorFixture()
    const head = fx.git('rev-parse', 'HEAD')
    expect(changedBetween(fx.dir, 'no-such-commit', head)).toBeNull()
    expect(changedBetween(fx.dir, head, head)).toEqual([])
  })

  it('every git diff read prePushSelection consumes reports its failure to an opted-in caller only', () => {
    const fx = selectorFixture()
    fx.commit('first', { 'packages/p/src/a.ts': 'export const a = 1\n' })
    const readers: [string, (failure?: ReadFailure) => unknown][] = [
      ['changed files', (failure) => changedFilesSinceRemoteBase(fx.dir, 'no-such-ref', failure)],
      ['added or renamed files', (failure) => addedOrRenamedFilesSinceRemoteBase(fx.dir, 'no-such-ref', failure)],
      ['removed files', (failure) => removedFilesSinceRemoteBase(fx.dir, 'no-such-ref', failure)],
      ['file diffs', (failure) => changedFileDiffsSinceRemoteBase(fx.dir, 'no-such-ref', failure)]
    ]
    for (const [name, read] of readers) {
      const failure: ReadFailure = { failed: false }
      read(failure)
      expect(failure.failed, name).toBe(true)
      expect(() => read(), name).not.toThrow()
    }
    const selection: ReadFailure = { failed: false }
    prePushSelection(fx.dir, 'no-such-ref', 'one', selection)
    expect(selection.failed).toBe(true)
    const fine: ReadFailure = { failed: false }
    prePushSelection(fx.dir, 'HEAD~1', 'one', fine)
    expect(fine.failed).toBe(false)
  })
})

describe('the native push: its base, its obligations and its proof', () => {
  const ROOT = '/repo'
  const CTX = 'ctx-1'
  const failedAt = (over: Partial<FailedTestsRecord> = {}): FailedTestsRecord => ({
    version: 1,
    head: 'r'.repeat(40),
    branch: 'task/x/1',
    failed: ['/repo/apps/cli/tests/a.test.ts'],
    recordedAt: '2026-10-30T00:00:00.000Z',
    selectionCompleted: true,
    context: CTX,
    ...over
  })
  const passingAt = (over: Partial<PassingRecord> = {}): PassingRecord => ({
    version: 2,
    kind: 'passed',
    head: 'p'.repeat(40),
    branch: 'task/x/1',
    selection: ['/repo/apps/cli/tests/a.test.ts'],
    selectionCompleted: true,
    context: CTX,
    recordedAt: '2026-10-30T00:00:00.000Z',
    ...over
  })
  const inputs = (over: Partial<NativeBaseInputs> = {}): NativeBaseInputs => ({
    repoRoot: ROOT,
    head: 'h'.repeat(40),
    branch: 'task/x/1',
    mergeBase: 'm'.repeat(40),
    failed: null,
    passing: null,
    context: CTX,
    inputsClean: true,
    isAncestor: () => true,
    exists: () => true,
    changedBetween: () => ['/repo/apps/cli/src/x.ts'],
    ...over
  })

  it('with no record the selector compares with the merge base', () => {
    expect(chooseNativeBase(inputs())).toMatchObject({ base: 'm'.repeat(40), kind: 'merge-base', obligations: [] })
  })

  it('a verified pass under this context narrows the base to it; any mismatch widens to the merge base', () => {
    expect(chooseNativeBase(inputs({ passing: passingAt() }))).toMatchObject({
      base: 'p'.repeat(40),
      kind: 'since-green'
    })
    for (const over of [
      { passing: passingAt({ context: 'other' }) },
      { passing: passingAt({ branch: 'task/x/2' }) },
      { passing: passingAt(), context: null },
      { passing: passingAt(), inputsClean: false },
      { passing: passingAt(), isAncestor: () => false },
      { passing: passingAt(), changedBetween: () => null },
      { passing: passingAt(), changedBetween: () => ['/repo/vinaya.config.json'] }
    ])
      expect(chooseNativeBase(inputs(over)).kind).toBe('merge-base')
  })

  it('a completed refusal under this context narrows to its head and keeps its failed tests as obligations', () => {
    expect(chooseNativeBase(inputs({ failed: failedAt(), passing: passingAt() }))).toMatchObject({
      base: 'r'.repeat(40),
      kind: 'rerun',
      obligations: ['/repo/apps/cli/tests/a.test.ts']
    })
  })

  it('an unresolved failure stays an obligation even when the base widens; an unnamed one widens with none', () => {
    for (const over of [
      { context: 'other' },
      { inputsClean: false },
      { changedBetween: () => ['/repo/vinaya.config.json'] }
    ])
      expect(chooseNativeBase(inputs({ failed: failedAt(), ...over }))).toMatchObject({
        kind: 'merge-base',
        obligations: ['/repo/apps/cli/tests/a.test.ts']
      })
    expect(chooseNativeBase(inputs({ failed: failedAt({ selectionCompleted: false }) })).obligations).toEqual([
      '/repo/apps/cli/tests/a.test.ts'
    ])
    expect(chooseNativeBase(inputs({ failed: failedAt({ failed: 'all' }) }))).toMatchObject({
      kind: 'merge-base',
      obligations: []
    })
    expect(chooseNativeBase(inputs({ failed: failedAt(), exists: () => false }))).toMatchObject({
      kind: 'merge-base',
      obligations: []
    })
  })

  it('a refusal on another branch or outside this history is ignored', () => {
    expect(chooseNativeBase(inputs({ failed: failedAt({ branch: 'task/x/2' }) })).obligations).toEqual([])
    expect(chooseNativeBase(inputs({ failed: failedAt(), isAncestor: () => false })).obligations).toEqual([])
  })

  const native = (identities: string[]): NonNullable<SelectionNote['native']> => ({
    version: 1,
    base: 'm'.repeat(40),
    baseKind: 'merge-base',
    plan: 'plan',
    inventory: 'inv',
    context: CTX,
    identities,
    obligations: [],
    groups: [],
    expanded: [],
    command: null
  })
  const note = (identities: string[]): SelectionNote => ({
    version: 1,
    mode: 'full',
    head: 'h'.repeat(40),
    fullCount: identities.length,
    selected: identities.map((id) => `/repo/${id.split('@')[0]}`),
    native: native(identities)
  })
  const complete = (executed: string[]) => ({
    version: 1 as const,
    completed: true,
    executed,
    failedRunners: [],
    problems: []
  })
  const proof = (over: Partial<Parameters<typeof nativePassingRecord>[0]> = {}) =>
    nativePassingRecord({
      note: note(['a.test.ts@default']),
      completion: complete(['a.test.ts@default']),
      head: 'h'.repeat(40),
      branch: 'task/x/1',
      context: CTX,
      inputsClean: true,
      treeClean: true,
      now: new Date('2026-10-31T00:00:00Z'),
      ...over
    })

  it('a complete green native run of exactly the plan, on an unchanged head, tree and context, is proof', () => {
    expect(proof()).toMatchObject({ version: 2, kind: 'passed', head: 'h'.repeat(40), context: CTX })
  })

  it('anything short of that is no proof', () => {
    for (const over of [
      { completion: { ...complete(['a.test.ts@default']), completed: false } },
      { completion: { ...complete(['a.test.ts@default']), failedRunners: ['cli@default'] } },
      { completion: complete([]) },
      { completion: complete(['a.test.ts@default', 'b.test.ts@default']) },
      {
        completion: {
          ...complete(['a.test.ts@default']),
          problems: [{ code: 'extra', path: 'b.test.ts', detail: 'executed but not scheduled' }]
        }
      },
      { head: 'x'.repeat(40) },
      { context: 'other' },
      { context: null },
      { inputsClean: false },
      { treeClean: false },
      { treeClean: null },
      { branch: 'HEAD' },
      { note: note([]) },
      { note: { ...note(['a.test.ts@default']), native: undefined } }
    ])
      expect(proof(over as never)).toBeNull()
  })
})
