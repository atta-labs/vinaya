import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchIssueBodyAndComments } from '../../src/commands/issue-objectives'
import { resolveBriefHashForPr } from '../../src/commands/review-post'
import {
  FORGE_READ_CEILING_BYTES,
  ForgeReadOversizeError,
  type ForgeRunner,
  isForgeReadOversize,
  readIssueBody,
  readIssueComments
} from '../../src/lib/forge-read'
import { fetchIssueComments } from '../../src/lib/dispatch-task'
import { fetchFrozenBrief, resolveIssueObjectives } from '../../src/lib/dev-review-loop/developer-dispatch'
import { fetchForgeIssueContext } from '../../src/lib/forge-write'

const COUNT = 250
const BODY_BYTES = 5 * 1024
// 250 comments of 5 KiB: 1.25 MiB of comment text, three REST pages.
const comments = Array.from({ length: COUNT }, (_, i) => ({
  body: `c${i}:`.padEnd(BODY_BYTES, 'x'),
  html_url: `https://example.test/c/${i}`,
  user: { login: 'someone' }
}))

let dir: string
let savedPath: string | undefined

const FAKE_GH = `#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
const a = process.argv.slice(2)
const dir = process.env.FAKE_GH_DIR
if (a[0] === 'api') {
  const page = Number(/[?&]page=(\\d+)/.exec(a[1])[1])
  const all = JSON.parse(readFileSync(dir + '/comments.json', 'utf8'))
  if (process.env.FAKE_GH_HUGE) process.stdout.write('[' + '"' + 'y'.repeat(Number(process.env.FAKE_GH_HUGE)) + '"]')
  else process.stdout.write(JSON.stringify(all.slice((page - 1) * 100, page * 100)))
} else if (a[0] === 'pr') {
  process.stdout.write('Closes #7')
} else {
  const json = a[a.indexOf('--json') + 1]
  const out = { number: 7, body: 'issue body', title: 't', labels: [] }
  process.stdout.write(JSON.stringify(Object.fromEntries(json.split(',').map((k) => [k, out[k]]))))
  if (a.includes('--jq')) process.exit(0)
}
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-read-'))
  writeFileSync(join(dir, 'comments.json'), JSON.stringify(comments))
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${dir}:${savedPath}`
  process.env.FAKE_GH_DIR = dir
})

