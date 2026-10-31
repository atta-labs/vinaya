/**
 * The test inventory, proved two ways: the committed declarations validate
 * against this repository's own tree, and independent fixture trees show
 * each rule refusing what it must — an unclassified, duplicate or missing
 * test, fixture data a runner would collect, a runner the configuration
 * contradicts, a no-reader claim that would erase a scanner's or a security
 * policy's duty — and each reader kind answering a configuration change the
 * way its kind says. The build job's step that runs all of this is executed
 * here against fake runners, so a failure of either command is shown to fail
 * the job.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { SUITE_INPUTS } from '../../apps/cli/tests/sandbox-conformance/command-sources.ts'
import {
  buildInventoryView,
  changedInputReaders,
  diffTestIdentities,
  INVENTORY_PATH,
  type InventoryDeclarations,
  InventoryError,
  type InventoryView,
  layoutOf,
  memoryReader,
  nativeGroups,
  readTestInventory
} from './inventory-check.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')

// ── The committed inventory ────────────────────────────────────────────────

describe('the committed inventory validates against this repository', () => {
  const inventory = readTestInventory(REPO_ROOT)
  const { head } = inventory
  const byId = new Map(head.tests.map((t) => [t.id, t]))

  test('every tracked test-shaped file is owned once or excluded, with no problem', () => {
    expect(head.problems).toEqual([])
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .stdout.split('\0')
      .filter((f) => /(\.|_)(test|spec)\.(c|m)?[jt]sx?$/.test(f))
    const classified = new Set([...head.tests.map((t) => t.id), ...head.exclusions.map((e) => e.path)])
    expect(tracked.filter((f) => !classified.has(f))).toEqual([])
    expect(new Set(head.tests.map((t) => t.id)).size).toBe(head.tests.length)
  })

  test('the root tests are the repository suite: root working directory, Bun, the root bunfig preload', () => {
    for (const id of ['scripts/vinaya-checks/ui-rules.test.ts', 'scripts/vinaya-checks/process-version-bump.test.ts']) {
      expect(byId.get(id)).toMatchObject({
        suite: 'repository',
        owner: 'repository',
        kind: 'repository',
        runner: 'bun',
        cwd: '.',
        preload: 'apps/cli/tests/lib/test-env-preload.ts'
      })
    }
  })

  test('every named area is covered, with its actual runner, working directory and preload', () => {
    const expectations: [string, string, string, string, string | null][] = [
      ['apps/cli/tests/lib/test-selector.test.ts', 'cli', 'bun', 'apps/cli', 'apps/cli/tests/lib/test-env-preload.ts'],
      ['harness/tests/architecture.test.ts', 'kernel', 'bun', 'harness', null],
      [
        'processes/vinaya/tests/run-engine.test.ts',
        'process-vinaya',
        'bun',
        'processes/vinaya',
        'apps/cli/tests/lib/test-env-preload.ts'
      ],
      ['packages/aeg-core/src/no-binary-sources.test.ts', 'aeg-core', 'vitest', 'packages/aeg-core', null],
      ['apps/log-server/src/worker.test.ts', 'log-server', 'vitest', 'apps/log-server', null],
      ['packages/sources/src/file-adapter.test.ts', 'sources', 'bun', 'packages/sources', null],
      ['apps/vinaya-portal/src/lib/brand-logo.test.ts', 'portal', 'bun', 'apps/vinaya-portal', null]
    ]
    for (const [id, suite, runner, cwd, preload] of expectations)
      expect(byId.get(id), id).toMatchObject({ suite, runner, cwd, preload })
    const forgeState = head.tests.filter((t) => t.suite === 'aeg-forge-state')
    expect(forgeState.length).toBeGreaterThan(0)
    expect(forgeState.every((t) => t.runner === 'vitest')).toBe(true)
    // The Workers pool is read from the log server's own configuration.
    expect(head.suites.find((s) => s.id === 'log-server')?.environment.pool).toBe('cloudflare-workers')
  })

  test('the vitest suite keeps its fixture-folder test only because it declares it a real test', () => {
    expect(byId.get('packages/aeg-core/src/log/fixtures/executions.test.ts')?.suite).toBe('aeg-core')
  })

  test('the type packages and shared TypeScript configuration are recorded as type inputs', () => {
    const paths = head.typeInputs.map((t) => t.path)
    for (const path of [
      'packages/aeg-types',
      'packages/typescript-config',
      'packages/typescript-config/base.json',
      'tsconfig.json'
    ])
      expect(paths).toContain(path)
  })

  test("the sandbox suite's inputs are read from their own module, never copied", () => {
    const resolved = head.edges.filter((e) => e.source === 'provider:sandbox-suite-inputs').map((e) => e.input)
    expect([...new Set(resolved)].sort()).toEqual([...SUITE_INPUTS].sort())
    // No declared input restates one of those edges: the sandbox suite is a reader only through the provider.
    const declarations = JSON.parse(readFileSync(join(REPO_ROOT, INVENTORY_PATH), 'utf8')) as InventoryDeclarations
    const sandboxTest = 'apps/cli/tests/sandbox-conformance/sandbox-conformance.test.ts'
    expect(declarations.inputs.filter((input) => input.readers.some((r) => r.tests?.includes(sandboxTest)))).toEqual([])
  })

  test('governance policy is kept apart from dependency data', () => {
    expect(head.policies.map((p) => p.kind).sort()).toEqual([
      'always-run',
      'mandatory',
      'mandatory',
      'oracle',
      'security'
    ])
    expect(head.edges.every((e) => !('duty' in e))).toBe(true)
  })

  test('native groups and the CI layout come from the same view', () => {
    const groups = nativeGroups(head)
    expect(groups.reduce((n, g) => n + g.tests.length, 0)).toBe(head.tests.length)
    expect(groups.find((g) => g.suite === 'aeg-core')?.runner).toBe('vitest')
    const layout = layoutOf(head)
    expect(layout.packageDirs).toContain('harness')
    expect(layout.preloads).toContain('apps/cli/tests/lib/test-env-preload.ts')
    expect(layout.opaque).toContain('scripts/ci/config-probe.ts')
  })

  test('the default Bun selection never hands a Vitest file to bun test; exposure names the runner', async () => {
    const { selectAffectedTestFiles } = await import('../../apps/cli/src/lib/test-selector.ts')
    const changed = ['packages/aeg-core/src/anchored-region.ts']
    const plain = selectAffectedTestFiles(REPO_ROOT, changed)
    const vitestIds = new Set(head.tests.filter((t) => t.runner === 'vitest').map((t) => t.id))
    expect(plain.selected.map((f) => f.slice(REPO_ROOT.length + 1)).filter((f) => vitestIds.has(f))).toEqual([])
    const exposed = selectAffectedTestFiles(REPO_ROOT, changed, { nativeRunners: 'expose' })
    expect(exposed.selected).toEqual(plain.selected)
    expect(exposed.native.length).toBeGreaterThan(0)
    for (const entry of exposed.native)
      expect(byId.get(entry.test.slice(REPO_ROOT.length + 1))?.runner).toBe(entry.runner as 'vitest')
  }, 60_000)
})

// ── Fixture trees ──────────────────────────────────────────────────────────

/** A small tree: a Bun CLI member with a preload, a Vitest member, a type package and a root suite. */
function baseFiles(overrides: Record<string, string | null> = {}): Record<string, string> {
  const declarations: InventoryDeclarations = {
    schema: 'vinaya.test-inventory',
    schemaVersion: 1,
    declarationVersion: 1,
    suites: [
      {
        id: 'cli',
        owner: '@fx/cli',
        kind: 'workspace',
        dir: 'apps/cli',
        runner: 'bun',
        preload: 'apps/cli/tests/preload.ts'
      },
      { id: 'core', owner: '@fx/core', kind: 'workspace', dir: 'packages/core', runner: 'vitest', preload: null },
      {
        id: 'repository',
        owner: 'repository',
        kind: 'repository',
        dir: '.',
        runner: 'bun',
        preload: null,
        tests: ['scripts/root.test.ts']
      }
    ],
    typeInputs: [{ path: 'packages/types', role: 'type package with no tests' }],
    exclusions: [],
    inputs: [],
    providers: [],
    policies: [],
    unknowns: []
  }
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
    'apps/cli/package.json': JSON.stringify({ name: '@fx/cli', scripts: { test: 'bun test --timeout=30000' } }),
    'apps/cli/bunfig.toml': '[test]\npreload = "./tests/preload.ts"\n',
    'apps/cli/tests/preload.ts': 'export {}\n',
    'apps/cli/src/config.ts': 'export const read = () => 1\n',
    'apps/cli/tests/config.test.ts': "import { read } from '../src/config'\n",
    'packages/core/package.json': JSON.stringify({ name: '@fx/core', scripts: { test: 'vitest run' } }),
    'packages/core/vitest.config.ts': "export default { test: { include: ['src/**/*.test.ts'] } }\n",
    'packages/core/src/a.test.ts': "import { describe } from 'vitest'\n",
    'packages/types/package.json': JSON.stringify({ name: '@fx/types' }),
    'scripts/root.test.ts': "import { test } from 'bun:test'\n",
    [INVENTORY_PATH]: JSON.stringify(declarations)
  }
  for (const [path, text] of Object.entries(overrides)) {
    if (text === null) delete files[path]
    else files[path] = text
  }
  return files
}

