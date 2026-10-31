import { describe, expect, it } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CONVENTIONAL_LAYOUT,
  type CiFacts,
  decideCiSelection,
  discoveredLayout,
  isSelectablePath,
  readLayoutFile,
  shardFilesToRun
} from '../../src/lib/ci-test-selection'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture'
import { fixtureDir } from './test-temp-fixture'

const ROOT = '/repo'
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

function facts(overrides: Partial<CiFacts> = {}): CiFacts {
  return {
    baseResolves: true,
    gitDiff: ['apps/cli/src/lib/widget.ts'],
    selectionChanged: ['apps/cli/src/lib/widget.ts'],
    select: () => [`${ROOT}/apps/cli/tests/widget.test.ts`],
    ...overrides
  }
}

describe('which changed paths the selector can judge', () => {
  it('accepts the portal, changesets and TypeScript sources under apps/ and packages/', () => {
    for (const path of [
      'apps/vinaya-portal/app/page.tsx',
      'apps/vinaya-portal/README.md',
      'apps/vinaya-portal/public/logo.svg',
      '.changeset/quiet-fox.md',
      'apps/cli/src/lib/widget.ts',
      'apps/cli/tests/widget.test.ts',
      'packages/aeg-core/src/brief.ts',
      'packages/sources/src/view.tsx'
    ]) {
      expect(isSelectablePath(path), path).toBe(true)
    }
  })

  it('refuses every other kind of path', () => {
    for (const path of [
      '.github/workflows/ci.yml',
      'aeg-root/enforcement.md',
      'apps/cli/specs/self-hosting.md',
      'apps/cli/package.json',
      'apps/cli/tests/fixtures/repo/src/index.ts',
      'packages/aeg-core/src/fixtures/brief.ts',
      'apps/cli/tests/lib/test-env-preload.ts',
      'apps/cli/tests/ci-shards/shard-1.txt',
      'bunfig.toml',
      'tsconfig.json',
      'vinaya.config.json',
      'scripts/build.ts',
      'apps/cli/scripts/bundle-doctrine.ts',
      'apps/cli/scripts/bundle-doctrine.test.ts',
      'packages/aeg-core/bin/verify-dispatch.ts',
      'apps/cli/vitest.config.ts',
      'packages/aeg-core/vitest.config.ts',
      'apps/cli/index.ts',
      'apps/cli/tsconfig.json',
      'apps/cli/src/lib/tool.py'
    ]) {
      expect(isSelectablePath(path), path).toBe(false)
    }
  })
})

describe('a pull request falls back to everything', () => {
  it('when the base commit does not resolve, without running the selection', () => {
    let ran = false
    const decision = decideCiSelection(
      facts({
        baseResolves: false,
        select: () => {
          ran = true
          return []
        }
      })
    )
    expect(decision).toEqual({ scope: 'all', reason: 'the base commit does not resolve' })
    expect(ran).toBe(false)
  })

  it('when any changed path is one the selector cannot judge', () => {
    const decision = decideCiSelection(
      facts({ gitDiff: ['apps/cli/src/lib/widget.ts', 'apps/cli/specs/self-hosting.md'] })
    )
    expect(decision.scope).toBe('all')
    expect(decision.scope === 'all' && decision.reason).toContain('apps/cli/specs/self-hosting.md')
  })

  it('when the selection saw no changed file while git diff lists some', () => {
    expect(decideCiSelection(facts({ selectionChanged: [] })).scope).toBe('all')
  })

  it('when the selection throws', () => {
    const decision = decideCiSelection(
      facts({
        select: () => {
          throw new Error('graph build failed')
        }
      })
    )
    expect(decision).toEqual({ scope: 'all', reason: 'the selection failed: graph build failed' })
  })

  it('and a run-everything decision keeps the whole shard list in its order', () => {
    const shard = ['tests/b.test.ts', 'tests/a.test.ts']
    expect(shardFilesToRun(ROOT, shard, { scope: 'all', reason: 'x' })).toEqual(shard)
  })
})

