/**
 * The CI plan (`scripts/ci/impact-plan.ts`) and its base guard
 * (`scripts/ci/base-guard.ts`), on real commits of this repository: the plan
 * takes its tests from the same shared selection a local push uses, keeps the
 * always-run list and every mandatory duty as stated additions, records the
 * approved head apart from the tested tree, checks its schedule whole, and
 * runs everything whenever the guard, read from the base, says so or says
 * nothing. Fixture changes are committed into the object store as commits no
 * branch names (`scripts/ci/replay.ts`); the checkout is never touched.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { plannedTests, type SelectionPlan } from '../../src/lib/verification/index.js'
import { SUITE_INPUTS } from '../sandbox-conformance/command-sources.js'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

// The repository's CI scripts sit outside this package's type program, so they load by path, never by a
// static import; the inventory declares them as this test's code input.
const load = async (path: string): Promise<any> => import(join(REPO_ROOT, path))
type Guard = { verdict: 'plan' | 'full'; reason: string; guarded: string[] }
type JobDecision = { required: boolean; reason: string }
type PlannedRun = { test: string; why: string[] }
type CiPlan = {
  identity: string
  scope: string
  reason: string | null
  approvedHead: string
  testedTree: string
  valid: boolean
  changed: string[]
  tests: PlannedRun[]
  unselected: { suite: string; reason: string }[]
  decision: unknown
  jobs: { 'sandbox-conformance': JobDecision; 'sandbox-conformance-macos': JobDecision } & Record<string, JobDecision>
  obligations: { id: string }[]
}
type TreeReader = { revision: string; list(): string[]; read(path: string): string | null }
type Problems = { problems: { code: string }[] }
const { guardedClosure, guardRepository, guardVerdict, relativeSpecifiers } = (await load(
  'scripts/ci/base-guard.ts'
)) as {
  guardedClosure: (read: (path: string) => string | null) => { files: string[]; unresolved: string[] }
  guardRepository: (root: string, base: string, head: string) => Guard
  guardVerdict: (changed: string[], read: (path: string) => string | null) => Guard
  relativeSpecifiers: (text: string) => string[]
}
const { GOVERNANCE_OBLIGATIONS } = (await load('scripts/ci/governance-obligations.ts')) as {
  GOVERNANCE_OBLIGATIONS: { id: string; job: string; step?: string; when: string }[]
}
const { buildCiPlan, ciSelection, githubOutputs, readGuard, SANDBOX_SUITE_TEST, scheduleCheck } = (await load(
  'scripts/ci/impact-plan.ts'
)) as {
  buildCiPlan: (input: Record<string, unknown>) => CiPlan
  ciSelection: (root: string, base: string, head: string) => { plan: SelectionPlan }
  githubOutputs: (plan: CiPlan) => string
  readGuard: (path: string | undefined) => Guard | null
  SANDBOX_SUITE_TEST: string
  scheduleCheck: (tree: TreeReader, view: unknown, decision: unknown) => Problems
}
const { syntheticCommit } = (await load('scripts/ci/replay.ts')) as {
  syntheticCommit: (root: string, base: string, changes: Record<string, unknown>) => string
}
const { readTestInventory, revisionReader } = (await load('scripts/test-suites/inventory-check.ts')) as {
  readTestInventory: (root: string, options: { head: string }) => { head: unknown }
  revisionReader: (root: string, revision: string) => TreeReader
}
const { repositorySelection } = (await load('scripts/test-suites/repository-selection.ts')) as {
  repositorySelection: (root: string, options: Record<string, unknown>) => SelectionPlan
}
/** A commit every full clone of the default branch holds: the base every fixture change applies to. */
const BASE = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'apps/cli/tests/fixtures/ci-impact/replay.json'), 'utf8')) as { base: string }
).base
const PLAN = { verdict: 'plan' as const, reason: 'the fixture plans past the guard', guarded: [] }
/** A module that appends straight to a log outbox file. */
const OUTBOX_WRITER = [
  "import { appendFileSync } from 'node:fs'",
  '',
  'export function write(outbox: string, line: string): void {',
  "  appendFileSync(outbox, line + '\\n')",
  '}',
  ''
].join('\n')

const at = (base: string) => {
  const tree = revisionReader(REPO_ROOT, base)
  return (path: string) => (tree.list().includes(path) ? tree.read(path) : null)
}

