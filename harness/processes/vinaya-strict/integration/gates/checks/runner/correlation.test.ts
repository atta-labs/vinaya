import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunRecorder } from '../../../../../../kernel/log/run-recorder'
import type { CheckSpec } from '../../../../../../kernel/gates/checks/contract'
import { runChecks } from '../../../../../../kernel/gates/checks/runner'

const FIXTURES = join(import.meta.dir, '../../../../../../kernel/gates/checks/fixtures')
const PASSING = join(FIXTURES, 'passing-check.ts')

function fullScope(overrides: Partial<CheckSpec> & Pick<CheckSpec, 'name' | 'run'>): CheckSpec {
  return { scope: 'full', ...overrides }
}

const BASE_OPTS = { parallel: 1, diffOnly: false, changedFiles: null, defaultTimeoutMs: 5000 }
const PATH_ONLY = { PATH: process.env.PATH as string }

/** One process's own run handle over the shared local copy, as a real hook, CLI or CI process each opens its own. */
function processWith(dir: string, runId: string) {
  const recorder = createRunRecorder({
    runId: () => runId,
    workRef: () => '900',
    repository: () => 'atta-labs/vinaya',
    place: (repository) => ({ folder: join(dir, 'logs'), repository }),
    processIdentity: () => undefined,
    sender: () => ({ request: () => {}, remember: () => {}, drain: async () => {} }),
    home: () => dir,
    cwd: () => mkdtempSync(join(tmpdir(), 'vinaya-checks-root-')),
    onError: () => {}
  })
  const handle = recorder.handle()
  if (handle === undefined) throw new Error('the run handle did not open')
  return { checks: handle.checks, flush: () => handle.flush() }
}

/** Every `vinaya.checks` span in the local copy, with its run's trace and its attributes by name. */
function checkSpans(dir: string): Array<{ name: string; traceId: string; attributes: Record<string, unknown> }> {
  const folder = join(dir, 'logs', 'atta-labs-vinaya')
  return readdirSync(folder)
    .filter((name) => name.endsWith('.traces.jsonl'))
    .flatMap((name) => readFileSync(join(folder, name), 'utf8').trim().split('\n'))
    .map((line) => JSON.parse(line))
    .flatMap((doc) => doc.resourceSpans.flatMap((g: any) => g.scopeSpans.flatMap((s: any) => s.spans)))
    .filter((span: any) => span.name.startsWith('vinaya.checks'))
    .map((span: any) => ({
      name: span.name,
      traceId: span.traceId,
      attributes: Object.fromEntries(
        span.attributes.map((a: any) => [a.key, a.value.stringValue ?? Number(a.value.intValue)])
      )
    }))
}

/**
 * A hook, a command line and CI run are told apart by `where` on the one span a run writes, never by anything the
 * runner invents on its own. Each caller here opens its own handle under its own run id — the shape three separate
 * `vinaya` invocations have — over the same local copy.
 */
describe('runChecks — a run of checks across hook/CLI/CI callers', () => {
  it('one span per run when every check passes — a count, never one record per check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-checks-correlation-'))
    const specs = [fullScope({ name: 'a', run: PASSING }), fullScope({ name: 'b', run: PASSING })]
    await runChecks(specs, { ...BASE_OPTS, callerEnv: PATH_ONLY, log: processWith(dir, 'run-plain') })
    const spans = checkSpans(dir)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      name: 'vinaya.checks local',
      attributes: {
        'vinaya.checks.where': 'local',
        'vinaya.checks.ran': 2,
        'vinaya.checks.passed': 2,
        'vinaya.checks.failed': 0,
        'vinaya.checks.skipped': 0
      }
    })
  })

  it('the commit hook reads where "hook", the push hook "push", CI "ci" — never collapsed into plain "local"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-checks-correlation-'))
    const spec = [fullScope({ name: 'a', run: PASSING })]
    await runChecks(spec, { ...BASE_OPTS, skipFull: true, callerEnv: PATH_ONLY, log: processWith(dir, 'run-hook') })
    await runChecks(spec, { ...BASE_OPTS, localOnly: true, callerEnv: PATH_ONLY, log: processWith(dir, 'run-push') })
    await runChecks(spec, {
      ...BASE_OPTS,
      callerEnv: { ...PATH_ONLY, CI: 'true' },
      log: processWith(dir, 'run-ci')
    })
    await runChecks(spec, { ...BASE_OPTS, callerEnv: PATH_ONLY, log: processWith(dir, 'run-local') })
    expect(
      checkSpans(dir)
        .map((s) => s.attributes['vinaya.checks.where'])
        .sort()
    ).toEqual(['ci', 'hook', 'local', 'push'])
  })

  it('hook then CI on the SAME check name produce two independently-attributed spans, never one merged span', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-checks-correlation-'))
    const spec = [fullScope({ name: 'shared-check', run: PASSING })]
    await runChecks(spec, { ...BASE_OPTS, skipFull: true, callerEnv: PATH_ONLY, log: processWith(dir, 'run-hook') })
    await runChecks(spec, {
      ...BASE_OPTS,
      callerEnv: { ...PATH_ONLY, CI: 'true' },
      log: processWith(dir, 'run-ci')
    })
    const spans = checkSpans(dir)
    expect(spans).toHaveLength(2)
    // Each caller's own run stays its own — never coalesced into one trace.
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(2)
  })
})
