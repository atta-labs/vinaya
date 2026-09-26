import { describe, expect, it } from 'vitest'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from '../verdict-extraction'
import { blockingVerdict, cleanVerdict, fakeGate, fakeVerdicts, runScenario } from './fakes'
import { parseSummaryConfidenceRows, renderSummary } from './render-summary'
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

describe('renderSummary — Part 4 (O4)', () => {
  it('renders one row per round with the fixed severity columns, confidence, and outcome', () => {
    const { state } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'blocker', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])

    const summary = renderSummary({ rounds: state.rounds })

    expect(summary).toContain(
      '| round | blocker | major | minor | critical | high | medium | low | confidence | outcome |'
    )
    expect(summary).toContain('| 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | — | changes_requested |')
    expect(summary).toContain('| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 80% | green |')
  })

  it('never emits a line either verdict extractor reads as a real verdict', () => {
    const { state } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])
    const summary = renderSummary({ rounds: state.rounds })

    expect(extractCodeReviewVerdict([summary]).danglingNote).not.toBeNull()
    expect(extractSecurityReviewVerdict([summary]).danglingNote).not.toBeNull()
    expect(summary).not.toMatch(/VERDICT:/)
    expect(summary).not.toMatch(/Judged head:/)
    expect(summary).not.toMatch(/Objectives version:/)
  })

  it('carries no finding text — no F<n> id, no file path', () => {
    const { state } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F7', severity: 'major', state: 'open' }]),
        cleanVerdict('security')
      ])
    ])
    const summary = renderSummary({ rounds: state.rounds })

    expect(summary).not.toMatch(/\bF\d+\b/)
    expect(summary).not.toMatch(/apps\/cli|packages\/aeg-core/)
  })

  it('defeat: a journal with zero rounds renders one header row, no crash', () => {
    const summary = renderSummary({ rounds: [] })
    const lines = summary.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('round')
  })

  it('defeat: outcome words never include APPROVE — only green, changes_requested, escalated, stopped', () => {
    const summary = renderSummary({
      rounds: [
        { round: 1, countsBySeverity: {}, confidence: null, outcome: 'green' },
        { round: 2, countsBySeverity: {}, confidence: null, outcome: 'changes_requested' },
        { round: 3, countsBySeverity: {}, confidence: null, outcome: 'escalated' },
        { round: 4, countsBySeverity: {}, confidence: null, outcome: 'stopped' }
      ]
    })
    expect(summary).not.toMatch(/APPROVE/)
    for (const word of ['green', 'changes_requested', 'escalated', 'stopped']) {
      expect(summary).toContain(word)
    }
  })

  it('renders `absent` confidence distinctly from a numeric value or no confidence at all', () => {
    const summary = renderSummary({
      rounds: [
        { round: 1, countsBySeverity: {}, confidence: null, outcome: 'changes_requested' },
        { round: 2, countsBySeverity: {}, confidence: 'absent', outcome: 'changes_requested' },
        { round: 3, countsBySeverity: {}, confidence: { value: 60 }, outcome: 'green' }
      ]
    })
    expect(summary).toContain('| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | changes_requested |')
    expect(summary).toContain('| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | absent | changes_requested |')
    expect(summary).toContain('| 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 60% | green |')
  })
})

describe('parseSummaryConfidenceRows', () => {
  it("reads back every round's confidence from a table this module itself rendered", () => {
    const { state } = runScenario(freshState(), [
      fakeGate(1, true),
      fakeVerdicts(1, [
        blockingVerdict('reviewer', [{ id: 'F1', severity: 'blocker', state: 'open' }]),
        cleanVerdict('security')
      ]),
      fakeGate(2, true, { confidence: { value: 80 } }),
      fakeVerdicts(2, [cleanVerdict('reviewer'), cleanVerdict('security')])
    ])

    expect(parseSummaryConfidenceRows(renderSummary({ rounds: state.rounds }))).toEqual([
      // Round 1 was never asked for a confidence — recorded as an absence,
      // read back as one, never as a zero.
      { round: 1, percent: null },
      { round: 2, percent: 80 }
    ])
  })

  it('reads a summary quoted inside a longer comment, and nothing from prose or a differently-shaped table', () => {
    const comment = [
      'Ready for merge.',
      '',
      '| round | blocker | major | minor | critical | high | medium | low | confidence | outcome |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 95% | green |',
      '',
      '| round | confidence |',
      '| --- | --- |',
      '| 9 | 10% |'
    ].join('\n')

    expect(parseSummaryConfidenceRows(comment)).toEqual([{ round: 1, percent: 95 }])
  })
})
