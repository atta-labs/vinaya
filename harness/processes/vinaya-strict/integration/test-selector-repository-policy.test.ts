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

// A push that changes the repository-root `vinaya.config.json` runs the CLI's
// whole suite. That file configures every command a test spawns — where
// telemetry is delivered above all — and no test imports it, so the import
// graph can never reach it: before this rule, a push that changed only it
// selected nothing, which is how a `logs.url` added there passed pre-push
// and failed CI. That whole-suite answer is the transitive walk's — CI's own.
// Under depth one (the pre-push hook) it narrows to the CLI tests that import
// the configuration loader module directly, plus `alwaysRun`, so a push that
// touches the root file fits the publish tool's time limit. Proved on a
// throwaway workspace whose own CLI entrypoint and loader are named through
// `cliEntrypoint` and `configLoader`, so the rule is exercised by its real
// mechanism rather than against this repository's own tree.
describe('the repository-root configuration selects the whole CLI suite transitively, the loader importers at depth one', () => {
  function configFixture(): { root: string; cliEntrypoint: string; configLoader: string } {
    const root = mkdtempSync(join(tmpdir(), 'vinaya-rootcfg-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }))
    writeFileSync(join(root, ROOT_CONFIG_FILENAME), '{}\n')

    const cli = join(root, 'apps', 'cli')
    mkdirSync(join(cli, 'src'), { recursive: true })
    mkdirSync(join(cli, 'tests'), { recursive: true })
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@fx/cli', main: './src/index.ts' }))
    writeFileSync(join(cli, 'src', 'index.ts'), 'export function run() { return 1 }\n')
    writeFileSync(join(cli, 'src', 'unrelated.ts'), 'export function unrelated() { return 2 }\n')
    writeFileSync(join(cli, 'tests', 'importer.test.ts'), "import { run } from '../src/index.js'\nrun()\n")
    // Imports nothing at all: reachability alone would never select it, so
    // its selection is the rule's own doing and nothing else's.
    writeFileSync(join(cli, 'tests', 'orphan.test.ts'), 'const x = 1\nexport default x\n')
    mkdirSync(join(cli, 'src', 'lib'), { recursive: true })
    writeFileSync(join(cli, 'src', 'lib', 'config.ts'), 'export function loadConfig() { return null }\n')
    writeFileSync(
      join(cli, 'src', 'uses-config.ts'),
      "import { loadConfig } from './lib/config.js'\nexport function usesConfig() { return loadConfig() }\n"
    )
    writeFileSync(
      join(cli, 'tests', 'loader.test.ts'),
      "import { loadConfig } from '../src/lib/config.js'\nloadConfig()\n"
    )
    // Reaches the loader only through a second file: a depth-two edge.
    writeFileSync(
      join(cli, 'tests', 'indirect.test.ts'),
      "import { usesConfig } from '../src/uses-config.js'\nusesConfig()\n"
    )

    const other = join(root, 'packages', 'other')
    mkdirSync(join(other, 'src'), { recursive: true })
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: '@fx/other', main: './src/index.ts' }))
    writeFileSync(join(other, 'src', 'index.ts'), 'export function other() { return 3 }\n')
    writeFileSync(join(other, 'src', 'other.test.ts'), "import { other } from './index.js'\nother()\n")

    return { root, cliEntrypoint: 'apps/cli/src/index.ts', configLoader: 'apps/cli/src/lib/config.ts' }
  }

  it('under the transitive walk a change to only it selects every test in the CLI package, orphan included', () => {
    const { root, cliEntrypoint, configLoader } = configFixture()
    try {
      const { selected, totalTestFiles } = selectAffectedTestFiles(root, [join(root, ROOT_CONFIG_FILENAME)], {
        cliEntrypoint,
        configLoader,
        depth: 'transitive'
      })
      expect(totalTestFiles).toBe(5)
      const tests = join(root, 'apps', 'cli', 'tests')
      expect(new Set(selected)).toEqual(
        new Set(['importer', 'orphan', 'loader', 'indirect'].map((name) => join(tests, `${name}.test.ts`)))
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("under depth one it selects only the loader's direct importers plus alwaysRun, never an orphan or a depth-two importer", () => {
    const { root, cliEntrypoint, configLoader } = configFixture()
    try {
      const tests = join(root, 'apps', 'cli', 'tests')
      const onlyLoader = selectAffectedTestFiles(root, [join(root, ROOT_CONFIG_FILENAME)], {
        cliEntrypoint,
        configLoader,
        depth: 'one'
      })
      expect(onlyLoader.selected).toEqual([join(tests, 'loader.test.ts')])

      const withAlwaysRun = selectAffectedTestFiles(root, [join(root, ROOT_CONFIG_FILENAME)], {
        cliEntrypoint,
        configLoader,
        depth: 'one',
        alwaysRun: ['apps/cli/tests/importer.test.ts']
      })
      expect(new Set(withAlwaysRun.selected)).toEqual(
        new Set([join(tests, 'loader.test.ts'), join(tests, 'importer.test.ts')])
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a configuration file that is not the repository root one selects nothing — the rule matches one path, not every JSON file', () => {
    const { root, cliEntrypoint, configLoader } = configFixture()
    try {
      const nested = join(root, 'apps', 'cli', 'tests', ROOT_CONFIG_FILENAME)
      writeFileSync(nested, '{}\n')
      const other = join(root, 'packages', 'other', 'package.json')
      for (const changed of [nested, other, join(root, 'tsconfig.json')]) {
        for (const depth of ['one', 'transitive'] as const) {
          const { selected } = selectAffectedTestFiles(root, [changed], { cliEntrypoint, configLoader, depth })
          expect(selected.filter((f) => f.startsWith(join(root, 'apps', 'cli')))).toEqual([])
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("this repository's own root configuration selects its whole CLI suite transitively, every file in it", () => {
    const { selected, totalTestFiles } = selectAffectedTestFiles(REPO_ROOT, [join(REPO_ROOT, ROOT_CONFIG_FILENAME)], {
      depth: 'transitive'
    })
    const cliTests = selected.filter((f) => f.startsWith(join(REPO_ROOT, 'apps', 'cli')))
    const onDisk = walkFiles(join(REPO_ROOT, 'apps', 'cli')).filter(isTestFile)
    expect(new Set(cliTests)).toEqual(new Set(onDisk))
    expect(cliTests.length).toBeLessThanOrEqual(totalTestFiles)
  }, 60_000)

  it("at depth one this repository's own root configuration selects the loader's direct importers, not the whole CLI suite", () => {
    const { selected } = selectAffectedTestFiles(REPO_ROOT, [join(REPO_ROOT, ROOT_CONFIG_FILENAME)], { depth: 'one' })
    const cliTests = selected.filter((f) => f.startsWith(join(REPO_ROOT, 'apps', 'cli')))
    const onDisk = walkFiles(join(REPO_ROOT, 'apps', 'cli')).filter(isTestFile)
    // The configuration golden test imports `../src/lib/config.js` directly, so it is one of them.
    expect(cliTests).toContain(join(REPO_ROOT, 'apps/cli/tests/config-golden.test.ts'))
    expect(cliTests.length).toBeLessThan(onDisk.length / 4)
  }, 60_000)
})
