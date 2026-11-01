#!/usr/bin/env bun
/**
 * The consumer surface of every published package, read from a packed install
 * outside this repository, and its comparison with the committed snapshot
 * (`scripts/package-compat/snapshot.json`).
 *
 * The published packages are the fixed release group of `.changeset/config.json`.
 * Each one is packed: the three aeg packages through the assemble step
 * (`assemble-pack.ts`), the source package with `npm pack`, and the command-line
 * package from its built bundle and bundled doctrine. The tarballs are installed
 * together into a scratch folder with Bun — every `@attalabs/` package from its
 * local tarball, by dependency and by override, never from a registry — and the
 * install's lockfile is read back to prove it. Third-party dependencies resolve
 * the ordinary way, from the install cache or their registry.
 *
 * From that install, per package: every subpath its `exports` map names; per
 * subpath, the names a Bun import returns, the symbol names and the
 * declarations a TypeScript consumer sees — emitted, then printed per symbol,
 * so a module that moves inside the package changes no recorded declaration —
 * and the tarball's file list. A consumer file importing every subpath is
 * typechecked against the installed packages, and every file either program or
 * the Bun import loads must lie inside the scratch folder.
 *
 * `bun scripts/package-compat/facts.ts --write` records today's facts into the
 * snapshot, keeping each package's reviewed internal-module allowlist.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { ASSEMBLED_PACKAGES, assemblePack, type InternalModule } from './assemble-pack.ts'

export const REPO_ROOT = realpathSync(join(import.meta.dir, '..', '..'))
export const SNAPSHOT_PATH = 'scripts/package-compat/snapshot.json'
export const SNAPSHOT_SCHEMA = 'vinaya.package-compat-snapshot'
export const WRITE_COMMAND = 'bun scripts/package-compat/facts.ts --write'

/**
 * Tarball paths the snapshot does not record, each with why. The command-line
 * package's Studio is a prebuilt web build its `prepack` downloads from a
 * release; it is not built from this tree, so it is left out of the pack.
 */
export const UNRECORDED_PREFIXES: Readonly<Record<string, Record<string, string>>> = {
  '@attalabs/vinaya': {
    'studio-standalone/': 'a prebuilt web build the pack lifecycle downloads from a release, not built from this tree'
  }
}

// ── Snapshot shape ──────────────────────────────────────────────────────────

export type SubpathFacts = {
  /** Every exported name, values and types, as the TypeScript checker lists them. */
  symbols: string[]
  /** The names a Bun `import()` of the subpath returns. */
  runtimeExports: string[]
  /** Per symbol: its emitted declarations, normalized, sorted. */
  declarations: Record<string, string[]>
}

export type PackageFacts = {
  /** The manifest's `bin` map, when it has one. */
  bin?: Record<string, string>
  subpaths: Record<string, SubpathFacts>
  /** The tarball's files, `package/` prefix removed, sorted. */
  files: string[]
}

export type PackageSnapshot = PackageFacts & {
  /** Repository-relative package folder. */
  dir: string
  /** Packed through the assemble step. */
  assembled: boolean
  /** The reviewed allowlist: internal modules the file list may gain or lose. */
  internalModules: InternalModule[]
}

export type Snapshot = {
  schema: typeof SNAPSHOT_SCHEMA
  schemaVersion: 1
  packages: Record<string, PackageSnapshot>
}

export function readSnapshot(root: string = REPO_ROOT): Snapshot {
  return JSON.parse(readFileSync(join(root, SNAPSHOT_PATH), 'utf8')) as Snapshot
}