function withDeclarations(edit: (d: InventoryDeclarations) => void, overrides: Record<string, string | null> = {}) {
  const files = baseFiles(overrides)
  const declarations = JSON.parse(files[INVENTORY_PATH] as string) as InventoryDeclarations
  edit(declarations)
  files[INVENTORY_PATH] = JSON.stringify(declarations)
  return files
}

function view(files: Record<string, string>, revision = 'head', imports = false): InventoryView {
  return buildInventoryView(memoryReader(revision, files), { imports })
}

const codes = (v: InventoryView) => v.problems.map((p) => `${p.code} ${p.path}`)

describe('discovery refuses what it must', () => {
  test('a valid tree has no problem, and readTestInventory returns it', () => {
    const v = view(baseFiles())
    expect(v.problems).toEqual([])
    expect(v.tests.map((t) => `${t.id} ${t.runner} ${t.cwd} ${t.preload}`)).toEqual([
      'apps/cli/tests/config.test.ts bun apps/cli apps/cli/tests/preload.ts',
      'packages/core/src/a.test.ts vitest packages/core null',
      'scripts/root.test.ts bun . null'
    ])
    expect(v.tests[0]?.environment.timeoutMs).toBe(30000)
    expect(readTestInventory({ head: memoryReader('head', baseFiles()) }).head.tests).toHaveLength(3)
  })

  test('an unclassified test-shaped file fails, outside every workspace or outside a vitest include', () => {
    expect(codes(view(baseFiles({ 'tools/stray.test.ts': '' })))).toContain('unclassified tools/stray.test.ts')
    expect(codes(view(baseFiles({ 'packages/core/tests/b.test.ts': '' })))).toContain(
      'unclassified packages/core/tests/b.test.ts'
    )
    expect(() => readTestInventory({ head: memoryReader('head', baseFiles({ 'tools/stray.test.ts': '' })) })).toThrow(
      InventoryError
    )
  })

  test('a file two suites collect is a duplicate', () => {
    const files = withDeclarations(
      (d) => {
        d.suites.push({
          id: 'nested',
          owner: '@fx/nested',
          kind: 'workspace',
          dir: 'apps/cli/nested',
          runner: 'bun',
          preload: null
        })
      },
      {
        'package.json': JSON.stringify({ workspaces: ['apps/*', 'apps/cli/nested', 'packages/*'] }),
        'apps/cli/nested/package.json': JSON.stringify({ name: '@fx/nested', scripts: { test: 'bun test' } }),
        'apps/cli/nested/x.test.ts': ''
      }
    )
    expect(codes(view(files))).toContain('duplicate apps/cli/nested/x.test.ts')
  })

  test('a listed test, exclusion or input that is not in the tree is missing; a repeated entry is a duplicate', () => {
    expect(codes(view(baseFiles({ 'scripts/root.test.ts': null })))).toContain('missing scripts/root.test.ts')
    const repeated = withDeclarations((d) => {
      const root = d.suites.find((s) => s.id === 'repository')
      root?.tests?.push('scripts/root.test.ts')
    })
    expect(codes(view(repeated))).toContain('duplicate scripts/root.test.ts')
  })

  test('fixture data a runner would collect fails; declared as a real test it passes; excluded, no runner may collect it', () => {
    const fixture = 'apps/cli/tests/fixtures/repo/sample.test.ts'
    expect(codes(view(baseFiles({ [fixture]: '' })))).toContain(`unclassified ${fixture}`)
    const declared = withDeclarations(
      (d) => {
        const cli = d.suites.find((s) => s.id === 'cli')
        if (cli) cli.fixtureExecutables = [fixture]
      },
      { [fixture]: '' }
    )
    expect(view(declared).problems).toEqual([])
    const excludedButCollected = withDeclarations((d) => d.exclusions.push({ path: fixture, reason: 'fixture data' }), {
      [fixture]: ''
    })
    expect(codes(view(excludedButCollected))).toContain(`unclassified ${fixture}`)
    // Under the vitest member, outside its include: an honest exclusion.
    const data = 'packages/core/tests/fixtures/sample.test.ts'
    const excluded = withDeclarations((d) => d.exclusions.push({ path: data, reason: 'fixture data a test copies' }), {
      [data]: ''
    })
    const v = view(excluded)
    expect(v.problems).toEqual([])
    expect(v.exclusions).toEqual([{ path: data, reason: 'fixture data a test copies' }])
    expect(v.tests.map((t) => t.id)).not.toContain(data)
  })

  test('a runner or preload the configuration contradicts is a mismatch; an unreadable include is reported', () => {
    const wrongRunner = withDeclarations((d) => {
      const core = d.suites.find((s) => s.id === 'core')
      if (core) core.runner = 'bun'
    })
    expect(codes(view(wrongRunner))).toContain('runner-mismatch packages/core')
    expect(codes(view(baseFiles({ 'apps/cli/bunfig.toml': '[test]\n' })))).toContain('runner-mismatch apps/cli')
    const computed = baseFiles({ 'packages/core/vitest.config.ts': 'export default { test: { include: INCLUDE } }\n' })
    expect(codes(view(computed))).toContain('unreadable packages/core/vitest.config.ts')
  })

  test('a workspace member with neither a suite nor a type-input entry is unclassified', () => {
    const files = baseFiles({ 'packages/extra/package.json': JSON.stringify({ name: '@fx/extra' }) })
    expect(codes(view(files))).toContain('unclassified packages/extra')
  })

  test('the target tree is discovered from the manifest: a re-rooted kernel and process need no new code', () => {
    const files = withDeclarations(
      (d) => {
        d.suites.push(
          { id: 'kernel', owner: '@fx/kernel', kind: 'workspace', dir: 'harness/kernel', runner: 'bun', preload: null },
          {
            id: 'process',
            owner: '@fx/process',
            kind: 'workspace',
            dir: 'harness/processes/strict',
            runner: 'bun',
            preload: null
          }
        )
      },
      {
        'package.json': JSON.stringify({
          workspaces: ['apps/*', 'packages/*', 'harness/kernel', 'harness/processes/*']
        }),
        'harness/kernel/package.json': JSON.stringify({ name: '@fx/kernel', scripts: { test: 'bun test' } }),
        'harness/kernel/gates/run.test.ts': '',
        'harness/processes/strict/package.json': JSON.stringify({ name: '@fx/process', scripts: { test: 'bun test' } }),
        'harness/processes/strict/loops/flow.test.ts': ''
      }
    )
    const v = view(files)
    expect(v.problems).toEqual([])
    expect(v.workspaces).toContain('harness/kernel')
    expect(v.workspaces).toContain('harness/processes/strict')
    expect(v.tests.find((t) => t.id === 'harness/processes/strict/loops/flow.test.ts')?.suite).toBe('process')
  })
})

