// The test-selection package as this repository's selector: the one
// repository adapter gives every caller the same answer, the package's glob
// agrees with the kernel's, and the canonical inventory owns the package's
// tests and routes its fixtures. The package's own isolation, install and
// revision tests live beside it (`packages/test-selection/tests/`).
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  globToRegex,
  type InventoryDeclarations,
  type InventoryView,
  inventoryViewOf,
  plannedTests,
  type SelectionPlan
} from '@attalabs/test-selection'
import { spawnSyncBudgeted, stripVinayaEnv } from '../../../conformance/unit/process-fixture'
import { globToRegex as coreGlobToRegex } from '../../glob-to-regex'

const REPO_ROOT = join(import.meta.dir, '../../../../..')
const REPOSITORY_SELECTION = join(REPO_ROOT, 'scripts/test-suites/repository-selection.ts')
const INVENTORY_CHECK = join(REPO_ROOT, 'scripts/test-suites/inventory-check.ts')
const PACKAGE_FIXTURES = join(REPO_ROOT, 'packages/test-selection/tests/fixtures')

/** One of the package's committed fixture repositories, read as data. */
function fixture(name: 'workspaces-repo.json' | 'flat-repo.json'): {
  files: Record<string, string>
  inventory: InventoryDeclarations
} {
  return JSON.parse(readFileSync(join(PACKAGE_FIXTURES, name), 'utf8'))
}

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

/** This repository's adapter, run as its own process against `repo`. */
function repositorySelection(repo: string, options: { base: string; head: string }): SelectionPlan {
  const args = [REPOSITORY_SELECTION, '--base', options.base, '--head', options.head]
  const run = spawnSyncBudgeted('bun', args, { cwd: repo, encoding: 'utf8', env: bareEnv(repo) }, 60_000)
  if (run.status !== 0) throw new Error(run.stderr)
  return JSON.parse(run.stdout) as SelectionPlan
}

/**
 * A child's environment: no Vinaya, Bun, git or Node settings of this process,
 * its own `HOME`, and only this test process's private runtime directory, so
 * nothing a child does can reach the real one.
 */
function bareEnv(home: string): NodeJS.ProcessEnv {
  const env = stripVinayaEnv()
  for (const key of Object.keys(env))
    if (key.startsWith('BUN_') || key.startsWith('GIT_') || key.startsWith('NODE_')) delete env[key]
  return { ...env, HOME: home, ...privateRuntime() }
}

/** The private runtime directory the test preload set, when it set one. */
function privateRuntime(): NodeJS.ProcessEnv {
  return process.env.VINAYA_RUNTIME_DIR ? { VINAYA_RUNTIME_DIR: process.env.VINAYA_RUNTIME_DIR } : {}
}

function git(cwd: string, args: string[]): string {
  return spawnSyncBudgeted('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...bareEnv(cwd),
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@x',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@x'
    }
  }).stdout.trim()
}

// ── This repository's adapters ─────────────────────────────────────────────

/** A small repository shaped like this one: workspaces, a repository suite, committed inventory declarations, a scanner provider and a root configuration. */
function adapterFixture(): Record<string, string> {
  const fx = fixture('workspaces-repo.json')
  const inventory = {
    schema: 'vinaya.test-inventory',
    schemaVersion: 1,
    declarationVersion: 1,
    suites: [
      { id: 'app', owner: '@fx/app', kind: 'workspace', dir: 'packages/app', runner: 'bun', preload: null },
      {
        id: 'repository',
        owner: 'repository',
        kind: 'repository',
        dir: '.',
        runner: 'bun',
        preload: null,
        tests: ['scripts/check.test.ts']
      }
    ],
    typeInputs: [{ path: 'packages/core', role: 'the library the app tests import' }],
    exclusions: [],
    inputs: [
      {
        id: 'settings',
        kind: 'config',
        paths: ['packages/app/settings.json'],
        format: 'json',
        readers: [
          { kind: 'semantic', tests: ['packages/app/tests/settings.test.ts'] },
          { kind: 'parsed-keys', keys: ['theme'], tests: ['packages/app/tests/theme.test.ts'] },
          { kind: 'raw-bytes', tests: ['packages/app/tests/bytes.test.ts'] }
        ],
        reason: 'read from disk'
      },
      {
        id: 'table',
        kind: 'fixture',
        paths: ['packages/app/tests/fixtures/'],
        readers: [{ kind: 'raw-bytes', tests: ['packages/app/tests/data.test.ts'] }],
        reason: 'read from disk'
      },
      {
        id: 'guide',
        kind: 'doc',
        paths: ['docs/'],
        readers: [{ kind: 'raw-bytes', tests: ['packages/app/tests/docs.test.ts'] }],
        reason: 'read from disk'
      },
      {
        id: 'cli-program',
        kind: 'spawn',
        paths: ['tools/cli.ts'],
        readers: [{ kind: 'code', tests: ['packages/app/tests/cli.test.ts'] }],
        reason: 'started as a program'
      }
    ],
    providers: [
      {
        id: 'scanners',
        kind: 'provider',
        file: 'tools/scanners.ts',
        export: 'SCANNERS',
        shape: 'scanner-declarations',
        reason: 'folder-scanning tests'
      }
    ],
    policies: [
      {
        id: 'pre-push-always-run',
        kind: 'always-run',
        inputs: ['vinaya.config.json#prePush.alwaysRun'],
        duty: 'runs on every push',
        source: 'vinaya.config.json'
      },
      {
        id: 'inventory-gate',
        kind: 'mandatory',
        inputs: ['scripts/test-suites/'],
        duty: 'the repository suite runs on every pull request',
        source: 'ci'
      }
    ],
    unknowns: [{ scope: 'opaque/', reason: 'a test reads this folder through a computed path' }]
  }
  return {
    ...fx.files,
    'scripts/test-suites/inventory.json': `${JSON.stringify(inventory, null, 2)}\n`,
    'scripts/check.test.ts': "import { test } from 'bun:test'\n\ntest('check', () => {})\n",
    'tools/scanners.ts':
      "export const SCANNERS = [{ test: 'packages/app/tests/tree.test.ts', roots: ['packages/core/src/'], trigger: 'tree-shape' }]\n",
    'vinaya.config.json': '{ "prePush": { "alwaysRun": ["packages/app/tests/add.test.ts"] } }\n'
  }
}

