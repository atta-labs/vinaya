import { describe, expect, it } from 'vitest'
import {
  extractLoopEventsFromCommentBody,
  nextRoundNumber,
  parseLoopEventLines,
  reconstructRounds
} from './journal-reconstruction'
import type { DevReviewLoopEvent } from '../log'

const meta = {
  schema: 1 as const,
  ts: '2026-09-05T00:00:00.000Z',
  run_id: 'run-1',
  seq: 0,
  repo: 'atta-labs/vinaya',
  vinaya: '0.24.1',
  doctrine: 'aeg-root@abc123',
  host: 'cli' as const,
  machine: 'deadbeef'
}
const subject = { issue: 412, role: 'unattributed' as const }

function ts(offsetSeconds: number): string {
  return new Date(Date.parse(meta.ts) + offsetSeconds * 1000).toISOString()
}

function loopEvent(fields: Record<string, unknown>, seq: number, offsetSeconds: number): DevReviewLoopEvent {
  return {
    meta: { ...meta, ts: ts(offsetSeconds), seq },
    subject,
    kind: 'dev_review_loop',
    loop_id: 'loop-1',
    payload: {},
    ...fields
  } as DevReviewLoopEvent
}

function roundEnded(
  round: number,
  seq: number,
  offsetSeconds: number,
  outcome: 'green' | 'changes_requested' | 'escalated',
  overrides: Record<string, unknown> = {}
) {
  return loopEvent(
    {
      event: 'round_ended',
      round,
      base_head: `base-${round}`,
      head: `head-${round}`,
      files_changed: 3,
      insertions: 10,
      deletions: 2,
      wall_ms: 1000,
      outcome,
      ...overrides
    },
    seq,
    offsetSeconds
  )
}

function verdictsRead(round: number, seq: number, offsetSeconds: number, blockers: number) {
  return loopEvent(
    { event: 'verdicts_read', round, head: `head-${round}`, all_approve: blockers === 0, blockers },
    seq,
    offsetSeconds
  )
}

function stopConditionMet(round: number, seq: number, offsetSeconds: number, condition: string) {
  return loopEvent({ event: 'stop_condition_met', round, condition }, seq, offsetSeconds)
}

