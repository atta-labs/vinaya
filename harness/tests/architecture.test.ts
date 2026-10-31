import { afterAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import {
  BASELINE_PATH,
  COMPARE_COMMAND,
  compareBase,
  compareWithBaseline,
  countSource,
  countTree,
  importsOfAProcess,
  importsThroughForwarding,
  OWNERSHIP_MAP_PATH,
  ownershipRefusals,
  REPOSITORY_ROOT,
  readBaseline,
  readOwnershipMap,
  SOURCE_FILE,
  serializeBaseline,
  sourceFiles,
  WRITE_COMMAND,
  workingTree
} from './architecture-ratchet'

export { importsOfAProcess, sourceFiles }

// The harness is generic machinery: it knows no process. A file under
// `harness/` that imports from `processes/`, by relative path or by the
// `@attalabs/process-` package scope, would tie the harness to one process.

const harnessRoot = join(import.meta.dir, '..')

// A module specifier inside `from '…'`, `import '…'`, `import('…')` or `require('…')`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])([^'"`\n]+)\1/g

// Nor does it reach into an application: a file under `harness/` that imports
// from `apps/` would make the generic machinery depend on one product's code.
export function importsOfAnApp(source: string): string[] {
  const offending: string[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[2] ?? ''
    if (specifier.startsWith('.') && specifier.split('/').includes('apps')) offending.push(specifier)
  }
  return offending
}

describe('harness never imports an app', () => {
  test('no file under harness/ imports from apps/', () => {
    const violations: string[] = []
    for (const file of sourceFiles(harnessRoot)) {
      if (file === import.meta.path) continue
      for (const specifier of importsOfAnApp(readFileSync(file, 'utf8'))) {
        violations.push(`${file.slice(harnessRoot.length + 1)} imports ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('the scan catches a planted offending import', () => {
    expect(importsOfAnApp("import { x } from '../../apps/cli/src/lib/thing'")).toEqual(['../../apps/cli/src/lib/thing'])
    expect(importsOfAnApp("const m = await import('../../../apps/cli/x')")).toEqual(['../../../apps/cli/x'])
    expect(importsOfAnApp("import { x } from './local'\nimport y from 'node:fs'")).toEqual([])
  })
})

describe('harness never imports a process', () => {
  test('no file under harness/ imports from processes/', () => {
    const violations: string[] = []
    for (const file of sourceFiles(harnessRoot)) {
      // This file names the forbidden specifiers as data, so it is not scanned.
      if (file === import.meta.path) continue
      for (const specifier of importsOfAProcess(readFileSync(file, 'utf8'))) {
        violations.push(`${file.slice(harnessRoot.length + 1)} imports ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  test('the scan catches a planted offending import', () => {
    expect(importsOfAProcess("import { x } from '../../processes/vinaya/thing'")).toEqual([
      '../../processes/vinaya/thing'
    ])
    expect(importsOfAProcess("import { x } from '@attalabs/process-vinaya'")).toEqual(['@attalabs/process-vinaya'])
    expect(importsOfAProcess("const m = await import('../processes/other')")).toEqual(['../processes/other'])
    expect(importsOfAProcess("import { x } from './local'\nimport y from 'node:fs'")).toEqual([])
  })

  test('no file under harness/ reaches a process through a forwarding entry of the ownership map', () => {
    expect(importsThroughForwarding(REPOSITORY_ROOT)).toEqual([])
  })
})

// ── Planted repositories ────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'architecture-ratchet-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let repositories = 0

function run(root: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=ratchet',
      '-c',
      'user.email=ratchet@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/** Writes each file (a `null` deletes it), then commits; returns the new commit. */
function commit(root: string, files: Record<string, string | null>): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(root, path), { force: true })
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
  }
  run(root, ['add', '-A'])
  run(root, ['commit', '-q', '--allow-empty', '-m', 'planted'])
  return run(root, ['rev-parse', 'HEAD'])
}

/** A planted repository whose base commit holds `files` and, unless told otherwise, their fresh baseline. */
function plantedRepository(files: Record<string, string>, withBaseline = true): { root: string; base: string } {
  const root = join(scratch, `repo-${++repositories}`)
  mkdirSync(root, { recursive: true })
  run(root, ['init', '-q'])
  commit(root, files)
  const base = withBaseline ? commitBaseline(root) : run(root, ['rev-parse', 'HEAD'])
  return { root, base }
}

/** Rewrites the planted repository's baseline from its tree and commits it, as the write command does. */
function commitBaseline(root: string, extra: Record<string, string | null> = {}): string {
  for (const [path, content] of Object.entries(extra)) {
    if (content === null) rmSync(join(root, path), { force: true })
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
  }
  return commit(root, { [BASELINE_PATH]: serializeBaseline(countTree(root)) })
}

/** Moves a file as `git mv` does, keeping its content, so git's rename detection pairs the two paths. */
function move(root: string, from: string, to: string, content?: string): Record<string, string | null> {
  return { [from]: null, [to]: content ?? readFileSync(join(root, from), 'utf8') }
}

// Enough unchanged lines that a small edit still reads as a rename to git.
const BODY = Array.from({ length: 40 }, (_, i) => `export const line${i} = ${i}`).join('\n')

// ── The counted ratchet ─────────────────────────────────────────────────────

describe('the counted ratchet', () => {
  test('every scanned file counts exactly its baseline entry', () => {
    expect(compareWithBaseline(countTree(REPOSITORY_ROOT), readBaseline(REPOSITORY_ROOT))).toEqual([])
  })

  test('the count is the same on two runs over an unchanged tree', () => {
    expect(serializeBaseline(countTree(REPOSITORY_ROOT))).toBe(serializeBaseline(countTree(REPOSITORY_ROOT)))
  })

  test('scanned files are the ones the import checks walk', () => {
    expect(SOURCE_FILE.source).toBe('\\.(ts|tsx|js|jsx|mjs|cjs)$')
  })

  test('the committed ownership map holds no refused entry', () => {
    const read = (path: string): string | null => {
      try {
        return readFileSync(join(REPOSITORY_ROOT, path), 'utf8')
      } catch {
        return null
      }
    }
    expect(ownershipRefusals(readOwnershipMap(REPOSITORY_ROOT), read, workingTree(REPOSITORY_ROOT))).toEqual([])
  })

  test('a role token matches as a whole word, case-insensitively, optionally plural', () => {
    expect(countSource('const seat = "code-reviewer"')).toBe(1)
    expect(countSource('the developers and the reviewers')).toBe(2)
    expect(countSource('type DeveloperTurnResult = developerTurn')).toBe(2)
    expect(countSource('the code was developed')).toBe(0)
    expect(countSource('tranche-archivist, execution-planner, security-reviewer')).toBe(3)
    expect(countSource('the Principal ruled; the operator, the controller')).toBe(3)
    expect(countSource('reviewer_count, reviewer-seat, codeReviewer, reviewerss')).toBe(0)
  })

  test('process tokens match as substrings, and overlapping ones in one path count once', () => {
    expect(countSource("const doctrine = 'aeg-root/roles'")).toBe(1)
    expect(countSource("const launcher = '../../processes/vinaya/bin/run-engine.ts'")).toBe(1)
    expect(countSource("const launcher = '../../harness/processes/vinaya-strict/bin/run-engine.ts'")).toBe(1)
    expect(countSource("const scope = '@attalabs/process-vinaya-strict'")).toBe(1)
  })

  test('an import counts once per specifier, the names inside it included', () => {
    expect(countSource("import { x } from '../../processes/vinaya/loops/developer.ts'")).toBe(1)
    expect(countSource("import { x } from '@attalabs/aeg-core/reviewer'")).toBe(1)
    expect(countSource("import { x } from '@attalabs/aeg-forge-state'")).toBe(1)
    expect(countSource("import { x } from '@attalabs/aeg-types'\nimport y from './local'")).toBe(0)
  })

  test('a role token added to a scanned file is above its baseline entry, naming the file, both counts and both commands', () => {
    const failures = compareWithBaseline({ 'apps/cli/src/lib/a.ts': 3 }, { 'apps/cli/src/lib/a.ts': 2 })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('apps/cli/src/lib/a.ts: counts 3, baseline 2')
    expect(failures[0]).toContain(WRITE_COMMAND)
    expect(failures[0]).toContain(COMPARE_COMMAND)
  })

  test('a new scanned file with a token fails with no baseline entry', () => {
    const failures = compareWithBaseline({ 'packages/aeg-core/src/new.ts': 1 }, {})
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('packages/aeg-core/src/new.ts: counts 1, baseline 0 — and has no baseline entry')
  })

  test('a lowered count fails until the baseline is lowered in the same change', () => {
    const failures = compareWithBaseline({ 'harness/gates/a.ts': 1 }, { 'harness/gates/a.ts': 4 })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('harness/gates/a.ts: counts 1, baseline 4 — below its baseline entry')
    expect(compareWithBaseline({}, { 'harness/gates/a.ts': 1 })[0]).toContain('counts 0, baseline 1')
  })

  test('only non-test source files of the scope roots, outside a process, are counted', () => {
    const { root } = plantedRepository(
      {
        'apps/cli/src/lib/a.ts': 'the developer',
        'apps/cli/src/lib/a.test.ts': 'the developer',
        'apps/cli/tests/b.ts': 'the developer',
        'packages/aeg-core/src/fixtures/c.ts': 'the developer',
        'packages/aeg-core/README.md': 'the developer',
        'packages/aeg-core/src/d.json': '{"role":"developer"}',
        'harness/processes/vinaya-strict/e.ts': 'the developer',
        'harness/tests/f.ts': 'the developer',
        'harness/gates/g.ts': 'the reviewer and the developer',
        'processes/vinaya/h.ts': 'the developer',
        'apps/log-server/src/i.ts': 'the developer'
      },
      false
    )
    expect(countTree(root)).toEqual({ 'apps/cli/src/lib/a.ts': 1, 'harness/gates/g.ts': 2 })
  })
})

// ── The base comparison ─────────────────────────────────────────────────────

describe('the base comparison', () => {
  test('a base with no baseline file passes with a notice', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' }, false)
    commitBaseline(root)
    const result = compareBase(root, base)
    expect(result.failures).toEqual([])
    expect(result.notice).toContain('has no baseline')
  })

  test('an unchanged tree passes', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' })
    expect(compareBase(root, base)).toMatchObject({ notice: null, failures: [], baseTotal: 1, headTotal: 1 })
  })

  test('a growth committed together with a rewritten baseline still fails', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' })
    commitBaseline(root, { 'apps/cli/src/a.ts': 'the developer and the reviewer' })
    expect(compareWithBaseline(countTree(root), readBaseline(root))).toEqual([])
    const { failures } = compareBase(root, base)
    expect(failures[0]).toContain('apps/cli/src/a.ts: counts 2, base 1 — above its base entry')
    expect(failures[0]).toContain(WRITE_COMMAND)
    expect(failures[0]).toContain(COMPARE_COMMAND)
    expect(failures[1]).toContain('total: counts 2, base 1')
  })

  test('a new scanned file with a token fails against a base with no entry for it', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer' })
    commitBaseline(root, { 'packages/sources/src/b.ts': 'the planner' })
    expect(compareBase(root, base).failures[0]).toContain(
      'packages/sources/src/b.ts: counts 1, base 0 — a file with no base entry counts above zero'
    )
  })

  test('a renamed file keeps its count, and fails when its count grew', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/lib/a.ts': `// the developer\n${BODY}\n` })
    commitBaseline(root, move(root, 'apps/cli/src/lib/a.ts', 'harness/gates/a.ts'))
    expect(compareBase(root, base).failures).toEqual([])

    commitBaseline(root, { 'harness/gates/a.ts': `// the developer and the reviewer\n${BODY}\n` })
    expect(compareBase(root, base).failures[0]).toContain(
      'harness/gates/a.ts: counts 2, base 1 — above the base entry of apps/cli/src/lib/a.ts, which it was renamed from'
    )
  })

  test('a lowered count with a lowered baseline passes', () => {
    const { root, base } = plantedRepository({ 'apps/cli/src/a.ts': 'the developer and the reviewer' })
    commitBaseline(root, { 'apps/cli/src/a.ts': 'the developer' })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 2, headTotal: 1 })
  })
})

