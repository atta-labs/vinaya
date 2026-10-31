/**
 * The independent job oracle for the CI plan (`scripts/ci/impact-plan.ts`).
 *
 * Two sources of expectation, neither produced by the planner, the base
 * guard, the selection or the schedule:
 *
 * - the hand-written table of `fixtures/ci-impact/replay.json`: per fixture
 *   change, the jobs, packages, files, tests and duties its plan must hold —
 *   builds, type-only changes, lint, data readers, native suites,
 *   configuration contexts, sandbox inputs, a change no test reads, an
 *   unmodeled input and a relocation;
 * - the native task graph: `turbo run build typecheck test --dry=json`, with
 *   each changed file mapped to its package from the root and workspace
 *   manifests read here, gives every package whose typecheck task depends on
 *   a changed one. The planner must typecheck at least those.
 *
 * Each fixture also removes one required duty at a time from the real plan;
 * every such omission must be caught.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

// The repository's CI scripts sit outside this package's type program, so they load by path, never by a
// static import; the inventory declares them as this test's code input.
type CiPlan = { scope: string; changed: string[]; steps: { typecheck: { scope: string; items: string[] } } }
type ReplayCase = { id: string; category: string; mutants: string[]; expect: unknown }
const { judgePlan, mutatePlan, readBundle, replayCase } = (await import(join(REPO_ROOT, 'scripts/ci/replay.ts'))) as {
  readBundle: (path: string) => { base: string; cases: ReplayCase[] }
  replayCase: (root: string, base: string, replay: ReplayCase) => { misses: string[]; uncaught: string[]; plan: CiPlan }
  judgePlan: (plan: CiPlan, expect: unknown) => string[]
  mutatePlan: (plan: CiPlan, mutant: string) => CiPlan
}
const bundle = readBundle(join(REPO_ROOT, 'apps/cli/tests/fixtures/ci-impact/replay.json'))

/** Package folder → name, from the root manifest's workspaces and each member's own manifest. */
function workspacePackages(): { dir: string; name: string }[] {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces: string[] }
  const out: { dir: string; name: string }[] = []
  for (const glob of root.workspaces) {
    const dirs = glob.endsWith('/*')
      ? (new Bun.Glob(`${glob.slice(0, -2)}/*/package.json`).scanSync({ cwd: REPO_ROOT }) as Iterable<string>)
      : [`${glob}/package.json`]
    for (const manifest of dirs) {
      if (!existsSync(join(REPO_ROOT, manifest))) continue
      out.push({
        dir: dirname(manifest),
        name: (JSON.parse(readFileSync(join(REPO_ROOT, manifest), 'utf8')) as { name: string }).name
      })
    }
  }
  return out
}

/** Package → every package whose typecheck task depends on its typecheck task, transitively, from turbo's own graph. */
function typecheckDependents(): Map<string, Set<string>> {
  const run = spawnSyncBudgeted(
    'bunx',
    ['turbo', 'run', 'build', 'typecheck', 'test', '--dry=json'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...stripVinayaEnv(), TURBO_TELEMETRY_DISABLED: '1' } },
    60_000
  )
  expect(run.status).toBe(0)
  const dry = JSON.parse(run.stdout) as {
    tasks: { taskId: string; package: string; task: string; dependents: string[] }[]
  }
  const direct = new Map<string, Set<string>>()
  for (const task of dry.tasks.filter((t) => t.task === 'typecheck'))
    direct.set(
      task.package,
      new Set(task.dependents.filter((d) => d.endsWith('#typecheck')).map((d) => d.slice(0, d.lastIndexOf('#'))))
    )
  const closure = new Map<string, Set<string>>()
  for (const pkg of direct.keys()) {
    const seen = new Set<string>([pkg])
    const queue = [pkg]
    while (queue.length > 0)
      for (const next of direct.get(queue.shift() as string) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    closure.set(pkg, seen)
  }
  return closure
}

const packages = workspacePackages()
const dependents = typecheckDependents()

/** The packages turbo's graph says must be typechecked for these changed paths. */
function turboExpectation(changed: readonly string[]): string[] {
  const owners = new Set<string>()
  for (const path of changed) {
    if (!/\.(c|m)?(j|t)sx?$|\.json$/.test(path)) continue
    const owner = packages.filter((p) => path.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]
    if (owner) owners.add(owner.name)
  }
  return [...new Set([...owners].flatMap((pkg) => [...(dependents.get(pkg) ?? [])]))].sort()
}

/** The oracle's verdict on a plan's typecheck step against turbo's graph: the packages it misses. */
function typecheckMisses(plan: CiPlan, expected: readonly string[]): string[] {
  if (plan.scope === 'full' || plan.steps.typecheck.scope === 'all') return []
  return expected.filter((pkg) => !plan.steps.typecheck.items.includes(pkg))
}

describe('the job oracle', () => {
  it('reads a task graph that holds every workspace package with a typecheck task', () => {
    expect(dependents.get('@attalabs/aeg-types')).toContain('@attalabs/aeg-core')
    expect(dependents.get('@attalabs/aeg-types')).toContain('@vinaya/portal')
    expect(packages.map((p) => p.name)).toContain('@attalabs/vinaya')
  })

  it('covers every job category the plan decides', () => {
    expect([...new Set(bundle.cases.map((c) => c.category))].sort()).toEqual(
      [
        'build',
        'configuration-context',
        'doc-data-reader',
        'empty-with-governance',
        'lint',
        'native-suite',
        'relocation',
        'sandbox-input',
        'type-only',
        'unknown-fallback'
      ].sort()
    )
    // Each omission kind CI must never lose is exercised by at least one mutant.
    const mutants = bundle.cases.flatMap((c) => c.mutants)
    for (const kind of [
      'job:sandbox-conformance',
      'job:test-cli-config-anchor',
      'typecheck:',
      'lint:',
      'test:',
      'obligation:'
    ])
      expect(mutants.some((m) => m.startsWith(kind))).toBe(true)
  })

  for (const replay of bundle.cases)
    it(`${replay.id} [${replay.category}]: the real plan meets the hand-written table and turbo's graph, and every omission is caught`, () => {
      const result = replayCase(REPO_ROOT, bundle.base, replay)
      expect(result.misses).toEqual([])
      expect(result.uncaught).toEqual([])

      const expected = turboExpectation(result.plan.changed)
      expect(typecheckMisses(result.plan, expected)).toEqual([])
      // Dropping any package turbo requires is an omission the graph catches.
      if (result.plan.steps.typecheck.scope === 'some')
        for (const pkg of expected)
          expect(typecheckMisses(mutatePlan(result.plan, `typecheck:${pkg}`), expected)).toEqual([pkg])
      // The unmodified plan passes and a full plan always covers the table.
      expect(judgePlan(result.plan, replay.expect)).toEqual([])
    }, 120_000)
})
