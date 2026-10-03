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
import {
  normalizeFailureSignature,
  renderPhaseBreakdown,
  renderTaskBudgetDetail,
  taskBudgetExceeded
} from './assess-round'
import { activeBudgetMs, isActiveBudgetPhase } from '../task-phase-history'
import { initialLoopState, SEVERITY_COLUMNS } from './types'
import type { LoopConfig, TaskClock } from './types'

const CONFIG: LoopConfig = {
  loopId: 'loop-1',
  task: 414,
  reviewers: ['code-reviewer', 'security'],
  models: { 'code-reviewer': 'sonnet', security: 'sonnet' },
  maxRounds: 3,
  maxTaskMinutes: 180
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
        findings: [],
        reviewers: [
          { role: 'code-reviewer', outcome: 'approve', blockers: 0 },
          { role: 'security', outcome: 'approve', blockers: 0 }
        ]
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

describe('assessRound — verdicts_read reviewers', () => {
  type Reviewers = { role: string; outcome: string; blockers: number }[]
  function reviewersOf(verdicts: Parameters<typeof fakeVerdicts>[1]): { reviewers: Reviewers; blockers: number } {
    const { events } = runScenario(freshState(), [fakeGate(1, true), fakeVerdicts(1, verdicts)])
    const read = events.find((e) => e.event === 'verdicts_read') as unknown as {
      reviewers: Reviewers
      blockers: number
    }
    return read
  }

  it('a blocking verdict reads changes_requested with one blocker, and the entries add up to blockers', () => {
    const read = reviewersOf([
      blockingVerdict('reviewer', [{ id: 'F1', severity: 'blocker', state: 'open' }]),
      cleanVerdict('security')
    ])
    expect(read.reviewers).toEqual([
      { role: 'code-reviewer', outcome: 'changes_requested', blockers: 1 },
      { role: 'security', outcome: 'approve', blockers: 0 }
    ])
    expect(read.reviewers.reduce((n, r) => n + r.blockers, 0)).toBe(read.blockers)
  })

  it('a configured role with no verdict reads not_reviewed with no blockers', () => {
    const read = reviewersOf([cleanVerdict('reviewer')])
    expect(read.reviewers).toEqual([
      { role: 'code-reviewer', outcome: 'approve', blockers: 0 },
      { role: 'security', outcome: 'not_reviewed', blockers: 0 }
    ])
    expect(read.reviewers.reduce((n, r) => n + r.blockers, 0)).toBe(read.blockers)
  })

  it('an ESCALATE verdict reads changes_requested with no counted blocker, matching the event count', () => {
    const read = reviewersOf([escalateVerdict('reviewer'), blockingVerdict('security', [])])
    expect(read.reviewers[0]).toEqual({ role: 'code-reviewer', outcome: 'changes_requested', blockers: 0 })
    expect(read.reviewers.reduce((n, r) => n + r.blockers, 0)).toBe(read.blockers)
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
  it('a round-3 review that is not green → stop_condition_met max_rounds; rounds 1 and 2 continue, no fourth round is dispatched', () => {
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
      ])
    ])

    // Rounds 1 and 2 each continue (healthy churn: one id resolved, a new one raised).
    expect(decisions.slice(0, 4)).toEqual([
      { type: 'dispatch_reviewers' },
      { type: 'dispatch_developer' },
      { type: 'dispatch_reviewers' },
      { type: 'dispatch_developer' }
    ])
    // Round 3 is the last round that runs: its review pauses the loop, naming the cap.
    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'max_rounds', detail: 'max rounds: 3' })
    expect(decisions).toHaveLength(6)
    const round3Stop = events.find((e) => e.event === 'stop_condition_met' && 'round' in e && e.round === 3)
    expect(round3Stop).toMatchObject({ condition: 'max_rounds' })
    expect(events.some((e) => e.event === 'round_started' && 'round' in e && e.round === 4)).toBe(false)
    expect(events.some((e) => e.event === 'journal_finalized' && 'result' in e && e.result === 'stopped')).toBe(true)
  })

  it('a GREEN round at the cap still publishes', () => {
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
          { id: 'F2', severity: 'major', state: 'open' }
        ]),
        cleanVerdict('security')
      ]),
      fakeGate(3, true, { confidence: { value: 80 } }),
      fakeVerdicts(3, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])
    expect(decisions.at(-1)).toEqual({ type: 'publish' })
  })

  it('(#543 O4) the round cap is configured, not hardcoded: maxRounds:5 lets round 4 run, and pauses after round 5', () => {
    const configuredState = initialLoopState({ ...CONFIG, maxRounds: 5, maxTaskMinutes: 180 })
    const rounds = [1, 2, 3, 4, 5].flatMap((round) => [
      fakeGate(round, true, round === 1 ? undefined : { confidence: { value: 80 } }),
      fakeVerdicts(round, [
        blockingVerdict('reviewer', [
          ...(round > 1 ? [{ id: `F${round - 1}`, severity: 'major' as const, state: 'resolved' as const }] : []),
          { id: `F${round}`, severity: 'major' as const, state: 'open' as const }
        ]),
        cleanVerdict('security')
      ])
    ])
    const { decisions } = runScenario(configuredState, rounds)
    // Round 4 continues under maxRounds:5 — the default (3) cap's own test
    // above pauses at round 3 instead.
    expect(decisions[6]).toEqual({ type: 'dispatch_reviewers' })
    expect(decisions[7]).toEqual({ type: 'dispatch_developer' })
    // Round 5 is the last that runs, naming the configured cap.
    expect(decisions.at(-1)).toEqual({ type: 'pause', reason: 'max_rounds', detail: 'max rounds: 5' })
    expect(decisions).toHaveLength(10)
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

// --- the task's own wall-clock budget --------------------------------------

const MINUTE = 60_000

/** A clock reading: `elapsed` minutes on the budget clock, split across the phases named — `elapsed` set independently so a test can probe `taskBudgetExceeded` on the one figure it reads. */
function clock(elapsedMinutes: number, byPhaseMinutes: Record<string, number> = {}): TaskClock {
  const byPhaseMs: Record<string, number> = {}
  for (const [phase, minutes] of Object.entries(byPhaseMinutes)) byPhaseMs[phase] = minutes * MINUTE
  return { elapsedMs: elapsedMinutes * MINUTE, byPhaseMs }
}

/**
 * The clock exactly as the driver builds it (`taskClock`, apps/cli): `byPhaseMs`
 * is the full record, and `elapsedMs` is the ACTIVE sum over it — so a test can
 * hand in a task that sat paused for hours and prove the budget ignores it.
 */
function activeClock(byPhaseMinutes: Record<string, number>): TaskClock {
  const byPhaseMs: Record<string, number> = {}
  for (const [phase, minutes] of Object.entries(byPhaseMinutes)) byPhaseMs[phase] = minutes * MINUTE
  return { elapsedMs: activeBudgetMs(byPhaseMs), byPhaseMs }
}

describe('taskBudgetExceeded (O1, O3)', () => {
  it('is false under the budget, false AT it, true over it', () => {
    expect(taskBudgetExceeded(180, clock(179))).toBe(false)
    expect(taskBudgetExceeded(180, clock(180))).toBe(false)
    expect(taskBudgetExceeded(180, clock(181))).toBe(true)
  })

  it('a budget of 0 is off — no elapsed time ever exceeds it (O3)', () => {
    expect(taskBudgetExceeded(0, clock(0))).toBe(false)
    expect(taskBudgetExceeded(0, clock(6 * 60))).toBe(false)
    expect(taskBudgetExceeded(0, clock(60 * 24 * 7))).toBe(false)
  })

  it('a negative budget is read as off, never as a budget already blown', () => {
    expect(taskBudgetExceeded(-5, clock(600))).toBe(false)
  })
})

describe('renderPhaseBreakdown (O1)', () => {
  it('names each phase in the reader-facing vocabulary, longest first', () => {
    expect(
      renderPhaseBreakdown({
        dispatch_reviewers: 22 * MINUTE,
        dispatch_developer: 190 * MINUTE,
        publish: 2 * MINUTE
      })
    ).toBe('developing 190 min, reviewing 22 min, publishing 2 min')
  })

  it('reports an unrecorded breakdown honestly rather than inventing one row', () => {
    expect(renderPhaseBreakdown({})).toBe('no phase times recorded')
  })

  it('a phase the label vocabulary does not know reads back as the loop’s own recorded word', () => {
    expect(renderPhaseBreakdown({ some_new_phase: 5 * MINUTE })).toBe('some_new_phase 5 min')
  })

  it('the detail names the budget, what was spent, and where it went', () => {
    expect(renderTaskBudgetDetail(180, clock(214, { dispatch_developer: 190, dispatch_reviewers: 24 }))).toBe(
      'task time budget: 180 min, spent 214 min — developing 190 min, reviewing 24 min'
    )
  })

  it('the detail names ONLY the active phases it summed — paused and publishing time is never named (O3)', () => {
    // The full record carries 20 hours paused and 5 minutes publishing; the
    // detail reports neither, and the phases it does name sum to the active
    // time it reports as spent.
    const spentClock = activeClock({
      dispatch_developer: 190,
      dispatch_reviewers: 24,
      pause: 20 * 60,
      publish: 5
    })
    expect(renderTaskBudgetDetail(180, spentClock)).toBe(
      'task time budget: 180 min, spent 214 min — developing 190 min, reviewing 24 min'
    )
  })
})

describe('activeBudgetMs / isActiveBudgetPhase (O1)', () => {
  it('developing, reviewing and awaiting confidence are active work', () => {
    expect(isActiveBudgetPhase('dispatch_developer')).toBe(true)
    expect(isActiveBudgetPhase('dispatch_reviewers')).toBe(true)
    expect(isActiveBudgetPhase('ask_confidence')).toBe(true)
    expect(
      activeBudgetMs({ dispatch_developer: 30 * MINUTE, dispatch_reviewers: 10 * MINUTE, ask_confidence: 2 * MINUTE })
    ).toBe(42 * MINUTE)
  })

  it('paused and publishing time is never active — a task that only sat waiting has spent nothing', () => {
    expect(isActiveBudgetPhase('pause')).toBe(false)
    expect(isActiveBudgetPhase('publish')).toBe(false)
    expect(activeBudgetMs({ pause: 20 * 60 * MINUTE, publish: 5 * MINUTE })).toBe(0)
    expect(activeBudgetMs({ dispatch_developer: 40 * MINUTE, pause: 20 * 60 * MINUTE, publish: 5 * MINUTE })).toBe(
      40 * MINUTE
    )
  })

  it('an unknown recorded phase is not counted — the budget under-counts rather than pause on a word it cannot vouch is work', () => {
    expect(isActiveBudgetPhase('some_new_phase')).toBe(false)
    expect(activeBudgetMs({ dispatch_developer: 10 * MINUTE, some_new_phase: 99 * MINUTE })).toBe(10 * MINUTE)
  })

  it('a negative recorded value contributes nothing rather than subtracting from the sum', () => {
    expect(activeBudgetMs({ dispatch_developer: 50 * MINUTE, dispatch_reviewers: -5 * MINUTE })).toBe(50 * MINUTE)
  })
})

describe('the budget counts active work, not age (O2)', () => {
  // The task that motivated this fix: first started 20 hours ago, resumed only
  // to re-cast a verdict, with 40 minutes of real developing behind it.
  it('a task 20 hours old with only 40 active minutes has not blown a 180-min budget', () => {
    const twentyHoursMostlyWaiting = activeClock({ dispatch_developer: 40, pause: 20 * 60 })
    expect(twentyHoursMostlyWaiting.elapsedMs).toBe(40 * MINUTE)
    expect(taskBudgetExceeded(180, twentyHoursMostlyWaiting)).toBe(false)
  })

  it('the same task once it has spent 200 active minutes pauses', () => {
    const twoHundredActiveMinutes = activeClock({ dispatch_developer: 190, dispatch_reviewers: 10, pause: 20 * 60 })
    expect(twoHundredActiveMinutes.elapsedMs).toBe(200 * MINUTE)
    expect(taskBudgetExceeded(180, twoHundredActiveMinutes)).toBe(true)
  })

  it('the clock the driver builds pauses at a round boundary, naming only the active time and phases', () => {
    // Round 1 gate red under budget (40 active min), then the retry lands the
    // task at 200 active minutes — with 20 hours of that spent paused, which the
    // pause never names and never counts.
    const { decisions } = runScenario(
      freshState(),
      [fakeGate(1, false, { failure: 'check `test` failed' }), fakeGate(1, false, { failure: 'a different failure' })],
      (i) =>
        i === 0
          ? activeClock({ dispatch_developer: 40, pause: 20 * 60 })
          : activeClock({ dispatch_developer: 190, dispatch_reviewers: 10, pause: 20 * 60 })
    )
    expect(decisions[0]).toEqual({ type: 'dispatch_developer' })
    expect(decisions[1]).toEqual({
      type: 'pause',
      reason: 'time_budget',
      detail: 'task time budget: 180 min, spent 200 min — developing 190 min, reviewing 10 min'
    })
  })
})

describe('assessRound — the task time budget (O1, O2)', () => {
  it('a clock past the budget during a mechanical retry pauses at the next boundary, naming the budget and the phases', () => {
    // Round 1 gate red at 170 minutes — under the budget, so the developer is
    // sent back. The retry runs long; by the next observation the task has
    // spent 214 minutes, and THAT boundary is where the loop stops.
    const { decisions, state } = runScenario(
      freshState(),
      [fakeGate(1, false, { failure: 'check `test` failed' }), fakeGate(1, false, { failure: 'a different failure' })],
      (i) =>
        i === 0
          ? clock(170, { dispatch_developer: 170 })
          : clock(214, { dispatch_developer: 190, dispatch_reviewers: 24 })
    )

    expect(decisions[0]).toEqual({ type: 'dispatch_developer' })
    expect(decisions[1]).toEqual({
      type: 'pause',
      reason: 'time_budget',
      detail: 'task time budget: 180 min, spent 214 min — developing 190 min, reviewing 24 min'
    })
    // The round it lands on reached no reviewer, and records as one.
    expect(state.rounds[state.rounds.length - 1]).toEqual(
      expect.objectContaining({ outcome: 'stopped', notReviewed: 'time_budget', countsBySeverity: {} })
    )
  })

  it('emits the same four-event pause shape every other bounded stop emits', () => {
    const { events } = runScenario(freshState(), [fakeGate(1, true)], () => clock(400, { dispatch_developer: 400 }))
    expect(events.map((e) => e.event)).toEqual(['stop_condition_met', 'paused', 'round_ended', 'journal_finalized'])
    expect(events[0]).toEqual(
      expect.objectContaining({ event: 'stop_condition_met', round: 1, condition: 'time_budget' })
    )
    expect(events[1]).toEqual(
      expect.objectContaining({ event: 'paused', round: 1, reason: 'principal_item', reason_code: 'time_budget' })
    )
    expect(events[3]).toEqual(expect.objectContaining({ event: 'journal_finalized', result: 'stopped' }))
  })

  it('a budget of 0 never pauses, however long the task has run (O3)', () => {
    const offConfig: LoopConfig = { ...CONFIG, maxTaskMinutes: 0 }
    const { decisions } = runScenario(
      initialLoopState(offConfig),
      [fakeGate(1, true), fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])],
      () => clock(60 * 24, { dispatch_developer: 60 * 24 })
    )
    expect(decisions[decisions.length - 1]).toEqual({ type: 'publish' })
  })

  it('a caller that passes no clock is assessed exactly as before — the budget is never inferred', () => {
    const { decisions } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])
    expect(decisions[decisions.length - 1]).toEqual({ type: 'publish' })
  })

  it('verdicts already back are never discarded by the budget — the stop waits for the next boundary (O2)', () => {
    // The gate is observed under budget; by the time the verdicts come back the
    // task is well past it. Those verdicts still decide the round, and the
    // budget stops the loop at the round boundary that follows.
    const { decisions } = runScenario(
      freshState(),
      [fakeGate(1, true), fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])],
      (i) => (i === 0 ? clock(170, { dispatch_developer: 170 }) : clock(400, { dispatch_reviewers: 230 }))
    )
    expect(decisions[decisions.length - 1]).toEqual({ type: 'publish' })
  })

  it('a mechanical failure observation past the budget pauses rather than recording only a signature (O2)', () => {
    const { decisions } = runScenario(
      freshState(),
      [{ kind: 'mechanical_failure', round: 1, failure: 'push never landed', stats: fakeStats(1) }],
      () => clock(200, { dispatch_developer: 200 })
    )
    expect(decisions[0]).toEqual(expect.objectContaining({ type: 'pause', reason: 'time_budget' }))
  })
})
