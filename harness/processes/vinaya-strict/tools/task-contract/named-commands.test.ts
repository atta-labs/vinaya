import { describe, expect, it } from 'bun:test'
import type { CommandReferenceFacts } from './issue-validation'
import { checkQuotedCommandsExist } from './named-commands'

const REFERENCE: CommandReferenceFacts = {
  file: 'harness/processes/vinaya-strict/integration/commands.ts',
  binary: 'vinaya',
  commands: [
    { name: 'help', flags: [], needs: [] },
    { name: 'task run', flags: [], needs: [] },
    { name: 'task status', flags: [], needs: [] },
    { name: 'pr rule', flags: [], needs: ['forge'] }
  ],
  text: ''
}

type Fields = { objective?: string; part?: string; trap?: string; testPlan?: string }

function body({
  objective = 'A task runs.',
  part = 'Part 1 (O1) — the task runs.',
  trap = 'Nothing special.',
  testPlan = 'bun test a.test.ts → 0 fail'
}: Fields = {}): string {
  return [
    '**Traps to avoid** — ' + trap,
    '',
    '## Objectives',
    '',
    `O1. ${objective}`,
    '',
    '## Parts',
    '',
    `${part}`,
    '',
    '## Test plan',
    '',
    '```',
    testPlan,
    '```',
    ''
  ].join('\n')
}

describe('checkQuotedCommandsExist', () => {
  it('refuses a quoted command the reference lacks, naming it', () => {
    const result = checkQuotedCommandsExist(body({ trap: 'Run `vinaya frobnicate --now` first.' }), REFERENCE)
    expect(result.status).toBe('fail')
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('`vinaya frobnicate`')
  })

  it('passes a quoted command the reference carries, with arguments after it', () => {
    const result = checkQuotedCommandsExist(
      body({ trap: 'Run `vinaya task run planner-checks-v1 4` and `vinaya help`.' }),
      REFERENCE
    )
    expect(result).toEqual({ status: 'pass', errors: [] })
  })

  it('refuses a Test plan line invoking a command the reference lacks', () => {
    const result = checkQuotedCommandsExist(
      body({ testPlan: 'bun apps/cli/src/index.ts frobnicate 3 → exits 0' }),
      REFERENCE
    )
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('`vinaya frobnicate`')
    expect(result.errors[0]).toContain('Test plan line')
  })

  it('refuses a Test plan line written with the installed binary, and one behind an env assignment or a pipe', () => {
    expect(checkQuotedCommandsExist(body({ testPlan: 'vinaya frobnicate → exits 0' }), REFERENCE).status).toBe('fail')
    expect(
      checkQuotedCommandsExist(body({ testPlan: 'CI=1 bun apps/cli/src/index.ts frobnicate | head' }), REFERENCE).status
    ).toBe('fail')
    expect(
      checkQuotedCommandsExist(body({ testPlan: 'bun apps/cli/src/index.ts task run x 1 → exits 0' }), REFERENCE).status
    ).toBe('pass')
  })

  it('names the separate program when the quoted words are the words it stands for', () => {
    const result = checkQuotedCommandsExist(body({ trap: 'Run `vinaya check --all` before pushing.' }), REFERENCE)
    expect(result.status).toBe('fail')
    expect(result.errors[0]).toContain('`vinaya check`')
    expect(result.errors[0]).toContain('`vinaya-check`')
    const log = checkQuotedCommandsExist(body({ testPlan: 'bun apps/cli/src/index.ts log emit x → ok' }), REFERENCE)
    expect(log.errors[0]).toContain('`vinaya-log-emit`')
  })

  it('does not judge a separate program written with its hyphenated name', () => {
    const result = checkQuotedCommandsExist(body({ trap: 'Run `vinaya-check --all` before pushing.' }), REFERENCE)
    expect(result.status).toBe('pass')
  })

  it('accepts a command the Objectives introduce where the Traps quote it', () => {
    const result = checkQuotedCommandsExist(
      body({ objective: '`vinaya frobnicate` exists.', trap: 'Run `vinaya frobnicate` to see it.' }),
      REFERENCE
    )
    expect(result).toEqual({ status: 'pass', errors: [] })
  })

  it('accepts a command a Part introduces where the Test plan runs it', () => {
    const result = checkQuotedCommandsExist(
      body({
        part: 'Part 1 (O1) — add `vinaya frobnicate`.',
        testPlan: 'bun apps/cli/src/index.ts frobnicate → exits 0'
      }),
      REFERENCE
    )
    expect(result).toEqual({ status: 'pass', errors: [] })
  })

  it('does not judge the Objectives and Parts themselves, which the introduction rule owns', () => {
    const result = checkQuotedCommandsExist(body({ objective: '`vinaya frobnicate` exists.' }), REFERENCE)
    expect(result.status).toBe('pass')
  })

  it('accepts a capitalised name after the binary, which is a proper name', () => {
    const result = checkQuotedCommandsExist(body({ trap: 'The `Vinaya Body Checks` workflow runs.' }), REFERENCE)
    expect(result).toEqual({ status: 'pass', errors: [] })
  })

  it('is not dormant when the repository ships no command reference file', () => {
    const result = checkQuotedCommandsExist(body({ trap: 'Run `vinaya frobnicate`.' }), { ...REFERENCE, file: null })
    expect(result.status).toBe('fail')
  })

  it('reports one command once, however often it is quoted', () => {
    const result = checkQuotedCommandsExist(
      body({ trap: 'Run `vinaya frobnicate` and again `vinaya frobnicate --now`.' }),
      REFERENCE
    )
    expect(result.errors.length).toBe(1)
  })

  it('leaves a premise quoting code text alone', () => {
    const premise = '\n## Premises\n\n- `a/b.ts` contains `vinaya frobnicate`\n'
    expect(checkQuotedCommandsExist(`${body()}${premise}`, REFERENCE).status).toBe('pass')
  })
})
