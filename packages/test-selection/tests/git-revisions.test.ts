// A plan over two committed revisions reads only those revisions: a dirty
// checkout, another branch or an advanced HEAD around them changes nothing,
// and the selection runs and records nothing.
import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type CommandRunner,
  findReadRecord,
  gitRepository,
  RECORD_ARTIFACT_PREFIX,
  RECORD_WORKFLOW_FILE,
  selectTests
} from '../src/index.js'
import { fixture, headFiles, scenarioInput } from './fixture-repos.js'

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** A child's environment with no git setting of this process. */
function bareEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, HOME: home }
}

function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...bareEnv(cwd),
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x'
    }
  })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim()
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('a plan for two commits reads only those commits', () => {
  it('is unchanged by a dirty checkout, another branch and an advanced HEAD, and executes and records nothing', () => {
    const fx = fixture('workspaces-repo.json')
    const scenario = fx.scenarios[0] as (typeof fx.scenarios)[number]
    const repo = scratch('verification-git-')
    try {
      const marker = join(repo, 'executed.marker')
      // A test that would leave a mark if anything ran it.
      const tripwire = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`
      const base = { ...fx.files, 'packages/app/tests/tripwire.test.ts': tripwire }
      const head = { ...headFiles(fx, scenario), 'packages/app/tests/tripwire.test.ts': tripwire }
      git(repo, ['init', '-q', '-b', 'main'])
      writeTree(repo, base)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'base'])
      const baseSha = git(repo, ['rev-parse', 'HEAD'])
      writeTree(repo, head)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'head'])
      const headSha = git(repo, ['rev-parse', 'HEAD'])
      const records = join(repo, 'records/passing.json')
      writeTree(repo, { 'records/passing.json': '{ "passed": [] }\n' })

      const input = () => {
        const memory = scenarioInput(
          { ...fx, files: base },
          { ...scenario, change: { ...scenario.change, 'packages/app/tests/tripwire.test.ts': tripwire } },
          { base: baseSha, head: headSha }
        )
        return { ...memory, repo: gitRepository(repo) }
      }
      const first = selectTests(input())
      expect(first.required.map((t) => t.test)).toEqual(['packages/app/tests/square.test.ts'])
      // The same plan an in-memory reader of the same two trees gives.
      const inMemory = selectTests(
        scenarioInput(
          { ...fx, files: base },
          { ...scenario, change: { ...scenario.change, 'packages/app/tests/tripwire.test.ts': tripwire } },
          { base: baseSha, head: headSha }
        )
      )
      expect(first.identity).toBe(inMemory.identity)

      // Dirty the checkout, move to another branch, advance HEAD.
      writeFileSync(join(repo, 'packages/core/src/add.ts'), 'export function add() { return 0 }\n')
      writeFileSync(join(repo, 'packages/app/tests/untracked.test.ts'), 'export {}\n')
      git(repo, ['checkout', '-q', '-b', 'elsewhere'])
      writeFileSync(join(repo, 'docs/guide.md'), '# Guide\n\nAdvanced.\n')
      git(repo, ['commit', '-q', '-am', 'advance'])
      writeFileSync(join(repo, 'packages/core/src/mul.ts'), '// dirty again\n')
      const status = git(repo, ['status', '--porcelain'])
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      const recordBefore = digest(records)

      const second = selectTests(input())
      expect(second.identity).toBe(first.identity)
      expect(git(repo, ['status', '--porcelain'])).toBe(status)
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(digest(records)).toBe(recordBefore)
      expect(readdirSync(repo)).not.toContain('executed.marker')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('the search for a read record, with a runner of the test in place of gh', () => {
  /** A scratch repository of `count` commits on one line; the commits' ids, oldest first. */
  function line(count: number): { repo: string; commits: string[] } {
    const repo = scratch('verification-fetch-')
    git(repo, ['init', '-q', '-b', 'main'])
    const commits: string[] = []
    for (let i = 0; i < count; i++) {
      writeTree(repo, { 'a.txt': `${i}\n` })
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', `c${i}`])
      commits.push(git(repo, ['rev-parse', 'HEAD']))
    }
    return { repo, commits }
  }

  const recordOf = (commit: string, extra = {}) =>
    JSON.stringify({ schema: 'vinaya.read-record', schemaVersion: 1, commit, platform: 'linux', tests: {}, ...extra })

  /** A stand-in for gh: `artifacts` maps a commit to the text of its record file; `fail` names a call that fails. */
  function fakeGh(artifacts: Record<string, string>, fail?: 'branch' | 'list' | 'start' | 'download-timeout') {
    const calls: string[][] = []
    const envs: NodeJS.ProcessEnv[] = []
    const run: CommandRunner = (file, args, options) => {
      expect(file).toBe('gh')
      calls.push(args)
      envs.push(options.env ?? {})
      if (fail === 'start') throw Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' })
      if (args[0] === 'repo') {
        if (fail === 'branch') throw new Error('gh: not logged in')
        return JSON.stringify({ defaultBranchRef: { name: 'trunk' } })
      }
      if (args[0] === 'run' && args[1] === 'list') {
        if (fail === 'list') throw new Error('gh: HTTP 401')
        const commit = args[args.indexOf('--commit') + 1] as string
        expect(args).toContain(RECORD_WORKFLOW_FILE)
        expect(args[args.indexOf('--branch') + 1]).toBe('trunk')
        expect(args[args.indexOf('--event') + 1]).toBe('push')
        return JSON.stringify(commit in artifacts ? [{ databaseId: 7 }] : [])
      }
      if (fail === 'download-timeout') throw Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' })
      const name = args[args.indexOf('--name') + 1] as string
      const commit = name.slice(RECORD_ARTIFACT_PREFIX.length)
      if (!name.startsWith(RECORD_ARTIFACT_PREFIX) || !(commit in artifacts)) throw new Error('no artifact')
      writeFileSync(join(args[args.indexOf('--dir') + 1] as string, 'read-record.json'), artifacts[commit] as string)
      return ''
    }
    return { run, calls, envs }
  }

  it('uses the record of the base, keeps it, and uses the kept copy with no call', () => {
    const { repo, commits } = line(3)
    try {
      const base = commits[2] as string
      const gh = fakeGh({ [base]: recordOf(base) })
      const found = findReadRecord(repo, base, gh.run)
      expect(found).toMatchObject({ source: 'fetched', commit: base })
      expect(gh.calls.filter((c) => c[0] === 'repo')).toHaveLength(1)
      expect(readFileSync(join(repo, '.git/test-selection/read-records', `${base}.json`), 'utf8')).toBe(recordOf(base))
      expect(git(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('')

      const again = fakeGh({})
      expect(findReadRecord(repo, base, again.run)).toMatchObject({ source: 'kept', commit: base })
      expect(again.calls).toEqual([])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('uses the record of an earlier commit when the base has none, and starts gh with no GIT_ variable', () => {
    const { repo, commits } = line(4)
    try {
      const earlier = commits[1] as string
      const gh = fakeGh({ [earlier]: recordOf(earlier) })
      process.env.GIT_DIR = '/nowhere'
      try {
        const found = findReadRecord(repo, commits[3] as string, gh.run)
        expect(found).toMatchObject({ source: 'fetched', commit: earlier })
      } finally {
        delete process.env.GIT_DIR
      }
      expect(gh.envs.length).toBeGreaterThan(0)
      for (const env of gh.envs) expect(Object.keys(env).filter((key) => key.startsWith('GIT_'))).toEqual([])
      // The default branch was asked once, before the first fetch.
      expect(gh.calls.filter((c) => c[0] === 'repo')).toHaveLength(1)
      expect(gh.calls[0]?.[0]).toBe('repo')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('goes on after a candidate with no run, and gives a reason when no candidate has a record', () => {
    const { repo, commits } = line(3)
    try {
      const none = findReadRecord(repo, commits[2] as string, fakeGh({}).run)
      expect(none).toEqual({ record: null, reason: `no ${RECORD_WORKFLOW_FILE} push run for ${commits[2]}` })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('starts gh no more after a failing run list or default branch, and a missing gh is a reason', () => {
    const { repo, commits } = line(5)
    try {
      const base = commits[4] as string
      for (const fail of ['list', 'branch', 'start'] as const) {
        const gh = fakeGh({ [commits[0] as string]: recordOf(commits[0] as string) }, fail)
        const found = findReadRecord(repo, base, gh.run)
        expect(found.record).toBeNull()
        // The default branch, then (for a failing run list) one run list; never a second commit's.
        expect(gh.calls).toHaveLength(fail === 'list' ? 2 : 1)
      }
      // A kept record of an earlier commit is still used after gh failed.
      mkdirSync(join(repo, '.git/test-selection/read-records'), { recursive: true })
      const kept = commits[2] as string
      writeFileSync(join(repo, '.git/test-selection/read-records', `${kept}.json`), recordOf(kept))
      const gh = fakeGh({}, 'list')
      expect(findReadRecord(repo, base, gh.run)).toMatchObject({ source: 'kept', commit: kept })
      expect(gh.calls).toHaveLength(2)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('starts gh no more after a download runs out of time, and still uses a kept record', () => {
    const { repo, commits } = line(5)
    try {
      const base = commits[4] as string
      const all = Object.fromEntries(commits.map((c) => [c, recordOf(c)]))
      const gh = fakeGh(all, 'download-timeout')
      const found = findReadRecord(repo, base, gh.run)
      expect(found).toEqual({
        record: null,
        reason: `the download of ${RECORD_ARTIFACT_PREFIX}${base} ran out of time`
      })
      // The default branch, one run list, one download; never another download or another commit's runs.
      expect(gh.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual(['repo view', 'run list', 'run download'])

      mkdirSync(join(repo, '.git/test-selection/read-records'), { recursive: true })
      const kept = commits[1] as string
      writeFileSync(join(repo, '.git/test-selection/read-records', `${kept}.json`), recordOf(kept))
      const again = fakeGh(all, 'download-timeout')
      expect(findReadRecord(repo, base, again.run)).toMatchObject({ source: 'kept', commit: kept })
      expect(again.calls.filter((c) => c[1] === 'download')).toHaveLength(1)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('returns no record with a reason, and never throws, when no download folder can be made', () => {
    const { repo, commits } = line(3)
    const saved = process.env.TMPDIR
    try {
      const base = commits[2] as string
      const gh = fakeGh({ [base]: recordOf(base) })
      process.env.TMPDIR = join(repo, 'no-such-folder', 'deeper')
      let found: ReturnType<typeof findReadRecord> | undefined
      expect(() => {
        found = findReadRecord(repo, base, gh.run)
      }).not.toThrow()
      expect(found?.record).toBeNull()
      expect(found).toMatchObject({ reason: expect.stringContaining('no download folder can be made') })
      expect(gh.calls.filter((c) => c[1] === 'download')).toEqual([])
      expect(gh.calls.filter((c) => c[1] === 'list')).toHaveLength(1)
    } finally {
      if (saved === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = saved
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('refuses a file that is not a record and a record of another commit, and keeps neither', () => {
    const { repo, commits } = line(3)
    try {
      const base = commits[2] as string
      const other = commits[1] as string
      const gh = fakeGh({ [base]: '{ "not": "a record" }', [other]: recordOf(commits[0] as string) })
      const found = findReadRecord(repo, base, gh.run)
      expect(found.record).toBeNull()
      expect(found).toMatchObject({ reason: `the fetched file is not a read record of ${base}` })
      expect(() => readFileSync(join(repo, '.git/test-selection/read-records', `${base}.json`))).toThrow()
      expect(() => readFileSync(join(repo, '.git/test-selection/read-records', `${other}.json`))).toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('looks through the base and nine commits before it, no further', () => {
    const { repo, commits } = line(12)
    try {
      const base = commits[11] as string
      const tooFar = fakeGh({ [commits[1] as string]: recordOf(commits[1] as string) })
      expect(findReadRecord(repo, base, tooFar.run).record).toBeNull()
      expect(tooFar.calls.filter((c) => c[1] === 'list')).toHaveLength(10)
      const reached = fakeGh({ [commits[2] as string]: recordOf(commits[2] as string) })
      expect(findReadRecord(repo, base, reached.run)).toMatchObject({ commit: commits[2] })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
