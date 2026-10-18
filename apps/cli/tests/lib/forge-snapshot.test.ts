/**
 * The forge snapshot: REST mapped to `gh --json` shape, proven against the
 * recorded fixture (`fixtures/forge-snapshot/gh-vs-rest.json`), and the
 * reading rules — honoured only in CI, served only for the number it was
 * written for, failing on a missing file instead of reading the forge.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type ForgeRunner, readIssueBody, readIssueComments } from '../../src/lib/forge-read'
import {
  BODY_FILE,
  commentsFromRest,
  FORGE_SNAPSHOT_DIR_ENV,
  ForgeSnapshotIncompleteError,
  ForgeSnapshotIssueNotFoundError,
  incompleteForgeSnapshot,
  ISSUE_COMMENTS_FILE,
  ISSUE_FILE,
  issueFromRest,
  PULL_COMMENTS_FILE,
  PULL_FILE,
  pullRequestFromRest,
  RAW_PULL_COMMENTS_FILE,
  RAW_PULL_FILE,
  type RestIssue,
  type RestPull,
  snapshotBody,
  snapshotComments,
  snapshotIssue,
  snapshotPullRequest,
  writeForgeSnapshot
} from '../../src/lib/forge-snapshot'
import type { RestComment } from '../../src/lib/forge-read'

type FixtureCase = {
  name: string
  rest: { pull: RestPull; pullComments: RestComment[][]; issue: RestIssue; issueComments: RestComment[] }
  gh: { pull: unknown; pullComments: unknown[]; issue: unknown; issueComments: unknown[] }
}

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'forge-snapshot', 'gh-vs-rest.json'), 'utf8')
) as { cases: FixtureCase[] }

let dirs: string[] = []
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    [FORGE_SNAPSHOT_DIR_ENV]: process.env[FORGE_SNAPSHOT_DIR_ENV]
  }
})

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

/** A runner that answers REST reads of the fixture's task Issue and records every call; anything else fails. */
function fixtureRunner(c: FixtureCase, calls: string[][]): ForgeRunner {
  return (args) => {
    calls.push(args)
    const path = args[1] ?? ''
    if (args[0] === 'api' && path === `repos/{owner}/{repo}/issues/${c.rest.issue.number}`) {
      return JSON.stringify(c.rest.issue)
    }
    if (args[0] === 'api' && path.startsWith(`repos/{owner}/{repo}/issues/${c.rest.issue.number}/comments?`)) {
      return JSON.stringify(path.includes('page=1') ? c.rest.issueComments : [])
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
}

function writtenSnapshot(c: FixtureCase, runner: ForgeRunner = fixtureRunner(c, [])): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-snapshot-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'raw'))
  writeFileSync(join(dir, RAW_PULL_FILE), JSON.stringify(c.rest.pull))
  writeFileSync(join(dir, RAW_PULL_COMMENTS_FILE), JSON.stringify(c.rest.pullComments))
  writeForgeSnapshot(dir, runner)
  return dir
}

const ci = (dir: string) => ({ GITHUB_ACTIONS: 'true', [FORGE_SNAPSHOT_DIR_ENV]: dir })

describe('REST to `gh --json` shape, against the recorded fixture', () => {
  for (const c of FIXTURE.cases) {
    it(`${c.name}: the pull request`, () => {
      expect(pullRequestFromRest(c.rest.pull)).toEqual(c.gh.pull as ReturnType<typeof pullRequestFromRest>)
    })
    it(`${c.name}: the task Issue`, () => {
      expect(issueFromRest(c.rest.issue)).toEqual(c.gh.issue as ReturnType<typeof issueFromRest>)
    })
    it(`${c.name}: the comments`, () => {
      expect(commentsFromRest(c.rest.pullComments.flat())).toEqual(c.gh.pullComments as never)
      expect(commentsFromRest(c.rest.issueComments)).toEqual(c.gh.issueComments as never)
    })
  }

  it('maps each named field: state uppercase, head.sha, base.ref, head.ref, user.login, bot authors', () => {
    const [open] = FIXTURE.cases
    if (!open) throw new Error('fixture has no cases')
    const pull = pullRequestFromRest(open.rest.pull)
    expect(pull.state).toBe('OPEN')
    expect(pull.headRefOid).toBe(open.rest.pull.head.sha)
    expect(pull.baseRefName).toBe(open.rest.pull.base.ref)
    expect(pull.headRefName).toBe(open.rest.pull.head.ref)
    // A GitHub App's pull request: `app/<name>` in gh's shape…
    expect(pull.author).toEqual({ login: 'app/vinaya-loop' })
    // …and its comment: the bare `<name>`.
    expect(commentsFromRest(open.rest.pullComments.flat())[1]?.author).toEqual({ login: 'github-actions' })
    expect(commentsFromRest(open.rest.pullComments.flat())[0]?.author).toEqual({ login: 'octocat' })
  })
})

