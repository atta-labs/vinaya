import { describe, expect, it } from 'vitest'
import {
  blockingVerdict,
  cleanVerdict,
  escalateVerdict,
  fakeGate,
  fakeStats,
  fakeVerdicts,
  notMetVerdict,
  runScenario
} from './fakes'
import { normalizeFailureSignature } from './assess-round'
import { initialLoopState, SEVERITY_COLUMNS } from './types'
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

describe('assessRound — gate_result_read confidence fields (O1, O2)', () => {
  it('a first stated confidence on round two carries value/reason and extra_turn_spent: false', () => {
    const { events } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 90, reason: 'fixed the reported issue' } })
    ])
    const gate = events.find((e) => e.event === 'gate_result_read' && 'round' in e && e.round === 2)
    expect(gate).toMatchObject({
      confidence_value: 90,
      confidence_reason: 'fixed the reported issue',
      extra_turn_spent: false
    })
  })

  it('an absent statement is recorded confidence_unavailable: true, never a fabricated value', () => {
    const { events } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: 'absent' })
    ])
    const gate = events.find((e) => e.event === 'gate_result_read' && 'round' in e && e.round === 2)
    expect(gate).toMatchObject({ confidence_unavailable: true, extra_turn_spent: false })
    expect(gate).not.toHaveProperty('confidence_value')
  })

  it('a statement made after the extra turn reads extra_turn_spent: true, telling it apart from the first statement', () => {
    const { events } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 45, reason: 'still checking' } }), // extra turn granted
      fakeGate(2, true, { confidence: { value: 85, reason: 'confirmed the fix' } }) // extra turn consumed
    ])
    const gateReads = events.filter((e) => e.event === 'gate_result_read' && 'round' in e && e.round === 2)
    expect(gateReads).toHaveLength(2)
    expect(gateReads[0]).toMatchObject({ confidence_value: 45, extra_turn_spent: false })
    expect(gateReads[1]).toMatchObject({ confidence_value: 85, extra_turn_spent: true })
  })

  it('round one never carries the confidence fields on gate_result_read', () => {
    const { events } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])
    const gate = events.find((e) => e.event === 'gate_result_read')
    expect(gate).not.toHaveProperty('confidence_value')
    expect(gate).not.toHaveProperty('confidence_unavailable')
    expect(gate).not.toHaveProperty('extra_turn_spent')
  })

  it('a red gate on round two never carries the confidence fields', () => {
    const { events } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, false)
    ])
    const gate = events.find((e) => e.event === 'gate_result_read' && 'round' in e && e.round === 2)
    expect(gate).not.toHaveProperty('confidence_value')
    expect(gate).not.toHaveProperty('confidence_unavailable')
    expect(gate).not.toHaveProperty('extra_turn_spent')
  })

  it('a re-ask that recovers a real value gets its own event — the round is never stuck on the first read’s confidence_unavailable', () => {
    const { events } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: 'absent' }), // first read: nothing stated, re-ask
      fakeGate(2, true, { confidence: { value: 90, reason: 'fixed it' } }) // re-ask's own real read
    ])
    const gateReads = events.filter((e) => e.event === 'gate_result_read' && 'round' in e && e.round === 2)
    expect(gateReads).toHaveLength(2)
    expect(gateReads[0]).toMatchObject({ confidence_unavailable: true })
    expect(gateReads[1]).toMatchObject({ confidence_value: 90, confidence_reason: 'fixed it' })
    expect(gateReads[1]).not.toHaveProperty('confidence_unavailable')
    // Exactly one `round_started` for round 2 — only the re-ask's own
    // gate_result_read is new, never a second round entry.
    expect(events.filter((e) => e.event === 'round_started' && 'round' in e && e.round === 2)).toHaveLength(1)
  })
})

