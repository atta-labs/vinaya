import { describe, expect, it } from 'vitest'
import { buildExecution } from './fixtures'
import { NARRATION_KINDS, narrate } from './narration'
import * as log from './index'

type Parsed = Record<string, any>

function records(name: Parameters<typeof buildExecution>[0]): Parsed[] {
  return buildExecution(name).lines.map((line) => JSON.parse(line.raw))
}

/** Each record of an execution narrated with the records before it, as a screen reading the Log in order would. */
function narrated(name: Parameters<typeof buildExecution>[0]) {
  const all = records(name)
  return all.map((record, index) => narrate(record, all.slice(0, index)))
}

const loop = { kind: 'dev_review_loop', loop_id: 'loop-x' }

describe('narrate — fixture executions, expected lines written by hand', () => {
  it('the three-round execution reads round by round', () => {
    expect(narrated('three-rounds-recurring-finding').filter((line) => line !== null)).toEqual([
      { kind: 'starting', text: 'Round 1 started.' },
      { kind: 'working', text: 'The developer is working on round 1.' },
      { kind: 'done', text: 'The developer finished its turn.' },
      { kind: 'done', text: 'Round 1: the checks passed.' },
      { kind: 'working', text: 'The code reviewer is reviewing round 1.' },
      { kind: 'done', text: 'The code reviewer finished its turn.' },
      { kind: 'information', text: 'Round 1 verdicts: 1 blocking.' },
      { kind: 'information', text: 'Round 1 ended after 8m 44s: changes requested. Confidence: —.' },
      { kind: 'starting', text: 'Round 2 started.' },
      { kind: 'working', text: 'The developer is working on round 2.' },
      { kind: 'done', text: 'The developer finished its turn.' },
      { kind: 'done', text: 'Round 2: the checks passed.' },
      { kind: 'working', text: 'The code reviewer is reviewing round 2.' },
      { kind: 'done', text: 'The code reviewer finished its turn.' },
      { kind: 'information', text: 'Round 2 verdicts: 1 blocking.' },
      { kind: 'information', text: 'Round 2 ended after 2m 44s: changes requested. Confidence: 70.' },
      { kind: 'starting', text: 'Round 3 started.' },
      { kind: 'working', text: 'The developer is working on round 3.' },
      { kind: 'done', text: 'The developer finished its turn.' },
      { kind: 'done', text: 'Round 3: the checks passed.' },
      { kind: 'working', text: 'The code reviewer is reviewing round 3.' },
      { kind: 'done', text: 'The code reviewer finished its turn.' },
      { kind: 'done', text: 'Round 3 verdicts: The code reviewer approved; The security approved.' },
      { kind: 'done', text: 'Round 3 ended after 7m 43s: approved. Confidence: 92 (after the extra turn).' },
      { kind: 'done', text: 'The loop stopped: every check and review passed.' }
    ])
  })

  it('the paused execution says a person has to act, and the resume has no wording', () => {
    const lines = narrated('paused-and-resumed')
    const events = records('paused-and-resumed').map((r) => r.event)
    expect(lines[events.indexOf('paused')]).toEqual({
      kind: 'blocked',
      text: 'The loop paused for a person: an item needs a person to decide.'
    })
    expect(lines[events.indexOf('resumed')]).toBeNull()
  })

  it('the escalated execution says who decides', () => {
    const lines = narrated('escalated-handoff').filter((line) => line !== null)
    expect(lines.slice(-3)).toEqual([
      { kind: 'blocked', text: 'The developer raised an escalation (strategy). A person has to decide.' },
      { kind: 'blocked', text: 'The loop stopped itself: a role escalated a question. A person has to act.' },
      { kind: 'blocked', text: 'Round 1 ended after 8m 48s: a role escalated, a person has to decide.' }
    ])
  })
})

