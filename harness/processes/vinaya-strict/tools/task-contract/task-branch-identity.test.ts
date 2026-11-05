import { describe, expect, it } from 'vitest'
import { issueBranchName, parseTaskBranchIdentity } from './task-branch-identity'

describe('parseTaskBranchIdentity', () => {
  it('parses a tranche-shaped branch', () => {
    expect(parseTaskBranchIdentity('task/task-run-v1/15')).toEqual({
      kind: 'tranche',
      tranche: 'task-run-v1',
      taskId: '15'
    })
  })

  it('parses a backlog-Issue-shaped branch', () => {
    expect(parseTaskBranchIdentity('task/issue-521')).toEqual({ kind: 'issue', issueNumber: 521 })
  })

  it('returns null for a non-task branch', () => {
    expect(parseTaskBranchIdentity('main')).toBeNull()
    expect(parseTaskBranchIdentity('fix/some-bug')).toBeNull()
  })

  it('returns null for a single-segment task branch that is not the issue- shape', () => {
    expect(parseTaskBranchIdentity('task/aeg-governance-hardening')).toBeNull()
  })

  it('returns null for a branch with more than two segments after task/', () => {
    expect(parseTaskBranchIdentity('task/aeg-governance-hardening/5d/extra')).toBeNull()
  })

  it('does not read "issue-<n>" as a tranche name — task/issue-42 is the issue shape, not tranche "issue-42" task "..."', () => {
    // task/issue-42 has only one segment after `task/`, so it can never match
    // the two-segment tranche pattern; confirms the two shapes are disjoint.
    const result = parseTaskBranchIdentity('task/issue-42')
    expect(result).toEqual({ kind: 'issue', issueNumber: 42 })
  })
})

describe('issueBranchName', () => {
  it('formats the backlog-Issue branch name', () => {
    expect(issueBranchName(521)).toBe('task/issue-521')
  })
})
