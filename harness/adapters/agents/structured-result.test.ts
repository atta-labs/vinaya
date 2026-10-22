import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionIdOf, structuredResult } from './structured-result'

// A recorded `codex exec --json` Developer stream (paths and bodies already elided).
const codexStream = readFileSync(join(import.meta.dir, 'codex', 'fixtures', 'codex-exec-json-developer.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')

describe('structuredResult', () => {
  test('every line of the recorded Codex stream is one JSON record, as the executor frames stdout', () => {
    for (const line of codexStream) expect(() => JSON.parse(line)).not.toThrow()
  })

  test("Codex: the last agent_message item's text, parsed, not the closing turn.completed", () => {
    const records = codexStream.map((line) => JSON.parse(line))
    expect((records.at(-1) as { type: string }).type).toBe('turn.completed')
    const result = structuredResult(records) as { turnResult: { schemaVersion: number; status: string } }
    expect(result.turnResult.schemaVersion).toBe(1)
    const lastMessage = [...records]
      .reverse()
      .find((r) => r.type === 'item.completed' && r.item.type === 'agent_message')
    expect(result).toEqual(JSON.parse(lastMessage.item.text))
  })

  test('Claude and Codex yield the same shape for the same result', () => {
    const turn = { turnResult: { schemaVersion: 1, status: 'completed', summary: 'done\nwith a newline' } }
    const claude = structuredResult([turn])
    const codex = structuredResult([
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: JSON.stringify(turn) } },
      { type: 'turn.completed', usage: {} }
    ])
    expect(codex).toEqual(claude)
    expect(codex).toEqual(turn)
  })

  test('a Codex stream with no final message, or an unparsable one, has no result', () => {
    expect(structuredResult([{ type: 'turn.started' }, { type: 'turn.completed' }])).toBeUndefined()
    expect(
      structuredResult([{ type: 'item.completed', item: { type: 'agent_message', text: 'not json' } }])
    ).toBeUndefined()
    expect(structuredResult([])).toBeUndefined()
  })
})

describe('Claude stream-json and session ids', () => {
  const turn = { turnResult: { schemaVersion: 1, status: 'completed', summary: 's' } }
  test("Claude: the final result event's structured_output", () => {
    const records = [
      { type: 'system', subtype: 'init', session_id: 'c-1' },
      { type: 'assistant', message: { content: [] } },
      { type: 'result', subtype: 'success', session_id: 'c-1', structured_output: turn }
    ]
    expect(structuredResult(records)).toEqual(turn)
    expect(sessionIdOf(records)).toBe('c-1')
  })
  test('Codex: the thread.started thread id is the session', () => {
    const records = codexStream.map((line) => JSON.parse(line))
    expect(sessionIdOf(records)).toBe('01a116cb-a5fd-7230-a764-4a4f4f7fe04b')
    expect(sessionIdOf([{ type: 'turn.started' }])).toBeUndefined()
  })
})