describe('identities: the generated graph is per revision; the verification context is the declarations and runners', () => {
  test('adding a test changes the graph identity only; editing a declaration changes both', () => {
    const before = view(baseFiles())
    const added = view(baseFiles({ 'apps/cli/tests/new.test.ts': '' }))
    expect(added.graphIdentity).not.toBe(before.graphIdentity)
    expect(added.contextIdentity).toBe(before.contextIdentity)
    expect(added.declarationIdentity).toBe(before.declarationIdentity)
    const edited = view(withDeclarations((d) => d.unknowns.push({ scope: 'docs/', reason: 'unread' })))
    expect(edited.declarationIdentity).not.toBe(before.declarationIdentity)
    expect(edited.contextIdentity).not.toBe(before.contextIdentity)
    expect(before.schemaIdentity).toBe('vinaya.test-inventory@1')
    expect(before.declarationVersion).toBe(1)
  })
})

// ── Configuration readers ──────────────────────────────────────────────────

describe('a configuration change reaches each reader by how it reads', () => {
  const CONFIG = 'apps/cli/settings.json'
  const original = `${JSON.stringify({ review: { rounds: 3 }, telemetry: { url: 'x' }, extra: 1 }, null, 2)}\n`
  const files = withDeclarations(
    (d) => {
      d.inputs.push({
        id: 'settings',
        kind: 'config',
        paths: [CONFIG],
        format: 'json',
        readers: [
          { kind: 'raw-bytes', tests: ['apps/cli/tests/snapshot.test.ts'] },
          { kind: 'parsed-keys', keys: ['review'], tests: ['apps/cli/tests/review.test.ts'] },
          { kind: 'parsed-keys', keys: ['telemetry'], tests: ['apps/cli/tests/telemetry.test.ts'] }
        ],
        reason: 'fixture'
      })
      d.policies.push({
        id: 'scan',
        kind: 'security',
        inputs: [`${CONFIG}#review`],
        duty: 'scans it',
        source: 'fixture'
      })
    },
    {
      [CONFIG]: original,
      'apps/cli/tests/snapshot.test.ts': '',
      'apps/cli/tests/review.test.ts': '',
      'apps/cli/tests/telemetry.test.ts': ''
    }
  )
  const head = view(files)
  const reach = (after: string | null, before: string | null = original) =>
    changedInputReaders(head, head, { path: CONFIG, before, after })
  const readers = (impact: ReturnType<typeof reach>) => [...new Set(impact.readers.map((r) => r.test))].sort()

  test('formatting only: the raw snapshot is reached, the parsed-key readers are not, the security duty stays', () => {
    const impact = reach(`${JSON.stringify(JSON.parse(original))}\n`)
    expect(readers(impact)).toEqual(['apps/cli/tests/snapshot.test.ts'])
    expect(impact.policies.map((p) => p.id)).toEqual(['scan'])
    expect(impact.unknown).toEqual([])
  })

  test('a changed relevant key reaches its reader; another reader of an unrelated key is not reached', () => {
    const impact = reach(`${JSON.stringify({ review: { rounds: 4 }, telemetry: { url: 'x' }, extra: 1 }, null, 2)}\n`)
    expect(readers(impact)).toEqual(['apps/cli/tests/review.test.ts', 'apps/cli/tests/snapshot.test.ts'])
  })

  test('a changed key no declared domain covers keeps the conservative answer, explained', () => {
    const impact = reach(`${JSON.stringify({ review: { rounds: 3 }, telemetry: { url: 'x' }, extra: 2 }, null, 2)}\n`)
    expect(readers(impact)).toEqual([
      'apps/cli/tests/review.test.ts',
      'apps/cli/tests/snapshot.test.ts',
      'apps/cli/tests/telemetry.test.ts'
    ])
    expect(impact.unknown.map((u) => u.scope)).toContain(`${CONFIG}#extra`)
  })

  test('malformed or deleted configuration is read conservatively', () => {
    for (const after of ['{ not json', null]) {
      const impact = reach(after)
      expect(readers(impact)).toHaveLength(3)
      expect(impact.unknown.length).toBeGreaterThan(0)
    }
  })

  test('a path no edge names is an unknown, never silence', () => {
    const impact = changedInputReaders(head, head, { path: 'apps/cli/other.json', before: '{}', after: '{"a":1}' })
    expect(impact.readers).toEqual([])
    expect(impact.unknown[0]?.reason).toContain('no declared edge')
  })
})

