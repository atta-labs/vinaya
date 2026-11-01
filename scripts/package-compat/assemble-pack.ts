#!/usr/bin/env bun
/**
 * The assemble step: packs `@attalabs/aeg-core`, `@attalabs/aeg-forge-state`
 * or `@attalabs/aeg-types` from wherever the modules its entries reach live.
 *
 * These three packages ship TypeScript source under their `exports` subpaths.
 * In the workspace a module a package entry reaches may live outside the
 * package — the entry, or a file it imports, re-exports it from its owner —
 * while a consumer must still receive every reached module inside the
 * package's own `src` tree. So the step:
 *
 * 1. copies the package folder to a staging folder, `node_modules` and build
 *    output left out — every non-TypeScript asset (readme, licence, changelog,
 *    manifest, JSON data) comes along unchanged;
 * 2. walks the modules the manifest's entries reach, through every relative
 *    `import`, `export … from`, `import()` and `import type`;
 * 3. places each reached module at its module path in the package: a module
 *    inside the package's `src` keeps its own path, a module outside it takes
 *    the path its internal-module entry in the snapshot
 *    (`scripts/package-compat/snapshot.json`) records — an outside module no
 *    entry records is refused, as is a module path a package file already holds;
 * 4. rewrites only relative import specifiers, and only those whose target's
 *    place changed, so on a tree where nothing has left a package the staged
 *    copy is byte-for-byte the package;
 * 5. runs `npm pack`, lifecycle scripts off, in the staging folder.
 *
 * It reads workspace files and writes only under the staging folder and the
 * destination. Today no module has left a package, so no pack lifecycle runs
 * it; the first change that moves a module out of one of these packages wires
 * it into that package's pack lifecycle.
 *
 * `bun scripts/package-compat/assemble-pack.ts <package folder> <destination>`
 */
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

/** The packages this step assembles; the command-line and source packages are packed as they are. */
export const ASSEMBLED_PACKAGES: ReadonlySet<string> = new Set([
  '@attalabs/aeg-core',
  '@attalabs/aeg-forge-state',
  '@attalabs/aeg-types'
])

/** One reviewed internal module: where it ships in the tarball, and the repository file it comes from. */
export type InternalModule = {
  /** Package-relative module path in the tarball, under `src/`. */
  path: string
  /** Repository-relative authoritative file. */
  source: string
  reason: string
}

export type AssembleOptions = {
  /** The repository (or a staging copy of it) the package folder is read from. */
  root: string
  /** Repository-relative package folder. */
  packageDir: string
  /** A folder the step may write its staged package into. */
  staging: string
  /** Where the tarball is written. */
  dest: string
  internalModules: readonly InternalModule[]
}

export type AssembledModule = {
  /** Package-relative module path. */
  path: string
  /** Repository-relative authoritative file. */
  source: string
  /** Whether any specifier in it was rewritten. */
  rewritten: boolean
}

export type AssembleResult = { tarball: string; stagedDir: string; modules: AssembledModule[] }

const SKIPPED = new Set(['node_modules', 'dist', '.turbo', 'coverage'])
const MODULE_FILE = /\.(?:ts|tsx|mts|cts|json)$/

type Specifier = { text: string; start: number; end: number }

/** Every module specifier of a source file: imports, `export … from`, `import()`, `import type` and `require`. */
export function moduleSpecifiers(path: string, text: string): Specifier[] {
  if (path.endsWith('.json')) return []
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: Specifier[] = []
  const push = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node))
      out.push({ text: node.text, start: node.getStart(file) + 1, end: node.getEnd() - 1 })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) push(node.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      push(node.moduleReference.expression)
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) push(node.argument.literal)
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      push(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out.sort((a, b) => a.start - b.start)
}

/** The file a relative specifier names from `importer`, or `null`. */
export function resolveRelative(importer: string, specifier: string): string | null {
  const base = resolve(dirname(importer), specifier)
  const candidates = [
    base,
    base.replace(/\.(m|c)?js$/, '.$1ts'),
    base.replace(/\.jsx$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx')
  ]
  for (const candidate of candidates)
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate)
  return null
}

const toPosix = (path: string): string => path.split(sep).join('/')

/** A relative specifier from module path `from` to module path `to`, in the original specifier's extension style. */
function specifierBetween(from: string, to: string, original: string): string {
  let target = posix.relative(posix.dirname(from), to)
  if (!target.startsWith('.')) target = `./${target}`
  if (/\.(?:ts|tsx|mts|cts|json)$/.test(original)) return target
  if (/\.(?:m|c)?jsx?$/.test(original)) return target.replace(/\.(m|c)?ts(x?)$/, '.$1js$2')
  return target.replace(/\.(?:ts|tsx)$/, '').replace(/\/index$/, '')
}

const builtins = new Set(builtinModules)
const packageOf = (specifier: string): string =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? specifier)

