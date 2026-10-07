import { describe, expect, test } from 'bun:test'
import {
  createNarrationState,
  type NarratedUpdate,
  type NarrationContext,
  openActions,
  translateClaudeEvent
} from '../../src/lib/loop-narration-claude'

const WORKTREE = '/work/repo/.worktrees/task/t/1'
const HOME = '/Users/someone'

function ctx(now: number): NarrationContext {
  return { worktree: WORKTREE, home: HOME, now }
}

function call(name: string, input: Record<string, unknown>, id: string | null = 'toolu_1') {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', ...(id ? { id } : {}), name, input }] } }
}

function result(id: string, content: unknown, isError = false) {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }
  }
}

function actionOf(name: string, input: Record<string, unknown>) {
  const [first] = translateClaudeEvent(call(name, input), createNarrationState(), ctx(0))
  if (first?.type !== 'action') throw new Error('expected an action')
  return first
}

describe('kinds and subjects (O1)', () => {
  test('file tools read their path, relative to the worktree', () => {
    expect(actionOf('Read', { file_path: `${WORKTREE}/apps/cli/src/a.ts` })).toMatchObject({
      kind: 'reading',
      subject: 'apps/cli/src/a.ts'
    })
    expect(actionOf('Edit', { file_path: `${WORKTREE}/a.ts`, old_string: 'x', new_string: 'y' }).kind).toBe('editing')
    expect(actionOf('Write', { file_path: `${WORKTREE}/b.ts`, content: 'x' }).kind).toBe('creating')
    expect(actionOf('Grep', { pattern: 'foo', path: WORKTREE })).toMatchObject({ kind: 'searching', subject: 'foo' })
    expect(actionOf('Glob', { pattern: '**/*.ts' }).kind).toBe('searching')
  })

  test('a path outside the worktree never keeps the home directory', () => {
    const a = actionOf('Read', { file_path: `${HOME}/.config/x.json` })
    expect(a.subject).toBe('~/.config/x.json')
    expect(JSON.stringify(a)).not.toContain(HOME)
  })

  test('the other tools', () => {
    expect(actionOf('Skill', { skill: 'vinaya' })).toMatchObject({ kind: 'skill', subject: 'vinaya' })
    expect(actionOf('Task', { description: 'find callers', prompt: 'long prompt' })).toMatchObject({
      kind: 'delegating',
      subject: 'find callers'
    })
    expect(actionOf('mcp__vinaya-dev-tools__publish_changes', { message: 'secret words' })).toMatchObject({
      kind: 'tool_request',
      subject: 'mcp__vinaya-dev-tools__publish_changes'
    })
  })

  test('a fetch keeps the host and path, never the query', () => {
    expect(actionOf('WebFetch', { url: 'https://example.com/docs/a?token=abc', prompt: 'p' })).toMatchObject({
      kind: 'fetching',
      subject: 'example.com/docs/a'
    })
  })
})

describe('the fixed command table (O5)', () => {
  const cases: [string, string, string][] = [
    ['rm -rf build', 'removing', 'rm build'],
    ['git rm old.ts', 'removing', 'git rm old.ts'],
    ['git clean -fd', 'removing', 'git clean'],
    ['git status --short', 'git', 'git status'],
    ['gh pr view 12', 'github', 'gh pr view 12'],
    ['bun test apps/cli/tests/a.test.ts --timeout=30000', 'running_tests', 'bun test apps/cli/tests/a.test.ts'],
    ['bun run test', 'running_tests', 'bun run test'],
    ['CI=1 npx vitest run', 'running_tests', 'npx vitest run'],
    ['bun run typecheck', 'type_checking', 'bun run typecheck'],
    ['tsc --noEmit', 'type_checking', 'tsc'],
    ['grep -rn foo src', 'searching', 'grep foo'],
    ['cat README.md | head', 'reading', 'cat README.md']
  ]
  for (const [command, kind, subject] of cases) {
    test(command, () => {
      expect(actionOf('Bash', { command })).toMatchObject({ kind, subject })
    })
  }

  test('a command outside the table is running, with its first words, never guessed further', () => {
    expect(actionOf('Bash', { command: 'unlink --force a.ts extra words here' })).toMatchObject({
      kind: 'running',
      subject: 'unlink --force a.ts'
    })
    expect(actionOf('Bash', { command: 'mv a.ts b.ts' }).kind).toBe('running')
    expect(actionOf('Bash', { command: 'bun apps/cli/src/index.ts check --all' }).kind).toBe('running')
  })

  test('a secret in a command never reaches the subject', () => {
    const a = actionOf('Bash', { command: 'curl -H Authorization: Bearer abcdefghijklmnop https://x.test' })
    expect(a.subject).not.toContain('abcdefghijklmnop')
  })
})

