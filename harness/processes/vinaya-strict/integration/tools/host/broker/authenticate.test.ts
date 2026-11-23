/**
 * `authenticateWorkerInvocation`/`authenticateOperatorInvocation` — the
 * invocation-context authentication half of the broker, exercised on its
 * own before `requestEffect`'s grant/ownership checks.
 */

import { describe, expect, it } from 'bun:test'
import type { DispatchTeeRecoveryDeps } from '../../../../loops/dev-review/dispatch/dispatch'
import { authenticateOperatorInvocation, ForgedInvocationError } from '../../../../../../kernel/tools/host/broker'
import { authenticateWorkerInvocation } from './vinaya-broker'
import type { CommandRecord } from '../../../../../../kernel/log/outside-log'
import { isolatedLocalCopy } from '../../../log/client/local-copy-fixture'

/** An in-memory `DispatchTeeRecoveryDeps` naming exactly one launch record — `records` is `[runId, role, task]` triples, mirroring what `dispatchRole` would have durably written before spawning this child. */
function fakeDispatchDeps(records: readonly [string, string, number][]): DispatchTeeRecoveryDeps {
  return {
    env: {},
    listLaunchRecordPaths: () => records.map((_, i) => `launch-${i}.json`),
    readFile: (path: string) => {
      const idx = Number.parseInt((/launch-(\d+)\.json/.exec(path) as RegExpExecArray)[1] as string, 10)
      const [runId, role, task] = records[idx] as [string, string, number]
      return JSON.stringify({ runId, role, agent: 'claude', task })
    }
  }
}

const REAL_DISPATCH = fakeDispatchDeps([['run-abc', 'developer', 2]])

describe('authenticateWorkerInvocation', () => {
  it('maps VINAYA_ROLE=developer to the worker broker role, task parsed from VINAYA_TASK, once a matching launch record is found', () => {
    const ctx = authenticateWorkerInvocation(
      { VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' },
      REAL_DISPATCH
    )
    expect(ctx.role).toBe('worker')
    expect(ctx.task).toBe(2)
  })

  it('refuses a role never dispatched as a child process at all (forged principal claim)', () => {
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'principal', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
  })

  it('refuses a real but non-Worker dispatched role (code-reviewer holds no Worker grant)', () => {
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'code-reviewer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
  })

  it('refuses an arbitrary, out-of-vocabulary role string', () => {
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'super-admin', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
  })

  it('refuses a missing VINAYA_ROLE', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' }, REAL_DISPATCH)).toThrow(
      ForgedInvocationError
    )
  })

  it('refuses a missing, non-numeric, zero or negative VINAYA_TASK', () => {
    expect(() =>
      authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_RUN_ID: 'run-abc' }, REAL_DISPATCH)
    ).toThrow(ForgedInvocationError)
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'developer', VINAYA_TASK: 'x', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'developer', VINAYA_TASK: '0', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'developer', VINAYA_TASK: '-1', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
  })

  it('refuses a missing or blank VINAYA_RUN_ID — there is nothing to cross-check the claimed task against', () => {
    expect(() => authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_TASK: '2' }, REAL_DISPATCH)).toThrow(
      ForgedInvocationError
    )
    expect(() =>
      authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: '  ' }, REAL_DISPATCH)
    ).toThrow(ForgedInvocationError)
  })

  it('refuses a runId with no launch record at all — an unknown run never authenticates', () => {
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'never-dispatched' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
  })

  it("refuses a forged task claim — the real run's own launch record names a DIFFERENT task than the one presented (security finding: a Worker dispatched for one task claiming another)", () => {
    // The real, controller-written record for run-abc says task 2. A
    // compromised Worker's own env could still set VINAYA_TASK=99 — the
    // cross-check must catch that no launch record names (run-abc,
    // developer, 99), not merely that SOME record exists for run-abc.
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'developer', VINAYA_TASK: '99', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
    ).toThrow(ForgedInvocationError)
  })

  it("refuses a runId real for a DIFFERENT role's own dispatch — a Reviewer's run cannot authenticate as Worker even if it somehow knew the runId", () => {
    const deps = fakeDispatchDeps([['run-reviewer', 'code-reviewer', 2]])
    expect(() =>
      authenticateWorkerInvocation({ VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-reviewer' }, deps)
    ).toThrow(ForgedInvocationError)
  })
})