describe('assessRound — Part 3 (O2): the exits', () => {
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
    // Round 4 stops. The pause names the configured cap.
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

  it('two consecutive rounds resolving no id now continue to a developer dispatch (no_progress stop removed)', () => {
    const { decisions, events } = runScenario(freshState(), [
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

    // The old assessment `no_progress` exit paused here after two rounds that
    // resolved no id — it read a resolved-id signal no reviewer observation
    // ever fills, so it stalled loops that were making real progress and is
    // removed. The same sequence now dispatches the developer for another
    // round, and no `no_progress` stop is ever recorded from the assessment.
    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
    expect(decisions).not.toContainEqual({ type: 'pause', reason: 'no_progress' })
    expect(
      events.some((e) => e.event === 'stop_condition_met' && 'condition' in e && e.condition === 'no_progress')
    ).toBe(false)
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
})

describe('assessRound — a round no reviewer saw records no counts and names why (Issue #824)', () => {
  it('a red gate records an empty count map and `checks_red`, while the round_ended log keeps `changes_requested`', () => {
    const { state, events } = runScenario(freshState(), [fakeGate(1, false)])

    const record = state.rounds.at(-1)
    // Empty, not seeded-at-zero: the renderer's "counts have no source" path
    // shows `—`, never a `0` a reader takes for a reviewed-clean round.
    expect(record?.countsBySeverity).toEqual({})
    expect(record?.notReviewed).toBe('checks_red')
    expect(record?.outcome).toBe('changes_requested')
    // Trap: the log event a reader parses is unchanged by this.
    expect(events.find((e) => e.event === 'round_ended')).toMatchObject({ outcome: 'changes_requested' })
  })

  it('a below-50 confidence that sends the developer back records no counts and names `low_confidence`, carrying the stated figure', () => {
    const { state, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'blocker', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 49 } })
    ])

    // The decision itself is unchanged — the developer is still sent back.
    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer', reason: 'confidence' })
    const record = state.rounds.at(-1)
    expect(record?.round).toBe(2)
    expect(record?.countsBySeverity).toEqual({})
    expect(record?.notReviewed).toBe('low_confidence')
    expect(record?.confidence).toEqual({ value: 49 })
    expect(record?.outcome).toBe('changes_requested')
  })

  it('a round the reviewers assessed and found nothing in records seeded zeros and no not-reviewed reason', () => {
    const { state } = runScenario(freshState(), [
      fakeGate(1, true, { confidence: { value: 80 } }),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])

    const record = state.rounds.at(-1)
    expect(record?.notReviewed).toBeUndefined()
    // Every severity column is present at zero — a measurement, not an absence.
    expect(Object.keys(record?.countsBySeverity ?? {}).sort()).toEqual([...SEVERITY_COLUMNS].sort())
  })
})

describe('assessRound — the same blocking finding twice pauses the loop', () => {
  const blocking = (id: string, state: 'open' | 'fix-claimed' | 'resolved' = 'open') => ({
    id,
    severity: 'blocker',
    state,
    severityScale: 'code-review',
    policyTreatment: 'blocking' as const
  })

  it('a blocking finding open in two consecutive rounds → pause(repeat_finding) naming it, instead of a third developer turn', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [blockingVerdict('reviewer', [blocking('F1')]), cleanVerdict('security')]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [blockingVerdict('reviewer', [blocking('F1')]), cleanVerdict('security')])
    ])

    expect(decisions[1]).toEqual({ type: 'dispatch_developer' })
    expect(decisions.at(-1)).toEqual({
      type: 'pause',
      reason: 'repeat_finding',
      detail: 'open after two consecutive rounds: reviewer:F1'
    })
    const stop = events.find((e) => e.event === 'stop_condition_met' && 'round' in e && e.round === 2)
    expect(stop).toMatchObject({ condition: 'repeat_finding' })
    expect(events.some((e) => e.event === 'journal_finalized' && 'result' in e && e.result === 'stopped')).toBe(true)
  })

  it('the same id from the other role is a different finding: reviewer:F1 then security:F1 continues', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [blockingVerdict('reviewer', [blocking('F1')]), cleanVerdict('security')]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [cleanVerdict('reviewer'), blockingVerdict('security', [blocking('F1')])])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })

  it('a repeated NON-blocking finding never pauses — the developer was never sent back for it', () => {
    const nonBlocking = {
      id: 'F1',
      severity: 'minor',
      state: 'open' as const,
      severityScale: 'code-review',
      policyTreatment: 'non_blocking' as const
    }
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [blockingVerdict('reviewer', [nonBlocking, blocking('F2')]), cleanVerdict('security')]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [blockingVerdict('reviewer', [nonBlocking, blocking('F3')]), cleanVerdict('security')])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })

  it('the removed no_progress rule is not revived: a round resolving nothing but raising only NEW blocking findings continues', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [blockingVerdict('reviewer', [blocking('F1')]), cleanVerdict('security')]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [blockingVerdict('reviewer', [blocking('F2')]), cleanVerdict('security')])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })

  it('a blocking finding the round marks resolved is not open, so it never counts as repeated', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [blockingVerdict('reviewer', [blocking('F1')]), cleanVerdict('security')]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [
        blockingVerdict('reviewer', [blocking('F1', 'resolved'), blocking('F2')]),
        cleanVerdict('security')
      ])
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })

  it('a red gate between two reviewed rounds does not break the chain — consecutive means consecutive REVIEWED rounds', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [blockingVerdict('reviewer', [blocking('F1')]), cleanVerdict('security')]),
      fakeGate(2, false),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [blockingVerdict('reviewer', [blocking('F1')]), cleanVerdict('security')])
    ])

    expect(decisions.at(-1)).toMatchObject({ type: 'pause', reason: 'repeat_finding' })
  })
})