describe('counts without content (O2)', () => {
  test('an edit carries lines added and removed from its own old and new text', () => {
    const a = actionOf('Edit', {
      file_path: `${WORKTREE}/a.ts`,
      old_string: 'one\ntwo',
      new_string: 'one\ntwo\nthree\nfour\n'
    })
    expect(a).toMatchObject({ added: 4, removed: 2 })
    expect(JSON.stringify(a)).not.toContain('three')
  })

  test('a multi-edit sums its edits', () => {
    const a = actionOf('MultiEdit', {
      file_path: `${WORKTREE}/a.ts`,
      edits: [
        { old_string: 'a', new_string: 'b\nc' },
        { old_string: 'd\ne', new_string: '' }
      ]
    })
    expect(a).toMatchObject({ added: 2, removed: 3 })
  })

  test('a create carries its line count and never the file', () => {
    const a = actionOf('Write', { file_path: `${WORKTREE}/n.ts`, content: 'secret line\nsecond\nthird\n' })
    expect(a).toMatchObject({ kind: 'creating', lines: 3 })
    expect(a.added).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('secret line')
  })
})

describe('the turn result is one reporting action', () => {
  test('it carries its status and confidence, never the summary or findings', () => {
    const a = actionOf('StructuredOutput', {
      turnResult: {
        schemaVersion: 1,
        status: 'completed',
        summary: 'SECRET SUMMARY',
        confidence: 88,
        addressedFindingIds: ['R1-CR-1'],
        reportedChecks: [{ command: 'SECRET CMD', outcome: 'pass' }]
      }
    })
    expect(a).toMatchObject({ kind: 'reporting', subject: 'completed', status: 'completed', confidence: 88 })
    expect(JSON.stringify(a)).not.toContain('SECRET')
    expect(JSON.stringify(a)).not.toContain('R1-CR-1')
  })

  test('a blocked result has a status and no confidence; prose in the status is dropped', () => {
    const blocked = actionOf('StructuredOutput', { turnResult: { status: 'blocked', summary: 'x' } })
    expect(blocked.confidence).toBeUndefined()
    expect(blocked.status).toBe('blocked')
    const odd = actionOf('StructuredOutput', { status: 'free text with SECRET', confidence: 'high' })
    expect(odd).toMatchObject({ kind: 'reporting', subject: 'turn result' })
    expect(odd.status).toBeUndefined()
    expect(odd.confidence).toBeUndefined()
  })
})

describe('results, durations and open calls (O3, O4)', () => {
  test('a result is matched by identifier, out of order, with its own duration', () => {
    const state = createNarrationState()
    translateClaudeEvent(call('Read', { file_path: `${WORKTREE}/a.ts` }, 'A'), state, ctx(1000))
    translateClaudeEvent(call('Read', { file_path: `${WORKTREE}/b.ts` }, 'B'), state, ctx(1500))
    const [rb] = translateClaudeEvent(result('B', 'file b body'), state, ctx(2500))
    const [ra] = translateClaudeEvent(result('A', 'file a body'), state, ctx(4000))
    expect(rb).toMatchObject({ type: 'result', id: 'B', subject: 'b.ts', ok: true, durationMs: 1000 })
    expect(ra).toMatchObject({ type: 'result', id: 'A', subject: 'a.ts', ok: true, durationMs: 3000 })
    expect(JSON.stringify([ra, rb])).not.toContain('body')
  })

  test('a failure keeps its first error line, shortened and redacted', () => {
    const state = createNarrationState()
    translateClaudeEvent(call('Bash', { command: 'bun test' }), state, ctx(0))
    const long = `${HOME}/x failed with ${'z'.repeat(400)}`
    const [r] = translateClaudeEvent(
      result('toolu_1', [{ type: 'text', text: `\n${long}\nsecond line` }], true),
      state,
      ctx(10)
    )
    if (r?.type !== 'result') throw new Error('expected a result')
    expect(r.ok).toBe(false)
    expect(r.error?.startsWith('~/x failed with')).toBe(true)
    expect(r.error?.length).toBeLessThanOrEqual(160)
    expect(r.error).not.toContain('second line')
  })

  test('a result naming no known call, or answered twice, yields nothing', () => {
    const state = createNarrationState()
    expect(translateClaudeEvent(result('ghost', 'x'), state, ctx(0))).toEqual([])
    translateClaudeEvent(call('Read', { file_path: 'a.ts' }, 'A'), state, ctx(0))
    expect(translateClaudeEvent(result('A', 'x'), state, ctx(1))).toHaveLength(1)
    expect(translateClaudeEvent(result('A', 'x'), state, ctx(2))).toEqual([])
  })

  test('calls without a result are open, longest first, with their age', () => {
    const state = createNarrationState()
    translateClaudeEvent(call('Read', { file_path: 'a.ts' }, 'A'), state, ctx(1000))
    translateClaudeEvent(call('Bash', { command: 'bun test' }, 'B'), state, ctx(3000))
    translateClaudeEvent(call('Read', { file_path: 'c.ts' }, null), state, ctx(3000))
    translateClaudeEvent(result('A', 'ok'), state, ctx(3500))
    expect(openActions(state, 8000)).toEqual([{ id: 'B', kind: 'running_tests', subject: 'bun test', openForMs: 5000 }])
  })

  test('events of other types yield nothing', () => {
    const state = createNarrationState()
    expect(translateClaudeEvent({ type: 'system', subtype: 'init' }, state, ctx(0))).toEqual([])
    expect(
      translateClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, state, ctx(0))
    ).toEqual([])
  })
})

