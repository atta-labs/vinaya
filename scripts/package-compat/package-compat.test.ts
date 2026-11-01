/**
 * The package-compatibility suite: every published package's consumer surface,
 * read from a packed install outside this repository, matches the committed
 * snapshot (`scripts/package-compat/snapshot.json`); the assemble step
 * (`assemble-pack.ts`) packs the three aeg packages byte-for-byte as `npm pack`
 * does today and ships a module that has left a package inside its tarball.
 *
 * It deliberately imports the packages' public subpaths — from the scratch
 * install, never from the workspace — and the build job runs it on every pull
 * request. A difference fails naming the package, the subpath and what
 * differs; `bun scripts/package-compat/facts.ts --write` records an intended one.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { parse } from 'yaml'
import { fixtureDir } from '../../apps/cli/tests/lib/test-temp-fixture.ts'
import { ASSEMBLED_PACKAGES, assemblePack } from './assemble-pack.ts'
import {
  allowlistProblems,
  type CompatRun,
  compareFacts,
  installedFacts,
  installTarballs,
  npmPack,
  type PackageFacts,
  publishedPackages,
  REPO_ROOT,
  readSnapshot,
  runCompat,
  type Snapshot,
  tarballDigests,
  tarballFiles
} from './facts.ts'
import {
  applySplitPrototype,
  DOC_OWNERS,
  SPLIT_MODULE,
  SPLIT_SOURCE,
  SPLIT_SPECIFIER
} from './fixtures/split-prototype.ts'

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
  run = runCompat(scratch, REPO_ROOT, snapshot)
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
    expect(
      published
        .filter((p) => p.assembled)
        .map((p) => p.name)
        .sort()
    ).toEqual([...ASSEMBLED_PACKAGES].sort())
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

  test('the assembled aeg tarballs hold exactly the bytes npm pack ships from each package today', () => {
    for (const pkg of published.filter((p) => p.assembled)) {
      const plain = npmPack(join(REPO_ROOT, pkg.dir), join(scratch, 'plain'))
      expect({ [pkg.name]: tarballDigests(run.tarballs[pkg.name] as string, scratch) }).toEqual({
        [pkg.name]: tarballDigests(plain, scratch)
      })
    }
  })

  test('packing a library package again gives the same bytes', () => {
    for (const pkg of published.filter((p) => !existsSync(join(REPO_ROOT, p.dir, 'scripts', 'build.ts')))) {
      const again = pkg.assembled
        ? assemblePack({
            root: REPO_ROOT,
            packageDir: pkg.dir,
            staging: join(scratch, 'again-stage', pkg.dir),
            dest: join(scratch, 'again'),
            internalModules: snapshot.packages[pkg.name]?.internalModules ?? []
          }).tarball
        : npmPack(join(REPO_ROOT, pkg.dir), join(scratch, 'again'))
      expect({ [pkg.name]: tarballDigests(again, scratch) }).toEqual({
        [pkg.name]: tarballDigests(run.tarballs[pkg.name] as string, scratch)
      })
    }
  })

  test('packing and assembling changed no workspace file', () => {
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
    packages: { [NAME]: { dir: 'packages/example', assembled: true, internalModules: [], ...facts() } }
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

// ── The assemble step and the split prototype ───────────────────────────────

/** A staging copy of the repository holding the three aeg packages, sources only. */
function stagingCopy(prefix: string): string {
  const root = realpathSync(fixtureDir(prefix))
  for (const pkg of published.filter((p) => p.assembled))
    cpSync(join(REPO_ROOT, pkg.dir), join(root, pkg.dir), {
      recursive: true,
      filter: (path) => !path.split(sep).includes('node_modules')
    })
  return root
}

const CORE = published.find((p) => p.name === '@attalabs/aeg-core')?.dir as string

describe('the assemble step', () => {
  test('refuses a package it does not assemble', () => {
    const sources = published.find((p) => !p.assembled && p.dir.startsWith('packages/'))?.dir as string
    expect(() =>
      assemblePack({
        root: REPO_ROOT,
        packageDir: sources,
        staging: join(scratch, 'refused'),
        dest: join(scratch, 'refused'),
        internalModules: []
      })
    ).toThrow('is not one of')
  })

  test('refuses a module outside the package that no internal-module entry records', () => {
    const root = stagingCopy('package-compat-unrecorded-')
    applySplitPrototype(root)
    expect(() =>
      assemblePack({
        root,
        packageDir: CORE,
        staging: join(root, '..', 'unrecorded-stage'),
        dest: join(root, '..'),
        internalModules: []
      })
    ).toThrow(
      `it reaches ${SPLIT_SOURCE}, outside the package's src, and no internal-module entry records its module path`
    )
  })
})

