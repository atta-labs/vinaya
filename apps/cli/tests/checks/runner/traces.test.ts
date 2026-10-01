import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { LogEventInput } from '../../../src/lib/log-sink'
import type { CheckSpec } from '../../../src/checks/contract'
import { runChecks } from '../../../src/checks/runner'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'checks')
const PASSING = join(FIXTURES, 'passing-check.ts')
const FAILING = join(FIXTURES, 'failing-check.ts')

function fullScope(overrides: Partial<CheckSpec> & Pick<CheckSpec, 'name' | 'run'>): CheckSpec {
  return { scope: 'full', ...overrides }
}

/** `events` holds the per-check `checked` observations (a check that did not pass); `summaries` the runs' `summary` events, in order. */
function capture(): {
  events: LogEventInput[]
  summaries: LogEventInput[]
  log: (e: LogEventInput) => void
} {
  const events: LogEventInput[] = []
  const summaries: LogEventInput[] = []
  return {
    events,
    summaries,
    log: (e) => (e.kind === 'gate' && e.event === 'summary' ? summaries : events).push(e)
  }
}

const BASE_OPTS = { parallel: 1, diffOnly: false, changedFiles: null, defaultTimeoutMs: 5000 }

type GateEvent = Extract<LogEventInput, { kind: 'gate'; event: 'checked' }>

describe('runChecks — reject-then-correct trace', () => {
  it('a rejected round then a corrected round produce two distinct summaries, never one overwritten record', async () => {
    const { events, summaries, log } = capture()

    // Round 1: the check as originally pushed — rejected.
    const [round1] = await runChecks([fullScope({ name: 'my-check', run: FAILING })], { ...BASE_OPTS, log })
    expect(round1?.status).toBe('fail')

    // Round 2: the SAME check name, run again after a fix — this time it
    // passes. A real Developer round looks exactly like this: the same
    // check attempted twice, at two different times, on two different diffs.
    const [round2] = await runChecks([fullScope({ name: 'my-check', run: PASSING })], { ...BASE_OPTS, log })
    expect(round2?.status).toBe('pass')

    // The rejection is one `checked` event; the correction is a pass, which
    // records no event of its own, so it is visible only in the second
    // run's summary — a reader still sees the rejection AND the correction.
    expect(events).toHaveLength(1)
    const [rejected] = events as [GateEvent]
    expect(rejected.check).toBe('my-check')
    expect(rejected.outcome).toBe('fail')
    expect(summaries).toHaveLength(2)
    const [first, second] = summaries as [GateEvent, GateEvent]
    expect(first).toMatchObject({ ran: 1, passed: 0, failed: 1, failed_checks: ['my-check'] })
    expect(second).toMatchObject({ ran: 1, passed: 1, failed: 0, failed_checks: [] })
  })
})

describe('runChecks — an explicitly missing observation is a real absence, never a fabricated one (O3)', () => {
  it('a spec that never reaches runChecks is in no gate line — silence, not a synthesized outcome', async () => {
    const { events, summaries, log } = capture()

    // `attempted-check` mirrors a real attempt: it reaches `runChecks` and
    // is counted. `never-dispatched` mirrors a check the CALLER refused
    // BEFORE `runChecks` — e.g. `check.ts`'s FAIL_CLOSED config-refusal path
    // (`apps/cli/src/commands/check.ts`), which returns without ever
    // building a `CheckSpec` for a rejected `checks` entry. `runChecks`
    // itself is never handed that spec, so it is never in this array.
    await runChecks([fullScope({ name: 'attempted-check', run: PASSING })], { ...BASE_OPTS, log })

    // The run counted exactly the one check it was handed, and no event names
    // `never-dispatched` — a reader reconciling "every check this task
    // declared" against "every check this log recorded" can tell "never
    // attempted" apart from a pass because the summary's count does not
    // include it and it never defaults to a misleadingly clean outcome.
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ ran: 1, passed: 1, failed_checks: [] })
    expect(events).toHaveLength(0)
    const fabricated = [...events, ...summaries].some((e) => JSON.stringify(e).includes('never-dispatched'))
    expect(fabricated).toBe(false)
  })
})