describe('narrate — confidence at a round end', () => {
  const read = (extra: Record<string, unknown>) => ({
    ...loop,
    event: 'gate_result_read',
    round: 2,
    green: true,
    ...extra
  })
  const ended = { ...loop, event: 'round_ended', round: 2, wall_ms: 59_500, outcome: 'green' }

  it('states the value as stated', () => {
    expect(narrate(ended, [read({ confidence_value: 64 })])?.text).toBe(
      'Round 2 ended after 1m 0s: approved. Confidence: 64.'
    )
  })

  it('marks a value stated after the extra turn', () => {
    expect(narrate(ended, [read({ confidence_value: 64, extra_turn_spent: true })])?.text).toContain(
      'Confidence: 64 (after the extra turn).'
    )
  })

  it('shows a dash when none was asked', () => {
    expect(narrate(ended, [read({})])?.text).toContain('Confidence: —.')
  })

  it('says not given when recorded unavailable, and never a number', () => {
    const text = narrate(ended, [read({ confidence_unavailable: true })])?.text
    expect(text).toContain('Confidence: not given.')
    expect(text).not.toMatch(/\d+\.$/)
  })

  it('claims nothing about confidence when the round has no gate read to go by', () => {
    expect(narrate(ended)?.text).toBe('Round 2 ended after 1m 0s: approved.')
    expect(narrate(ended, [{ ...read({ confidence_value: 64 }), round: 1 }])?.text).not.toContain('Confidence')
    expect(narrate(ended, [{ ...read({ confidence_value: 64 }), loop_id: 'other' }])?.text).not.toContain('Confidence')
  })

  it('never states an out-of-range value', () => {
    expect(narrate(ended, [read({ confidence_value: 140 })])?.text).toContain('Confidence: —.')
  })
})

describe('narrate — who acts on a pause or stop', () => {
  const pause = (reason_code?: string, reason = 'principal_item') =>
    narrate({ ...loop, event: 'paused', round: 1, reason, reason_code })

  it('a reason a person must act on says so', () => {
    expect(pause('repeat_failure')).toEqual({
      kind: 'blocked',
      text: 'The loop paused for a person: the same mechanical failure happened twice in a row.'
    })
  })

  it('a reason the loop pauses itself on says the loop did', () => {
    expect(pause('objectives_changed')).toEqual({
      kind: 'paused',
      text: 'The loop paused itself: the objectives changed during the round.'
    })
  })

  it('an unknown code reads as paused with the code and no guess about who acts', () => {
    expect(pause('mystery-reason')).toEqual({ kind: 'paused', text: 'Paused: mystery-reason.' })
    expect(pause('unknown')).toEqual({ kind: 'paused', text: 'Paused: unknown.' })
  })

  it('a code that is not a code is ignored', () => {
    expect(pause('has spaces and /paths', 'refreeze_needed')).toEqual({
      kind: 'paused',
      text: 'Paused: refreeze_needed.'
    })
  })

  it('stop conditions read as who acts', () => {
    const stop = (condition: unknown) => narrate({ ...loop, event: 'stop_condition_met', round: 3, condition })
    expect(stop('time_budget')).toEqual({
      kind: 'blocked',
      text: 'The loop stopped itself: the time budget was passed. A person has to act.'
    })
    expect(stop('green')?.kind).toBe('done')
    expect(stop('from-the-future')).toEqual({ kind: 'paused', text: 'Paused: from-the-future.' })
    expect(stop(7)).toBeNull()
  })
})

