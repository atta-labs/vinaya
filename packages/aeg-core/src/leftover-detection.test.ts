import { describe, expect, it } from 'vitest'
import { classifyLeftover } from './leftover-detection'

describe('classifyLeftover', () => {
  it('is clean when nothing exists', () => {
    const result = classifyLeftover({ branchExistsRemote: false, worktreeExistsLocal: false, commitsAheadOfMain: 0 })
    expect(result.verdict).toBe('clean')
  })

  it('is stop when commits are ahead of main, regardless of branch/worktree existence', () => {
    const result = classifyLeftover({ branchExistsRemote: true, worktreeExistsLocal: true, commitsAheadOfMain: 3 })
    expect(result.verdict).toBe('stop')
    expect(result.reason).toContain('3 commit(s)')
  })

  it('is stop even with just one commit ahead', () => {
    const result = classifyLeftover({ branchExistsRemote: false, worktreeExistsLocal: true, commitsAheadOfMain: 1 })
    expect(result.verdict).toBe('stop')
  })

  it('is resume when the branch exists remotely but has zero commits ahead', () => {
    const result = classifyLeftover({ branchExistsRemote: true, worktreeExistsLocal: false, commitsAheadOfMain: 0 })
    expect(result.verdict).toBe('resume')
  })

  it('is resume when only a local worktree exists with zero commits ahead', () => {
    const result = classifyLeftover({ branchExistsRemote: false, worktreeExistsLocal: true, commitsAheadOfMain: 0 })
    expect(result.verdict).toBe('resume')
  })

  it('is resume when both branch and worktree exist with zero commits ahead', () => {
    const result = classifyLeftover({ branchExistsRemote: true, worktreeExistsLocal: true, commitsAheadOfMain: 0 })
    expect(result.verdict).toBe('resume')
  })

  it('names the open PR in the stop reason when one is given', () => {
    const result = classifyLeftover({
      branchExistsRemote: true,
      worktreeExistsLocal: false,
      commitsAheadOfMain: 2,
      openPrNumber: 1025
    })
    expect(result.verdict).toBe('stop')
    expect(result.reason).toContain('PR #1025 is already open for this task.')
  })

  it('omits the PR clause when openPrNumber is null or absent', () => {
    const withNull = classifyLeftover({
      branchExistsRemote: true,
      worktreeExistsLocal: false,
      commitsAheadOfMain: 1,
      openPrNumber: null
    })
    expect(withNull.reason).not.toContain('PR #')

    const omitted = classifyLeftover({ branchExistsRemote: true, worktreeExistsLocal: false, commitsAheadOfMain: 1 })
    expect(omitted.reason).not.toContain('PR #')
  })
})
