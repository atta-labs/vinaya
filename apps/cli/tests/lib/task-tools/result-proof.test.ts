import { describe, expect, it } from 'bun:test'
import {
  DEVELOPER_TURN_RESULT_SCHEMA_VERSION,
  type DeveloperTurnContext,
  developerTurnResultJsonSchema,
  validateDeveloperTurnResult
} from '../../../src/lib/developer-turn-result.js'
import {
  accountEnv,
  driverVerdict,
  judgeCase,
  PROOF_TURN_CONTEXT,
  parseResultProofArgs,
  proofCases,
  readClaudeTurnOutput,
  readCodexTurnOutput,
  redactProviderText,
  shellQuote
} from '../../../src/lib/task-tools/result-proof.js'
import { spawnSyncBudgeted, stripVinayaEnv } from '../process-fixture.js'

/**
 * The structured-result proof's pure parts: the shared DeveloperTurnResult
 * schema and its semantic validator (O4), the per-vendor stream readers, the
 * adapter-boundary verdict and the per-case judge. The live dispatches are the
 * command itself (`vinaya task-tools result-proof --agent <claude|codex>`).
 */

const context: DeveloperTurnContext = {
  knownFindingIds: ['R1-CR-1', 'R1-SEC-1'],
  requiredSources: ['https://example.com/doc'],
  permissibleDecisions: ['supersede-surface', 'stop-task']
}

const v = DEVELOPER_TURN_RESULT_SCHEMA_VERSION
const completed = {
  schemaVersion: v,
  status: 'completed',
  summary: 'did the work',
  confidence: 90,
  confidenceExplanation: 'every check passed',
  addressedFindingIds: ['R1-CR-1'],
  sourceUses: [{ source: 'https://example.com/doc', use: 'decided the flag' }],
  reportedChecks: [{ command: 'bun test', outcome: 'pass' }]
}
const blocked = {
  schemaVersion: v,
  status: 'blocked',
  summary: 'cannot start',
  blocker: { kind: 'dependency_unmerged', detail: 'the dependency PR is open' },
  sourceUses: null
}
const needsRuling = {
  schemaVersion: v,
  status: 'needs_ruling',
  summary: 'the Surface is too narrow',
  rulingRequest: { question: 'Widen the Surface?', decisions: ['supersede-surface'] },
  sourceUses: null
}
const wrap = (turnResult: unknown) => ({ turnResult })

describe('DeveloperTurnResult — valid examples of every variant', () => {
  it('accepts completed, blocked and needs_ruling', () => {
    for (const example of [completed, blocked, needsRuling]) {
      const out = validateDeveloperTurnResult(wrap(example), context)
      expect(out).toEqual({ ok: true, result: example as never })
    }
  })
  it('accepts null for every optional field', () => {
    const minimal = { ...completed, reportedChecks: null }
    expect(validateDeveloperTurnResult(wrap(minimal), context).ok).toBe(true)
    expect(
      validateDeveloperTurnResult(wrap({ ...completed, sourceUses: null }), { ...context, requiredSources: [] }).ok
    ).toBe(true)
    expect(
      validateDeveloperTurnResult(wrap({ ...completed, sourceUses: [] }), { ...context, requiredSources: [] }).ok
    ).toBe(false)
  })
})

