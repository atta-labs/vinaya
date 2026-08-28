import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { reassertPremiseFile } from '../../src/checks/premise-reassert-logic'
import { containedAbs } from '../../src/lib/ops'

/**
 * Bin-level regression for the `PREMISE_FILE` wiring (task 10, #59). The
 * bin's forge-dependent path (a real task branch) needs a live `gh`/network
 * round-trip that isn't hermetic to spawn in CI — `reassertPremiseFile`'s own
 * unit tests (`premise-reassert-logic.test.ts`) cover the pass/fail/missing-
 * file/no-pins decision logic directly. What this file proves instead: on a
 * non-task branch (the existing, unchanged bypass — `main` matches no
 * `task/<tranche>/<n>` pattern), the check still exits `0` with no findings
 * whether or not `PREMISE_FILE` is set — i.e. this task's addition changes
 * nothing about the pre-existing "nothing to evaluate here" path, satisfying
 * the unset-env "byte-equivalent in shape to pre-change behavior" test-plan
 * item at the wiring level.
 */
const REPO_ROOT = join(import.meta.dir, '../../../..')
const BIN = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-dispatch-readiness.ts')

async function run(env: Record<string, string>): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bun', BIN], {
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
    stdout: 'ignore',
    stderr: 'pipe'
  })
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stderr }
}

describe('check-dispatch-readiness: PREMISE_FILE on a non-task branch (bypass unaffected)', () => {
  it('PREMISE_FILE unset: exits 0 with no findings (pre-existing bypass, unchanged)', async () => {
    const result = await run({ BRANCH: 'main' })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.trim()).toBe('')
  })

  it('PREMISE_FILE set to a nonexistent path: bypass still fires first — exits 0, no premise error raised', async () => {
    const result = await run({ BRANCH: 'main', PREMISE_FILE: '/tmp/does-not-exist-premise-file.md' })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.trim()).toBe('')
  })
})

/**
 * `checkPremiseReassertion`'s `fileReader` wraps every pin's `path` field in
 * `containedRealPath(process.cwd(), p)` before reading — this reproduces
 * that exact wrapping (mirrored locally since the bin's `main()` runs on
 * import) against real files on disk, proving the containment holds for
 * every escape a `Premise:` pin's `path` (parsed by the frozen, unmodified
 * `parsePremiseBlock` grammar, which imposes none itself) could otherwise
 * carry: an absolute path, a `..`-traversal path, and — round `3`, the
 * escape `containedAbs` alone cannot see — a symlink whose textual path is
 * inside the root but whose target resolves outside it. `PREMISE_FILE` is an
 * adopter-wired env var that can point at PR-author-controlled content on
 * that same PR's own branch checkout (mirroring `PR_BODY_FILE`), so an
 * author who controls both the pin and the tree is a real threat model, not
 * a hypothetical one.
 */