describe('a prototype split of globToRegex out of aeg-core keeps the public snapshot', () => {
  let root = ''
  let workspaceText = ''
  let stagedText = ''
  let prototype: ReturnType<typeof assemblePack>
  let facts: ReturnType<typeof installedFacts>
  let installDir = ''
  let sourcesBefore: Record<string, string> = {}

  beforeAll(() => {
    root = stagingCopy('package-compat-split-')
    workspaceText = applySplitPrototype(root)
    sourcesBefore = { ...treeDigest(join(root, 'packages')), ...treeDigest(join(root, 'harness')) }
    const out = realpathSync(fixtureDir('package-compat-split-out-'))
    prototype = assemblePack({
      root,
      packageDir: CORE,
      staging: join(out, 'stage'),
      dest: join(out, 'tarballs'),
      internalModules: [SPLIT_MODULE]
    })
    stagedText = readFileSync(join(prototype.stagedDir, 'src', 'doc-owners.ts'), 'utf8')
    const tarballs = Object.fromEntries(
      published.filter((p) => p.assembled).map((p) => [p.name, run.tarballs[p.name] as string])
    )
    tarballs['@attalabs/aeg-core'] = prototype.tarball
    installDir = join(out, 'install')
    installTarballs(REPO_ROOT, installDir, tarballs)
    facts = installedFacts(installDir, tarballs)
  }, WHOLE_RUN_MS)

  test('the split module lives outside the package in the staging copy, and doc-owners.ts re-exports it', () => {
    expect(existsSync(join(root, SPLIT_SOURCE))).toBe(true)
    expect(workspaceText).not.toContain('export function globToRegex(')
    expect(workspaceText).toContain(`import { globToRegex } from '${SPLIT_SPECIFIER}'`)
  })

  test('the module ships inside the tarball at its recorded module path, and only its specifier is rewritten', () => {
    expect(tarballFiles(prototype.tarball)).toContain(SPLIT_MODULE.path)
    expect(prototype.modules).toContainEqual({ path: SPLIT_MODULE.path, source: SPLIT_SOURCE, rewritten: false })
    expect(prototype.modules).toContainEqual({ path: 'src/doc-owners.ts', source: DOC_OWNERS, rewritten: true })
    expect(prototype.modules.filter((m) => m.rewritten).map((m) => m.path)).toEqual(['src/doc-owners.ts'])
    expect(stagedText).toBe(workspaceText.replace(`'${SPLIT_SPECIFIER}'`, "'./glob-to-regex'"))
  })

  test('the staging copy it read is unchanged', () => {
    expect({ ...treeDigest(join(root, 'packages')), ...treeDigest(join(root, 'harness')) }).toEqual(sourcesBefore)
  })

  test('every public subpath, symbol and declaration of the snapshot holds, and the new file passes only under the allowlist', () => {
    expect(facts.problems).toEqual([])
    const core = { '@attalabs/aeg-core': facts.facts['@attalabs/aeg-core'] as PackageFacts }
    expect(compareFacts(snapshot, core)).toEqual([
      `@attalabs/aeg-core: tarball file ${SPLIT_MODULE.path} is not in the snapshot and no internal-module entry allows it`
    ])
    expect(compareFacts(snapshot, core, () => [SPLIT_MODULE])).toEqual([])
  })

  test('the installed package imports outside the repository with no reference to the repository', () => {
    const installed = join(installDir, 'node_modules', '@attalabs', 'aeg-core')
    const offending = Object.keys(treeDigest(installed)).filter((path) => {
      const text = readFileSync(join(installed, path), 'utf8')
      return text.includes(REPO_ROOT) || text.includes('harness/') || text.includes(root)
    })
    expect(offending).toEqual([])
    expect(facts.facts['@attalabs/aeg-core']?.subpaths['.']?.runtimeExports).toContain('globToRegex')
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
