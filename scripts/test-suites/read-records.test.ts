import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CommandRunner,
  ghRecordFetch,
  nearestReachableRecord,
  RECORD_DOWNLOAD_TIMEOUT_MS,
  RECORD_FILE,
  RECORD_QUERY_TIMEOUT_MS
} from './read-records'

// Every lookup here is about record use itself, so a switch another file in the same process left set never applies.
let previousReadRecord: string | undefined
beforeEach(() => {
  previousReadRecord = process.env.VINAYA_READ_RECORD
  delete process.env.VINAYA_READ_RECORD
})
afterEach(() => {
  if (previousReadRecord === undefined) delete process.env.VINAYA_READ_RECORD
  else process.env.VINAYA_READ_RECORD = previousReadRecord
})

const record = (commit: string) =>
  JSON.stringify({ schema: 'vinaya.read-record', schemaVersion: 1, commit, platform: 'linux', tests: {} })

/** A folder outside any git checkout, so no kept record is found and every lookup goes through the fetch. */
function outside(): string {
  return mkdtempSync(join(tmpdir(), 'read-records-'))
}

it('a commit with no record of its own uses the nearest earlier commit that has one', () => {
  const root = outside()
  try {
    const asked: string[] = []
    const fetch = (commit: string) => {
      asked.push(commit)
      if (commit === 'c1') return record('c1')
      throw new Error(`no run for ${commit}`)
    }
    const reached = nearestReachableRecord(root, 'c3', fetch, 10, () => ['c3', 'c2', 'c1', 'c0'])
    expect(reached.record?.commit).toBe('c1')
    expect(reached.reason).toContain('c1, the nearest earlier commit that has one')
    // It stops at the first record and never looks further back.
    expect(asked).toEqual(['c3', 'c2', 'c1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('the exact commit wins when it has a record, and nothing in reach gives no record with the first reason', () => {
  const root = outside()
  try {
    const exact = nearestReachableRecord(
      root,
      'c3',
      (c) => record(c),
      10,
      () => ['c3', 'c2']
    )
    expect([exact.record?.commit, exact.reason.includes('nearest earlier')]).toEqual(['c3', false])
    const none = nearestReachableRecord(
      root,
      'c3',
      (c) => {
        throw new Error(`no run for ${c}`)
      },
      10,
      () => ['c3', 'c2']
    )
    expect(none.record).toBeNull()
    expect(none.reason).toContain('no run for c3')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The error a child call raises when it hits its `timeout` option. */
function timedOut(): Error {
  return Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' })
}

type Call = { commit: string; command: string; timeout: number | undefined }

/**
 * A fake `gh`: each commit has the run ids `runs` gives it, and `download` decides what the download of a commit's run
 * does — writes the record, throws a timeout, or throws another failure. Every call is kept with the limit it was given.
 */
function fakeGh(
  runs: (commit: string) => number[],
  download: (commit: string) => 'record' | 'timeout' | 'missing'
): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = []
  const run: CommandRunner = (_file, args, options) => {
    const at = (flag: string) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] ?? '') : '')
    const commit = at('--commit') || at('--name').replace('read-record-', '')
    calls.push({ commit, command: `${args[0]} ${args[1]}`, timeout: options.timeout })
    if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' } })
    if (args[1] === 'list') return JSON.stringify(runs(commit).map((databaseId) => ({ databaseId })))
    const outcome = download(commit)
    if (outcome === 'timeout') throw timedOut()
    if (outcome === 'missing') throw new Error('no artifact matches')
    writeFileSync(join(at('--dir'), RECORD_FILE), record(commit))
    return ''
  }
  return { run, calls }
}

it('the download runs under its own limit of 120 seconds and the short queries keep their twenty seconds', () => {
  const root = outside()
  try {
    const gh = fakeGh(
      () => [7],
      () => 'record'
    )
    const reached = nearestReachableRecord(root, 'c3', ghRecordFetch(root, gh.run), 10, () => ['c3'])
    expect(reached.record?.commit).toBe('c3')
    expect(RECORD_DOWNLOAD_TIMEOUT_MS).toBe(120_000)
    expect(RECORD_QUERY_TIMEOUT_MS).toBe(20_000)
    expect(gh.calls.map((c) => [c.command, c.timeout])).toEqual([
      ['repo view', 20_000],
      ['run list', 20_000],
      ['run download', 120_000]
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('a download that runs out of time names the limit, and the search stops there', () => {
  const root = outside()
  try {
    const gh = fakeGh(
      () => [1, 2, 3],
      (commit) => (commit === 'c3' ? 'timeout' : 'record')
    )
    const reached = nearestReachableRecord(root, 'c3', ghRecordFetch(root, gh.run), 10, () => ['c3', 'c2', 'c1'])
    expect(reached.record).toBeNull()
    expect(reached.downloadTimedOut).toBe(true)
    expect(reached.reason).toContain('ran out of time')
    expect(reached.reason).toContain('120 s')
    expect(reached.reason).not.toContain('holds the')
    expect(reached.reason).not.toContain('\n')
    // One download of c3: neither its other runs nor any earlier commit were tried.
    expect(gh.calls.filter((c) => c.command === 'run download')).toHaveLength(1)
    expect(gh.calls.every((c) => c.commit === 'c3' || c.command === 'repo view')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('a commit with no record yet passes the search on, and a later download timeout gives its reason', () => {
  const root = outside()
  try {
    const gh = fakeGh(
      (commit) => (commit === 'c3' ? [] : [5]),
      (commit) => (commit === 'c2' ? 'timeout' : 'record')
    )
    const reached = nearestReachableRecord(root, 'c3', ghRecordFetch(root, gh.run), 10, () => ['c3', 'c2', 'c1'])
    expect(reached.record).toBeNull()
    expect(reached.reason).toContain('the download of the record of c2 ran out of time')
    expect(gh.calls.some((c) => c.commit === 'c1')).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('a download that fails for another cause tries the next run and still walks on to an earlier commit', () => {
  const root = outside()
  try {
    const gh = fakeGh(
      () => [1, 2],
      (commit) => (commit === 'c1' ? 'record' : 'missing')
    )
    const reached = nearestReachableRecord(root, 'c3', ghRecordFetch(root, gh.run), 10, () => ['c3', 'c2', 'c1'])
    expect(reached.record?.commit).toBe('c1')
    expect(gh.calls.filter((c) => c.command === 'run download' && c.commit === 'c3')).toHaveLength(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('a short query that runs out of time keeps its reason and the search walks on', () => {
  const root = outside()
  try {
    const asked: string[] = []
    const run: CommandRunner = (_file, args) => {
      if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: 'main' } })
      asked.push(args[args.indexOf('--commit') + 1] ?? '')
      throw timedOut()
    }
    const reached = nearestReachableRecord(root, 'c3', ghRecordFetch(root, run), 10, () => ['c3', 'c2'])
    expect(reached.record).toBeNull()
    expect(reached.downloadTimedOut).toBeUndefined()
    expect(reached.reason).toContain('gh run list failed')
    expect(asked).toEqual(['c3', 'c2'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
