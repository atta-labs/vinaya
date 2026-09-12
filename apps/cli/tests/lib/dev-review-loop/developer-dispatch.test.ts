import { describe, expect, it } from 'vitest'
import { developerBranchFor } from '../../../src/lib/dev-review-loop/developer-dispatch'

// task-run-v1 task 15, O1: `developerBranchFor` derives `task/issue-<n>` for
// a backlog Issue (no `[<tranche>] <n> — …` title, no `vinaya/tranche:*`
// label) instead of throwing — the same function, extended to a second
// branch shape, never a synthetic tranche.

describe('developerBranchFor', () => {
  it('derives task/<tranche>/<n> from a tranche-shaped title', () => {
    const branch = developerBranchFor(
      521,
      () => '[task-run-v1] 15 — A backlog Issue runs like a task',
      () => ['vinaya/tranche:task-run-v1']
    )
    expect(branch).toBe('task/task-run-v1/15')
  })

  it('derives task/issue-<n> for a backlog Issue with no tranche-shaped title or label', () => {
    const branch = developerBranchFor(
      600,
      () => 'Fix the flaky retry loop',
      () => []
    )
    expect(branch).toBe('task/issue-600')
  })

  it('throws when the title fails to parse but the Issue still carries a tranche label — a real defect, not a backlog Issue', () => {
    expect(() =>
      developerBranchFor(
        601,
        () => 'not a tranche-shaped title',
        () => ['vinaya/tranche:some-tranche']
      )
    ).toThrow(/does not match the `\[<tranche>\] <n> — …` shape, but it carries a vinaya\/tranche:\* label/)
  })
})
