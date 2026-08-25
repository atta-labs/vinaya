import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Regression guard for the exact miss found live: milestone-model.md and
// task-model.md shipped in aeg-root/ (PR #222) without being added to this
// script's FILES allowlist, so a publish right after would have bundled
// tranche-model.md but not its two siblings — SKILL.md's reading-order
// (which DOES ship, via the `skills` dir) would point adopters at files
// that never reached the tarball. Neither the code-reviewer nor security
// pass on #222 caught it — both reviewed doctrine content, not the
// packaging step that decides what actually ships.
//
// This test does not re-implement FILES' own logic (that would just be a
// second copy free to drift the same way). It runs the real script against
// the real aeg-root/ and asserts the two new files actually landed in the
// bundled output — proof the allowlist and the source directory agree,
// not a guess that they do.

const repoRoot = join(import.meta.dir, '..', '..', '..')
const pkgRoot = join(import.meta.dir, '..')
const bundledRoot = join(pkgRoot, 'aeg-root')

describe('bundle-doctrine — the milestone/task-model regression', () => {
  it('bundles milestone-model.md and task-model.md alongside tranche-model.md', () => {
    execFileSync('bun', [join(import.meta.dir, 'bundle-doctrine.ts')], { cwd: repoRoot })

    for (const file of ['tranche-model.md', 'milestone-model.md', 'task-model.md']) {
      expect(existsSync(join(bundledRoot, file)), `${file} missing from bundled aeg-root/`).toBe(true)
    }
  })

  it('every top-level .md file in the source aeg-root/ that is portable doctrine is bundled — new files must be added deliberately', () => {
    execFileSync('bun', [join(import.meta.dir, 'bundle-doctrine.ts')], { cwd: repoRoot })

    // This-repo operational prose that is deliberately NOT portable doctrine
    // (see bundle-doctrine.ts's own top comment) — excluded here by the same
    // name, not re-derived, so this list and the script's own exclusion
    // reasoning stay one decision, not two.
    const deliberatelyExcluded = new Set(['aeg-manual-flow.md', 'documentation-coherence.md', 'reviewer-prompt.md'])

    const sourceRoot = join(repoRoot, 'aeg-root')
    const sourceTopLevelMdFiles = readdirSync(sourceRoot, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .filter((name) => !deliberatelyExcluded.has(name))

    const missing = sourceTopLevelMdFiles.filter((name) => !existsSync(join(bundledRoot, name)))
    expect(missing, `new aeg-root/*.md file(s) not yet added to bundle-doctrine.ts's FILES array: ${missing.join(', ')}`).toEqual(
      []
    )
  })
})