describe('DeveloperTurnResult — schema rejections', () => {
  const schemaInvalid: [string, unknown][] = [
    ['no wrapper', completed],
    ['unknown status', { ...completed, status: 'done' }],
    ['wrong schema version', { ...completed, schemaVersion: 2 }],
    ['missing schemaVersion', (({ schemaVersion: _s, ...rest }) => rest)(completed)],
    ['confidence on blocked', { ...blocked, confidence: 80 }],
    ['confidence on needs_ruling', { ...needsRuling, confidence: 80 }],
    ['confidence not a number', { ...completed, confidence: 'high' }],
    ['confidence above 100', { ...completed, confidence: 101 }],
    ['confidence not whole', { ...completed, confidence: 90.5 }],
    ['missing summary', (({ summary: _s, ...rest }) => rest)(completed)],
    ['empty summary', { ...completed, summary: '' }],
    ['extra field', { ...completed, notes: 'x' }],
    ['completed without confidenceExplanation', (({ confidenceExplanation: _c, ...rest }) => rest)(completed)],
    ['blocked with an untyped blocker', { ...blocked, blocker: 'stuck' }],
    ['blocked with an unknown blocker kind', { ...blocked, blocker: { kind: 'tired', detail: 'x' } }],
    ['needs_ruling without rulingRequest', (({ rulingRequest: _r, ...rest }) => rest)(needsRuling)],
    ['reported check with an unknown outcome', { ...completed, reportedChecks: [{ command: 'x', outcome: 'skipped' }] }]
  ]
  for (const [name, value] of schemaInvalid) {
    it(`rejects ${name}`, () => {
      const out = validateDeveloperTurnResult(name === 'no wrapper' ? value : wrap(value), context)
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.stage).toBe('schema')
    })
  }
})

describe('DeveloperTurnResult — semantic rejections', () => {
  const cases: [string, unknown, string][] = [
    ['an unknown finding id', { ...completed, addressedFindingIds: ['R9-XX-1'] }, 'R1-CR-1'],
    [
      'a ruling request naming no permissible decision',
      { ...needsRuling, rulingRequest: { question: 'Merge?', decisions: ['merge-without-review'] } },
      'names no permissible decision'
    ],
    [
      'a ruling request naming no decision at all',
      { ...needsRuling, rulingRequest: { question: 'Merge?', decisions: [] } },
      'names no permissible decision'
    ],
    [
      'a ruling request mixing in an impermissible decision',
      { ...needsRuling, rulingRequest: { question: 'Merge?', decisions: ['stop-task', 'merge-now'] } },
      '"merge-now" is not a permissible decision'
    ],
    ['completed with no sourceUses when sources are required', { ...completed, sourceUses: null }, 'sourceUses'],
    [
      'completed leaving a required source unreported',
      { ...completed, sourceUses: [{ source: 'https://other.example', use: 'x' }] },
      'https://example.com/doc'
    ],
    [
      'a confidenceExplanation over the shared bound',
      { ...completed, confidenceExplanation: 'x'.repeat(281) },
      'confidenceExplanation'
    ]
  ]
  for (const [name, value, error] of cases) {
    it(`rejects ${name}`, () => {
      const out = validateDeveloperTurnResult(wrap(value), context)
      expect(out.ok).toBe(false)
      if (!out.ok) {
        expect(out.errors.join('\n')).toContain(error)
      }
    })
  }
  it('does not require sourceUses on blocked or needs_ruling', () => {
    expect(validateDeveloperTurnResult(wrap(blocked), context).ok).toBe(true)
    expect(validateDeveloperTurnResult(wrap(needsRuling), context).ok).toBe(true)
  })
})

describe('developerTurnResultJsonSchema', () => {
  const schema = developerTurnResultJsonSchema(context)
  it('is a plain object root holding the union under turnResult, with no $schema keyword', () => {
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['turnResult'])
    expect(schema.additionalProperties).toBe(false)
    expect('$schema' in schema).toBe(false)
    const union = (schema.properties as { turnResult: { anyOf: { properties: { status: { const: string } } }[] } })
      .turnResult.anyOf
    expect(union.map((variant) => variant.properties.status.const)).toEqual(['completed', 'blocked', 'needs_ruling'])
  })
  it('requires every property of every object and forbids extra ones (strict structured-output shape)', () => {
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) visit(item)
        return
      }
      if (node === null || typeof node !== 'object') return
      const obj = node as Record<string, unknown>
      if (obj.type === 'object' && obj.properties) {
        expect(obj.additionalProperties).toBe(false)
        expect([...(obj.required as string[])].sort()).toEqual(Object.keys(obj.properties as object).sort())
      }
      for (const value of Object.values(obj)) visit(value)
    }
    visit(schema)
  })
})

