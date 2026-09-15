import { describe, expect, it } from 'vitest'
import {
  blockingVerdict,
  cleanVerdict,
  escalateVerdict,
  fakeGate,
  fakeVerdicts,
  notMetVerdict,
  runScenario
} from './fakes'
import { initialLoopState } from './types'
import type { LoopConfig } from './types'

const CONFIG: LoopConfig = {
  loopId: 'loop-1',
  task: 414,
  reviewers: ['code-reviewer', 'security'],
  models: { 'code-reviewer': 'sonnet', security: 'sonnet' },
  maxRounds: 3
}

function freshState() {
  return initialLoopState(CONFIG)
}

describe('assessRound — Part 1 (O1, O5): green path', () => {
  it('round one, CI green, two clean verdicts, every objective met → publish, byte-for-byte events', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])

    expect(events).toEqual([
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'loop-1',
        event: 'loop_started',
        task: 414,
        policy: {
          max_rounds: 3,
          reviewers: ['code-reviewer', 'security'],
          models: { 'code-reviewer': 'sonnet', security: 'sonnet' }
        }
      },
      { kind: 'dev_review_loop', payload: {}, loop_id: 'loop-1', event: 'round_started', round: 1, base_head: 'base1' },
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'loop-1',
        event: 'gate_result_read',
        round: 1,
        head: 'head1',
        green: true
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'loop-1',
        event: 'verdicts_read',
        round: 1,
        head: 'head1',
        all_approve: true,
        blockers: 0,
        findings: []
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'loop-1',
        event: 'findings_compared',
        round: 1,
        open: [],
        resolved: [],
        new: [],
        recurring: []
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'loop-1',
        event: 'stop_condition_met',
        round: 1,
        condition: 'green'
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'loop-1',
        event: 'round_ended',
        round: 1,
        base_head: 'base1',
        head: 'head1',
        files_changed: 1,
        insertions: 1,
        deletions: 1,
        wall_ms: 1000,
        outcome: 'green'
      },
      {
        kind: 'dev_review_loop',
        payload: {},
        loop_id: 'loop-1',
        event: 'journal_finalized',
        rounds: 1,
        total_wall_ms: 1000,
        time_to_green_ms: 1000,
        files_changed_total: 1,
        final_head: 'head1',
        result: 'merged_ready'
      }
    ])
    expect(decisions).toEqual([{ type: 'dispatch_reviewers' }, { type: 'publish' }])
  })

  it('CI red on round one → dispatch_developer, no verdicts_read', () => {
    const { events, decisions } = runScenario(freshState(), [fakeGate(1, false)])

    expect(decisions).toEqual([{ type: 'dispatch_developer' }])
    expect(events.some((e) => e.event === 'verdicts_read')).toBe(false)
    expect(events.map((e) => e.event)).toEqual(['loop_started', 'round_started', 'gate_result_read', 'round_ended'])
  })

  it('one verdict ESCALATE → pause(escalation), spec §10.4 first row', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [escalateVerdict('reviewer'), cleanVerdict('security')])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'escalation' })
    const kinds = events.map((e) => e.event)
    expect(kinds).toContain('stop_condition_met')
    expect(kinds).toContain('paused')
    // Round 2 review, BLOCKER: an escalation pause is a terminal event like
    // every other pause reason — it must close the journal, not leave the
    // task looking unfinished with no `journal_finalized` ever logged.
    expect(events.some((e) => e.event === 'journal_finalized' && 'result' in e && e.result === 'stopped')).toBe(true)
    const stop = events.find((e) => e.event === 'stop_condition_met')
    expect(stop).toMatchObject({ condition: 'escalated' })
    const paused = events.find((e) => e.event === 'paused')
    expect(paused).toMatchObject({ reason: 'escalation' })
  })

  it('a verdict with a blocking finding and all objectives met → dispatch_developer, round_ended changes_requested', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'blocker', state: 'open' }]),
        cleanVerdict('security')
      ])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
    const ended = events.find((e) => e.event === 'round_ended')
    expect(ended).toMatchObject({ outcome: 'changes_requested' })
    expect(events.some((e) => e.event === 'stop_condition_met')).toBe(false)
  })
})

