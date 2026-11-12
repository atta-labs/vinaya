/**
 * Assertions that read the driver's own source from the tree: its exit sites, the merge-base wiring of its
 * manifest builder, and the paths a stale-driver check treats as the driver's own.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { DRIVER_OWNED_PATHS } from '../../../../loops/dev-review/standalone/dev-review-loop.js'
import { cleanupWorlds } from '../dev-review-loop-harness.js'
import { tempDirs as sharedTempDirs } from './driver-test-support.js'

const DRIVER_DIR = join(import.meta.dir, '..', '..', '..', '..', 'loops', 'dev-review', 'standalone')
const MODULE_DIR = join(DRIVER_DIR, 'dev-review-loop')
const DRIVER_PATH = join(DRIVER_DIR, 'dev-review-loop.ts')
const EXPORT_LIST_PATH = join(import.meta.dir, '..', '..', '..', '..', 'fixtures', 'dev-review-driver-exports.json')

const tempDirs = sharedTempDirs
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
// Issue #709: the in-process harness owns its own temp dirs (its world's
// runtimeDir/repoRoot/logDir) — clean them after every test too.
afterEach(cleanupWorlds)

/**
 * O6 — a static enumeration, not a behavioral one: every
 * `return { finalDecision` (a real exit from `devReviewLoop`) and every
 * `d.exitProcess(` call in the source names its own decision kind, so the
 * loop's own exit sites are countable by inspection. Only two kinds may
 * ever be the reason the FUNCTION resolves without a lock left behind:
 * `publish`, and the re-exec hand-off (`exitProcess`, the literal process
 * boundary — a real hand-off to a child process, not a decision this
 * process makes about its own work). Every `pause`-shaped return is
 * legitimate (see the two classes above) but is never counted as one of
 * the "the process really ends" sites the fixture names — a pause return
 * still ends THIS invocation's own async call (there is no infinite
 * retry loop in this codebase), but the two sanctioned reasons the loop
 * itself decides to stop being the source of new work are publish and an
 * explicit stop (`d.exitProcess` on a clean re-exec hand-off, or the
 * DeveloperStopSignal path posting an explicit refusal/escalation).
 */
