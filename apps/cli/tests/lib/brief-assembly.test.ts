import { describe, expect, it } from 'bun:test'
import { resolveBoundaryPaths } from '../../src/lib/brief-assembly.js'

/**
 * `resolveBoundaryPaths` — the impure-adjacent half of task 5 (Issue #447,
 * O3): resolving `extractBoundaryFilePaths` tokens (tested purely in
 * `packages/aeg-core/src/brief-render.test.ts`) against a real `git
 * ls-files` snapshot. The snapshot is injected here so this stays a fast,
 * network-free unit test.
 */
describe('resolveBoundaryPaths', () => {
  it('resolves a full repo-relative path via an exact match', () => {
    const files = ['apps/cli/src/lib/dispatch-task.ts', 'apps/cli/src/lib/brief-assembly.ts']
    expect(resolveBoundaryPaths(['apps/cli/src/lib/dispatch-task.ts'], files)).toEqual([
      'apps/cli/src/lib/dispatch-task.ts'
    ])
  })

  it('resolves a bare filename elided from a shared directory prefix via a unique suffix match', () => {
    const files = ['aeg-root/roles/developer.md', 'aeg-root/process.md', 'aeg-root/aeg-manual-flow.md']
    expect(resolveBoundaryPaths(['process.md'], files)).toEqual(['aeg-root/process.md'])
    expect(resolveBoundaryPaths(['roles/developer.md'], files)).toEqual(['aeg-root/roles/developer.md'])
  })

  it('drops a token with zero matches, never guessing a new/renamed path', () => {
    expect(resolveBoundaryPaths(['this-file-does-not-exist.ts'], ['apps/cli/src/lib/dispatch-task.ts'])).toEqual([])
  })

  it('drops an ambiguous token that suffix-matches more than one tracked file', () => {
    const files = ['apps/cli/src/commands/brief.ts', 'apps/aeg-core/src/other/brief.ts']
    expect(resolveBoundaryPaths(['brief.ts'], files)).toEqual([])
  })

  it('deduplicates when two tokens resolve to the same tracked file', () => {
    const files = ['aeg-root/roles/developer.md']
    expect(resolveBoundaryPaths(['roles/developer.md', 'aeg-root/roles/developer.md'], files)).toEqual([
      'aeg-root/roles/developer.md'
    ])
  })
})
