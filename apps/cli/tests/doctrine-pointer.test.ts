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
      // or sitting in an indented code block. `/vinaya <role>` (task 5, #152's
      // generic slash-command discoverability line) is the one sanctioned
      // exception: a command-syntax token, never a filesystem path, and it
      // names no vendor-specific file — stripped before the scan so it can
      // never be mistaken for the machine-local path this test guards against.
      expect(content.replace('/vinaya <role>', '')).not.toMatch(/(^|[\s`("'])\/[A-Za-z]/m)
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

  it('names no specific vendor file path in the slash-command discoverability line (task 5, #152)', () => {
    // Generic on purpose — the note names no `.claude/commands/vinaya.md` or
    // `.gemini/commands/vinaya.toml` path, so it never drifts as the vendor
    // set the `--agents` flag installs changes.
    for (const selfHost of [null, VENDORED]) {
      const content = doctrinePointer(selfHost)
      expect(content).toContain('slash-style commands')
      expect(content).toContain('/vinaya <role>')
      expect(content).not.toContain('.claude/commands')
      expect(content).not.toContain('.gemini/commands')
      expect(content).not.toContain('.agents/skills')
    }
  })
})

describe('doctrine pointer content (atta-labs/vinaya#41 — honest adopter entry point)', () => {
  it('names all three rings, one sentence each', () => {
    const content = doctrinePointer(null)
    expect(content).toContain('Ring 0 (git hooks)')
    expect(content).toContain('Ring 1 (forge-write interception)')
    expect(content).toContain('Ring 2 (async audits)')
  })

  it('points at real, shipped governance surfaces in THIS repo — never attalabs-internal aeg-root/', () => {
    const content = doctrinePointer(null)
    const governanceSection = content.split('## Where governance lives in this repo')[1]?.split('##')[0] ?? ''
    expect(content).toContain('vinaya.config.json')
    expect(content).toContain('.vinaya/hooks')
    expect(content).toContain('.vinaya/doc-owners')
    // Every aeg-root/ mention lives under "where the full doctrine lives" —
    // never framed as something present in the adopter's own repo tree.
    expect(governanceSection).not.toContain('aeg-root/')
    const fullDoctrineSection = content.split('## Where the full doctrine lives')[1] ?? ''
    const aegRootMentions = content.split('aeg-root/').length - 1
    const aegRootMentionsInFullDoctrineSection = fullDoctrineSection.split('aeg-root/').length - 1
    expect(aegRootMentions).toBe(aegRootMentionsInFullDoctrineSection)
  })

  it('names how to see what is running and how to extend, using only shipped commands', () => {
    const content = doctrinePointer(null)
    expect(content).toContain('vinaya check --plan')
    expect(content).toContain('vinaya doctor')
    expect(content).toContain('vinaya new check')
    // `vinaya new role` is not shipped yet (task 8) — must not be named as
    // though usable (the #684 trap this task supersedes).
    expect(content).not.toContain('new role')
  })

  it('carries the security paragraph: env allowlist, literal-never-secret, audit-trail caveat', () => {
    const content = doctrinePointer(null)
    expect(content).toContain('never the full parent')
    expect(content).toContain('breaking-change tightening')
    expect(content).toContain('must never be a secret')
    expect(content).toContain('pull request review is actually enforced')
  })
})