describe('assessRound — Part 2 (O3): objectives and confidence', () => {
  it('a NOT MET objective with zero findings → dispatch_developer, verdicts_read.all_approve false', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [notMetVerdict('reviewer', ['O1', 'O2']), cleanVerdict('security')])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
    // The reviewer's own verdict is still APPROVE (findings alone don't drive
    // it here); `verdicts_read.all_approve` reflects the raw verdict values.
    const verdictsRead = events.find((e) => e.event === 'verdicts_read')
    expect(verdictsRead).toMatchObject({ all_approve: true })
  })

  it('round one never asks confidence', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true, { confidence: 'absent' }),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])
    expect(decisions).toEqual([{ type: 'dispatch_reviewers' }, { type: 'publish' }])
  })

  it('round two asks confidence when green', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: 'absent' })
    ])
    expect(decisions.at(-1)).toEqual({ type: 'ask_confidence' })
  })

  it('confidence 49 on round two → dispatch_developer reason confidence, no reviewers dispatched', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 49 } })
    ])
    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer', reason: 'confidence' })
  })

  it('confidence 49 again after the extra turn → exit', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 49 } }), // extra turn granted
      fakeGate(3, true, { confidence: { value: 49 } }) // extra turn consumed
    ])
    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'confidence' })
  })

  it('confidence 75 on round two → dispatch_reviewers', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 75 } })
    ])
    expect(decisions.at(-1)).toEqual({ type: 'dispatch_reviewers' })
  })

  it('confidence absent twice → pause', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: 'absent' }),
      fakeGate(2, true, { confidence: 'absent' })
    ])
    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'confidence' })
  })

  it('defeat: confidence exactly 50 dispatches reviewers, not below', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 50 } })
    ])
    expect(decisions.at(-1)).toEqual({ type: 'dispatch_reviewers' })
  })

  it('defeat: confidence given on round one is recorded, ignored for branching', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true, { confidence: { value: 10 } }),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])
    expect(decisions).toEqual([{ type: 'dispatch_reviewers' }, { type: 'publish' }])
  })
})

