/**
 * The selection library's import/export graph, resolved by the TypeScript
 * compiler rather than by reading source text with regular expressions.
 *
 * ## Why the compiler and not a text scan
 *
 * A text scan can see that a file writes `from './demo.js'`; it cannot know
 * that `./demo.js` IS `./demo.ts`, that `{ foo }` imported from a package
 * barrel is DEFINED three re-export hops away in another package, or that a
 * name arrives through an `export *`. Every one of those is a real edge, and a
 * scan that cannot follow it does not over-select — it drops the edge and
 * SILENTLY under-selects, which is the one failure mode a push-time selector
 * must never have. `ts.resolveModuleName` answers the first question the way
 * the runtime does, and the checker's alias chain
 * ({@link ts.TypeChecker.getImmediateAliasedSymbol}) answers the rest by
 * walking the exact symbol table the compiler itself uses.
 *
 * ## How the compiler gets here without becoming a shipped dependency
 *
 * `typescript` is a development dependency of this package, not a runtime one,
 * and a bundler inlines anything that is not a declared runtime dependency — so a static `import ts from 'typescript'` would either
 * add the whole compiler to every published artifact or add it to every
 * adopter's install. {@link loadTypeScript} instead resolves `typescript` from
 * the repository being analyzed (and, failing that, from wherever this file
 * itself is installed), through `createRequire` — a runtime resolution no
 * bundler can inline, so package size and install footprint are unchanged. A
 * repository with no `typescript` installed gets `null` and the caller's own
 * text-scan graph, which is never worse than what shipped before this.
 *
 * ## Reading a revision rather than the disk
 *
 * {@link GraphInput.host} is the one seam between the graph and the files it
 * reads. Absent, the compiler reads the disk exactly as it always has. Given,
 * every repository file the program and the module resolver touch is read
 * through it — a committed revision's tree, never the checkout around it — and
 * only the compiler's own bundled library declarations still come from the
 * compiler's installation, which is tooling, not repository content.
 *
 * ## The edge vocabulary
 *
 * Edges are emitted as opaque node keys the selector walks; their grammar is
 * documented on the selector's own `NodeKey` doc (`selector.ts`), since the
 * selector is what interprets them. What matters here is the discipline: a shape the compiler
 * resolves precisely becomes name-level edges, and every shape it cannot —
 * a namespace import, a default import, `export *`, a side-effect import, a
 * dynamic specifier, a name whose alias chain does not terminate, or a module
 * it cannot resolve at all — becomes the coarse whole-module (relative) or
 * whole-package (bare) edge. Over-select, never omit.
 */
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

export type TypeScriptApi = typeof import('typescript')

/**
 * The TypeScript compiler, resolved at runtime from `repoRoot` first (the
 * repository under analysis almost always has its own), then from this file's
 * own installation. `null` when neither has it — the caller's signal to fall
 * back to its text-scan graph rather than to fail a push.
 */
export function loadTypeScript(repoRoot: string): TypeScriptApi | null {
  return loadTypeScriptFrom([join(repoRoot, 'package.json'), import.meta.url])
}

/**
 * The TypeScript compiler, resolved from this library's own installation only
 * — what a selection over committed revisions uses, since the repository it
 * reads is a snapshot with no installation of its own. `null` when none.
 */
export function loadLibraryTypeScript(): TypeScriptApi | null {
  return loadTypeScriptFrom([import.meta.url])
}

function loadTypeScriptFrom(anchors: readonly string[]): TypeScriptApi | null {
  for (const from of anchors) {
    try {
      const loaded = createRequire(from)('typescript') as Partial<TypeScriptApi> | undefined
      // Shape-checked, not merely caught: a resolution from an anchor with no
      // `node_modules` of its own does not always throw — found live, it can
      // hand back a partially-populated module whose first property access
      // throws instead, which would fail a push rather than fall back.
      if (loaded && typeof loaded.createProgram === 'function' && loaded.ScriptTarget) return loaded as TypeScriptApi
    } catch {
      // Not resolvable from this anchor — try the next one.
    }
  }
  return null
}