describe('the one repository adapter', () => {
  it('gives every caller the same one-hop answer, and states the same obligations apart', () => {
    const repo = scratch('verification-adapter-')
    try {
      const files = adapterFixture()
      git(repo, ['init', '-q', '-b', 'main'])
      writeTree(repo, files)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'base'])
      writeTree(repo, {
        'packages/core/src/add.ts': 'export function add(a: number, b: number): number {\n  return b + a\n}\n'
      })
      git(repo, ['commit', '-q', '-am', 'head'])

      const transitive = repositorySelection(repo, { base: 'HEAD~1', head: 'HEAD' })
      expect(transitive.context.base).toBe(git(repo, ['rev-parse', 'HEAD~1']))
      // The repository suite is selected by what it reads, never added as an obligation of its own.
      expect(transitive.obligations.map((o) => `${o.obligation} ${o.test}`)).toEqual([
        'pre-push-always-run packages/app/tests/add.test.ts'
      ])
      // One policy for every caller: the walk stops at a test's own direct edges.
      expect(transitive.required.map((t) => t.test)).toEqual(['packages/app/tests/add.test.ts'])
      expect(transitive.context.policy).toBe(repositorySelection(repo, { base: 'HEAD~1', head: 'HEAD' }).context.policy)
      expect(plannedTests(transitive)).not.toContain('scripts/check.test.ts')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 120_000)
})

// ── The package against this repository's own helpers ─────────────────────

describe('the package agrees with this repository', () => {
  it("the library's policy glob matches what the shared core package's matched", () => {
    const patterns = ['apps/cli/tests/**/ci-*.test.ts', 'a/*.ts', 'x/[slug]/y.ts', 'a.b+c', '**', 'a?b']
    const paths = [
      'apps/cli/tests/ci-shards.test.ts',
      'apps/cli/tests/lib/ci-x.test.ts',
      'a/b.ts',
      'a/b/c.ts',
      'x/[slug]/y.ts',
      'x/s/y.ts',
      'a.b+c',
      'abbc',
      'a?b',
      'axb'
    ]
    for (const pattern of patterns)
      for (const path of paths) expect(globToRegex(pattern).test(path)).toBe(coreGlobToRegex(pattern).test(path))
  })

  it('the canonical inventory owns the library tests and routes its fixtures', () => {
    const run = spawnSyncBudgeted(
      'bun',
      [INVENTORY_CHECK, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...stripVinayaEnv(), ...privateRuntime() } },
      60_000
    )
    expect(run.stderr).toBe('')
    const view = (JSON.parse(run.stdout) as { head: InventoryView }).head
    const owned = view.tests.filter((t) => t.id.startsWith('packages/test-selection/')).map((t) => `${t.id} ${t.suite}`)
    expect(owned).toEqual([
      'packages/test-selection/tests/consumer.test.ts test-selection',
      'packages/test-selection/tests/git-revisions.test.ts test-selection',
      'packages/test-selection/tests/isolation.test.ts test-selection',
      'packages/test-selection/tests/native.test.ts test-selection',
      'packages/test-selection/tests/recorded-reads.test.ts test-selection',
      'packages/test-selection/tests/selection.test.ts test-selection'
    ])
    const fixtures = view.edges.find((e) => e.input === 'packages/test-selection/tests/fixtures/')
    expect(fixtures?.readers).toEqual([
      'harness/kernel/gates/ring0-hooks/pre-push/verification-portability.test.ts',
      'packages/test-selection/tests/git-revisions.test.ts',
      'packages/test-selection/tests/selection.test.ts'
    ])
    // The fixture views the library tests build are what the library validates.
    const fx = fixture('flat-repo.json')
    expect(inventoryViewOf('r', fx.files, fx.inventory).tests.map((t) => t.runner)).toEqual([
      'vitest',
      'vitest',
      'vitest',
      'vitest',
      'vitest'
    ])
  })
})