describe('devReviewLoop — the loop’s exit sites (O6)', () => {
  it('exactly one exitProcess call site exists — the re-exec hand-off — never a bare process.exit sprinkled elsewhere', () => {
    const source = readFileSync(join(MODULE_DIR, 'stale-driver.ts'), 'utf8')
    const exitProcessCalls = source.match(/\bd\.exitProcess\(/g) ?? []
    expect(exitProcessCalls).toHaveLength(1)
    // No second site hides in the orchestrator or another module.
    expect(readFileSync(DRIVER_PATH, 'utf8').match(/\bd\.exitProcess\(/g) ?? []).toHaveLength(0)
    for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts') && name !== 'stale-driver.ts')) {
      expect(readFileSync(join(MODULE_DIR, file), 'utf8').match(/\bd\.exitProcess\(/g) ?? []).toHaveLength(0)
    }
  })

  it('the outer round-loop catch no longer re-throws — it is a `return`, same as every other decided exit', () => {
    const source = readFileSync(join(MODULE_DIR, 'run-start.ts'), 'utf8')
    // Located via `recordDriverExited('error')` — unique to THIS catch —
    // rather than a `catch (err) {`-anchored regex: several OTHER catches in
    // this file (control-store-v1 task 6, `#556`: `resolveEscalation`'s own
    // resume/cancel error handling) also re-throw an unrecognized error by
    // design, and ANY regex starting from a `catch (err) {` literal and
    // lazily searching forward will eventually reach this same unique marker
    // regardless of which catch it started at — a loose pattern can never
    // reliably isolate this ONE block. Plain string indexing does.
    const markerIndex = source.indexOf("recordDriverExited('error', { error: err })")
    expect(markerIndex).toBeGreaterThan(-1)
    const catchStart = source.lastIndexOf('catch (err) {', markerIndex)
    expect(catchStart).toBeGreaterThan(-1)
    // The catch's own closing line: the first one after its `return`.
    const returnIndex = source.indexOf('return { finalDecision: decision, prNumber, task }', markerIndex)
    expect(returnIndex).toBeGreaterThan(markerIndex)
    const catchEnd = source.indexOf('\n  }\n', returnIndex)
    expect(catchEnd).toBeGreaterThan(returnIndex)
    const body = source.slice(catchStart, catchEnd)
    expect(body).not.toMatch(/^\s*throw err\s*$/m)
    expect(body).toMatch(/return \{ finalDecision: decision, prNumber, task \}/)
  })

  // Round 5 review, MINOR: `logPauseCommentRetryIfNotable`'s own guard used
  // to read `if (result.attempts <= 1) return` — indistinguishable from a
  // genuine `{attempts: 0/1, posted: false}` failure (a corrupt
  // control-store record, an epoch-acquisition throw — see
  // `pause-resume.test.ts`'s own structural tests for that fix) and the
  // harmless `{attempts: 0/1, posted: true}` no-op/first-try-success case.
  // The fixed guard only skips logging when `posted` is true — asserted
  // directly here since a genuine reproduction needs the same real,
  // process-memoized control store `pause-resume.test.ts`'s own tests
  // avoid touching in-process for the identical reason.
  it("logPauseCommentRetryIfNotable's own guard only stays silent on a genuinely boring outcome (posted, attempts <= 1) — never a real posted:false failure", () => {
    const source = readFileSync(join(MODULE_DIR, 'developer-prompts.ts'), 'utf8')
    const markerIndex = source.indexOf('async function logPauseCommentRetryIfNotable(')
    expect(markerIndex).toBeGreaterThan(-1)
    const guardLine = source.slice(markerIndex, source.indexOf('\n', markerIndex + 1) + 200)
    expect(guardLine).toMatch(/if \(result\.posted && result\.attempts <= 1\) return/)
  })
})
// issue-657, O4 — source-wiring proof, the same convention this file's own
// "O3 wiring reaches both gate modes" describe block already uses: the
// subprocess fixtures above prove the round-level OUTCOME (a normal publish,
// or a decided pause), but cannot observe the exact `baseSha` byte value the
// manifest binds (the control-store snapshot is never persisted without a
// real, resolvable repository — see the describe block's own comment,
// above). This proves the call sites themselves reach the real merge-base
// resolver, never the raw default-branch tip.
describe('devReviewLoop — O4 (issue-657) wiring: the manifest builder reads a merge base, never the raw tip', () => {
  const src = readFileSync(join(MODULE_DIR, 'driver-deps.ts'), 'utf8')

  // The round loop moved to its own module; the wiring it carries is read there.
  const roundLoopSrc = readFileSync(join(MODULE_DIR, 'round-loop.ts'), 'utf8')

  it('the round-1 dispatch builds baseSha from d.gitMergeBase(head), not d.gitRevParseOriginMain()', () => {
    expect(roundLoopSrc).toContain('const baseSha = await d.gitMergeBase(head)')
  })

  it('the publish-time fallback manifest rebuild resolves baseSha the same way', () => {
    expect(roundLoopSrc).toContain('baseSha: await d.gitMergeBase(d.resolveHead(branch))')
  })

  it('gitMergeBase is a real Deps field, defaulting to resolveMergeBase — never an ad hoc shell pipeline in the driver', () => {
    expect(src).toContain('gitMergeBase: (head: string) => Promise<string>')
    expect(readFileSync(join(MODULE_DIR, 'runtime-defaults.ts'), 'utf8')).toContain('gitMergeBase: defaultGitMergeBase')
    expect(readFileSync(join(MODULE_DIR, 'git-defaults.ts'), 'utf8')).toMatch(
      /function defaultGitMergeBase\(head: string\): Promise<string> \{\s*return resolveMergeBase\(head\)/
    )
  })
})
// --- review-validity-v1 12 (#526), O8 round 2: the split must not narrow stale_driver's own coverage ---

describe('DRIVER_OWNED_PATHS covers every dev-review-loop/*.ts split module (review-validity-v1 12, #526 round 2)', () => {
  it('names the dev-review-loop/ directory, not only the old single composition-root file', () => {
    const splitModules = [
      'gate-reading.ts',
      'reviewer-dispatch.ts',
      'round-assess.ts',
      'publication.ts',
      'pause-resume.ts',
      'developer-dispatch.ts',
      'run-context.ts',
      'round-loop.ts',
      'rate-limit-waits.ts',
      'ci-gate.ts',
      'round-report.ts',
      'reviewer-turn.ts'
    ]
    for (const m of splitModules) {
      const modulePath = `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop/${m}`
      expect(DRIVER_OWNED_PATHS.some((p) => modulePath === p || modulePath.startsWith(p))).toBe(true)
    }
  })
})

// --- driver-split-v1 1: the driver file is a composition root, not the place the round loop lives ---

/** The most lines `devReviewLoop`, its nested `runDevReviewLoopBody` included, may span. */
const DEV_REVIEW_LOOP_LINE_CAP = 400

describe('devReviewLoop stays a bounded composition root (driver-split-v1 1)', () => {
  it('keeps the driver at most 1,500 lines and every module at most 2,000 lines', () => {
    expect(readFileSync(DRIVER_PATH, 'utf8').trimEnd().split('\n').length).toBeLessThanOrEqual(1500)
    for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'))) {
      expect(
        { file, lines: readFileSync(join(MODULE_DIR, file), 'utf8').trimEnd().split('\n').length }.lines
      ).toBeLessThanOrEqual(2000)
    }
  })
  it(`spans at most ${DEV_REVIEW_LOOP_LINE_CAP} lines`, () => {
    const source = readFileSync(DRIVER_PATH, 'utf8')
    const file = ts.createSourceFile(DRIVER_PATH, source, ts.ScriptTarget.Latest, true)
    const fn = file.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'devReviewLoop'
    )
    expect(fn).toBeDefined()
    const first = file.getLineAndCharacterOfPosition(fn!.getStart()).line
    const last = file.getLineAndCharacterOfPosition(fn!.getEnd()).line
    expect(last - first + 1).toBeLessThanOrEqual(DEV_REVIEW_LOOP_LINE_CAP)
  })

  it('creates its run context inside the function — no module in the loop holds one at module level', () => {
    const driver = readFileSync(DRIVER_PATH, 'utf8')
    expect(driver).toContain('const c = createLoopRunContext(')
    // `createLoopRunContext` is called exactly once, in `devReviewLoop`; a module-level call would share one
    // context between two drivers running in one process.
    expect(driver.match(/createLoopRunContext\(/g)).toHaveLength(1)
    for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(join(MODULE_DIR, file), 'utf8')).not.toMatch(
        /^(export )?(const|let) \w+(: [^=\n]+)? = createLoopRunContext\(/m
      )
    }
  })
})

/** The names a module's top level exports, read from its syntax — a re-export names its own exports too. */
function exportedNames(path: string): Set<string> {
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      expect(statement.exportClause).toBeDefined() // `export *` would hide names from this list
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements) names.add(element.name.text)
      continue
    }
    const exported = ts.getCombinedModifierFlags(statement as unknown as ts.Declaration) & ts.ModifierFlags.Export
    if (!exported) continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text)
    }
  }
  return names
}

describe('the driver file keeps every name it exported before the split (driver-split-v1 1)', () => {
  const listed = JSON.parse(readFileSync(EXPORT_LIST_PATH, 'utf8')) as { values: string[]; types: string[] }

  it('exports each name in the committed list, taken from the default branch before the move', () => {
    const exported = exportedNames(DRIVER_PATH)
    const missing = [...listed.values, ...listed.types].filter((name) => !exported.has(name))
    expect(missing).toEqual([])
  })

  it('exports each listed value at run time, under the same path', async () => {
    const loaded = (await import('../../../../loops/dev-review/standalone/dev-review-loop.js')) as Record<
      string,
      unknown
    >
    expect(listed.values.filter((name) => !(name in loaded))).toEqual([])
  })
})
