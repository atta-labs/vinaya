import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNarrationState, type NarrationContext, translateClaudeEvent } from '../../src/lib/loop-narration-claude'
import { translateCodexEvent, translateGeminiEvent } from '../../src/lib/loop-narration-codex'

const WORKTREE = '/work/repo/.worktrees/task/t/1'
const HOME = '/Users/someone'

function ctx(now: number): NarrationContext {
  return { worktree: WORKTREE, home: HOME, now }
}

function started(item: Record<string, unknown>) {
  return { type: 'item.started', item: { status: 'in_progress', ...item } }
}

function completed(item: Record<string, unknown>) {
  return { type: 'item.completed', item: { status: 'completed', ...item } }
}

function one(event: Record<string, unknown>) {
  const [first] = translateCodexEvent(event, createNarrationState(), ctx(0))
  if (first?.type !== 'action') throw new Error('expected an action')
  return first
}

describe('commands, file changes, tool calls and messages (O1, O2)', () => {
  test('a command is classified by the same table as a Claude shell call, through its shell wrapper', () => {
    expect(
      one(started({ id: 'i', type: 'command_execution', command: `/bin/zsh -lc "git rm -f a.ts"` }))
    ).toMatchObject({
      kind: 'removing',
      subject: 'git rm a.ts'
    })
    expect(
      one(started({ id: 'i', type: 'command_execution', command: `/bin/zsh -lc 'bun test a.test.ts'` }))
    ).toMatchObject({
      kind: 'running_tests'
    })
    expect(one(started({ id: 'i', type: 'command_execution', command: 'ls apps' }))).toMatchObject({ kind: 'reading' })
  })

  test('a command carries its exit status on failure, never its output', () => {
    const state = createNarrationState()
    const item = {
      id: 'c',
      type: 'command_execution',
      command: 'bun run build',
      aggregated_output: 'SECRET /Users/someone/x'
    }
    translateCodexEvent(started({ ...item, exit_code: null }), state, ctx(1000))
    const out = translateCodexEvent(completed({ ...item, status: 'failed', exit_code: 2 }), state, ctx(4000))
    expect(out).toEqual([
      {
        type: 'result',
        id: 'c',
        kind: 'running',
        subject: 'bun run build',
        ok: false,
        durationMs: 3000,
        error: 'exit 2'
      }
    ])
    expect(JSON.stringify(out)).not.toContain('SECRET')
  })

  test('a file change is one action per path with the kind of change, relative to the worktree', () => {
    const out = translateCodexEvent(
      started({
        id: 'f',
        type: 'file_change',
        changes: [
          { path: `${WORKTREE}/a.ts`, kind: 'add' },
          { path: `${WORKTREE}/b.ts`, kind: 'update' },
          { path: `${WORKTREE}/c.ts`, kind: 'delete' }
        ]
      }),
      createNarrationState(),
      ctx(0)
    )
    expect(out.map((u) => [u.type === 'action' && u.kind, u.type === 'action' && u.subject])).toEqual([
      ['creating', 'a.ts'],
      ['editing', 'b.ts'],
      ['removing', 'c.ts']
    ])
  })

  test('a tool call carries its name and nothing of its arguments or result', () => {
    const state = createNarrationState()
    const item = { id: 't', type: 'mcp_tool_call', server: 'other', tool: 'lookup', arguments: { token: 'sk-secret' } }
    const out = [
      ...translateCodexEvent(started(item), state, ctx(0)),
      ...translateCodexEvent(
        completed({ ...item, result: { content: [{ type: 'text', text: 'private' }] } }),
        state,
        ctx(10)
      )
    ]
    expect(out).toMatchObject([
      { type: 'action', kind: 'tool_request', subject: 'lookup' },
      { type: 'result', ok: true, durationMs: 10 }
    ])
    expect(JSON.stringify(out)).not.toMatch(/sk-secret|private/)
  })

  test('a plain message is one action and its first line', () => {
    expect(one(completed({ id: 'm', type: 'agent_message', text: 'Reading the brief.\nThen more.' }))).toMatchObject({
      kind: 'message',
      subject: 'Reading the brief.'
    })
  })

  test('a completed item whose start was never seen is an action and an instant result', () => {
    const out = translateCodexEvent(
      completed({ id: 'x', type: 'command_execution', command: 'ls', exit_code: 0 }),
      createNarrationState(),
      ctx(5)
    )
    expect(out.map((u) => u.type)).toEqual(['action', 'result'])
  })
})

