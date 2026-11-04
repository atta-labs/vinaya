/**
 * The package-compatibility suite: every published package's consumer surface,
 * read from a packed install outside this repository, matches the committed
 * snapshot (`scripts/package-compat/snapshot.json`). One package is published,
 * the command-line package, and its tarball carries the tool bridge program
 * beside the bundle.
 *
 * It deliberately imports the packages' public subpaths — from the scratch
 * install, never from the workspace — and the build job runs it on every pull
 * request. A difference fails naming the package, the subpath and what
 * differs; `bun scripts/package-compat/facts.ts --write` records an intended one.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { parse } from 'yaml'
import { fixtureDir } from '../../apps/cli/tests/lib/test-temp-fixture.ts'
import {
  allowlistProblems,
  type CompatRun,
  compareFacts,
  type PackageFacts,
  publishedPackages,
  REPO_ROOT,
  readSnapshot,
  runCompat,
  type Snapshot,
  tarballFiles
} from './facts.ts'

const WHOLE_RUN_MS = 600_000
const snapshot = readSnapshot()
const published = publishedPackages()

/** Each file's digest under a folder, `node_modules` and build output left out. */
function treeDigest(folder: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.turbo'].includes(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else out[path.slice(folder.length + 1)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(folder)
  return out
}

const gitStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })

let scratch = ''
let run: CompatRun
let statusBefore = ''
let packagesBefore: Record<string, Record<string, string>> = {}

beforeAll(() => {
  statusBefore = gitStatus()
  packagesBefore = Object.fromEntries(published.map((p) => [p.name, treeDigest(join(REPO_ROOT, p.dir, 'src'))]))
  scratch = realpathSync(fixtureDir('package-compat-'))
  run = runCompat(scratch, REPO_ROOT)
}, WHOLE_RUN_MS)

describe('every published package matches the snapshot from a scratch install outside the repository', () => {
  test('the scratch install lies outside the repository', () => {
    expect(scratch.startsWith(`${REPO_ROOT}${sep}`)).toBe(false)
    expect(realpathSync(run.installDir).startsWith(`${REPO_ROOT}${sep}`)).toBe(false)
  })

  test('the published packages are the fixed release group, and the snapshot records each one', () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, '.changeset/config.json'), 'utf8')) as { fixed: string[][] }
    expect(published.map((p) => p.name).sort()).toEqual([...(config.fixed[0] ?? [])].sort())
    expect(Object.keys(snapshot.packages).sort()).toEqual(published.map((p) => p.name).sort())
  })

  test('the command-line package is the one published package, and its tarball carries the bridge program', () => {
    expect(published.map((p) => p.name)).toEqual(['@attalabs/vinaya'])
    expect(tarballFiles(run.tarballs['@attalabs/vinaya'] as string)).toContain(
      'dist/kernel/tools/host/dev-tools-bridge.js'
    )
  })

  test('every @attalabs package resolved from its local tarball, and the install loaded nothing from the repository', () => {
    const lock = readFileSync(join(run.installDir, 'bun.lock'), 'utf8')
    for (const tarball of Object.values(run.tarballs)) expect(lock).toContain(tarball)
    expect(lock).not.toContain(REPO_ROOT)
    expect(run.problems).toEqual([])
  })

  test('every subpath each manifest exports was imported under Bun and typechecked', () => {
    for (const pkg of published) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, pkg.dir, 'package.json'), 'utf8')) as {
        exports?: Record<string, string>
      }
      expect({ [pkg.name]: Object.keys(run.facts[pkg.name]?.subpaths ?? {}) }).toEqual({
        [pkg.name]: Object.keys(manifest.exports ?? {}).sort()
      })
    }
  })

  test('the facts equal the snapshot', () => {
    expect(compareFacts(snapshot, run.facts)).toEqual([])
  })

  test("the snapshot's internal-module allowlists hold only reasoned, non-entry modules", () => {
    expect(allowlistProblems(snapshot)).toEqual([])
  })

  test('packing changed no workspace file', () => {
    expect(gitStatus()).toBe(statusBefore)
    for (const pkg of published)
      expect({ [pkg.name]: treeDigest(join(REPO_ROOT, pkg.dir, 'src')) }).toEqual({
        [pkg.name]: packagesBefore[pkg.name] ?? {}
      })
  })
})

// ── The comparison ──────────────────────────────────────────────────────────

describe('a difference fails naming the package, the subpath and the difference', () => {
  const NAME = '@attalabs/example'
  const facts = (): PackageFacts => ({
    subpaths: {
      '.': {
        symbols: ['Kept', 'removed'],
        runtimeExports: ['removed'],
        declarations: { Kept: ['type Kept = string;'], removed: ['function removed(): void;'] }
      },
      './extra': { symbols: [], runtimeExports: [], declarations: {} }
    },
    files: ['package.json', 'src/index.ts']
  })
  const recorded: Snapshot = {
    schema: 'vinaya.package-compat-snapshot',
    schemaVersion: 1,
    packages: { [NAME]: { dir: 'packages/example', internalModules: [], ...facts() } }
  }

  test('unchanged facts give no difference', () => {
    expect(compareFacts(recorded, { [NAME]: facts() })).toEqual([])
  })

  test('a removed symbol, a changed declaration, a removed subpath and an added file are each named', () => {
    const changed = facts()
    const root = changed.subpaths['.'] as PackageFacts['subpaths'][string]
    root.symbols = ['Kept', 'added']
    root.runtimeExports = []
    root.declarations = { Kept: ['type Kept = number;'], added: ['const added: 1;'] }
    delete changed.subpaths['./extra']
    changed.files = ['package.json', 'src/index.ts', 'src/internal.ts']
    expect(compareFacts(recorded, { [NAME]: changed })).toEqual([
      `${NAME} ./extra: subpath in the snapshot is missing from the exports map`,
      `${NAME} .: symbol removed is no longer exported`,
      `${NAME} .: symbol added is exported but not in the snapshot`,
      `${NAME} .: runtime export removed is missing from the Bun import`,
      `${NAME} .: declaration of Kept differs — snapshot ["type Kept = string;"], tarball ["type Kept = number;"]`,
      `${NAME}: tarball file src/internal.ts is not in the snapshot and no internal-module entry allows it`
    ])
  })

  test('a file change an internal-module entry names is allowed', () => {
    const changed = facts()
    changed.files = ['package.json', 'src/index.ts', 'src/internal.ts']
    const allow = () => [{ path: 'src/internal.ts', source: 'harness/kernel/internal.ts', reason: 'moved' }]
    expect(compareFacts(recorded, { [NAME]: changed }, allow)).toEqual([])
  })
})

// ── Continuous integration ──────────────────────────────────────────────────

describe('continuous integration runs this suite on every pull request', () => {
  const STEP = 'Check every published package against its compatibility snapshot'
  const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { if?: unknown; steps: Array<{ name?: string; if?: unknown; run?: string }> }>
  }

  test('the build job, which carries no condition, runs it in a step that carries none either', () => {
    expect(workflow.jobs.build?.if).toBeUndefined()
    const step = workflow.jobs.build?.steps.find((s) => s.name === STEP)
    expect(step).toBeDefined()
    expect(step?.if).toBeUndefined()
    expect(step?.run?.trim()).toBe('bun test ./scripts/package-compat/package-compat.test.ts')
  })
})
