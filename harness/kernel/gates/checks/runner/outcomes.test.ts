import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunRecorder } from '@harness/kernel/log/run-recorder'
import type { CheckLog } from '../runner'
import type { CheckSpec } from '../contract'
import { runChecks } from '../runner'
import { storedEvents, storedSpans } from './local-copy-probe'

type NotPassed = Parameters<CheckLog['checks']['notPassed']>[0]
type Ran = Parameters<CheckLog['checks']['ran']>[0]

const FIXTURES = join(import.meta.dir, '../fixtures')
const PASSING = join(FIXTURES, 'passing-check.ts')
const FAILING = join(FIXTURES, 'failing-check.ts')
const PENDING = join(FIXTURES, 'pending-check.ts')
const MALFORMED = join(FIXTURES, 'malformed-check.ts')
const SLEEPER = join(FIXTURES, 'sleeper.ts')

function fullScope(overrides: Partial<CheckSpec> & Pick<CheckSpec, 'name' | 'run'>): CheckSpec {
  return { scope: 'full', ...overrides }
}

/** `events` holds the per-check `checked` observations (a check that did not pass); `summaries` the run's one `summary`. */
function capture(): {
  events: NotPassed[]
  summaries: Ran[]
  log: CheckLog
} {
  const events: NotPassed[] = []
  const summaries: Ran[] = []
  return {
    events,
    summaries,
    log: { checks: { notPassed: (e) => void events.push(e), ran: (e) => void summaries.push(e) } }
  }
}

const BASE_OPTS = { parallel: 1, diffOnly: false, changedFiles: null, defaultTimeoutMs: 5000 }

/**
 * One `gate` `checked` observation per terminal outcome the runner can reach
 * for a check that did not pass (a pass and a skip record none — the run's
 * `summary` counts them), each carrying `check_version`,
 * `policy_version`, `input_fingerprint`, `outcome`, `duration_ms` and a
 * structured `reason` (never a check's own free-text `CheckError.message`,
 * which the fixture bodies below deliberately vary to prove that).
 */
describe('runChecks — gate observations, one per terminal outcome', () => {
  it('pass — records no event of its own, only the run summary', async () => {
    const { events, summaries, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'passing', run: PASSING })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('pass')
    expect(events).toHaveLength(0)
    expect(summaries).toHaveLength(1)
  })

  it('fail — rejected, structured reason names only the error count, never the message', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'failing', run: FAILING })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('fail')
    expect(events).toHaveLength(1)
    const e = events[0] as NotPassed
    expect(e.result).toBe('fail')
    expect(e.reason).toBe('errors:1')
    expect(e.reason).not.toContain('fixture finding')
  })

  it('wait — every reported error is pending:true, never rendered as a rejection', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'pending', run: PENDING })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('fail')
    expect(outcome?.errors[0]?.pending).toBe(true)
    expect(events).toHaveLength(1)
    const e = events[0] as NotPassed
    expect(e.result).toBe('wait')
    expect(e.reason).toBe('pending_principal_action')
  })

  it('skip — a diff-scoped check with no matching include glob records no event, only a skipped count', async () => {
    const { events, summaries, log } = capture()
    const spec = fullScope({ name: 'scoped', run: PASSING, scope: 'diff', include: ['apps/other/**'] })
    const [outcome] = await runChecks([spec], {
      ...BASE_OPTS,
      diffOnly: true,
      changedFiles: ['apps/vinaya/cli/src/index.ts'],
      log
    })
    expect(outcome?.status).toBe('skipped')
    expect(events).toHaveLength(0)
    expect(summaries[0]).toMatchObject({ ran: 0, skipped: 1, failedNames: [] })
  })

  it('skip — requiresOpenPr under localOnly records no event, and the outcome names its own reason', async () => {
    const { events, summaries, log } = capture()
    const spec = fullScope({ name: 'pr-only', run: PASSING, requiresOpenPr: true })
    const [outcome] = await runChecks([spec], { ...BASE_OPTS, localOnly: true, log })
    expect(events).toHaveLength(0)
    expect(summaries[0]).toMatchObject({ skipped: 1 })
    expect(outcome?.skipReason).toBe('requires-open-pr, local-only')
  })

  it('skip — skipFull records no event, and the outcome names its own reason', async () => {
    const { events, summaries, log } = capture()
    const spec = fullScope({ name: 'full-one', run: PASSING, scope: 'full' })
    const [outcome] = await runChecks([spec], { ...BASE_OPTS, skipFull: true, log })
    expect(events).toHaveLength(0)
    expect(summaries[0]).toMatchObject({ skipped: 1 })
    expect(outcome?.skipReason).toBe('full-scope, pre-commit')
  })

  it('timeout', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'slow', run: SLEEPER, args: ['10000'], timeoutMs: 300 })], {
      ...BASE_OPTS,
      log
    })
    expect(outcome?.status).toBe('timeout')
    expect(events).toHaveLength(1)
    const e = events[0] as NotPassed
    expect(e.result).toBe('timeout')
    expect(e.reason).toBe('timeout_ms:300')
  })

  it('invalid_input — malformed check output, never the raw stderr content', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'malformed', run: MALFORMED })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('error')
    expect(events).toHaveLength(1)
    const e = events[0] as NotPassed
    expect(e.result).toBe('invalid_input')
    expect(e.reason).toBe('malformed_output')
  })

  it('unavailable_dependency — missing executable', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'missing-bin', run: join(FIXTURES, 'no-such-executable') })], {
      ...BASE_OPTS,
      log
    })
    expect(outcome?.status).toBe('error')
    expect(events).toHaveLength(1)
    const e = events[0] as NotPassed
    expect(e.result).toBe('unavailable_dependency')
    expect(e.reason).toBe('spawn_failed:ENOENT')
  })

  it('unavailable_dependency — missing required env, names only the key, never a value', async () => {
    const { events, log } = capture()
    const spec = fullScope({ name: 'needs-token', run: PASSING, env: { SECRET_TOKEN: true } })
    const [outcome] = await runChecks([spec], {
      ...BASE_OPTS,
      callerEnv: { PATH: process.env.PATH as string },
      log
    })
    expect(outcome?.status).toBe('error')
    expect(events).toHaveLength(1)
    const e = events[0] as NotPassed
    expect(e.result).toBe('unavailable_dependency')
    expect(e.reason).toBe('missing_env:SECRET_TOKEN')
  })

  it('a not-passed record names the check and its version and carries no forwarded secret value', async () => {
    const { events, log } = capture()
    // A failing check, because a passing one records no event of its own.
    const spec = fullScope({ name: 'with-secret', run: FAILING, env: { SECRET_TOKEN: true } })
    await runChecks([spec], {
      ...BASE_OPTS,
      callerEnv: { PATH: process.env.PATH as string, SECRET_TOKEN: 'sk-super-secret-value' },
      log
    })
    const e = events[0] as NotPassed
    expect(e.name).toBe('with-secret')
    expect(e.version).toBe('1')
    expect(JSON.stringify(e)).not.toContain('sk-super-secret-value')
  })
})

