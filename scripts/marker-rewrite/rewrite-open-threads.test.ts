import { describe, expect, test } from 'bun:test'
import {
  CLAIM_ANCHOR,
  DEVELOPER_ROUND_MARKER,
  FROZEN_BRIEF_MARKER,
  LOOP_PUBLISHED_MARKER,
  type MarkerSpelling,
  OBJECTIVES_VERSION_MARKER,
  PRINCIPAL_RULING_MARKER,
  PROVENANCE_HEADING,
  QUOTES_FILE_ANCHOR,
  REGION_PREFIX,
  VENDOR_EXAMPLE_ANCHOR
} from '../../harness/processes/vinaya-strict/tools/legacy-markers'
import {
  type EditRefusal,
  type Forge,
  type GhRunner,
  ghForge,
  main,
  type OpenThread,
  repoFromRemoteUrl,
  rewriteMarkers,
  type ThreadComment
} from './rewrite-open-threads'

type Spelling = 'old' | 'current'

/**
 * A body carrying every marker family in one spelling, plus the same markers
 * quoted in fenced and inline code (which always keep the old spelling: code
 * is never a marker). Built from the legacy-spelling module, so the test
 * restates no spelling either.
 */
function fixtureBody(spelling: Spelling): string {
  const s = (family: MarkerSpelling) => family[spelling]
  const region = s(REGION_PREFIX)
  return [
    `<!-- ${region}:CLOSES:START -->`,
    'Closes #12',
    `<!-- ${region}:CLOSES:END -->`,
    '',
    `<!--${region}:EVIDENCE:START-->`,
    'Some evidence text, unchanged.',
    `<!--  ${region}:EVIDENCE:END  -->`,
    '',
    `${s(PROVENANCE_HEADING)}`,
    '',
    `<!-- ${s(CLAIM_ANCHOR)}: docs/a.md contains:literal text -->`,
    `<!-- ${s(QUOTES_FILE_ANCHOR)}:START:docs/b.md -->`,
    `<!-- ${s(QUOTES_FILE_ANCHOR)}:END -->`,
    `<!-- ${s(VENDOR_EXAMPLE_ANCHOR)}:START -->`,
    `<!-- ${s(VENDOR_EXAMPLE_ANCHOR)}:END -->`,
    '',
    'Prose mentioning the old prefix word alone stays: ' +
      REGION_PREFIX.old +
      ' and ' +
      PROVENANCE_HEADING.old.slice(4) +
      '.',
    '',
    '```',
    `<!-- ${REGION_PREFIX.old}:CLOSES:START -->`,
    `${PROVENANCE_HEADING.old}`,
    `<!-- ${FROZEN_BRIEF_MARKER.old}:v1 -->`,
    '```',
    '',
    `Inline \`<!-- ${REGION_PREFIX.old}:TIER:START -->\` stays too.`,
    ''
  ].join('\r\n')
}

function commentBody(spelling: Spelling): string {
  return [
    `<!-- ${DEVELOPER_ROUND_MARKER[spelling]}-3 -->`,
    'Round notes.',
    `<!-- ${LOOP_PUBLISHED_MARKER[spelling]} head=abc1234 confidence=80 -->`,
    `Quoted: \`<!-- ${PRINCIPAL_RULING_MARKER.old}:12-1 -->\``
  ].join('\n')
}

describe('rewriteMarkers', () => {
  test('rewrites every family outside code and leaves every other byte unchanged', () => {
    const { body, count } = rewriteMarkers(fixtureBody('old'))
    expect(body).toBe(fixtureBody('current'))
    expect(count).toBe(10)
  })

  test('rewrites forge comment markers and keeps a quoted one', () => {
    expect(rewriteMarkers(commentBody('old'))).toEqual({ body: commentBody('current'), count: 2 })
  })

  test('first-line markers of each named comment family move', () => {
    for (const family of [FROZEN_BRIEF_MARKER, PRINCIPAL_RULING_MARKER, OBJECTIVES_VERSION_MARKER]) {
      const old = `<!-- ${family.old}:v2 -->\nbody`
      expect(rewriteMarkers(old)).toEqual({ body: `<!-- ${family.current}:v2 -->\nbody`, count: 1 })
    }
  })

  test('a body already in the current spelling, or with no markers, is unchanged', () => {
    expect(rewriteMarkers(fixtureBody('current')).count).toBe(0)
    expect(rewriteMarkers('plain text').count).toBe(0)
  })
})

type StoredThread = OpenThread & { comments: ThreadComment[] }