// ── Base and head ──────────────────────────────────────────────────────────

describe('base and head are each read from their own declarations', () => {
  const helper = 'apps/cli/tests/helper.ts'
  const baseTree = baseFiles({
    [helper]: 'export const h = 1\n',
    'apps/cli/tests/config.test.ts': "import { read } from '../src/config'\nimport { h } from './helper'\n"
  })
  const headTree = baseFiles() // the helper deleted, and the import of it removed
  const base = view(baseTree, 'base', true)
  const head = view(headTree, 'head', true)

  test('a deleted dependency and the removed import of it still name their reader', () => {
    expect(head.edges.some((e) => e.input === helper)).toBe(false)
    const impact = changedInputReaders(base, head, { path: helper, before: 'export const h = 1\n', after: null })
    expect(impact.readers.map((r) => r.test)).toContain('apps/cli/tests/config.test.ts')
  })

  test('a renamed subject reaches its readers from both sides, and a renamed test is a rename, not a loss', () => {
    const renamedBase = view(
      baseFiles({
        'apps/cli/src/old.ts': 'export const o = 1\n',
        'apps/cli/tests/old.test.ts': "import { o } from '../src/old'\n"
      }),
      'base',
      true
    )
    const renamedHead = view(
      baseFiles({
        'apps/cli/src/new.ts': 'export const o = 1\n',
        'apps/cli/tests/new.test.ts': "import { o } from '../src/new'\n"
      }),
      'head',
      true
    )
    const impact = changedInputReaders(renamedBase, renamedHead, {
      path: 'apps/cli/src/new.ts',
      from: 'apps/cli/src/old.ts',
      before: 'export const o = 1\n',
      after: 'export const o = 2\n'
    })
    expect(impact.readers.map((r) => r.test).sort()).toEqual([
      'apps/cli/tests/new.test.ts',
      'apps/cli/tests/old.test.ts'
    ])
    const diff = diffTestIdentities(
      renamedBase,
      renamedHead,
      new Map([['apps/cli/tests/old.test.ts', 'apps/cli/tests/new.test.ts']])
    )
    expect(diff).toEqual({
      added: [],
      removed: [],
      renamed: [{ from: 'apps/cli/tests/old.test.ts', to: 'apps/cli/tests/new.test.ts' }]
    })
  })

  test("a base without declarations is unmodeled, never filled in from the head's", () => {
    const unmodeled = view(baseFiles({ [INVENTORY_PATH]: null }), 'base')
    expect(unmodeled.modeled).toBe(false)
    expect(unmodeled.tests).toEqual([])
    expect(unmodeled.declarationIdentity).toBeNull()
    const impact = changedInputReaders(unmodeled, head, { path: 'apps/cli/src/config.ts', before: 'a', after: 'b' })
    expect(impact.unknown.some((u) => u.reason.includes('base revision is not modeled'))).toBe(true)
    const inventory = readTestInventory({
      head: memoryReader('head', headTree),
      base: memoryReader('base', baseFiles({ [INVENTORY_PATH]: null }))
    })
    expect(inventory.base?.modeled).toBe(false)
  })
})

