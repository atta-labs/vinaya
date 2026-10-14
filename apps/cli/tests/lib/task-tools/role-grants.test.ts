import { describe, expect, it } from 'bun:test'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPERATOR_TOOL_GRANT } from '@attalabs/aeg-core'
import { startDevToolsHost } from '../../../src/lib/task-tools/dev-tools-host.js'
import {
  createDevToolsMcpServer,
  DEV_TOOL_NAMES,
  dispatchDevTool,
  type DevToolContext
} from '../../../src/lib/task-tools/dev-tools-server.js'
import {
  GRANTED_ROLES,
  type GrantedRole,
  isToolGranted,
  ROLE_TOOL_GRANTS,
  servedTools
} from '../../../src/lib/task-tools/role-grants.js'
import { AGENT_TOOL_CATALOG } from '../../../src/lib/task-tools/tool-catalog.js'

/**
 * The capability grants: one table names each role's tools, and the
 * driver-run server lists and accepts only the dispatched role's grant,
 * refusing every other call itself before a handler runs.
 */

/** A context whose every handler records its own name, so a test sees whether any handler ran. */
function recordingContext(calls: string[]): DevToolContext {
  const record =
    <T>(name: string, result: T) =>
    async () => {
      calls.push(name)
      return { ok: true as const, result }
    }
  return {
    publishChanges: record('publish_changes', { pushedHead: 'h' }),
    openPullRequest: record('open_pull_request', { prNumber: 1 }),
    updatePullRequestBody: record('update_pull_request_body', { prNumber: 1 }),
    refreshEvidence: record('refresh_evidence', { head: 'h', checksPassed: true, evidence: 'e' }),
    readPullRequest: record('read_pull_request', {
      prNumber: 1,
      state: 'OPEN',
      head: 'h',
      checks: [],
      reviews: [],
      body: 'b',
      failedChecks: []
    }),
    runChecks: record('run_checks', { passed: true, output: 'ok' }),
    fetchDocumentation: async () => {
      calls.push('fetch_documentation')
      throw new Error('not reached in these tests')
    }
  }
}

const VALID_ARGS: Record<string, unknown> = {
  publish_changes: { header: 'Test(grants): probe' },
  open_pull_request: { title: 't', body: 'b' },
  update_pull_request_body: { body: 'b' },
  fetch_documentation: { url: 'https://example.com/docs' }
}

async function listed(role: GrantedRole): Promise<string[]> {
  const srv = createDevToolsMcpServer({ serverVersion: 'test', context: recordingContext([]), role })
  const resp = await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  return (JSON.parse(resp as string).result.tools as Array<{ name: string }>).map((t) => t.name)
}

describe('ROLE_TOOL_GRANTS — the one grant table', () => {
  it('grants the Developer exactly the seven Developer tools', () => {
    expect(ROLE_TOOL_GRANTS.developer).toHaveLength(7)
    expect([...ROLE_TOOL_GRANTS.developer].sort()).toEqual([...DEV_TOOL_NAMES].sort())
  })
  it('grants the code and security reviewers read_source only', () => {
    expect(ROLE_TOOL_GRANTS['code-reviewer']).toEqual(['read_source'])
    expect(ROLE_TOOL_GRANTS.security).toEqual(['read_source'])
  })
  it('grants the controller nothing', () => {
    expect(ROLE_TOOL_GRANTS.controller).toEqual([])
  })
  it('names no Operator tool and no Operator role', () => {
    expect(GRANTED_ROLES as readonly string[]).not.toContain('operator')
    const granted = Object.values(ROLE_TOOL_GRANTS).flat()
    for (const tool of OPERATOR_TOOL_GRANT) expect(granted).not.toContain(tool)
  })
  it('every granted tool is a catalog entry', () => {
    const catalog = AGENT_TOOL_CATALOG.map((t) => t.name)
    for (const tool of Object.values(ROLE_TOOL_GRANTS).flat()) expect(catalog).toContain(tool)
  })
  it('a role outside the table is granted nothing', () => {
    expect(isToolGranted('operator', 'run_checks')).toBe(false)
    expect(isToolGranted('planner', 'read_source')).toBe(false)
  })
  it('an annotation never grants: a read-only Developer tool is still not a reviewer’s', () => {
    const readPr = AGENT_TOOL_CATALOG.find((t) => t.name === 'read_pull_request')
    expect(readPr?.annotations.readOnlyHint).toBe(true)
    expect(isToolGranted('code-reviewer', 'read_pull_request')).toBe(false)
    expect(isToolGranted('security', 'read_pull_request')).toBe(false)
  })
})