describe('a pull request the selector can judge', () => {
  it('runs only the shard entries the selection picked, compared on one path form', () => {
    const decision = decideCiSelection(
      facts({
        select: () => [`${ROOT}/apps/cli/tests/a.test.ts`, `${ROOT}/apps/vinaya-portal/tests/page.test.ts`]
      })
    )
    expect(decision.scope).toBe('selected')
    expect(shardFilesToRun(ROOT, ['tests/b.test.ts', 'tests/a.test.ts'], decision)).toEqual(['tests/a.test.ts'])
  })

  it('runs nothing in a shard none of whose files were selected', () => {
    const decision = decideCiSelection(facts({ select: () => [] }))
    expect(decision).toEqual({ scope: 'selected', selected: [] })
    expect(shardFilesToRun(ROOT, ['tests/a.test.ts'], decision)).toEqual([])
  })

  it('narrows a diff that only touches the portal and a changeset', () => {
    const decision = decideCiSelection(
      facts({
        gitDiff: ['apps/vinaya-portal/app/page.tsx', '.changeset/quiet-fox.md'],
        selectionChanged: ['apps/vinaya-portal/app/page.tsx', '.changeset/quiet-fox.md']
      })
    )
    expect(decision.scope).toBe('selected')
  })

  it('narrows an empty diff with an empty selection', () => {
    expect(decideCiSelection(facts({ gitDiff: [], selectionChanged: [], select: () => [] }))).toEqual({
      scope: 'selected',
      selected: []
    })
  })
})

