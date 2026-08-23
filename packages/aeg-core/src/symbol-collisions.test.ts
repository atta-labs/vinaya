import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declarationsIn, findCollisions } from './symbol-collisions'

describe('symbol-collision detection', () => {
  it('finds a name declared in two files', () => {
    const decls = [
      ...declarationsIn('a.ts', 'function stripBackticks(s) {}'),
      ...declarationsIn('b.ts', 'function stripBackticks(s) {}')
    ]
    expect(findCollisions(decls)).toEqual([{ name: 'stripBackticks', files: ['a.ts', 'b.ts'], anyExported: false }])
  })

  it('does not report a name declared twice in ONE file', () => {
    expect(findCollisions(declarationsIn('a.ts', 'function f() {}\nfunction f() {}'))).toEqual([])
  })

  it('records whether any of the colliding declarations is exported', () => {
    const decls = [...declarationsIn('a.ts', 'export function f() {}'), ...declarationsIn('b.ts', 'function f() {}')]
    expect(findCollisions(decls)[0]?.anyExported).toBe(true)
  })

  it('reads the declaration forms this codebase actually uses', () => {
    const src =
      'export const A = 1\nfunction b() {}\nexport async function c() {}\ntype D = string\ninterface E {}\nclass F {}'
    expect(declarationsIn('x.ts', src).map((d) => d.name)).toEqual(['A', 'b', 'c', 'D', 'E', 'F'])
  })

  it('ignores indented declarations — only top level', () => {
    expect(declarationsIn('x.ts', '  const inner = 1').map((d) => d.name)).toEqual([])
  })

  it('sorts files and collisions, so a report does not reorder between runs', () => {
    const decls = [
      ...declarationsIn('z.ts', 'function b() {}\nfunction a() {}'),
      ...declarationsIn('a.ts', 'function b() {}\nfunction a() {}')
    ]
    const got = findCollisions(decls)
    expect(got.map((c) => c.name)).toEqual(['a', 'b'])
    expect(got[0]?.files).toEqual(['a.ts', 'z.ts'])
  })

  /**
   * The live case this exists for. `parse-registry.ts` and `registry-parse.ts`
   * are transpositions of each other, and a THIRD copy sits in
   * `parse-tranche.ts` — so "the registry's backtick stripper" names nothing
   * resolvable by eye, and a grep-based check of a claim about it returns a
   * confident answer about whichever copy it happened to land on.
   *
   * Asserting the exact file set keeps the detector honest against the real
   * tree rather than a fixture. If this list changes, that is signal — a fourth
   * copy appeared, or one was consolidated away — not maintenance noise.
   */
  it('detects the real stripBackticks collision in this package', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const decls = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .flatMap((f) => declarationsIn(f, readFileSync(join(dir, f), 'utf8')))
    const hit = findCollisions(decls).find((c) => c.name === 'stripBackticks')
    expect(hit?.files).toEqual(['parse-registry.ts', 'parse-tranche.ts', 'registry-parse.ts'])
  })
})

/**
 * The gate, as opposed to the unit tests above: a NEW name declared in two
 * files of this package fails here.
 *
 * Baselined rather than emptied. Each entry below is a real hazard, and each
 * needs a behaviour-affecting consolidation that does not belong in the same
 * change as the detector:
 *
 *   - `checkClosesN`   — two EXPORTED functions, different signatures, in
 *                        `brief-validation.ts` and `coherence-checks.ts`. A
 *                        claim about "checkClosesN" resolves to neither.
 *   - `isSpecFile`     — the export in `file-classify.ts` excludes frozen
 *                        archives (`!isFrozenArchive(p)`); the private shadow in
 *                        `reader-resolvable-prose.ts` does not. Same name, two
 *                        different definitions of "spec file".
 *   - `TASK_BRANCH_PATTERN` — three regexes; `archive-task.ts`'s has capture
 *                        groups, the other two do not.
 *   - `stripBackticks` — three copies, see the test above.
 *   - `isEmDashOrDash` — two copies, byte-identical; harmless, listed for
 *                        completeness so the set is exhaustive.
 */
const KNOWN_COLLISIONS = ['checkClosesN', 'isEmDashOrDash', 'isSpecFile', 'stripBackticks', 'TASK_BRANCH_PATTERN']

describe('symbol-collision gate over this package', () => {
  function packageCollisions() {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const decls = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .flatMap((f) => declarationsIn(f, readFileSync(join(dir, f), 'utf8')))
    return findCollisions(decls)
  }

  it('declares no name in two files beyond the known set', () => {
    const found = packageCollisions().map((c) => c.name)
    expect(
      found,
      'A name is now declared in more than one file of @attalabs/aeg-core. Rename or consolidate it, or add it to KNOWN_COLLISIONS with a reason. A name that resolves to two files cannot be checked by reading one of them.'
    ).toEqual([...KNOWN_COLLISIONS].sort((a, b) => a.localeCompare(b)))
  })

  it('scans enough files to be meaningful — a guard on the enumeration', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    expect(readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).length).toBeGreaterThan(20)
  })
})