describe('servedTools — granted and live', () => {
  it('serves the Developer every Developer tool', () => {
    expect(servedTools('developer').map((t) => t.name)).toEqual([...DEV_TOOL_NAMES])
  })
  it('serves each reviewer read_source and nothing else', () => {
    expect(servedTools('code-reviewer').map((t) => t.name)).toEqual(['read_source'])
    expect(servedTools('security').map((t) => t.name)).toEqual(['read_source'])
  })
  it('serves the controller nothing', () => {
    expect(servedTools('controller')).toEqual([])
  })
})

describe('the driver-run server serves each role only its grant', () => {
  it('tools/list names exactly the role’s served tools', async () => {
    expect(await listed('developer')).toEqual([...DEV_TOOL_NAMES])
    expect(await listed('code-reviewer')).toEqual(['read_source'])
    expect(await listed('security')).toEqual(['read_source'])
    expect(await listed('controller')).toEqual([])
  })

  for (const role of ['code-reviewer', 'security', 'controller'] as const) {
    it(`${role}: every Developer tool refuses unauthorized / never / not_started, and no handler runs`, async () => {
      const calls: string[] = []
      for (const name of DEV_TOOL_NAMES) {
        const result = await dispatchDevTool(recordingContext(calls), role, name, VALID_ARGS[name] ?? {})
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.error).toMatchObject({
            errorClass: 'unauthorized',
            retryDisposition: 'never',
            effectState: 'not_started',
            check: 'role-grant'
          })
        }
      }
      expect(calls).toEqual([])
    })
  }

  it('the refusal comes before argument validation, so malformed input to an ungranted tool still reads unauthorized', async () => {
    const result = await dispatchDevTool(recordingContext([]), 'code-reviewer', 'publish_changes', { nope: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errorClass).toBe('unauthorized')
  })

  it('the Developer still reaches its handlers', async () => {
    const calls: string[] = []
    const result = await dispatchDevTool(recordingContext(calls), 'developer', 'run_checks', {})
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['run_checks'])
  })

  it('a reviewer’s read_source on a context with no source reader refuses as unavailable, reaching no Developer handler', async () => {
    const calls: string[] = []
    const result = await dispatchDevTool(recordingContext(calls), 'code-reviewer', 'read_source', {
      sourceId: 's',
      offset: 0
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.check).toBe('read-source-unavailable')
    expect(calls).toEqual([])
  })

  it('the Developer is refused read_source before any handler runs', async () => {
    const result = await dispatchDevTool(recordingContext([]), 'developer', 'read_source', { sourceId: 's' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ errorClass: 'unauthorized', check: 'role-grant' })
  })
})

describe('the host enforces the grant over its real socket', () => {
  it('a reviewer host lists read_source only and refuses publish_changes without running it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-grants-host-'))
    const calls: string[] = []
    const host = await startDevToolsHost({
      socketPath: join(dir, 'r.sock'),
      serverVersion: 'test',
      context: recordingContext(calls),
      role: 'code-reviewer'
    })
    try {
      const [list, publish] = await driveOverSocket(host.socketPath, [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'publish_changes', arguments: { header: 'Test(grants): probe' } }
        }
      ])
      if (list === undefined || publish === undefined) throw new Error('the host answered fewer messages than sent')
      expect((list.result.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['read_source'])
      expect(publish.result.isError).toBe(true)
      expect((publish.result.structuredContent as { error: Record<string, unknown> }).error).toMatchObject({
        errorClass: 'unauthorized',
        retryDisposition: 'never',
        effectState: 'not_started'
      })
      expect(calls).toEqual([])
    } finally {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Sends each message as one newline-delimited line, collecting one response per message. */
function driveOverSocket(socketPath: string, messages: unknown[]): Promise<Array<{ result: Record<string, unknown> }>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath)
    const out: Array<{ result: Record<string, unknown> }> = []
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', reject)
    socket.on('connect', () => {
      for (const msg of messages) socket.write(`${JSON.stringify(msg)}\n`)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim().length > 0) out.push(JSON.parse(line))
        if (out.length === messages.length) {
          socket.end()
          resolve(out)
          return
        }
        idx = buffer.indexOf('\n')
      }
    })
  })
}
