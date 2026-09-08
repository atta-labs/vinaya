import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'bun:test'

/**
 * O16 — a change that adds, removes or renames an export
 * is refused while `apps/cli/specs/surface.md`'s Policy/Effects tables
 * still disagree with it. `surface-index.test.ts` already enforces the
 * Commands table against the real source tree ("this file is its source of
 * truth, not the reverse") but explicitly leaves Policy/Effects unchecked
 * ("Calls into `@attalabs/aeg-core` are unrestricted"); this file closes
 * that gap for the two tables surface.md itself says are exhaustive real-
 * export mirrors.
 *
 * Two independent comparisons, each via the real TypeScript checker (never
 * a regex over source text, for the same reason `surface-index.test.ts`
 * uses the checker: a renamed import or an aliased re-export must still
 * resolve correctly):
 *
 * - Policy: every non-type export of `packages/aeg-core/src/index.ts`'s
 *   own module symbol (the barrel), resolved to its real declaring file.
 * - Effects: every exported function/const/class of each file directly
 *   under `apps/cli/src/lib/` (one file, one module symbol each — there is
 *   no barrel there).
 */

const CLI_ROOT = join(import.meta.dir, '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const SURFACE_MD = join(CLI_ROOT, 'specs', 'surface.md')
const AEG_CORE_SRC = join(REPO_ROOT, 'packages', 'aeg-core', 'src')
const AEG_CORE_INDEX = join(AEG_CORE_SRC, 'index.ts')
const CLI_LIB_DIR = join(CLI_ROOT, 'src', 'lib')

// ---------------------------------------------------------------------------
// surface.md table parsing — same shape as surface-index.test.ts's tableRows.
// ---------------------------------------------------------------------------

const surfaceMd = readFileSync(SURFACE_MD, 'utf-8')

function tableRows(heading: string): string[][] {
  const lines = surfaceMd.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) throw new Error(`surface.md: missing heading '${heading}'`)
  const rows: string[][] = []
  let inTable = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('## ')) break
    if (!line.startsWith('|')) continue
    if (/^\|[\s-]*\|/.test(line) && line.includes('---')) {
      inTable = true
      continue
    }
    if (!inTable) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    rows.push(cells)
  }
  return rows
}

function unbacktick(cell: string): string {
  return cell.replace(/^`|`$/g, '')
}

type SpecRow = { name: string; kind: string; file: string }

function specRows(heading: string): SpecRow[] {
  return tableRows(heading).map(([name, kind, file]) => ({
    name: unbacktick(name ?? ''),
    kind: (kind ?? '').trim(),
    file: unbacktick(file ?? '')
  }))
}

const policyRows = specRows('## Policy — `@attalabs/aeg-core` public exports')
const effectsRows = specRows('## Effects — `apps/cli/src/lib` public exports')

// ---------------------------------------------------------------------------
// Real exports, via the TypeScript checker.
// ---------------------------------------------------------------------------

type RealExport = { name: string; kind: 'function' | 'const' | 'class' | 'other'; file: string }

function declarationKind(decl: ts.Declaration): RealExport['kind'] {
  if (ts.isFunctionDeclaration(decl)) return 'function'
  if (ts.isClassDeclaration(decl)) return 'class'
  if (ts.isVariableDeclaration(decl)) return 'const'
  return 'other'
}

/** Every non-type-only export of `moduleFile`'s own module symbol, resolved through re-exports to its real declaring file — repo-relative, POSIX-separated. */
function moduleExports(program: ts.Program, moduleFile: string): RealExport[] {
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(moduleFile)
  if (!sf) throw new Error(`surface-spec-exports: could not load ${moduleFile}`)
  const moduleSymbol = checker.getSymbolAtLocation(sf)
  if (!moduleSymbol) throw new Error(`surface-spec-exports: ${moduleFile} has no module symbol`)

  const out: RealExport[] = []
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    // Type-only (an interface, a type alias, or a `Symbol.Value`-less alias
    // to one) carries no `Value` flag — Policy/Effects both explicitly
    // index "non-type"/"function/const/class" exports only.
    const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
    if (!(resolved.flags & ts.SymbolFlags.Value)) continue

    const decl = resolved.getDeclarations()?.[0]
    if (!decl) continue
    const declFile = decl.getSourceFile().fileName
    out.push({
      name: sym.getName(),
      kind: declarationKind(decl),
      file: relative(REPO_ROOT, declFile).split('\\').join('/')
    })
  }
  return out
}

