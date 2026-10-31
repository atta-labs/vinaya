// The selection library as a portable unit and as this repository's selector:
// its dependency closure stays inside its own directory, a copy of only that
// directory runs elsewhere, a plan over two commits ignores the checkout
// around them, and the local and CI adapters agree on what a change requires.
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { globToRegex as coreGlobToRegex } from '@attalabs/aeg-core'
import ts from 'typescript'
import * as legacyGraph from '../../src/lib/ts-module-graph'
import * as libraryGraph from '../../src/lib/verification/compiler-graph'
import {
  gitRepository,
  globToRegex,
  type InventoryView,
  plannedTests,
  type SelectionPlan,
  selectTests
} from '../../src/lib/verification/index'
import { fixture, headFiles, scenarioInput, viewOf } from '../../src/lib/verification/tests/fixture-repos'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'

const LIBRARY = join(import.meta.dir, '../../src/lib/verification')
const REPO_ROOT = join(import.meta.dir, '../../../..')
const REPOSITORY_SELECTION = join(REPO_ROOT, 'scripts/test-suites/repository-selection.ts')
const INVENTORY_CHECK = join(REPO_ROOT, 'scripts/test-suites/inventory-check.ts')

/** This repository's adapter, run as its own process against `repo`. */
function repositorySelection(
  repo: string,
  options: { base: string; head: string; consumer: 'local' | 'ci'; depth?: 'one' | 'transitive' }
): SelectionPlan {
  const args = [REPOSITORY_SELECTION, '--base', options.base, '--head', options.head, '--consumer', options.consumer]
  if (options.depth) args.push('--depth', options.depth)
  const run = spawnSyncBudgeted('bun', args, { cwd: repo, encoding: 'utf8', env: bareEnv(repo) }, 60_000)
  if (run.status !== 0) throw new Error(run.stderr)
  return JSON.parse(run.stdout) as SelectionPlan
}

// ── The dependency closure ─────────────────────────────────────────────────

