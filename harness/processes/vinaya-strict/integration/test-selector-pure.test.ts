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
import {
  ALL_NAMES,
  affectedNamesForFile,
  type LineRange,
  parseHunkRanges
} from '../../../kernel/gates/ring0-hooks/pre-push/verification/index'
import { loadConfig } from '../../../../apps/cli/src/lib/config'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../../apps/cli/tests/lib/process-fixture'
import {
  discoverWorkspaceDirs,
  discoverWorkspacePackages,
  expandWorkspacePatterns,
  extractImportSpecifiers,
  isTestFile,
  ROOT_CONFIG_FILENAME,
  selectAffectedTestFiles,
  walkFiles
} from './repository-verification'
import { cliSpawnEdgeOf } from '../../../kernel/gates/ring0-hooks/pre-push/cli-spawn-tests'
import { spawnEdgeOf, startedScriptsOf } from '../../../kernel/gates/ring0-hooks/pre-push/verification/spawn-inputs'
import { scannedRootsOf } from './verification-scanner-policy'
import { loadTypeScript } from '../../../kernel/gates/ring0-hooks/pre-push/verification/index'
import { fixtureDir } from '../../../../apps/cli/tests/lib/test-temp-fixture'

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

// Issue #660, O2 — two real 2026-09-19 pushes passed the pre-push hook and
// then failed CI on `log-callers — O2` (harness/processes/vinaya-strict/integration/log/client/log-callers.test.ts):
// a repo-wide invariant test that walks every source file directly, so no
// import edge from a changed file ever reaches it — reachability alone can
// never select it, which is exactly the case `alwaysRun` exists for. Each
// change set below is the REAL repo-root-relative file list from that push
// (`git diff --name-only <fork-point>...<head>` at the actual commits:
// task-operator-v1/5's 93e25534 and task-files-v1/1's first push a6d9640c),
// reproduced live against these commits to confirm log-callers — O2 does
// fail on the unmodified tree (`bun test harness/processes/vinaya-strict/integration/log/client/log-callers.test.ts`
// at each sha, offenders: `harness/kernel/connectors/checkpoint/control-store/local.ts`).
const REPO_ROOT = join(import.meta.dir, '../../../..')
const LOG_CALLERS_TEST = join(REPO_ROOT, 'harness/processes/vinaya-strict/integration/log/client/log-callers.test.ts')

const INCIDENT_CHANGE_SETS: Record<string, string[]> = {
  'task-operator-v1/5 — 93e25534, the control-store symlink fix': [
    'harness/kernel/run-paths.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/resume.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/start.ts',
    'harness/processes/vinaya-strict/integration/run-paths.test.ts',
    'harness/kernel/connectors/checkpoint/control-store/index.ts',
    'harness/kernel/connectors/checkpoint/control-store/local.test.ts',
    'harness/kernel/connectors/checkpoint/control-store/local.ts',
    'packages/aeg-core/src/index.ts'
  ],
  'task-files-v1/1 — a6d9640c, the one-runtime-directory first push': [
    '.changeset/task-files-v1-1-one-runtime-directory.md',
    'harness/kernel/isolation/isolation.md',
    'harness/kernel/log/log.md',
    'harness/processes/vinaya-strict/loops/dev-review/loop.md',
    'apps/cli/src/lib/config.ts',
    'harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts',
    'harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/pause-resume.ts',
    'harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/publication.ts',
    'harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/reviewer-dispatch.ts',
    'harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/reviewer-isolation.ts',
    'harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts',
    'harness/kernel/effects/effects.ts',
    'harness/kernel/log/log-sink.ts',
    'harness/kernel/log/client/loop-log.ts',
    'harness/kernel/run-paths.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/task-run.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/task-status.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/cancel.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/handlers.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/read.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/resume.ts',
    'harness/processes/vinaya-strict/loops/dev-review/run-control/start.ts',
    'harness/kernel/isolation/worker-boundary.ts',
    'apps/cli/tests/ci-shards/shard-2.txt',
    'apps/cli/tests/ci-shards/shard-3.txt',
    'harness/processes/vinaya-strict/tests/standalone/lib/dev-review-loop/driver-integration.test.ts',
    'harness/processes/vinaya-strict/tests/standalone/lib/dev-review-loop/reviewer-dispatch.test.ts',
    'harness/processes/vinaya-strict/tests/lib/dispatch/dispatch-helpers.test.ts',
    'harness/processes/vinaya-strict/tests/lib/dispatch/dispatch-child-process.test.ts',
    'harness/processes/vinaya-strict/tests/lib/dispatch/dispatch-vinaya-policy.test.ts',
    'harness/kernel/adapters/agents/dispatch/launch-intent.test.ts',
    'apps/cli/tests/lib/dispatch/worker-boundary.test.ts',
    'harness/kernel/effects/executor.test.ts',
    'apps/cli/tests/lib/loop-log.test.ts',
    'harness/processes/vinaya-strict/integration/run-paths.test.ts',
    'harness/processes/vinaya-strict/tests/lib/task-status.test.ts',
    'harness/processes/vinaya-strict/tests/lib/task-tools/cancel.test.ts',
    'harness/processes/vinaya-strict/tests/lib/task-tools/read.test.ts',
    'harness/processes/vinaya-strict/tests/lib/task-tools/resume.test.ts',
    'harness/processes/vinaya-strict/integration/run-paths-only.test.ts',
    'harness/kernel/connectors/checkpoint/control-store/local.test.ts',
    'harness/kernel/connectors/checkpoint/control-store/local.ts',
    'packages/sources/src/config-reference.ts'
  ]
}