describe('reconstructRounds', () => {
  it('returns an empty journal for no events', () => {
    expect(reconstructRounds([])).toEqual({ rounds: [], totalWallMs: 0, totalFilesChanged: 0 })
  })

  it("rebuilds one RoundRecord per round_ended event, with the round's blockers count as the only populated severity column", () => {
    const events = [verdictsRead(1, 0, 0, 2), roundEnded(1, 1, 1, 'changes_requested')]
    const { rounds } = reconstructRounds(events)
    expect(rounds).toEqual([
      { round: 1, countsBySeverity: { blocker: 2 }, confidence: null, outcome: 'changes_requested' }
    ])
  })

  it('a round with zero blockers carries an empty countsBySeverity, never a fabricated {blocker: 0}', () => {
    const events = [verdictsRead(1, 0, 0, 0), roundEnded(1, 1, 1, 'green')]
    const { rounds } = reconstructRounds(events)
    expect(rounds[0]?.countsBySeverity).toEqual({})
  })

  it('confidence is always null — never logged, never fabricated', () => {
    const events = [roundEnded(1, 0, 0, 'green')]
    expect(reconstructRounds(events).rounds[0]?.confidence).toBeNull()
  })

  it('sums wall_ms and files_changed across every reconstructed round', () => {
    const events = [
      roundEnded(1, 0, 0, 'changes_requested', { wall_ms: 500, files_changed: 2 }),
      roundEnded(2, 1, 10, 'green', { wall_ms: 700, files_changed: 4 })
    ]
    const { totalWallMs, totalFilesChanged } = reconstructRounds(events)
    expect(totalWallMs).toBe(1200)
    expect(totalFilesChanged).toBe(6)
  })

  it('maps a stop_condition_met of confidence/reappearance/no_progress/max_rounds to outcome "stopped", overriding round_ended\'s own logged outcome', () => {
    for (const condition of ['confidence', 'reappearance', 'no_progress', 'max_rounds']) {
      const events = [stopConditionMet(1, 0, 0, condition), roundEnded(1, 1, 1, 'changes_requested')]
      expect(reconstructRounds(events).rounds[0]?.outcome).toBe('stopped')
    }
  })

  it('a stop_condition_met of "escalated" keeps outcome "escalated", not "stopped"', () => {
    const events = [stopConditionMet(1, 0, 0, 'escalated'), roundEnded(1, 1, 1, 'escalated')]
    expect(reconstructRounds(events).rounds[0]?.outcome).toBe('escalated')
  })

  it("no stop_condition_met for a round leaves round_ended's own outcome untouched", () => {
    const events = [roundEnded(1, 0, 0, 'green')]
    expect(reconstructRounds(events).rounds[0]?.outcome).toBe('green')
  })

  it('is order-independent — events out of file order are re-sorted by meta.ts/meta.seq before replay', () => {
    const events = [roundEnded(1, 1, 1, 'changes_requested'), verdictsRead(1, 0, 0, 5)]
    expect(reconstructRounds(events).rounds).toEqual([
      { round: 1, countsBySeverity: { blocker: 5 }, confidence: null, outcome: 'changes_requested' }
    ])
  })

  it('rebuilds multiple rounds, sorted ascending by round number regardless of input order', () => {
    const events = [roundEnded(2, 1, 10, 'green'), roundEnded(1, 0, 0, 'changes_requested')]
    expect(reconstructRounds(events).rounds.map((r) => r.round)).toEqual([1, 2])
  })

  it('a duplicate round_ended for the same round (a chunk fetched or replayed twice) keeps only the one that sorts last', () => {
    const events = [
      roundEnded(1, 0, 0, 'changes_requested'),
      roundEnded(1, 1, 1, 'changes_requested', { wall_ms: 999 })
    ]
    const { rounds, totalWallMs } = reconstructRounds(events)
    expect(rounds).toHaveLength(1)
    expect(totalWallMs).toBe(999)
  })

  it('the pull-request verdict-comment parity bar: five real concluded rounds reconstruct to five rows, never fewer', () => {
    const events = [1, 2, 3, 4, 5].flatMap((round) => [
      verdictsRead(round, round * 2, round * 10, round),
      roundEnded(round, round * 2 + 1, round * 10 + 1, round === 5 ? 'green' : 'changes_requested')
    ])
    expect(reconstructRounds(events).rounds).toHaveLength(5)
  })

  it('a non-dev_review_loop or schema-invalid line is silently skipped, never thrown', () => {
    const lines = ['not json at all', JSON.stringify({ kind: 'dispatch', event: 'dispatched' }), '']
    expect(parseLoopEventLines(lines)).toEqual([])
  })
})

describe('extractLoopEventsFromCommentBody', () => {
  it('parses a real log-flush chunk comment — marker line, then a fenced ndjson block', () => {
    const event = roundEnded(1, 0, 0, 'green')
    const body = `<!-- aeg:log:run-1:0-0 -->\n\n\`\`\`ndjson\n${JSON.stringify(event)}\n\`\`\`\n`
    expect(extractLoopEventsFromCommentBody(body)).toEqual([event])
  })

  it('returns [] for a comment with no aeg:log marker on its first line', () => {
    expect(extractLoopEventsFromCommentBody('just an ordinary comment')).toEqual([])
  })

  it('returns [] for a marked comment with no fenced ndjson block', () => {
    expect(extractLoopEventsFromCommentBody('<!-- aeg:log:run-1:0-0 -->\n\nno fence here')).toEqual([])
  })
})

describe('nextRoundNumber', () => {
  it('is 1 when there is no prior history', () => {
    expect(nextRoundNumber([])).toBe(1)
  })

  it('is one past the highest reconstructed round', () => {
    const { rounds } = reconstructRounds([
      roundEnded(1, 0, 0, 'changes_requested'),
      roundEnded(3, 1, 1, 'changes_requested')
    ])
    expect(nextRoundNumber(rounds)).toBe(4)
  })
})