describe('authenticateOperatorInvocation', () => {
  it('authenticates through VINAYA_MCP_CALLER, the same channel task-tools/server.ts already uses', () => {
    const ctx = authenticateOperatorInvocation({ VINAYA_MCP_CALLER: 'operator-session-1' }, 2)
    expect(ctx.role).toBe('operator')
    expect(ctx.task).toBe(2)
  })

  it('refuses when no caller was authenticated on this invocation', () => {
    expect(() => authenticateOperatorInvocation({}, 2)).toThrow(ForgedInvocationError)
    expect(() => authenticateOperatorInvocation({ VINAYA_MCP_CALLER: '   ' }, 2)).toThrow(ForgedInvocationError)
  })

  it('refuses a non-positive task id even with a valid caller', () => {
    expect(() => authenticateOperatorInvocation({ VINAYA_MCP_CALLER: 'operator-session-1' }, 0)).toThrow(
      ForgedInvocationError
    )
  })
})

/** Both `authenticate*Invocation` functions write one `log.command.completed` record for the invocation itself — `ok` on success, `refused` (naming `ForgedInvocationError`) on failure — before ever returning or throwing. */
describe('authenticate*Invocation — command records', () => {
  it('authenticateWorkerInvocation records ok on success', () => {
    const commands: CommandRecord[] = []
    authenticateWorkerInvocation(
      { VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' },
      REAL_DISPATCH,
      { command: (r) => void commands.push(r) }
    )
    expect(commands).toEqual([{ action: 'authenticate-invocation', target: 'task:2', result: 'ok' }])
  })

  it('authenticateWorkerInvocation records refused naming ForgedInvocationError on failure, never a silent throw', () => {
    const commands: CommandRecord[] = []
    expect(() =>
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'principal', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH,
        { command: (r) => void commands.push(r) }
      )
    ).toThrow(ForgedInvocationError)
    expect(commands).toEqual([
      { action: 'authenticate-invocation', result: 'refused', errorType: 'ForgedInvocationError' }
    ])
  })

  it('authenticateOperatorInvocation records ok on success and refused on failure', () => {
    const ok: CommandRecord[] = []
    authenticateOperatorInvocation({ VINAYA_MCP_CALLER: 'operator-session-1' }, 2, {
      command: (r) => void ok.push(r)
    })
    expect(ok).toMatchObject([{ result: 'ok' }])

    const refused: CommandRecord[] = []
    expect(() => authenticateOperatorInvocation({}, 2, { command: (r) => void refused.push(r) })).toThrow(
      ForgedInvocationError
    )
    expect(refused).toMatchObject([{ result: 'refused', errorType: 'ForgedInvocationError' }])
  })

  it("writes one command.completed to the run's local copy, and no earlier-format operation event (O2, O4)", () => {
    const copy = isolatedLocalCopy()
    try {
      authenticateWorkerInvocation(
        { VINAYA_ROLE: 'developer', VINAYA_TASK: '2', VINAYA_RUN_ID: 'run-abc' },
        REAL_DISPATCH
      )
      const written = copy.events().filter((e) => e.name.startsWith('vinaya.command.'))
      expect(written.map((e) => e.name)).toEqual(['vinaya.command.completed'])
      expect(written[0]?.attributes).toMatchObject({
        'vinaya.outside.action': 'authenticate-invocation',
        'vinaya.outside.target': 'task:2',
        'vinaya.result': 'ok'
      })
      expect(copy.earlierFormatFiles()).toEqual([])
    } finally {
      copy.restore()
    }
  })
})