/** Assembles and packs one package; see the file comment. */
export function assemblePack(options: AssembleOptions): AssembleResult {
  const root = realpathSync(options.root)
  const packageRoot = realpathSync(join(root, options.packageDir))
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    name?: string
    main?: string
    types?: string
    exports?: Record<string, string>
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  const name = manifest.name ?? options.packageDir
  if (!ASSEMBLED_PACKAGES.has(name))
    throw new Error(`assemble: ${name} is not one of ${[...ASSEMBLED_PACKAGES].join(', ')}; it is packed as it is`)
  const srcRoot = join(packageRoot, 'src')
  const fail = (detail: string): never => {
    throw new Error(`assemble: ${name}: ${detail}`)
  }

  // Each reached module's place in the package.
  const bySource = new Map(options.internalModules.map((m) => [toPosix(m.source), m]))
  const placeOf = (file: string): string => {
    if (file.startsWith(`${srcRoot}${sep}`)) return toPosix(relative(packageRoot, file))
    const repoPath = toPosix(relative(root, file))
    const entry = bySource.get(repoPath)
    if (!entry)
      return fail(
        `it reaches ${repoPath}, outside the package's src, and no internal-module entry records its module path`
      )
    if (!entry.path.startsWith('src/')) return fail(`internal module ${entry.path} is not under src/`)
    return entry.path
  }

  const entries = [...new Set([...Object.values(manifest.exports ?? {}), manifest.main, manifest.types])].filter(
    (p): p is string => typeof p === 'string'
  )
  const reached = new Map<string, string>()
  const queue: string[] = []
  for (const entry of entries) {
    const file = join(packageRoot, entry)
    if (!existsSync(file)) fail(`entry ${entry} does not exist`)
    queue.push(realpathSync(file))
  }
  const sources = new Map<string, string>()
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (reached.has(file)) continue
    reached.set(file, placeOf(file))
    const text = readFileSync(file, 'utf8')
    sources.set(file, text)
    for (const specifier of moduleSpecifiers(file, text)) {
      if (!specifier.text.startsWith('.')) continue
      const target = resolveRelative(file, specifier.text)
      if (target === null) fail(`${toPosix(relative(root, file))} imports ${specifier.text}, which resolves to no file`)
      else if (MODULE_FILE.test(target)) queue.push(target)
    }
  }

  // Two different files may not share a module path.
  const holders = new Map<string, string>()
  for (const [file, place] of reached) {
    const other = holders.get(place)
    if (other && other !== file)
      fail(`${toPosix(relative(root, file))} and ${toPosix(relative(root, other))} both ship as ${place}`)
    holders.set(place, file)
    if (!file.startsWith(`${srcRoot}${sep}`) && existsSync(join(packageRoot, place)))
      fail(`internal module ${place} would overwrite the package's own file`)
  }

  // An outside module may import only what the package itself depends on.
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {})
  ])
  for (const [file, text] of sources) {
    if (file.startsWith(`${srcRoot}${sep}`)) continue
    for (const specifier of moduleSpecifiers(file, text)) {
      if (specifier.text.startsWith('.')) continue
      const bare = specifier.text.replace(/^node:/, '')
      if (specifier.text.startsWith('node:') || builtins.has(bare) || builtins.has(packageOf(bare))) continue
      if (!declared.has(packageOf(specifier.text)))
        fail(`${toPosix(relative(root, file))} imports ${specifier.text}, which ${name} does not depend on`)
    }
  }

  // Stage the package, then place and rewrite the reached modules.
  mkdirSync(options.staging, { recursive: true })
  const stagedDir = join(options.staging, packageRoot.split(sep).at(-1) ?? 'package')
  cpSync(packageRoot, stagedDir, {
    recursive: true,
    filter: (path) => !SKIPPED.has(path.split(sep).at(-1) ?? '')
  })
  const modules: AssembledModule[] = []
  for (const [file, place] of [...reached].sort(([, a], [, b]) => (a < b ? -1 : 1))) {
    const text = sources.get(file) as string
    const moved = !file.startsWith(`${srcRoot}${sep}`)
    let out = ''
    let last = 0
    for (const specifier of moduleSpecifiers(file, text)) {
      if (!specifier.text.startsWith('.')) continue
      const target = resolveRelative(file, specifier.text) as string
      const targetPlace = reached.get(target)
      if (targetPlace === undefined) continue
      const targetMoved = !target.startsWith(`${srcRoot}${sep}`)
      if (!moved && !targetMoved) continue
      out += text.slice(last, specifier.start) + specifierBetween(place, targetPlace, specifier.text)
      last = specifier.end
    }
    const rewritten = last > 0
    if (moved || rewritten) {
      const destination = join(stagedDir, place)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, rewritten ? out + text.slice(last) : text)
    }
    modules.push({ path: place, source: toPosix(relative(root, file)), rewritten })
  }

  mkdirSync(options.dest, { recursive: true })
  const packed = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', options.dest], {
    cwd: stagedDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const filename = (JSON.parse(packed) as { filename: string }[])[0]?.filename
  if (!filename) fail('npm pack reported no tarball')
  return { tarball: join(options.dest, filename as string), stagedDir, modules }
}

if (import.meta.main) {
  const [packageDir, dest] = process.argv.slice(2)
  if (!packageDir || !dest) {
    process.stderr.write('usage: bun scripts/package-compat/assemble-pack.ts <package folder> <destination>\n')
    process.exit(2)
  }
  const root = realpathSync(join(import.meta.dir, '..', '..'))
  const snapshot = JSON.parse(readFileSync(join(import.meta.dir, 'snapshot.json'), 'utf8')) as {
    packages: Record<string, { dir: string; internalModules: InternalModule[] }>
  }
  const dir = toPosix(relative(root, resolve(packageDir)))
  const internalModules = Object.values(snapshot.packages).find((p) => p.dir === dir)?.internalModules ?? []
  const result = assemblePack({
    root,
    packageDir: dir,
    staging: mkdtempSync(join(tmpdir(), 'assemble-pack-')),
    dest: resolve(dest),
    internalModules
  })
  process.stdout.write(`${result.tarball}\n`)
}
