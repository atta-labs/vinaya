import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { COMMANDS } from '@attalabs/vinaya-sources'

/**
 * Enforces apps/cli/specs/surface.md against the real source tree.
 *
 * Predicate (Principal ruling, Issue #418): for a command's entry function,
 * collect every call expression — transitively through same-file helpers —
 * whose callee resolves to an export of apps/cli/src/lib/** or of another
 * apps/cli/src/commands/*.ts file. Calls into @attalabs/aeg-core (policy)
 * are unrestricted. The resulting set must be exactly the index's one named
 * function, or the command must carry a dated exemption row in surface.md
 * naming the chokepoint that retires it. No regex over source text is used
 * to resolve calls — only the TypeScript compiler's type checker, so a
 * renamed import or a re-export barrel is still followed correctly.
 */

const CLI_ROOT = join(import.meta.dir, '..')
const CMD_DIR = join(CLI_ROOT, 'src/commands')
const SURFACE_MD = join(CLI_ROOT, 'specs/surface.md')
const ROUTER_FILE = join(CLI_ROOT, 'src/index.ts')

const cmdFileNames = readdirSync(CMD_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
const cmdFiles = cmdFileNames.map((f) => join(CMD_DIR, f))

const configPath = ts.findConfigFile(CLI_ROOT, ts.sys.fileExists, 'tsconfig.json')
if (!configPath) throw new Error('surface-index.test.ts: could not find apps/cli/tsconfig.json')
const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, CLI_ROOT)

const program = ts.createProgram({
  rootNames: [...parsedConfig.fileNames, ROUTER_FILE, ...cmdFiles],
  options: parsedConfig.options
})
const checker = program.getTypeChecker()

function isInScope(filePath: string): boolean {
  return filePath.includes('/apps/cli/src/lib/') || filePath.includes('/apps/cli/src/commands/')
}
function isLibFile(filePath: string): boolean {
  return filePath.includes('/apps/cli/src/lib/')
}

/** Every top-level `export function`/`export const <id> = (...)` in a source file, by name. */
function topLevelDecl(sf: ts.SourceFile, name: string): ts.Node | undefined {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl
      }
    }
  }
  return undefined
}

interface BoundaryCall {
  name: string
  file: string
  kind: 'lib' | 'cmd'
}

/**
 * Boundary calls reachable from `entryName` in `file`: every call expression
 * whose callee resolves to an export of apps/cli/src/lib/** or another
 * apps/cli/src/commands/*.ts file, following same-file helper calls
 * transitively. Calls into @attalabs/aeg-core, node builtins, and npm
 * packages are out of scope entirely (policy is unrestricted).
 */