describe('the base guard', () => {
  it('imports nothing but the runtime, so it can run from the base commit alone', () => {
    const text = readFileSync(join(REPO_ROOT, 'scripts/ci/base-guard.ts'), 'utf8')
    const specifiers = [...text.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1] as string)
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) expect(specifier.startsWith('node:')).toBe(true)
    expect(relativeSpecifiers(text)).toEqual([])
  })

  it('runs as a copy outside the checkout and answers for the change it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-base-guard-'))
    try {
      copyFileSync(join(REPO_ROOT, 'scripts/ci/base-guard.ts'), join(dir, 'base-guard.ts'))
      const run = (head: string) =>
        // As the workflow runs it: from its own folder, the repository named.
        spawnSyncBudgeted('bun', ['./base-guard.ts', '--repo', REPO_ROOT, '--base', BASE, '--head', head], {
          cwd: dir,
          encoding: 'utf8',
          env: stripVinayaEnv()
        })
      const same = run(BASE)
      expect(same.status).toBe(0)
      expect(JSON.parse(same.stdout)).toMatchObject({ verdict: 'plan' })
      const workflow = run(syntheticCommit(REPO_ROOT, BASE, { '.github/workflows/ci.yml': { append: '# guard' } }))
      expect(JSON.parse(workflow.stdout)).toMatchObject({ verdict: 'full', guarded: ['.github/workflows/ci.yml'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("guards the planner's whole closure at the base, every planning folder and every runner and manifest input", () => {
    const read = at(BASE)
    const { files, unresolved } = guardedClosure(read)
    expect(unresolved).toEqual([])
    // The selection library's whole runtime and type closure, not only its entrypoint.
    for (const file of [
      'apps/cli/src/lib/verification/selector.ts',
      'apps/cli/src/lib/verification/types.ts',
      'apps/cli/src/lib/ts-module-graph.ts',
      'scripts/test-suites/repository-selection.ts',
      'scripts/test-suites/schedule.ts'
    ])
      expect(files).toContain(file)
    for (const path of [
      'scripts/ci/impact-plan.ts',
      'scripts/ci/base-guard.ts',
      'scripts/ci/governance-obligations.ts',
      'apps/cli/src/lib/verification/README.md',
      'apps/cli/src/lib/verification/selector.ts',
      'apps/cli/src/lib/config.ts',
      'scripts/test-suites/inventory.json',
      'apps/cli/tests/ci-shards/shard-3.txt',
      '.github/workflows/ci.yml',
      '.github/workflows/sandbox-conformance-macos.yml',
      'packages/aeg-core/package.json',
      'packages/aeg-core/vitest.config.ts',
      'processes/vinaya/bunfig.toml',
      'apps/cli/tsconfig.json',
      'bun.lock',
      'turbo.json',
      'biome.json',
      'vinaya.config.json'
    ])
      expect(guardVerdict([path], read)).toMatchObject({ verdict: 'full', guarded: [path] })
    for (const path of ['apps/cli/src/lib/push-progress-observer.ts', 'README.md', 'aeg-root/roles/developer.md'])
      expect(guardVerdict([path], read).verdict).toBe('plan')
  })

  it('runs everything when the closure cannot be read whole, ignoring imports a comment only quotes', () => {
    const tree: Record<string, string> = {
      'scripts/ci/impact-plan.ts': "// from './quoted.js'\nimport { a } from './missing.js'\n"
    }
    const read = (path: string) => tree[path] ?? null
    expect(guardVerdict(['README.md'], read)).toMatchObject({ verdict: 'full' })
    tree['scripts/ci/missing.ts'] = 'export const a = 1\n'
    expect(guardVerdict(['README.md'], read).verdict).toBe('plan')
    expect(guardVerdict(['scripts/ci/missing.ts'], read).verdict).toBe('full')
  })

  it('reads an unreadable revision as a reason to run everything', () => {
    expect(guardRepository(REPO_ROOT, 'f'.repeat(40), BASE)).toMatchObject({ verdict: 'full' })
  })
})

describe('the CI plan', () => {
  let writer: string
  let tested: string
  let plan: CiPlan
  let merged: CiPlan

  beforeAll(() => {
    // A new module that appends to the log outbox, imported by no test.
    writer = syntheticCommit(REPO_ROOT, BASE, { 'apps/cli/src/lib/plan-outbox-writer.ts': { content: OUTBOX_WRITER } })
    // The tree CI tests: the same change merged with a base that moved on.
    tested = syntheticCommit(REPO_ROOT, BASE, {
      'apps/cli/src/lib/plan-outbox-writer.ts': { content: OUTBOX_WRITER },
      'README.md': { append: 'the base moved on' }
    })
    plan = buildCiPlan({
      repoRoot: REPO_ROOT,
      event: 'pull_request',
      base: BASE,
      approvedHead: writer,
      testedTree: writer,
      guard: PLAN
    })
    merged = buildCiPlan({
      repoRoot: REPO_ROOT,
      event: 'pull_request',
      base: BASE,
      approvedHead: writer,
      testedTree: tested,
      guard: PLAN
    })
  }, 120_000)

  it('records the approved head and the tested tree apart, and both are part of its identity', () => {
    expect(merged.approvedHead).toBe(writer)
    expect(merged.testedTree).toBe(tested)
    expect(merged.approvedHead).not.toBe(merged.testedTree)
    expect(merged.identity).not.toBe(plan.identity)
    expect(merged.changed).toContain('README.md')
    expect(plan.valid).toBe(true)
    expect(merged.valid).toBe(true)
  })

  it('a new outbox writer no test imports still runs the outbox scanner, kept by the always-run list', () => {
    const scanner = plan.tests.find((t) => t.test === 'apps/cli/tests/lib/log-callers.test.ts')
    expect(scanner).toBeDefined()
    expect(scanner?.why.some((w) => w.startsWith('obligation pre-push-always-run: unmodeled input:'))).toBe(true)
  })

  it('takes its tests from the shared selection: for the same commits and depth, local and CI require the same tests', () => {
    const local = repositorySelection(REPO_ROOT, { base: BASE, head: writer, consumer: 'local', depth: 'transitive' })
    const ci = ciSelection(REPO_ROOT, BASE, writer).plan
    expect(ci.required).toEqual(local.required)
    expect(ci.fallbacks).toEqual(local.fallbacks)
    expect(ci.context.base).toBe(local.context.base)
    expect(ci.context.head).toBe(local.context.head)
    // CI's additions are stated obligations, never folded into what the change requires.
    const added = [...new Set(ci.obligations.map((o) => o.obligation))].sort()
    expect(added).toEqual(['inventory-gate', 'pre-push-always-run'])
    for (const o of ci.obligations.filter((x) => x.obligation === 'pre-push-always-run'))
      expect(o.reason.startsWith('unmodeled input:')).toBe(true)
  }, 60_000)

  it('covers the local push it defers: every test the depth-one local plan names runs in CI', () => {
    const local = repositorySelection(REPO_ROOT, { base: BASE, head: writer, consumer: 'local' })
    const ran = new Set(plan.tests.map((t) => t.test))
    expect(plannedTests(local).filter((test) => !ran.has(test))).toEqual([])
  }, 60_000)

  it('explains what it runs and what it does not', () => {
    expect(plan.tests.every((t) => t.why.length > 0)).toBe(true)
    expect(plan.unselected.length).toBeGreaterThan(0)
    expect(plan.unselected.every((u) => u.reason.length > 0)).toBe(true)
    for (const [job, decision] of Object.entries(plan.jobs)) expect(decision.reason.length, job).toBeGreaterThan(0)
    expect(plan.obligations.map((o) => o.id)).toEqual(
      GOVERNANCE_OBLIGATIONS.filter((o) => o.when === 'every-run').map((o) => o.id)
    )
  })

  it('starts the Linux sandbox suite only when the change reaches it through its SUITE_INPUTS or its imports', () => {
    expect(plan.jobs['sandbox-conformance'].required).toBe(plan.tests.some((t) => t.test === SANDBOX_SUITE_TEST))
    // A path the suite's own list names, read from the list itself.
    const input = SUITE_INPUTS.find((path) => path === 'apps/cli/src/lib/worker-boundary.ts')
    expect(input).toBeDefined()
    const reached = buildCiPlan({
      repoRoot: REPO_ROOT,
      event: 'pull_request',
      base: BASE,
      approvedHead: syntheticCommit(REPO_ROOT, BASE, { [input as string]: { append: '// a sandbox input' } }),
      testedTree: syntheticCommit(REPO_ROOT, BASE, { [input as string]: { append: '// a sandbox input' } }),
      guard: PLAN
    })
    expect(reached.jobs['sandbox-conformance'].required).toBe(true)
    expect(reached.jobs['sandbox-conformance-macos'].required).toBe(false)
  }, 60_000)

  it('runs everything, with its reason, without a guard verdict, against a full verdict, and on every push', () => {
    const none = buildCiPlan({
      repoRoot: REPO_ROOT,
      event: 'pull_request',
      base: BASE,
      approvedHead: writer,
      testedTree: writer
    })
    expect(none).toMatchObject({
      scope: 'full',
      reason: 'the base guard: no base guard verdict was given',
      valid: true
    })
    expect(none.decision).toEqual({ scope: 'all', reason: 'the base guard: no base guard verdict was given' })
    expect(none.jobs['sandbox-conformance'].required).toBe(true)
    const push = buildCiPlan({
      repoRoot: REPO_ROOT,
      event: 'push',
      base: BASE,
      approvedHead: writer,
      testedTree: writer,
      guard: PLAN
    })
    expect(push).toMatchObject({ scope: 'full', reason: 'a push to the default branch runs every job and every test' })
    expect(push.obligations.map((o) => o.id)).toContain('selector-oracle')
    const unknown = buildCiPlan({
      repoRoot: REPO_ROOT,
      event: 'pull_request',
      base: 'f'.repeat(40),
      approvedHead: writer,
      testedTree: writer,
      guard: PLAN,
      fetch: () => {
        throw new Error('not in this checkout')
      }
    })
    expect(unknown.scope).toBe('full')
    expect(unknown.reason).toContain('the comparison revisions could not be resolved')
  }, 60_000)

  it('reads an absent, unreadable or malformed guard verdict as none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-guard-file-'))
    try {
      expect(readGuard(undefined)).toBeNull()
      expect(readGuard(join(dir, 'absent.json'))).toBeNull()
      writeFileSync(join(dir, 'bad.json'), '{"verdict":"skip"}')
      expect(readGuard(join(dir, 'bad.json'))).toBeNull()
      writeFileSync(join(dir, 'ok.json'), '{"verdict":"plan","reason":"r","guarded":[]}')
      expect(readGuard(join(dir, 'ok.json'))).toEqual({ verdict: 'plan', reason: 'r', guarded: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is invalid when the schedule doubles or invents a test', () => {
    const view = readTestInventory(REPO_ROOT, { head: BASE }).head
    const real = revisionReader(REPO_ROOT, BASE)
    const shard = (n: number) => `apps/cli/tests/ci-shards/shard-${n}.txt`
    const listed = (real.read(shard(2)) ?? '').split('\n').filter(Boolean)
    const tree = (overrides: Record<string, string>): TreeReader => ({
      revision: BASE,
      list: () => real.list(),
      read: (path) => overrides[path] ?? real.read(path)
    })
    expect(scheduleCheck(real, view, { scope: 'all', reason: 'every test' }).problems).toEqual([])
    const doubled = scheduleCheck(tree({ [shard(1)]: `${real.read(shard(1))}${listed[0]}\n` }), view, {
      scope: 'all',
      reason: 'every test'
    })
    expect(doubled.problems.map((p) => p.code)).toContain('duplicate')
    const invented = scheduleCheck(tree({ [shard(1)]: `${real.read(shard(1))}tests/never.test.ts\n` }), view, {
      scope: 'all',
      reason: 'every test'
    })
    expect(invented.problems.map((p) => p.code)).toContain('extra')
  })
})

describe('the workflow the plan drives', () => {
  type Job = {
    name?: string
    needs?: string | string[]
    steps?: { name?: string; run?: string }[]
    outputs?: Record<string, string>
  }
  const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: Record<string, Job>
  }

  it('keeps the job names and build-only dependencies the loop reader keys on, and adds no planning job', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(
      ['aggregate', 'build', 'sandbox-conformance', 'test-cli', 'test-cli-config-anchor', 'test-shared-packages'].sort()
    )
    expect(workflow.jobs.build?.name).toBe('Build, lint & typecheck')
    expect(workflow.jobs.build?.needs).toBeUndefined()
    for (const job of ['test-cli', 'test-shared-packages', 'test-cli-config-anchor', 'sandbox-conformance'])
      expect(workflow.jobs[job]?.needs).toBe('build')
    expect(workflow.jobs['sandbox-conformance']?.name).toBe('Sandbox conformance (Linux)')
    expect(workflow.jobs.aggregate?.name).toBe('Vinaya CI')
  })

  it('names every governance step the plan records, and runs the one sandbox test the plan decides on', () => {
    const steps = Object.entries(workflow.jobs).flatMap(([job, j]) => (j.steps ?? []).map((s) => `${job}:${s.name}`))
    for (const o of GOVERNANCE_OBLIGATIONS.filter((x) => x.step)) expect(steps).toContain(`${o.job}:${o.step}`)
    const sandbox = workflow.jobs['sandbox-conformance']?.steps?.find(
      (s) => s.name === 'Run the suite under both sandboxes'
    )
    expect(sandbox?.run).toContain(SANDBOX_SUITE_TEST.replace('apps/cli/', ''))
  })

  it('every plan output a job reads is one the plan step writes', () => {
    const plan = buildCiPlan({
      repoRoot: REPO_ROOT,
      event: 'pull_request',
      base: BASE,
      approvedHead: BASE,
      testedTree: BASE,
      guard: PLAN
    })
    const written = new Set([...githubOutputs(plan).matchAll(/^([a-z_]+)<</gm)].map((m) => m[1] as string))
    const text = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
    for (const m of text.matchAll(/steps\.plan\.outputs\.([a-z_]+)/g))
      expect(written.has(m[1] as string), m[1]).toBe(true)
    const exported = new Set(Object.keys(workflow.jobs.build?.outputs ?? {}))
    for (const m of text.matchAll(/needs\.build\.outputs\.([a-z_]+)/g))
      expect(exported.has(m[1] as string), m[1]).toBe(true)
  }, 60_000)
})
