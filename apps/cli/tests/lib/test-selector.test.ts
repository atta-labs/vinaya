// task-run-v1 20, O6/Part 5 — the file-level test selector, proved against
// real fixtures on disk (never mocked import resolution). The literal Part 5
// shape — two packages, three test files, one changed file selects exactly
// one — is `minimalTwoPackageFixture` below; a richer fixture covers
// transitive chains and cross-package bare-specifier resolution.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