/** Node-key prefixes. Mirrored by the selector's walker; see its `NodeKey` doc for what each means. */
export const ALL_PREFIX = 'all:'
export const OWN_PREFIX = 'own:'
export const TOUCH_PREFIX = 'touch:'
export const NAME_PREFIX = 'name:'
export const EXTERNAL_PREFIX = 'external:'
export const PKGMETA_PREFIX = 'pkgmeta:'
export const SCAN_PREFIX = 'scan:'
/** Separates a file from the exported name inside a `name:` key. `#` cannot occur in a bare identifier, so the split is unambiguous. */
export const NAME_SEPARATOR = '#'

/**
 * A read-only view of the files under one root, for the compiler: every path
 * is absolute. A path the view does not hold does not exist.
 */
export type SourceHost = {
  fileExists(path: string): boolean
  readFile(path: string): string | undefined
  directoryExists(path: string): boolean
  getDirectories(path: string): string[]
}

export type GraphInput = {
  repoRoot: string
  /**
   * Where the compiler reads repository files from. Absent, the disk under
   * `repoRoot`; given, this view alone — see "Reading a revision rather than
   * the disk" above.
   */
  host?: SourceHost
  /** Every workspace source file, absolute — the compiler program's roots and the membership test for "is this edge a workspace file". */
  files: readonly string[]
  /** The workspace package that owns an absolute file, by package name; `null` for a file in none. */
  packageOfFile: (file: string) => string | null
  /** The workspace package a BARE specifier names, or `null` for a third-party specifier. */
  packageOfBareSpecifier: (specifier: string) => string | null
  /**
   * Bare workspace specifier (`@scope/pkg`, `@scope/pkg/sub`) → the absolute
   * source file its own manifest's `exports`/`main` names, handed to the
   * compiler as `paths` so it resolves a workspace specifier from the
   * MANIFEST rather than from whatever an installer happened to link into
   * `node_modules`. Without this the graph's answer would depend on the
   * install layout (hoisted, isolated, or absent), which is not a property of
   * the code being analyzed.
   */
  entrypoints: ReadonlyMap<string, string>
}

export type CompilerGraph = {
  /** Node key → the node keys it depends on. */
  edges: Map<string, string[]>
  /** Milliseconds spent building the compiler program, separate from graph construction — the dominant cost, and the one worth reporting on its own. */
  programMs: number
}

/** The compiler options the graph resolves under: bundler resolution (what Bun and every modern bundler do), workspace specifiers mapped from their own manifests, types off, no emit — resolution only, never a type-check. */
function graphCompilerOptions(ts: TypeScriptApi, input: GraphInput): import('typescript').CompilerOptions {
  const paths: Record<string, string[]> = {}
  for (const [specifier, entry] of input.entrypoints) paths[specifier] = [entry]
  return {
    baseUrl: input.repoRoot,
    paths,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    allowJs: true,
    noEmit: true,
    skipLibCheck: true,
    // No ambient type packages: the graph never type-checks, and loading
    // `@types/*` is pure cost at push time.
    types: [],
    resolveJsonModule: true
  }
}

/**
 * A compiler host that reads repository files only through `view`. The
 * compiler's bundled library declarations (`lib.*.d.ts`) are the one read left
 * to the compiler's own installation; nothing else on disk is visible, so a
 * file the view does not hold does not exist for the program or the resolver.
 */
function viewCompilerHost(
  ts: TypeScriptApi,
  options: import('typescript').CompilerOptions,
  root: string,
  view: SourceHost
): import('typescript').CompilerHost {
  const base = ts.createCompilerHost(options)
  const libDir = dirname(ts.getDefaultLibFilePath(options))
  const isLib = (path: string): boolean => path.startsWith(`${libDir}/`)
  return {
    ...base,
    getCurrentDirectory: () => root,
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    realpath: (path) => path,
    fileExists: (path) => (isLib(path) ? base.fileExists(path) : view.fileExists(path)),
    readFile: (path) => (isLib(path) ? base.readFile(path) : view.readFile(path)),
    directoryExists: (path) => (isLib(path) ? true : view.directoryExists(path)),
    getDirectories: (path) => (isLib(path) ? [] : view.getDirectories(path)),
    getSourceFile: (fileName, languageVersion) => {
      if (isLib(fileName)) return base.getSourceFile(fileName, languageVersion)
      const text = view.readFile(fileName)
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion)
    }
  }
}

