import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUNDLED_DOCTRINE_DIR,
  DOCTRINE_MAP,
  doctrineSource
} from '../../../harness/processes/vinaya-strict/tools/doctrine/doctrine-map'

// Regression guard for the exact miss found live: milestone-model.md and
// task-model.md shipped in the doctrine without being added to the bundler's
// file list, so a publish right after would have bundled tranche-model.md
// but not its two siblings — SKILL.md's reading-order (which DOES ship)
// would point adopters at files that never reached the tarball. Neither the
// code-reviewer nor security pass caught it — both reviewed doctrine
// content, not the packaging step that decides what actually ships.
//
// This test does not re-implement the bundler's own logic (that would just
// be a second copy free to drift the same way). It runs the real script
// against the real doctrine and asserts the files actually landed in the
// bundled output, at their process-relative paths under `vinaya-strict/` —
// proof the doctrine map and the source tree agree, not a guess that they do.

const repoRoot = join(import.meta.dir, '..', '..', '..')
const pkgRoot = join(import.meta.dir, '..')
const bundledRoot = join(pkgRoot, BUNDLED_DOCTRINE_DIR)

describe('bundle-doctrine — the milestone/task-model regression', () => {
  it('bundles milestone-model.md and task-model.md alongside tranche-model.md', () => {
    execFileSync('bun', [join(import.meta.dir, 'bundle-doctrine.ts')], { cwd: repoRoot })

    for (const file of ['tranche-model.md', 'milestone-model.md', 'task-model.md']) {
      expect(
        existsSync(join(bundledRoot, doctrineSource(file))),
        `${file} missing from bundled ${BUNDLED_DOCTRINE_DIR}/`
      ).toBe(true)
    }
  })

  it('every doctrine file that is portable doctrine is bundled — new files must be added deliberately', () => {
    execFileSync('bun', [join(import.meta.dir, 'bundle-doctrine.ts')], { cwd: repoRoot })

    // This-repo operational prose that is deliberately NOT portable doctrine
    // (see bundle-doctrine.ts's own top comment) — excluded here by the same
    // logical key, not re-derived, so this list and the script's own exclusion
    // reasoning stay one decision, not two.
    const deliberatelyExcluded = new Set(['aeg-manual-flow.md', 'documentation-coherence.md', 'reviewer-prompt.md'])

    const portable = DOCTRINE_MAP.filter((entry) => !deliberatelyExcluded.has(entry.key))

    const missing = portable.filter((entry) => !existsSync(join(bundledRoot, entry.source))).map((entry) => entry.key)
    expect(
      missing,
      `doctrine file(s) not bundled — mark them shipped in the doctrine map: ${missing.join(', ')}`
    ).toEqual([])
  })
})