describe('a no-reader claim must be proven', () => {
  const scannerModule = 'apps/cli/src/scanners.ts'
  const scanners = `export const DECLARED = [\n  { test: 'apps/cli/tests/config.test.ts', roots: ['docs/'], trigger: 'content' }\n]\n`
  const claim = (path: string) =>
    withDeclarations(
      (d) => {
        d.providers.push({
          id: 'scanners',
          kind: 'provider',
          file: scannerModule,
          export: 'DECLARED',
          shape: 'scanner-declarations',
          reason: 'fixture'
        })
        d.policies.push({
          id: 'secrets',
          kind: 'security',
          inputs: ['secrets/'],
          duty: 'scans for secrets',
          source: 'fixture'
        })
        d.inputs.push({
          id: 'claim',
          kind: 'doc',
          paths: [path],
          readers: [],
          noReader: { reason: 'nothing reads it' },
          reason: 'fixture'
        })
      },
      { [scannerModule]: scanners, 'secrets/policy.md': '', [path]: 'text\n' }
    )

  test('a claim over a scanned folder or a security duty is refused', () => {
    expect(codes(view(claim('docs/guide.md')))).toContain('unproven-no-reader claim')
    expect(codes(view(claim('secrets/key.txt')))).toContain('unproven-no-reader claim')
  })

  test('a claim no duty contradicts is accepted, and one with no reason is refused', () => {
    expect(view(claim('notes/today.md')).problems).toEqual([])
    const unexplained = withDeclarations(
      (d) => d.inputs.push({ id: 'bare', kind: 'doc', paths: ['notes.md'], readers: [], reason: 'x' }),
      {
        'notes.md': ''
      }
    )
    expect(codes(view(unexplained))).toContain('unproven-no-reader bare')
  })
})

