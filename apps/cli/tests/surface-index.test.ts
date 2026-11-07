import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { COMMANDS } from '../../../harness/processes/vinaya-strict/integration/commands.js'
import type { SurfaceExemption } from '../../../harness/processes/vinaya-strict/tools/pr-report/surface-exemption'

/**
 * Enforces the layering rule against the real source tree — no hand-maintained
 * table as input.
 *
 * Predicate (Principal ruling, Issue #418): for a command's entry function,
 * collect every call expression — transitively through same-file helpers —
 * whose callee resolves to an export of apps/cli/src/lib/** or of another
 * apps/cli/src/commands/*.ts file. Calls into @attalabs/aeg-core (policy)
 * are unrestricted. The resulting set must be exactly the command's one
 * lib call, or the command's own file must export a `SURFACE_EXEMPTIONS` entry
 * (`harness/processes/vinaya-strict/tools/pr-report/surface-exemption.ts`) naming the chokepoint that retires
 * it — a source-visible marker living in the file the exemption is about,
 * never a shared spec every unrelated task also has to edit. No regex over
 * source text is used to resolve calls — only the TypeScript compiler's type
 * checker, so a renamed import or a re-export barrel is still followed
 * correctly.
 */

const CLI_ROOT = join(import.meta.dir, '..')
const CMD_DIR = join(CLI_ROOT, 'src/commands')
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