describe('assessRound — the same mechanical failure twice pauses the loop', () => {
  // The live shape of a repeated premise re-check mismatch: the same failure,
  // reported by two different attempts, differing only in what always differs.
  const premiseMismatch = (when: string, tmp: string, pid: number, ms: number) =>
    `2026-09-28T${when}Z premise re-assert failed in /tmp/${tmp} (pid ${pid}, ${ms}ms): absent: maxRounds`

  it('two consecutive red gates with the same failure → pause(repeat_failure) naming the message as reported', () => {
    const { events, decisions } = runScenario(freshState(), [
      fakeGate(1, false, { failure: premiseMismatch('10:00:00', 'aeg-a1b2c3d', 41201, 1200) }),
      fakeGate(1, false, { failure: premiseMismatch('10:07:31', 'aeg-9f8e7d6', 41999, 1873) })
    ])

    // The first red gate is an ordinary send-back; the second is the stop.
    expect(decisions[0]).toEqual({ type: 'dispatch_developer' })
    expect(decisions[1]).toEqual({
      type: 'pause',
      reason: 'repeat_failure',
      detail: premiseMismatch('10:07:31', 'aeg-9f8e7d6', 41999, 1873)
    })
    expect(events.filter((e) => e.event === 'stop_condition_met')).toMatchObject([{ condition: 'repeat_failure' }])
    expect(events.some((e) => e.event === 'journal_finalized' && 'result' in e && e.result === 'stopped')).toBe(true)
  })

  it('a near miss is not a repeat: two different premise pins keep the loop going', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, false, { failure: premiseMismatch('10:00:00', 'aeg-a1b2c3d', 41201, 1200) }),
      fakeGate(1, false, {
        failure: premiseMismatch('10:07:31', 'aeg-9f8e7d6', 41999, 1873).replace('maxRounds', 'reviewers')
      })
    ])

    expect(decisions).toEqual([{ type: 'dispatch_developer' }, { type: 'dispatch_developer' }])
  })

  it('a red gate whose cause the driver could not name never matches another unnamed one', () => {
    const { decisions } = runScenario(freshState(), [fakeGate(1, false), fakeGate(1, false)])

    expect(decisions).toEqual([{ type: 'dispatch_developer' }, { type: 'dispatch_developer' }])
  })

  it('a green gate in between breaks the chain — the failure stopped repeating', () => {
    const failure = 'pre-push test run failed: apps/cli/tests/loop.test.ts'
    const { decisions, state } = runScenario(freshState(), [
      fakeGate(1, false, { failure }),
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, false, { confidence: { value: 80 }, failure })
    ])

    expect(state.lastFailure).toEqual({
      signature: normalizeFailureSignature(failure),
      message: failure
    })
    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })

  it('the round a repeat stops records no counts and names why, like every other round no reviewer saw', () => {
    const failure = 'push refused by the pre-push hook: 1 test failed'
    const { state } = runScenario(freshState(), [fakeGate(1, false, { failure }), fakeGate(1, false, { failure })])

    const record = state.rounds.at(-1)
    expect(record?.countsBySeverity).toEqual({})
    expect(record?.notReviewed).toBe('checks_red')
    expect(record?.outcome).toBe('stopped')
  })
})

describe('normalizeFailureSignature — what varies is ignored, what distinguishes is kept', () => {
  it('two runs of the same failure share a signature across timestamps, temp paths, process ids and durations', () => {
    const a = normalizeFailureSignature(
      '2026-09-28T10:00:00.123Z forge read failed in /var/folders/rp/T/aeg-1a2b3c4 (pid 41201) after 1200ms at 4f0807fab8bb7a4c'
    )
    const b = normalizeFailureSignature(
      '2026-09-29T02:41:07Z forge read failed in /private/tmp/aeg-99ff00e (pid=8) after 3.4s at 1f4ed5c7aa19'
    )
    expect(a).toBe(b)
    // Volatile tokens are replaced, never deleted — the sentence still reads.
    expect(a).toBe('<ts> forge read failed in <tmp> (pid <pid>) after <dur> at <sha>')
  })

  it('two different failures never collapse into one signature', () => {
    expect(normalizeFailureSignature('absent: maxRounds')).not.toBe(normalizeFailureSignature('absent: reviewers'))
    expect(normalizeFailureSignature('check typecheck failed')).not.toBe(
      normalizeFailureSignature('check biome failed')
    )
  })

  it('is total: an empty or whitespace-only message normalises to the empty signature', () => {
    expect(normalizeFailureSignature('')).toBe('')
    expect(normalizeFailureSignature('   \n\t ')).toBe('')
  })
})