describe('referenced providers are read from syntax; an unreadable one stays opaque and scoped', () => {
  const module = 'apps/cli/src/inputs.ts'
  const declare = (text: string) =>
    withDeclarations(
      (d) =>
        d.providers.push({
          id: 'inputs',
          kind: 'provider',
          file: module,
          export: 'INPUTS',
          shape: 'path-list',
          readers: [{ kind: 'raw-bytes', tests: ['apps/cli/tests/config.test.ts'] }],
          reason: 'fixture'
        }),
      { [module]: text, 'docs/a.md': '', 'docs/b/c.md': '' }
    )

  test('literals and spreads of a sibling constant resolve to edges', () => {
    const v = view(
      declare("const DOCS = ['docs/a.md'] as const\nexport const INPUTS: readonly string[] = [...DOCS, 'docs/b/']\n")
    )
    expect(v.problems).toEqual([])
    expect(v.edges.filter((e) => e.source === 'provider:inputs').map((e) => e.input)).toEqual(['docs/a.md', 'docs/b/'])
  })

  test('a computed list is opaque: no edge, a scoped unknown, and the module is never run', () => {
    const v = view(declare("export const INPUTS = computeInputs()\nthrow new Error('never run')\n"))
    expect(v.edges.filter((e) => e.source === 'provider:inputs')).toEqual([])
    expect(v.unknowns).toEqual([expect.objectContaining({ scope: module })])
  })
})

