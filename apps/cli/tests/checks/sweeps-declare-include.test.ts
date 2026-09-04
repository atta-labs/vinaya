import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { coreCheckRegistry } from '../../src/checks/registry'

/**
 * Pins task 12's (#387) cost-savings claim: every `scope: 'full'` registry
 * entry whose bin reads `<doctrineRoot>` declares an `include` — the
 * report-only sweeps (`reader-resolvable-prose`, `retired-vocabulary`,
 * `doctrine-portability`, `workspace-escape`) plus the blocking
 * `doctrine-no-procedures`. Reads each bin's SOURCE directly (same
 * discipline `registry-env.test.ts`'s own `readCode` uses), never
 * `spec.run` — that path resolves to a bundled `dist/` file when a build
 * happens to exist, and a bundled file is not what this test means by
 * "the bin's source".
 *
 * `include`'s current effect on a `scope: 'full'` entry is still
 * documentation/pinning only — `runner.ts`'s `shouldSkip` never consults it
 * for a non-`'diff'` scope, `--skip-full` (#397 round 2) included: that flag
 * is a blanket "defer every full-scope check" switch, orthogonal to any one
 * check's own `include` globs — so this test asserts the DECLARATION, not a
 * runtime skip.
 */
const BIN_DIR = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin')

function readBinSource(checkName: string): string {
  return readFileSync(join(BIN_DIR, `check-${checkName}.ts`), 'utf8')
}

describe('sweeps declare include (task 12, #387)', () => {
  it("every scope: 'full' registry entry whose bin reads <doctrineRoot> declares an include", () => {
    const specs = coreCheckRegistry().filter((s) => s.scope === 'full')
    const missing: string[] = []
    for (const spec of specs) {
      const source = readBinSource(spec.name)
      const readsDoctrineRoot = /\bDOCTRINE_ROOT\b/.test(source)
      if (readsDoctrineRoot && (!spec.include || spec.include.length === 0)) {
        missing.push(spec.name)
      }
    }
    expect(missing).toEqual([])
  })

  it('the four doctrine-root-reading sweeps this pins are exactly this set — a guard on the test itself', () => {
    const specs = coreCheckRegistry().filter((s) => s.scope === 'full')
    const readers = specs.filter((s) => /\bDOCTRINE_ROOT\b/.test(readBinSource(s.name))).map((s) => s.name)
    expect(new Set(readers)).toEqual(
      new Set(['reader-resolvable-prose', 'retired-vocabulary', 'doctrine-portability', 'doctrine-no-procedures'])
    )
  })

  it('the five named sweeps (the four doctrine-root readers, plus workspace-escape) all declare the include', () => {
    const specs = coreCheckRegistry()
    for (const name of [
      'reader-resolvable-prose',
      'retired-vocabulary',
      'doctrine-portability',
      'doctrine-no-procedures',
      'workspace-escape'
    ]) {
      const spec = specs.find((s) => s.name === name)
      expect(spec?.include, `${name} should declare include`).toEqual(['aeg-root/**/*.md'])
    }
  })
})
