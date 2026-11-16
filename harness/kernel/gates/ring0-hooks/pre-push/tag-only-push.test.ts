import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTagOnlyPushOfPushedCommits } from './tag-only-push.js'

const ZERO = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const reached = new Set([A])
const decide = (pushRefs: string, defaultBranch: string | null = 'main') =>
  isTagOnlyPushOfPushedCommits({ pushRefs, defaultBranch, isReached: (sha) => reached.has(sha) })
const tagLine = (sha: string) => `refs/tags/v1 ${sha} refs/tags/v1 ${ZERO}`

describe('isTagOnlyPushOfPushedCommits', () => {
  test('tags on reached commits qualify', () => {
    expect(decide(`${tagLine(A)}\n${tagLine(A)}`)).toBe(true)
  })
  test('a tag on an unreached commit does not', () => {
    expect(decide(tagLine(B))).toBe(false)
    expect(decide(`${tagLine(A)}\n${tagLine(B)}`)).toBe(false)
  })
  test('a tag deletion counts as reached', () => {
    expect(decide(`(delete) ${ZERO} refs/tags/v1 ${'c'.repeat(40)}`)).toBe(true)
  })
  test('a mixed tag and branch push does not qualify', () => {
    expect(decide(`${tagLine(A)}\nrefs/heads/x ${A} refs/heads/x ${ZERO}`)).toBe(false)
  })
  test('a refs/notes push does not qualify', () => {
    expect(decide(`refs/notes/c ${A} refs/notes/c ${ZERO}`)).toBe(false)
  })
  test('an empty ref list does not qualify', () => {
    expect(decide('')).toBe(false)
    expect(decide('\n  \n')).toBe(false)
  })
  test('no default branch does not qualify', () => {
    expect(decide(tagLine(A), null)).toBe(false)
  })
})

describe('the program', () => {
  const script = join(import.meta.dir, 'tag-only-push.ts')
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t'
      }
    }).trim()

  test('prints tags for an annotated tag on a reached commit, nothing on an unreached one', () => {
    const root = mkdtempSync(join(tmpdir(), 'tag-only-'))
    try {
      const remote = join(root, 'remote.git')
      const work = join(root, 'work')
      git(root, ['init', '--bare', '-b', 'main', remote])
      git(root, ['clone', remote, work])
      git(work, ['config', 'commit.gpgsign', 'false'])
      git(work, ['config', 'tag.gpgsign', 'false'])
      writeFileSync(join(work, 'a'), '1')
      git(work, ['add', 'a'])
      git(work, ['commit', '-m', 'one'])
      git(work, ['push', 'origin', 'HEAD:main'])
      git(work, ['fetch', 'origin'])
      const reachedCommit = git(work, ['rev-parse', 'HEAD'])
      git(work, ['tag', '-a', 'v-reached', '-m', 'r'])
      git(work, ['checkout', '-b', 'side'])
      writeFileSync(join(work, 'b'), '2')
      git(work, ['add', 'b'])
      git(work, ['commit', '-m', 'two'])
      git(work, ['tag', '-a', 'v-unreached', '-m', 'u'])
      const tagSha = (tag: string) => git(work, ['rev-parse', tag])
      expect(tagSha('v-reached')).not.toBe(reachedCommit)
      const ask = (tag: string) =>
        execFileSync('bun', [script], {
          cwd: work,
          encoding: 'utf8',
          env: { ...process.env, VINAYA_PUSH_REFS: `refs/tags/${tag} ${tagSha(tag)} refs/tags/${tag} ${ZERO}` }
        })
      expect(ask('v-reached')).toBe('tags\n')
      expect(ask('v-unreached')).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