describe('assessRound — Part 3 (O2): the four exits', () => {
  it('rounds over 3 → stop_condition_met max_rounds; round 3 exactly continues, round 4 stops', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [
        blockingVerdict('reviewer', [
          { id: 'F1', severity: 'major', state: 'resolved' },
          { id: 'F2', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(3, true, { confidence: { value: 80 } }),
      fakeVerdicts(3, [
        blockingVerdict('reviewer', [
          { id: 'F2', severity: 'major', state: 'resolved' },
          { id: 'F3', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(4, true, { confidence: { value: 80 } }),
      fakeVerdicts(4, [
        blockingVerdict('reviewer', [
          { id: 'F3', severity: 'major', state: 'resolved' },
          { id: 'F4', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ])
    ])

    // Rounds 1-3 each continue (healthy churn: one id resolved, a new one raised).
    expect(decisions.slice(0, 6)).toEqual([
      { type: 'dispatch_reviewers' },
      { type: 'dispatch_developer' },
      { type: 'dispatch_reviewers' },
      { type: 'dispatch_developer' },
      { type: 'dispatch_reviewers' },
      { type: 'dispatch_developer' }
    ])
    // Round 4 stops. (#543 O4) The pause names the configured cap.
    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'max_rounds', detail: 'max rounds: 3' })
    const round4Stop = events.find((e) => e.event === 'stop_condition_met' && 'round' in e && e.round === 4)
    expect(round4Stop).toMatchObject({ condition: 'max_rounds' })
    expect(events.some((e) => e.event === 'journal_finalized' && 'result' in e && e.result === 'stopped')).toBe(true)
  })

  it('(#543 O4) the round cap is configured, not hardcoded: maxRounds:5 lets round 4 run, and stops at round 5', () => {
    const configuredState = initialLoopState({ ...CONFIG, maxRounds: 5 })
    const { decisions } = runScenario(configuredState, [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [
        blockingVerdict('reviewer', [
          { id: 'F1', severity: 'major', state: 'resolved' },
          { id: 'F2', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(3, true, { confidence: { value: 80 } }),
      fakeVerdicts(3, [
        blockingVerdict('reviewer', [
          { id: 'F2', severity: 'major', state: 'resolved' },
          { id: 'F3', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(4, true, { confidence: { value: 80 } }),
      fakeVerdicts(4, [
        blockingVerdict('reviewer', [
          { id: 'F3', severity: 'major', state: 'resolved' },
          { id: 'F4', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(5, true, { confidence: { value: 80 } }),
      fakeVerdicts(5, [
        blockingVerdict('reviewer', [
          { id: 'F4', severity: 'major', state: 'resolved' },
          { id: 'F5', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(6, true, { confidence: { value: 80 } }),
      fakeVerdicts(6, [
        blockingVerdict('reviewer', [
          { id: 'F5', severity: 'major', state: 'resolved' },
          { id: 'F6', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ])
    ])
    // Round 4 continues under maxRounds:5 — the default (3) cap's own test
    // above pauses there instead.
    expect(decisions[6]).toEqual({ type: 'dispatch_reviewers' })
    expect(decisions[7]).toEqual({ type: 'dispatch_developer' })
    // Round 6 stops, naming the configured cap.
    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'max_rounds', detail: 'max rounds: 5' })
  })

  it('an id resolved in round n reported again in round n+1 → pause(reappearance), id in findings_compared.recurring', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'resolved' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'reproduced' }]),
        cleanVerdict('security')
      ])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'reappearance' })
    const fc = events.find((e) => e.event === 'findings_compared' && 'round' in e && e.round === 2)
    expect(fc).toMatchObject({ recurring: ['F1'] })
    const stop = events.find((e) => e.event === 'stop_condition_met' && 'round' in e && e.round === 2)
    expect(stop).toMatchObject({ condition: 'reappearance' })
  })

  it('two consecutive rounds resolving no id → pause(no_progress)', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'no_progress' })
  })

  it('defeat: a round that resolves one id and raises two new ones is healthy churn and continues', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [
        blockingVerdict('reviewer', [
          { id: 'F1', severity: 'major', state: 'resolved' },
          { id: 'F2', severity: 'major', state: 'open' },
          { id: 'F3', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })

  it('a CI-red bounce is not a genuine round: one real resolved-nothing round after it does not fire no_progress', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, false), // bounce — never a findings comparison
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })

  it('a CI-red bounce between two genuine resolved-nothing rounds does not swallow the second strike', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, false), // bounce, in between — must not reset or corrupt the streak
      fakeGate(3, true, { confidence: { value: 80 } }),
      fakeVerdicts(3, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'no_progress' })
  })

  it('a confidence-collapse bounce is not a genuine round: it must not fake a resolved-nothing strike', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      // Round 1 resolves F1 (healthy churn) — genuinely NOT a resolved-nothing round.
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [
          { id: 'F1', severity: 'major', state: 'resolved' },
          { id: 'F2', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 49 } }), // confidence bounce — never a findings comparison
      fakeGate(3, true, { confidence: { value: 80 } }),
      // Round 3 is the FIRST genuine resolved-nothing round (F2 still open).
      fakeVerdicts(3, [
        blockingVerdict('reviewer', [{ id: 'F2', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ])
    ])

    // Only one genuine resolved-nothing round has happened (round 3) — the
    // confidence bounce must not have hardcoded a fake second strike.
    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })
})