// ── Relocation equivalence ──────────────────────────────────────────────────

describe('a relocated dependency is unchanged, never growth', () => {
  const launcher = (path: string): string =>
    `import { resolve } from 'node:path'\nexport const launcher = (root: string) => resolve(root, '${path}')\n`

  test('the launcher path rewritten to its location under the renamed process folder keeps its count', () => {
    const { root, base } = plantedRepository({
      'apps/cli/package.json': '{}',
      'apps/cli/src/lib/task-run-engine.ts': launcher('../../processes/vinaya/bin/run-engine.ts'),
      'processes/vinaya/bin/run-engine.ts': `${BODY}\n`
    })
    commitBaseline(root, {
      ...move(root, 'processes/vinaya/bin/run-engine.ts', 'harness/processes/vinaya-strict/bin/run-engine.ts'),
      'apps/cli/src/lib/task-run-engine.ts': launcher('../../harness/processes/vinaya-strict/bin/run-engine.ts')
    })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 1, headTotal: 1 })

    commitBaseline(root, {
      'harness/processes/vinaya-strict/integration/other.ts': `${BODY}\n`,
      'apps/cli/src/lib/task-run-engine.ts': `import { other } from '../../../harness/processes/vinaya-strict/integration/other.ts'\n${launcher('../../harness/processes/vinaya-strict/bin/run-engine.ts')}`
    })
    expect(compareBase(root, base).failures[0]).toContain('apps/cli/src/lib/task-run-engine.ts: counts 2, base 1')
  })

  test("a CLI caller whose driver import is rewritten to the driver's process location keeps its count", () => {
    const caller = (specifier: string): string => `import { cancelDevReviewLoop } from '${specifier}'\n${BODY}\n`
    const { root, base } = plantedRepository({
      'apps/cli/src/lib/dev-review-loop.ts': `export function cancelDevReviewLoop() {}\n${BODY}\n`,
      'apps/cli/src/lib/task-tools/cancel.ts': caller('../dev-review-loop.js')
    })
    expect(countTree(root)).toEqual({})
    commitBaseline(root, {
      ...move(
        root,
        'apps/cli/src/lib/dev-review-loop.ts',
        'harness/processes/vinaya-strict/loops/dev-review/driver.ts'
      ),
      'apps/cli/src/lib/task-tools/cancel.ts': caller(
        '../../../../../harness/processes/vinaya-strict/loops/dev-review/driver.js'
      )
    })
    expect(countTree(root)).toEqual({ 'apps/cli/src/lib/task-tools/cancel.ts': 1 })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 0, headTotal: 0 })

    commitBaseline(root, {
      'harness/processes/vinaya-strict/loops/dev-review/seats.ts': `${BODY}\n`,
      'apps/cli/src/lib/task-tools/cancel.ts': `import { seats } from '../../../../../harness/processes/vinaya-strict/loops/dev-review/seats.js'\n${caller('../../../../../harness/processes/vinaya-strict/loops/dev-review/driver.js')}`
    })
    expect(compareBase(root, base).failures[0]).toContain(
      'apps/cli/src/lib/task-tools/cancel.ts: counts 1, base 0 — above its base entry'
    )
  })
})

