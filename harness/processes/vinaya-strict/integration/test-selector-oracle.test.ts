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

describe('selectAffectedTestFiles replayed against the two recorded 2026-09-19 incidents (Issue #660, O2)', () => {
  for (const [label, changed] of Object.entries(INCIDENT_CHANGE_SETS)) {
    it(`${label} — with this repo's real alwaysRun config, log-callers — O2 is selected`, () => {
      const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
      const { selected } = selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun })
      expect(selected).toContain(LOG_CALLERS_TEST)
    }, 30_000)

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
    }, 60_000)
  }
})

// Round 2 review, BLOCKER — the a6d9640c change set above failed a SECOND
// CI shard the first pass of this fixture never checked: GitHub Actions run
// 35434611919, shard 3, failed 6 assertions in
// harness/processes/vinaya-strict/tests/commands/task-status.test.ts (reproduced live at that sha).
// This was a DIFFERENT class of gap than log-callers — O2's: this file has no
// import edge to walk at all. It drives the real CLI end-to-end
// (`execFileSync('bun', [INDEX, ...])` against a string path, never a
// static `import` of any `src/` file), so reachability alone could never
// reach it regardless of what changed — confirmed by grep: this file's own
// import list is `node:child_process`/`node:fs`/`node:os`/`node:path`/
// `node:url`/`bun:test` only. `alwaysRun` was the escape hatch this task's
// own fix carried at the time, for a structurally different reason than
// log-callers (no edge existed to walk, rather than an edge that
// deliberately isn't one) — and it explicitly escalated "a broader audit of
// every CLI end-to-end test sharing this same blind spot" as out of its own
// bounded surface, future work rather than attempted there.
//
// Issue #702 is that escalated future work: `cli-spawn-tests.ts` gives
// exactly this shape (`execFileSync('bun', [INDEX, ...])`) a real edge, so
// reachability alone now reaches it — no `alwaysRun` entry required — the
// same way it reaches every other file that imports the entrypoint directly.
describe('a second real CI failure in the SAME task-files-v1/1 change set (Issue #660, O2, round 2 review BLOCKER; closed on the merits by Issue #702)', () => {
  const changed = INCIDENT_CHANGE_SETS['task-files-v1/1 — a6d9640c, the one-runtime-directory first push'] as string[]
  const TASK_STATUS_E2E_TEST = join(REPO_ROOT, 'harness/processes/vinaya-strict/tests/commands/task-status.test.ts')

  it("with this repo's real alwaysRun config, commands/task-status.test.ts (shard 3's real CI failure) is selected", () => {
    const alwaysRun = loadConfig()?.prePush?.alwaysRun ?? []
    const { selected } = selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun })
    expect(selected).toContain(TASK_STATUS_E2E_TEST)
  }, 30_000)

  it('reachability ALONE (no alwaysRun) now selects it on the merits — the CLI-spawn edge (Issue #702), not the escape hatch', () => {
    expect(selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun: [] }).selected).toContain(TASK_STATUS_E2E_TEST)
    // Withhold the new edge alone and the ORIGINAL gap is still visible
    // underneath — proving it is this edge doing the work, not a static
    // import this fixture happened to gain some other way.
    expect(
      selectAffectedTestFiles(REPO_ROOT, changed, { alwaysRun: [], cliSpawnDetection: 'ignore' }).selected
    ).not.toContain(TASK_STATUS_E2E_TEST)
  }, 60_000)
})

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
      'harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch.ts',
      'harness/processes/vinaya-strict/integration/repository-verification.ts',
      'harness/kernel/connectors/git/remote-base.ts',
      'harness/kernel/gates/checks/runner.ts'
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
      'harness/processes/vinaya-strict/tools/task-contract/review-input-manifest.ts',
      'harness/kernel/gates/checks/anchored-region.ts',
      'harness/processes/vinaya-strict/tools/task-contract/parse-registry.ts'
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

describe('Issue #702, O2 — the exact regression: a log-sink.ts-only change now selects check.test.ts', () => {
  const LOG_SINK = join(REPO_ROOT, 'harness/kernel/log/log-sink.ts')
  const CHECK_TEST = join(REPO_ROOT, 'apps/cli/tests/commands/check.test.ts')

  it('check.test.ts imports neither log-sink.ts nor anything that does, and spawns the built CLI directly', () => {
    const source = readFileSync(CHECK_TEST, 'utf8')
    expect(source).not.toMatch(/log-sink/)
    expect(extractImportSpecifiers(source).some((s) => s.startsWith('.'))).toBe(false)
  })

  it('is invisible to reachability alone, and selected once the CLI-spawn edge is in play', () => {
    expect(selectAffectedTestFiles(REPO_ROOT, [LOG_SINK], { cliSpawnDetection: 'ignore' }).selected).not.toContain(
      CHECK_TEST
    )
    expect(selectAffectedTestFiles(REPO_ROOT, [LOG_SINK]).selected).toContain(CHECK_TEST)
  }, 60_000)
})