describe('writeForgeSnapshot', () => {
  it('writes every file in gh shape and reads the task Issue the body closes over REST only', () => {
    const [c] = FIXTURE.cases
    if (!c) throw new Error('fixture has no cases')
    const calls: string[][] = []
    const dir = writtenSnapshot(c, fixtureRunner(c, calls))
    expect(JSON.parse(readFileSync(join(dir, PULL_FILE), 'utf8'))).toEqual(c.gh.pull)
    expect(JSON.parse(readFileSync(join(dir, PULL_COMMENTS_FILE), 'utf8'))).toEqual({
      number: c.rest.pull.number,
      comments: c.gh.pullComments
    })
    expect(JSON.parse(readFileSync(join(dir, ISSUE_FILE), 'utf8'))).toEqual(c.gh.issue)
    expect(JSON.parse(readFileSync(join(dir, ISSUE_COMMENTS_FILE), 'utf8'))).toEqual({
      number: c.rest.issue.number,
      comments: c.gh.issueComments
    })
    expect(readFileSync(join(dir, BODY_FILE), 'utf8')).toBe(c.rest.pull.body ?? '')
    expect(calls.every((a) => a[0] === 'api' && a[1]?.startsWith('repos/'))).toBe(true)
  })

  it('records a body that closes no Issue as `{ number: null }`, with no Issue read', () => {
    const [c] = FIXTURE.cases
    if (!c) throw new Error('fixture has no cases')
    const calls: string[][] = []
    const dir = writtenSnapshot(
      { ...c, rest: { ...c.rest, pull: { ...c.rest.pull, body: 'no closing line' } } },
      (a) => {
        calls.push(a)
        throw new Error('no read expected')
      }
    )
    expect(JSON.parse(readFileSync(join(dir, ISSUE_FILE), 'utf8'))).toEqual({ number: null })
    expect(calls).toEqual([])
  })

  it('records a 404 on the task Issue as notFound; any other failed read throws', () => {
    const [c] = FIXTURE.cases
    if (!c) throw new Error('fixture has no cases')
    const notFound = Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' })
    const dir = writtenSnapshot(c, () => {
      throw notFound
    })
    expect(JSON.parse(readFileSync(join(dir, ISSUE_FILE), 'utf8'))).toEqual({ number: 811, notFound: true })
    expect(() => snapshotIssue(811, ci(dir))).toThrow(ForgeSnapshotIssueNotFoundError)
    expect(() =>
      writtenSnapshot(c, () => {
        throw new Error('HTTP 403: API rate limit exceeded')
      })
    ).toThrow('rate limit')
  })
})

describe('reading the snapshot', () => {
  it('is honoured only when GITHUB_ACTIONS is `true`', () => {
    const [c] = FIXTURE.cases
    if (!c) throw new Error('fixture has no cases')
    const dir = writtenSnapshot(c)
    expect(snapshotPullRequest(812, { [FORGE_SNAPSHOT_DIR_ENV]: dir })).toBeNull()
    expect(snapshotPullRequest(812, { [FORGE_SNAPSHOT_DIR_ENV]: dir, GITHUB_ACTIONS: 'false' })).toBeNull()
    expect(snapshotPullRequest(812, ci(dir))?.headRefOid).toBe(c.rest.pull.head.sha)
  })

  it('serves a file only for the number it was written for', () => {
    const [c] = FIXTURE.cases
    if (!c) throw new Error('fixture has no cases')
    const dir = writtenSnapshot(c)
    expect(snapshotPullRequest(813, ci(dir))).toBeNull()
    expect(snapshotIssue(812, ci(dir))).toBeNull()
    expect(snapshotComments(1, ci(dir))).toBeNull()
    expect(snapshotBody(1, ci(dir))).toBeNull()
    expect(snapshotComments(811, ci(dir))).toEqual(c.gh.issueComments as never)
    expect(snapshotBody(811, ci(dir))).toBe(c.rest.issue.body ?? '')
  })

  it('a missing file fails rather than reading the forge', () => {
    const [c] = FIXTURE.cases
    if (!c) throw new Error('fixture has no cases')
    const dir = writtenSnapshot(c)
    expect(incompleteForgeSnapshot(ci(dir))).toBeNull()
    unlinkSync(join(dir, ISSUE_COMMENTS_FILE))
    expect(incompleteForgeSnapshot(ci(dir))).toContain(ISSUE_COMMENTS_FILE)
    expect(() => snapshotComments(811, ci(dir))).toThrow(ForgeSnapshotIncompleteError)
    unlinkSync(join(dir, PULL_FILE))
    expect(incompleteForgeSnapshot(ci(dir))).toContain(PULL_FILE)
    expect(() => snapshotPullRequest(812, ci(dir))).toThrow(ForgeSnapshotIncompleteError)
    expect(incompleteForgeSnapshot({ [FORGE_SNAPSHOT_DIR_ENV]: dir })).toBeNull()
  })

  it('readIssueComments and readIssueBody route there in CI and read live otherwise', () => {
    const [c] = FIXTURE.cases
    if (!c) throw new Error('fixture has no cases')
    const dir = writtenSnapshot(c)
    const calls: string[][] = []
    const live: ForgeRunner = (args) => {
      calls.push(args)
      if (args[0] === 'issue') return JSON.stringify({ body: 'live body' })
      return JSON.stringify([])
    }
    process.env.GITHUB_ACTIONS = 'true'
    process.env[FORGE_SNAPSHOT_DIR_ENV] = dir
    expect(readIssueComments(811, 'Issue 811', live)).toEqual(c.gh.issueComments as never)
    expect(readIssueBody(812, 'PR 812', live)).toBe(c.rest.pull.body ?? '')
    expect(calls).toEqual([])
    // Another number reads live.
    expect(readIssueBody(5, 'Issue 5', live)).toBe('live body')
    expect(calls).toHaveLength(1)
    delete process.env.GITHUB_ACTIONS
    expect(readIssueComments(811, 'Issue 811', live)).toEqual([])
    expect(calls).toHaveLength(2)
  })
})
