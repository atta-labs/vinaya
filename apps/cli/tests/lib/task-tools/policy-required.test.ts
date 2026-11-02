/**
 * The tool server's, the tool host's and the task-tool router's policy seams,
 * owned by the task tools themselves: building any of them without its policy
 * is refused, naming it, and each grant check runs over whatever grant the
 * policy carries. Every role label, seat and tool grant here is synthetic — no
 * process's own vocabulary.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDevToolsHost } from '../../../src/lib/task-tools/dev-tools-host.js'
import {
  createDevToolsMcpServer,
  type DevToolContext,
  dispatchDevTool
} from '../../../src/lib/task-tools/dev-tools-server.js'
import { MissingToolGrantPolicyError, type ToolGrantPolicy } from '../../../src/lib/task-tools/role-grants.js'
import { createTaskToolRouter, MissingRouterPolicyError } from '../../../src/lib/task-tools/router.js'

const GRANTS: ToolGrantPolicy = { roles: ['alpha', 'beta'], grants: { alpha: ['run_checks'], beta: [] } }

/** A context no refused call may reach: any handler running fails the test. */
const unreachable = new Proxy({} as DevToolContext, {
  get: () => async () => {
    throw new Error('a refused call reached a handler')
  }
})

describe('the tool server and its dispatch — a missing tool-grant policy is a refusal', () => {
  it('refuses a server built without one', () => {
    expect(() =>
      createDevToolsMcpServer({ serverVersion: 'test', context: unreachable, role: 'alpha' } as unknown as Parameters<
        typeof createDevToolsMcpServer
      >[0])
    ).toThrow(
      'createDevToolsMcpServer: refusing to build without its tool-grant policy (toolGrants) — a missing grant is never an empty one'
    )
  })

  it('refuses a dispatch handed none, before any handler runs', async () => {
    await expect(
      dispatchDevTool(undefined as unknown as ToolGrantPolicy, unreachable, 'alpha', 'run_checks', {})
    ).rejects.toThrow(MissingToolGrantPolicyError)
  })

  it('refuses a malformed policy as missing', () => {
    expect(() =>
      createDevToolsMcpServer({
        serverVersion: 'test',
        context: unreachable,
        role: 'alpha',
        toolGrants: { grants: {} } as unknown as ToolGrantPolicy
      })
    ).toThrow(MissingToolGrantPolicyError)
  })

  it('lists and admits only what the policy grants', async () => {
    const server = createDevToolsMcpServer({
      serverVersion: 'test',
      context: unreachable,
      role: 'alpha',
      toolGrants: GRANTS
    })
    const list = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    expect((JSON.parse(list as string).result.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      'run_checks'
    ])
    const refused = await dispatchDevTool(GRANTS, unreachable, 'beta', 'run_checks', {})
    expect(refused).toMatchObject({
      ok: false,
      error: { check: 'role-grant', output: 'the beta role is not granted "run_checks".' }
    })
    const outside = await dispatchDevTool(GRANTS, unreachable, 'gamma', 'run_checks', {})
    expect(outside).toMatchObject({
      ok: false,
      error: { check: 'role-grant', fix: 'This role is granted no tools; finish the turn without calling one.' }
    })
  })
})

describe('the tool host — a missing tool-grant policy is refused before any socket is bound', () => {
  it('refuses a host started without one, leaving no socket behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'policy-required-host-'))
    const socketPath = join(dir, 'h.sock')
    try {
      await expect(
        startDevToolsHost({
          socketPath,
          serverVersion: 'test',
          context: unreachable,
          role: 'alpha'
        } as unknown as Parameters<typeof startDevToolsHost>[0])
      ).rejects.toThrow('startDevToolsHost: refusing to build without its tool-grant policy (toolGrants)')
      expect(existsSync(socketPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the task-tool router — a missing role policy is a refusal', () => {
  it('refuses a router built without one', () => {
    expect(() => createTaskToolRouter(undefined as unknown as Parameters<typeof createTaskToolRouter>[0])).toThrow(
      'createTaskToolRouter: refusing to build without its role policy (roles) — a missing grant is never an empty one'
    )
    expect(() => createTaskToolRouter({} as unknown as Parameters<typeof createTaskToolRouter>[0])).toThrow(
      MissingRouterPolicyError
    )
    expect(() =>
      createTaskToolRouter({ roles: { grantedTools: ['task_status'] } } as unknown as Parameters<
        typeof createTaskToolRouter
      >[0])
    ).toThrow(MissingRouterPolicyError)
  })

  it('grants and refuses over the policy’s own seat and grant', () => {
    const router = createTaskToolRouter({
      roles: { grantedTools: ['task_status'], seat: 'the Lookout', askedOf: 'the Keeper' }
    })
    expect(router.refuseUngrantedTool('task_status')).toBeNull()
    expect(router.refuseUngrantedTool('task_cancel')).toEqual({
      kind: 'authority',
      message: 'the Lookout is not granted "task_cancel"',
      detail:
        "the Lookout's grant is limited to: task_status — a shell, a forge write, an Issue edit, a review publish or a merge is asked of the Keeper, never called here"
    })
    expect(router.routeTaskToolIntent('what is the status?')).toBe('task_status')
  })
})
