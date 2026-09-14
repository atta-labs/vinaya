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

function capture(): { events: LogEventInput[]; log: (e: LogEventInput) => void } {
  const events: LogEventInput[] = []
  return { events, log: (e) => events.push(e) }
}

const BASE_OPTS = { parallel: 1, diffOnly: false, changedFiles: null, defaultTimeoutMs: 5000 }

type GateEvent = Extract<LogEventInput, { kind: 'gate' }>

describe('runChecks — reject-then-correct trace (task-log-v1 3, O3)', () => {
  it('a rejected round then a corrected round produce two distinct gate observations, never one overwritten record', async () => {
    const { events, log } = capture()

    // Round 1: the check as originally pushed — rejected.
    const [round1] = await runChecks([fullScope({ name: 'my-check', run: FAILING })], { ...BASE_OPTS, log })
    expect(round1?.status).toBe('fail')

    // Round 2: the SAME check name, run again after a fix — this time it
    // passes. A real Developer round looks exactly like this: the same
    // check attempted twice, at two different times, on two different diffs.
    const [round2] = await runChecks([fullScope({ name: 'my-check', run: PASSING })], { ...BASE_OPTS, log })
    expect(round2?.status).toBe('pass')

    expect(events).toHaveLength(2)
    const [first, second] = events as [GateEvent, GateEvent]
    expect(first.check).toBe('my-check')
    expect(first.outcome).toBe('fail')
    expect(second.check).toBe('my-check')
    expect(second.outcome).toBe('pass')
    // Two real attempts, not a retry collapsed to one line — a reader must
    // see the rejection AND the correction, not just the final state.
    expect(first).not.toEqual(second)
  })
})

describe('runChecks — an explicitly missing observation is a real absence, never a fabricated one (O3)', () => {
  it('a spec that never reaches runChecks produces no gate line for it — silence, not a synthesized outcome', async () => {
    const { events, log } = capture()

    // `attempted-check` mirrors a real attempt: it reaches `runChecks` and
    // is recorded. `never-dispatched` mirrors a check the CALLER refused
    // BEFORE `runChecks` — e.g. `check.ts`'s FAIL_CLOSED config-refusal path
    // (`apps/cli/src/commands/check.ts`), which returns without ever
    // building a `CheckSpec` for a rejected `checks` entry. `runChecks`
    // itself is never handed that spec, so it is never in this array.
    await runChecks([fullScope({ name: 'attempted-check', run: PASSING })], { ...BASE_OPTS, log })

    expect(events).toHaveLength(1)
    const names = (events as GateEvent[]).map((e) => e.check)
    expect(names).toEqual(['attempted-check'])
    expect(names).not.toContain('never-dispatched')

    // The absence is total, not a disguised pass: there is no `gate` line
    // naming `never-dispatched` at all — a reader reconciling "every check
    // this task declared" against "every check this log recorded" must be
    // able to tell "never attempted" apart from "attempted and passed," and
    // can only do that if a missing check produces no line rather than one
    // that defaults to a misleadingly clean outcome.
    const fabricatedPass = (events as GateEvent[]).find((e) => e.check === 'never-dispatched' && e.outcome === 'pass')
    expect(fabricatedPass).toBeUndefined()
  })
})