function programFor(rootFile: string): ts.Program {
  const configPath = ts.findConfigFile(dirname(rootFile), ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error(`surface-spec-exports: could not find a tsconfig.json above ${rootFile}`)
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath))
  return ts.createProgram({ rootNames: [...parsedConfig.fileNames, rootFile], options: parsedConfig.options })
}

// ---------------------------------------------------------------------------
// Policy — packages/aeg-core/src/index.ts's barrel
// ---------------------------------------------------------------------------

/** `name` alone collides on a genuinely-duplicated export (`isAgentVendor` is declared independently in TWO lib files, and surface.md already carries a separate row for each) — key on `name::file` instead, so two real, distinct declarations sharing a name are compared against their own, distinct rows rather than one hiding the other. */
function compositeKey(name: string, file: string): string {
  return `${name}::${file}`
}

function checkTableAgainstReal(rows: SpecRow[], real: RealExport[], label: string) {
  const realByKey = new Map(real.map((e) => [compositeKey(e.name, e.file), e]))
  const rowByKey = new Map(rows.map((r) => [compositeKey(r.name, r.file), r]))

  it(`names no export ${label} does not actually export at that file`, () => {
    const stale = rows.filter((r) => !realByKey.has(compositeKey(r.name, r.file)))
    expect(
      stale.map((r) => `${r.name} (${r.file})`),
      `surface.md row(s) with no matching real export — remove or fix`
    ).toEqual([])
  })

  it(`is missing no real ${label} export`, () => {
    const missing = real.filter((e) => !rowByKey.has(compositeKey(e.name, e.file)))
    expect(
      missing.map((e) => `${e.name} (${e.file})`),
      `real export(s) with no surface.md row — add one`
    ).toEqual([])
  })

  it(`gets every listed export's kind right`, () => {
    const wrong = rows
      .filter((r) => realByKey.has(compositeKey(r.name, r.file)))
      .filter((r) => realByKey.get(compositeKey(r.name, r.file))!.kind !== r.kind)
      .map((r) => `${r.name} (${r.file}): surface.md says ${r.kind}, really ${realByKey.get(compositeKey(r.name, r.file))!.kind}`)
    expect(wrong).toEqual([])
  })
}

describe('surface.md Policy table mirrors packages/aeg-core/src/index.ts exactly (O16)', () => {
  const program = programFor(AEG_CORE_INDEX)
  const real = moduleExports(program, AEG_CORE_INDEX)

  it('has at least one real export to check (sanity)', () => {
    expect(real.length).toBeGreaterThan(0)
  })

  checkTableAgainstReal(policyRows, real, '@attalabs/aeg-core')
})

// ---------------------------------------------------------------------------
// Effects — apps/cli/src/lib/**, one module per file, no barrel
// ---------------------------------------------------------------------------

describe('surface.md Effects table mirrors apps/cli/src/lib/**\'s real exports exactly (O16)', () => {
  const configPath = ts.findConfigFile(CLI_ROOT, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('surface-spec-exports: could not find apps/cli/tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, CLI_ROOT)
  const program = ts.createProgram({ rootNames: parsedConfig.fileNames, options: parsedConfig.options })

  const libFiles = parsedConfig.fileNames.filter(
    (f) => f.startsWith(`${CLI_LIB_DIR}/`) && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')
  )

  const real = libFiles.flatMap((f) => moduleExports(program, f))

  it('has at least one real export to check (sanity)', () => {
    expect(real.length).toBeGreaterThan(0)
  })

  checkTableAgainstReal(effectsRows, real, 'apps/cli/src/lib/**')
})
