/**
 * Shared mocked-`gh` shape for every `harness/processes/vinaya-strict/tools/task-contract/forge` vitest suite
 * that needs `./gh` mocked — generalised from the `mock.module('./gh', () => ({...}))`
 * block that used to live only in `fetch-milestone.test.ts`. One stub per `gh.ts` export, kept in lockstep by hand — `gh.ts` is a
 * small, stable surface, so a new export there is a one-line addition here.
 *
 * Usage, in any `*.test.ts` under this package:
 *
 *   mock.module('./gh', () => createGhMock())
 *   const gh = await import('./gh')
 *   const subject = await import('./whatever-consumes-gh')
 *
 * `createGhMock()` returns a fresh object of `mock()` stubs each call — never
 * shared mutable state between test files, so one suite's `mockReturnValue`
 * can't leak into another's.
 *
 * Referencing `createGhMock` inside a `mock.module('./gh', () => createGhMock())`
 * factory is safe under Vitest's hoisting: the restriction is on referencing
 * same-file `const`/`let` bindings (temporal-dead-zone at the hoisted call
 * site), not on imported bindings, which ESM hoists natively ahead of any
 * module's own top-level code.
 */

import { mock } from 'bun:test'

export function createGhMock() {
  const gh = {
    ghApiGet: mock(),
    ghApiGetAsync: mock(),
    ghApiGetAllPagesAsync: mock(),
    ghApiPost: mock(),
    ghApiDelete: mock(),
    ghIssueListByLabel: mock(),
    ghIssueListByLabelAsync: mock(),
    ghIssueListByAnyLabel: mock(),
    ghIssueListByAnyLabelAsync: mock(),
    ghLabelIssueCountsAsync: mock()
  }
  // By default the label counts follow whatever this suite's own label list
  // and Issue-list stubs answer, so a suite that stubs `ghIssueListByLabelAsync`
  // per label gets matching counts without stubbing the counts query too. The
  // stub calls it makes are struck from their call records the moment they
  // are made, so a suite counting the reader's own Issue-list reads sees only
  // those.
  gh.ghLabelIssueCountsAsync.mockImplementation(async (owner: string, repo: string, labelQuery: string) => {
    const labelsRead = gh.ghApiGetAllPagesAsync(`repos/${owner}/${repo}/labels?per_page=100`)
    gh.ghApiGetAllPagesAsync.mock.calls.pop()
    const labels = ((await labelsRead) ?? []) as Array<{ name: string }>
    const counts: Array<{ name: string; open: number; total: number }> = []
    for (const { name } of labels) {
      if (!name.startsWith(labelQuery)) continue
      const issuesRead = gh.ghIssueListByLabelAsync(owner, repo, name)
      gh.ghIssueListByLabelAsync.mock.calls.pop()
      const issues = ((await issuesRead) ?? []) as Array<{ state: string }>
      counts.push({ name, open: issues.filter((i) => i.state === 'OPEN').length, total: issues.length })
    }
    return counts
  })
  return gh
}