describe('narrate — other records', () => {
  it('a verdict names each reviewer, its outcome and its blockers', () => {
    expect(
      narrate({
        ...loop,
        event: 'verdicts_read',
        round: 2,
        all_approve: false,
        blockers: 1,
        reviewers: [
          { role: 'code-reviewer', outcome: 'changes_requested', blockers: 1 },
          { role: 'security', outcome: 'not_reviewed', blockers: 0 }
        ]
      })
    ).toEqual({
      kind: 'information',
      text: 'Round 2 verdicts: The code reviewer asked for changes (1 blocking); The security did not review.'
    })
  })

  it('a failed gate reads as failed', () => {
    expect(narrate({ ...loop, event: 'gate_result_read', round: 4, green: false })).toEqual({
      kind: 'failed',
      text: 'Round 4: the checks failed.'
    })
  })

  it('a driver exit reads by how it ended', () => {
    const exit = (extra: Record<string, unknown>) => narrate({ ...loop, event: 'driver_exited', ...extra })
    expect(exit({ reason: 'finished', exit_code: 0 })).toEqual({
      kind: 'done',
      text: 'The driver finished (exit code 0).'
    })
    expect(exit({ reason: 'paused' })?.kind).toBe('paused')
    expect(exit({ reason: 'reexec' })?.kind).toBe('information')
    expect(exit({ reason: 'error', error_class: 'ENOENT', exit_code: 1 })).toEqual({
      kind: 'failed',
      text: 'The driver stopped on an error (ENOENT) (exit code 1).'
    })
    expect(exit({ reason: 'signal' })?.kind).toBe('failed')
  })

  it('no line carries a symbol other than the dash, a time or a path', () => {
    const lines = [
      ...narrated('three-rounds-recurring-finding'),
      ...narrated('paused-and-resumed'),
      ...narrated('escalated-handoff')
    ].filter((line) => line !== null)
    for (const line of lines) {
      expect(NARRATION_KINDS).toContain(line.kind)
      expect(line.text).not.toMatch(/[✓✗⚠●○▶■]|\d{2}:\d{2}:\d{2}|\//)
      expect(line.text.includes(String.fromCharCode(27))).toBe(false)
    }
  })
})

describe('narrate — records it has no wording for, and malformed ones', () => {
  it('returns nothing for a record kind or event it does not know', () => {
    expect(narrate({ kind: 'telepathy', event: 'sent' })).toBeNull()
    expect(narrate({ ...loop, event: 'a_future_event' })).toBeNull()
    expect(narrate({ ...loop, event: 'resumed', round: 1, by: 'principal' })).toBeNull()
    expect(narrate({ kind: 'dispatch', event: 'dispatch_failed' })).toBeNull()
  })

  it('never throws on a malformed record', () => {
    const hostile: unknown[] = [
      null,
      undefined,
      7,
      'text',
      [],
      {},
      { kind: 'dev_review_loop' },
      { ...loop, event: 'round_ended', round: 'two', wall_ms: 'long', outcome: {} },
      { ...loop, event: 'verdicts_read', reviewers: [null, 4, { role: 9 }], blockers: 'many' },
      {
        ...loop,
        event: 'paused',
        reason_code: {
          toString: () => {
            throw new Error('boom')
          }
        }
      },
      { ...loop, event: 'driver_exited', reason: 'error', error_class: 12, exit_code: 'x' },
      { kind: 'dispatch', event: 'dispatched', target_role: { x: 1 }, round: 'one' },
      { kind: 'dispatch', event: 'outcome_received', outcome: null }
    ]
    for (const record of hostile) {
      expect(() => narrate(record)).not.toThrow()
      expect(() => narrate({ ...loop, event: 'round_ended', round: 1 }, [record, null, 3] as unknown[])).not.toThrow()
    }
    expect(() => narrate({ ...loop, event: 'round_ended', round: 1 }, 'nope' as unknown as unknown[])).not.toThrow()
    expect(narrate(null)).toBeNull()
    expect(narrate({ ...loop, event: 'gate_result_read', round: 1, green: 'yes' })).toBeNull()
  })
})

describe('narrate — exported from the log module', () => {
  it('is the same function a consumer imports from the log index', () => {
    expect(log.narrate).toBe(narrate)
    expect(log.NARRATION_KINDS).toBe(NARRATION_KINDS)
  })
})
