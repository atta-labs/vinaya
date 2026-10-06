// Folder-scanning tests at pre-push: each declares the roots it reads and the
// kind of change it judges, and the depth-one selection runs it for that kind
// of change only — a file added, renamed or removed under its roots, or a
// process started in the touched lines of a file there. An ordinary edit
// selects none of them. Proved on throwaway workspaces with declarations of
// their own, plus a completeness check over this repository's real tree.
import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { escapeReportLines, failingTestFilesFromJunit } from '../../src/lib/pre-push-selection'
import {
  SCANNER_DECLARATIONS,
  type ScannerDeclaration,
  scannedRootsOf,
  startsProcessIn
} from '../../src/lib/repo-scanner-tests'
import { discoverWorkspacePackages, isTestFile, selectAffectedTestFiles } from '../../src/lib/test-selector'
import { loadTypeScript } from '../../src/lib/ts-module-graph'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

const DECLARATIONS: ScannerDeclaration[] = [
  { test: 'apps/cli/tests/shape.test.ts', roots: ['apps/cli/'], trigger: 'tree-shape' },
  { test: 'apps/cli/tests/processes.test.ts', roots: ['apps/cli/tests/'], trigger: 'process-start' },
  { test: 'apps/cli/tests/content.test.ts', roots: ['.'], trigger: 'content' }
]
const SHAPE = 'apps/cli/tests/shape.test.ts'
const PROCESSES = 'apps/cli/tests/processes.test.ts'
const CONTENT = 'apps/cli/tests/content.test.ts'

/** A workspace whose three scanner tests import nothing, so only a declared trigger can select them. */
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinaya-scanner-triggers-'))
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }
  write('package.json', JSON.stringify({ workspaces: ['apps/*'] }))
  write('apps/cli/package.json', JSON.stringify({ name: '@fx/cli', main: './src/index.ts' }))
  write('apps/cli/src/index.ts', 'export function run() { return 1 }\n')
  write(SHAPE, 'export const shape = 1\n')
  write(PROCESSES, 'export const processes = 1\n')
  write(CONTENT, 'export const content = 1\n')
  write(
    'apps/cli/tests/spawner.test.ts',
    "import { spawnSync } from 'node:child_process'\nconst label = 'a'\nspawnSync('true', [])\nexport default label\n"
  )
  return root
}

function select(
  root: string,
  diff: {
    changed?: string[]
    addedOrRenamed?: string[]
    removed?: string[]
    changedRanges?: Map<string, { start: number; end: number }[]>
  }
): string[] {
  const { selected } = selectAffectedTestFiles(
    root,
    (diff.changed ?? []).map((f) => join(root, f)),
    {
      addedOrRenamed: diff.addedOrRenamed,
      removed: diff.removed,
      changedRanges: diff.changedRanges,
      scannerDeclarations: DECLARATIONS,
      depth: 'one'
    }
  )
  // Sorted: selection follows directory-listing order, which only some filesystems sort.
  return selected
    .map((f) => f.slice(root.length + 1))
    .filter((f) => [SHAPE, PROCESSES, CONTENT].includes(f))
    .sort()
}

