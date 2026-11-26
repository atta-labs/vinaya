import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProcess } from '@harness/kernel/dev-process-socket/loader/load-process'
import { BUNDLED_DOCTRINE_DIR, DOCTRINE_MAP, doctrineSource } from '@harness/workflow/tools/doctrine/doctrine-map'
import { BUILT_PROCESS_FOLDER } from '@harness/workflow/tools/programs'
import { pinnedProcessFiles } from './bundle-doctrine'

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
// The script writes under a temporary `--out` folder, never the package's own.

const repoRoot = join(import.meta.dir, '..', '..', '..')
const processFolder = join(repoRoot, 'harness', 'processes', 'vinaya-strict')
let outRoot: string
let bundledRoot: string
let shippedProcess: string

function bundle(): void {
  execFileSync('bun', [join(import.meta.dir, 'bundle-doctrine.ts'), '--out', outRoot], { cwd: repoRoot })
}

beforeAll(() => {
  outRoot = mkdtempSync(join(tmpdir(), 'bundle-doctrine-'))
  bundledRoot = join(outRoot, BUNDLED_DOCTRINE_DIR)
  shippedProcess = join(outRoot, BUILT_PROCESS_FOLDER)
})

afterAll(() => {
  rmSync(outRoot, { recursive: true, force: true })
})

describe('bundle-doctrine — the milestone/task-model regression', () => {
  it('bundles milestone-model.md and task-model.md alongside tranche-model.md', () => {
    bundle()

    for (const file of ['tranche-model.md', 'milestone-model.md', 'task-model.md']) {
      expect(
        existsSync(join(bundledRoot, doctrineSource(file))),
        `${file} missing from bundled ${BUNDLED_DOCTRINE_DIR}/`
      ).toBe(true)
    }
  })

  it('every doctrine file that is portable doctrine is bundled — new files must be added deliberately', () => {
    bundle()

    // This-repo operational prose that is deliberately NOT portable doctrine
    // (see bundle-doctrine.ts's own top comment) — excluded here by the same
    // logical key, not re-derived, so this list and the script's own exclusion
    // reasoning stay one decision, not two.
    const deliberatelyExcluded = new Set(['manual-flow.md', 'documentation-coherence.md', 'reviewer-prompt.md'])

    const portable = DOCTRINE_MAP.filter((entry) => !deliberatelyExcluded.has(entry.key))

    const missing = portable.filter((entry) => !existsSync(join(bundledRoot, entry.source))).map((entry) => entry.key)
    expect(
      missing,
      `doctrine file(s) not bundled — mark them shipped in the doctrine map: ${missing.join(', ')}`
    ).toEqual([])
  })
})

describe('bundle-doctrine — the process files the Engine runner loads', () => {
  it('copies every file the process loader pins under dist/vinaya-strict, and the copy loads to the same digest', () => {
    bundle()

    const pinned = pinnedProcessFiles(processFolder)
    for (const file of [
      'process.yaml',
      'executing/dev-review.flow.yaml',
      'loops/dev-review/v2/dev-review-v2.flow.yaml'
    ])
      expect(pinned).toContain(file)
    const missing = pinned.filter((file) => !existsSync(join(shippedProcess, file)))
    expect(missing).toEqual([])
    expect(loadProcess(shippedProcess).digest).toBe(loadProcess(processFolder).digest)
  })

  it('never ships a pinned process file beside the top-level doctrine, where the test walkers would find it', () => {
    bundle()

    const outsideDist = pinnedProcessFiles(processFolder)
      .filter((file) => file.endsWith('.test.ts'))
      .filter((file) => existsSync(join(bundledRoot, file)))
    expect(outsideDist).toEqual([])
  })

  it('removes the shipped copy before each run, so a file deleted since the last pack leaves no stale copy', () => {
    bundle()
    const stale = join(shippedProcess, 'executing', 'developer', 'deleted-since.md')
    mkdirSync(join(stale, '..'), { recursive: true })
    writeFileSync(stale, 'stale\n')

    bundle()

    expect(existsSync(stale)).toBe(false)
    expect(loadProcess(shippedProcess).digest).toBe(loadProcess(processFolder).digest)
  })
})