export function serializeSnapshot(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

// ── The published packages ──────────────────────────────────────────────────

export type PublishedPackage = { name: string; dir: string; assembled: boolean }

type Manifest = {
  name?: string
  version?: string
  bin?: Record<string, string>
  exports?: Record<string, string>
  dependencies?: Record<string, string>
}

const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest

/** The fixed release group of `.changeset/config.json`, each with its workspace folder. */
export function publishedPackages(root: string = REPO_ROOT): PublishedPackage[] {
  const config = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')) as { fixed?: string[][] }
  const names = (config.fixed ?? []).flat()
  const dirs = new Map<string, string>()
  for (const parent of ['apps', 'packages']) {
    for (const child of readdirSync(join(root, parent))) {
      const manifest = join(root, parent, child, 'package.json')
      if (!existsSync(manifest)) continue
      const name = readManifest(manifest).name
      if (name) dirs.set(name, `${parent}/${child}`)
    }
  }
  return names.map((name) => {
    const dir = dirs.get(name)
    if (!dir) throw new Error(`package-compat: ${name} is in the fixed release group but no workspace folder holds it`)
    return { name, dir, assembled: ASSEMBLED_PACKAGES.has(name) }
  })
}

// ── Packing ─────────────────────────────────────────────────────────────────

/** `npm pack` of a folder, lifecycle scripts off, into `dest`; the tarball's path. */
export function npmPack(folder: string, dest: string): string {
  mkdirSync(dest, { recursive: true })
  const out = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dest], {
    cwd: folder,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const filename = (JSON.parse(out) as { filename: string }[])[0]?.filename
  if (!filename) throw new Error(`package-compat: npm pack in ${folder} reported no tarball`)
  return join(dest, filename)
}

/** The tarball's files, `package/` prefix removed, sorted. */
export function tarballFiles(tarball: string): string[] {
  return execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => line.replace(/^package\//, ''))
    .sort()
}

/** Each tarball file's sha256, keyed by its path: the bytes two packs must share. */
export function tarballDigests(tarball: string, scratch: string): Record<string, string> {
  const out = mkdtempIn(scratch, 'unpack-')
  execFileSync('tar', ['-xzf', tarball, '-C', out])
  const digests: Record<string, string> = {}
  for (const path of filesUnder(join(out, 'package')))
    digests[relative(join(out, 'package'), path).split(sep).join('/')] = createHash('sha256')
      .update(readFileSync(path))
      .digest('hex')
  return digests
}

function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(folder, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    })
    .sort()
}