/** An in-memory forge with the REST semantics the program relies on. */
function fakeForge(threads: StoredThread[], options: { refusedComments?: number[]; rateLimitAfter?: number } = {}) {
  const calls = { commentReads: [] as number[], edits: [] as string[] }
  const refuse = (): EditRefusal | null => {
    if (options.rateLimitAfter !== undefined && calls.edits.length >= options.rateLimitAfter) {
      return { kind: 'rate-limited', detail: 'HTTP 403: API rate limit exceeded' }
    }
    return null
  }
  const forge: Forge = {
    listOpenThreads: () =>
      threads.filter((thread) => thread.state === 'open').map(({ comments: _c, ...thread }) => ({ ...thread })),
    listComments: (number) => {
      calls.commentReads.push(number)
      return (threads.find((thread) => thread.number === number)?.comments ?? []).map((comment) => ({ ...comment }))
    },
    updateThreadBody: (number, body) => {
      const refusal = refuse()
      if (refusal) return refusal
      const thread = threads.find((candidate) => candidate.number === number) as StoredThread
      if (thread.state !== 'open') throw new Error(`edited closed thread ${number}`)
      thread.body = body
      calls.edits.push(`body:${number}`)
      return null
    },
    updateComment: (id, body) => {
      const refusal = refuse()
      if (refusal) return refusal
      if (options.refusedComments?.includes(id)) return { kind: 'refused', detail: 'HTTP 403: Resource not accessible' }
      for (const thread of threads) {
        const comment = thread.comments.find((candidate) => candidate.id === id)
        if (comment) {
          if (thread.state !== 'open') throw new Error(`edited a comment on closed thread ${thread.number}`)
          comment.body = body
          calls.edits.push(`comment:${id}`)
          return null
        }
      }
      throw new Error(`no comment ${id}`)
    }
  }
  return { forge, calls }
}

function sampleThreads(): StoredThread[] {
  const url = (n: number) => `https://github.com/o/r/issues/${n}`
  return [
    {
      number: 1,
      state: 'open',
      isPullRequest: false,
      htmlUrl: url(1),
      body: `<!-- ${FROZEN_BRIEF_MARKER.old}:v1 -->\nbrief`,
      comments: [{ id: 101, htmlUrl: `${url(1)}#issuecomment-101`, body: commentBody('old') }]
    },
    {
      number: 2,
      state: 'open',
      isPullRequest: true,
      htmlUrl: 'https://github.com/o/r/pull/2',
      body: fixtureBody('old'),
      comments: [
        { id: 201, htmlUrl: 'https://github.com/o/r/pull/2#issuecomment-201', body: 'no markers here' },
        { id: 202, htmlUrl: 'https://github.com/o/r/pull/2#issuecomment-202', body: `${PROVENANCE_HEADING.old}\nx` }
      ]
    },
    {
      number: 3,
      state: 'closed',
      isPullRequest: true,
      htmlUrl: 'https://github.com/o/r/pull/3',
      body: fixtureBody('old'),
      comments: [{ id: 301, htmlUrl: 'https://github.com/o/r/pull/3#issuecomment-301', body: commentBody('old') }]
    },
    {
      number: 4,
      state: 'closed',
      isPullRequest: false,
      htmlUrl: url(4),
      body: `<!-- ${FROZEN_BRIEF_MARKER.old}:v1 -->`,
      comments: []
    }
  ]
}

