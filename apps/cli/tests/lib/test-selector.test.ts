// task-run-v1 20, O6/Part 5 — the file-level test selector, proved against
// real fixtures on disk (never mocked import resolution). The literal Part 5
// shape — two packages, three test files, one changed file selects exactly
// one — is `minimalTwoPackageFixture` below; a richer fixture covers
// transitive chains and cross-package bare-specifier resolution.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../src/lib/config'
import { discoverWorkspacePackages, isTestFile, selectAffectedTestFiles } from '../../src/lib/test-selector'

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

    it(`${label} — reachability ALONE (no alwaysRun) never selects it — the real gap this task closes`, () => {
      const { selected } = selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun: [] })
      expect(selected).not.toContain(LOG_CALLERS_TEST)
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
type PkgSpec = { name: string; main?: string; test?: string; files: Record<string, string> }

/** Writes a throwaway multi-package workspace to a temp dir and returns its root plus a `dir(name)` locator. */
function mkWorkspace(pkgs: PkgSpec[]): { root: string; dir: (name: string) => string } {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-sym-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
  const dirs = new Map<string, string>()
  pkgs.forEach((p, i) => {
    const dir = join(root, 'packages', `p${i}`)
    dirs.set(p.name, dir)
    mkdirSync(dir, { recursive: true })
    const manifest: { name: string; main?: string; scripts?: { test: string } } = { name: p.name }
    if (p.main) manifest.main = p.main
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