let scratchCounter = 0
function mkdtempIn(parent: string, prefix: string): string {
  const dir = join(parent, `${prefix}${process.pid}-${scratchCounter++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The command-line package's tarball: its bundle built and its doctrine copied
 * in place, as its `prepack` does (both outputs are ignored by git), then the
 * files `npm pack` would publish staged in `stage` and packed there. A bundle
 * file older than this build is an earlier build's leftover — the build
 * rewrites every file it emits — and is not staged; nor is any path
 * {@link UNRECORDED_PREFIXES} names.
 */
export function packCommandLine(root: string, dir: string, stage: string, dest: string): string {
  const cli = join(root, dir)
  const started = Date.now() - 1000
  for (const script of ['scripts/build.ts', 'scripts/bundle-doctrine.ts']) {
    const run = spawnSync(process.execPath, [script], { cwd: cli, encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`package-compat: ${dir}/${script} failed:\n${run.stderr}${run.stdout}`)
  }
  const listed = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: cli,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const name = readManifest(join(cli, 'package.json')).name ?? ''
  const skipped = Object.keys(UNRECORDED_PREFIXES[name] ?? {})
  const target = join(stage, 'command-line')
  for (const { path } of (JSON.parse(listed) as { files: { path: string }[] }[])[0]?.files ?? []) {
    if (skipped.some((prefix) => path.startsWith(prefix))) continue
    const source = join(cli, path)
    if (path.startsWith('dist/') && statSync(source).mtimeMs < started) continue
    mkdirSync(dirname(join(target, path)), { recursive: true })
    cpSync(source, join(target, path))
  }
  return npmPack(target, dest)
}

/** One package's tarball, packed the way its kind ships. */
export function packPackage(
  root: string,
  pkg: PublishedPackage,
  scratch: string,
  internalModules: readonly InternalModule[] = []
): string {
  const dest = join(scratch, 'tarballs')
  if (pkg.assembled)
    return assemblePack({ root, packageDir: pkg.dir, staging: mkdtempIn(scratch, 'assemble-'), dest, internalModules })
      .tarball
  if (existsSync(join(root, pkg.dir, 'scripts', 'build.ts')))
    return packCommandLine(root, pkg.dir, mkdtempIn(scratch, 'stage-'), dest)
  return npmPack(join(root, pkg.dir), dest)
}

// ── The scratch install ─────────────────────────────────────────────────────

/** The version of a dev type package the repository installed, so the consumer types against the same one. */
function installedVersion(root: string, name: string): string {
  return readManifest(join(root, 'node_modules', name, 'package.json')).version ?? 'latest'
}

/**
 * Installs the tarballs into `installDir` (outside the repository) with Bun.
 * Every `@attalabs/` package resolves from its local tarball — a direct
 * dependency and an override, so a package depending on another at its
 * published version gets the local tarball too — and the lockfile is read
 * back: an `@attalabs/` entry resolved from anywhere else throws.
 */
export function installTarballs(root: string, installDir: string, tarballs: Record<string, string>): void {
  assertOutside(root, installDir)
  mkdirSync(installDir, { recursive: true })
  const local = Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]))
  writeFileSync(
    join(installDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'package-compat-consumer',
        private: true,
        type: 'module',
        dependencies: local,
        devDependencies: { '@types/bun': installedVersion(root, '@types/bun') },
        overrides: local
      },
      null,
      2
    )}\n`
  )
  // The caller's environment, for the install cache and any network proxy, minus a module search path.
  const { NODE_PATH: _searchPath, ...env } = process.env
  const run = spawnSync('bun', ['install', '--silent'], { cwd: installDir, encoding: 'utf8', env })
  if (run.status !== 0) throw new Error(`package-compat: bun install failed in ${installDir}:\n${run.stderr}`)
  const lock = readFileSync(join(installDir, 'bun.lock'), 'utf8')
  const tarballDirs = new Set(Object.values(tarballs).map((path) => dirname(path)))
  const resolved = new Map<string, string>()
  for (const match of lock.matchAll(/"(@attalabs\/[^"]+)": \["(@attalabs\/[^@"]+)@([^"]*)"/g))
    resolved.set(match[1] as string, match[3] as string)
  for (const name of Object.keys(tarballs)) {
    const from = resolved.get(name)
    if (from === undefined || ![...tarballDirs].some((dir) => from.startsWith(`${dir}/`)))
      throw new Error(`package-compat: ${name} resolved from ${from ?? 'nowhere'}, not its local tarball`)
  }
  for (const [name, from] of resolved)
    if (!(name in tarballs)) throw new Error(`package-compat: the install resolved ${name} from ${from}, not a tarball`)
}

/** A minimal environment for importing in the scratch folder: its own home, no repository path in it. */
function scratchEnv(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, '.home')
  mkdirSync(home, { recursive: true })
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: tmpdir() }
}

export function assertOutside(root: string, dir: string): void {
  mkdirSync(dir, { recursive: true })
  const real = realpathSync(dir)
  if (real === root || real.startsWith(`${root}${sep}`))
    throw new Error(`package-compat: ${dir} is inside the repository; the scratch install must lie outside it`)
}

// ── Facts ───────────────────────────────────────────────────────────────────

const subpathSpecifier = (name: string, subpath: string): string =>
  subpath === '.' ? name : `${name}${subpath.slice(1)}`

/** The compiler options a consumer typechecks with: the repository's shared base configuration, as a consumer would. */
function consumerOptions(): ts.CompilerOptions {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    esModuleInterop: true,
    isolatedModules: true,
    noUncheckedIndexedAccess: true,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    types: ['bun']
  }
}

function hostIn(dir: string, options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true)
  host.getCurrentDirectory = () => dir
  return host
}

const tsLibDir = realpathSync(dirname(ts.getDefaultLibFilePath({})))