/** The standalone driver, moved out of `apps/cli/src/lib/` into the process; the commands still call it as a library. */
const STANDALONE_DRIVER = '/harness/processes/vinaya-strict/loops/dev-review/standalone/'
/** The run control, dispatch, task-contract, emitter, artifact and result modules, moved out of `apps/cli/src/lib/` into the process; the commands still call them as a library. */
const MOVED_LIBRARY_FOLDERS = [
  'tools/',
  'artifacts/',
  'integration/',
  'executing/developer/',
  'executing/code-reviewer/',
  'retrospecting/archivist/',
  'loops/dev-review/run-control/',
  'loops/dev-review/dispatch/',
  'loops/dev-review/actions/'
].map((folder) => `/harness/processes/vinaya-strict/${folder}`)
const MOVED_LIBRARY_FILES = ['loops/dev-review/flow-v2-events.ts', 'loops/dev-review/review-gate-input.ts'].map(
  (file) => `/harness/processes/vinaya-strict/${file}`
)
/** The library modules that moved out of `apps/cli/src/lib/` into the kernel; the commands still call them as a library. */
const KERNEL_LIBRARY_FILES = [
  'adapters/agents/agent-stream.ts',
  'adapters/agents/agent-vendors.ts',
  'adapters/agents/codex/loop-narration-codex.ts',
  'adapters/code-host/github/forge-read.ts',
  'adapters/code-host/github/forge-snapshot.ts',
  'adapters/code-host/github/gh-path.ts',
  'adapters/code-host/github/github-rate-limit.ts',
  'conformance/unit/process-registry.ts',
  'conformance/unit/test-temp.ts',
  'connectors/git/detect.ts',
  'connectors/git/diff-evidence.ts',
  'connectors/git/numstat.ts',
  'connectors/git/patch-id.ts',
  'connectors/git/remote-base.ts',
  'gates/checks/env-lint.ts',
  'gates/checks/github-crossing-files.ts',
  'gates/enforcement-controls.ts',
  'gates/local-gate-control.ts',
  'gates/ops.ts',
  'gates/ring0-hooks/init-hook-paths.ts',
  'gates/ring0-hooks/pre-push/cli-spawn-tests.ts',
  'gates/ring0-hooks/pre-push/pre-push-changed-files.ts',
  'gates/ring0-hooks/pre-push/pre-push-failed-tests.ts',
  'gates/ring0-hooks/pre-push/pre-push-mode-logic.ts',
  'gates/ring0-hooks/pre-push/pre-push-mode.ts',
  'gates/ring0-hooks/pre-push/pre-push-record-tests.ts',
  'gates/ring0-hooks/pre-push/pre-push-test-runner.ts',
  'gates/ring1-ci/workflows/managed-workflow-paths.ts'
].map((file) => `/harness/kernel/${file}`)
const KERNEL_LIBRARY_FOLDERS = ['/harness/kernel/gates/ring0-hooks/pre-push/verification/']
/** Relocated policy modules retain their original unrestricted classification. */
const MOVED_POLICY_FILES = [
  '/harness/processes/vinaya-strict/checks/forge/fetch-provenance.ts',
  '/harness/processes/vinaya-strict/checks/forge/fetch-task-issue-refs.ts',
  '/harness/processes/vinaya-strict/checks/forge/list-issue-milestones.ts',
  '/harness/processes/vinaya-strict/checks/pr-report-density.ts',
  '/harness/processes/vinaya-strict/thinking/planner/tools/amend-rationale-deps.ts',
  '/harness/processes/vinaya-strict/artifacts/docs/build-doc-nav.ts',
  '/harness/processes/vinaya-strict/artifacts/docs/legacy-anchors.ts',
  '/harness/processes/vinaya-strict/artifacts/docs/nav-helpers.ts',
  '/harness/processes/vinaya-strict/artifacts/docs/node-route.ts',
  '/harness/processes/vinaya-strict/retrospecting/archivist/bin/archive-task.ts',
  '/harness/processes/vinaya-strict/tools/archive-task.ts',
  '/harness/processes/vinaya-strict/tools/dev-review-policy/assess-round.ts',
  '/harness/processes/vinaya-strict/tools/dev-review-policy/fakes.ts',
  '/harness/processes/vinaya-strict/tools/dev-review-policy/journal-reconstruction.ts',
  '/harness/processes/vinaya-strict/tools/dev-review-policy/render-summary.ts',
  '/harness/processes/vinaya-strict/tools/dev-review-policy/types.ts',
  '/harness/processes/vinaya-strict/tools/milestone/check-milestone-attachment.ts',
  '/harness/processes/vinaya-strict/tools/pr-report/tokens/parse-ledger.ts',
  '/harness/processes/vinaya-strict/tools/pr-report/tokens/parse-token-report.ts',
  '/harness/processes/vinaya-strict/tools/pr-report/tokens/report-tokens.ts',
  '/harness/processes/vinaya-strict/tools/pr-report/tokens/sum-ledger.ts',
  '/harness/processes/vinaya-strict/tools/prior-tranche-archival.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/blast-radius-domains.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/brief-render.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/brief-validation.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/consumer-enumeration.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/derive-section7.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/derive-tranche.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/derive-from-forge.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/fetch-forge-facts.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/fetch-milestone.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/fetch-open-issues.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/labels.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/list-tasks.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/map-forge-facts.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/forge/parse-rationale-deps.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/gate-cutovers.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/issue-validation.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/live-record.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/milestone-validation.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/objectives-cutover-config.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/objectives.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/parse-registry.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/parse-tranche.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/pr-tier.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/premise-check.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/principals-config.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/protected-paths.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/review-input-manifest.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/review-policy.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/review-status.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/ruling-ordinal.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/state-machine-model.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/state-source.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/task-branch-identity.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/test-plan-section.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/tranche-types.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/types.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/verdict-extraction.ts',
  '/harness/processes/vinaya-strict/tools/task-contract/waiver-label.ts',
  '/harness/processes/vinaya-strict/tools/task-phase-history.ts'
]
const isMovedLibrary = (filePath: string): boolean =>
  KERNEL_LIBRARY_FILES.some((file) => filePath.endsWith(file)) ||
  KERNEL_LIBRARY_FOLDERS.some((folder) => filePath.includes(folder)) ||
  (!MOVED_POLICY_FILES.some((file) => filePath.endsWith(file)) &&
    !filePath.includes('/harness/processes/vinaya-strict/tests/') &&
    // `roles/plan.ts` sat beside `lib/`, never inside it, so it stays outside the library here too.
    !filePath.includes('/harness/processes/vinaya-strict/integration/roles/') &&
    (MOVED_LIBRARY_FOLDERS.some((folder) => filePath.includes(folder)) ||
      MOVED_LIBRARY_FILES.some((file) => filePath.endsWith(file))))

