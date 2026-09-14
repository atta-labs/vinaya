import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'bun:test'
import type { SurfaceExemption } from '../src/lib/surface-exemption'

/**
 * O2 — the export inventory is enforced from the real export set, with no
 * hand-written count anywhere in the repository. A markdown mirror of every
 * `@attalabs/aeg-core` and `apps/cli/src/lib/**` export used to live in
 * `apps/cli/specs/surface.md`, requiring a doc edit on every export added,
 * removed, or renamed under either directory — the two busiest in the repo.
 * That mirror provided no behavioral guarantee of its own: the layering
 * predicate (`surface-index.test.ts`) classifies a call as 'lib' purely by
 * the declaring file's path, never by membership in a table.
 *
 * What genuinely needs enforcing from the real export set, with nothing
 * hand-maintained: every `SURFACE_EXEMPTIONS` marker's `retiresVia` target
 * that already names a real, existing `apps/cli/src/lib/**` export must name
 * a *function* — the chokepoint a command is meant to eventually call alone,
 * never a const or a class. A target that does not exist yet (the
 * consolidated set named in `apps/cli/specs/surface.md`'s Effects intro —
 * `sharedCommandShell`, `runChecks`, `forgeWrite`, `collectTokens`,
 * `taskStatus` — is mostly still aspirational) is skipped: this test asserts
 * nothing about a name that isn't real yet, only that a real one stays a
 * real function. The set of target names comes from the command files'
 * own markers — never a list typed here or in any doc — so an unrelated
 * task adding an ordinary lib export never touches this file's inputs.
 */

const CLI_ROOT = join(import.meta.dir, '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const CMD_DIR = join(CLI_ROOT, 'src', 'commands')
const CLI_LIB_DIR = join(CLI_ROOT, 'src', 'lib')

// ---------------------------------------------------------------------------
// Real exports, via the TypeScript checker.
// ---------------------------------------------------------------------------

type RealExport = { name: string; kind: 'function' | 'const' | 'class' | 'other' }

function declarationKind(decl: ts.Declaration): RealExport['kind'] {
  if (ts.isFunctionDeclaration(decl)) return 'function'
  if (ts.isClassDeclaration(decl)) return 'class'
  if (ts.isVariableDeclaration(decl)) {
    // `export const f = (...) => ...` / `export const f = async (...) => ...`
    // is a function value even though the declaration node is a VariableDeclaration.
    const init = decl.initializer
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return 'function'
    return 'const'
  }
  return 'other'
}

/** Every non-type-only export of `moduleFile`'s own module symbol. */
function moduleExports(program: ts.Program, moduleFile: string): RealExport[] {
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(moduleFile)
  if (!sf) throw new Error(`surface-spec-exports: could not load ${moduleFile}`)
  const moduleSymbol = checker.getSymbolAtLocation(sf)
  if (!moduleSymbol) throw new Error(`surface-spec-exports: ${moduleFile} has no module symbol`)

  const out: RealExport[] = []
  for (const sym of checker.getExportsOfModule(moduleSymbol)) {
    const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym
    if (!(resolved.flags & ts.SymbolFlags.Value)) continue
    const decl = resolved.getDeclarations()?.[0]
    if (!decl) continue
    out.push({ name: sym.getName(), kind: declarationKind(decl) })
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
// Effects — apps/cli/src/lib/**, one module per file, no barrel
// ---------------------------------------------------------------------------

describe("apps/cli/src/lib/**'s real exports are internally sane (O2)", () => {
  const configPath = ts.findConfigFile(CLI_ROOT, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('surface-spec-exports: could not find apps/cli/tsconfig.json')
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, CLI_ROOT)
  const program = ts.createProgram({ rootNames: parsedConfig.fileNames, options: parsedConfig.options })

  const libFiles = parsedConfig.fileNames.filter(
    (f) => f.startsWith(`${CLI_LIB_DIR}/`) && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')
  )

  const real = libFiles.flatMap((f) => moduleExports(program, f))
  const realByName = new Map<string, RealExport>()
  for (const e of real) realByName.set(e.name, e)

  it('has at least one real export to check (sanity)', () => {
    expect(real.length).toBeGreaterThan(0)
  })

  it("has at least one real export to check for @attalabs/aeg-core's barrel (sanity)", () => {
    const aegCoreProgram = programFor(join(REPO_ROOT, 'packages', 'aeg-core', 'src', 'index.ts'))
    const aegCoreReal = moduleExports(aegCoreProgram, join(REPO_ROOT, 'packages', 'aeg-core', 'src', 'index.ts'))
    expect(aegCoreReal.length).toBeGreaterThan(0)
  })

  it('every retiresVia target that already names a real lib export names a function', async () => {
    const cmdFileNames = readdirSync(CMD_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const targets = new Set<string>()
    for (const f of cmdFileNames) {
      const mod = (await import(pathToFileURL(join(CMD_DIR, f)).href)) as {
        SURFACE_EXEMPTIONS?: Record<string, SurfaceExemption>
      }
      for (const exemption of Object.values(mod.SURFACE_EXEMPTIONS ?? {})) targets.add(exemption.retiresVia)
    }

    const wrong = [...targets]
      .filter((name) => realByName.has(name))
      .filter((name) => realByName.get(name)!.kind !== 'function')
      .map((name) => `${name}: real export is ${realByName.get(name)!.kind}, not a function`)

    expect(wrong).toEqual([])
  })
})