describe('hand-written streams (O6)', () => {
  function run(events: Record<string, unknown>[]): NarratedUpdate[] {
    const state = createNarrationState()
    return events.flatMap((e, i) => translateClaudeEvent(e, state, ctx(i * 1000)))
  }

  test('a developer run', () => {
    const updates = run([
      { type: 'system', subtype: 'init' },
      call('Read', { file_path: `${WORKTREE}/apps/cli/src/a.ts` }, 'd1'),
      result('d1', 'SECRET FILE BODY'),
      call('Edit', { file_path: `${WORKTREE}/apps/cli/src/a.ts`, old_string: 'a', new_string: 'a\nb' }, 'd2'),
      result('d2', 'edited SECRET'),
      call('Write', { file_path: `${WORKTREE}/apps/cli/tests/a.test.ts`, content: 'x\ny\n' }, 'd3'),
      result('d3', 'created'),
      call('Bash', { command: 'bun test apps/cli/tests/a.test.ts' }, 'd4'),
      result('d4', '1 fail\nSECRET OUTPUT', true),
      call('StructuredOutput', { turnResult: { status: 'completed', summary: 'SECRET', confidence: 90 } }, 'd5'),
      result('d5', 'Structured output provided successfully')
    ])
    expect(
      updates.map((u) =>
        u.type === 'action'
          ? `${u.kind} ${u.subject}${u.confidence !== undefined ? ` confidence ${u.confidence}` : ''}${u.added !== undefined ? ` +${u.added}/-${u.removed}` : ''}${u.lines !== undefined ? ` ${u.lines} lines` : ''}`
          : `${u.ok ? 'ok' : `failed: ${u.error}`} ${u.durationMs}`
      )
    ).toEqual([
      'reading apps/cli/src/a.ts',
      'ok 1000',
      'editing apps/cli/src/a.ts +2/-1',
      'ok 1000',
      'creating apps/cli/tests/a.test.ts 2 lines',
      'ok 1000',
      'running_tests bun test apps/cli/tests/a.test.ts',
      'failed: 1 fail 1000',
      'reporting completed confidence 90',
      'ok 1000'
    ])
    expect(JSON.stringify(updates)).not.toContain('SECRET')
  })

  test('a reviewer run', () => {
    const updates = run([
      call('Bash', { command: 'gh pr diff 12' }, 'r1'),
      result('r1', 'DIFF BODY'),
      call('Grep', { pattern: 'renderClaudeEvent', path: WORKTREE }, 'r2'),
      result('r2', 'MATCH BODY'),
      call('Skill', { skill: 'code-review' }, 'r3'),
      result('r3', 'SKILL BODY'),
      call('WebFetch', { url: 'https://docs.example.com/x?key=1' }, 'r4'),
      result('r4', 'PAGE BODY')
    ])
    expect(updates.filter((u) => u.type === 'action').map((u) => `${u.kind} ${u.subject}`)).toEqual([
      'github gh pr diff 12',
      'searching renderClaudeEvent',
      'skill code-review',
      'fetching docs.example.com/x'
    ])
    expect(updates.filter((u) => u.type === 'result').every((u) => u.type === 'result' && u.ok)).toBe(true)
    expect(JSON.stringify(updates)).not.toContain('BODY')
  })
})
