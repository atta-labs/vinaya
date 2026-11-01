import { describe, expect, test } from 'bun:test'
import { pullRequestCheckEnv, type PullRequestView } from '../executing/pull-request-env'

const reader = (pr: PullRequestView | Error) => (branch: string) => {
  expect(branch).toBe('task/issue-7')
  if (pr instanceof Error) throw pr
  return pr
}

describe('pullRequestCheckEnv', () => {
  test('an open pull request gives the branch, number, body and head', () => {
    const env = pullRequestCheckEnv(
      'task/issue-7',
      reader({ number: 42, body: 'Closes #7', headRefOid: 'abc123', state: 'OPEN' })
    )
    expect(env).toEqual({
      BRANCH: 'task/issue-7',
      PR_NUMBER: '42',
      PR_BODY: 'Closes #7',
      PULL_REQUEST_HEAD_SHA: 'abc123'
    })
  })

  test('a closed pull request gives the branch alone', () => {
    const env = pullRequestCheckEnv(
      'task/issue-7',
      reader({ number: 42, body: 'x', headRefOid: 'abc', state: 'MERGED' })
    )
    expect(env).toEqual({ BRANCH: 'task/issue-7' })
  })

  test('a failed read (no pull request) gives the branch alone', () => {
    expect(pullRequestCheckEnv('task/issue-7', reader(new Error('no pull requests found')))).toEqual({
      BRANCH: 'task/issue-7'
    })
  })
})
