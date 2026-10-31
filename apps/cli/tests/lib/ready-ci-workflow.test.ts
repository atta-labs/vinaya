/**
 * This repository's hand-written CI, as the required check a deferred version-2 run waits on: both test jobs run on
 * documentation-only pull requests too, as does the build job's inventory check and repository suite, and the
 * `Vinaya CI` aggregate's own shell — executed here, not read — refuses
 * any failed, cancelled or skipped mandatory job while the root-config probe alone may be skipped.
 */
import { describe, expect, it } from 'bun:test'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { READY_TESTS_CHECK, READY_TESTS_WORKFLOW } from '../../src/lib/pre-push-ready-policy.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const workflow = parse(readFileSync(join(REPO_ROOT, READY_TESTS_WORKFLOW), 'utf8')) as {
  jobs: Record<string, { name?: string; if?: string; needs?: string[]; steps?: { name?: string; run?: string }[] }>
}
const MANDATORY = ['build', 'test-shared-packages', 'test-cli', 'sandbox-conformance']
const PROBE = 'test-cli-config-anchor'

/** The aggregate's verdict step, run with each upstream job's result substituted as Actions would. */
function aggregate(results: Record<string, string>): { status: number | null; out: string } {
  const step = workflow.jobs.aggregate?.steps?.find((s) => s.run?.includes('needs.'))
  if (!step?.run) throw new Error('the aggregate has no verdict step')
  const script = step.run.replace(/\$\{\{\s*needs\.([a-z-]+)\.result\s*\}\}/g, (_whole, job: string) => {
    if (!(job in results)) throw new Error(`no result given for ${job}`)
    return results[job] as string
  })
  const run = spawnSyncBudgeted('sh', ['-c', script], { encoding: 'utf8', env: stripVinayaEnv() })
  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

const allSucceeded = () => Object.fromEntries([...MANDATORY, PROBE].map((job) => [job, 'success']))

describe('the required CI check a deferred run waits on', () => {
  it('is the aggregate job of the configured workflow, depending on every mandatory job and the probe', () => {
    expect(workflow.jobs.aggregate?.name).toBe(READY_TESTS_CHECK)
    expect(workflow.jobs.aggregate?.if).toBe('always()')
    expect([...(workflow.jobs.aggregate?.needs ?? [])].sort()).toEqual([...MANDATORY, PROBE].sort())
  })

  it('both test jobs run on documentation-only pull requests: no docs-only skip', () => {
    for (const job of ['test-shared-packages', 'test-cli']) expect(workflow.jobs[job]?.if).toBeUndefined()
    // The root-config probe stays conditional, and the transitive selection with its whole-list fallback stays.
    expect(workflow.jobs[PROBE]?.if).toContain('config_changed')
    const cliSteps = workflow.jobs['test-cli']?.steps?.map((s) => s.run ?? '').join('\n') ?? ''
    expect(cliSteps).toContain('ci-test-selection.ts')
    expect(cliSteps).toContain('this shard runs its whole list')
  })

  it('the build job checks the test inventory and runs the repository suite on every pull request, docs-only included', () => {
    const build = workflow.jobs.build
    expect(build?.if).toBeUndefined()
    const steps = build?.steps ?? []
    const at = steps.findIndex((s) => s.name === 'Check the test inventory and run the repository suite')
    expect(at).toBeGreaterThan(-1)
    const step = steps[at] as { if?: string; run?: string }
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

  it('passes when every mandatory job succeeded, with the probe run or skipped', () => {
    expect(aggregate(allSucceeded()).status).toBe(0)
    expect(aggregate({ ...allSucceeded(), [PROBE]: 'skipped' }).status).toBe(0)
  })

  for (const job of MANDATORY)
    for (const result of ['failure', 'cancelled', 'skipped'])
      it(`refuses when ${job} ended ${result}`, () => {
        const run = aggregate({ ...allSucceeded(), [job]: result })
        expect(run.status).toBe(1)
        expect(run.out).toContain(`vinaya-needs: a required job ended ${result}`)
      })

  for (const result of ['failure', 'cancelled'])
    it(`refuses when the root-config probe ended ${result}`, () => {
      expect(aggregate({ ...allSucceeded(), [PROBE]: result }).status).toBe(1)
    })
})
