// task-run-v1 20, O6/Part 5 — the file-level test selector, proved against
// real fixtures on disk (never mocked import resolution). The literal Part 5
// shape — two packages, three test files, one changed file selects exactly
// one — is `minimalTwoPackageFixture` below; a richer fixture covers
// transitive chains and cross-package bare-specifier resolution.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_NAMES, affectedNamesForFile, type LineRange, parseHunkRanges } from '../../src/lib/changed-names'
import { loadConfig } from '../../src/lib/config'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'
import {
  discoverWorkspacePackages,
  extractImportSpecifiers,
  isTestFile,
  selectAffectedTestFiles,
  walkFiles
} from '../../src/lib/test-selector'
import { scannedRootsOf } from '../../src/lib/repo-scanner-tests'
import { loadTypeScript } from '../../src/lib/ts-module-graph'

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-selector-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))

  const pkgA = join(root, 'packages', 'a')
  mkdirSync(join(pkgA, 'src'), { recursive: true })
  writeFileSync(join(pkgA, 'package.json'), JSON.stringify({ name: '@fixture/a' }))
  // The changed file.
  writeFileSync(join(pkgA, 'src', 'target.ts'), 'export function target() { return 1 }\n')
  // Imports target.ts directly — must be selected.
  writeFileSync(
    join(pkgA, 'src', 'direct.test.ts'),
    "import { target } from './target'\ntest('direct', () => target())\n"
  )
  // Imports a sibling that itself imports target.ts — transitive, must be selected.
  writeFileSync(join(pkgA, 'src', 'middle.ts'), "export { target } from './target'\n")
  writeFileSync(
    join(pkgA, 'src', 'transitive.test.ts'),
    "import { target } from './middle'\ntest('transitive', () => target())\n"
  )
  // Shares the SAME FOLDER as target.ts but imports nothing from it — must NOT be selected
  // (the whole point: this is a folder-mate, not an import-graph neighbour).
  writeFileSync(join(pkgA, 'src', 'unrelated.ts'), 'export function unrelated() { return 2 }\n')
  writeFileSync(
    join(pkgA, 'src', 'unrelated.test.ts'),
    "import { unrelated } from './unrelated'\ntest('unrelated', () => unrelated())\n"
  )

  // A test in a SECOND, unrelated package — never selected when only A
  // changes: it imports neither the changed file nor package @fixture/a.
  writeFileSync(join(pkgA, 'src', 'consumes-b.ts'), "import '@fixture/b'\nexport const usesB = true\n")
  writeFileSync(
    join(pkgA, 'src', 'consumes-b.test.ts'),
    "import { usesB } from './consumes-b'\ntest('consumes-b', () => usesB)\n"
  )

  const pkgB = join(root, 'packages', 'b')
  mkdirSync(join(pkgB, 'src'), { recursive: true })
  writeFileSync(join(pkgB, 'package.json'), JSON.stringify({ name: '@fixture/b' }))
  writeFileSync(join(pkgB, 'src', 'other.ts'), 'export function other() { return 3 }\n')
  writeFileSync(join(pkgB, 'src', 'other.test.ts'), "import { other } from './other'\ntest('other', () => other())\n")

  return root
}

/**
 * The Part 5 literal fixture shape: two packages, three test files total,
 * one changed file, exactly one test selected. `a/unrelated.test.ts` is the
 * folder-mate that must NOT be selected — it lives next to the changed file
 * but imports nothing from it; `b/other.test.ts` is in a package that
 * neither imports the changed file nor package `@fixture/a` at all.
 */
function minimalTwoPackageFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-selector-min-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))

  const pkgA = join(root, 'packages', 'a')
  mkdirSync(join(pkgA, 'src'), { recursive: true })
  writeFileSync(join(pkgA, 'package.json'), JSON.stringify({ name: '@fixture/a' }))
  writeFileSync(join(pkgA, 'src', 'target.ts'), 'export function target() { return 1 }\n')
  writeFileSync(
    join(pkgA, 'src', 'direct.test.ts'),
    "import { target } from './target'\ntest('direct', () => target())\n"
  )
  writeFileSync(join(pkgA, 'src', 'unrelated.ts'), 'export function unrelated() { return 2 }\n')
  writeFileSync(
    join(pkgA, 'src', 'unrelated.test.ts'),
    "import { unrelated } from './unrelated'\ntest('unrelated', () => unrelated())\n"
  )

  const pkgB = join(root, 'packages', 'b')
  mkdirSync(join(pkgB, 'src'), { recursive: true })
  writeFileSync(join(pkgB, 'package.json'), JSON.stringify({ name: '@fixture/b' }))
  writeFileSync(join(pkgB, 'src', 'other.ts'), 'export function other() { return 3 }\n')
  writeFileSync(join(pkgB, 'src', 'other.test.ts'), "import { other } from './other'\ntest('other', () => other())\n")

  return root
}