/**
 * Builds the whole workspace's import/export graph through the compiler.
 *
 * One program over every workspace source file, one checker, then one AST pass
 * per file emitting edges. The program build dominates; the AST pass is linear
 * and resolves each module specifier once per file.
 */
export function buildCompilerGraph(ts: TypeScriptApi, input: GraphInput): CompilerGraph {
  const { files, packageOfFile, packageOfBareSpecifier } = input
  const fileSet = new Set(files)
  const options = graphCompilerOptions(ts, input)

  const host = input.host ? viewCompilerHost(ts, options, input.repoRoot, input.host) : ts.createCompilerHost(options)
  const t0 = performance.now()
  const program = input.host ? ts.createProgram([...files], options, host) : ts.createProgram([...files], options)
  const checker = program.getTypeChecker()
  const programMs = performance.now() - t0

  const resolutionCache = new Map<string, string | null>()
  /** A specifier from a containing file to a WORKSPACE source file, or `null` (third-party, a type-only `.d.ts`, or unresolvable). */
  const resolveToWorkspaceFile = (specifier: string, containingFile: string): string | null => {
    const key = `${containingFile}\n${specifier}`
    const cached = resolutionCache.get(key)
    if (cached !== undefined) return cached
    let out: string | null = null
    try {
      const resolved = ts.resolveModuleName(specifier, containingFile, options, host).resolvedModule
      if (resolved && fileSet.has(resolved.resolvedFileName)) out = resolved.resolvedFileName
    } catch {
      out = null
    }
    resolutionCache.set(key, out)
    return out
  }

  /**
   * Whether `name` arrives at module `file` through MORE THAN ONE `export *`
   * source, with no explicit export of its own to settle the tie.
   *
   * This is the one place the compiler is less safe than the coarse answer, and
   * it was found live rather than reasoned about: given `export * from './dupa'`
   * and `export * from './dupb'` both exporting `dup`, the checker's alias chain
   * resolves straight to the FIRST source's declaration, so a change to the
   * second selected nothing. What the runtime does with such a duplicate is a
   * different question again. Two sources means the origin is not proven, so the
   * whole specifier degrades to the coarse edge and both stay selected.
   */
  const starAmbiguityCache = new Map<string, boolean>()
  const isStarAmbiguous = (file: string, name: string, seen: Set<string> = new Set()): boolean => {
    const key = `${file}${NAME_SEPARATOR}${name}`
    const cached = starAmbiguityCache.get(key)
    if (cached !== undefined) return cached
    if (seen.has(key)) return false // a cycle is unresolvable for other reasons; the chain walk goes coarse on it anyway.
    seen.add(key)
    let ambiguous = false
    const sourceFile = program.getSourceFile(file)
    if (sourceFile) {
      const starTargets: string[] = []
      /** The one place this name is explicitly forwarded from, if any — `{ file, name }` at the next module, or `null` for a local declaration. */
      let explicit: { next: string | null; name: string } | undefined
      for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)) continue
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          // An explicit `export { name }` (with or without `from`) wins outright
          // over every star source, so there is no tie left to break here — but
          // the module it forwards to may have one of its own.
          for (const element of statement.exportClause.elements) {
            if (element.name.text !== name) continue
            const spec =
              statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : null
            explicit = {
              next: spec ? resolveToWorkspaceFile(spec, file) : null,
              name: element.propertyName?.text ?? element.name.text
            }
          }
          continue
        }
        // `export * as ns from` introduces a namespace binding, not `name`.
        if (statement.exportClause) continue
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const target = resolveToWorkspaceFile(statement.moduleSpecifier.text, file)
        if (target) starTargets.push(target)
      }
      if (explicit) {
        ambiguous = explicit.next ? isStarAmbiguous(explicit.next, explicit.name, seen) : false
      } else {
        // `getExportsOfModule` on each star source is what says whether that
        // source supplies the name at all, transitively — the compiler's own
        // answer, not a re-derived one. Two suppliers is an unproven origin;
        // exactly one means the question moves to that module.
        const suppliers: string[] = []
        for (const target of starTargets) {
          const targetFile = program.getSourceFile(target)
          const moduleSymbol = targetFile ? checker.getSymbolAtLocation(targetFile) : undefined
          if (!moduleSymbol) continue
          if (checker.getExportsOfModule(moduleSymbol).some((s) => s.name === name)) suppliers.push(target)
        }
        ambiguous =
          suppliers.length > 1 || (suppliers.length === 1 && isStarAmbiguous(suppliers[0] as string, name, seen))
      }
    }
    starAmbiguityCache.set(key, ambiguous)
    return ambiguous
  }

  const edges = new Map<string, string[]>()

  for (const sourceFile of program.getSourceFiles()) {
    const file = sourceFile.fileName
    if (!fileSet.has(file)) continue
    const ownPackage = packageOfFile(file)

    // Two edge lists per file. `moduleScope` is what running this module runs —
    // its `import` statements, side effects and dynamic specifiers. `reexport`
    // is what it merely FORWARDS (`export … from`). A file reached as a
    // re-export hop or as a name's definer contributes only the first: the
    // definition can depend only on what its file imports, never on what its
    // file re-exports for other names, and keeping the two apart is exactly
    // what stops a barrel from fanning out to its whole package.
    const moduleScope: string[] = []
    const reexport: string[] = []

    /**
     * The specifier's target, plus — when a relative specifier's LITERAL path
     * also exists on disk and is not what the compiler chose — a coarse edge to
     * that file too. `./x.js` next to both `x.js` and `x.ts` is resolved by the
     * compiler to the TypeScript source while a runtime would load the emitted
     * JavaScript; which of the two is right depends on the runtime, so both get
     * an edge and neither can be dropped.
     */
    const resolveWithLiteral = (specifier: string, into: string[]): string | null => {
      const target = resolveToWorkspaceFile(specifier, file)
      if (specifier.startsWith('.')) {
        const literal = resolve(dirname(file), specifier)
        if (literal !== target && fileSet.has(literal)) into.push(`${ALL_PREFIX}${literal}`)
      }
      return target
    }

    /** Records the packages a resolved chain crossed, so a NON-source change in one (a manifest re-pointing `exports`) still reaches this importer — such a file is not a graph node, so the file edges alone would miss it. */
    const addPackageMeta = (chainFiles: readonly string[], into: string[]): void => {
      for (const f of chainFiles) {
        const owner = packageOfFile(f)
        if (owner && owner !== ownPackage) into.push(`${PKGMETA_PREFIX}${owner}`)
      }
    }

    /**
     * The coarse edge for a specifier whose shape or name the compiler cannot
     * prove: a bare workspace specifier degrades to its WHOLE package (which
     * also covers that package's non-source files), a relative specifier to the
     * whole target module, and anything else to nothing — a third-party
     * specifier is never a changed workspace file.
     */
    const coarse = (specifier: string, target: string | null, into: string[]): void => {
      if (!specifier.startsWith('.')) {
        const pkg = packageOfBareSpecifier(specifier)
        if (pkg) into.push(`${EXTERNAL_PREFIX}${pkg}`)
        return
      }
      if (target) into.push(`${ALL_PREFIX}${target}`)
    }

    /**
     * The alias chain for one imported/re-exported name, as node keys: the
     * specifier's own target module (so a change to a barrel's own re-export
     * line still selects, including the `export *` case the checker resolves
     * straight past), then every hop the checker walks through, then the file
     * that actually declares the name. `null` when the chain does not
     * terminate in a declaration — the caller's signal to go coarse.
     */
    const chainNodes = (nameNode: import('typescript').Node, target: string, originName: string): string[] | null => {
      if (isStarAmbiguous(target, originName)) return null
      const keys = [`${NAME_PREFIX}${target}${NAME_SEPARATOR}${originName}`, `${OWN_PREFIX}${target}`]
      const chainFiles = [target]
      let symbol = checker.getSymbolAtLocation(nameNode)
      if (!symbol) return null
      // Guarded rather than unbounded: a pathological or cyclic alias chain
      // must degrade to coarse, never spin at push time.
      for (let hop = 0; hop < 64; hop++) {
        if (!(symbol.flags & ts.SymbolFlags.Alias)) {
          const declarations = symbol.declarations ?? []
          if (declarations.length === 0) return null
          for (const declaration of declarations) {
            const declared = declaration.getSourceFile().fileName
            // A declaration outside the workspace (a third-party `.d.ts`) can
            // never be a changed file, so it adds no edge — and it is not a
            // resolution failure either: the target module edge above already
            // carries whatever workspace dependency this name has.
            if (!fileSet.has(declared)) continue
            keys.push(`${NAME_PREFIX}${declared}${NAME_SEPARATOR}${symbol.name}`, `${OWN_PREFIX}${declared}`)
            chainFiles.push(declared)
          }
          addPackageMeta(chainFiles, keys)
          return keys
        }
        const next = checker.getImmediateAliasedSymbol(symbol)
        if (!next || next === symbol) return null
        symbol = next
        // The first symbol is this file's own import binding; every later one
        // is a re-export hop whose own file must select when IT changes.
        for (const declaration of symbol.declarations ?? []) {
          const declared = declaration.getSourceFile().fileName
          if (!fileSet.has(declared) || declared === file) continue
          keys.push(`${NAME_PREFIX}${declared}${NAME_SEPARATOR}${symbol.name}`, `${OWN_PREFIX}${declared}`)
          chainFiles.push(declared)
        }
      }
      return null
    }

    /** One `{ a, b as c }` list against `specifier`: every element resolved by name, or the whole specifier degraded to coarse the moment one will not. */
    const namedElements = (
      elements: readonly (import('typescript').ImportSpecifier | import('typescript').ExportSpecifier)[],
      specifier: string,
      target: string | null,
      into: string[]
    ): void => {
      if (!target || elements.length === 0) {
        coarse(specifier, target, into)
        return
      }
      const collected: string[] = []
      for (const element of elements) {
        // `{ a as b }` — the ORIGIN name is what the target module exports.
        const origin = element.propertyName?.text ?? element.name.text
        const keys = chainNodes(element.name, target, origin)
        if (!keys) {
          coarse(specifier, target, into)
          return
        }
        collected.push(...keys)
      }
      into.push(...collected)
    }

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text
        const target = resolveWithLiteral(specifier, moduleScope)
        if (!target && specifier.startsWith('.')) continue
        const clause = statement.importClause
        // `import '<spec>'` — no bindings at all, the module simply runs.
        if (!clause) {
          coarse(specifier, target, moduleScope)
          continue
        }
        // A default binding is never provably one file's export in a way this
        // graph can follow; a namespace binding uses everything the module has.
        if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
          coarse(specifier, target, moduleScope)
          continue
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          namedElements(clause.namedBindings.elements, specifier, target, moduleScope)
          continue
        }
        coarse(specifier, target, moduleScope)
        continue
      }

      if (ts.isExportDeclaration(statement)) {
        if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const specifier = statement.moduleSpecifier.text
        const target = resolveWithLiteral(specifier, reexport)
        if (!target && specifier.startsWith('.')) continue
        // `export * from` / `export * as ns from` — every name at once.
        if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
          coarse(specifier, target, reexport)
          continue
        }
        namedElements(statement.exportClause.elements, specifier, target, reexport)
        continue
      }

      // `import x = require('<spec>')` — a whole-module binding, and one no
      // alias chain here follows, so it degrades to the coarse edge rather
      // than to silence.
      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteral(statement.moduleReference.expression)
      ) {
        const specifier = statement.moduleReference.expression.text
        coarse(specifier, resolveWithLiteral(specifier, moduleScope), moduleScope)
      }
    }

    // Dynamic `import('<spec>')` anywhere in the file, not only at top level —
    // a lazily-loaded command module is a real edge, and it is always coarse:
    // the whole module is what gets loaded.
    const visitForDynamicImports = (node: import('typescript').Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0]
        if (arg && ts.isStringLiteral(arg)) coarse(arg.text, resolveWithLiteral(arg.text, moduleScope), moduleScope)
      }
      ts.forEachChild(node, visitForDynamicImports)
    }
    ts.forEachChild(sourceFile, visitForDynamicImports)

    edges.set(`${OWN_PREFIX}${file}`, [...new Set(moduleScope)])
    edges.set(`${ALL_PREFIX}${file}`, [...new Set([...moduleScope, ...reexport])])
  }

  return { edges, programMs }
}