describe('eligibility follows the workspace members discovery finds', () => {
  /** A repository holding both layouts' members: today's `harness` and the target's nested kernel and process. */
  function layoutsRepo(): string {
    const root = fixtureDir('ci-layouts-')
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    write('package.json', JSON.stringify({ workspaces: ['apps/*', 'harness/kernel', 'harness/processes/*'] }))
    write('bunfig.toml', '[test]\npreload = "./apps/cli/tests/lib/test-env-preload.ts"\n')
    write('apps/cli/package.json', JSON.stringify({ name: '@fx/cli' }))
    write('harness/kernel/package.json', JSON.stringify({ name: '@fx/kernel' }))
    write(
      'harness/kernel/bunfig.toml',
      '[test]\ntimeout = 5\npreload = ["./tests/setup.ts", "./tests/env.ts"]\n\n[run]\npreload = "./ignored.ts"\n'
    )
    write('harness/processes/strict/package.json', JSON.stringify({ name: '@fx/strict' }))
    write('tools/x/package.json', JSON.stringify({ name: '@fx/not-a-member' }))
    return root
  }

  it("discovers the members from the manifest and every preload the root's or a member's bunfig names", () => {
    const layout = discoveredLayout(layoutsRepo())
    expect(layout.packageDirs).toEqual(['apps/cli', 'harness/kernel', 'harness/processes/strict'])
    expect(layout.preloads).toEqual([
      'apps/cli/tests/lib/test-env-preload.ts',
      'harness/kernel/tests/env.ts',
      'harness/kernel/tests/setup.ts'
    ])
  })

  it("admits the target tree's members' source folders and nothing a member does not model", () => {
    const layout = discoveredLayout(layoutsRepo())
    for (const path of [
      'harness/kernel/src/config/loader.ts',
      'harness/processes/strict/tests/flow.test.ts',
      'apps/cli/src/a.ts'
    ])
      expect(isSelectablePath(path, layout), path).toBe(true)
    for (const path of [
      'harness/kernel/config/loader.ts', // a folder the member does not model by default
      'harness/kernel/tests/setup.ts', // a preload its bunfig names
      'harness/kernel/vitest.config.ts',
      'harness/processes/strict/bin/run.ts',
      'tools/x/src/a.ts', // under a package the manifest never names: its dependencies are not modeled
      'harness/processes/strict/tests/fixtures/repo/a.ts'
    ])
      expect(isSelectablePath(path, layout), path).toBe(false)
  })

  it('a layout naming a member’s own source folders admits them, still never its bin, scripts, top-level files or opaque paths', () => {
    const layout = {
      ...discoveredLayout(layoutsRepo()),
      sourceRoots: { 'harness/kernel': ['.'] },
      opaque: ['harness/kernel/spawned/']
    }
    expect(isSelectablePath('harness/kernel/config/loader.ts', layout)).toBe(true)
    for (const path of [
      'harness/kernel/bin/run.ts',
      'harness/kernel/scripts/x.ts',
      'harness/kernel/index.ts',
      'harness/kernel/spawned/p.ts'
    ])
      expect(isSelectablePath(path, layout), path).toBe(false)
  })

  it("this repository's discovered layout answers the conventional lists exactly as before", () => {
    const layout = discoveredLayout(REPO_ROOT)
    const judged = [
      'apps/vinaya-portal/app/page.tsx',
      '.changeset/quiet-fox.md',
      'apps/cli/src/lib/widget.ts',
      'apps/cli/tests/widget.test.ts',
      'packages/aeg-core/src/brief.ts',
      'packages/sources/src/view.tsx'
    ]
    const refused = [
      '.github/workflows/ci.yml',
      'apps/cli/tests/fixtures/repo/src/index.ts',
      'apps/cli/tests/lib/test-env-preload.ts',
      'vinaya.config.json',
      'scripts/build.ts',
      'apps/cli/scripts/bundle-doctrine.ts',
      'packages/aeg-core/bin/verify-dispatch.ts',
      'apps/cli/index.ts'
    ]
    for (const path of judged)
      expect([path, isSelectablePath(path, layout)]).toEqual([path, isSelectablePath(path, CONVENTIONAL_LAYOUT)])
    for (const path of refused) expect([path, isSelectablePath(path, layout)]).toEqual([path, false])
    // Members the fixed folder list never covered are found, and only their source folders are admitted.
    expect(layout.packageDirs).toContain('harness')
    expect(layout.packageDirs).toContain('processes/vinaya')
    expect(isSelectablePath('processes/vinaya/bin/run-engine.ts', layout)).toBe(false)
  })

  it('the decision reads the layout the facts carry', () => {
    const gitDiff = ['harness/kernel/src/a.ts']
    expect(decideCiSelection(facts({ gitDiff, selectionChanged: gitDiff })).scope).toBe('all')
    const layout = discoveredLayout(layoutsRepo())
    expect(decideCiSelection(facts({ gitDiff, selectionChanged: gitDiff, layout })).scope).toBe('selected')
  })

  it('a layout file is read and refused when malformed', () => {
    const dir = fixtureDir('ci-layout-file-')
    writeFileSync(
      join(dir, 'good.json'),
      JSON.stringify({ packageDirs: ['apps/cli'], sourceRoots: { 'apps/cli': ['src'] } })
    )
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ packageDirs: 'apps/cli' }))
    expect(readLayoutFile(join(dir, 'good.json')).packageDirs).toEqual(['apps/cli'])
    expect(() => readLayoutFile(join(dir, 'bad.json'))).toThrow('packageDirs')
  })

  it('--explain writes the decision and why each selected test was picked, leaving STDOUT as it was', () => {
    const root = fixtureDir('ci-explain-')
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    write('package.json', JSON.stringify({ workspaces: ['packages/*'] }))
    write('packages/a/package.json', JSON.stringify({ name: '@fx/a' }))
    write('packages/a/src/a.ts', 'export const a = 1\n')
    write('packages/a/tests/a.test.ts', "import { a } from '../src/a'\nexport const t = a\n")
    const git = (...args: string[]) =>
      spawnSyncBudgeted('git', ['-c', 'user.email=f@x', '-c', 'user.name=f', ...args], {
        cwd: root,
        encoding: 'utf8',
        env: stripVinayaEnv()
      })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD').stdout.trim()
    write('packages/a/src/a.ts', 'export const a = 2\n')
    git('commit', '-qam', 'change')
    const explain = join(root, 'explain.json')
    const run = spawnSyncBudgeted(
      'bun',
      [join(REPO_ROOT, 'apps/cli/src/lib/ci-test-selection.ts'), '--base', base, '--packages', '--explain', explain],
      { cwd: root, encoding: 'utf8', env: stripVinayaEnv() },
      60_000
    )
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('affected\n')
    const written = JSON.parse(readFileSync(explain, 'utf8')) as {
      decision: { scope: string }
      explanations: { test: string; kind: string }[]
    }
    expect(written.decision.scope).toBe('selected')
    expect(written.explanations).toEqual([
      expect.objectContaining({ test: 'packages/a/tests/a.test.ts', kind: 'direct-dependency' })
    ])
  }, 60_000)
})