// ── Ownership transfer with a forwarding entry ──────────────────────────────

describe('an ownership transfer that keeps a forwarding entry is a relocation', () => {
  const OLD = 'packages/aeg-core/src/baseline-capture.ts'
  const OWNER = 'harness/processes/vinaya-strict/tools/baseline-capture.ts'
  const FORWARD = "export * from '../../../harness/processes/vinaya-strict/tools/baseline-capture.ts'\n"
  const captured = readFileSync(join(REPOSITORY_ROOT, OLD), 'utf8')

  function transferred(oldContent: string): { root: string; base: string } {
    const { root, base } = plantedRepository({ [OLD]: captured, 'harness/gates/kernel.ts': 'export {}\n' })
    commit(root, { [OLD]: oldContent, [OWNER]: captured, [OWNERSHIP_MAP_PATH]: JSON.stringify({ [OLD]: OWNER }) })
    return { root, base }
  }

  test('the capture module, counting zero today, kept as a pure re-export of its mapped process owner passes', () => {
    expect(countSource(captured)).toBe(0)
    const { root, base } = transferred(`/** Moved to its process owner. */\n${FORWARD}`)
    expect(countTree(root)).toEqual({})
    expect(compareBase(root, base)).toMatchObject({ notice: null, failures: [], headTotal: 0 })
  })

  test('the same entry with executable code added is refused', () => {
    const { root, base } = transferred(`${FORWARD}export const extra = captureBaseline\n`)
    expect(compareBase(root, base).failures[0]).toContain(
      `ownership map entry refused: ${OLD} holds code beyond forwarding statements`
    )
  })

  test('the same entry with an unrelated process import is refused', () => {
    const { root, base } = transferred(
      `${FORWARD}export { other } from '../../../harness/processes/vinaya-strict/tools/other.ts'\n`
    )
    commit(root, { 'harness/processes/vinaya-strict/tools/other.ts': 'export const other = 1\n' })
    expect(compareBase(root, base).failures[0]).toContain(`ownership map entry refused: ${OLD} forwards to`)
  })

  test('a map entry for a file that is not pure forwarding is refused', () => {
    const tree = { isFile: (path: string) => path === OWNER, isDirectory: () => false }
    expect(ownershipRefusals({ [OLD]: OWNER }, () => captured, tree)[0]).toContain(
      `${OLD} holds no forwarding statement`
    )
    expect(ownershipRefusals({ [OLD]: OWNER }, () => FORWARD, tree)).toEqual([])
  })

  test("a scanned owner inherits the old file's base entry", () => {
    const old = 'packages/aeg-core/src/seats.ts'
    const owner = 'harness/gates/seats.ts'
    const { root, base } = plantedRepository({ [old]: `// the developer and the reviewer\n${BODY}\n` })
    commitBaseline(root, {
      [old]: "export * from '../../../harness/gates/seats.ts'\n",
      [owner]: `// the developer and the reviewer\n${BODY}\n`,
      [OWNERSHIP_MAP_PATH]: JSON.stringify({ [old]: owner })
    })
    expect(compareBase(root, base)).toMatchObject({ failures: [], baseTotal: 2, headTotal: 2 })
  })

  test("the kernel's indirect-boundary check follows the entry to its process owner", () => {
    const { root } = transferred(FORWARD)
    commit(root, {
      'harness/gates/kernel.ts': "import { captureBaseline } from '../../packages/aeg-core/src/baseline-capture.ts'\n"
    })
    expect(importsThroughForwarding(root)).toEqual([
      `harness/gates/kernel.ts imports ../../packages/aeg-core/src/baseline-capture.ts, which forwards to ${OWNER}`
    ])
  })
})

// ── Continuous integration ──────────────────────────────────────────────────

describe('continuous integration runs the ratchet on every pull request', () => {
  const RATCHET_STEP = 'Test the architecture ratchet against the base'
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, { if?: unknown; steps: Array<{ name?: string; if?: unknown; run?: string }> }>
  }

  test('the build job has no condition that skips it', () => {
    expect(workflow.jobs.build).toBeDefined()
    expect(workflow.jobs.build?.if).toBeUndefined()
  })

  test('the build job runs the ratchet test and the base comparison, with no condition on the step', () => {
    const step = workflow.jobs.build?.steps.find((s) => s.name === RATCHET_STEP)
    expect(step).toBeDefined()
    expect(step?.if).toBeUndefined()
    expect(step?.run).toContain('bun test tests/architecture.test.ts')
    expect(step?.run).toContain('bun harness/tests/architecture-ratchet.ts --compare-base "$BASE_SHA"')
  })
})
