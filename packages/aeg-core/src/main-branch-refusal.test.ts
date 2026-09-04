import { describe, expect, it } from 'vitest'
import { checkMainBranchRefusal } from './main-branch-refusal'

describe('main-branch refusal', () => {
  it('refuses when the symbolic current branch equals the default branch', () => {
    expect(checkMainBranchRefusal({ currentSymbolicBranch: 'main', defaultBranch: 'main' })).toEqual({
      reason: 'on-default-branch',
      severity: 'error',
      currentBranch: 'main',
      defaultBranch: 'main'
    })
  })

  it('passes on any other named branch', () => {
    expect(
      checkMainBranchRefusal({ currentSymbolicBranch: 'task/vinaya-engine-v1/9', defaultBranch: 'main' })
    ).toBeNull()
  })

  it('passes on detached HEAD even if it happened to equal the default branch name', () => {
    expect(checkMainBranchRefusal({ currentSymbolicBranch: null, defaultBranch: 'main' })).toBeNull()
  })

  it('passes on detached HEAD when the default branch is also undetermined', () => {
    expect(checkMainBranchRefusal({ currentSymbolicBranch: null, defaultBranch: null })).toBeNull()
  })

  it('fails open with a warning when the default branch cannot be determined', () => {
    expect(checkMainBranchRefusal({ currentSymbolicBranch: 'main', defaultBranch: null })).toEqual({
      reason: 'default-branch-undetermined',
      severity: 'warning',
      currentBranch: 'main',
      defaultBranch: null
    })
  })

  it('respects a non-"main" default branch name', () => {
    expect(checkMainBranchRefusal({ currentSymbolicBranch: 'trunk', defaultBranch: 'trunk' })).toEqual({
      reason: 'on-default-branch',
      severity: 'error',
      currentBranch: 'trunk',
      defaultBranch: 'trunk'
    })
  })

  it('passes a tag-only push from the default branch (#407 O2)', () => {
    expect(
      checkMainBranchRefusal({
        currentSymbolicBranch: 'main',
        defaultBranch: 'main',
        pushRefs: 'refs/tags/x abc refs/tags/x 000'
      })
    ).toBeNull()
  })

  it('refuses a push carrying a refs/heads/* remote ref from the default branch', () => {
    expect(
      checkMainBranchRefusal({
        currentSymbolicBranch: 'main',
        defaultBranch: 'main',
        pushRefs: 'refs/heads/main abc refs/heads/main def'
      })
    ).toEqual({
      reason: 'on-default-branch',
      severity: 'error',
      currentBranch: 'main',
      defaultBranch: 'main'
    })
  })

  it('refuses with no pushRefs at all, same as before (a commit, not a push)', () => {
    expect(checkMainBranchRefusal({ currentSymbolicBranch: 'main', defaultBranch: 'main', pushRefs: null })).toEqual({
      reason: 'on-default-branch',
      severity: 'error',
      currentBranch: 'main',
      defaultBranch: 'main'
    })
  })
})
