import { describe, expect, it } from 'bun:test'
import { type GhRunner, readTaskIssue, RETRY_WAITS_MS } from './task-issue-read'

const ARGS = ['issue', 'view', '7', '-R', 'o/r', '--json', 'number,state,body,labels']
const ISSUE = { number: 7, state: 'OPEN', body: 'b', labels: [] }
const CONNECTION = 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: i/o timeout\n'
const MISSING = 'GraphQL: Could not resolve to an issue or pull request with the number of 7. (repository.issue)\n'

/** A fake `gh` that answers each call from the script in order; an `Error` entry throws its message. */
function scripted(answers: Array<string | Error>): { run: GhRunner; calls: () => number } {
  let n = 0
  return {
    run: () => {
      const answer = answers[Math.min(n, answers.length - 1)] as string | Error
      n += 1
      if (answer instanceof Error) throw answer
      return answer
    },
    calls: () => n
  }
}

function setup(answers: Array<string | Error>) {
  const gh = scripted(answers)
  const waits: number[] = []
  const cache = new Map<string, unknown>()
  return { gh, waits, deps: { run: gh.run, sleep: (ms: number) => waits.push(ms), cache } }
}

describe('readTaskIssue', () => {
  it('reads the Issue and goes on after a connection failure then a success', () => {
    const t = setup([new Error(CONNECTION), JSON.stringify(ISSUE)])
    expect(readTaskIssue(ARGS, t.deps)).toEqual({ outcome: 'read', issue: ISSUE })
    expect(t.waits).toEqual([10_000])
    expect(t.gh.calls()).toBe(2)
  })

  it('fails after the three waits when the connection failure persists, keeping gh stderr verbatim', () => {
    const t = setup([new Error(CONNECTION)])
    expect(readTaskIssue(ARGS, t.deps)).toEqual({ outcome: 'failed', error: CONNECTION })
    expect(t.waits).toEqual([...RETRY_WAITS_MS])
    expect(t.waits).toEqual([10_000, 30_000, 60_000])
    expect(t.gh.calls()).toBe(4)
  })

  it('fails at once, with no wait, on any other failure', () => {
    const text = 'failed to run git: fatal: not a git repository\n'
    const t = setup([new Error(text)])
    expect(readTaskIssue(ARGS, t.deps)).toEqual({ outcome: 'failed', error: text })
    expect(t.waits).toEqual([])
    expect(t.gh.calls()).toBe(1)
  })

  it('fails at once on a bare timeout line that names no GitHub host', () => {
    const t = setup([new Error('dial tcp: i/o timeout')])
    expect(readTaskIssue(ARGS, t.deps).outcome).toBe('failed')
    expect(t.waits).toEqual([])
  })

  it('reports the missing-Issue text as missing, with no wait and no retry', () => {
    const t = setup([new Error(MISSING)])
    expect(readTaskIssue(ARGS, t.deps)).toEqual({ outcome: 'missing' })
    expect(t.waits).toEqual([])
    expect(t.gh.calls()).toBe(1)
  })

  it('fails when gh prints output that is not JSON', () => {
    const t = setup(['not json'])
    expect(readTaskIssue(ARGS, t.deps).outcome).toBe('failed')
  })

  it('does not remember a failed read: the next read of the same Issue reaches the runner again', () => {
    const t = setup([new Error('failed to run git: fatal: not a git repository'), JSON.stringify(ISSUE)])
    expect(readTaskIssue(ARGS, t.deps).outcome).toBe('failed')
    expect(readTaskIssue(ARGS, t.deps)).toEqual({ outcome: 'read', issue: ISSUE })
    expect(t.gh.calls()).toBe(2)
  })

  it('remembers a successful read', () => {
    const t = setup([JSON.stringify(ISSUE)])
    readTaskIssue(ARGS, t.deps)
    expect(readTaskIssue(ARGS, t.deps)).toEqual({ outcome: 'read', issue: ISSUE })
    expect(t.gh.calls()).toBe(1)
  })

  it('makes one attempt only when retry is off', () => {
    const t = setup([new Error(CONNECTION)])
    expect(readTaskIssue(ARGS, { ...t.deps, retry: false }).outcome).toBe('failed')
    expect(t.waits).toEqual([])
    expect(t.gh.calls()).toBe(1)
  })
})
