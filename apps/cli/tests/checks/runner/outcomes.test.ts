import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { LogEventInput } from '../../../src/lib/log-sink'
import type { CheckSpec } from '../../../src/checks/contract'
import { runChecks } from '../../../src/checks/runner'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'checks')
const PASSING = join(FIXTURES, 'passing-check.ts')
const FAILING = join(FIXTURES, 'failing-check.ts')
const PENDING = join(FIXTURES, 'pending-check.ts')
const MALFORMED = join(FIXTURES, 'malformed-check.ts')
const SLEEPER = join(FIXTURES, 'sleeper.ts')

function fullScope(overrides: Partial<CheckSpec> & Pick<CheckSpec, 'name' | 'run'>): CheckSpec {
  return { scope: 'full', ...overrides }
}

function capture(): { events: LogEventInput[]; log: (e: LogEventInput) => void } {
  const events: LogEventInput[] = []
  return { events, log: (e) => events.push(e) }
}

const BASE_OPTS = { parallel: 1, diffOnly: false, changedFiles: null, defaultTimeoutMs: 5000 }

/**
 * One `gate` `checked` observation per terminal
 * outcome the runner can reach, each carrying `check_version`,
 * `policy_version`, `input_fingerprint`, `outcome`, `duration_ms` and a
 * structured `reason` (never a check's own free-text `CheckError.message`,
 * which the fixture bodies below deliberately vary to prove that).
 */
describe('runChecks — gate observations, one per terminal outcome', () => {
  it('pass', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'passing', run: PASSING })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('pass')
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.kind).toBe('gate')
    expect(e.event).toBe('checked')
    expect(e.check).toBe('passing')
    expect(e.outcome).toBe('pass')
    expect(e.reason).toBeUndefined()
    expect(e.check_version).toBe('1')
    expect(e.policy_version).toBeNull()
    expect(typeof e.input_fingerprint).toBe('string')
    expect((e.input_fingerprint as string).length).toBeGreaterThan(0)
    expect(typeof e.duration_ms).toBe('number')
    expect(e.payload).toEqual({})
  })

  it('fail — rejected, structured reason names only the error count, never the message', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'failing', run: FAILING })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('fail')
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('fail')
    expect(e.reason).toBe('errors:1')
    expect(e.reason).not.toContain('fixture finding')
  })

  it('wait — every reported error is pending:true, never rendered as a rejection', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'pending', run: PENDING })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('fail')
    expect(outcome?.errors[0]?.pending).toBe(true)
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('wait')
    expect(e.reason).toBe('pending_principal_action')
  })

  it('skip — a diff-scoped check with no matching include glob', async () => {
    const { events, log } = capture()
    const spec = fullScope({ name: 'scoped', run: PASSING, scope: 'diff', include: ['apps/other/**'] })
    const [outcome] = await runChecks([spec], {
      ...BASE_OPTS,
      diffOnly: true,
      changedFiles: ['apps/vinaya/cli/src/index.ts'],
      log
    })
    expect(outcome?.status).toBe('skipped')
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('skip')
    expect(e.reason).toBe('no-matching-include-glob')
    expect(e.duration_ms).toBe(0)
  })

  it('skip — requiresOpenPr under localOnly names its own reason', async () => {
    const { events, log } = capture()
    const spec = fullScope({ name: 'pr-only', run: PASSING, requiresOpenPr: true })
    await runChecks([spec], { ...BASE_OPTS, localOnly: true, log })
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('skip')
    expect(e.reason).toBe('requires-open-pr, local-only')
  })

  it('skip — skipFull names its own reason', async () => {
    const { events, log } = capture()
    const spec = fullScope({ name: 'full-one', run: PASSING, scope: 'full' })
    await runChecks([spec], { ...BASE_OPTS, skipFull: true, log })
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('skip')
    expect(e.reason).toBe('full-scope, pre-commit')
  })

  it('timeout', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'slow', run: SLEEPER, args: ['10000'], timeoutMs: 300 })], {
      ...BASE_OPTS,
      log
    })
    expect(outcome?.status).toBe('timeout')
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('timeout')
    expect(e.reason).toBe('timeout_ms:300')
  })

  it('invalid_input — malformed check output, never the raw stderr content', async () => {
    const { events, log } = capture()
    const [outcome] = await runChecks([fullScope({ name: 'malformed', run: MALFORMED })], { ...BASE_OPTS, log })
    expect(outcome?.status).toBe('error')
    expect(events).toHaveLength(1)
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('invalid_input')
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
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('unavailable_dependency')
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
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.outcome).toBe('unavailable_dependency')
    expect(e.reason).toBe('missing_env:SECRET_TOKEN')
  })

  it('the input fingerprint never carries a forwarded secret value in the clear', async () => {
    const { events, log } = capture()
    const spec = fullScope({ name: 'with-secret', run: PASSING, env: { SECRET_TOKEN: true } })
    await runChecks([spec], {
      ...BASE_OPTS,
      callerEnv: { PATH: process.env.PATH as string, SECRET_TOKEN: 'sk-super-secret-value' },
      log
    })
    const e = events[0] as Extract<LogEventInput, { kind: 'gate' }>
    expect(e.input_fingerprint).not.toContain('sk-super-secret-value')
    // sha256 hex digest — fixed shape, not the JSON it was built from.
    expect(e.input_fingerprint as string).toMatch(/^[0-9a-f]{64}$/)
  })
})