describe('pre-push selects a folder-scanning test only for the kind of change it judges', () => {
  it('an ordinary modification selects none of them', () => {
    const root = workspace()
    try {
      const ranges = new Map([[join(root, 'apps/cli/tests/spawner.test.ts'), [{ start: 2, end: 2 }]]])
      expect(select(root, { changed: ['apps/cli/src/index.ts'] })).toEqual([])
      expect(select(root, { changed: ['apps/cli/tests/spawner.test.ts'], changedRanges: ranges })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a file added, renamed or removed under its roots selects a tree-shape scanner', () => {
    const root = workspace()
    try {
      writeFileSync(join(root, 'apps/cli/src/added.ts'), 'export const added = 1\n')
      expect(select(root, { changed: ['apps/cli/src/added.ts'], addedOrRenamed: ['apps/cli/src/added.ts'] })).toEqual([
        SHAPE
      ])
      expect(select(root, { removed: ['apps/cli/src/gone.ts'] })).toEqual([SHAPE])
      // Outside the roots: nothing.
      expect(select(root, { removed: ['docs/gone.md'] })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a process started in the touched lines of a file under its roots selects a process-start scanner', () => {
    const root = workspace()
    const spawner = 'apps/cli/tests/spawner.test.ts'
    try {
      const touchedCall = new Map([[join(root, spawner), [{ start: 3, end: 3 }]]])
      expect(select(root, { changed: [spawner], changedRanges: touchedCall })).toEqual([PROCESSES])
      // No hunks known for the file: every line counts as touched.
      expect(select(root, { changed: [spawner] })).toEqual([PROCESSES])
      // A brand-new file that starts a process is added and reshapes apps/cli/ too.
      writeFileSync(
        join(root, 'apps/cli/tests/new.test.ts'),
        "import { execFileSync } from 'node:child_process'\nexecFileSync('true')\n"
      )
      const added = 'apps/cli/tests/new.test.ts'
      expect(select(root, { changed: [added], addedOrRenamed: [added] })).toEqual([PROCESSES, SHAPE].sort())
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a content scanner is never selected by its declaration', () => {
    const root = workspace()
    try {
      expect(select(root, { changed: ['apps/cli/src/index.ts'], removed: ['x.ts'] })).not.toContain(CONTENT)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('startsProcessIn reads process starts with the compiler, not a text search', () => {
  const ts = loadTypeScript(REPO_ROOT)
  if (!ts) throw new Error('typescript is not resolvable from the repository root')

  it('counts a call only in the touched lines, and skips comments, strings and RegExp exec', () => {
    const source = [
      '// spawnSync(this is a comment)', // 1
      "const text = 'execSync(not a call)'", // 2
      '/x/.exec(text)', // 3
      'Bun.spawn({ cmd: [', // 4
      "  'true'", // 5
      '] })' // 6
    ].join('\n')
    expect(startsProcessIn(ts, 'f.ts', source, [{ start: 1, end: 3 }])).toBe(false)
    expect(startsProcessIn(ts, 'f.ts', source, [{ start: 5, end: 5 }])).toBe(true)
    expect(startsProcessIn(ts, 'f.ts', source)).toBe(true)
    expect(startsProcessIn(ts, 'f.ts', 'const a = 1\n')).toBe(false)
  })
})

describe('every folder-scanning test in this repository declares its roots and its trigger', () => {
  const ts = loadTypeScript(REPO_ROOT)
  if (!ts) throw new Error('typescript is not resolvable from the repository root')
  const classified = discoverWorkspacePackages(REPO_ROOT)
    .flatMap((pkg) => pkg.sourceFiles)
    .filter(isTestFile)
    .filter((file) => scannedRootsOf(ts, file, readFileSync(file, 'utf8'), REPO_ROOT).length > 0)
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort()
  const declared = SCANNER_DECLARATIONS.map((d) => d.test).sort()

  it('the classifier finds folder-scanning tests at all', () => {
    expect(classified.length).toBeGreaterThan(0)
  })

  it('no folder-scanning test is missing a declaration', () => {
    expect(classified.filter((f) => !declared.includes(f))).toEqual([])
  })

  it('no declaration names a file that is gone or no longer scans', () => {
    expect(declared.filter((f) => !classified.includes(f))).toEqual([])
    expect(new Set(declared).size).toBe(declared.length)
  })

  it('every declared root exists in the checkout', () => {
    const missing = SCANNER_DECLARATIONS.flatMap((d) => d.roots)
      .filter((root) => root !== '.')
      .filter((root) => !existsSync(join(REPO_ROOT, root)) && !existsSync(dirname(join(REPO_ROOT, root))))
    expect(missing).toEqual([])
  })
})

describe('the CI escape report', () => {
  const junit = [
    '<testsuites name="bun test" tests="3" failures="2">',
    '  <testsuite name="tests/a.test.ts" file="tests/a.test.ts" tests="1" failures="1" skipped="0">',
    '  </testsuite>',
    '  <testsuite name="tests/b.test.ts" file="tests/b.test.ts" tests="1" failures="0" skipped="0">',
    '  </testsuite>',
    '  <testsuite name="tests/c.test.ts" file="tests/c.test.ts" tests="1" failures="0" errors="1">',
    '  </testsuite>',
    '</testsuites>'
  ].join('\n')

  it('reads every suite with a failure or an error, resolved against the run directory', () => {
    expect(failingTestFilesFromJunit(junit, '/repo/apps/cli')).toEqual([
      '/repo/apps/cli/tests/a.test.ts',
      '/repo/apps/cli/tests/c.test.ts'
    ])
  })

  it('tells a selection escape from a platform difference, per failing file', () => {
    const lines = escapeReportLines(
      '/repo',
      ['/repo/apps/cli/tests/a.test.ts', '/repo/apps/cli/tests/c.test.ts'],
      ['/repo/apps/cli/tests/a.test.ts']
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('apps/cli/tests/a.test.ts — pre-push selects it')
    expect(lines[0]).toContain('platform difference')
    expect(lines[1]).toContain('apps/cli/tests/c.test.ts — pre-push does NOT select it')
    expect(lines[1]).toContain('selection escape')
  })
})
