import { describe, expect, mock, test } from 'bun:test'
import type { Task } from '@attalabs/aeg-types'

let sent: string[] = []
let respond: (query: string) => unknown = () => ({ repository: {} })

mock.module('@octokit/graphql', () => ({
  graphql: { defaults: () => async (query: string) => respond(query) }
}))
mock.module('../src/github-token', () => ({ resolveGithubToken: async () => 'token' }))

const { fetchForgeFacts, fetchForgeFactsByIssue } = await import('../src/fetch-forge-facts')
const { resolveDuplicateTasks } = await import('../src/list-tasks')

const task = (id: string, issue: number): Task => ({
  id,
  title: 't',
  issue,
  projects: [],
  dependsOn: [],
  conflictsWith: [],
  rationaleMarkdown: ''
})

const issueNode = (state: 'OPEN' | 'CLOSED', stateReason: string | null) => ({
  state,
  stateReason,
  closedAt: state === 'CLOSED' ? '2026-01-01T00:00:00Z' : null,
  assignees: { totalCount: 0 },
  labels: { nodes: [] },
  timelineItems: { nodes: [] }
})

describe('resolveDuplicateTasks', () => {
  const tasks = [task('3', 10), task('3', 12), task('4', 11)]

  test('an open Issue beats a closed not-planned one of the same number', () => {
    const r = resolveDuplicateTasks(tasks, (n) => n === 12)
    expect(r.conflicts).toEqual([])
    expect(r.tasks.map((t) => [t.id, t.issue])).toEqual([
      ['3', 12],
      ['4', 11]
    ])
  })

  test('the open Issue wins even when it has the lower number', () => {
    const r = resolveDuplicateTasks(tasks, (n) => n === 10)
    expect(r.tasks.find((t) => t.id === '3')?.issue).toBe(10)
  })

  test('two open Issues are a conflict naming both', () => {
    const r = resolveDuplicateTasks(tasks, () => true)
    expect(r.conflicts).toEqual([{ id: '3', issues: [10, 12] }])
  })

  test('all closed: the latest Issue stands, no conflict', () => {
    const r = resolveDuplicateTasks(tasks, () => false)
    expect(r.conflicts).toEqual([])
    expect(r.tasks.find((t) => t.id === '3')?.issue).toBe(12)
  })
})

describe('fetchForgeFacts with a duplicated task number', () => {
  test('sub-queries are named by Issue number, never colliding', async () => {
    sent = []
    respond = (q) => {
      sent.push(q)
      return {
        repository: {
          i_10_issue: issueNode('CLOSED', 'NOT_PLANNED'),
          i_10_ref: null,
          i_10_prs: { nodes: [] },
          i_12_issue: issueNode('OPEN', null),
          i_12_ref: null,
          i_12_prs: { nodes: [] }
        }
      }
    }
    const input = { owner: 'o', repo: 'r', tranche: 'x', tasks: [task('3', 10), task('3', 12)] }

    const byIssue = await fetchForgeFactsByIssue(input)
    expect(byIssue.unavailable).toBe(false)
    expect(byIssue.facts.get(10)?.issueState).toBe('closed')
    expect(byIssue.facts.get(12)?.issueState).toBe('open')
    expect(sent[0]).toContain('i_10_issue')
    expect(sent[0]).toContain('i_12_issue')
    expect(sent[0]).not.toContain('t_3')

    const snap = await fetchForgeFacts(input)
    expect(snap.facts.get('3')?.issueState).toBe('open')
  })

  test('a failed query reports its own reason', async () => {
    respond = () => {
      throw new Error('Field i_1_issue is defined more than once')
    }
    const snap = await fetchForgeFactsByIssue({ owner: 'o', repo: 'r', tranche: 'x', tasks: [task('3', 1)] })
    expect(snap.unavailable).toBe(true)
    expect(snap.reason).toContain('defined more than once')
  })
})