afterAll(() => {
  process.env.PATH = savedPath
  process.env.FAKE_GH_DIR = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe('readIssueComments', () => {
  it('pages through more than 1 MiB of comments, every one in order exactly once', () => {
    const pages: string[] = []
    const runner: ForgeRunner = (args) => {
      pages.push(args[1] as string)
      const page = Number(/[?&]page=(\d+)/.exec(args[1] as string)?.[1])
      return JSON.stringify(comments.slice((page - 1) * 100, page * 100))
    }
    const got = readIssueComments(7, 'Issue #7', runner)
    expect(pages).toHaveLength(3)
    expect(got.map((c) => c.body.slice(0, c.body.indexOf(':')))).toEqual(comments.map((_, i) => `c${i}`))
    expect(got[0]).toEqual({
      body: comments[0]?.body ?? '',
      url: 'https://example.test/c/0',
      author: { login: 'someone' }
    })
  })

  it('asks for one more page when the last page is exactly full, and stops on the empty one', () => {
    const exact = comments.slice(0, 100)
    const runner: ForgeRunner = (args) => (/[?&]page=1\b/.test(args[1] as string) ? JSON.stringify(exact) : '[]')
    expect(readIssueComments(7, 'Issue #7', runner)).toHaveLength(100)
  })

  it('refuses with a typed error naming the subject, the ceiling and the observed size', () => {
    const runner: ForgeRunner = () => 'x'.repeat(FORGE_READ_CEILING_BYTES + 1)
    let caught: unknown
    try {
      readIssueComments(7, 'Issue #7', runner)
    } catch (err) {
      caught = err
    }
    expect(isForgeReadOversize(caught)).toBe(true)
    const e = caught as ForgeReadOversizeError
    expect(e.subject).toBe('Issue #7')
    expect(e.ceilingBytes).toBe(FORGE_READ_CEILING_BYTES)
    expect(e.observedBytes).toBe(FORGE_READ_CEILING_BYTES + 1)
    expect(e.message).toMatch(/Issue #?7/)
    expect(e.message).toContain(String(FORGE_READ_CEILING_BYTES))
  })

  it('counts the pages together against the one ceiling', () => {
    const page = JSON.stringify(Array.from({ length: 100 }, () => ({ body: 'z'.repeat(1024 * 1024) })))
    const runner: ForgeRunner = () => page
    expect(() => readIssueComments(7, 'Issue #7', runner)).toThrow(ForgeReadOversizeError)
  })

  it('turns a spawn buffer overflow into the typed refusal', () => {
    const runner: ForgeRunner = () => {
      throw Object.assign(new Error('spawnSync gh ENOBUFS'), { code: 'ENOBUFS' })
    }
    expect(() => readIssueComments(7, 'Issue #7', runner)).toThrow(ForgeReadOversizeError)
    expect(() => readIssueBody(7, 'Issue #7', runner)).toThrow(ForgeReadOversizeError)
  })

  it('passes any other gh failure through unchanged', () => {
    const runner: ForgeRunner = () => {
      throw new Error('HTTP 404 Not Found')
    }
    expect(() => readIssueComments(7, 'Issue #7', runner)).toThrow('HTTP 404 Not Found')
  })
})

describe('callers over 1 MiB of comments', () => {
  it('forge-write context (issue write and edit gate)', () => {
    const ctx = fetchForgeIssueContext('7', 'retry')
    expect(ctx.body).toBe('issue body')
    expect(ctx.comments).toHaveLength(COUNT)
  })

  it('dispatch lookup for an existing brief', () => {
    expect(fetchIssueComments(7)).toHaveLength(COUNT)
  })

  it('developer dispatch: frozen brief and objectives readers reach the no-brief refusal, not a buffer error', () => {
    expect(() => fetchFrozenBrief(7)).toThrow('carries no principal-authored, frozen')
    expect(() => resolveIssueObjectives(7)).toThrow('carries no principal-authored, frozen')
  })

  it('review publication binding the frozen brief', () => {
    expect(resolveBriefHashForPr('9', [])).toBeNull()
  })

  it('objectives reader', () => {
    const got = fetchIssueBodyAndComments('7')
    expect(got.number).toBe(7)
    expect(got.comments).toHaveLength(COUNT)
  })

  it('body reader', () => {
    expect(readIssueBody(7)).toBe('issue body')
  })
})

describe('callers over the ceiling', () => {
  it('end in the same typed refusal text, never a raw buffer error', () => {
    process.env.FAKE_GH_HUGE = String(FORGE_READ_CEILING_BYTES + 1024)
    try {
      for (const read of [
        () => fetchForgeIssueContext('7', 'retry'),
        () => fetchIssueComments(7),
        () => fetchFrozenBrief(7),
        () => resolveIssueObjectives(7),
        () => fetchIssueBodyAndComments('7'),
        () => resolveBriefHashForPr('9', [])
      ]) {
        let message = ''
        const realErr = process.stderr.write.bind(process.stderr)
        const realOut = process.stdout.write.bind(process.stdout)
        const seen: string[] = []
        process.stderr.write = ((s: string) => (seen.push(String(s)), true)) as typeof process.stderr.write
        process.stdout.write = ((s: string) => (seen.push(String(s)), true)) as typeof process.stdout.write
        const realExit = process.exit
        process.exit = (() => {
          throw new Error('exit')
        }) as typeof process.exit
        try {
          read()
        } catch (err) {
          message = (err as Error).message
        } finally {
          process.exit = realExit
          process.stderr.write = realErr
          process.stdout.write = realOut
        }
        const text = `${message}\n${seen.join('\n')}`
        expect(text).toContain('read ceiling')
        expect(text).toMatch(/Issue #?7/)
        expect(text).not.toContain('ENOBUFS')
      }
    } finally {
      process.env.FAKE_GH_HUGE = undefined
    }
  })
})