describe('Issue #702, O2 — every test file the Origin’s own grep identifies is now selected', () => {
  // Re-run live, never special-cased by path (`aeg-root` trap for this task):
  // the same pattern the Origin's own grep used, so this test still passes
  // when a new spawning test is added tomorrow and still fails honestly if
  // this task's own edge regresses.
  const ORIGIN_PATTERN =
    'Bun\\.spawn(Sync)?\\(\\[[^]]*[\'"]bun[\'"]|execFileSync\\([\'"]bun[\'"]|spawnSync\\([\'"]bun[\'"]'

  // Which of the matched files a `log-sink.ts`-only change must select is
  // derived from what each file starts, never from the selector's own graph:
  // `bundlerOracle` (above) bundles each started program and lists the
  // modules it pulls in, sharing no code path with the selector.
  //
  // - A file `spawnEdgeOf` answers `'entrypoint'` for starts the CLI entrypoint.
  // - A `'fallback'` file `startedScriptsOf` reads starts only those scripts.
  // - Any other `'fallback'` file keeps the coarse folder edge.
  const LOG_SINK = join(REPO_ROOT, 'harness/kernel/log/log-sink.ts')
  const program = { binary: 'bun', entrypoint: join(REPO_ROOT, 'apps/cli/src/index.ts') }

  function matchedTestFiles(): string[] {
    const grep = spawnSyncBudgeted(
      'grep',
      [
        '-rlE',
        ORIGIN_PATTERN,
        join(REPO_ROOT, 'apps/cli/tests'),
        join(REPO_ROOT, 'harness/processes/vinaya-strict/tests'),
        join(REPO_ROOT, 'harness/processes/vinaya-strict/integration'),
        join(REPO_ROOT, 'harness/kernel'),
        '--include=*.ts'
      ],
      { encoding: 'utf8' }
    )
    return grep.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((f) => resolve(f))
  }

  function startsOf(testFiles: readonly string[]) {
    const ts = loadTypeScript(REPO_ROOT) as NonNullable<ReturnType<typeof loadTypeScript>>
    const sourceFiles = new Set(discoverWorkspacePackages(REPO_ROOT).flatMap((p) => p.sourceFiles))
    const read = (file: string) => readFileSync(file, 'utf8')
    const starts = new Map<string, { coarse: true } | { coarse: false; scripts: string[] }>()
    for (const file of testFiles) {
      const classification = spawnEdgeOf(ts, file, read(file), REPO_ROOT, program)
      if (classification === 'entrypoint') starts.set(file, { coarse: false, scripts: [program.entrypoint] })
      else if (classification === 'fallback') {
        const scripts = startedScriptsOf(ts, file, read(file), REPO_ROOT, program, (p) => sourceFiles.has(p), read)
        starts.set(file, scripts ? { coarse: false, scripts } : { coarse: true })
      }
    }
    const started = [...new Set([...starts.values()].flatMap((s) => (s.coarse ? [] : s.scripts)))].sort()
    const oracle = bundlerOracle(REPO_ROOT, started)
    // A started script the bundler listed no modules for proves nothing either way.
    expect(oracle.unbuildable).toEqual([])
    return { starts, reachesLogSink: (script: string) => oracle.reaches(LOG_SINK, script) }
  }

  it('every real *.test.ts file the pattern matches is selected by a log-sink.ts-only change when what it starts reaches log-sink.ts, or when it keeps the coarse edge', () => {
    const matched = matchedTestFiles()
    // Sanity floor on the Origin's own count (58 when this was first written) —
    // guards against the pattern itself silently matching nothing.
    expect(matched.length).toBeGreaterThan(50)
    // Only genuine `*.test.ts` files are the selector's own universe: a `.ts`
    // script `bun test` never discovers owes this nothing. This file matches
    // the pattern too — its fixture bodies write the literal call shapes, and
    // `bundlerOracle` really starts `bun` — and is judged like any other.
    const testFiles = matched.filter(isTestFile)
    const { starts, reachesLogSink } = startsOf(testFiles)

    // The coarse edge is a scan of the entrypoint's own source folder, so it keeps a change inside that folder and
    // owes nothing to a change beside it (the Log client now lives in the kernel).
    const coarseFolder = dirname(program.entrypoint)
    const owed = testFiles.filter((f) => {
      const start = starts.get(f)
      return (
        start !== undefined &&
        (start.coarse ? LOG_SINK.startsWith(`${coarseFolder}/`) : start.scripts.some(reachesLogSink))
      )
    })
    expect(owed.length).toBeGreaterThan(0)
    const selected = new Set(selectAffectedTestFiles(REPO_ROOT, [LOG_SINK]).selected)
    expect(owed.filter((f) => !selected.has(f))).toEqual([])
  }, 240_000)

  // The other side: a matched file whose every start resolves to scripts that
  // never reach `log-sink.ts` owes that change nothing through what it starts,
  // so the start edge must not be what selects it — it is selected only when
  // its own imports already select it, with no start edge at all.
  it('a matched file whose every started script misses log-sink.ts is selected by that change only if its imports alone select it', () => {
    const testFiles = matchedTestFiles().filter(isTestFile)
    const { starts, reachesLogSink } = startsOf(testFiles)

    const unowed = testFiles.filter((f) => {
      const start = starts.get(f)
      return start !== undefined && !start.coarse && !start.scripts.some(reachesLogSink)
    })
    const changed = [LOG_SINK]
    const withEdge = new Set(selectAffectedTestFiles(REPO_ROOT, changed).selected)
    const withoutEdge = new Set(selectAffectedTestFiles(REPO_ROOT, changed, { cliSpawnDetection: 'ignore' }).selected)
    expect(unowed.filter((f) => withEdge.has(f) && !withoutEdge.has(f))).toEqual([])
  }, 240_000)
})

