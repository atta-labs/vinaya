/**
 * Every reader of imports that decides what runs, what the CI plan covers or what a guard sees follows an aliased
 * import. One small tree holds a module that imports another through each alias; each reader in the registry below is
 * asked whether it reports that edge, and the test fails naming each reader that does not. A reader added to the
 * repository that follows imports is added here.
 *
 * Every reader but one reads the alias table through the kernel's one reading and the library's one matching rule. The
 * base guard is the registered exception: CI runs it from the base commit alone, it imports nothing but the runtime,
 * so it reads the table from the base commit through its own reader with a small local matching rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { selectAffectedTestFiles } from '@harness/workflow/integration/repository-verification.js'
import { gatherLogProducerGraph } from '@harness/workflow/checks/log-producer-graph.js'
import { importedPaths } from '@harness/workflow/evals/suites/not-shipped-imports.js'
import { runtimeImportPaths } from '@harness/workflow/evals/suites/renderer-imports.js'
import { type Revision, resolveModule } from '@harness/workflow/evals/suites/recut-generic-cases.js'
import { suiteImports } from '@harness/workflow/integration/isolation/sandbox-conformance/suite-imports.js'
import { readPinnedFileImporters } from '@harness/workflow/tools/task-contract/forge/forge-write.js'
import { repositoryImportTree } from '@harness/workflow/tools/task-contract/generated-artifacts.js'
import { countSource } from '@harness/kernel/tests/architecture-ratchet.js'
import { readAliasTable } from '@harness/kernel/imports/alias-table.js'
import { staticClosure } from '../../apps/cli/tests/lib/static-closure.js'
import { guardedClosure } from '../ci/base-guard.ts'
import { typecheckScope } from '../ci/impact-plan.ts'
import { importClosure, revisionReader } from './inventory-check.ts'

type AliasName = 'kernel' | 'workflow'

/** The two aliases, the module each names in the fixture, and the specifier the importer writes. */
const ALIASES: Record<AliasName, { specifier: string; target: string }> = {
  kernel: { specifier: '@harness/kernel/fx/kernel-target.js', target: 'harness/kernel/fx/kernel-target.ts' },
  workflow: {
    specifier: '@harness/workflow/fx/workflow-target.js',
    target: 'harness/processes/vinaya-strict/fx/workflow-target.ts'
  }
}

const IMPORTER = 'apps/cli/src/fx/importer.ts'
const TEST_FILE = 'apps/cli/tests/fx/direct.test.ts'

type Fixture = { root: string; read: (path: string) => string | null }

type Reader = {
  /** What the reader is, named in a failure. */
  name: string
  /** The aliases the reader's own rule applies to; every reader follows both unless it says otherwise. */
  aliases?: readonly AliasName[]
  /** Set on the one reader that reads the alias table itself, with the reason it cannot use the kernel's reading. */
  readsTableItself?: string
  /** Whether the reader reports the edge from the importer to the module the alias names. */
  reports: (fx: Fixture, alias: AliasName) => boolean | Promise<boolean>
}

const stem = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/, '')
const sameModule = (reported: string, target: string): boolean => stem(reported) === stem(target)

const READERS: readonly Reader[] = [
  {
    name: 'test selection, compiler-graph walk (through the adapter)',
    reports: (fx, alias) =>
      selectAffectedTestFiles(fx.root, [ALIASES[alias].target], { resolver: 'compiler' }).selected.some((file) =>
        file.endsWith(TEST_FILE)
      )
  },
  {
    name: 'test selection, text-scan walk (through the adapter)',
    reports: (fx, alias) =>
      selectAffectedTestFiles(fx.root, [ALIASES[alias].target], { resolver: 'text-scan' }).selected.some((file) =>
        file.endsWith(TEST_FILE)
      )
  },
  {
    name: 'base guard (closure of planner inputs)',
    readsTableItself:
      'CI runs it from the base commit alone and it imports nothing but the runtime, so it reads the table from the base commit through its own reader',
    reports: (fx, alias) =>
      guardedClosure(fx.read, [IMPORTER]).files.some((file) => sameModule(file, ALIASES[alias].target))
  },
  {
    name: 'impact plan (type-check scope)',
    reports: (fx, alias) =>
      typecheckScope(fx.root, revisionReader(fx.root, 'HEAD'), [ALIASES[alias].target]).items.includes('@fx/cli')
  },
  {
    name: 'inventory check (import closure)',
    reports: (fx, alias) => {
      const tree = revisionReader(fx.root, 'HEAD')
      return importClosure(tree, tree.list())(IMPORTER).some((file) => sameModule(file, ALIASES[alias].target))
    }
  },
  {
    name: 'Issue gate (importers of a pinned file)',
    reports: (fx, alias) => {
      const body = [
        "## Planner's rationale",
        '',
        `**Boundary** — In: the module. Pinned files: \`${ALIASES[alias].target}\`. Out: nothing else.`,
        '',
        '## Objectives',
        '',
        'O1. The module is read.',
        '',
        '## Surface',
        '',
        'in: apps/cli/src',
        '',
        '## Parts',
        '',
        'Part 1 (O1) — the module is read.'
      ].join('\n')
      return (readPinnedFileImporters(body, fx.root)[0]?.importers ?? []).includes(IMPORTER)
    }
  },
  {
    name: 'kernel boundary guard (architecture ratchet count)',
    // Only a process alias is counted: the kernel alias names no process.
    aliases: ['workflow'],
    reports: (fx) => countSource(fx.read(IMPORTER) ?? '', [], readAliasTable(fx.root)) >= 1
  },
  {
    name: 'log-producer graph',
    reports: (fx, alias) =>
      (gatherLogProducerGraph(fx.root).imports.get(IMPORTER) ?? []).some((file) =>
        sameModule(file, ALIASES[alias].target)
      )
  },
  {
    name: 'recut case resolver',
    reports: (fx, alias) => {
      const revision: Revision = { has: (path) => fx.read(path) !== null, read: fx.read }
      const resolved = resolveModule(ALIASES[alias].specifier, IMPORTER, revision, new Map())
      return resolved !== null && sameModule(resolved, ALIASES[alias].target)
    }
  },
  {
    name: 'not-shipped test import reading',
    reports: (fx, alias) =>
      importedPaths(join(fx.root, IMPORTER), fx.root).some((file) =>
        sameModule(file, join(fx.root, ALIASES[alias].target))
      )
  },
  {
    name: 'command-loading test static closure',
    reports: (fx, alias) =>
      staticClosure(join(fx.root, IMPORTER), fx.root).some((file) => sameModule(file, ALIASES[alias].target))
  },
  {
    name: 'sandbox-conformance import walk',
    reports: (fx, alias) =>
      [...suiteImports([join(fx.root, IMPORTER)], fx.root).modules].some((file) =>
        sameModule(file, ALIASES[alias].target)
      )
  },
  {
    name: 'renderer test import scan',
    reports: (fx, alias) =>
      runtimeImportPaths(fx.read(IMPORTER) ?? '', IMPORTER, fx.root).some((file) =>
        sameModule(file, ALIASES[alias].target)
      )
  },
  {
    name: 'generated-artifact import tree',
    reports: (fx, alias) => {
      try {
        const resolved = repositoryImportTree(fx.root).resolve(ALIASES[alias].specifier, IMPORTER)
        return resolved !== null && sameModule(resolved, ALIASES[alias].target)
      } catch {
        return false
      }
    }
  }
]