function runMain(forge: Forge, argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = main(
    ['--repo', 'o/r', ...argv],
    () => forge,
    (line) => out.push(line),
    (line) => err.push(line)
  )
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('the program against a fake forge', () => {
  test('a dry run changes nothing and prints each body and comment with its marker count', () => {
    const threads = sampleThreads()
    const before = JSON.stringify(threads)
    const { forge, calls } = fakeForge(threads)
    const { code, out } = runMain(forge, ['--dry-run'])
    expect(code).toBe(0)
    expect(calls.edits).toEqual([])
    expect(JSON.stringify(threads)).toBe(before)
    expect(out).toContain('#1 (Issue) https://github.com/o/r/issues/1')
    expect(out).toContain('  would rewrite body: 1 marker')
    expect(out).toContain('  would rewrite comment https://github.com/o/r/issues/1#issuecomment-101: 2 markers')
    expect(out).toContain('#2 (pull request) https://github.com/o/r/pull/2')
    expect(out).toContain('  would rewrite body: 10 markers')
    expect(out).toContain('  would rewrite comment https://github.com/o/r/pull/2#issuecomment-202: 1 marker')
    expect(out).not.toContain('issuecomment-201')
    expect(out).not.toContain('/pull/3')
    expect(out).not.toContain('/issues/4')
  })

  test('a real run edits open bodies and comments in place byte-for-byte, never a closed one, and a second run is empty', () => {
    const threads = sampleThreads()
    const closedBefore = JSON.stringify(threads.filter((thread) => thread.state === 'closed'))
    const { forge, calls } = fakeForge(threads)
    const first = runMain(forge, [])
    expect(first.code).toBe(0)
    expect(calls.edits).toEqual(['body:1', 'comment:101', 'body:2', 'comment:202'])
    expect(threads[0]?.body).toBe(`<!-- ${FROZEN_BRIEF_MARKER.current}:v1 -->\nbrief`)
    expect(threads[0]?.comments[0]?.body).toBe(commentBody('current'))
    expect(threads[1]?.body).toBe(fixtureBody('current'))
    expect(threads[1]?.comments[0]?.body).toBe('no markers here')
    expect(threads[1]?.comments[1]?.body).toBe(`${PROVENANCE_HEADING.current}\nx`)
    expect(JSON.stringify(threads.filter((thread) => thread.state === 'closed'))).toBe(closedBefore)
    expect(calls.commentReads).not.toContain(3)
    expect(calls.commentReads).not.toContain(4)

    const second = runMain(forge, [])
    expect(second.code).toBe(0)
    expect(second.out).toBe('nothing to rewrite on open Issues and pull requests')
    expect(calls.edits).toHaveLength(4)
  })

  test('a comment the token may not edit is reported by its link and skipped, and the run exits non-zero', () => {
    const threads = sampleThreads()
    const { forge, calls } = fakeForge(threads, { refusedComments: [101] })
    const { code, out } = runMain(forge, [])
    expect(code).toBe(1)
    expect(out).toContain('skipped https://github.com/o/r/issues/1#issuecomment-101: the edit was refused')
    expect(calls.edits).toEqual(['body:1', 'body:2', 'comment:202'])
    expect(threads[0]?.comments[0]?.body).toBe(commentBody('old'))
  })

  test('a rate-limit answer stops the run at once with a non-zero exit', () => {
    const { forge, calls } = fakeForge(sampleThreads(), { rateLimitAfter: 1 })
    const { code, out } = runMain(forge, [])
    expect(code).toBe(2)
    expect(calls.edits).toEqual(['body:1'])
    expect(out).toContain('stopped: HTTP 403: API rate limit exceeded')
  })
})

describe('the gh-backed forge', () => {
  test('reads open threads and their comments over paginated REST and edits in place with PATCH', () => {
    const calls: { args: string[]; input?: string }[] = []
    const gh: GhRunner = (args, input) => {
      calls.push({ args, input })
      const path = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (path.startsWith('repos/o/r/issues?')) {
        return {
          status: 0,
          stdout: `${JSON.stringify({ number: 7, state: 'open', html_url: 'u7', body: null, is_pull_request: true })}\n`,
          stderr: ''
        }
      }
      if (path === 'repos/o/r/issues/7/comments?per_page=100') {
        return { status: 0, stdout: `${JSON.stringify({ id: 9, html_url: 'c9', body: 'x' })}\n`, stderr: '' }
      }
      if (path === 'repos/o/r/issues/comments/9') return { status: 1, stdout: '', stderr: 'gh: Forbidden (HTTP 403)' }
      return { status: 0, stdout: '{}', stderr: '' }
    }
    const forge = ghForge('o/r', gh)
    expect(forge.listOpenThreads()).toEqual([
      { number: 7, state: 'open', isPullRequest: true, htmlUrl: 'u7', body: '' }
    ])
    expect(forge.listComments(7)).toEqual([{ id: 9, htmlUrl: 'c9', body: 'x' }])
    const body = 'line\r\n"quoted" \\ `code`\n'
    expect(forge.updateThreadBody(7, body)).toBeNull()
    expect(forge.updateComment(9, body)).toEqual({ kind: 'refused', detail: 'gh: Forbidden (HTTP 403)' })

    for (const { args } of calls) {
      expect(args[0]).toBe('api')
      expect(args).not.toContain('graphql')
    }
    expect(calls[0]?.args).toContain('--paginate')
    expect(calls[0]?.args).toContain('repos/o/r/issues?state=open&per_page=100')
    expect(calls[1]?.args).toContain('--paginate')
    expect(calls[2]?.args).toEqual(expect.arrayContaining(['-X', 'PATCH', 'repos/o/r/issues/7', '--input', '-']))
    expect(JSON.parse(calls[2]?.input ?? '')).toEqual({ body })
    expect(calls[3]?.args).toEqual(expect.arrayContaining(['-X', 'PATCH', 'repos/o/r/issues/comments/9']))
  })

  test('a rate-limited read stops the run with a non-zero exit', () => {
    const gh: GhRunner = () => ({ status: 1, stdout: '', stderr: 'gh: API rate limit exceeded for user (HTTP 403)' })
    const err: string[] = []
    const code = main(
      ['--repo', 'o/r', '--dry-run'],
      (repo) => ghForge(repo, gh),
      () => {},
      (line) => err.push(line)
    )
    expect(code).toBe(2)
    expect(err.join('\n')).toContain('REST rate limit reached')
  })

  test('a rate-limited edit is a stop, not a skip', () => {
    const gh: GhRunner = () => ({
      status: 1,
      stdout: '',
      stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)'
    })
    expect(ghForge('o/r', gh).updateComment(1, 'x')?.kind).toBe('rate-limited')
  })
})

describe('arguments', () => {
  test('repoFromRemoteUrl reads ssh and https origins', () => {
    expect(repoFromRemoteUrl('git@github.com:atta-labs/vinaya.git\n')).toBe('atta-labs/vinaya')
    expect(repoFromRemoteUrl('https://github.com/atta-labs/vinaya')).toBe('atta-labs/vinaya')
    expect(repoFromRemoteUrl('https://example.com/x')).toBeNull()
  })

  test('an unknown argument is a usage error', () => {
    const { forge } = fakeForge([])
    expect(runMain(forge, ['--bogus']).code).toBe(2)
  })
})