// symbol-aware-test-selection-v1 1, Part 3 — real on-disk fixtures for every
// import/export shape the refinement must resolve precisely or fall back on:
// aliases and `type` imports, nested and cross-package re-exports, unambiguous
// vs. ambiguous `export *`, cyclic re-exports, namespace/default/dynamic/unknown
// shapes, and a test that reaches a bare-package import only through an
// intermediate file. Never mocked: each writes a throwaway workspace to disk.
type PkgSpec = { name: string; main?: string; exports?: unknown; test?: string; files: Record<string, string> }

/** Writes a throwaway multi-package workspace to a temp dir and returns its root plus a `dir(name)` locator. */
function mkWorkspace(
  pkgs: PkgSpec[],
  root = mkdtempSync(join(tmpdir(), 'vinaya-sym-'))
): { root: string; dir: (name: string) => string } {
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

describe('isTestFile', () => {
  it('matches *.test.<ext> only', () => {
    expect(isTestFile('/a/b/foo.test.ts')).toBe(true)
    expect(isTestFile('/a/b/foo.test.tsx')).toBe(true)
    expect(isTestFile('/a/b/foo.ts')).toBe(false)
    expect(isTestFile('/a/b/footest.ts')).toBe(false)
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

  const EXPORT_LISTS = [
    'export {', // 1
    '  alpha,', // 2
    '  beta as renamed,', // 3
    "} from './a.js'", // 4
    "export { solo } from './b.js'", // 5
    "export * from './c.js'", // 6
    'function local() { return 1 }', // 7
    'export {', // 8
    '  local as publicLocal', // 9
    '}', // 10
    'export {', // 11
    '  moved', // 12
    '}', // 13
    "  from './d.js'" // 14
  ].join('\n')

  it('a hunk on a specifier line of a named export list attributes to that exported name', () => {
    expect(modified(EXPORT_LISTS, [{ start: 2, end: 2 }])).toEqual(new Set(['alpha']))
  })

  it('an aliased specifier attributes to the name it exports, not the one it re-exports', () => {
    expect(modified(EXPORT_LISTS, [{ start: 3, end: 3 }])).toEqual(new Set(['renamed']))
    expect(modified(EXPORT_LISTS, [{ start: 9, end: 9 }])).toEqual(new Set(['publicLocal']))
  })

  it('a hunk across several specifier lines attributes to each of them', () => {
    expect(modified(EXPORT_LISTS, [{ start: 2, end: 3 }])).toEqual(new Set(['alpha', 'renamed']))
  })

  it('a local declaration exported under an alias affects the exported name too', () => {
    expect(modified(EXPORT_LISTS, [{ start: 7, end: 7 }])).toEqual(new Set(['local', 'publicLocal']))
  })

  for (const [label, line] of [
    ['the `export {` line', 1],
    ['the `} from` line', 4],
    ['a one-line list, whose line holds its braces and module specifier', 5],
    ['an `export *` statement', 6],
    ['a local list’s closing brace', 10],
    ['a module specifier on its own line', 14]
  ] as const) {
    it(`a hunk on ${label} widens to the whole file`, () => {
      expect(modified(EXPORT_LISTS, [{ start: line, end: line }])).toBe(ALL_NAMES)
    })
  }

  it('a hunk spanning a specifier line and the statement’s brace widens to the whole file', () => {
    expect(modified(EXPORT_LISTS, [{ start: 3, end: 4 }])).toBe(ALL_NAMES)
  })

  it('a specifier removed by the diff is attributed from the OLD side', () => {
    const before = "export {\n  kept,\n  gone,\n} from './a.js'\n"
    const after = "export {\n  kept,\n} from './a.js'\n"
    expect(
      affectedNamesForFile(ts, {
        file: '/w/mod.ts',
        after,
        before,
        afterRanges: [{ start: 3, end: 2 }],
        beforeRanges: [{ start: 3, end: 3 }]
      })
    ).toEqual(new Set(['gone']))
  })

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