describe('unknown events (O3)', () => {
  test('an unknown event, item or malformed shape yields nothing and never throws', () => {
    const state = createNarrationState()
    const odd: unknown[] = [
      {},
      { type: 'turn.completed', usage: {} },
      { type: 'item.completed', item: { id: 'e', type: 'error', message: 'x' } },
      { type: 'item.started', item: { id: 'r', type: 'reasoning', text: 'x' } },
      { type: 'item.started', item: null },
      { type: 'item.started', item: { type: 'command_execution', command: 42 } },
      { type: 'item.started', item: { id: 'f', type: 'file_change', changes: 'nope' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', arguments: 'nope', result: 7 } },
      { type: 7, item: [] }
    ]
    for (const event of odd) {
      expect(() => translateCodexEvent(event as Record<string, unknown>, state, ctx(0))).not.toThrow()
    }
    expect(translateCodexEvent(odd[1] as Record<string, unknown>, state, ctx(0))).toEqual([])
    expect(translateCodexEvent(odd[2] as Record<string, unknown>, state, ctx(0))).toEqual([])
    expect(translateCodexEvent(odd[3] as Record<string, unknown>, state, ctx(0))).toEqual([])
  })
})

describe('a recorded developer stream (O4)', () => {
  const lines = readFileSync(join(import.meta.dir, '../fixtures/loop-narration/codex-developer-stream.jsonl'), 'utf8')
    .trim()
    .split('\n')

  test('translates to the hand-written action list', () => {
    const state = createNarrationState()
    const out = lines.flatMap((line, i) => translateCodexEvent(JSON.parse(line), state, ctx(i * 1000)))
    const rendered = out.map((u) =>
      u.type === 'action'
        ? `${u.at / 1000} ${u.kind} ${u.subject}${u.confidence !== undefined ? ` ${u.confidence}` : ''}`
        : `${u.ok ? 'ok' : 'fail'} ${u.durationMs} ${u.subject}${u.error !== undefined ? ` [${u.error}]` : ''}`
    )
    expect(rendered).toEqual([
      '3 reporting completed 100',
      '4 running sed -n 1,240p',
      'ok 1000 sed -n 1,240p',
      '6 reporting completed 100',
      '7 searching rg dispatch-readiness.txt',
      'ok 1000 rg dispatch-readiness.txt',
      '9 reporting completed 100',
      '10 creating .changeset/dev-review-capabilities-contracts.md',
      '10 editing apps/cli/specs/dev-review-engine-state-machine.md',
      '10 editing apps/cli/specs/isolation.md',
      'ok 1000 .changeset/dev-review-capabilities-contracts.md',
      'ok 1000 apps/cli/specs/dev-review-engine-state-machine.md',
      'ok 1000 apps/cli/specs/isolation.md',
      '12 publishing changes',
      '13 reporting completed 100',
      'ok 2000 changes',
      '15 running bun apps/cli/src/index.ts doctrine',
      'ok 1000 bun apps/cli/src/index.ts doctrine',
      '17 github open pull request',
      'fail 1000 open pull request [pr-premise-own-additions: Premise line `- `apps/cli/specs/dev-review-engine-state-machine.md` contains: `The target Atta-Engine developer-review workflow`` n...]',
      '19 github open pull request',
      'ok 1000 open pull request',
      '21 checking all checks',
      'ok 1000 all checks',
      '23 github refresh evidence',
      'ok 1000 refresh evidence',
      '25 github read pull request',
      'ok 1000 read pull request',
      '27 running bun run build',
      'fail 1000 bun run build [exit 1]',
      '29 github update pull request text',
      'ok 1000 update pull request text',
      '31 reporting blocked',
      '32 removing cleanup-1014.ts',
      'ok 1000 cleanup-1014.ts'
    ])
    expect(state.open.size).toBe(0)
  })

  test('nothing in the translated list carries output, content or a home path', () => {
    const state = createNarrationState()
    const out = lines.flatMap((line, i) => translateCodexEvent(JSON.parse(line), state, ctx(i * 1000)))
    expect(JSON.stringify(out)).not.toMatch(/aggregated_output|\/Users\/|AEG:CLOSES|ACK: /)
  })
})

describe('Gemini stays minimal (O5)', () => {
  test('only the session start is narrated, as a working action', () => {
    const state = createNarrationState()
    expect(translateGeminiEvent({ type: 'init' }, state, ctx(7))).toEqual([
      { type: 'action', id: null, at: 7, kind: 'working', subject: 'session started' }
    ])
    for (const event of [
      { type: 'message', role: 'assistant', content: 'hi' },
      { type: 'result', status: 'success' },
      {}
    ]) {
      expect(translateGeminiEvent(event, state, ctx(0))).toEqual([])
    }
  })
})

describe('the turn result (O6)', () => {
  test('the final JSON message is one reporting action with its status and confidence only', () => {
    const text = JSON.stringify({
      turnResult: {
        schemaVersion: 1,
        status: 'completed',
        summary: 'SECRET prose',
        confidence: 87,
        confidenceExplanation: 'why'
      }
    })
    const out = translateCodexEvent(completed({ id: 'r', type: 'agent_message', text }), createNarrationState(), ctx(3))
    expect(out).toEqual([
      { type: 'action', id: 'r', at: 3, kind: 'reporting', subject: 'completed', status: 'completed', confidence: 87 }
    ])
  })

  test('a blocked result carries no confidence; a cut-off result is still never printed', () => {
    const blocked = JSON.stringify({ turnResult: { status: 'blocked', summary: 'SECRET' } })
    expect(one(completed({ id: 'r', type: 'agent_message', text: blocked }))).toMatchObject({
      kind: 'reporting',
      status: 'blocked'
    })
    const cut = one(
      completed({ id: 'r', type: 'agent_message', text: '{"turnResult":{"status":"completed","summary":"SECRET' })
    )
    expect(cut).toMatchObject({ kind: 'reporting', subject: 'turn result' })
    expect(JSON.stringify(cut)).not.toContain('SECRET')
  })
})

describe('the driver-run tools (O7)', () => {
  const tools = [
    ['fetch_documentation', { url: 'https://example.com/docs/a?q=1' }, 'fetching', 'example.com/docs/a'],
    ['run_checks', {}, 'checking', 'all checks'],
    ['publish_changes', { header: 'Fix(x): y' }, 'publishing', 'changes'],
    ['open_pull_request', { title: 't', body: 'SECRET' }, 'github', 'open pull request'],
    ['update_pull_request_body', { body: 'SECRET' }, 'github', 'update pull request text'],
    ['refresh_evidence', {}, 'github', 'refresh evidence'],
    ['read_pull_request', {}, 'github', 'read pull request']
  ] as const

  test('Codex names each as a plain action, with a refusal as a failure', () => {
    for (const [tool, args, kind, subject] of tools) {
      const state = createNarrationState()
      const item = { id: 't', type: 'mcp_tool_call', server: 'vinaya-dev-tools', tool, arguments: args }
      const out = [
        ...translateCodexEvent(started(item), state, ctx(0)),
        ...translateCodexEvent(
          completed({
            ...item,
            status: 'failed',
            result: { structured_content: { error: { check: 'gate', output: 'refused: SECRET-free reason\nmore' } } }
          }),
          state,
          ctx(5)
        )
      ]
      expect(out).toMatchObject([
        { type: 'action', kind, subject },
        { type: 'result', ok: false, durationMs: 5, error: 'refused: SECRET-free reason' }
      ])
      expect(JSON.stringify(out)).not.toContain('"SECRET"')
    }
  })

  test('Claude names each as a plain action instead of a raw tool request', () => {
    for (const [tool, args, kind, subject] of tools) {
      const state = createNarrationState()
      const call = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'u', name: `mcp__vinaya-dev-tools__${tool}`, input: args }] }
      }
      const refusal = {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'u', is_error: true, content: 'refused' }] }
      }
      const out = [...translateClaudeEvent(call, state, ctx(0)), ...translateClaudeEvent(refusal, state, ctx(4))]
      expect(out).toMatchObject([
        { type: 'action', kind, subject },
        { type: 'result', ok: false, error: 'refused' }
      ])
    }
  })

  test('another MCP tool stays a tool request', () => {
    const call = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'u', name: 'mcp__other__publish_changes', input: {} }] }
    }
    expect(translateClaudeEvent(call, createNarrationState(), ctx(0))).toMatchObject([{ kind: 'tool_request' }])
  })
})