describe('parseResultProofArgs', () => {
  it('accepts --agent claude and --agent codex', () => {
    expect(parseResultProofArgs(['--agent', 'claude'])).toEqual({ agent: 'claude' })
    expect(parseResultProofArgs(['--agent', 'codex'])).toEqual({ agent: 'codex' })
  })
  it('refuses a missing or unknown agent', () => {
    expect('error' in parseResultProofArgs([])).toBe(true)
    expect('error' in parseResultProofArgs(['--agent'])).toBe(true)
    expect('error' in parseResultProofArgs(['--agent', 'gemini'])).toBe(true)
  })
})

const proofCompleted = (summary: string) =>
  wrap({
    ...completed,
    summary,
    sourceUses: [{ source: PROOF_TURN_CONTEXT.requiredSources[0], use: 'x' }]
  })
const lines = (...events: unknown[]): string => events.map((e) => JSON.stringify(e)).join('\n')

describe('readClaudeTurnOutput', () => {
  it('reads structured_output off a success result and counts every StructuredOutput emission', () => {
    const stdout = lines(
      { type: 'system', subtype: 'init', session_id: 's-1' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: proofCompleted('a') }] }
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: proofCompleted('b') }] }
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: 's-1', structured_output: proofCompleted('b') }
    )
    const read = readClaudeTurnOutput(`${stdout}\nnot json`)
    expect(read.sessionId).toBe('s-1')
    expect(read.emissions).toHaveLength(2)
    expect(read.terminalResults).toBe(1)
    expect(read.raw).toEqual(proofCompleted('b'))
    expect(read.event).toContain('structured_output')
  })
  it('reads nothing from an error result, even one carrying a value', () => {
    const read = readClaudeTurnOutput(
      lines({
        type: 'result',
        subtype: 'error_max_structured_output_retries',
        is_error: true,
        result: 'gave up',
        structured_output: proofCompleted('x')
      })
    )
    expect(read.event).toBeNull()
    expect(read.terminal).toBe('error_max_structured_output_retries (is_error)')
    expect(read.errors).toContain('gave up')
  })
  it('reads nothing from a stream that never reached a result (a cancelled run)', () => {
    const read = readClaudeTurnOutput(lines({ type: 'system', subtype: 'init', session_id: 's-2' }))
    expect(read).toMatchObject({ sessionId: 's-2', event: null, raw: null, terminal: null })
  })
})

describe('readCodexTurnOutput', () => {
  it('reads the final agent message of a completed turn as JSON', () => {
    const read = readCodexTurnOutput(
      lines(
        { type: 'thread.started', thread_id: 't-1' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(proofCompleted('a')) } },
        { type: 'turn.completed', usage: {} }
      )
    )
    expect(read).toMatchObject({ sessionId: 't-1', terminal: 'turn.completed', terminalResults: 1 })
    expect(read.raw).toEqual(proofCompleted('a'))
  })
  it('reads nothing from a failed turn', () => {
    const read = readCodexTurnOutput(
      lines(
        { type: 'thread.started', thread_id: 't-2' },
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(proofCompleted('a')) } },
        { type: 'turn.failed', error: { message: 'context window exceeded' } }
      )
    )
    expect(read.event).toBeNull()
    expect(read.errors).toContain('context window exceeded')
  })
  it('keeps non-JSON final text as raw text, which the adapter then refuses', () => {
    const read = readCodexTurnOutput(
      lines(
        { type: 'turn.started' },
        { type: 'item.completed', item: { type: 'agent_message', text: 'done!' } },
        { type: 'turn.completed' }
      )
    )
    expect(read.raw).toBe('done!')
    expect(driverVerdict(read, PROOF_TURN_CONTEXT).crossed).toBe(false)
  })
})