describe('assessRound — an attempt that never produced a head reaches the same repeat stop', () => {
  const pushNeverLanded = (head: string, dirty: string) =>
    `push never landed on task/x/1: head ${head} unchanged; dirty file(s): ${dirty}`

  function mechanical(round: number, failure: string) {
    return { kind: 'mechanical_failure' as const, round, failure, stats: fakeStats(round) }
  }

  it('the same failure on two consecutive headless attempts → pause(repeat_failure) naming it', () => {
    const { events, decisions, state } = runScenario(freshState(), [
      mechanical(1, pushNeverLanded('a'.repeat(40), 'smoke.ts')),
      mechanical(1, pushNeverLanded('a'.repeat(40), 'smoke.ts'))
    ])

    expect(decisions[0]).toEqual({ type: 'dispatch_developer' })
    expect(decisions[1]).toEqual({
      type: 'pause',
      reason: 'repeat_failure',
      detail: pushNeverLanded('a'.repeat(40), 'smoke.ts')
    })
    expect(events.filter((e) => e.event === 'stop_condition_met')).toMatchObject([{ condition: 'repeat_failure' }])
    // The round it stops on saw no gate and no reviewer, and says so.
    expect(state.rounds.at(-1)?.notReviewed).toBe('mechanical_failure')
    expect(state.rounds.at(-1)?.countsBySeverity).toEqual({})
  })

  it('a first occurrence records the signature and nothing else — no round record, no events', () => {
    const { events, state } = runScenario(freshState(), [mechanical(1, pushNeverLanded('b'.repeat(40), 'smoke.ts'))])

    expect(events).toEqual([])
    expect(state.rounds).toEqual([])
    expect(state.lastFailure?.message).toBe(pushNeverLanded('b'.repeat(40), 'smoke.ts'))
  })

  it('a headless attempt that failed DIFFERENTLY is not a repeat — the driver keeps its own first-occurrence bound', () => {
    const { decisions } = runScenario(freshState(), [
      mechanical(1, pushNeverLanded('c'.repeat(40), 'smoke.ts')),
      mechanical(1, pushNeverLanded('c'.repeat(40), 'other.ts'))
    ])

    expect(decisions).toEqual([{ type: 'dispatch_developer' }, { type: 'dispatch_developer' }])
  })

  it('a headless attempt and a red gate carrying the same failure match each other — the chain is one chain', () => {
    const failure = 'failing check-run(s): Vinaya CI'
    const { decisions } = runScenario(freshState(), [mechanical(1, failure), fakeGate(1, false, { failure })])

    expect(decisions.at(-1)).toMatchObject({ type: 'pause', reason: 'repeat_failure', detail: failure })
  })

  it('a green gate between two identical headless attempts breaks the chain', () => {
    const failure = pushNeverLanded('d'.repeat(40), 'smoke.ts')
    const { decisions } = runScenario(freshState(), [
      mechanical(1, failure),
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ]),
      mechanical(2, failure)
    ])

    expect(decisions.at(-1)).toEqual({ type: 'dispatch_developer' })
  })
})

describe('assessRound — buildRoundRecord collects deferred findings (O4)', () => {
  it("carries each verdict's deferred findings, with severity/location/reason, onto the round record", () => {
    const reviewer: import('./types').VerdictObservation = {
      role: 'reviewer',
      verdict: 'APPROVE',
      objectives: [],
      findings: [
        {
          id: 'F1',
          severity: 'MAJOR',
          location: 'packages/aeg-core/src/x.ts:42',
          state: null,
          policyTreatment: 'non_blocking',
          deferred: 'unchanged-line'
        }
      ]
    }
    const security: import('./types').VerdictObservation = {
      role: 'security',
      verdict: 'PASS',
      objectives: [],
      findings: []
    }
    const { state, decisions } = runScenario(freshState(), [fakeGate(1, true), fakeVerdicts(1, [reviewer, security])])
    expect(decisions[decisions.length - 1]).toEqual({ type: 'publish' })
    expect(state.rounds[0]?.deferred).toEqual([
      { severity: 'MAJOR', location: 'packages/aeg-core/src/x.ts:42', reason: 'unchanged-line' }
    ])
  })

  it('a round that deferred nothing carries no deferred list', () => {
    const { state } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])
    expect(state.rounds[0]?.deferred).toBeUndefined()
  })
})
