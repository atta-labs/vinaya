import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultControlStoreDeps, type ControlStoreDeps } from '@attalabs/aeg-core'
import type { DispatchTeeRecoveryDeps } from '../../../src/lib/dispatch'
import { authenticateWorkerInvocation, requestEffect, scopeTarget, WORKER_OPERATIONS } from '../../../src/lib/broker'
import { buildWorkerEnv } from '../../../src/lib/worker-boundary'

/**
 * `worker-isolation-v1` task 3 (`#560`) — the Test Plan's "scoped
 * publication flows pass inside it" case. `broker.ts` (task 2, `#557`) runs
 * parent-side, never inside a dispatched child (its own module doc) — what
 * this task's confined environment must NOT do is strip the three
 * attribution variables (`VINAYA_ROLE`/`VINAYA_TASK`/`VINAYA_RUN_ID`) a
 * legitimate Worker's later `vinaya` subcommand needs to present to
 * `authenticateWorkerInvocation` in order to be granted a scoped operation
 * at all. This proves that property directly: build the env the way
 * `dispatchRole` builds a confined Worker's env (`buildWorkerEnv` — the
 * O2 allowlist, never a spread), and show a broker request authenticated
 * from exactly that env, naming exactly that env's task, still succeeds —
 * the boundary narrows what a Worker can read, never what a LEGITIMATE
 * request can authenticate as.
 */

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

describe('a confined Worker env still authenticates to the broker — scoped publication passes inside the boundary', () => {
  let dir: string
  let deps: ControlStoreDeps

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vinaya-boundary-publication-test-'))
    deps = defaultControlStoreDeps(() => dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('branch-push is granted from the exact env dispatchRole hands a confined Worker', () => {
    // The parent's own real environment — the exact thing `buildWorkerEnv`
    // must NEVER spread wholesale into the child.
    const parentEnv = { GH_TOKEN: 'ghp_operator_secret', HOME: '/home/operator', PATH: '/usr/bin' }
    const attribution = { VINAYA_RUN_ID: 'run-confined-1', VINAYA_ROLE: 'developer', VINAYA_TASK: '7' }
    const confinedEnv = buildWorkerEnv(parentEnv, attribution)

    // The credential a Worker must never be able to read is genuinely gone.
    expect(confinedEnv.GH_TOKEN).toBeUndefined()

    const dispatchDeps = fakeDispatchDeps([['run-confined-1', 'developer', 7]])
    const context = authenticateWorkerInvocation(
      {
        VINAYA_ROLE: confinedEnv.VINAYA_ROLE,
        VINAYA_TASK: confinedEnv.VINAYA_TASK,
        VINAYA_RUN_ID: confinedEnv.VINAYA_RUN_ID
      },
      dispatchDeps
    )
    expect(context.role).toBe('worker')
    expect(context.task).toBe(7)

    let posts = 0
    const url = requestEffect(deps, context, {
      operation: WORKER_OPERATIONS[0],
      target: scopeTarget(7, 'task/example/7'),
      inputVersion: 1,
      key: 'branch-push',
      payload: 'commit-sha-abc',
      poster: () => {
        posts++
        return 'https://example.invalid/posted'
      },
      reconcile: () => {
        throw new Error('reconcile should not be called for a fresh key')
      }
    })
    expect(posts).toBe(1)
    expect(url).toBe('https://example.invalid/posted')
  })
})