const readOf = (raw: unknown, extra: Partial<ReturnType<typeof readClaudeTurnOutput>> = {}) => ({
  sessionId: 's-1',
  emissions: [raw],
  terminalResults: raw === null ? 0 : 1,
  terminal: 'success',
  event: raw === null ? null : 'result',
  raw,
  errors: [],
  ...extra
})

describe('driverVerdict — the adapter boundary', () => {
  it('lets only a schema-valid value cross, and accepts it when it is semantically valid', () => {
    expect(driverVerdict(readOf(proofCompleted('a')), PROOF_TURN_CONTEXT)).toMatchObject({
      crossed: true,
      accepted: true
    })
  })
  it('never lets malformed output cross', () => {
    const verdict = driverVerdict(readOf(wrap({ ...completed, confidence: 'high' })), PROOF_TURN_CONTEXT)
    expect(verdict.crossed).toBe(false)
  })
  it('keeps handoff violations from crossing the adapter boundary', () => {
    const value = wrap({ ...completed, addressedFindingIds: ['R9-XX-404'], sourceUses: null })
    const verdict = driverVerdict(readOf(value), PROOF_TURN_CONTEXT)
    expect(verdict).toMatchObject({ crossed: false })
  })
})

describe('judgeCase', () => {
  it('passes an accepted first result only when it is the expected emission and the only one', () => {
    const read = readOf(proofCompleted('first-n'))
    expect(
      judgeCase({ kind: 'accepted', summary: 'first-n' }, read, driverVerdict(read, PROOF_TURN_CONTEXT)).pass
    ).toBe(true)
    const other = readOf(proofCompleted('other-n'))
    const judged = judgeCase({ kind: 'accepted', summary: 'first-n' }, other, driverVerdict(other, PROOF_TURN_CONTEXT))
    expect(judged.pass).toBe(false)
    expect(judged.why.join('\n')).toContain('"other-n"')
  })
  it('fails a resume on another session, or one that returned the earlier result', () => {
    const read = readOf(proofCompleted('resumed-n'), { sessionId: 's-other' })
    const verdict = driverVerdict(read, PROOF_TURN_CONTEXT)
    const judged = judgeCase({ kind: 'accepted', summary: 'resumed-n', resumes: 'first' }, read, verdict, {
      firstSessionId: 's-1',
      firstSummary: 'first-n'
    })
    expect(judged.pass).toBe(false)
    const reused = readOf(proofCompleted('first-n'))
    expect(
      judgeCase(
        { kind: 'accepted', summary: 'first-n', resumes: 'first' },
        reused,
        driverVerdict(reused, PROOF_TURN_CONTEXT),
        {
          firstSessionId: 's-1',
          firstSummary: 'first-n'
        }
      ).why.join('\n')
    ).toContain('returned the earlier turn result')
  })
  it('fails when more than one result was accepted from one invocation', () => {
    const read = readOf(proofCompleted('a'), { terminalResults: 2 })
    expect(judgeCase({ kind: 'accepted', summary: 'a' }, read, driverVerdict(read, PROOF_TURN_CONTEXT)).pass).toBe(
      false
    )
  })
  it('keeps a schema rejection outside controller-rejection cases', () => {
    const value = wrap({ ...completed, addressedFindingIds: ['R9-XX-404'], sourceUses: null })
    const read = readOf(value)
    const verdict = driverVerdict(read, PROOF_TURN_CONTEXT)
    expect(judgeCase({ kind: 'rejected', error: 'R1-CR-1' }, read, verdict).pass).toBe(false)
    const valid = readOf(proofCompleted('a'))
    expect(
      judgeCase({ kind: 'rejected', error: 'unknown finding id' }, valid, driverVerdict(valid, PROOF_TURN_CONTEXT)).pass
    ).toBe(false)
  })
  it('refuses a missing source at the schema boundary', () => {
    const missing = readOf(wrap({ ...completed, summary: 'missing-source-n', sourceUses: null }))
    const firstVerdict = driverVerdict(missing, PROOF_TURN_CONTEXT)
    expect(firstVerdict).toMatchObject({ crossed: false })
  })
  it('passes the malformed case either way nothing malformed crossed, and the no-result cases only with no acceptance', () => {
    const none = readOf(null)
    expect(judgeCase({ kind: 'never-malformed' }, none, driverVerdict(none, PROOF_TURN_CONTEXT)).pass).toBe(true)
    expect(judgeCase({ kind: 'none' }, none, driverVerdict(none, PROOF_TURN_CONTEXT)).pass).toBe(true)
    const accepted = readOf(proofCompleted('a'))
    expect(judgeCase({ kind: 'none' }, accepted, driverVerdict(accepted, PROOF_TURN_CONTEXT)).pass).toBe(false)
  })
})

