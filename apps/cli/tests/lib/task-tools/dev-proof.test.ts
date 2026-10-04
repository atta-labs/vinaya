import { describe, expect, it } from 'bun:test'
import {
  devBridgeInvocation,
  parseAgentStream,
  parseCodexProofStream,
  parseDevProofArgs,
  proofContext
} from '../../../src/lib/task-tools/dev-proof.js'

/**
 * The O1 proof command's pure helpers (`dev-proof.ts`) — the argv parse, the
 * per-dispatch bridge registration, the pid-stamping `DevToolContext`, and the
 * stream-json reducer. The live end-to-end dispatch is the command itself
 * (`vinaya task-tools dev-proof --agent <claude|codex>`), re-run on macOS with
 * both sandboxes on by the Principal; these cover the logic a unit test can.
 */

describe('parseDevProofArgs', () => {
  it('accepts --agent claude and --agent codex', () => {
    expect(parseDevProofArgs(['--agent', 'claude'])).toEqual({ agent: 'claude' })
    expect(parseDevProofArgs(['--agent', 'codex'])).toEqual({ agent: 'codex' })
  })
  it('refuses a missing or unknown agent', () => {
    expect('error' in parseDevProofArgs([])).toBe(true)
    expect('error' in parseDevProofArgs(['--agent'])).toBe(true)
    expect('error' in parseDevProofArgs(['--agent', 'gemini'])).toBe(true)
  })
})

describe('devBridgeInvocation', () => {
  it('registers the running entrypoint as the bridge, carrying the socket path', () => {
    const inv = devBridgeInvocation('/tmp/x/dev.sock')
    expect(inv.command).toBe(process.execPath)
    expect(inv.args.slice(-4)).toEqual(['task-tools', 'dev-bridge', '--socket', '/tmp/x/dev.sock'])
  })
})

describe('proofContext', () => {
  it('run_checks stamps this process pid, passes, and records the call', async () => {
    const recorded: Array<{ tool: string; args: unknown; result: unknown }> = []
    const ctx = proofContext(recorded)
    const res = await ctx.runChecks()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.result.passed).toBe(true)
      expect(res.result.output).toContain(`driver pid ${process.pid}`)
    }
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.tool).toBe('run_checks')
  })
  it('every forge-writing tool is out of the proof scope', async () => {
    const ctx = proofContext([])
    for (const call of [
      ctx.publishChanges('h'),
      ctx.openPullRequest('t', 'b'),
      ctx.updatePullRequestBody('b'),
      ctx.refreshEvidence(),
      ctx.readPullRequest()
    ]) {
      const res = await call
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error.check).toBe('dev-proof-scope')
    }
  })
})

describe('parseAgentStream', () => {
  it('pulls is_error, permission_denials and result from the terminal result event', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: {} }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        permission_denials: [],
        result: 'dev-proof: answered in driver pid 42'
      })
    ].join('\n')
    const parsed = parseAgentStream(lines)
    expect(parsed.isError).toBe(false)
    expect(parsed.permissionDenials).toEqual([])
    expect(parsed.resultText).toBe('dev-proof: answered in driver pid 42')
  })
  it('tolerates non-JSON and missing fields', () => {
    const parsed = parseAgentStream('not json\n\n{"type":"other"}')
    expect(parsed.isError).toBeNull()
    expect(parsed.resultText).toBeNull()
    expect(parsed.permissionDenials).toEqual([])
  })
})

describe('parseCodexProofStream', () => {
  it('collects mcp_tool_call items and the final agent message (the call reached the tool)', () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'mcp_tool_call', server: 'vinaya-dev-tools', tool: 'run_checks', status: 'success' }
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'dev-proof: answered in driver pid 42' }
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
    ].join('\n')
    const parsed = parseCodexProofStream(lines)
    expect(parsed.codex.mcpToolCalls).toHaveLength(1)
    expect(parsed.codex.mcpToolCalls[0]?.tool).toBe('run_checks')
    expect(parsed.codex.errorEvents).toHaveLength(0)
    expect(parsed.resultText).toBe('dev-proof: answered in driver pid 42')
    expect(parsed.codex.finalMessage).toBe('dev-proof: answered in driver pid 42')
    expect(parsed.isError).toBeNull()
  })
  it('surfaces a top-level error event and flags the turn as errored', () => {
    const lines = [
      JSON.stringify({ type: 'error', message: 'MCP server vinaya-dev-tools failed to start' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'I could not find the tool.' } })
    ].join('\n')
    const parsed = parseCodexProofStream(lines)
    expect(parsed.codex.errorEvents).toHaveLength(1)
    expect(parsed.isError).toBe(true)
    expect(parsed.codex.mcpToolCalls).toHaveLength(0)
  })
  it('reports no call and a null stamp when the agent answered without calling the tool', () => {
    // The round-2 symptom: exit 0, a final message, but no mcp_tool_call item.
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't2' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
    ].join('\n')
    const parsed = parseCodexProofStream(lines)
    expect(parsed.codex.mcpToolCalls).toHaveLength(0)
    expect(parsed.resultText).toBe('done')
  })
  it('tolerates non-JSON lines', () => {
    const parsed = parseCodexProofStream('not json\n\n{"type":"turn.started"}')
    expect(parsed.codex.mcpToolCalls).toEqual([])
    expect(parsed.resultText).toBeNull()
  })
})
