/**
 * Parity across the injected policies: built from the composition module the
 * way every production builder builds them, the broker, the tool server and
 * the task-tool router grant each role exactly what they granted when the
 * role facts were written inside them, refuse an unknown role the same way,
 * and print every refusal byte for byte as before. The expected values below
 * are the literal grants and messages from before the facts moved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ControlStoreDeps, defaultControlStoreDeps, TASK_TOOL_NAMES } from '@attalabs/aeg-core'
import type { DispatchTeeRecoveryDeps } from '../../../../harness/processes/vinaya-strict/loops/dev-review/dispatch/dispatch'
import {
  vinayaBrokerPolicies,
  vinayaRouterPolicies,
  vinayaToolGrantPolicy
} from '../../../../harness/processes/vinaya-strict/integration/policies/vinaya-policies'
import {
  createBroker,
  ProtectedPathError,
  scopeTarget,
  UngrantedOperationError
} from '../../../../harness/kernel/tools/host/broker'
import { type DevToolContext, dispatchDevTool } from '../../../../harness/kernel/tools/dev-tools-server'
import { grantedTools, isToolGranted, servedTools } from '../../../../harness/kernel/tools/role-grants'
import { createTaskToolRouter } from '../../../../harness/kernel/tools/host/router'

const noLog = (): void => {}

const GRANTS_BEFORE: Record<string, string[]> = {
  developer: [
    'fetch_documentation',
    'run_checks',
    'publish_changes',
    'open_pull_request',
    'update_pull_request_body',
    'refresh_evidence',
    'read_pull_request'
  ],
  'code-reviewer': ['read_source'],
  security: ['read_source'],
  controller: []
}

const LAUNCH: DispatchTeeRecoveryDeps = {
  env: {},
  listLaunchRecordPaths: () => ['launch-0.json'],
  readFile: () => JSON.stringify({ runId: 'run-parity', role: 'developer', agent: 'claude', task: 2 })
}

/** A context no refused call may reach: any handler running fails the test. */
const unreachable = new Proxy({} as DevToolContext, {
  get: () => async () => {
    throw new Error('a refused call reached a handler')
  }
})

describe('tool grants — each role’s grant is the same as before', () => {
  for (const [role, tools] of Object.entries(GRANTS_BEFORE)) {
    it(`${role} is granted exactly ${tools.length === 0 ? 'nothing' : tools.join(', ')}`, () => {
      expect([...grantedTools(vinayaToolGrantPolicy(), role)]).toEqual(tools)
      expect(
        servedTools(vinayaToolGrantPolicy(), role)
          .map((t) => t.name)
          .sort()
      ).toEqual([...tools].sort())
    })
  }

  it('an unknown role is granted nothing and served nothing', () => {
    for (const role of ['operator', 'planner', 'principal', 'unknown']) {
      for (const tool of Object.values(GRANTS_BEFORE).flat())
        expect(isToolGranted(vinayaToolGrantPolicy(), role, tool)).toBe(false)
      expect(servedTools(vinayaToolGrantPolicy(), role)).toEqual([])
    }
  })
})

describe('tool server — every role-grant refusal reads as before', () => {
  it('a reviewer calling a Developer tool', async () => {
    const result = await dispatchDevTool(vinayaToolGrantPolicy(), unreachable, 'code-reviewer', 'publish_changes', {})
    expect(result).toEqual({
      ok: false,
      error: {
        errorClass: 'unauthorized',
        retryDisposition: 'never',
        effectState: 'not_started',
        check: 'role-grant',
        output: 'the code-reviewer role is not granted "publish_changes".',
        fix: 'Call only a tool this role is granted: read_source.'
      }
    })
  })

  it('the Developer calling a reviewer tool', async () => {
    const result = await dispatchDevTool(vinayaToolGrantPolicy(), unreachable, 'developer', 'read_source', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.output).toBe('the developer role is not granted "read_source".')
      expect(result.error.fix).toBe(`Call only a tool this role is granted: ${GRANTS_BEFORE.developer?.join(', ')}.`)
    }
  })

  it('the controller, granted nothing', async () => {
    const result = await dispatchDevTool(vinayaToolGrantPolicy(), unreachable, 'controller', 'run_checks', {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.output).toBe('the controller role is not granted "run_checks".')
      expect(result.error.fix).toBe('This role is granted no tools; finish the turn without calling one.')
    }
  })
})

