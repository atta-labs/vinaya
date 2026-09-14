import { describe, expect, it } from 'bun:test'
import {
  createTaskToolsMcpServer,
  dispatchToolCall,
  type TaskToolHandlers
} from '../../../src/lib/task-tools/server.js'

/**
 * `handleLine`'s own doc comment promises it never throws. In-process
 * coverage that a handler throwing or rejecting — a real failure mode
 * (`task_status`'s forge read shells out to `gh`) — is caught and turned
 * into one caller's `isError` refusal rather than an uncaught rejection,
 * which would otherwise be fatal to the whole server process. The
 * transport-level path (real stdio, the production handler set) is
 * `protocol.test.ts`.
 */

function serverWith(handlers: Partial<TaskToolHandlers>) {
  const base: TaskToolHandlers = {
    task_status: () => ({ ok: true, result: { items: [], nextCursor: null } }),
    task_escalation_read: () => ({
      ok: true,
      result: { items: [], nextCursor: null, observedAt: '2026-01-01T00:00:00.000Z', freshness: 'unknown' }
    }),
    task_resume: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
    task_cancel: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
    task_start: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } })
  }
  return createTaskToolsMcpServer({ serverVersion: '0.0.0-test', handlers: { ...base, ...handlers } })
}

async function callTool(server: ReturnType<typeof serverWith>, name: string) {
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
  const response = await server.handleLine(line)
  expect(response).not.toBeNull()
  return JSON.parse(response as string)
}

describe('task-tools MCP server — a handler exception never crashes the process', () => {
  it('a synchronously throwing handler becomes an isError refusal, not an uncaught throw', async () => {
    const server = serverWith({
      task_status: () => {
        throw new Error('gh: not authenticated')
      }
    })
    await expect(callTool(server, 'task_status')).resolves.toMatchObject({
      result: { isError: true, structuredContent: { error: { kind: 'infrastructure' } } }
    })
  })

  it('a rejecting async handler becomes an isError refusal, not an unhandled rejection', async () => {
    const server = serverWith({
      task_status: async () => {
        throw new Error('gh: network error')
      }
    })
    await expect(callTool(server, 'task_status')).resolves.toMatchObject({
      result: { isError: true, structuredContent: { error: { kind: 'infrastructure' } } }
    })
  })

  it('the refusal names the failing tool and the underlying message', async () => {
    const server = serverWith({
      task_status: () => {
        throw new Error('gh: not authenticated')
      }
    })
    const response = await callTool(server, 'task_status')
    expect(response.result.structuredContent.error.message).toContain('task_status')
    expect(response.result.structuredContent.error.message).toContain('gh: not authenticated')
  })

  it('a well-behaved handler on the same server is unaffected by a sibling call throwing', async () => {
    const server = serverWith({
      task_status: () => {
        throw new Error('gh: not authenticated')
      }
    })
    await callTool(server, 'task_status')
    const ok = await callTool(server, 'task_escalation_read')
    expect(ok.result.isError).toBe(false)
  })
})

/**
 * `dispatchToolCall` is the one place a caller-supplied tool name reaches a
 * real call path (every MCP client call runs through it) — this is that
 * gate's own regression case, distinct from `operator-grant.test.ts`'s
 * isolated fixture on `refuseUngrantedTool` alone. `grantCheck` is injected
 * here (rather than mocking `router.js` globally, which would leak across
 * the other files this shared bun process runs) so a call can be forced
 * through the ungranted branch without needing a catalog tool that is
 * actually outside the grant (there is none — `OPERATOR_TOOL_GRANT` is built
 * from `TASK_TOOL_NAMES` itself); production callers never pass a fourth
 * argument, so they always get the real `refuseUngrantedTool`.
 */
describe('dispatchToolCall — the grant gate runs on the real call path, before any handler', () => {
  const handlers: TaskToolHandlers = {
    task_status: () => ({ ok: true, result: { items: [], nextCursor: null } }),
    task_escalation_read: () => ({
      ok: true,
      result: { items: [], nextCursor: null, observedAt: '2026-01-01T00:00:00.000Z', freshness: 'unknown' }
    }),
    task_resume: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
    task_cancel: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
    task_start: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } })
  }

  it('a refused tool never reaches its handler', async () => {
    let handlerCalled = false
    const refusingHandlers: TaskToolHandlers = {
      ...handlers,
      task_status: () => {
        handlerCalled = true
        return { ok: true, result: { items: [], nextCursor: null } }
      }
    }
    const result = await dispatchToolCall(refusingHandlers, 'task_status', {}, { caller: null }, () => ({
      kind: 'authority',
      message: 'the Operator is not granted "task_status"'
    }))
    expect(result).toEqual({
      ok: false,
      error: { kind: 'authority', message: 'the Operator is not granted "task_status"' }
    })
    expect(handlerCalled).toBe(false)
  })

  it('a granted tool still reaches its handler when the gate returns null', async () => {
    const result = await dispatchToolCall(handlers, 'task_status', {}, { caller: null }, () => null)
    expect(result).toEqual({ ok: true, result: { items: [], nextCursor: null } })
  })

  it('the real refuseUngrantedTool is used when no grantCheck is passed — the production wiring', async () => {
    const result = await dispatchToolCall(handlers, 'task_status', {}, { caller: null })
    expect(result).toEqual({ ok: true, result: { items: [], nextCursor: null } })
  })
})
