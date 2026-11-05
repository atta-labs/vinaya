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
  return {
    ghApiGet: mock(),
    ghApiGetAsync: mock(),
    ghApiGetAllPagesAsync: mock(),
    ghApiPost: mock(),
    ghApiDelete: mock(),
    ghIssueListByLabel: mock(),
    ghIssueListByLabelAsync: mock(),
    ghIssueListByAnyLabel: mock(),
    ghIssueListByAnyLabelAsync: mock()
  }
}
