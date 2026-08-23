/**
 * Shared mocked-`gh` shape for every `packages/aeg-forge-state` vitest suite
 * that needs `./gh` mocked — generalised from the `vi.mock('./gh', () => ({...}))`
 * block that used to live only in `fetch-milestone.test.ts` (`vinaya-milestone-model-v1`
 * task 1). One stub per `gh.ts` export, kept in lockstep by hand — `gh.ts` is a
 * small, stable surface, so a new export there is a one-line addition here.
 *
 * Usage, in any `*.test.ts` under this package:
 *
 *   vi.mock('./gh', () => createGhMock())
 *   const gh = await import('./gh')
 *   const subject = await import('./whatever-consumes-gh')
 *
 * `createGhMock()` returns a fresh object of `vi.fn()` stubs each call — never
 * shared mutable state between test files, so one suite's `mockReturnValue`
 * can't leak into another's.
 *
 * Referencing `createGhMock` inside a `vi.mock('./gh', () => createGhMock())`
 * factory is safe under Vitest's hoisting: the restriction is on referencing
 * same-file `const`/`let` bindings (temporal-dead-zone at the hoisted call
 * site), not on imported bindings, which ESM hoists natively ahead of any
 * module's own top-level code.
 */

import { vi } from 'vitest'

export function createGhMock() {
  return {
    ghApiGet: vi.fn(),
    ghApiGetAsync: vi.fn(),
    ghApiGetAllPagesAsync: vi.fn(),
    ghApiPost: vi.fn(),
    ghApiDelete: vi.fn(),
    ghIssueListByLabel: vi.fn(),
    ghIssueListByLabelAsync: vi.fn(),
    ghIssueListByAnyLabel: vi.fn(),
    ghIssueListByAnyLabelAsync: vi.fn()
  }
}