describe('router — the Operator grant and its refusal read as before', () => {
  const router = createTaskToolRouter(vinayaRouterPolicies())

  it('admits every catalog task tool', () => {
    for (const tool of TASK_TOOL_NAMES) expect(router.refuseUngrantedTool(tool)).toBeNull()
  })

  it('refuses a merge with the same message and detail', () => {
    expect(router.refuseUngrantedTool('merge')).toEqual({
      kind: 'authority',
      message: 'the Operator is not granted "merge"',
      detail: `the Operator's grant is limited to: ${TASK_TOOL_NAMES.join(', ')} — a shell, a forge write, an Issue edit, a review publish or a merge is asked of the Planner or Principal, never called here`
    })
  })
})

describe('broker — authentication and push refusals read as before', () => {
  const broker = createBroker(vinayaBrokerPolicies({ launchRecordDeps: LAUNCH }))
  let dir: string
  let deps: ControlStoreDeps
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'role-policy-parity-'))
    deps = defaultControlStoreDeps(() => dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const authenticate =
    (role: string, task = '2') =>
    () =>
      broker.authenticateWorkerInvocation({ VINAYA_ROLE: role, VINAYA_TASK: task, VINAYA_RUN_ID: 'run-parity' }, noLog)

  it('admits the Developer to the Worker channel only', () => {
    expect(authenticate('developer')().role).toBe('worker')
  })

  it('refuses an unknown role, each ungranted dispatched role and a forged task with the same messages', () => {
    expect(authenticate('operator')).toThrow(
      'broker: refusing to authenticate invocation context — VINAYA_ROLE "operator" is not a recognized dispatched role at all'
    )
    for (const role of ['code-reviewer', 'security', 'principal', 'planner', 'archivist', 'architect']) {
      expect(authenticate(role)).toThrow(
        `broker: refusing to authenticate invocation context — VINAYA_ROLE "${role}" does not map to a broker-grantable Worker role`
      )
    }
    expect(authenticate('developer', '3')).toThrow(
      'broker: refusing to authenticate invocation context — no launch record names run "run-parity" as role "developer" for task 3 — the claimed task does not match what dispatchRole actually launched this child for'
    )
  })

  let pushes = 0
  const push = (operation: string, touchedPaths: string[]) =>
    broker.requestEffect(
      deps,
      authenticate('developer')(),
      {
        operation,
        target: scopeTarget(2, 'refs/heads/task/parity/2'),
        inputVersion: 1,
        touchedPaths,
        key: `${operation}-${++pushes}`,
        payload: 'sha',
        poster: () => 'pushed',
        reconcile: () => ({ outcome: 'absent' })
      },
      noLog
    )

  it('refuses every protected administrative path, disguised or not, with the same message', () => {
    for (const path of [
      'vinaya.config.json',
      '.vinaya/doc-owners',
      '.github/workflows/ci.yml',
      'aeg-root/roles/developer.md',
      '../.github/workflows/ci.yml',
      'foo/../aeg-root/x'
    ]) {
      let thrown: unknown
      try {
        push('branch-push', [path])
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(ProtectedPathError)
      expect((thrown as Error).message).toBe(
        `broker: refusing an operation that touches a protected administrative policy path: ${path} — the task's Surface does not cover it; the Planner must add the path to the task's Surface`
      )
    }
    expect(push('branch-push', ['apps/cli/src/lib/broker.ts'])).toBe('pushed')
  })

  it('refuses an ungranted operation with the same message', () => {
    expect(() => push('ruling-post', [])).toThrow(UngrantedOperationError)
    expect(() => push('ruling-post', [])).toThrow("broker: role 'worker' is not granted operation 'ruling-post'")
  })
})