let root = ''
let fixture: Fixture

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'fx-root',
    private: true,
    workspaces: ['apps/cli', 'harness/kernel', 'harness/processes/vinaya-strict']
  }),
  'packages/typescript-config/base.json': JSON.stringify({
    compilerOptions: {
      paths: {
        '@harness/kernel/*': ['../../harness/kernel/*'],
        '@harness/workflow/*': ['../../harness/processes/vinaya-strict/*']
      }
    }
  }),
  'apps/cli/package.json': JSON.stringify({
    name: '@fx/cli',
    version: '1.0.0',
    scripts: { typecheck: 'tsc --noEmit' }
  }),
  'harness/kernel/package.json': JSON.stringify({
    name: '@fx/kernel',
    version: '1.0.0',
    scripts: { typecheck: 'tsc --noEmit' }
  }),
  'harness/processes/vinaya-strict/package.json': JSON.stringify({
    name: '@fx/workflow',
    version: '1.0.0',
    scripts: { typecheck: 'tsc --noEmit' }
  }),
  'harness/kernel/fx/kernel-target.ts': 'export const kernelTarget = 1\n',
  'harness/processes/vinaya-strict/fx/workflow-target.ts': 'export const workflowTarget = 2\n',
  [IMPORTER]: [
    `import { kernelTarget } from '${ALIASES.kernel.specifier}'`,
    `import { workflowTarget } from '${ALIASES.workflow.specifier}'`,
    'export const both = [kernelTarget, workflowTarget]',
    ''
  ].join('\n'),
  [TEST_FILE]: [
    `import { kernelTarget } from '${ALIASES.kernel.specifier}'`,
    `import { workflowTarget } from '${ALIASES.workflow.specifier}'`,
    'export const both = [kernelTarget, workflowTarget]',
    ''
  ].join('\n')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'alias-readers-'))
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'fixture')
  fixture = { root, read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null) }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('every reader of imports follows an aliased import', () => {
  it('reports the edge through each alias for every registered reader, and names each one that does not', async () => {
    const missing: string[] = []
    for (const reader of READERS) {
      for (const alias of reader.aliases ?? (['kernel', 'workflow'] as const)) {
        let reported = false
        try {
          reported = await reader.reports(fixture, alias)
        } catch (error) {
          missing.push(
            `${reader.name} threw for the ${alias} alias: ${error instanceof Error ? error.message : String(error)}`
          )
          continue
        }
        if (!reported) missing.push(`${reader.name} does not report the ${alias} alias edge`)
      }
    }
    expect(missing).toEqual([])
  }, 120_000)

  it('registers the base guard as the one reader that reads the alias table itself, with the reason', () => {
    const own = READERS.filter((reader) => reader.readsTableItself !== undefined)
    expect(own.map((reader) => reader.name)).toEqual(['base guard (closure of planner inputs)'])
    expect(own[0]?.readsTableItself).toContain('base commit')
  })

  it('reports no edge from a reader when the repository holds no base config', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'alias-readers-bare-'))
    try {
      for (const [path, text] of Object.entries(FILES)) {
        if (path === 'packages/typescript-config/base.json') continue
        mkdirSync(dirname(join(bare, path)), { recursive: true })
        writeFileSync(join(bare, path), text)
      }
      const read = (path: string): string | null =>
        existsSync(join(bare, path)) ? readFileSync(join(bare, path), 'utf8') : null
      // Without a table nothing is an alias: the readers give the answer they gave before aliases, and throw nothing.
      expect(readAliasTable(bare)).toEqual([])
      expect(guardedClosure(read, [IMPORTER]).files).toEqual([IMPORTER])
      expect(staticClosure(join(bare, IMPORTER), bare)).toEqual([IMPORTER])
      expect(importedPaths(join(bare, IMPORTER), bare)).toEqual([])
      expect(runtimeImportPaths(read(IMPORTER) ?? '', IMPORTER, bare)).toEqual([])
      expect(countSource(read(IMPORTER) ?? '', [], readAliasTable(bare))).toBe(0)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