// Issue #707, O1 — `depth: 'one'` (the pre-push hook's own mode) stops at
// direct importers, never the full transitive closure. Three reference
// change sets, pinned against this repository's own real tree, each with a
// ceiling: exceeding it is a regression in the depth rule itself — a caller
// widening what "direct" means, or reinstating an unbounded category under
// `depth: 'one'`.
//
// One other thing moves these numbers, and it is not a regression: a new
// source file importing one of the reference files directly adds that file's
// own suite to the selection, by one. That is the rule working. So a raised
// ceiling has to come with the importer that raised it — here, the doctor
// command's log-destination check, which reads the sink's own destination
// decision rather than parsing the `logs` setting a second time, and whose
// suite therefore belongs in a log-sink change's selection. A ceiling raised
// with no such importer to point at is the regression this describes.
//
// Raised 21 → 22: `apps/cli/tests/lib/gate-cutovers.test.ts` newly imports
// `config.ts` directly (to cover `resolveGateCutovers`), so a `config.ts`
// change now selects that one extra suite. The rule working, not a regression.
//
// Raised 22 → 23: `apps/cli/tests/new-check.test.ts` newly imports
// `log-sink.ts` directly, for the test-only reset of the sink's
// process-lifetime trust-anchor memo it drops in its own teardown — so a
// `log-sink.ts` change now selects that one extra suite. Same rule.
//
// Raised 23 → 24: `harness/processes/vinaya-strict/tools/task-contract/forge/planning-collisions.test.ts` newly
// imports `config.ts` directly (to cover `resolveCollisionThreshold`, the
// pinned-file collision threshold's own resolver), so a `config.ts` change
// now selects that one extra suite. Same rule.
//
// Raised 24 → 25: `harness/processes/vinaya-strict/integration/log/client/log-custom.test.ts` imports `config.ts`
// (to prove `logs.events` is refused at load) and `log-sink.ts` (to write a
// custom event through a real sink) directly, so a change to either now
// selects that one extra suite. Same rule.
//
// Raised 25 → 26 (`log-portable-v1` 3): `apps/cli/tests/commands/log-emit.test.ts`
// imports `log-sink.ts` directly (`createLogSink`, to prove `vinaya log emit`
// attributes a process outside Vinaya's own `VINAYA_WORK_REF`/`VINAYA_FLOW`
// against a real, isolated sink), so a `log-sink.ts` change now selects that
// one extra suite. Same rule.
//
// Raised 26 → 27 (`log-readers-v1` 6): `harness/kernel/log/client/log-sync-folder-source.test.ts`
// imports `log-sink.ts` directly — `createLogSink`, to write the real,
// hardened-appended fixture folders the folder source is proven against,
// never a fake filesystem — so a `log-sink.ts` change now selects that one
// extra suite too. Same rule.
//
// Raised 27 → 28 (`log-portable-v1` 7): `harness/processes/vinaya-strict/tests/standalone/lib/dev-review-loop/pause-resume.test.ts`
// newly imports `log-sink.ts` directly (`drainLogSink`, to flush its own
// `writeEscalationRecord`/`resolveEscalation` handoff-event tests before
// reading the real logged lines back), so a `log-sink.ts` change now selects
// that one extra suite too. Same rule.
//
// Raised 28 → 29 (`log-readers-v1` 12): `harness/kernel/log/client/log-readers-integration.test.ts`
// newly imports both `log-sink.ts` (`appendHardenedLine`/`outboxPathFor`, to
// write real fixture folders the folder source reads) and `config.ts`
// (`resolveLogsHeaderValues`, to resolve the fake server's read credential)
// directly — one new file, so a change to either now selects that one extra
// suite, never two. Same rule.
//
// Raised 29 → 30: `apps/cli/tests/archive.test.ts` newly imports `config.ts`
// directly (`PrincipalsUnresolvedError`, to build the refusal its injected
// Principal list throws) — one new file, so a change to `config.ts` now
// selects that one extra suite, never two. Same rule.
//
// Raised 32 → 33: `harness/processes/vinaya-strict/tests/standalone/lib/dev-review-loop/security-scan-command.test.ts`
// tests the shared scan-command resolver, which imports `config.ts` — one new
// file, so a change to `config.ts` now selects that one extra suite, never two.
// Same rule.
//
// Raised 34 → 35: `harness/processes/vinaya-strict/loops/dev-review/run-control/runner-repo-default.test.ts` imports
// `config.ts` directly (`loadConfigChecked`/`resolveTaskRunner`, to resolve
// this repository's own configured runner) — one new file, so a change to
// `config.ts` now selects that one extra suite, never two. Same rule.
//
// Raised 35 → 36: `apps/cli/tests/lib/config-local-override.test.ts` tests the local
// pacing override resolver in `config.ts` — one new file, so a change to
// `config.ts` now selects that one extra suite, never two. Same rule.
//
// Raised 36 → 37: `apps/cli/tests/config-golden.test.ts` imports `config.ts`
// directly to compare every exported resolver against its recorded snapshot —
// one new file, so a change to `config.ts` now selects that one extra suite,
// never two. Same rule.
//
// Raised 37 → 38: the selection library's own test file was split into four by describe group, and one more of the
// four imports `config.ts` directly — one new file, so a change to `config.ts` selects that one extra suite. Same rule.
//
// Raised 38 → 39: `harness/kernel/log/log-sink-doctrine-identity.test.ts` proves the sink's new `doctrineIdentity`
// dependency and imports `log-sink.ts` directly — one new file, so a change to the sink selects that one extra suite.
// Same rule.
describe('selectAffectedTestFiles depth: "one" — reference change-set ceilings (Issue #707, O1)', () => {
  it('a change to the log sink (log-sink.ts/config.ts/run-paths.ts) selects at most 39 files', () => {
    const changed = [
      join(REPO_ROOT, 'harness/kernel/log/log-sink.ts'),
      join(REPO_ROOT, 'apps/cli/src/lib/config.ts'),
      join(REPO_ROOT, 'harness/kernel/run-paths.ts')
    ]
    const { selected } = selectAffectedTestFiles(REPO_ROOT, changed, { depth: 'one' })
    // Runner selection and disabled-recording suites directly consume these modules too, and so does the
    // standalone and Engine Log replay, which records both runners through the sink's own overrides.
    expect(selected.length).toBeLessThanOrEqual(39)
  }, 30_000)

  it('a change to a widely imported export of the shared core package selects at most 25 files', () => {
    // `defaultControlStoreDeps` (`harness/kernel/connectors/checkpoint/control-store/local.ts`)
    // — the control store's own dependency builder, imported directly by
    // every suite that exercises ownership, effects, or the task-tools MCP
    // handlers against a real store.
    const changed = join(REPO_ROOT, 'harness/kernel/connectors/checkpoint/control-store/local.ts')
    const { selected } = selectAffectedTestFiles(REPO_ROOT, [changed], {
      depth: 'one',
      affectedNames: new Map([[changed, new Set(['defaultControlStoreDeps'])]])
    })
    expect(selected.length).toBeLessThanOrEqual(25)
  }, 30_000)

  it('a change to one leaf module selects at most 5 files', () => {
    // `sum-ledger.ts` — a small, narrowly-consumed utility with no re-export
    // fan-out of its own.
    const changed = join(REPO_ROOT, 'harness/processes/vinaya-strict/tools/pr-report/tokens/sum-ledger.ts')
    const { selected } = selectAffectedTestFiles(REPO_ROOT, [changed], { depth: 'one' })
    expect(selected.length).toBeLessThanOrEqual(5)
  }, 30_000)
})