/** Every module specifier a source names, in every form: imports and exports (type-only too), `import x = require`, `require()`, `import()` and `import('…')` types. */
function specifiersOf(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      out.push(node.moduleSpecifier.text)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression
      if (ts.isStringLiteral(expression)) out.push(expression.text)
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      out.push(node.argument.literal.text)
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const arg = node.arguments[0]
      out.push(arg && ts.isStringLiteral(arg) ? arg.text : '<computed>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.[cm]?tsx?$/.test(path))
    .map((path) => join(dir, path))
}

/** The modules outside the directory its README documents, read from its Dependencies section. */
function documentedDependencies(dir: string): { runtime: Set<string>; tests: Set<string> } {
  const readme = readFileSync(join(dir, 'README.md'), 'utf8')
  const section = readme.slice(readme.indexOf('## Dependencies'), readme.indexOf('## License'))
  const [runtimePart, testPart] = section.split('The standalone tests also use:') as [string, string]
  // A bullet names its dependency first; a standard-library bullet lists every module it uses.
  const names = (text: string) =>
    new Set(
      text
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .flatMap((line) => {
          const modules = [...line.matchAll(/`((?:node|bun):[\w/-]+)`/g)].map((m) => m[1] as string)
          return modules.length > 0 ? modules : [/`([^`]+)`/.exec(line)?.[1] as string]
        })
    )
  return { runtime: names(runtimePart), tests: names(testPart) }
}

/** Every specifier in `dir` that escapes it or names a module its README does not document. */
function closureViolations(dir: string): string[] {
  const documented = documentedDependencies(dir)
  const violations: string[] = []
  for (const file of sourcesUnder(dir)) {
    const inTests = relative(dir, file).startsWith('tests/')
    for (const specifier of specifiersOf(file, readFileSync(file, 'utf8'))) {
      const where = `${relative(dir, file)}: ${specifier}`
      if (specifier.startsWith('.')) {
        if (!resolve(dirname(file), specifier).startsWith(`${dir}/`)) violations.push(`${where} escapes the directory`)
        continue
      }
      const allowed = documented.runtime.has(specifier) || (inTests && documented.tests.has(specifier))
      if (!allowed) violations.push(`${where} is not a documented dependency`)
    }
  }
  return violations.sort()
}

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

describe('the library directory is closed', () => {
  it('imports nothing outside itself but its documented dependencies', () => {
    expect(closureViolations(LIBRARY)).toEqual([])
    const documented = documentedDependencies(LIBRARY)
    // Every documented module is a real one: a standard-library module, the test runner, or the compiler.
    for (const name of documented.runtime)
      expect(name === 'typescript' || name === 'git' || builtinModules.includes(name.replace(/^node:/, ''))).toBe(true)
    expect([...documented.tests]).toEqual(['bun:test'])
    // And the README names exactly what the runtime sources use, no more.
    const used = new Set(
      sourcesUnder(LIBRARY)
        .filter((file) => !relative(LIBRARY, file).startsWith('tests/'))
        .flatMap((file) => specifiersOf(file, readFileSync(file, 'utf8')))
        .filter((specifier) => !specifier.startsWith('.'))
    )
    expect([...used].sort()).toEqual([...documented.runtime].filter((name) => name !== 'git').sort())
  })

  it('rejects an escaping, private, type-only or re-exported dependency', () => {
    const copy = join(scratch('verification-closure-'), 'verification')
    try {
      cpSync(LIBRARY, copy, { recursive: true })
      writeFileSync(
        join(copy, 'escape.ts'),
        [
          "import type { VinayaConfig } from '../config.js'",
          "export { globToRegex } from '@attalabs/aeg-core'",
          "import helper = require('../ops.js')",
          "export type Sink = import('../log-sink.js').Sink",
          "export const late = () => import('../../index.js')",
          ''
        ].join('\n')
      )
      expect(closureViolations(copy)).toEqual([
        'escape.ts: ../../index.js escapes the directory',
        'escape.ts: ../config.js escapes the directory',
        'escape.ts: ../log-sink.js escapes the directory',
        'escape.ts: ../ops.js escapes the directory',
        'escape.ts: @attalabs/aeg-core is not a documented dependency'
      ])
    } finally {
      rmSync(dirname(copy), { recursive: true, force: true })
    }
  })

  it('carries its usage, dependency and license notices', () => {
    expect(readFileSync(join(LIBRARY, 'LICENSE'), 'utf8')).toBe(
      readFileSync(join(REPO_ROOT, 'apps/cli/LICENSE'), 'utf8')
    )
    expect(readFileSync(join(LIBRARY, 'README.md'), 'utf8')).toContain('selectTests({')
  })
})

// ── A real copy ────────────────────────────────────────────────────────────

/** The installed compiler package, as a real directory. */
const TYPESCRIPT_DIR = dirname(realpathSync(createRequire(import.meta.url).resolve('typescript/package.json')))

function noSymlinks(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((path) =>
    lstatSync(join(dir, path)).isSymbolicLink()
  )
}

/** A tiny selection the copy and this checkout both compute: its plan identity proves where the library sits never matters. */
const ENTRY_SCRIPT = (
  lib: string
) => `import { groupNativeTests, memoryRepository, selectTests, stableHash, validateExecutedIdentities, validateInventory } from './${lib}/index.ts'
const files = (body) => ({
  'package.json': '{ "name": "copy-fixture" }\\n',
  'src/greet.ts': body,
  'tests/greet.test.ts': "import { greet } from '../src/greet.ts'\\n"
})
const base = files('export const greet = () => "hi"\\n')
const head = files('export const greet = () => "hello"\\n')
const view = (revision, tree) => ({
  revision, modeled: true, schemaIdentity: 'copy@1', declarationVersion: 1, declarationIdentity: null,
  contextIdentity: 'c', graphIdentity: stableHash(tree), workspaces: [],
  suites: [{ id: 'root', owner: 'root', kind: 'workspace', dir: '.', cwd: '.', runner: 'bun', preload: null, environment: {}, configFiles: ['package.json'], include: [], exclude: [] }],
  tests: [{ id: 'tests/greet.test.ts', suite: 'root', owner: 'root', kind: 'workspace', runner: 'bun', cwd: '.', preload: null, environment: {} }],
  exclusions: [], typeInputs: [], edges: [], unknowns: [], policies: [], problems: []
})
const inventory = { head: view('h', head), base: view('b', base) }
if (validateInventory(inventory).length > 0) throw new Error('invalid')
const plan = selectTests({ repo: memoryRepository({ b: base, h: head }), base: 'b', head: 'h', inventory, policy: { depth: 'transitive' } })
// Native grouping and the execution check over the same identities: a root obligation, a second configuration of one file, a mismatch, an empty set.
const [greet] = inventory.head.tests
const rootTest = { ...greet, id: 'scripts/check.test.ts', suite: 'repository', owner: 'repository', kind: 'repository' }
const grouped = groupNativeTests({ tests: [greet, { ...greet, configuration: 'probe' }, rootTest, { ...rootTest, id: 'scripts/odd.test.ts', preload: 'p.ts' }] })
const report = (group, files) => ({ group, outcome: 'completed', files })
const exact = validateExecutedIdentities(grouped.groups, [report('root@default', ['tests/greet.test.ts']), report('root@probe', ['./tests/greet.test.ts']), report('repository@default', ['scripts/check.test.ts'])], { roots: ['/r'] })
const mismatched = validateExecutedIdentities(grouped.groups, [report('root@default', ['tests/other.test.ts']), report('root@probe', []), report('repository@default', ['/elsewhere/scripts/check.test.ts'])], { roots: ['/r'] })
const empty = [groupNativeTests({ tests: [] }), validateExecutedIdentities([], [], { roots: ['/r'] })]
process.stdout.write(JSON.stringify({
  identity: plan.identity, required: plan.required.map((t) => t.test), resolver: plan.context.resolver,
  groups: grouped.groups.map((g) => g.id + ' ' + g.args.join(',')), groupProblems: grouped.problems.map((p) => p.code),
  exact: exact.problems.length, executed: exact.executed, mismatched: mismatched.problems.map((p) => p.code + ' ' + p.path), empty
}))
`

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

describe('a copy of only the library directory runs in unrelated repositories', () => {
  it('in two layouts, from the public entrypoint and its own standalone tests, with nothing of this checkout', () => {
    // This checkout's own answer for the same input.
    const local = scratch('verification-local-')
    writeFileSync(join(local, 'entry.ts'), ENTRY_SCRIPT(relative(local, LIBRARY)))
    const expected = spawnSyncBudgeted(
      'bun',
      [join(local, 'entry.ts')],
      { cwd: local, encoding: 'utf8', env: bareEnv(local) },
      60_000
    )
    expect(expected.stderr).toBe('')
    const answer = JSON.parse(expected.stdout) as { identity: string; required: string[]; resolver: string }
    expect(answer.required).toEqual(['tests/greet.test.ts'])
    expect(answer.resolver).toBe('compiler')
    // Grouping keeps the root obligation and both configurations, refuses the mismatched member; the check
    // accepts exactly the scheduled files and fails extra, missing and outside-root ones; an empty set is empty.
    expect(answer).toMatchObject({
      groups: [
        'repository@default ./scripts/check.test.ts',
        'root@default ./tests/greet.test.ts',
        'root@probe ./tests/greet.test.ts'
      ],
      groupProblems: ['configuration-mismatch'],
      exact: 0,
      executed: ['scripts/check.test.ts@default', 'tests/greet.test.ts@default', 'tests/greet.test.ts@probe'],
      mismatched: [
        'outside-root /elsewhere/scripts/check.test.ts',
        'missing scripts/check.test.ts',
        'extra tests/other.test.ts',
        'missing tests/greet.test.ts',
        'missing tests/greet.test.ts'
      ],
      empty: [
        { groups: [], problems: [] },
        { executed: [], problems: [] }
      ]
    })
    rmSync(local, { recursive: true, force: true })

    for (const layout of ['lib/verification', 'vendor/tools/select']) {
      const repo = scratch('verification-copy-')
      try {
        writeFileSync(join(repo, 'package.json'), '{ "name": "unrelated", "private": true }\n')
        cpSync(LIBRARY, join(repo, layout), { recursive: true })
        // The one third-party dependency, installed as a real copy.
        cpSync(TYPESCRIPT_DIR, join(repo, 'node_modules/typescript'), { recursive: true, dereference: true })
        writeFileSync(join(repo, 'entry.ts'), ENTRY_SCRIPT(layout))
        expect(noSymlinks(repo)).toEqual([])
        expect(readdirSync(repo).sort()).toEqual(
          ['entry.ts', layout.split('/')[0] as string, 'node_modules', 'package.json'].sort()
        )

        const run = spawnSyncBudgeted(
          'bun',
          [join(repo, 'entry.ts')],
          { cwd: repo, encoding: 'utf8', env: bareEnv(repo) },
          60_000
        )
        expect(run.stderr).toBe('')
        expect(JSON.parse(run.stdout)).toEqual(answer)

        const tests = spawnSyncBudgeted(
          'bun',
          ['test', '--timeout=30000', `./${layout}/tests/selection.test.ts`, `./${layout}/tests/native.test.ts`],
          { cwd: repo, encoding: 'utf8', env: bareEnv(repo) },
          120_000
        )
        expect(`${tests.stdout}${tests.stderr}`).toContain(' 0 fail')
        expect(tests.status).toBe(0)
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  }, 300_000)
})

// ── Two commits, whatever the checkout around them ─────────────────────────

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

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
}

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('a plan for two commits reads only those commits', () => {
  it('is unchanged by a dirty checkout, another branch and an advanced HEAD, and executes and records nothing', () => {
    const fx = fixture('workspaces-repo.json')
    const scenario = fx.scenarios[0] as (typeof fx.scenarios)[number]
    const repo = scratch('verification-git-')
    try {
      const marker = join(repo, 'executed.marker')
      // A test that would leave a mark if anything ran it.
      const tripwire = `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`
      const base = { ...fx.files, 'packages/app/tests/tripwire.test.ts': tripwire }
      const head = { ...headFiles(fx, scenario), 'packages/app/tests/tripwire.test.ts': tripwire }
      git(repo, ['init', '-q', '-b', 'main'])
      writeTree(repo, base)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'base'])
      const baseSha = git(repo, ['rev-parse', 'HEAD'])
      writeTree(repo, head)
      git(repo, ['add', '-A'])
      git(repo, ['commit', '-q', '-m', 'head'])
      const headSha = git(repo, ['rev-parse', 'HEAD'])
      const records = join(repo, 'records/passing.json')
      writeTree(repo, { 'records/passing.json': '{ "passed": [] }\n' })

      const input = () => {
        const memory = scenarioInput(
          { ...fx, files: base },
          { ...scenario, change: { ...scenario.change, 'packages/app/tests/tripwire.test.ts': tripwire } },
          { base: baseSha, head: headSha }
        )
        return { ...memory, repo: gitRepository(repo) }
      }
      const first = selectTests(input())
      expect(first.required.map((t) => t.test)).toEqual(['packages/app/tests/square.test.ts'])
      // The same plan an in-memory reader of the same two trees gives.
      const inMemory = selectTests(
        scenarioInput(
          { ...fx, files: base },
          { ...scenario, change: { ...scenario.change, 'packages/app/tests/tripwire.test.ts': tripwire } },
          { base: baseSha, head: headSha }
        )
      )
      expect(first.identity).toBe(inMemory.identity)

      // Dirty the checkout, move to another branch, advance HEAD.
      writeFileSync(join(repo, 'packages/core/src/add.ts'), 'export function add() { return 0 }\n')
      writeFileSync(join(repo, 'packages/app/tests/untracked.test.ts'), 'export {}\n')
      git(repo, ['checkout', '-q', '-b', 'elsewhere'])
      writeFileSync(join(repo, 'docs/guide.md'), '# Guide\n\nAdvanced.\n')
      git(repo, ['commit', '-q', '-am', 'advance'])
      writeFileSync(join(repo, 'packages/core/src/mul.ts'), '// dirty again\n')
      const status = git(repo, ['status', '--porcelain'])
      const headBefore = git(repo, ['rev-parse', 'HEAD'])
      const recordBefore = digest(records)

      const second = selectTests(input())
      expect(second.identity).toBe(first.identity)
      expect(git(repo, ['status', '--porcelain'])).toBe(status)
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore)
      expect(digest(records)).toBe(recordBefore)
      expect(readdirSync(repo)).not.toContain('executed.marker')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 120_000)
})

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

describe('the local and CI adapters', () => {
  it('require the same tests for the same commits and depth, and state their own obligations apart', () => {
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

      for (const depth of ['one', 'transitive'] as const) {
        const local = repositorySelection(repo, { base: 'HEAD~1', head: 'HEAD', consumer: 'local', depth })
        const ci = repositorySelection(repo, { base: 'HEAD~1', head: 'HEAD', consumer: 'ci', depth })
        expect(local.required).toEqual(ci.required)
        expect(local.fallbacks).toEqual(ci.fallbacks)
        expect(local.context.base).toBe(git(repo, ['rev-parse', 'HEAD~1']))
        expect(local.obligations.map((o) => `${o.obligation} ${o.test}`)).toEqual([
          'pre-push-always-run packages/app/tests/add.test.ts'
        ])
        expect(ci.obligations.map((o) => `${o.obligation} ${o.test}`)).toEqual(['inventory-gate scripts/check.test.ts'])
      }
      const transitive = repositorySelection(repo, { base: 'HEAD~1', head: 'HEAD', consumer: 'ci' })
      expect(transitive.required.map((t) => t.test)).toEqual([
        'packages/app/tests/add.test.ts',
        'packages/app/tests/mul.test.ts',
        'packages/app/tests/square.test.ts',
        'packages/app/tests/tree.test.ts'
      ])
      expect(plannedTests(transitive)).toContain('scripts/check.test.ts')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 120_000)
})

// ── The compatibility adapters forward to the one implementation ──────────

describe('the existing paths forward to the library', () => {
  it('the compiler graph is the library one, not a copy', () => {
    expect(legacyGraph.buildCompilerGraph).toBe(libraryGraph.buildCompilerGraph)
    expect(legacyGraph.loadTypeScript).toBe(libraryGraph.loadTypeScript)
  })

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
    const owned = view.tests
      .filter((t) => t.id.startsWith('apps/cli/src/lib/verification/'))
      .map((t) => `${t.id} ${t.suite}`)
    expect(owned).toEqual([
      'apps/cli/src/lib/verification/tests/native.test.ts cli',
      'apps/cli/src/lib/verification/tests/selection.test.ts cli'
    ])
    const fixtures = view.edges.find((e) => e.input === 'apps/cli/src/lib/verification/tests/fixtures/')
    expect(fixtures?.readers).toEqual([
      'apps/cli/src/lib/verification/tests/selection.test.ts',
      'apps/cli/tests/lib/verification-library.test.ts'
    ])
    // The fixture views the library tests build are what the library validates.
    const fx = fixture('flat-repo.json')
    expect(viewOf('r', fx.files, fx.inventory).tests.map((t) => t.runner)).toEqual([
      'vitest',
      'vitest',
      'vitest',
      'vitest',
      'vitest'
    ])
  })
})