function boundaryCallsFor(entryName: string, file: string): BoundaryCall[] {
  const sf = program.getSourceFile(file)
  if (!sf) throw new Error(`surface-index: could not load source file ${file}`)
  const startDecl = topLevelDecl(sf, entryName)
  if (!startDecl) throw new Error(`surface-index: could not find top-level declaration '${entryName}' in ${file}`)

  const visitedLocal = new Set<string>()
  const boundary = new Map<string, BoundaryCall>()

  function expand(node: ts.Node) {
    function visit(n: ts.Node) {
      if (ts.isCallExpression(n)) {
        let symbol = checker.getSymbolAtLocation(n.expression)
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
        if (symbol) {
          for (const decl of symbol.getDeclarations() ?? []) {
            const declFile = decl.getSourceFile().fileName
            const name = symbol.getName()
            if (declFile === file) {
              if (!visitedLocal.has(name)) {
                visitedLocal.add(name)
                expand(decl)
              }
            } else if (isInScope(declFile)) {
              boundary.set(`${name}::${declFile}`, { name, file: declFile, kind: isLibFile(declFile) ? 'lib' : 'cmd' })
            }
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(node)
  }

  expand(startDecl)
  return [...boundary.values()]
}

// ---------------------------------------------------------------------------
// Router: derive command-name -> entry-function-name from apps/cli/src/index.ts's
// switch(command) statement, rather than trusting the spec's own claim of it.
// ---------------------------------------------------------------------------

function findCalledIdentifier(node: ts.Node): string | undefined {
  let found: string | undefined
  function visit(n: ts.Node) {
    if (found) return
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      found = n.expression.text
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

/** Router-derived map: "command name" (e.g. "pr create") -> entry function identifier. */
function deriveRouterMap(): Map<string, string> {
  const sf = program.getSourceFile(ROUTER_FILE)
  if (!sf) throw new Error('surface-index: could not load apps/cli/src/index.ts')
  const map = new Map<string, string>()

  function visitSwitch(node: ts.Node) {
    if (ts.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression)) continue
        const label = clause.expression.text
        if (label === 'help' || label === '--help' || label === '-h' || label === 'version') continue

        // Look for a nested switch(subcommand) inside this clause.
        let nestedSwitch: ts.SwitchStatement | undefined
        let ifStatement: ts.IfStatement | undefined
        for (const stmt of clause.statements) {
          ts.forEachChild(stmt, function walk(n) {
            if (ts.isSwitchStatement(n) && !nestedSwitch) nestedSwitch = n
            if (ts.isIfStatement(n) && !ifStatement && !nestedSwitch) ifStatement = n
            if (!nestedSwitch) ts.forEachChild(n, walk)
          })
        }

        if (nestedSwitch) {
          for (const inner of nestedSwitch.caseBlock.clauses) {
            if (!ts.isCaseClause(inner) || !ts.isStringLiteral(inner.expression)) continue
            const fn = findCalledIdentifier(inner)
            if (fn) map.set(`${label} ${inner.expression.text}`, fn)
          }
        } else if (ifStatement) {
          // if (subcommand === 'x') { A } else if (subcommand === 'y') { B } else { C }
          //   => "label x" -> A, "label y" -> B, and "label" -> C only if C itself
          //      calls a *Command identifier directly (not a bare error branch).
          function walkChain(stmt: ts.IfStatement) {
            let literal: string | undefined
            ts.forEachChild(stmt.expression, (n) => {
              if (ts.isStringLiteral(n)) literal = n.text
            })
            const thenFn = findCalledIdentifier(stmt.thenStatement)
            if (literal && thenFn) map.set(`${label} ${literal}`, thenFn)
            if (!stmt.elseStatement) return
            if (ts.isIfStatement(stmt.elseStatement)) {
              walkChain(stmt.elseStatement)
            } else {
              const elseFn = findCalledIdentifier(stmt.elseStatement)
              if (elseFn) map.set(label, elseFn)
            }
          }
          walkChain(ifStatement)
        } else {
          const fn = findCalledIdentifier(clause)
          if (fn) map.set(label, fn)
        }
      }
    }
    ts.forEachChild(node, visitSwitch)
  }
  visitSwitch(sf)
  return map
}

const routerMap = deriveRouterMap()

/** Which commands/*.ts file exports a given top-level identifier. */
function fileExportingEntry(entryName: string): string | undefined {
  for (const file of cmdFiles) {
    const sf = program.getSourceFile(file)
    if (sf && topLevelDecl(sf, entryName)) return file
  }
  return undefined
}

// ---------------------------------------------------------------------------
// surface.md parsing
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

const commandsTable = tableRows(
  "## Commands — `apps/cli/src/commands` (35 shipped rows, one per `packages/sources/src/commands.ts` entry with `status: 'shipped'`)"
).map(([name, file, entry, calls, status, oneFn]) => ({
  name: unbacktick(name ?? ''),
  file: unbacktick(file ?? ''),
  entry: unbacktick(entry ?? ''),
  calls: Number(calls),
  status: (status ?? '').startsWith('compliant') ? ('compliant' as const) : ('exempt' as const),
  oneFn: oneFn ?? ''
}))

const exemptionsTable = tableRows('## Exemptions').map(([subject, date, callsToday, retiresVia]) => ({
  subject: unbacktick(subject ?? ''),
  date: date ?? '',
  callsToday: Number((callsToday ?? '').match(/^\d+/)?.[0]),
  retiresVia: unbacktick((retiresVia ?? '').trim())
}))

function exemptionFor(commandName: string) {
  return exemptionsTable.find((e) => e.subject === commandName)
}

// ---------------------------------------------------------------------------
// O2 / O3 assertions
// ---------------------------------------------------------------------------

describe('surface index: every shipped command is indexed', () => {
  const shipped = COMMANDS.filter((c) => c.status === 'shipped')

  it('has at least one shipped command to check (sanity)', () => {
    expect(shipped.length).toBeGreaterThan(0)
  })

  for (const command of shipped) {
    it(`'${command.name}' has a surface.md Commands row`, () => {
      const row = commandsTable.find((r) => r.name === command.name)
      expect(
        row,
        `packages/sources/src/commands.ts row '${command.name}' has no matching apps/cli/specs/surface.md Commands row`
      ).toBeDefined()
    })
  }

  for (const command of shipped) {
    if (command.name === 'help' || command.name === 'version') continue

    it(`'${command.name}' calls exactly its one named function, or carries a valid exemption`, () => {
      const entryName = routerMap.get(command.name)
      expect(
        entryName,
        `apps/cli/src/index.ts's router has no case wiring '${command.name}' to an entry function`
      ).toBeDefined()

      const file = fileExportingEntry(entryName as string)
      expect(file, `no apps/cli/src/commands/*.ts file exports '${entryName}'`).toBeDefined()

      const calls = boundaryCallsFor(entryName as string, file as string)
      const cmdCalls = calls.filter((c) => c.kind === 'cmd')
      const libCalls = calls.filter((c) => c.kind === 'lib')

      const row = commandsTable.find((r) => r.name === command.name)
      expect(row).toBeDefined()

      if (row!.status === 'compliant') {
        expect(
          cmdCalls,
          `'${command.name}' calls another commands/*.ts file — commands never call commands: ${cmdCalls.map((c) => c.name).join(', ')}`
        ).toEqual([])
        expect(
          libCalls.length,
          `'${command.name}' is marked compliant but calls ${libCalls.length} lib functions: ${libCalls.map((c) => c.name).join(', ')}`
        ).toBeLessThanOrEqual(1)
        if (libCalls.length === 1) {
          const named = unbacktick(row!.oneFn)
          expect(
            libCalls[0]!.name,
            `'${command.name}' calls '${libCalls[0]!.name}' but the index names '${named}'`
          ).toBe(named)
        }
      } else {
        const exemption = exemptionFor(command.name)
        expect(
          exemption,
          `'${command.name}' is not compliant (${calls.length} in-scope calls) and has no Exemptions row`
        ).toBeDefined()
        expect(exemption!.date.length, `'${command.name}' exemption row has no date`).toBeGreaterThan(0)
        expect(
          exemption!.retiresVia.length,
          `'${command.name}' exemption row has no retirement target`
        ).toBeGreaterThan(0)
        expect(
          calls.length,
          `'${command.name}' makes ${calls.length} in-scope calls today; the exemption row claims ${exemption!.callsToday} — update surface.md`
        ).toBe(exemption!.callsToday)
      }
    })
  }

  it('every non-test file under apps/cli/src/commands/ is either a routed command or a named exemption', () => {
    const routedFiles = new Set(
      [...routerMap.values()].map((entry) => fileExportingEntry(entry)).filter(Boolean) as string[]
    )
    const orphans = cmdFiles.filter((f) => !routedFiles.has(f))
    for (const orphan of orphans) {
      const base = orphan.split('/').pop()!
      const exemption = exemptionsTable.find((e) => e.subject.includes(base))
      expect(
        exemption,
        `${base} is not wired into apps/cli/src/index.ts's router and has no Exemptions row explaining why`
      ).toBeDefined()
      expect(exemption!.retiresVia.length, `${base}'s exemption row has no retirement target`).toBeGreaterThan(0)
    }
  })
})