describe('proofCases', () => {
  it('runs the first session first and the resume second, and covers every rejection case', () => {
    for (const agent of ['claude', 'codex'] as const) {
      const cases = proofCases(agent, 'n')
      expect(cases[0]?.name).toBe('first session')
      expect(cases[1]).toMatchObject({ name: 'resumed session', resume: true })
      expect(cases.map((c) => c.name)).toEqual([
        'first session',
        'resumed session',
        'missing required source — rejected, then corrected in the same session',
        'unknown finding id',
        'ruling request naming no permissible decision',
        'malformed model output',
        'cancelled run',
        'provider error',
        'context exhaustion'
      ])
    }
  })
  it('expects the first result itself on both CLIs — no Stop hook takes part in selecting it (O6)', () => {
    expect(proofCases('claude', 'n')[0]?.expectation).toEqual({ kind: 'accepted', summary: 'first-n' })
    expect(proofCases('codex', 'n')[0]?.expectation).toEqual({ kind: 'accepted', summary: 'first-n' })
  })
  it('replaces the forced Stop-hook case with the controller-rejection case, resumed once', () => {
    const c = proofCases('claude', 'n').find((x) => x.correctOnce === true)
    expect(c?.expectation).toEqual({ kind: 'rejected-then-accepted', error: 'sourceUses' })
    expect(c?.prompt).toContain('sourceUses null')
  })
  it('never asks the model for its reasoning', () => {
    for (const c of proofCases('claude', 'n')) expect(c.prompt.toLowerCase()).not.toContain('reasoning')
  })
})

describe('accountEnv', () => {
  it('keeps the parent USER/LOGNAME, and fills only what is missing from the OS account', () => {
    expect(accountEnv({ USER: 'a', LOGNAME: 'b' }, () => 'os')).toEqual({ USER: 'a', LOGNAME: 'b' })
    expect(accountEnv({ USER: 'a' }, () => 'os')).toEqual({ USER: 'a', LOGNAME: 'a' })
    expect(accountEnv({}, () => 'os')).toEqual({ USER: 'os', LOGNAME: 'os' })
  })
})

describe('shellQuote', () => {
  it('passes a path holding quotes, dollars and spaces to the shell as one literal word', () => {
    const tricky = `/tmp/a b/"q"/$HOME/it's/\`x\``
    const r = spawnSyncBudgeted('/bin/sh', ['-c', `printf %s ${shellQuote(tricky)}`], {
      encoding: 'utf8',
      env: stripVinayaEnv()
    })
    expect(r.stdout).toBe(tricky)
  })
})

describe('redactProviderText', () => {
  it('replaces the home directory and email-shaped text before provider output is printed', () => {
    expect(redactProviderText('open /Users/me/.claude/x for me@example.com failed', '/Users/me')).toBe(
      'open ~/.claude/x for <email> failed'
    )
  })
  it('leaves text without either unchanged', () => {
    expect(redactProviderText('Prompt is too long', '/Users/me')).toBe('Prompt is too long')
  })
})