function isInScope(filePath: string): boolean {
  return (
    filePath.includes('/apps/cli/src/lib/') ||
    filePath.includes('/apps/cli/src/commands/') ||
    filePath.includes(STANDALONE_DRIVER) ||
    isMovedLibrary(filePath)
  )
}
function isLibFile(filePath: string): boolean {
  return filePath.includes('/apps/cli/src/lib/') || filePath.includes(STANDALONE_DRIVER) || isMovedLibrary(filePath)
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
// switch(command) statement, rather than trusting any doc's claim of it.
// ---------------------------------------------------------------------------

function findCalledIdentifier(node: ts.Node): string | undefined {
  let found: string | undefined
  function visit(n: ts.Node) {
    if (found) return
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      found = n.expression.text
      return
    }
    // A command loaded on demand: `(await import('./commands/x.js')).entry(args)`.
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isParenthesizedExpression(n.expression.expression) &&
      ts.isAwaitExpression(n.expression.expression.expression) &&
      ts.isCallExpression(n.expression.expression.expression.expression) &&
      n.expression.expression.expression.expression.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      found = n.expression.name.text
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
// Source-visible exemption markers — each command file's own `SURFACE_EXEMPTIONS`
// export, read via dynamic import (a runtime value, not an AST parse: the
// marker is a plain object literal, and the exact value it holds today is
// what the ratchet below checks).
// ---------------------------------------------------------------------------

type ExemptionsExport = Record<string, SurfaceExemption> | undefined

const exemptionModules = new Map<string, Promise<ExemptionsExport>>()

async function exemptionsIn(file: string): Promise<ExemptionsExport> {
  let pending = exemptionModules.get(file)
  if (!pending) {
    pending = import(pathToFileURL(file).href).then((mod) => mod.SURFACE_EXEMPTIONS as ExemptionsExport)
    exemptionModules.set(file, pending)
  }
  return pending
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

describe('surface index: every shipped command respects the layering rule', () => {
  const shipped = COMMANDS.filter((c) => c.status === 'shipped')

  it('has at least one shipped command to check (sanity)', () => {
    expect(shipped.length).toBeGreaterThan(0)
  })

  for (const command of shipped) {
    if (command.name === 'help' || command.name === 'version') continue

    it(`'${command.name}' calls exactly one lib chokepoint, or carries a source-visible exemption`, async () => {
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

      const exemptions = await exemptionsIn(file as string)
      const exemption = exemptions?.[command.name]

      if (!exemption) {
        expect(
          cmdCalls,
          `'${command.name}' calls another commands/*.ts file — commands never call commands: ${cmdCalls.map((c) => c.name).join(', ')}`
        ).toEqual([])
        expect(
          libCalls.length,
          `'${command.name}' calls ${libCalls.length} lib functions but has no SURFACE_EXEMPTIONS entry: ${libCalls.map((c) => c.name).join(', ')}`
        ).toBeLessThanOrEqual(1)
      } else {
        expect(exemption.date.length, `'${command.name}' exemption has no date`).toBeGreaterThan(0)
        expect(exemption.retiresVia.length, `'${command.name}' exemption has no retirement target`).toBeGreaterThan(0)
        expect(
          calls.length,
          `'${command.name}' makes ${calls.length} in-scope calls today; its SURFACE_EXEMPTIONS entry claims ${exemption.callsToday} — update the marker in ${file}`
        ).toBe(exemption.callsToday)
      }
    })
  }

  it('every non-test file under apps/cli/src/commands/ is either a routed command or a named exemption', async () => {
    const routedFiles = new Set(
      [...routerMap.values()].map((entry) => fileExportingEntry(entry)).filter(Boolean) as string[]
    )
    const orphans = cmdFiles.filter((f) => !routedFiles.has(f))
    for (const orphan of orphans) {
      const base = orphan.split('/').pop()!
      const exemptions = await exemptionsIn(orphan)
      const exemption = exemptions?.[base]
      expect(
        exemption,
        `${base} is not wired into apps/cli/src/index.ts's router and has no SURFACE_EXEMPTIONS entry explaining why`
      ).toBeDefined()
      expect(exemption!.retiresVia.length, `${base}'s exemption has no retirement target`).toBeGreaterThan(0)
    }
  })
})
