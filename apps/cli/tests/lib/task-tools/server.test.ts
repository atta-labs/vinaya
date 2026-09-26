import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'node:stream'
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
    task_pr_read: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
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
    task_pr_read: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
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

/**
 * `serve`'s per-line dispatch is the one place two DIFFERENT tasks' calls
 * can be in flight on this shared, multi-tenant server at once. Round 2
 * security review (HIGH): `resume.ts`/`cancel.ts`'s handlers mutate
 * `process.env.VINAYA_TASK` around their own `log()` call — safe only if no
 * OTHER call's own mutate/restore can land in between. This models that
 * exact shape (a handler that mutates the shared env, yields, then reads it
 * back) without depending on the real handlers' filesystem state, and
 * proves two lines pushed into the stream back-to-back — no delay, no await
 * between them — never interleave.
 */
describe('serve — two different tasks never interleave through the shared per-line dispatch', () => {
  it('a slow first call is not clobbered by a second call for a different task arriving before it finishes', async () => {
    const observed: Record<string, string | undefined> = {}
    const handlers: TaskToolHandlers = {
      task_status: () => ({ ok: true, result: { items: [], nextCursor: null } }),
      task_escalation_read: () => ({
        ok: true,
        result: { items: [], nextCursor: null, observedAt: '2026-01-01T00:00:00.000Z', freshness: 'unknown' }
      }),
      task_pr_read: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
      task_resume: async (input) => {
        const task = String((input as { task: number }).task)
        const prev = process.env.VINAYA_TASK
        process.env.VINAYA_TASK = task
        // Yields the microtask/macrotask queue mid-handler — exactly where an
        // unserialized dispatcher would let a second call's own mutation of
        // the same shared `process.env.VINAYA_TASK` slip in.
        await new Promise((resolve) => setTimeout(resolve, 20))
        observed[task] = process.env.VINAYA_TASK
        if (prev === undefined) delete process.env.VINAYA_TASK
        else process.env.VINAYA_TASK = prev
        return { ok: true, result: { task } }
      },
      task_cancel: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
      task_start: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } })
    }
    const server = createTaskToolsMcpServer({ serverVersion: '0.0.0-test', handlers })

    const input = new PassThrough()
    const output = new PassThrough()
    const responses: unknown[] = []
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        responses.push(JSON.parse(line))
      }
    })

    const servePromise = server.serve(input, output)
    const call = (id: number, task: number) =>
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'task_resume', arguments: { task } }
      })}\n`
    // Both lines pushed in the same tick, back-to-back — the shape that
    // raced before this fix.
    input.write(call(1, 111))
    input.write(call(2, 222))
    input.end()

    await servePromise

    expect(observed['111']).toBe('111')
    expect(observed['222']).toBe('222')
    expect(responses).toHaveLength(2)
  })
})

/**
 * Round 3 security review, HIGH: `serve`'s serialized dispatch chains every
 * line through one `Promise` (the fix for the interleaving race above), but
 * a chained `.then()` sequence skips every later queued callback once one
 * link rejects — so an unguarded failure anywhere in one line's processing
 * (a handler result `JSON.stringify` can't serialize, say) would silently
 * stop dispatching every LATER line for the rest of the process's life, not
 * just the failing one. Two fixes close this: `handle`'s `tools/call` branch
 * now catches a `JSON.stringify` failure and turns it into this call's own
 * JSON-RPC error, and `serve`'s own chain link independently catches
 * whatever `handleLine`/`write` throw as a last line of defense. This proves
 * the chain survives either way: line 1 fails to serialize, line 2 (a
 * different, unrelated call) still gets its own response.
 */
describe('serve — a failure on one line never wedges dispatch for a later line', () => {
  it('a result JSON.stringify cannot serialize becomes this call’s own error response, and the next line still runs', async () => {
    const handlers: TaskToolHandlers = {
      // A BigInt field is valid JS but `JSON.stringify` throws on it —
      // exactly the "handler result isn't serializable" failure mode named
      // in the finding.
      task_status: () => ({ ok: true, result: { items: [], nextCursor: null, bad: 1n } }) as never,
      task_escalation_read: () => ({
        ok: true,
        result: { items: [], nextCursor: null, observedAt: '2026-01-01T00:00:00.000Z', freshness: 'unknown' }
      }),
      task_pr_read: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
      task_resume: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
      task_cancel: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } }),
      task_start: () => ({ ok: false, error: { kind: 'capability', message: 'stub' } })
    }
    const server = createTaskToolsMcpServer({ serverVersion: '0.0.0-test', handlers })

    const input = new PassThrough()
    const output = new PassThrough()
    const responses: Array<{ id: number; error?: { message: string } }> = []
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        responses.push(JSON.parse(line))
      }
    })

    const servePromise = server.serve(input, output)
    const call = (id: number, name: string) =>
      `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })}\n`
    // Pushed back-to-back, no await between them — line 1's failure must not
    // stop line 2's chain link from ever running.
    input.write(call(1, 'task_status'))
    input.write(call(2, 'task_escalation_read'))
    input.end()

    await servePromise

    expect(responses).toHaveLength(2)
    expect(responses[0]?.id).toBe(1)
    expect(responses[0]?.error?.message).toContain('could not be serialized')
    expect(responses[1]?.id).toBe(2)
    expect(responses[1]?.error).toBeUndefined()
  })
})