/** A run with one failing check, written through a real run handle into a temporary local copy and read back. */
describe('runChecks — what the local copy holds after a run', () => {
  const RUN = 'checks-run-own'
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-checks-local-copy-'))
    const folder = join(dir, 'logs')
    const recorder = createRunRecorder({
      runId: () => RUN,
      workRef: () => undefined,
      repository: () => 'atta-labs/vinaya',
      place: (repository) => ({ folder, repository }),
      processIdentity: () => undefined,
      sender: () => ({ request: () => {}, remember: () => {}, drain: async () => {} }),
      home: () => dir,
      cwd: () => mkdtempSync(join(tmpdir(), 'vinaya-checks-root-')),
      onError: (e) => {
        throw e
      }
    })
    const handle = recorder.handle()
    if (handle === undefined) throw new Error('the run handle did not open')
    return { dir, handle, folder: join(folder, 'atta-labs-vinaya') }
  }

  it('one checks span and one not-passed event, under the run id, and no earlier-format gate event', async () => {
    const { dir, handle, folder } = setup()
    try {
      await runChecks([fullScope({ name: 'passing', run: PASSING }), fullScope({ name: 'failing', run: FAILING })], {
        ...BASE_OPTS,
        log: { checks: handle.checks, flush: () => handle.flush() },
        where: 'local'
      })
      const spans = storedSpans(folder).filter((s) => s.name.startsWith('vinaya.checks'))
      expect(spans.map((s) => s.name)).toEqual(['vinaya.checks local'])
      expect(spans[0]?.attributes['vinaya.checks.ran']).toBe(2)
      expect(spans[0]?.attributes['vinaya.checks.passed']).toBe(1)
      expect(spans[0]?.attributes['vinaya.checks.failed']).toBe(1)
      const notPassed = storedEvents(folder).filter((e) => e.name === 'vinaya.checks.not_passed')
      expect(notPassed).toHaveLength(1)
      expect(notPassed[0]?.attributes['vinaya.checks.name']).toBe('failing')
      expect(notPassed[0]?.attributes['vinaya.result']).toBe('fail')
      // The run's own id: the process's, as nothing here is inside a task run.
      expect(handle.runId).toBe(RUN)
      expect(JSON.stringify([storedSpans(folder), storedEvents(folder)])).not.toContain('"gate"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The push's live progress: a completion observer told about every finished check, pass and skip included, that
 * changes nothing about the run — the same outcomes in the same order, and the same exit, with it on, off, or throwing.
 */
describe('runChecks — the completion observer', () => {
  const specs = (): CheckSpec[] => [
    fullScope({ name: 'passing', run: PASSING }),
    fullScope({ name: 'pr-only', run: PASSING, requiresOpenPr: true }),
    fullScope({ name: 'failing', run: FAILING }),
    fullScope({ name: 'malformed', run: MALFORMED })
  ]
  const shape = (outcomes: { name: string; status: string; exitCode: number | null; errors: unknown[] }[]) =>
    outcomes.map((o) => ({ name: o.name, status: o.status, exitCode: o.exitCode, errors: o.errors.length }))
  const failed = (outcomes: { status: string }[]) => outcomes.some((o) => o.status !== 'pass' && o.status !== 'skipped')

  it('fires for pass, skip, fail and error, and outcomes, order and exit are identical on, off and throwing', async () => {
    const { log } = capture()
    const opts = { ...BASE_OPTS, parallel: 2, localOnly: true, log }
    const off = await runChecks(specs(), opts)
    const seen: string[] = []
    const on = await runChecks(specs(), {
      ...opts,
      onCheckComplete: (outcome) => seen.push(`${outcome.name}:${outcome.status}`)
    })
    const throwing = await runChecks(specs(), {
      ...opts,
      onCheckComplete: () => {
        throw new Error('the progress sink is broken')
      }
    })
    expect([...seen].sort()).toEqual(['failing:fail', 'malformed:error', 'passing:pass', 'pr-only:skipped'])
    expect(shape(on)).toEqual(shape(off))
    expect(shape(throwing)).toEqual(shape(off))
    expect(shape(off).map((o) => o.name)).toEqual(['passing', 'pr-only', 'failing', 'malformed'])
    expect(failed(on)).toBe(failed(off))
    expect(failed(throwing)).toBe(failed(off))
  })
})
