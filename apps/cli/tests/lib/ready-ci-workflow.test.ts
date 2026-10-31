/**
 * This repository's hand-written CI, as the required check a deferred version-2 run waits on: one CI plan computed
 * inside the build job decides what every other job runs, both test jobs run on documentation-only pull requests too,
 * as does the build job's inventory check and repository suite, and the `Vinaya CI` aggregate's own shell — executed
 * here, not read — refuses a missing, invalid or foreign plan and any failed, cancelled or skipped job the plan
 * requires, while a job the plan does not require may be skipped.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { READY_TESTS_CHECK, READY_TESTS_WORKFLOW } from '../../src/lib/pre-push-ready-policy.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
type Step = {
  name?: string
  id?: string
  if?: string
  run?: string
  env?: Record<string, string>
  'continue-on-error'?: boolean
}
type Job = { name?: string; if?: string; needs?: string | string[]; steps?: Step[] }
const workflow = parse(readFileSync(join(REPO_ROOT, READY_TESTS_WORKFLOW), 'utf8')) as { jobs: Record<string, Job> }
const macos = parse(readFileSync(join(REPO_ROOT, '.github/workflows/sandbox-conformance-macos.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}
const MANDATORY = ['build', 'test-shared-packages', 'test-cli']
const PLANNED = ['test-cli-config-anchor', 'sandbox-conformance']
const PROBE = 'test-cli-config-anchor'
const HEAD = 'a'.repeat(40)
const TESTED = 'b'.repeat(40)
/** An Actions expression's opening, spelled so no linter reads it as a template placeholder. */
const EXPR = '$' + '{{'

type Run = {
  event?: string
  results?: Record<string, string>
  outputs?: Record<string, string>
}

/** A valid plan that requires both conditional jobs, every job of which succeeded. */
function base(): Required<Run> {
  return {
    event: 'pull_request',
    results: Object.fromEntries([...MANDATORY, ...PLANNED].map((job) => [job, 'success'])),
    outputs: {
      plan_identity: 'c'.repeat(64),
      plan_valid: 'true',
      plan_scope: 'selected',
      plan_head: HEAD,
      plan_tested: TESTED,
      guard_verdict: 'plan',
      required_jobs: 'build test-cli test-shared-packages test-cli-config-anchor sandbox-conformance aggregate',
      shadow_state: 'none',
      shadow_jobs: ''
    }
  }
}

/** The aggregate's verdict step, run with each expression substituted as Actions would. */
function aggregate(run: Run): { status: number | null; out: string } {
  const step = workflow.jobs.aggregate?.steps?.find((s) => s.env?.REQUIRED_JOBS)
  if (!step?.run || !step.env) throw new Error('the aggregate has no verdict step')
  const b = base()
  const results = { ...b.results, ...run.results }
  const outputs = { ...b.outputs, ...run.outputs }
  const event = run.event ?? b.event
  const value = (expression: string): string => {
    const e = expression.trim()
    if (e === 'github.event_name') return event
    if (e === 'github.event.pull_request.head.sha || github.sha') return event === 'push' ? TESTED : HEAD
    if (e === 'github.sha') return TESTED
    const result = /^needs\.([a-z-]+)\.result$/.exec(e)
    if (result) {
      if (!((result[1] as string) in results)) throw new Error(`no result given for ${result[1]}`)
      return results[result[1] as string] as string
    }
    const output = /^needs\.build\.outputs\.([a-z_]+)$/.exec(e)
    if (output) return outputs[output[1] as string] ?? ''
    throw new Error(`no value for ${e}`)
  }
  const env: Record<string, string> = { ...stripVinayaEnv() } as Record<string, string>
  for (const [key, raw] of Object.entries(step.env))
    env[key] = raw.replace(/\$\{\{([^}]*)\}\}/g, (_whole, expression: string) => value(expression))
  expect(step.run).not.toContain(EXPR)
  const spawned = spawnSyncBudgeted('sh', ['-c', step.run], { encoding: 'utf8', env })
  return { status: spawned.status, out: `${spawned.stdout}${spawned.stderr}` }
}

