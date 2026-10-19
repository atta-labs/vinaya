import { describe, expect, it } from 'vitest'
import { decideIssueAssignment } from './issue-assignment'

const base = {
  issue: 401,
  assignees: [] as string[],
  login: 'daniboomerang'
}

describe('decideIssueAssignment — fail-open guards (no signal means no action)', () => {
  it('skips when the assignee fetch failed, rather than risking a double-assign', () => {
    const result = decideIssueAssignment({ ...base, assignees: null })
    expect(result).toMatchObject({ action: 'skip', missingFact: true })
    expect(result.reason).toContain('current assignees')
  })

  it('skips when the authenticated login is unresolvable — never assigns anyone but that identity', () => {
    const result = decideIssueAssignment({ ...base, login: null })
    expect(result).toMatchObject({ action: 'skip', missingFact: true })
    expect(result.reason).toContain('authenticated')
  })

  it('skips when both facts are unknown', () => {
    const result = decideIssueAssignment({ ...base, assignees: null, login: null })
    expect(result).toMatchObject({ action: 'skip', missingFact: true })
  })
})

describe('decideIssueAssignment — idempotency', () => {
  it('no-ops when the Issue is already assigned', () => {
    const result = decideIssueAssignment({ ...base, assignees: ['daniboomerang'] })
    expect(result).toMatchObject({ action: 'skip', missingFact: false })
    expect(result.reason).toContain('already assigned')
    expect(result.reason).toContain('daniboomerang')
  })

  it('no-ops when the Issue is assigned to someone else — never re-assigns', () => {
    const result = decideIssueAssignment({ ...base, assignees: ['someone-else'] })
    expect(result).toMatchObject({ action: 'skip', missingFact: false })
    expect(result.reason).toContain('already assigned')
  })

  it('no-ops on an assigned Issue even when the identity is unknown', () => {
    const result = decideIssueAssignment({ ...base, assignees: ['someone-else'], login: null })
    expect(result).toMatchObject({ action: 'skip', missingFact: false })
  })
})

describe('decideIssueAssignment — the assign path', () => {
  it('assigns the authenticated identity when the assignees are known and empty', () => {
    const result = decideIssueAssignment(base)
    expect(result).toEqual({
      action: 'assign',
      issue: 401,
      login: 'daniboomerang',
      reason: expect.stringContaining('assigning it to @daniboomerang')
    })
  })
})
