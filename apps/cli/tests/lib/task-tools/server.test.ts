import { describe, expect, it } from 'bun:test'
import { createTaskToolsMcpServer, type TaskToolHandlers } from '../../../src/lib/task-tools/server.js'

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