// ── The build job's step ───────────────────────────────────────────────────

describe('the build job runs the inventory check and the repository suite, and either failure fails it', () => {
  type Step = { name?: string; if?: string; run?: string }
  const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { if?: string; steps: Step[] }>
  }
  const step = workflow.jobs.build?.steps.find(
    (s) => s.name === 'Check the test inventory and run the repository suite'
  )

  test('the step is unconditional, in an unconditional job, and lists exactly the inventory repository suite', () => {
    expect(workflow.jobs.build?.if).toBeUndefined()
    expect(step).toBeDefined()
    expect(step?.if).toBeUndefined()
    const listed = (step?.run ?? '')
      .split('\n')
      .find((line) => line.trim().startsWith('bun test '))
      ?.trim()
      .split(/\s+/)
      .slice(2)
      .map((path) => path.replace(/^\.\//, ''))
    const repositorySuite = readTestInventory(REPO_ROOT)
      .head.tests.filter((t) => t.kind === 'repository')
      .map((t) => t.id)
    expect([...(listed ?? [])].sort()).toEqual([...repositorySuite].sort())
  })

  // GitHub runs a `run:` block with `bash -e`; the fake `bun` fails the command named in FAIL_ON.
  const runStep = (failOn: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'inventory-step-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(
        join(bin, 'bun'),
        '#!/bin/sh\ncase "$*" in *"$FAIL_ON"*) echo "fake bun failed: $*" >&2; exit 1;; esac\nexit 0\n'
      )
      chmodSync(join(bin, 'bun'), 0o755)
      // A documentation-only diff: the step reads nothing about the diff, so it runs the same.
      return spawnSync('bash', ['-e', '-c', step?.run ?? 'exit 99'], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, FAIL_ON: failOn, DOCS_ONLY: 'true' }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('passes when both commands pass', () => {
    expect(runStep('__never__').status).toBe(0)
  })

  test('fails when the inventory check fails, before any test runs', () => {
    const run = runStep('inventory-check.ts')
    expect(run.status).not.toBe(0)
    expect(run.stderr).not.toContain('fake bun failed: test')
  })

  test('fails when the repository suite fails, the relocation proof among it', () => {
    expect(runStep('relocation-fixture.test.ts').status).not.toBe(0)
    expect(runStep('ui-rules.test.ts').status).not.toBe(0)
  })
})

describe('the check exits non-zero on a broken inventory', () => {
  test('an unclassified test in a committed tree fails the command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'inventory-cli-'))
    try {
      for (const [path, text] of Object.entries(baseFiles({ 'tools/stray.test.ts': '' }))) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), text)
      }
      const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      git('init', '-q')
      git('add', '-A')
      const run = spawnSync(process.execPath, [join(import.meta.dir, 'inventory-check.ts')], {
        cwd: dir,
        encoding: 'utf8'
      })
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('unclassified tools/stray.test.ts')
      git('rm', '-q', '--cached', 'tools/stray.test.ts')
      rmSync(join(dir, 'tools'), { recursive: true })
      const clean = spawnSync(process.execPath, [join(import.meta.dir, 'inventory-check.ts')], {
        cwd: dir,
        encoding: 'utf8'
      })
      expect(clean.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
