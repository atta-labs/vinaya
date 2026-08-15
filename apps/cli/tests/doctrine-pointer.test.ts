import { afterAll, describe, expect, it, mock } from 'bun:test'
import { doctrinePointer } from '../src/lib/artifacts.js'
// Imported from the SAME specifier artifacts.ts uses, so the mock.module
// interception below is provably live (see the sanity assertion) — a mock
// that silently failed to resolve would make the byte-identity test pass
// vacuously even against the machine-local implementation it exists to kill.
import { packageRoot } from '../src/lib/package-root.js'
import type { VendoredVinaya } from '../src/lib/self-host.js'

// Captured BEFORE any mock.module call rewires the live binding — module
// mocks persist across test files in the same bun process, so afterAll puts
// the real resolver back for whatever file runs next (doctrine.test.ts
// resolves a real path with it).
const realPackageRoot = packageRoot
afterAll(() => {
  mock.module('../src/lib/package-root.js', () => ({ packageRoot: realPackageRoot }))
})

const VENDORED: VendoredVinaya = { dir: 'apps/cli', bin: 'apps/cli/dist/index.js' }

/**
 * Regenerate the pointer as if the CLI physically sat at `fakeRoot` on this
 * machine — the exact variable atta-labs/attalabs#928's defect interpolated
 * into committed content.
 */
function pointerWithCliAt(fakeRoot: string, selfHost: VendoredVinaya | null): string {
  mock.module('../src/lib/package-root.js', () => ({ packageRoot: () => fakeRoot }))
  // The mock is live for artifacts.ts too (same module registry entry); if
  // this ever reads the real root, the whole test is void — fail loudly.
  expect(packageRoot('file:///anywhere/x.js')).toBe(fakeRoot)
  return doctrinePointer(selfHost)
}

describe('doctrine pointer machine-independence (atta-labs/attalabs#928)', () => {
  it('generates byte-identical content wherever the CLI physically sits', () => {
    for (const selfHost of [null, VENDORED]) {
      const a = pointerWithCliAt('/Users/alice/.npm/_npx/aaaa1111/node_modules/@attalabs/vinaya', selfHost)
      const b = pointerWithCliAt('/home/bob/checkouts/somewhere/else', selfHost)
      expect(a).toBe(b)
    }
  })

  it('contains no absolute filesystem path in either shape', () => {
    for (const selfHost of [null, VENDORED]) {
      const content = pointerWithCliAt('/Users/alice/.npm/_npx/aaaa1111/node_modules/@attalabs/vinaya', selfHost)
      expect(content).not.toContain('/Users/')
      expect(content).not.toContain('/home/')
      expect(content).not.toContain('_npx')
      // No token anywhere starts an absolute path — bare, backticked, quoted,
      // or sitting in an indented code block.
      expect(content).not.toMatch(/(^|[\s`("'])\/[A-Za-z]/m)
    }
  })

  it('still points at something a reader can open: package name, front door, resolution command', () => {
    const adopter = doctrinePointer(null)
    expect(adopter).toContain('@attalabs/vinaya')
    expect(adopter).toContain('aeg-root/skills/aeg/SKILL.md')
    expect(adopter).toContain('npx --yes @attalabs/vinaya doctrine')

    const vendored = doctrinePointer(VENDORED)
    expect(vendored).toContain('aeg-root/skills/aeg/SKILL.md')
    expect(vendored).toContain('node apps/cli/dist/index.js doctrine')
  })
})
