import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatAgentDetails, formatAgentLine, logQuiet, renderNarratedUpdate } from '../../src/lib/agent-line.js'
import { createAgentStreamRenderer } from '../../src/lib/agent-stream.js'
import { renderClaudeEvent, renderCodexEvent } from '../../src/lib/dispatch.js'
import { appendRoleLine } from '../../src/lib/loop-log.js'

describe('formatAgentLine', () => {
  const now = new Date('2026-10-08T03:04:05.678Z')

  it('uses the terminal-friendly role label, local clock, and Unicode mark by default', () => {
    expect(formatAgentLine('code-reviewer', 'reading the brief', { now })).toMatch(
      /^\d{2}:\d{2}:\d{2} {2}▸ Code review {3}reading the brief$/
    )
  })

  it('uses an ISO timestamp and ASCII mark for a non-interactive log line', () => {
    expect(formatAgentLine('developer', 'waiting 10s…', { now, log: true, unicode: false, mark: 'waiting' })).toBe(
      '2026-10-08T03:04:05.678Z  ~ Developer   waiting 10s…'
    )
  })
})

describe('formatAgentDetails', () => {
  it('suppresses details only when quiet mode is enabled', () => {
    expect(logQuiet({ VINAYA_LOG_QUIET: 'true' })).toBe(true)
    expect(formatAgentDetails(['first', '', 'second'], true)).toEqual([])
    expect(formatAgentDetails(['first', '', 'second'], false)).toEqual(['  · first', '  · second'])
  })
})

describe('renderNarratedUpdate (O1)', () => {
  const action = { type: 'action', id: 'a', at: 0 } as const

  it('renders an edit with its subject and line counts', () => {
    expect(
      renderNarratedUpdate({
        ...action,
        kind: 'editing',
        subject: 'apps/cli/src/lib/dispatch.ts',
        added: 14,
        removed: 3
      })
    ).toEqual({ words: 'Editing apps/cli/src/lib/dispatch.ts +14 −3', mark: 'working', details: [] })
  })

  it('renders a success as a done line with its duration', () => {
    expect(
      renderNarratedUpdate({
        type: 'result',
        id: 'a',
        kind: 'running_tests',
        subject: 'a.test.ts',
        ok: true,
        durationMs: 2300
      })
    ).toEqual({ words: 'Finished running tests a.test.ts in 2.3s', mark: 'done', details: [] })
  })

  it('renders a failure as a failed line with its first error line beneath', () => {
    expect(
      renderNarratedUpdate({
        type: 'result',
        id: 'a',
        kind: 'running',
        subject: 'bun run build',
        ok: false,
        durationMs: 40,
        error: 'exit 2'
      })
    ).toEqual({ words: 'Failed running bun run build after 40ms', mark: 'failed', details: ['exit 2'] })
  })

  it('puts a message in the detail, not the primary line', () => {
    expect(renderNarratedUpdate({ ...action, kind: 'message', subject: 'hello there' })).toEqual({
      words: 'Writing',
      mark: 'working',
      details: ['hello there']
    })
  })
})

describe('the dispatcher renders each agent’s stream through its translator (O2, O4)', () => {
  const home = '/Users/someone'
  const worktree = '/work/repo'

  function replay(agent: 'claude' | 'codex', events: Record<string, unknown>[]) {
    const renderer = createAgentStreamRenderer(
      agent,
      { worktree, home },
      agent === 'claude' ? renderClaudeEvent : renderCodexEvent,
      () => 0
    )
    return events.flatMap((e) => renderer.render(e))
  }

  const codexFixture = readFileSync(
    join(import.meta.dir, '../fixtures/loop-narration/codex-developer-stream.jsonl'),
    'utf8'
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

  it('replays the recorded Codex stream with no event name in any line', () => {
    const lines = replay('codex', codexFixture)
    expect(lines.length).toBeGreaterThan(0)
    const all = lines.flatMap((l) => [l.words, ...l.details]).join('\n')
    expect(all).not.toMatch(/item\.(started|completed)|turn\.(started|completed)|thread\.started/)
    expect(lines.some((l) => l.words.startsWith('Reporting'))).toBe(true)
  })

  it('narrates the same work with the same verbs on both agents', () => {
    const claude = replay('claude', [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf build' } }] }
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom\nmore', is_error: true }] }
      }
    ])
    const command = `/bin/zsh -lc 'rm -rf build'`
    const codex = replay('codex', [
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command, status: 'in_progress' } },
      {
        type: 'item.completed',
        item: {
          id: 'c1',
          type: 'command_execution',
          command,
          status: 'failed',
          exit_code: 1,
          aggregated_output: 'SECRET'
        }
      }
    ])
    expect(claude.map((l) => l.words.split(' ')[0])).toEqual(['Removing', 'Failed'])
    expect(codex.map((l) => l.words.split(' ')[0])).toEqual(['Removing', 'Failed'])
    expect(claude[1]).toMatchObject({ mark: 'failed', details: ['boom'] })
    expect(codex[1]).toMatchObject({ mark: 'failed', details: ['exit 1'] })
    expect(codex[0]?.details).toEqual(['rm -rf build'])
    expect(JSON.stringify(codex)).not.toContain('SECRET')
  })

  it('writes real marks and every detail line to the file, whatever the view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stream-'))
    const path = join(dir, 'driver.log')
    const lines = replay('claude', [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking out loud' }] } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/work/repo/a.ts' } }] }
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'nope', is_error: true }] }
      }
    ])
    for (const l of lines) appendRoleLine(path, 'developer', l.words, l.details, l.mark)
    const file = readFileSync(path, 'utf8')
    expect(file).toMatch(/> Developer {3}Working$/m)
    expect(file).toMatch(/· thinking out loud$/m)
    expect(file).toMatch(/> Developer {3}Reading a\.ts$/m)
    expect(file).toMatch(/x Developer {3}Failed reading a\.ts after 0ms$/m)
    expect(file).toMatch(/· nope$/m)
  })

  it('drops an unhandled event whose old text is only an event name', () => {
    expect(replay('codex', [{ type: 'turn.completed' }])).toEqual([])
  })
})
