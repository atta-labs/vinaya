import { describe, expect, it } from 'vitest'
import { PRODUCT_SLUG_SCOPE } from './reader-resolvable-prose'

/**
 * Pins `PRODUCT_SLUG_SCOPE` against drift. This list used to live inside
 * `retired-vocabulary.test.ts`'s `PATTERN_SCOPE[TRANCHE_SLUG_VN_PATTERN]`,
 * grepped by that suite directly; it moved here so the
 * scope a `bun test --affected` run for one package can no longer silently
 * diverge from the scope the check that actually runs at the push hook
 * sweeps — a scope edit is now a visible diff to this file, not a buried
 * array literal in another package's test.
 */
describe('PRODUCT_SLUG_SCOPE', () => {
  it('is exactly the non-aeg-root prefixes the product-code slug sweep covers', () => {
    expect(PRODUCT_SLUG_SCOPE).toEqual([
      'apps/cli/src',
      '.github/workflows',
      '.vinaya',
      'apps/cli/README.md',
      'packages/sources/README.md'
    ])
  })
})