describe('checkPremiseReassertion — containment on the per-pin fileReader', () => {
  const CHECK_NAME = 'dispatch-readiness'

  // Mirrors `check-dispatch-readiness.ts`'s `containedRealPath` exactly:
  // `containedAbs` first, then re-verified through the REAL (symlink-
  // resolved) path, matching `lib/self-host.ts`'s `resolvesInsideRepo`.
  function containedRealPath(root: string, p: string): string | null {
    const abs = containedAbs(root, p)
    if (abs === null) return null
    try {
      const real = realpathSync(abs)
      const realRoot = realpathSync(root)
      return real === realRoot || real.startsWith(realRoot + sep) ? real : null
    } catch {
      return null
    }
  }

  function containedFileReader(repoRoot: string): (p: string) => string | null {
    return (p) => {
      const real = containedRealPath(repoRoot, p)
      if (real === null) return null
      try {
        return readFileSync(real, 'utf8')
      } catch {
        return null
      }
    }
  }

  it('refuses an absolute-path pin pointing outside the containment root — treated as unreadable, never leaks real file content', () => {
    const root = mkdtempSync(join(tmpdir(), 'premise-containment-root-'))
    const secretDir = mkdtempSync(join(tmpdir(), 'premise-containment-secret-'))
    const secretPath = join(secretDir, 'secret.txt')
    writeFileSync(secretPath, 'top-secret-content')
    try {
      const body = ['**Premise:**', `- ${secretPath} contains: top-secret`, ''].join('\n')
      const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, containedFileReader(root))
      expect(result.pass).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.message).toContain('does not exist on disk')
      // The refusal names the pin's path, never the file's actual content.
      expect(result.errors[0]?.message).not.toContain('top-secret-content')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(secretDir, { recursive: true, force: true })
    }
  })

  it('refuses a `..`-traversal pin that climbs out of the containment root', () => {
    const root = mkdtempSync(join(tmpdir(), 'premise-containment-root-'))
    const outsideDir = mkdtempSync(join(tmpdir(), 'premise-containment-outside-'))
    writeFileSync(join(outsideDir, 'outside.txt'), 'outside-content')
    try {
      const traversal = relative(root, join(outsideDir, 'outside.txt'))
      const body = ['**Premise:**', `- ${traversal} contains: outside`, ''].join('\n')
      const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, containedFileReader(root))
      expect(result.pass).toBe(false)
      expect(result.errors[0]?.message).toContain('does not exist on disk')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  it('still accepts an ordinary repo-relative pin — no regression for legitimate `Premise:` pins', () => {
    const root = mkdtempSync(join(tmpdir(), 'premise-containment-legit-'))
    writeFileSync(join(root, 'thing.ts'), 'export function thing() {}\n')
    try {
      const body = ['**Premise:**', '- thing.ts contains: export function thing', ''].join('\n')
      const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, containedFileReader(root))
      expect(result).toEqual({ pass: true, errors: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still accepts a symlink whose target resolves INSIDE the root — no blanket symlink refusal, only escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'premise-containment-inlink-'))
    writeFileSync(join(root, 'real.ts'), 'export function real() {}\n')
    symlinkSync(join(root, 'real.ts'), join(root, 'link.ts'))
    try {
      const body = ['**Premise:**', '- link.ts contains: export function real', ''].join('\n')
      const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, containedFileReader(root))
      expect(result).toEqual({ pass: true, errors: [] })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Security re-review, round `3`: a symlink whose PATH is lexically inside
  // the containment root but whose TARGET resolves outside it — `containedAbs`
  // alone is a pure `node:path` computation with no filesystem access, so it
  // cannot see this; `readFileSync` follows the symlink transparently. Live
  // repro: a `sha256` pin on the symlink disclosed the real target's digest
  // verbatim in the failure message, and a `contains` pin with a correct
  // guess passed silently — the same boolean/digest oracle `containedAbs`
  // alone was supposed to have closed, reopened through the one class of
  // escape it structurally cannot detect.
  describe('a symlink escape (path inside root, target outside it)', () => {
    function makeSymlinkEscape(secretContent: string): { root: string; outsideDir: string; cleanup: () => void } {
      const root = mkdtempSync(join(tmpdir(), 'premise-containment-root-'))
      const outsideDir = mkdtempSync(join(tmpdir(), 'premise-containment-secret-'))
      writeFileSync(join(outsideDir, 'secret.txt'), secretContent)
      symlinkSync(join(outsideDir, 'secret.txt'), join(root, 'escape-link.txt'))
      return {
        root,
        outsideDir,
        cleanup: () => {
          rmSync(root, { recursive: true, force: true })
          rmSync(outsideDir, { recursive: true, force: true })
        }
      }
    }

    it("a `sha256` pin never discloses the real target's digest — refused the same as a missing file, not a hash mismatch", () => {
      const secretContent = 'top-secret-content'
      const realDigest = createHash('sha256').update(secretContent).digest('hex')
      const { root, cleanup } = makeSymlinkEscape(secretContent)
      try {
        const body = ['**Premise:**', `- escape-link.txt sha256: ${'0'.repeat(64)}`, ''].join('\n')
        const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, containedFileReader(root))
        expect(result.pass).toBe(false)
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]?.message).toContain('does not exist on disk')
        expect(result.errors[0]?.message).not.toContain('sha256 mismatch')
        expect(result.errors[0]?.message).not.toContain(realDigest)
      } finally {
        cleanup()
      }
    })

    it('a `contains` pin with a correct guess is refused, not a silent pass — no boolean oracle on the real target', () => {
      const secretContent = 'top-secret-content'
      const { root, cleanup } = makeSymlinkEscape(secretContent)
      try {
        const body = ['**Premise:**', '- escape-link.txt contains: top-secret-content', ''].join('\n')
        const result = reassertPremiseFile(CHECK_NAME, '/tmp/brief.md', body, containedFileReader(root))
        expect(result.pass).toBe(false)
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]?.message).toContain('does not exist on disk')
      } finally {
        cleanup()
      }
    })
  })
})