describe('selectAffectedTestFiles (task-run-v1 20, O6, Part 5)', () => {
  it('two packages, three test files — one changed file selects exactly one: the direct importer, never the folder-mate or the other package', () => {
    const root = minimalTwoPackageFixture()
    try {
      const changed = [join(root, 'packages', 'a', 'src', 'target.ts')]
      const { selected, totalTestFiles } = selectAffectedTestFiles(root, changed)
      expect(totalTestFiles).toBe(3)
      expect(selected).toEqual([join(root, 'packages', 'a', 'src', 'direct.test.ts')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a transitive import chain (test -> middle.ts -> target.ts) still selects the test — resolution is not one hop deep', () => {
    const root = fixtureRepo()
    try {
      // Force resolution through the chain alone by also changing middle.ts,
      // proving BOTH the direct and transitive importers select correctly
      // together — the folder-mate and the other package's test still don't.
      const changed = [join(root, 'packages', 'a', 'src', 'target.ts'), join(root, 'packages', 'a', 'src', 'middle.ts')]
      const { selected } = selectAffectedTestFiles(root, changed)
      expect(new Set(selected)).toEqual(
        new Set([
          join(root, 'packages', 'a', 'src', 'direct.test.ts'),
          join(root, 'packages', 'a', 'src', 'transitive.test.ts')
        ])
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a changed file in package B selects package A’s test that bare-imports @fixture/b — whole-package granularity for a real cross-package import', () => {
    const root = fixtureRepo()
    try {
      const changed = [join(root, 'packages', 'b', 'src', 'other.ts')]
      const { selected } = selectAffectedTestFiles(root, changed)
      expect(new Set(selected)).toEqual(
        new Set([
          join(root, 'packages', 'b', 'src', 'other.test.ts'),
          join(root, 'packages', 'a', 'src', 'consumes-b.test.ts')
        ])
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('no changed files selects nothing', () => {
    const root = fixtureRepo()
    try {
      const { selected } = selectAffectedTestFiles(root, [])
      expect(selected).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('O1: options.alwaysRun selects a test file no import graph reaches, on top of ordinary reachability', () => {
    const root = minimalTwoPackageFixture()
    try {
      // No changed files at all — reachability alone selects nothing — yet
      // the glob still forces `unrelated.test.ts` in.
      const { selected, totalTestFiles } = selectAffectedTestFiles(root, [], {
        alwaysRun: ['packages/a/src/unrelated.test.ts']
      })
      expect(totalTestFiles).toBe(3)
      expect(selected).toEqual([join(root, 'packages', 'a', 'src', 'unrelated.test.ts')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('O1: options.addedOrRenamed selects a brand-new test file nothing imports yet', () => {
    const root = minimalTwoPackageFixture()
    try {
      const brandNew = join(root, 'packages', 'a', 'src', 'brand-new.test.ts')
      writeFileSync(brandNew, "test('brand new', () => {})\n")
      const { selected } = selectAffectedTestFiles(root, [], { addedOrRenamed: [brandNew] })
      expect(selected).toEqual([brandNew])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('O1: alwaysRun never force-selects a file in a non-bun-test-compatible package', () => {
    const root = minimalTwoPackageFixture()
    try {
      writeFileSync(
        join(root, 'packages', 'a', 'package.json'),
        JSON.stringify({ name: '@fixture/a', scripts: { test: 'vitest run' } })
      )
      const { selected } = selectAffectedTestFiles(root, [], {
        alwaysRun: ['packages/a/src/unrelated.test.ts']
      })
      expect(selected).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('discoverWorkspacePackages', () => {
  it('reads the workspaces glob and returns every member with a real package.json', () => {
    const root = fixtureRepo()
    try {
      const packages = discoverWorkspacePackages(root)
      expect(new Set(packages.map((p) => p.name))).toEqual(new Set(['@fixture/a', '@fixture/b']))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isTestFile', () => {
  it('matches *.test.<ext> only', () => {
    expect(isTestFile('/a/b/foo.test.ts')).toBe(true)
    expect(isTestFile('/a/b/foo.test.tsx')).toBe(true)
    expect(isTestFile('/a/b/foo.ts')).toBe(false)
    expect(isTestFile('/a/b/footest.ts')).toBe(false)
  })
})

// task-run-v1 20, O7 — the hook's own invocation shape is `bun test
// <selected files...>`, ONE process handed every file the selector picked,
// never turbo orchestrating one `bun test` subprocess per affected
// PACKAGE. `--concurrency=1` (the removed guard) was always a turbo flag
// bounding exactly that per-package subprocess fan-out (#438) — bun's own
// test runner has no concurrency flag of its own (confirmed against `bun
// test --help`; it runs the files handed to it as one job). Removing the
// guard is therefore safe by construction, not by parallel wall time within
// a single invocation: the real risk it protected against (many concurrent
// `bun test` PROCESSES contending for resources) cannot recur when there is
// only ever one process, handed a flat file list, regardless of how many
// packages those files came from. This proves the actual claim: several
// real, cross-file `bun:test` files, selected together and handed to ONE
// `bun test` invocation with no concurrency flag at all, run and all pass.
describe('the hook drops --concurrency=1 — selected files run together in one process and green (O7)', () => {
  it('bun test <fileA> <fileB> <fileC> — no concurrency flag, one process, every file passes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-parallel-'))
    const files = ['a', 'b', 'c'].map((name) => {
      const path = join(dir, `${name}.test.ts`)
      writeFileSync(path, `import { expect, test } from 'bun:test'\ntest('${name}', () => expect(1).toBe(1))\n`)
      return path
    })

    try {
      const proc = Bun.spawn(['bun', 'test', ...files], { stdout: 'pipe', stderr: 'pipe' })
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      expect(exitCode).toBe(0)
      expect(stderr).toContain('3 pass')
      expect(stderr).not.toContain('concurrency')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Issue #660, O2 — two real 2026-09-19 pushes passed the pre-push hook and
// then failed CI on `log-callers — O2` (apps/cli/tests/lib/log-callers.test.ts):
// a repo-wide invariant test that walks every source file directly, so no
// import edge from a changed file ever reaches it — reachability alone can
// never select it, which is exactly the case `alwaysRun` exists for. Each
// change set below is the REAL repo-root-relative file list from that push
// (`git diff --name-only <fork-point>...<head>` at the actual commits:
// task-operator-v1/5's 93e25534 and task-files-v1/1's first push a6d9640c),
// reproduced live against these commits to confirm log-callers — O2 does
// fail on the unmodified tree (`bun test apps/cli/tests/lib/log-callers.test.ts`
// at each sha, offenders: `packages/aeg-core/src/control-store/local.ts`).
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const LOG_CALLERS_TEST = join(REPO_ROOT, 'apps/cli/tests/lib/log-callers.test.ts')

const INCIDENT_CHANGE_SETS: Record<string, string[]> = {
  'task-operator-v1/5 — 93e25534, the control-store symlink fix': [
    'apps/cli/src/lib/run-paths.ts',
    'apps/cli/src/lib/task-tools/resume.ts',
    'apps/cli/src/lib/task-tools/start.ts',
    'apps/cli/tests/lib/run-paths.test.ts',
    'packages/aeg-core/src/control-store/index.ts',
    'packages/aeg-core/src/control-store/local.test.ts',
    'packages/aeg-core/src/control-store/local.ts',
    'packages/aeg-core/src/index.ts'
  ],
  'task-files-v1/1 — a6d9640c, the one-runtime-directory first push': [
    '.changeset/task-files-v1-1-one-runtime-directory.md',
    'apps/cli/specs/isolation.md',
    'apps/cli/specs/log.md',
    'apps/cli/specs/loop.md',
    'apps/cli/src/lib/config.ts',
    'apps/cli/src/lib/dev-review-loop.ts',
    'apps/cli/src/lib/dev-review-loop/pause-resume.ts',
    'apps/cli/src/lib/dev-review-loop/publication.ts',
    'apps/cli/src/lib/dev-review-loop/reviewer-dispatch.ts',
    'apps/cli/src/lib/dev-review-loop/reviewer-isolation.ts',
    'apps/cli/src/lib/dispatch.ts',
    'apps/cli/src/lib/effects.ts',
    'apps/cli/src/lib/log-sink.ts',
    'apps/cli/src/lib/loop-log.ts',
    'apps/cli/src/lib/run-paths.ts',
    'apps/cli/src/lib/task-run.ts',
    'apps/cli/src/lib/task-status.ts',
    'apps/cli/src/lib/task-tools/cancel.ts',
    'apps/cli/src/lib/task-tools/handlers.ts',
    'apps/cli/src/lib/task-tools/read.ts',
    'apps/cli/src/lib/task-tools/resume.ts',
    'apps/cli/src/lib/task-tools/start.ts',
    'apps/cli/src/lib/worker-boundary.ts',
    'apps/cli/tests/ci-shards/shard-2.txt',
    'apps/cli/tests/ci-shards/shard-3.txt',
    'apps/cli/tests/lib/dev-review-loop.test.ts',
    'apps/cli/tests/lib/dev-review-loop/reviewer-dispatch.test.ts',
    'apps/cli/tests/lib/dispatch.test.ts',
    'apps/cli/tests/lib/dispatch/launch-intent.test.ts',
    'apps/cli/tests/lib/dispatch/worker-boundary.test.ts',
    'apps/cli/tests/lib/effects/executor.test.ts',
    'apps/cli/tests/lib/loop-log.test.ts',
    'apps/cli/tests/lib/run-paths.test.ts',
    'apps/cli/tests/lib/task-status.test.ts',
    'apps/cli/tests/lib/task-tools/cancel.test.ts',
    'apps/cli/tests/lib/task-tools/read.test.ts',
    'apps/cli/tests/lib/task-tools/resume.test.ts',
    'apps/cli/tests/run-paths-only.test.ts',
    'packages/aeg-core/src/control-store/local.test.ts',
    'packages/aeg-core/src/control-store/local.ts',
    'packages/sources/src/config-reference.ts'
  ]
}

describe('selectAffectedTestFiles replayed against the two recorded 2026-09-19 incidents (Issue #660, O2)', () => {
  for (const [label, changed] of Object.entries(INCIDENT_CHANGE_SETS)) {
    it(`${label} — with this repo's real alwaysRun config, log-callers — O2 is selected`, () => {
      const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
      const { selected } = selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun })
      expect(selected).toContain(LOG_CALLERS_TEST)
    })

    it(`${label} — with no alwaysRun at all, the scan rule now selects it; the IMPORT graph alone still cannot`, () => {
      // `log-callers.test.ts` walks the repository from disk, so no import edge
      // has ever reached it — which is why both of these incidents passed
      // pre-push and failed CI, and why the configured always-run list was the
      // only thing that could select it. The scan rule closes that on the
      // merits; withhold it and the original gap is still visible underneath.
      expect(selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun: [] }).selected).toContain(LOG_CALLERS_TEST)
      expect(
        selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun: [], repoTreeScanners: 'ignore' }).selected
      ).not.toContain(LOG_CALLERS_TEST)
    })
  }
})

// Round 2 review, BLOCKER — the a6d9640c change set above failed a SECOND
// CI shard the first pass of this fixture never checked: GitHub Actions run
// 35434611919, shard 3, failed 6 assertions in
// apps/cli/tests/commands/task-status.test.ts (reproduced live at that sha).
// This is a DIFFERENT class of gap than log-callers — O2's: that file has
// no import edge to walk at all. It drives the real CLI end-to-end
// (`execFileSync('bun', [INDEX, ...])` against a string path, never a
// static `import` of any `src/` file), so reachability can never reach it
// regardless of what changed — confirmed by grep: this file's own import
// list is `node:child_process`/`node:fs`/`node:os`/`node:path`/`node:url`/
// `bun:test` only. `alwaysRun` is the same escape hatch already used for
// log-callers/ci-shards/import-boundary, applied here for a structurally
// different reason (no edge exists to walk, rather than an edge that
// deliberately isn't one). This fixes the ONE concrete instance this task
// verified against a real incident — a broader audit of every CLI
// end-to-end test sharing this same blind spot is out of this task's
// bounded surface and is escalated separately, on the PR, rather than
// attempted here.
describe('a second real CI failure in the SAME task-files-v1/1 change set (Issue #660, O2, round 2 review BLOCKER)', () => {
  const changed = INCIDENT_CHANGE_SETS['task-files-v1/1 — a6d9640c, the one-runtime-directory first push'] as string[]
  const TASK_STATUS_E2E_TEST = join(REPO_ROOT, 'apps/cli/tests/commands/task-status.test.ts')

  it("with this repo's real alwaysRun config, commands/task-status.test.ts (shard 3's real CI failure) is selected", () => {
    const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
    const { selected } = selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun })
    expect(selected).toContain(TASK_STATUS_E2E_TEST)
  })

  it('reachability ALONE (no alwaysRun) never selects it — no static import edge exists to walk, not merely one uncrossed', () => {
    const { selected } = selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun: [] })
    expect(selected).not.toContain(TASK_STATUS_E2E_TEST)
  })
})

// symbol-aware-test-selection-v1 1, Part 3 — real on-disk fixtures for every
// import/export shape the refinement must resolve precisely or fall back on:
// aliases and `type` imports, nested and cross-package re-exports, unambiguous
// vs. ambiguous `export *`, cyclic re-exports, namespace/default/dynamic/unknown
// shapes, and a test that reaches a bare-package import only through an
// intermediate file. Never mocked: each writes a throwaway workspace to disk.
type PkgSpec = { name: string; main?: string; exports?: unknown; test?: string; files: Record<string, string> }

/** Writes a throwaway multi-package workspace to a temp dir and returns its root plus a `dir(name)` locator. */
function mkWorkspace(pkgs: PkgSpec[]): { root: string; dir: (name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-sym-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
  const dirs = new Map<string, string>()
  pkgs.forEach((p, i) => {
    const dir = join(root, 'packages', `p${i}`)
    dirs.set(p.name, dir)
    mkdirSync(dir, { recursive: true })
    const manifest: { name: string; main?: string; exports?: unknown; scripts?: { test: string } } = { name: p.name }
    if (p.main) manifest.main = p.main
    if (p.exports) manifest.exports = p.exports
    if (p.test) manifest.scripts = { test: p.test }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    for (const [rel, content] of Object.entries(p.files)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
  })
  return { root, dir: (name) => dirs.get(name) as string }
}

/** Runs the selector and returns the selected paths as a Set for containment asserts. */
function selectSet(root: string, changed: string[]): Set<string> {
  return new Set(selectAffectedTestFiles(root, changed).selected)
}

const INDEX_MAIN = './src/index.ts'

describe('Part 3 — named-export precision across import/export shapes', () => {
  it('aliases and type imports resolve by their origin name; an unrelated export never selects', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts':
            "export { foo } from './foo'\nexport type { Thing } from './thing'\nexport { bar } from './bar'\n",
          'src/foo.ts': 'export function foo() { return 1 }\n',
          'src/thing.ts': 'export type Thing = { a: number }\n',
          'src/bar.ts': 'export function bar() { return 2 }\n'
        }
      },
      {
        name: '@fx/app',
        files: {
          'src/uses-foo.test.ts': "import { foo as f } from '@fx/lib'\ntest('foo', () => f())\n",
          'src/uses-thing.test.ts':
            "import type { Thing } from '@fx/lib'\ntest('thing', () => { const t: Thing = { a: 1 }; return t })\n"
        }
      }
    ])
    try {
      const lib = dir('@fx/lib')
      const app = dir('@fx/app')
      const usesFoo = join(app, 'src/uses-foo.test.ts')
      const usesThing = join(app, 'src/uses-thing.test.ts')
      // Changing foo.ts selects only the aliased foo importer.
      expect(selectSet(root, [join(lib, 'src/foo.ts')])).toEqual(new Set([usesFoo]))
      // Changing the type's defining file selects only the `type`-import test.
      expect(selectSet(root, [join(lib, 'src/thing.ts')])).toEqual(new Set([usesThing]))
      // Changing an unrelated export selects NEITHER — the coarse rule would have selected both.
      expect(selectSet(root, [join(lib, 'src/bar.ts')])).toEqual(new Set())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a nested re-export chain resolves to the deep definition, and a change to any hop on the path selects', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { deep } from './outer'\n",
          'src/outer.ts': "export { deep } from './inner'\n",
          'src/inner.ts': 'export function deep() { return 1 }\n',
          'src/unrelated.ts': 'export function unrelated() { return 9 }\n'
        }
      },
      {
        name: '@fx/app',
        files: { 'src/uses-deep.test.ts': "import { deep } from '@fx/lib'\ntest('deep', () => deep())\n" }
      }
    ])
    try {
      const lib = dir('@fx/lib')
      const usesDeep = join(dir('@fx/app'), 'src/uses-deep.test.ts')
      expect(selectSet(root, [join(lib, 'src/inner.ts')])).toEqual(new Set([usesDeep])) // deep definition
      expect(selectSet(root, [join(lib, 'src/outer.ts')])).toEqual(new Set([usesDeep])) // intermediate hop
      expect(selectSet(root, [join(lib, 'src/index.ts')])).toEqual(new Set([usesDeep])) // entrypoint barrel
      expect(selectSet(root, [join(lib, 'src/unrelated.ts')])).toEqual(new Set()) // off the path
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a name re-exported across a package boundary resolves to its true origin, not a coarse edge on the middle package', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/base',
        main: INDEX_MAIN,
        files: { 'src/index.ts': "export { val } from './val'\n", 'src/val.ts': 'export const val = 1\n' }
      },
      {
        name: '@fx/mid',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { val } from '@fx/base'\nexport { own } from './own'\n",
          'src/own.ts': 'export const own = 2\n'
        }
      },
      { name: '@fx/app', files: { 'src/uses-val.test.ts': "import { val } from '@fx/mid'\ntest('val', () => val)\n" } }
    ])
    try {
      const usesVal = join(dir('@fx/app'), 'src/uses-val.test.ts')
      // The true origin is in @fx/base — a change there selects the consumer of @fx/mid.
      expect(selectSet(root, [join(dir('@fx/base'), 'src/val.ts')])).toContain(usesVal)
      // @fx/mid's own unrelated file does NOT — the coarse rule would have selected it on any @fx/mid change.
      expect(selectSet(root, [join(dir('@fx/mid'), 'src/own.ts')])).not.toContain(usesVal)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an unambiguous `export *` resolves precisely — it is not treated as automatically unsafe', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export * from './only'\nexport { extra } from './extra'\n",
          'src/only.ts': 'export function solo() { return 1 }\nexport function other() { return 2 }\n',
          'src/extra.ts': 'export const extra = 3\n'
        }
      },
      {
        name: '@fx/app',
        files: { 'src/uses-solo.test.ts': "import { solo } from '@fx/lib'\ntest('solo', () => solo())\n" }
      }
    ])
    try {
      const lib = dir('@fx/lib')
      const usesSolo = join(dir('@fx/app'), 'src/uses-solo.test.ts')
      expect(selectSet(root, [join(lib, 'src/only.ts')])).toEqual(new Set([usesSolo])) // resolved through the single star source
      expect(selectSet(root, [join(lib, 'src/extra.ts')])).toEqual(new Set()) // a different export, off solo's path
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a test reaches a bare-package import through an intermediate file, not written in the test itself', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { foo } from './foo'\n",
          'src/foo.ts': 'export function foo() { return 1 }\n',
          'src/unrelated.ts': 'export const u = 9\n'
        }
      },
      {
        name: '@fx/app',
        files: {
          'src/helper.ts': "import { foo } from '@fx/lib'\nexport const wrapped = () => foo()\n",
          'src/via-helper.test.ts': "import { wrapped } from './helper'\ntest('wrapped', () => wrapped())\n"
        }
      }
    ])
    try {
      const lib = dir('@fx/lib')
      const viaHelper = join(dir('@fx/app'), 'src/via-helper.test.ts')
      expect(selectSet(root, [join(lib, 'src/foo.ts')])).toEqual(new Set([viaHelper])) // reached transitively through helper.ts
      expect(selectSet(root, [join(lib, 'src/unrelated.ts')])).toEqual(new Set()) // off the resolved path
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Part 3 — unprovable shapes retain the whole-package edge (coarse fallback)', () => {
  // Each fixture shares one lib whose `foo`/`bar` are precisely resolvable; the
  // coarse test imports foo via an unprovable shape. A change to `bar.ts` (which
  // the precise control never imports) must select the coarse test and NOT the
  // control — proving the fallback is a real whole-package edge, not precision.
  const libFiles = {
    'src/index.ts':
      "export { foo } from './foo'\nexport { bar } from './bar'\nexport * from './dupa'\nexport * from './dupb'\nexport { cyc } from './cyca'\n",
    'src/foo.ts': 'export function foo() { return 1 }\n',
    'src/bar.ts': 'export function bar() { return 2 }\n',
    'src/dupa.ts': 'export function dup() { return 3 }\n',
    'src/dupb.ts': 'export function dup() { return 4 }\n',
    'src/cyca.ts': "export { cyc } from './cycb'\n",
    'src/cycb.ts': "export { cyc } from './cyca'\n"
  }

  const cases: Array<{ label: string; test: string; body: string }> = [
    { label: 'namespace import', test: 'ns.test.ts', body: "import * as lib from '@fx/lib'\ntest('ns', () => lib)\n" },
    { label: 'default import', test: 'def.test.ts', body: "import lib from '@fx/lib'\ntest('def', () => lib)\n" },
    { label: 'dynamic import', test: 'dyn.test.ts', body: "test('dyn', async () => await import('@fx/lib'))\n" },
    { label: 'side-effect import', test: 'side.test.ts', body: "import '@fx/lib'\ntest('side', () => 1)\n" },
    { label: 'unknown name', test: 'unk.test.ts', body: "import { ghost } from '@fx/lib'\ntest('unk', () => ghost)\n" },
    {
      label: 'ambiguous export *',
      test: 'amb.test.ts',
      body: "import { dup } from '@fx/lib'\ntest('amb', () => dup())\n"
    },
    { label: 'cyclic re-export', test: 'cyc.test.ts', body: "import { cyc } from '@fx/lib'\ntest('cyc', () => cyc)\n" }
  ]

  for (const c of cases) {
    it(`${c.label}: a change to an unrelated export still selects it, but never the precise control`, () => {
      const { root, dir } = mkWorkspace([
        { name: '@fx/lib', main: INDEX_MAIN, files: libFiles },
        {
          name: '@fx/app',
          files: {
            [`src/${c.test}`]: c.body,
            'src/control-foo.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n"
          }
        }
      ])
      try {
        const app = dir('@fx/app')
        const coarse = join(app, `src/${c.test}`)
        const control = join(app, 'src/control-foo.test.ts')
        const selected = selectSet(root, [join(dir('@fx/lib'), 'src/bar.ts')])
        expect(selected).toContain(coarse) // whole-package fallback fired
        expect(selected).not.toContain(control) // precise `foo` import is untouched by a `bar` change
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('an underivable entrypoint (no exports/main) makes every bare import of that package coarse', () => {
    const { root, dir } = mkWorkspace([
      { name: '@fx/noentry', files: { 'src/thing.ts': 'export function thing() { return 1 }\n' } },
      {
        name: '@fx/app',
        files: { 'src/uses.test.ts': "import { thing } from '@fx/noentry'\ntest('thing', () => thing())\n" }
      }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      // No entrypoint to resolve `thing` through — any change in @fx/noentry selects the importer.
      expect(selectSet(root, [join(dir('@fx/noentry'), 'src/thing.ts')])).toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a single file importing the same package under BOTH a resolvable and an unprovable shape stays coarse', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { foo } from './foo'\nexport { bar } from './bar'\n",
          'src/foo.ts': 'export function foo() { return 1 }\n',
          'src/bar.ts': 'export function bar() { return 2 }\n'
        }
      },
      {
        name: '@fx/app',
        files: {
          'src/mixed.test.ts':
            "import { foo } from '@fx/lib'\nimport * as all from '@fx/lib'\ntest('mixed', () => [foo(), all])\n"
        }
      }
    ])
    try {
      const mixed = join(dir('@fx/app'), 'src/mixed.test.ts')
      // `bar` is unrelated to the resolvable `foo` import, yet the namespace import
      // on the same file forces the whole-package edge, so `bar` still selects it.
      expect(selectSet(root, [join(dir('@fx/lib'), 'src/bar.ts')])).toContain(mixed)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// The never-miss ORACLE, and the one rule that makes it worth anything: its
// module graph comes from a DIFFERENT resolver than the selector's.
//
// The oracle this replaced read imports with its own regular expressions and
// reused the selector's own file discovery, so it inherited the selector's
// blind spots exactly — including the one that mattered: neither could resolve
// a relative specifier written with a `.js` extension to its `.ts` source, so a
// whole class of dropped edges looked like agreement. This one asks Bun to
// BUNDLE each test file and reads the module list out of the bundle's own
// source map: every file the bundler actually pulled in, resolved by the
// bundler's resolver, sharing no code path with the selector at all.
function bundlerOracle(root: string, testFiles: readonly string[]) {
  const workdir = mkdtempSync(join(tmpdir(), 'vinaya-oracle-'))
  try {
    // The oracle runs in its own bundler process, one build per entrypoint.
    //
    // Both shortcuts were tried and both are wrong. Calling `Bun.build` from
    // inside the test runner starts failing with "Unexpected reading file"
    // after the first build, which silently EMPTIES the oracle instead of
    // failing it. Passing every entrypoint to a single build is fast but merges
    // the module registry across entrypoints, so each source map lists modules
    // some OTHER entrypoint pulled in — measured here: one test file's map
    // listed 98 modules built alone and 148 built alongside 172 siblings. A
    // contaminated oracle reports violations that are not real, which is just a
    // different way of proving nothing.
    const script = join(workdir, 'oracle.ts')
    writeFileSync(
      script,
      [
        'const entries = JSON.parse(await Bun.file(Bun.argv[2] as string).text()) as string[]',
        'const out: Record<string, string[]> = {}',
        'for (const entry of entries) {',
        "  const built = await Bun.build({ entrypoints: [entry], target: 'node', sourcemap: 'external', throw: false })",
        '  const sources: string[] = []',
        '  if (built.success) {',
        '    for (const output of built.outputs) {',
        "      if (!output.path.endsWith('.map')) continue",
        '      sources.push(...(JSON.parse(await output.text()) as { sources: string[] }).sources)',
        '    }',
        '  }',
        '  out[entry] = sources',
        '}',
        'await Bun.write(Bun.argv[3] as string, JSON.stringify(out))',
        ''
      ].join('\n')
    )
    const entriesFile = join(workdir, 'entries.json')
    const resultFile = join(workdir, 'graph.json')
    writeFileSync(entriesFile, JSON.stringify(testFiles))
    const built = spawnSyncBudgeted(
      'bun',
      [script, entriesFile, resultFile],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...stripVinayaEnv(), HOME: process.env.HOME, PATH: process.env.PATH }
      },
      120_000,
      'bun (never-miss oracle)'
    )
    if (built.status !== 0) {
      throw new Error(`the oracle's bundler failed, so it proves nothing:\n${built.stderr}\n${built.stdout}`)
    }
    const raw = JSON.parse(readFileSync(resultFile, 'utf8')) as Record<string, string[]>
    const sources = new Map<string, Set<string>>()
    // Source-map paths are relative to the bundler process's own cwd, which is `root`.
    for (const testFile of testFiles) {
      sources.set(testFile, new Set((raw[testFile] ?? []).map((source) => resolve(root, source))))
    }
    return {
      reaches: (changedFile: string, testFile: string): boolean => sources.get(testFile)?.has(changedFile) ?? false,
      /** Entrypoints the bundler produced no module list for — never counted as evidence in either direction. */
      unbuildable: testFiles.filter((t) => (sources.get(t)?.size ?? 0) === 0)
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

/** Links each workspace package into `<root>/node_modules/<name>` so a bundler can resolve its bare specifiers with no install. */
function linkWorkspacePackages(root: string, names: readonly string[], dir: (name: string) => string): void {
  for (const name of names) {
    const target = join(root, 'node_modules', name)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(dir(name), target, 'dir')
  }
}

describe('Part 4 — never-miss: optimized selection is a superset of the independent oracle', () => {
  /**
   * What the bundler proves, and what it does not.
   *
   * Inside one package it is authoritative: it resolved every specifier
   * itself, `.js` extensions included, so anything it pulled in is a real
   * dependency the selector must not drop. ACROSS a workspace-package barrel it
   * is an over-approximation instead — bundling a barrel parses every module
   * the barrel re-exports, and what survives tree-shaking is not what the
   * source map lists. Importing ONE name from a package depends on that name's
   * resolution path, not on the barrel's other re-exports, which is the rule
   * this selector documents and `apps/cli/specs/self-hosting.md` specifies.
   *
   * So the two assertions differ in kind, and both are real: within a package,
   * strict superset; across a package boundary, every divergence must be
   * attributable to the barrel — the test reached the file through that
   * package's entry, never through a relative chain the selector lost.
   */
  function realRepoTestFiles(): string[] {
    return discoverWorkspacePackages(REPO_ROOT)
      .filter((p) => p.bunTestCompatible)
      .flatMap((p) => walkFiles(p.dir).filter(isTestFile))
  }

  it('within a package — including files imported through .js specifiers — the bundler finds nothing the selector drops', () => {
    const testFiles = realRepoTestFiles()
    const oracle = bundlerOracle(REPO_ROOT, testFiles)
    expect(oracle.unbuildable).toEqual([])
    // Every one of these is imported by its consumers through a `.js`
    // specifier — the exact class of edge that was missing outright.
    const sample = [
      'apps/cli/src/commands/demo.ts',
      'apps/cli/src/lib/config.ts',
      'apps/cli/src/lib/dispatch.ts',
      'apps/cli/src/lib/test-selector.ts',
      'apps/cli/src/lib/remote-base.ts',
      'apps/cli/src/checks/runner.ts'
    ].map((f) => join(REPO_ROOT, f))
    let checkedNonEmpty = 0
    for (const changed of sample) {
      const optimized = new Set(selectAffectedTestFiles(REPO_ROOT, [changed]).selected)
      const reached = testFiles.filter((t) => oracle.reaches(changed, t))
      if (reached.length > 0) checkedNonEmpty++
      expect(
        reached.filter((t) => !optimized.has(t)).map((t) => t.slice(REPO_ROOT.length + 1)),
        `never-miss violation for ${changed.slice(REPO_ROOT.length + 1)}`
      ).toEqual([])
    }
    // Guard the guard: an oracle that found nothing would pass the assertion
    // above while proving nothing at all.
    expect(checkedNonEmpty).toBe(sample.length)
  }, 180_000)

  it('across a package barrel, every divergence is the barrel — never a relative edge the selector lost', () => {
    const testFiles = realRepoTestFiles()
    const oracle = bundlerOracle(REPO_ROOT, testFiles)
    const barrel = join(REPO_ROOT, 'packages/aeg-core/src/index.ts')
    const sample = [
      'packages/aeg-core/src/review-input-manifest.ts',
      'packages/aeg-core/src/anchored-region.ts',
      'packages/aeg-core/src/parse-registry.ts'
    ].map((f) => join(REPO_ROOT, f))
    let checkedNonEmpty = 0
    for (const changed of sample) {
      const optimized = new Set(selectAffectedTestFiles(REPO_ROOT, [changed]).selected)
      const reached = testFiles.filter((t) => oracle.reaches(changed, t))
      if (reached.length > 0) checkedNonEmpty++
      // A divergence is only acceptable when the test reached the file through
      // the package's own entry barrel. One that reached it any other way is a
      // genuinely lost edge.
      expect(
        reached
          .filter((t) => !optimized.has(t) && !oracle.reaches(barrel, t))
          .map((t) => t.slice(REPO_ROOT.length + 1)),
        `divergence not explained by the barrel for ${changed.slice(REPO_ROOT.length + 1)}`
      ).toEqual([])
    }
    expect(checkedNonEmpty).toBe(sample.length)
  }, 180_000)

  it('over a constructed workspace whose imports are ALL written with .js specifiers, the bundler finds nothing the selector drops', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@nm/base',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { shared } from './shared.js'\n",
          'src/shared.ts': "import './shared-dep.js'\nexport const shared = 1\n",
          'src/shared-dep.ts': 'export const sd = 2\n'
        }
      },
      {
        name: '@nm/core',
        main: INDEX_MAIN,
        files: {
          'src/index.ts':
            "export { hot } from './hot.js'\nexport { warm } from './warm-outer.js'\nexport { shared } from '@nm/base'\nexport * from './starred.js'\nexport { cold } from './cold.js'\n",
          'src/hot.ts': "import './hot-dep.js'\nexport function hot() { return 1 }\n",
          'src/hot-dep.ts': 'export const hd = 1\n',
          'src/warm-outer.ts': "export { warm } from './warm-inner.js'\n",
          'src/warm-inner.ts': 'export function warm() { return 2 }\n',
          'src/starred.ts': 'export function starred() { return 3 }\n',
          'src/cold.ts': 'export function cold() { return 4 }\n'
        }
      },
      {
        name: '@nm/app',
        files: {
          'src/t-hot.test.ts': "import { hot } from '@nm/core'\ntest('hot', () => hot())\n",
          'src/t-hot-alias.test.ts': "import { hot as h } from '@nm/core'\ntest('h', () => h())\n",
          'src/helper.ts': "import { hot } from '@nm/core'\nexport const wrap = () => hot()\n",
          'src/t-hot-via.test.ts': "import { wrap } from './helper.js'\ntest('via', () => wrap())\n",
          'src/t-warm.test.ts': "import { warm } from '@nm/core'\ntest('warm', () => warm())\n",
          'src/t-starred.test.ts': "import { starred } from '@nm/core'\ntest('starred', () => starred())\n",
          'src/t-ns.test.ts': "import * as c from '@nm/core'\ntest('ns', () => c)\n"
        }
      }
    ])
    try {
      linkWorkspacePackages(root, ['@nm/base', '@nm/core', '@nm/app'], dir)
      const testFiles = ['t-hot', 't-hot-alias', 't-hot-via', 't-warm', 't-starred', 't-ns'].map((n) =>
        join(dir('@nm/app'), `src/${n}.test.ts`)
      )
      const oracle = bundlerOracle(root, testFiles)
      expect(oracle.unbuildable).toEqual([])
      // @nm/core's INTERNAL chain (hot -> hot-dep, warm-outer -> warm-inner,
      // every hop written with a `.js` specifier) is where a lost edge shows.
      const sample = [
        join(dir('@nm/core'), 'src/hot.ts'),
        join(dir('@nm/core'), 'src/hot-dep.ts'),
        join(dir('@nm/core'), 'src/warm-inner.ts'),
        join(dir('@nm/core'), 'src/warm-outer.ts'),
        join(dir('@nm/core'), 'src/starred.ts'),
        join(dir('@nm/core'), 'src/index.ts')
      ]
      const barrel = join(dir('@nm/core'), 'src/index.ts')
      let checkedNonEmpty = 0
      for (const changed of sample) {
        const optimized = new Set(selectAffectedTestFiles(root, [changed]).selected)
        const reached = testFiles.filter((t) => oracle.reaches(changed, t))
        if (reached.length > 0) checkedNonEmpty++
        expect(
          reached.filter((t) => !optimized.has(t) && !oracle.reaches(barrel, t)).map((t) => t.slice(root.length + 1)),
          `never-miss violation for ${changed.slice(root.length + 1)}`
        ).toEqual([])
      }
      // Not every sampled file is reached: the bundler tree-shakes a name no
      // test in this workspace uses, so `cold` and the modules only it reaches
      // legitimately appear in nobody's graph. Several must still be reached,
      // or the assertions above are vacuous.
      expect(checkedNonEmpty).toBeGreaterThanOrEqual(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
// symbol-aware-test-selection-v1 1, round 2 review — regressions the never-miss
// invariant hid until the reviewers surfaced them: an empty/comment-bearing named
// list must fall back (not silently drop names), a non-source change inside a
// package must still reach precisely-resolved importers, a re-export hop's own
// module imports must be traversed, a whitespace-free clause must still parse, and
// an `exports` conditions object must resolve through its runtime target.
describe('Round 2 — fallback and never-miss holes', () => {
  it('an empty named list `import {}` falls back to the whole-package edge (F1)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { foo } from './foo'\nexport { bar } from './bar'\n",
          'src/foo.ts': 'export function foo() { return 1 }\n',
          'src/bar.ts': 'export function bar() { return 2 }\n'
        }
      },
      {
        name: '@fx/app',
        files: {
          'src/empty.test.ts': "import {} from '@fx/lib'\ntest('empty', () => 1)\n",
          'src/control-foo.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n"
        }
      }
    ])
    try {
      const app = dir('@fx/app')
      const selected = selectSet(root, [join(dir('@fx/lib'), 'src/bar.ts')])
      expect(selected).toContain(join(app, 'src/empty.test.ts')) // coarse: any lib change selects it
      expect(selected).not.toContain(join(app, 'src/control-foo.test.ts')) // precise foo import untouched by a bar change
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a comment inside a multi-line named list drops no name — every name after it still resolves precisely (F1)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts':
            "export { alpha } from './alpha'\nexport { beta } from './beta'\nexport { gamma } from './gamma'\n",
          'src/alpha.ts': 'export const alpha = 1\n',
          'src/beta.ts': 'export const beta = 2\n',
          'src/gamma.ts': 'export const gamma = 3\n'
        }
      },
      {
        name: '@fx/app',
        files: {
          'src/commented.test.ts':
            "import {\n  alpha, // the first\n  beta\n} from '@fx/lib'\ntest('c', () => [alpha, beta])\n"
        }
      }
    ])
    try {
      const commented = join(dir('@fx/app'), 'src/commented.test.ts')
      // `beta` sits after the `// the first` comment; it must still resolve.
      expect(selectSet(root, [join(dir('@fx/lib'), 'src/beta.ts')])).toContain(commented)
      // `gamma` is imported by nobody, so a gamma change selects nothing (still precise, not coarse).
      expect(selectSet(root, [join(dir('@fx/lib'), 'src/gamma.ts')])).not.toContain(commented)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a NON-source change inside a package (its package.json) still selects a precisely-resolved importer (F2)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { foo } from './foo'\n",
          'src/foo.ts': 'export function foo() { return 1 }\n',
          'src/unrelated.ts': 'export const u = 9\n'
        }
      },
      { name: '@fx/app', files: { 'src/uses.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n" } }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      const lib = dir('@fx/lib')
      // exports/main re-point what the importer resolves to — a manifest change must select it.
      expect(selectSet(root, [join(lib, 'package.json')])).toContain(uses)
      expect(selectSet(root, [join(lib, 'tsconfig.json')])).toContain(uses)
      // A source change stays precise: foo selects, an unrelated source file does not.
      expect(selectSet(root, [join(lib, 'src/foo.ts')])).toContain(uses)
      expect(selectSet(root, [join(lib, 'src/unrelated.ts')])).not.toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a re-export hop's own side-effect and module-scope imports are traversed (F3)", () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts':
            "import './register'\nimport { helper } from './helper'\nexport { foo } from './foo'\nexport const wired = helper\n",
          'src/register.ts': 'export const registered = true\n',
          'src/helper.ts': 'export const helper = 1\n',
          'src/foo.ts': 'export function foo() { return 1 }\n',
          'src/unrelated.ts': 'export const u = 9\n'
        }
      },
      { name: '@fx/app', files: { 'src/uses.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n" } }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      const lib = dir('@fx/lib')
      // The barrel runs `register.ts` and `helper.ts` on every import of `foo`.
      expect(selectSet(root, [join(lib, 'src/register.ts')])).toContain(uses)
      expect(selectSet(root, [join(lib, 'src/helper.ts')])).toContain(uses)
      // A file the barrel does not import at all stays off the path.
      expect(selectSet(root, [join(lib, 'src/unrelated.ts')])).not.toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a whitespace-free clause `import{foo}from` still yields an edge, not silence (F4)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: { 'src/index.ts': "export { foo } from './foo'\n", 'src/foo.ts': 'export function foo() { return 1 }\n' }
      },
      { name: '@fx/app', files: { 'src/tight.test.ts': "import{foo}from'@fx/lib'\ntest('foo', () => foo())\n" } }
    ])
    try {
      const tight = join(dir('@fx/app'), 'src/tight.test.ts')
      expect(selectSet(root, [join(dir('@fx/lib'), 'src/foo.ts')])).toContain(tight)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an `exports` conditions object resolves through its RUNTIME target, not `types` (Sec-5)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        exports: { '.': { types: './src/types.d.ts', import: './src/index.ts' } },
        files: {
          'src/index.ts': 'export function foo() { return 1 }\n',
          'src/types.d.ts': 'export declare function foo(): number\n'
        }
      },
      { name: '@fx/app', files: { 'src/uses.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n" } }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      const lib = dir('@fx/lib')
      // Resolution used the runtime `import` entry (index.ts), so an index change selects…
      expect(selectSet(root, [join(lib, 'src/index.ts')])).toContain(uses)
      // …and the `types` declaration file, which the runtime never loads, is off the path.
      expect(selectSet(root, [join(lib, 'src/types.d.ts')])).not.toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// symbol-aware-test-selection-v1 1, round 3 review — the shapes that still
// resolved to SILENCE rather than to the coarse edge (a quote inside a clause, a
// hop's own import under a clause the binding parser cannot read, a hop's bare
// import of a package with no derivable entrypoint), the `exports` conditions
// choice that was guessed rather than proved, and two precision residuals: a
// `pkgmeta:` marker that named only the directly-imported package, and a hop's
// bare import that dragged its whole target package back in.
describe('Round 3 — silence-instead-of-fallback, unprovable conditions, and hop fan-out', () => {
  it('a clause carrying a STRING export name still yields its edge — the statement is not dropped (R3-1)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: { 'src/index.ts': "export { foo } from './foo'\n", 'src/foo.ts': 'export function foo() { return 1 }\n' }
      },
      {
        name: '@fx/app',
        files: {
          // `export { "odd-name" as odd } from './odd'` — a legal string export
          // name. The clause carries quotes, which used to make the whole
          // statement unparseable, so `./odd` became no edge at all.
          'src/reexporter.ts': 'export { "odd-name" as odd } from \'./odd\'\n',
          'src/odd.ts': "const value = 1\nexport { value as 'odd-name' }\n",
          'src/via-odd.test.ts': "import { odd } from './reexporter'\ntest('odd', () => odd)\n",
          // The same shape against a BARE package specifier: unparseable as a
          // name list, so it must fall back to the whole-package edge.
          'src/bare-odd.test.ts': "import { \"foo\" as f } from '@fx/lib'\ntest('f', () => f)\n"
        }
      }
    ])
    try {
      const app = dir('@fx/app')
      // The edge exists: a change to the file behind the string-named re-export selects.
      expect(selectSet(root, [join(app, 'src/odd.ts')])).toContain(join(app, 'src/via-odd.test.ts'))
      // The bare-specifier twin narrows to nothing, so it keeps the coarse edge:
      // ANY change in @fx/lib selects it, including one it never names.
      expect(selectSet(root, [join(dir('@fx/lib'), 'src/index.ts')])).toContain(join(app, 'src/bare-odd.test.ts'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a hop's own import under a clause the binding parser cannot read is still traversed (R3-2)", () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          // `default, { named }` and a whitespace-free clause: both are shapes
          // the narrow binding regex drops, which silently cost the barrel its
          // `./helper` and `./tight` dependency edges.
          'src/index.ts':
            "import registry, { helper } from './helper'\nimport{tight}from'./tight'\nexport { foo } from './foo'\nexport const wired = helper(registry) + tight\n",
          'src/helper.ts': 'export default 1\nexport const helper = (n: number) => n\n',
          'src/tight.ts': 'export const tight = 2\n',
          'src/foo.ts': 'export function foo() { return 1 }\n',
          'src/unrelated.ts': 'export const u = 9\n'
        }
      },
      { name: '@fx/app', files: { 'src/uses.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n" } }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      const lib = dir('@fx/lib')
      expect(selectSet(root, [join(lib, 'src/helper.ts')])).toContain(uses)
      expect(selectSet(root, [join(lib, 'src/tight.ts')])).toContain(uses)
      // Still precise: a file the barrel never imports stays off the path.
      expect(selectSet(root, [join(lib, 'src/unrelated.ts')])).not.toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an `exports` conditions object declaring two different runtime targets is unprovable, so it falls back (R3-3)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/dual',
        // Which of these the runtime takes depends on the active condition, which
        // no static scan knows — so no subpath is mapped and bare imports stay coarse.
        exports: { '.': { import: './src/esm.ts', require: './src/cjs.ts' } },
        files: {
          'src/esm.ts': 'export function foo() { return 1 }\n',
          'src/cjs.ts': 'export function foo() { return 2 }\n',
          'src/unrelated.ts': 'export const u = 9\n'
        }
      },
      {
        name: '@fx/typed',
        // Only a type-only condition: nothing the runtime ever executes, so this
        // is unmapped too rather than resolving names into a declaration file.
        exports: { '.': { types: './src/index.d.ts' } },
        files: { 'src/index.d.ts': 'export declare function bar(): number\n', 'src/impl.ts': 'export const impl = 1\n' }
      },
      {
        name: '@fx/elsewhere',
        // One branch re-points at ANOTHER package, which is not a path under this
        // one — so the relative sibling never wins the choice by default.
        exports: { '.': { browser: '@fx/dual', default: './src/local.ts' } },
        files: { 'src/local.ts': 'export function baz() { return 1 }\n', 'src/other.ts': 'export const o = 9\n' }
      },
      {
        name: '@fx/app',
        files: {
          'src/dual.test.ts': "import { foo } from '@fx/dual'\ntest('foo', () => foo())\n",
          'src/typed.test.ts': "import { bar } from '@fx/typed'\ntest('bar', () => bar())\n",
          'src/elsewhere.test.ts': "import { baz } from '@fx/elsewhere'\ntest('baz', () => baz())\n"
        }
      }
    ])
    try {
      const app = dir('@fx/app')
      // Coarse, not a guess: a file NEITHER declared target names still selects.
      expect(selectSet(root, [join(dir('@fx/dual'), 'src/unrelated.ts')])).toContain(join(app, 'src/dual.test.ts'))
      expect(selectSet(root, [join(dir('@fx/typed'), 'src/impl.ts')])).toContain(join(app, 'src/typed.test.ts'))
      expect(selectSet(root, [join(dir('@fx/elsewhere'), 'src/other.ts')])).toContain(
        join(app, 'src/elsewhere.test.ts')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a manifest change in an INTERMEDIATE package on the resolution path selects the importer (R3-4)', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/deep',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { deep } from './deep'\n",
          'src/deep.ts': 'export function deep() { return 1 }\n'
        }
      },
      { name: '@fx/mid', main: INDEX_MAIN, files: { 'src/index.ts': "export { deep } from '@fx/deep'\n" } },
      { name: '@fx/app', files: { 'src/uses.test.ts': "import { deep } from '@fx/mid'\ntest('deep', () => deep())\n" } }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      // `@fx/deep`'s own manifest re-points what `@fx/mid`'s barrel resolves to,
      // and so what this importer resolves to — a non-source file no graph edge names.
      expect(selectSet(root, [join(dir('@fx/deep'), 'package.json')])).toContain(uses)
      // The directly-imported package's manifest was already covered; still is.
      expect(selectSet(root, [join(dir('@fx/mid'), 'package.json')])).toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a hop's own BARE import resolves through exported names, not the whole target package (R3-5)", () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@fx/tools',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { used } from './used'\nexport { spare } from './spare'\n",
          'src/used.ts': 'export const used = 1\n',
          'src/spare.ts': 'export const spare = 2\n'
        }
      },
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          // The barrel runs this on every import through it — but it names ONE
          // tool, so it must not pull @fx/tools' other files in behind it.
          'src/index.ts': "import { used } from '@fx/tools'\nexport { foo } from './foo'\nexport const wired = used\n",
          'src/foo.ts': 'export function foo() { return 1 }\n'
        }
      },
      { name: '@fx/app', files: { 'src/uses.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n" } }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      const tools = dir('@fx/tools')
      // Never-miss: the name the barrel actually runs, and the barrel it came through.
      expect(selectSet(root, [join(tools, 'src/used.ts')])).toContain(uses)
      expect(selectSet(root, [join(tools, 'src/index.ts')])).toContain(uses)
      expect(selectSet(root, [join(dir('@fx/lib'), 'src/foo.ts')])).toContain(uses)
      // Precision: `spare` is a sibling export of `used`, on nobody's path here.
      expect(selectSet(root, [join(tools, 'src/spare.ts')])).not.toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a hop's bare import of a package with no derivable entrypoint keeps the coarse edge (R3-5)", () => {
    const { root, dir } = mkWorkspace([
      // No `main`, no `exports` — nothing to resolve a name through, so this
      // package is only ever reachable coarsely.
      { name: '@fx/opaque', files: { 'src/thing.ts': 'export const thing = 1\n' } },
      {
        name: '@fx/lib',
        main: INDEX_MAIN,
        files: {
          'src/index.ts':
            "import { thing } from '@fx/opaque'\nexport { foo } from './foo'\nexport const wired = thing\n",
          'src/foo.ts': 'export function foo() { return 1 }\n'
        }
      },
      { name: '@fx/app', files: { 'src/uses.test.ts': "import { foo } from '@fx/lib'\ntest('foo', () => foo())\n" } }
    ])
    try {
      const uses = join(dir('@fx/app'), 'src/uses.test.ts')
      // The barrel runs @fx/opaque's module scope on every import through it; an
      // underivable entrypoint must degrade to the whole-package edge, not to silence.
      expect(selectSet(root, [join(dir('@fx/opaque'), 'src/thing.ts')])).toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// A relative specifier written with the extension the EMIT will have
// (`./demo.js` for `./demo.ts`) is how TypeScript's own ESM guidance says to
// write these, and how 512 of this repo's 883 relative imports under `apps/cli`
// are written. Resolving only "the literal path, then the path plus each source
// extension" finds neither `demo.js` nor `demo.js.ts`, so every such edge was
// absent from the graph outright — under-selection, silently.
describe('a relative specifier written with an output extension resolves to its TypeScript source', () => {
  for (const [written, onDisk] of [
    ['.js', '.ts'],
    ['.js', '.tsx'],
    ['.jsx', '.tsx'],
    ['.mjs', '.mts'],
    ['.cjs', '.cts']
  ] as const) {
    it(`${written} specifier naming a ${onDisk} file selects the test that imports it`, () => {
      const { root, dir } = mkWorkspace([
        {
          name: '@ext/a',
          files: {
            [`src/target${onDisk}`]: 'export function target() { return 1 }\n',
            'src/uses.test.ts': `import { target } from './target${written}'\ntest('t', () => target())\n`
          }
        }
      ])
      try {
        const uses = join(dir('@ext/a'), 'src/uses.test.ts')
        expect(selectSet(root, [join(dir('@ext/a'), `src/target${onDisk}`)])).toContain(uses)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  // Which of the two a `./target.js` specifier means depends on who is
  // resolving: the compiler reads the TypeScript source, a runtime loads the
  // emitted JavaScript. Neither can be dropped, so both carry an edge.
  it('a real .js file sitting beside a .ts of the same name selects on a change to EITHER', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@ext/b',
        files: {
          'src/target.js': 'export function target() { return 1 }\n',
          'src/target.ts': 'export function target() { return 2 }\n',
          'src/uses.test.ts': "import { target } from './target.js'\ntest('t', () => target())\n"
        }
      }
    ])
    try {
      const uses = join(dir('@ext/b'), 'src/uses.test.ts')
      expect(selectSet(root, [join(dir('@ext/b'), 'src/target.js')])).toContain(uses)
      expect(selectSet(root, [join(dir('@ext/b'), 'src/target.ts')])).toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a directory index written as ./dir/index.js resolves to ./dir/index.ts', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@ext/c',
        files: {
          'src/nested/index.ts': 'export function nested() { return 1 }\n',
          'src/uses.test.ts': "import { nested } from './nested/index.js'\ntest('t', () => nested())\n"
        }
      }
    ])
    try {
      const uses = join(dir('@ext/c'), 'src/uses.test.ts')
      expect(selectSet(root, [join(dir('@ext/c'), 'src/nested/index.ts')])).toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The brief's own O1 fixture, on the REAL tree rather than a constructed one:
  // `apps/cli/tests/demo.test.ts` imports `'../src/commands/demo.js'`, and before
  // this resolution existed a change to `demo.ts` selected nothing but the
  // always-run list.
  it('on the real repository, a change to apps/cli/src/commands/demo.ts selects apps/cli/tests/demo.test.ts', () => {
    const selected = new Set(
      selectAffectedTestFiles(REPO_ROOT, [join(REPO_ROOT, 'apps/cli/src/commands/demo.ts')]).selected
    )
    expect(selected).toContain(join(REPO_ROOT, 'apps/cli/tests/demo.test.ts'))
  })
})

// O2 — resolution is the compiler's, with the text scan kept only for a
// repository that has no `typescript` to resolve. Both must hold the never-miss
// line; the compiler is what makes the selection narrow as well as safe.
describe('the compiler resolves the graph, and the text scan remains a safe fallback', () => {
  it('on the real repository the compiler answers, and reports its program build separately from selection', () => {
    const result = selectAffectedTestFiles(REPO_ROOT, [join(REPO_ROOT, 'apps/cli/src/commands/demo.ts')])
    expect(result.resolver).toBe('compiler')
    expect(result.programMs).toBeGreaterThan(0)
  })

  it('the text-scan fallback is reachable, resolves .js specifiers too, and never omits what the compiler selects', () => {
    const changed = [join(REPO_ROOT, 'apps/cli/src/commands/demo.ts')]
    const scan = selectAffectedTestFiles(REPO_ROOT, changed, { resolver: 'text-scan' })
    const compiler = selectAffectedTestFiles(REPO_ROOT, changed)
    expect(scan.resolver).toBe('text-scan')
    expect(scan.programMs).toBe(0)
    expect(scan.selected).toContain(join(REPO_ROOT, 'apps/cli/tests/demo.test.ts'))
    // The fallback is a strict over-approximation: anything the compiler proves
    // reachable, the coarser scan must also reach.
    const scanned = new Set(scan.selected)
    expect(compiler.selected.filter((f) => !scanned.has(f))).toEqual([])
  })

  it('a named import resolves to the file that DEFINES it, across a re-export chain and a package boundary', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@c2/deep',
        main: INDEX_MAIN,
        files: {
          'src/index.ts': "export { deep } from './deep.js'\n",
          'src/deep.ts': 'export function deep() { return 1 }\n',
          'src/sibling.ts': 'export function sibling() { return 2 }\n'
        }
      },
      {
        name: '@c2/mid',
        main: INDEX_MAIN,
        files: { 'src/index.ts': "export { deep } from '@c2/deep'\nexport const midOwn = 1\n" }
      },
      {
        name: '@c2/app',
        files: { 'src/uses.test.ts': "import { deep as d } from '@c2/mid'\ntest('deep', () => d())\n" }
      }
    ])
    try {
      const uses = join(dir('@c2/app'), 'src/uses.test.ts')
      // The definition, and every hop on the path to it, select.
      expect(selectSet(root, [join(dir('@c2/deep'), 'src/deep.ts')])).toContain(uses)
      expect(selectSet(root, [join(dir('@c2/deep'), 'src/index.ts')])).toContain(uses)
      expect(selectSet(root, [join(dir('@c2/mid'), 'src/index.ts')])).toContain(uses)
      // A sibling in the same package that the name never resolves through does not.
      expect(selectSet(root, [join(dir('@c2/deep'), 'src/sibling.ts')])).not.toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a bare workspace specifier resolves from the package MANIFEST, with no node_modules present at all', () => {
    const { root, dir } = mkWorkspace([
      {
        name: '@c2/lib',
        exports: { '.': './src/index.ts', './sub': './src/sub.ts' },
        files: {
          'src/index.ts': 'export function root() { return 1 }\n',
          'src/sub.ts': 'export function sub() { return 2 }\n'
        }
      },
      {
        name: '@c2/app',
        files: { 'src/uses-sub.test.ts': "import { sub } from '@c2/lib/sub'\ntest('sub', () => sub())\n" }
      }
    ])
    try {
      const uses = join(dir('@c2/app'), 'src/uses-sub.test.ts')
      expect(selectSet(root, [join(dir('@c2/lib'), 'src/sub.ts')])).toContain(uses)
      expect(selectSet(root, [join(dir('@c2/lib'), 'src/index.ts')])).not.toContain(uses)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// O3 — a diff is attributed to the top-level declarations its hunks touch, and
// selection follows those names. Every shape that cannot be attributed widens to
// the whole file, which is the file-level answer, never a narrower one.
describe('changed-name attribution (O3)', () => {
  const ts = loadTypeScript(REPO_ROOT) as NonNullable<ReturnType<typeof loadTypeScript>>

  /** One modified file, with its hunk ranges given directly rather than through git. */
  function modified(source: string, afterRanges: LineRange[], before = source, beforeRanges: LineRange[] = []) {
    return affectedNamesForFile(ts, {
      file: '/w/mod.ts',
      after: source,
      before,
      afterRanges,
      beforeRanges
    })
  }

  const SOURCE = [
    "import { dep } from './dep.js'", // 1
    '', // 2
    'export function alpha() {', // 3
    '  return 1', // 4
    '}', // 5
    '', // 6
    'export function beta() {', // 7
    '  return helper()', // 8
    '}', // 9
    '', // 10
    'function helper() {', // 11
    '  return dep', // 12
    '}', // 13
    '', // 14
    'export const gamma = 3' // 15
  ].join('\n')

  it('a hunk inside one exported function attributes to that name alone', () => {
    expect(modified(SOURCE, [{ start: 4, end: 4 }])).toEqual(new Set(['alpha']))
  })

  it('a hunk in a local helper also affects every exported declaration that uses it', () => {
    // `beta` calls `helper`; `alpha` and `gamma` do not.
    expect(modified(SOURCE, [{ start: 12, end: 12 }])).toEqual(new Set(['helper', 'beta']))
  })

  it('an exported const attributes to its own name', () => {
    expect(modified(SOURCE, [{ start: 15, end: 15 }])).toEqual(new Set(['gamma']))
  })

  it('a hunk in an import statement widens to the whole file', () => {
    expect(modified(SOURCE, [{ start: 1, end: 1 }])).toBe(ALL_NAMES)
  })

  it('a hunk past the last declaration widens to the whole file', () => {
    expect(modified(SOURCE, [{ start: 99, end: 99 }])).toBe(ALL_NAMES)
  })

  for (const [label, source] of [
    ['module-scope executable code', "console.log('boot')\nexport function f() { return 1 }\n"],
    ['an `export *` re-export', "export * from './other.js'\nexport function f() { return 1 }\n"],
    ['an `export default`', 'export default function () { return 1 }\n'],
    ['a destructuring binding', 'export const { a, b } = load()\n']
  ] as const) {
    it(`${label} widens to the whole file`, () => {
      expect(modified(source, [{ start: 1, end: 1 }])).toBe(ALL_NAMES)
    })
  }

  it('a declaration deleted by the diff is attributed from the OLD side', () => {
    const before = 'export function gone() { return 1 }\nexport function kept() { return 2 }\n'
    const after = 'export function kept() { return 2 }\n'
    expect(
      affectedNamesForFile(ts, {
        file: '/w/mod.ts',
        after,
        before,
        afterRanges: [{ start: 1, end: 0 }], // git's zero-width `+N,0` on a pure deletion
        beforeRanges: [{ start: 1, end: 1 }]
      })
    ).toEqual(new Set(['gone']))
  })

  it('a non-TypeScript changed file is never narrowed', () => {
    expect(
      affectedNamesForFile(ts, {
        file: '/w/vinaya.config.json',
        after: '{}',
        before: '{}',
        afterRanges: [{ start: 1, end: 1 }],
        beforeRanges: []
      })
    ).toBe(ALL_NAMES)
  })

  it('parseHunkRanges reads both sides, including git’s zero-width counts', () => {
    const patch = ['@@ -10,0 +11,3 @@', 'body', '@@ -20,2 +24,0 @@', 'body', '@@ -30 +34 @@'].join('\n')
    expect(parseHunkRanges(patch)).toEqual({
      beforeRanges: [
        { start: 10, end: 9 },
        { start: 20, end: 21 },
        { start: 30, end: 30 }
      ],
      afterRanges: [
        { start: 11, end: 13 },
        { start: 24, end: 23 },
        { start: 34, end: 34 }
      ]
    })
  })
})

describe('selection follows the changed names, and widens to file level when it cannot (O3)', () => {
  const NAMED_LIB = {
    'src/index.ts': "export { hot } from './hot.js'\nexport { cold } from './cold.js'\n",
    'src/hot.ts': 'export function hot() { return 1 }\n',
    'src/cold.ts': 'export function cold() { return 2 }\n'
  }

  function workspace() {
    return mkWorkspace([
      { name: '@o3/lib', main: INDEX_MAIN, files: NAMED_LIB },
      {
        name: '@o3/app',
        files: {
          'src/uses-hot.test.ts': "import { hot } from '@o3/lib'\ntest('hot', () => hot())\n",
          'src/uses-cold.test.ts': "import { cold } from '@o3/lib'\ntest('cold', () => cold())\n"
        }
      }
    ])
  }

  it('a change to ONE re-exported name on a shared barrel selects only that name’s consumer', () => {
    const { root, dir } = workspace()
    try {
      const index = join(dir('@o3/lib'), 'src/index.ts')
      const usesHot = join(dir('@o3/app'), 'src/uses-hot.test.ts')
      const usesCold = join(dir('@o3/app'), 'src/uses-cold.test.ts')
      const selected = new Set(
        selectAffectedTestFiles(root, [index], { affectedNames: new Map([[index, new Set(['hot'])]]) }).selected
      )
      expect(selected).toContain(usesHot)
      expect(selected).not.toContain(usesCold)
      // Without name information the same change is file-level: both select.
      const fileLevel = new Set(selectAffectedTestFiles(root, [index]).selected)
      expect(fileLevel).toContain(usesHot)
      expect(fileLevel).toContain(usesCold)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('an unattributable hunk (`all`) selects everything the file-level graph reaches', () => {
    const { root, dir } = workspace()
    try {
      const index = join(dir('@o3/lib'), 'src/index.ts')
      const named = new Set(
        selectAffectedTestFiles(root, [index], { affectedNames: new Map([[index, ALL_NAMES]]) }).selected
      )
      expect(named).toEqual(new Set(selectAffectedTestFiles(root, [index]).selected))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('on the real repository, a one-name change selects strictly fewer files than the file-level answer', () => {
    const changed = join(REPO_ROOT, 'packages/aeg-core/src/review-input-manifest.ts')
    const fileLevel = selectAffectedTestFiles(REPO_ROOT, [changed]).selected.length
    const oneName = selectAffectedTestFiles(REPO_ROOT, [changed], {
      affectedNames: new Map([[changed, new Set(['isBoundToPolicy'])]])
    }).selected.length
    expect(oneName).toBeLessThan(fileLevel)
  })
})

// O7 — a test whose input is the repository TREE has no import edge to the
// files it inspects, so reachability can never select it on the merits. The
// rule that does lives in the selector, not in repository configuration, so it
// travels with the selector into every repository that uses it.
describe('tests that read the repository tree are selected from what they scan (O7)', () => {
  const ts = loadTypeScript(REPO_ROOT) as NonNullable<ReturnType<typeof loadTypeScript>>

  it('classifies a real-tree scanner, and never a test that only walks its own temporary fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'vinaya-scan-'))
    try {
      mkdirSync(join(root, 'tests'), { recursive: true })
      const scanner = join(root, 'tests', 'scanner.test.ts')
      writeFileSync(
        scanner,
        [
          "import { readdirSync } from 'node:fs'",
          "import { join } from 'node:path'",
          "const REPO_ROOT = join(import.meta.dir, '..')",
          "const TREE = join(REPO_ROOT, 'src')",
          "test('scans', () => readdirSync(TREE))",
          ''
        ].join('\n')
      )
      const fixtureWalker = join(root, 'tests', 'fixture.test.ts')
      writeFileSync(
        fixtureWalker,
        [
          "import { mkdtempSync, readdirSync } from 'node:fs'",
          "import { tmpdir } from 'node:os'",
          "import { join } from 'node:path'",
          "test('walks its own fixture', () => {",
          "  const dir = mkdtempSync(join(tmpdir(), 'x-'))",
          '  readdirSync(dir)',
          '})',
          ''
        ].join('\n')
      )
      // `root` stands in for the repository root here; the scanner anchors on
      // its own module directory, the fixture walker on `tmpdir()`.
      expect(scannedRootsOf(ts, scanner, readFileSync(scanner, 'utf8'), root)).toEqual([join(root, 'src')])
      expect(scannedRootsOf(ts, fixtureWalker, readFileSync(fixtureWalker, 'utf8'), root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a git ls-files reader is classified as scanning the whole repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'vinaya-scan-'))
    try {
      const file = join(root, 'tracked.test.ts')
      writeFileSync(
        file,
        [
          "import { execFileSync } from 'node:child_process'",
          "test('tracked', () => execFileSync('git', ['ls-files'], { encoding: 'utf8' }))",
          ''
        ].join('\n')
      )
      expect(scannedRootsOf(ts, file, readFileSync(file, 'utf8'), root)).toEqual([root])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The exact incident: a pull request changing one test file passed pre-push
  // and failed CI on the test that audits every real-process call site, which
  // reads the whole test tree from disk and so had no edge to what changed.
  it('adding a bare subprocess call to a test file selects the test that audits real-process call sites', () => {
    const auditor = join(REPO_ROOT, 'apps/cli/tests/process-fixture-coverage.test.ts')
    const changedTest = join(REPO_ROOT, 'apps/cli/tests/demo.test.ts')
    expect(selectAffectedTestFiles(REPO_ROOT, [changedTest]).selected).toContain(auditor)
    // And it is reachability through the scan rule that does it, not an import
    // edge and not the configured always-run list.
    expect(selectAffectedTestFiles(REPO_ROOT, [changedTest], { repoTreeScanners: 'ignore' }).selected).not.toContain(
      auditor
    )
  })

  it('a narrowly-scoped scanner is not selected by a change outside the tree it reads', () => {
    // `surface-spec-exports.test.ts` reads `apps/cli/src/commands`; a change in
    // another package is outside its input entirely.
    const scanner = join(REPO_ROOT, 'apps/cli/tests/surface-spec-exports.test.ts')
    const roots = scannedRootsOf(ts, scanner, readFileSync(scanner, 'utf8'), REPO_ROOT)
    expect(roots).toEqual([join(REPO_ROOT, 'apps/cli/src/commands')])
  })
})

// Round 2 review, F1 — `import x = require('<spec>')` carries no `from`, no
// quote directly after `import`, and no `import(` call, so it was the one shape
// the text-scan graph could not see at all. A shape a graph cannot see
// contributes no edge, which is silence rather than the coarse fallback; the
// compiler graph degraded it correctly but had no fixture proving it either.
describe('`import x = require(...)` degrades to the coarse edge under BOTH resolvers (F1)', () => {
  const LIB = {
    'src/index.ts': "export { foo } from './foo.js'\nexport { bar } from './bar.js'\n",
    'src/foo.ts': 'export function foo() { return 1 }\n',
    'src/bar.ts': 'export function bar() { return 2 }\n'
  }

  for (const resolver of ['compiler', 'text-scan'] as const) {
    it(`${resolver}: a bare workspace specifier keeps the whole-package edge`, () => {
      const { root, dir } = mkWorkspace([
        { name: '@ieq/lib', main: INDEX_MAIN, files: LIB },
        {
          name: '@ieq/app',
          files: {
            'src/uses.test.ts': "import lib = require('@ieq/lib')\ntest('lib', () => lib)\n",
            // The control: a precisely-resolved importer of one name, which a
            // change to the OTHER name must never select.
            'src/control.test.ts': "import { foo } from '@ieq/lib'\ntest('foo', () => foo())\n"
          }
        }
      ])
      try {
        const uses = join(dir('@ieq/app'), 'src/uses.test.ts')
        const control = join(dir('@ieq/app'), 'src/control.test.ts')
        const selected = new Set(
          selectAffectedTestFiles(root, [join(dir('@ieq/lib'), 'src/bar.ts')], { resolver }).selected
        )
        expect(selected).toContain(uses)
        expect(selected).not.toContain(control)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it(`${resolver}: a relative specifier still yields its edge`, () => {
      const { root, dir } = mkWorkspace([
        {
          name: '@ieq/rel',
          files: {
            'src/target.ts': 'export function target() { return 1 }\n',
            'src/uses.test.ts': "import t = require('./target.js')\ntest('t', () => t)\n"
          }
        }
      ])
      try {
        const uses = join(dir('@ieq/rel'), 'src/uses.test.ts')
        expect(
          selectAffectedTestFiles(root, [join(dir('@ieq/rel'), 'src/target.ts')], { resolver }).selected
        ).toContain(uses)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it(`${resolver}: the form a re-export hop writes is traversed too`, () => {
      const { root, dir } = mkWorkspace([
        { name: '@ieq/opaque', main: INDEX_MAIN, files: { 'src/index.ts': 'export const thing = 1\n' } },
        {
          name: '@ieq/hop',
          main: INDEX_MAIN,
          files: {
            // The barrel pulls a whole module into its OWN scope this way, which
            // runs on every import through it.
            'src/index.ts':
              "import opaque = require('@ieq/opaque')\nexport { foo } from './foo.js'\nexport const wired = opaque\n",
            'src/foo.ts': 'export function foo() { return 1 }\n'
          }
        },
        {
          name: '@ieq/app',
          files: { 'src/uses.test.ts': "import { foo } from '@ieq/hop'\ntest('foo', () => foo())\n" }
        }
      ])
      try {
        const uses = join(dir('@ieq/app'), 'src/uses.test.ts')
        expect(
          selectAffectedTestFiles(root, [join(dir('@ieq/opaque'), 'src/index.ts')], { resolver }).selected
        ).toContain(uses)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('the text-scan graph extracts the specifier at all — the silence F1 found', () => {
    expect(extractImportSpecifiers("import lib = require('@ieq/lib')\n")).toEqual(['@ieq/lib'])
    expect(extractImportSpecifiers("export import lib = require('./thing.js')\n")).toEqual(['./thing.js'])
  })
})