/** Every program file outside the scratch folder and the compiler's own library. */
function filesOutside(program: ts.Program, scratch: string): string[] {
  return program
    .getSourceFiles()
    .map((file) => realpathSync(file.fileName))
    .filter((file) => !file.startsWith(`${scratch}${sep}`) && !file.startsWith(`${tsLibDir}${sep}`))
}

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    if (!d.file || d.start === undefined) return message
    const { line } = d.file.getLineAndCharacterOfPosition(d.start)
    return `${d.file.fileName}:${line + 1}: ${message}`
  })
}

/**
 * A normalized declaration longer than this is recorded as its digest: an
 * inferred schema type runs to hundreds of kilobytes, and its digest changes
 * exactly when its text does.
 */
export const VERBATIM_LIMIT = 1000

/** The recorded form of a normalized declaration: itself, or `sha256:<hex>` when longer than {@link VERBATIM_LIMIT}. */
export function recordedDeclaration(text: string): string {
  return text.length <= VERBATIM_LIMIT ? text : `sha256:${createHash('sha256').update(text).digest('hex')}`
}

/** A declaration's text with its export modifiers, whitespace and file-relative import types normalized. */
export function normalizeDeclaration(text: string, scratch: string): string {
  return text
    .split(scratch)
    .join('<scratch>')
    .replace(/import\((["'])\.{1,2}\/[^"']*\1\)/g, 'import(<module>)')
    .replace(/\s+/g, ' ')
    .replace(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?/, '')
    .trim()
}

function declarationText(decl: ts.Declaration, checker: ts.TypeChecker, declRoot: string, scratch: string): string {
  const file = decl.getSourceFile()
  const path = realpathSync(file.fileName)
  if (!path.startsWith(`${declRoot}${sep}`)) {
    const tail = path.split(`${sep}node_modules${sep}`).at(-1) ?? path
    const parts = tail.split(sep)
    const pkg = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] ?? tail)
    return `from ${pkg}`
  }
  if (ts.isSourceFile(decl)) {
    const symbol = checker.getSymbolAtLocation(decl)
    const names = symbol ? checker.getExportsOfModule(symbol).map((s) => s.name) : []
    return `namespace { ${[...names].sort().join(', ')} }`
  }
  if (ts.isVariableDeclaration(decl)) {
    const flags = decl.parent.flags
    const keyword = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var'
    return normalizeDeclaration(`${keyword} ${decl.getText(file)}`, scratch)
  }
  return normalizeDeclaration(decl.getText(file), scratch)
}

/**
 * The declarations a consumer sees for each subpath of one installed package:
 * the package copied out of `node_modules` (the compiler emits no file there),
 * its declarations emitted, and each exported symbol printed from the emitted
 * files with every alias followed to its target.
 */
function declarationFacts(
  installDir: string,
  name: string,
  exportsMap: Record<string, string>
): { symbols: Record<string, Record<string, string[]>>; problems: string[]; outside: string[] } {
  const scratch = realpathSync(installDir)
  const emitRoot = join(scratch, '.emit', name)
  const declRoot = join(scratch, '.decl', name)
  rmSync(emitRoot, { recursive: true, force: true })
  rmSync(declRoot, { recursive: true, force: true })
  cpSync(join(scratch, 'node_modules', name), emitRoot, { recursive: true, dereference: true })
  mkdirSync(declRoot, { recursive: true })
  const entries = Object.entries(exportsMap)
  const options: ts.CompilerOptions = {
    ...consumerOptions(),
    declaration: true,
    emitDeclarationOnly: true,
    removeComments: true,
    rootDir: emitRoot,
    outDir: declRoot
  }
  const program = ts.createProgram(
    entries.map(([, file]) => join(emitRoot, file)),
    options,
    hostIn(scratch, options)
  )
  const emitted = program.emit()
  const problems = diagnosticsText(emitted.diagnostics).map((d) => `${name}: declaration emit: ${d}`)
  const outside = filesOutside(program, scratch)

  const declOptions: ts.CompilerOptions = { ...consumerOptions(), noEmit: true }
  const declFile = (file: string) => join(declRoot, file.replace(/^\.\//, '').replace(/\.tsx?$/, '.d.ts'))
  const declProgram = ts.createProgram(
    entries.map(([, file]) => declFile(file)),
    declOptions,
    hostIn(scratch, declOptions)
  )
  outside.push(...filesOutside(declProgram, scratch))
  const checker = declProgram.getTypeChecker()
  const realDeclRoot = realpathSync(declRoot)
  const symbols: Record<string, Record<string, string[]>> = {}
  for (const [subpath, file] of entries) {
    const source = declProgram.getSourceFile(declFile(file))
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined
    if (!source || !moduleSymbol) {
      problems.push(`${name} ${subpath}: no emitted declaration file for ${file}`)
      continue
    }
    const out: Record<string, string[]> = {}
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      const texts = (target.declarations ?? []).map((d) =>
        recordedDeclaration(declarationText(d, checker, realDeclRoot, scratch))
      )
      out[exported.name] = [...new Set(texts)].sort()
    }
    symbols[subpath] = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
  return { symbols, problems, outside }
}

/** What a Bun import of each specifier returns, and every file the import loaded. */
function runtimeFacts(
  installDir: string,
  specifiers: string[]
): { exports: Record<string, string[]>; loaded: string[] } {
  const script = join(installDir, '.compat-import.ts')
  writeFileSync(
    script,
    [
      'const specifiers: string[] = JSON.parse(process.argv[2] ?? "[]")',
      'const exports: Record<string, string[]> = {}',
      'for (const specifier of specifiers) exports[specifier] = Object.keys(await import(specifier)).sort()',
      'console.log(JSON.stringify({ exports, loaded: Object.keys(require.cache) }))',
      ''
    ].join('\n')
  )
  const run = spawnSync('bun', [script, JSON.stringify(specifiers)], {
    cwd: installDir,
    encoding: 'utf8',
    env: scratchEnv(installDir)
  })
  if (run.status !== 0) throw new Error(`package-compat: importing under Bun failed:\n${run.stderr}`)
  const line = run.stdout.trim().split('\n').at(-1) ?? '{}'
  return JSON.parse(line) as { exports: Record<string, string[]>; loaded: string[] }
}

/** A consumer file importing every subpath, typechecked against the install. */
function consumerTypecheck(installDir: string, specifiers: string[]): { problems: string[]; outside: string[] } {
  const scratch = realpathSync(installDir)
  const consumer = join(scratch, 'consumer.ts')
  writeFileSync(
    consumer,
    `${specifiers.map((s, i) => `import * as surface${i} from '${s}'`).join('\n')}\n` +
      `export const surfaces = [${specifiers.map((_, i) => `surface${i}`).join(', ')}]\n`
  )
  const options = { ...consumerOptions(), noEmit: true }
  const program = ts.createProgram([consumer], options, hostIn(scratch, options))
  return {
    problems: diagnosticsText(ts.getPreEmitDiagnostics(program)).map((d) => `consumer typecheck: ${d}`),
    outside: filesOutside(program, scratch)
  }
}

export type InstalledFacts = {
  facts: Record<string, PackageFacts>
  /** Typecheck, emit or isolation problems: each one fails the check. */
  problems: string[]
}

/** The facts of each named package, read from the scratch install at `installDir`. */
export function installedFacts(installDir: string, tarballs: Record<string, string>): InstalledFacts {
  const scratch = realpathSync(installDir)
  const facts: Record<string, PackageFacts> = {}
  const problems: string[] = []
  const specifiers: string[] = []
  const manifests: Record<string, Manifest> = {}
  for (const name of Object.keys(tarballs)) {
    manifests[name] = readManifest(join(scratch, 'node_modules', name, 'package.json'))
    for (const subpath of Object.keys(manifests[name]?.exports ?? {})) specifiers.push(subpathSpecifier(name, subpath))
  }
  const runtime = runtimeFacts(scratch, specifiers)
  for (const loaded of runtime.loaded)
    if (loaded.startsWith('/') && !realpathSync(loaded).startsWith(`${scratch}${sep}`))
      problems.push(`the Bun import loaded ${loaded}, outside the scratch install`)
  const consumer = consumerTypecheck(scratch, specifiers)
  problems.push(...consumer.problems)
  const outside = [...consumer.outside]
  for (const [name, tarball] of Object.entries(tarballs)) {
    const manifest = manifests[name] as Manifest
    const exportsMap = manifest.exports ?? {}
    const declared = Object.keys(exportsMap).length > 0 ? declarationFacts(scratch, name, exportsMap) : null
    if (declared) {
      problems.push(...declared.problems)
      outside.push(...declared.outside)
    }
    const subpaths: Record<string, SubpathFacts> = {}
    for (const subpath of Object.keys(exportsMap).sort()) {
      const declarations = declared?.symbols[subpath] ?? {}
      subpaths[subpath] = {
        symbols: Object.keys(declarations),
        runtimeExports: runtime.exports[subpathSpecifier(name, subpath)] ?? [],
        declarations
      }
    }
    const skipped = Object.keys(UNRECORDED_PREFIXES[name] ?? {})
    facts[name] = {
      ...(manifest.bin ? { bin: manifest.bin } : {}),
      subpaths,
      files: tarballFiles(tarball).filter((path) => !skipped.some((prefix) => path.startsWith(prefix)))
    }
  }
  for (const file of [...new Set(outside)].sort())
    problems.push(`a TypeScript program loaded ${file}, outside the scratch install`)
  return { facts, problems }
}

// ── Comparison ──────────────────────────────────────────────────────────────

const missingFrom = (a: readonly string[], b: readonly string[]): string[] => a.filter((x) => !b.includes(x))

/**
 * Every difference between the snapshot and the facts, each naming the
 * package, the subpath and the difference. A tarball file the snapshot does
 * not record, or a recorded one the tarball lacks, is a difference unless the
 * package's internal-module allowlist (`allow`, the snapshot's own by default)
 * names it.
 */
export function compareFacts(
  snapshot: Snapshot,
  facts: Record<string, PackageFacts>,
  allow: (name: string) => readonly InternalModule[] = (name) => snapshot.packages[name]?.internalModules ?? []
): string[] {
  const out: string[] = []
  for (const name of Object.keys(facts)) {
    const expected = snapshot.packages[name]
    const actual = facts[name] as PackageFacts
    if (!expected) {
      out.push(`${name}: not in the snapshot`)
      continue
    }
    if (JSON.stringify(expected.bin ?? null) !== JSON.stringify(actual.bin ?? null))
      out.push(
        `${name}: bin map differs — snapshot ${JSON.stringify(expected.bin ?? null)}, tarball ${JSON.stringify(actual.bin ?? null)}`
      )
    for (const subpath of missingFrom(Object.keys(expected.subpaths), Object.keys(actual.subpaths)))
      out.push(`${name} ${subpath}: subpath in the snapshot is missing from the exports map`)
    for (const subpath of missingFrom(Object.keys(actual.subpaths), Object.keys(expected.subpaths)))
      out.push(`${name} ${subpath}: subpath in the exports map is not in the snapshot`)
    for (const [subpath, want] of Object.entries(expected.subpaths)) {
      const got = actual.subpaths[subpath]
      if (!got) continue
      for (const s of missingFrom(want.symbols, got.symbols))
        out.push(`${name} ${subpath}: symbol ${s} is no longer exported`)
      for (const s of missingFrom(got.symbols, want.symbols))
        out.push(`${name} ${subpath}: symbol ${s} is exported but not in the snapshot`)
      for (const s of missingFrom(want.runtimeExports, got.runtimeExports))
        out.push(`${name} ${subpath}: runtime export ${s} is missing from the Bun import`)
      for (const s of missingFrom(got.runtimeExports, want.runtimeExports))
        out.push(`${name} ${subpath}: runtime export ${s} is in the Bun import but not in the snapshot`)
      for (const [symbol, decls] of Object.entries(want.declarations)) {
        const gotDecls = got.declarations[symbol]
        if (gotDecls && JSON.stringify(gotDecls) !== JSON.stringify(decls))
          out.push(
            `${name} ${subpath}: declaration of ${symbol} differs — snapshot ${JSON.stringify(decls)}, tarball ${JSON.stringify(gotDecls)}`
          )
      }
    }
    const allowed = new Set(allow(name).map((m) => m.path))
    for (const file of missingFrom(actual.files, expected.files))
      if (!allowed.has(file))
        out.push(`${name}: tarball file ${file} is not in the snapshot and no internal-module entry allows it`)
    for (const file of missingFrom(expected.files, actual.files))
      if (!allowed.has(file))
        out.push(`${name}: snapshot file ${file} is missing from the tarball and no internal-module entry allows it`)
  }
  return out
}

/** Allowlist entries a package may not hold: a subpath entry is public, never an internal module. */
export function allowlistProblems(snapshot: Snapshot): string[] {
  const out: string[] = []
  for (const [name, pkg] of Object.entries(snapshot.packages)) {
    const manifest = readManifest(join(REPO_ROOT, pkg.dir, 'package.json'))
    const entries = new Set(Object.values(manifest.exports ?? {}).map((p) => p.replace(/^\.\//, '')))
    for (const module of pkg.internalModules) {
      if (entries.has(module.path)) out.push(`${name}: internal module ${module.path} is a subpath entry`)
      if (!module.reason?.trim()) out.push(`${name}: internal module ${module.path} carries no reason`)
    }
  }
  return out
}

// ── One whole run ───────────────────────────────────────────────────────────

export type CompatRun = InstalledFacts & { tarballs: Record<string, string>; installDir: string }

/** Packs every published package into `scratch`, installs the tarballs there and reads their facts. */
export function runCompat(scratch: string, root: string = REPO_ROOT, snapshot?: Snapshot): CompatRun {
  assertOutside(root, scratch)
  const tarballs: Record<string, string> = {}
  for (const pkg of publishedPackages(root))
    tarballs[pkg.name] = packPackage(root, pkg, scratch, snapshot?.packages[pkg.name]?.internalModules ?? [])
  const installDir = join(scratch, 'install')
  installTarballs(root, installDir, tarballs)
  return { ...installedFacts(installDir, tarballs), tarballs, installDir }
}

/** Today's facts as a snapshot, keeping each package's allowlist from `previous`. */
export function snapshotOf(run: CompatRun, previous: Snapshot | null, root: string = REPO_ROOT): Snapshot {
  const packages: Record<string, PackageSnapshot> = {}
  for (const pkg of publishedPackages(root)) {
    const facts = run.facts[pkg.name] as PackageFacts
    packages[pkg.name] = {
      dir: pkg.dir,
      assembled: pkg.assembled,
      internalModules: previous?.packages[pkg.name]?.internalModules ?? [],
      ...facts
    }
  }
  return { schema: SNAPSHOT_SCHEMA, schemaVersion: 1, packages }
}

if (import.meta.main) {
  const scratch = mkdtempSync(join(tmpdir(), 'package-compat-'))
  try {
    const previous = existsSync(join(REPO_ROOT, SNAPSHOT_PATH)) ? readSnapshot() : null
    const run = runCompat(scratch, REPO_ROOT, previous ?? undefined)
    if (run.problems.length > 0) {
      process.stderr.write(`${run.problems.join('\n')}\n`)
      process.exitCode = 1
    } else if (process.argv.includes('--write')) {
      writeFileSync(join(REPO_ROOT, SNAPSHOT_PATH), serializeSnapshot(snapshotOf(run, previous)))
      process.stdout.write(`package-compat: wrote ${SNAPSHOT_PATH}\n`)
    } else {
      const differences = previous ? compareFacts(previous, run.facts) : ['no snapshot committed']
      process.stdout.write(
        differences.length === 0
          ? 'package-compat: every package matches the snapshot\n'
          : `${differences.join('\n')}\n`
      )
      if (differences.length > 0) process.exitCode = 1
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
