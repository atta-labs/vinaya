import { expect, test } from 'bun:test'
import { type AgentStep, createAgentStreamRenderer } from './agent-stream.js'

type Json = Record<string, unknown>
const context = { worktree: '/work/tree', home: '/home/someone' }

function run(agent: 'claude' | 'codex', events: Json[], times: number[]) {
  const steps: AgentStep[] = []
  let clock = 0
  const withObserver = createAgentStreamRenderer(
    agent,
    context,
    () => null,
    () => times[clock++] ?? 0,
    (step) => steps.push(step)
  )
  let plainClock = 0
  const plain = createAgentStreamRenderer(
    agent,
    context,
    () => null,
    () => times[plainClock++] ?? 0
  )
  const observed = events.map((e) => withObserver.render(e))
  const unobserved = events.map((e) => plain.render(e))
  return { steps, observed, unobserved }
}

test('a Claude stream hands the observer one start and one result per tool call, and the lines are unchanged', () => {
  const secret = 'SECRET-FILE-CONTENT'
  const events: Json[] = [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun test src/a.test.ts' } },
          { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/work/tree/src/a.ts' } }
        ]
      }
    },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_2', content: secret, is_error: false },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '3 fail\n1 pass', is_error: true }
        ]
      }
    }
  ]
  const { steps, observed, unobserved } = run('claude', events, [1_000, 1_400])
  expect(observed).toEqual(unobserved)
  const starts = steps.filter((s) => s.type === 'start')
  const results = steps.filter((s) => s.type === 'result')
  expect(starts.map((s) => s.id)).toEqual(['toolu_1', 'toolu_2'])
  expect(results.map((s) => s.id).sort()).toEqual(['toolu_1', 'toolu_2'])
  const bash = starts.find((s) => s.id === 'toolu_1')
  expect(bash).toMatchObject({ tool: 'Bash', kind: 'running_tests', at: 1_000 })
  const failed = results.find((s) => s.id === 'toolu_1') as Extract<AgentStep, { type: 'result' }>
  expect(failed).toMatchObject({ ok: false, durationMs: 400 })
  // Never a tool's input or output: the file's content and the command's full text appear in no step.
  expect(JSON.stringify(steps)).not.toContain(secret)
})

test('a Codex stream hands the observer one start and one result per tool call, and the lines are unchanged', () => {
  const events: Json[] = [
    {
      type: 'item.started',
      item: { id: 'item_1', type: 'command_execution', command: 'ls -la', status: 'in_progress' }
    },
    {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'ls -la',
        status: 'completed',
        exit_code: 0,
        aggregated_output: 'TOP-SECRET-OUTPUT'
      }
    },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Done with the work.' } }
  ]
  const { steps, observed, unobserved } = run('codex', events, [2_000, 2_300, 2_400])
  expect(observed).toEqual(unobserved)
  expect(steps.map((s) => `${s.type}:${s.id}`)).toEqual(['start:item_1', 'result:item_1'])
  expect(steps[0]).toMatchObject({ tool: 'command_execution', at: 2_000 })
  expect(steps[1]).toMatchObject({ ok: true, durationMs: 300 })
  expect(JSON.stringify(steps)).not.toContain('TOP-SECRET-OUTPUT')
})

test('an observer that throws changes nothing the renderer returns', () => {
  const event: Json = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/work/tree/x.ts' } }] }
  }
  const throwing = createAgentStreamRenderer(
    'claude',
    context,
    () => null,
    undefined,
    () => {
      throw new Error('observer failed')
    }
  )
  const plain = createAgentStreamRenderer('claude', context, () => null)
  expect(throwing.render(event).map((l) => l.words)).toEqual(plain.render(event).map((l) => l.words))
})