describe('the required CI check a deferred run waits on', () => {
  it('is the aggregate job of the configured workflow, depending on every planned job', () => {
    expect(workflow.jobs.aggregate?.name).toBe(READY_TESTS_CHECK)
    expect(workflow.jobs.aggregate?.if).toBe('always()')
    expect([...(workflow.jobs.aggregate?.needs ?? [])].sort()).toEqual([...MANDATORY, ...PLANNED].sort())
  })

  it('every test and sandbox job depends on the build job alone, and only the planned jobs are conditional', () => {
    for (const job of ['test-shared-packages', 'test-cli', ...PLANNED]) expect(workflow.jobs[job]?.needs).toBe('build')
    for (const job of ['test-shared-packages', 'test-cli']) expect(workflow.jobs[job]?.if).toBeUndefined()
    expect(workflow.jobs[PROBE]?.if).toBe("needs.build.outputs.config_changed == 'true'")
    expect(workflow.jobs['sandbox-conformance']?.if).toBe("needs.build.outputs.sandbox == 'true'")
    expect(workflow.jobs['sandbox-conformance']?.name).toBe('Sandbox conformance (Linux)')
  })

  it('both test jobs run what the build job planned on documentation-only pull requests too, and refuse without a plan', () => {
    const steps = [
      ...(workflow.jobs['test-cli']?.steps ?? []),
      ...(workflow.jobs['test-shared-packages']?.steps ?? [])
    ].filter((s) => s.if === "github.event_name == 'pull_request'")
    expect(steps).toHaveLength(2)
    for (const step of steps) {
      expect(step.env?.CI_PLAN_DECISION).toBe(`${EXPR} needs.build.outputs.decision }}`)
      expect(step.env?.CI_PLAN_TESTED).toBe(`${EXPR} needs.build.outputs.plan_tested }}`)
      expect(step.run).toContain('This job has no CI plan for the tree it checked out; it refuses.')
      expect(step.run).toContain('--decision "$DECISION"')
      // One plan decides: no test job runs a selection of its own.
      expect(step.run).not.toContain('ci-test-selection.ts')
      expect(step.run).not.toContain('repository-selection.ts')
    }
  })

  it('the build job computes the plan after installing and before lint, typecheck and every test step', () => {
    const steps = workflow.jobs.build?.steps ?? []
    const at = (name: string) => steps.findIndex((s) => s.name === name)
    const plan = steps[at("Build this pull request's CI plan")] as Step
    expect(plan.id).toBe('plan')
    expect(plan.if).toBeUndefined()
    expect(at('Install dependencies')).toBeLessThan(at("Build this pull request's CI plan"))
    for (const later of ['Lint and format', 'Typecheck', 'Check the test inventory and run the repository suite'])
      expect(at("Build this pull request's CI plan")).toBeLessThan(at(later))
    // The guard is the base commit's copy, run before the candidate planner.
    expect(plan.run).toContain('git show "$BASE_SHA:scripts/ci/base-guard.ts" > "$PLAN_DIR/base-guard.ts"')
    expect(plan.run?.indexOf('base-guard.ts')).toBeLessThan(plan.run?.indexOf('scripts/ci/impact-plan.ts') ?? -1)
    // From its own folder, so no configuration the pull request commits loads into it.
    expect(plan.run).toContain('(cd "$PLAN_DIR" && bun ./base-guard.ts --repo "$GITHUB_WORKSPACE"')
    expect(plan.run).toContain('--guard "$GUARD"')
    expect(steps[at('Lint and format')]?.if).toBe("steps.plan.outputs.lint_scope != 'skip'")
    expect(steps[at('Typecheck')]?.if).toBe("steps.plan.outputs.typecheck_scope != 'skip'")
  })

  it('the build job checks the test inventory and runs the repository suite on every pull request, docs-only included', () => {
    const build = workflow.jobs.build
    expect(build?.if).toBeUndefined()
    const steps = build?.steps ?? []
    const at = steps.findIndex((s) => s.name === 'Check the test inventory and run the repository suite')
    expect(at).toBeGreaterThan(-1)
    const step = steps[at] as Step
    expect(step.if).toBeUndefined()
    expect(step.run).toContain('bun scripts/test-suites/inventory-check.ts')
    for (const test of [
      'scripts/vinaya-checks/ui-rules.test.ts',
      'scripts/vinaya-checks/process-version-bump.test.ts',
      'scripts/test-suites/inventory-check.test.ts',
      'scripts/test-suites/relocation-fixture.test.ts'
    ])
      expect(step.run).toContain(`./${test}`)
    // It runs before the job's failure-only reports, which must stay last.
    expect(at).toBeLessThan(steps.findIndex((s) => s.name === "Report this job's GitHub token budget"))
  })

  it('the macOS sandbox suite is advisory: its own workflow, never needed, its failure recorded without failing', () => {
    expect(workflow.jobs['sandbox-conformance-macos']).toBeUndefined()
    const job = macos.jobs['sandbox-conformance-macos']
    expect(job?.name).toBe('Sandbox conformance (macOS)')
    const suite = job?.steps?.find((s) => s.name === 'Run the suite under both sandboxes')
    expect(suite?.['continue-on-error']).toBe(true)
    expect(job?.steps?.find((s) => s.name === 'Record the advisory suite result')?.if).toBe(`${EXPR} !cancelled() }}`)
  })

  it('passes when the plan is valid and bound, and every job it requires succeeded', () => {
    expect(aggregate({}).status).toBe(0)
  })

  it('accepts a skip of a job the plan does not require, never of one it does', () => {
    const unrequired = { required_jobs: 'build test-cli test-shared-packages aggregate' }
    for (const job of PLANNED) {
      expect(aggregate({ outputs: unrequired, results: { [job]: 'skipped' } }).status).toBe(0)
      const run = aggregate({ results: { [job]: 'skipped' } })
      expect(run.status).toBe(1)
      expect(run.out).toContain('vinaya-needs: a required job ended skipped')
    }
  })

  for (const job of MANDATORY)
    for (const result of ['failure', 'cancelled', 'skipped'])
      it(`refuses when ${job} ended ${result}`, () => {
        const run = aggregate({ results: { [job]: result } })
        expect(run.status).toBe(1)
        expect(run.out).toContain(`vinaya-needs: a required job ended ${result}`)
      })

  for (const job of PLANNED)
    for (const result of ['failure', 'cancelled'])
      it(`refuses when ${job} ended ${result}, required or not`, () => {
        expect(aggregate({ results: { [job]: result } }).status).toBe(1)
        expect(
          aggregate({
            outputs: { required_jobs: 'build test-cli test-shared-packages aggregate' },
            results: { [job]: result }
          }).status
        ).toBe(1)
      })

  const refusals: [string, Record<string, string>, string][] = [
    ['no plan at all', { plan_identity: '', plan_valid: '' }, 'the CI plan is missing or invalid'],
    ['an invalid plan', { plan_valid: 'false' }, 'the CI plan is missing or invalid'],
    ['a plan for another head', { plan_head: 'd'.repeat(40) }, 'the CI plan is bound to another head or tree'],
    ['a plan for another tested tree', { plan_tested: 'e'.repeat(40) }, 'the CI plan is bound to another head or tree'],
    [
      'a narrowed plan the base guard asked to run everything',
      { guard_verdict: 'full', plan_scope: 'selected' },
      'the CI plan narrowed against the base guard'
    ],
    [
      'a plan that drops a mandatory job',
      { required_jobs: 'build test-cli aggregate' },
      'the CI plan drops a mandatory job'
    ]
  ]
  for (const [what, outputs, line] of refusals)
    it(`refuses ${what}`, () => {
      const run = aggregate({ outputs })
      expect(run.status).toBe(1)
      expect(run.out).toContain(`vinaya-needs: ${line}`)
    })

  it('accepts a full plan the base guard asked for', () => {
    expect(aggregate({ outputs: { guard_verdict: 'full', plan_scope: 'full' } }).status).toBe(0)
  })

  it('on a push to main, flags a failed job outside the shadow plan and calls a missing shadow inconclusive', () => {
    const push = { event: 'push', outputs: { plan_head: TESTED, plan_scope: 'full', guard_verdict: 'full' } }
    const outside = aggregate({
      ...push,
      outputs: { ...push.outputs, shadow_state: 'available', shadow_jobs: 'build test-cli' },
      results: { 'test-shared-packages': 'failure' }
    })
    expect(outside.status).toBe(1)
    expect(outside.out).toContain(
      'vinaya-shadow: test-shared-packages ended failure outside the shadow pull-request plan'
    )
    const inside = aggregate({
      ...push,
      outputs: { ...push.outputs, shadow_state: 'available', shadow_jobs: 'build test-cli' },
      results: { 'test-cli': 'failure' }
    })
    expect(inside.out).toContain('vinaya-shadow: test-cli ended failure inside the shadow pull-request plan')
    const none = aggregate({
      ...push,
      outputs: { ...push.outputs, shadow_state: 'inconclusive' },
      results: { 'test-cli': 'failure' }
    })
    expect(none.out).toContain('no shadow plan to compare, inconclusive')
    expect(aggregate(push).status).toBe(0)
  })
})
