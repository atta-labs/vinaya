import { describe, expect, it } from 'vitest'
import {
  classifyOutcome,
  computeRates,
  countFollowUpCommits,
  firstReviewActivityAt,
  parseArgs,
  runGates,
  toPrFacts
} from './eval-agent-compliance'
import type { EvalRow, GateVerdict, PrDetailRaw, PrFacts } from './eval-agent-compliance'

const PASS_ALL: GateVerdict = { applicable: true, pass: true, errors: [] }
const FAIL: GateVerdict = { applicable: true, pass: false, errors: ['nope'] }
const NOT_APPLICABLE: GateVerdict = { applicable: false, pass: true, errors: [] }

function baseFacts(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 1,
    headRefName: 'task/example-v1/1',
    title: 'Feat(x): thing',
    body: 'body',
    labels: [],
    mergedAt: '2026-08-01T00:00:00Z',
    mergeCommitOid: 'deadbeef',
    reviewActivityAt: null,
    followUpCommits: 0,
    issueNumber: null,
    ...overrides
  }
}

describe('parseArgs', () => {
  it('defaults to sample 20, json off', () => {
    expect(parseArgs([])).toEqual({ sample: 20, json: false })
  })

  it('parses --sample and --json', () => {
    expect(parseArgs(['--sample', '5', '--json'])).toEqual({ sample: 5, json: true })
  })

  it('throws on a non-positive-integer --sample', () => {
    expect(() => parseArgs(['--sample', '0'])).toThrow(/Usage:/)
    expect(() => parseArgs(['--sample', 'abc'])).toThrow(/Usage:/)
  })
})

describe('firstReviewActivityAt', () => {
  it('returns null when no comment carries a VERDICT: line', () => {
    expect(firstReviewActivityAt([{ body: 'looks good', createdAt: '2026-08-01T00:00:00Z' }])).toBeNull()
  })

  it('returns the earliest VERDICT: comment timestamp', () => {
    const comments = [
      { body: 'VERDICT: PASS\n...', createdAt: '2026-08-02T00:00:00Z' },
      { body: 'VERDICT: APPROVE\n...', createdAt: '2026-08-01T00:00:00Z' },
      { body: 'unrelated', createdAt: '2026-07-01T00:00:00Z' }
    ]
    expect(firstReviewActivityAt(comments)).toBe('2026-08-01T00:00:00Z')
  })
})

describe('countFollowUpCommits', () => {
  it('is zero when there is no review activity to compare against', () => {
    expect(countFollowUpCommits([{ committedDate: '2026-08-05T00:00:00Z' }], null)).toBe(0)
  })

  it('counts only commits strictly after the review timestamp', () => {
    const commits = [
      { committedDate: '2026-08-01T00:00:00Z' },
      { committedDate: '2026-08-02T00:00:00Z' },
      { committedDate: '2026-08-03T00:00:00Z' }
    ]
    expect(countFollowUpCommits(commits, '2026-08-02T00:00:00Z')).toBe(1)
  })
})

describe('classifyOutcome', () => {
  it('clean when no waiver label and no follow-up commits', () => {
    expect(classifyOutcome({ labels: [], followUpCommits: 0 })).toBe('clean')
  })

  it('rework when follow-up commits exist and no waiver label', () => {
    expect(classifyOutcome({ labels: [], followUpCommits: 2 })).toBe('rework')
  })

  it('waived takes precedence over rework when both signals are present', () => {
    expect(classifyOutcome({ labels: ['vinaya/waiver:docs'], followUpCommits: 3 })).toBe('waived')
  })

  it('a non-waiver label does not trigger waived', () => {
    expect(classifyOutcome({ labels: ['vinaya/tier:1'], followUpCommits: 0 })).toBe('clean')
  })
})

describe('toPrFacts', () => {
  it('derives labels, follow-up commits, and the smallest Closes #N as issueNumber', () => {
    const raw: PrDetailRaw = {
      number: 42,
      headRefName: 'task/example-v1/3',
      title: 'Feat(x): thing',
      body: 'Closes #10\n\nAlso closes #7 for good measure.',
      labels: [{ name: 'vinaya/tier:1' }, { name: 'vinaya/waiver:docs' }],
      mergedAt: '2026-08-01T00:00:00Z',
      mergeCommit: { oid: 'abc123' },
      commits: [{ committedDate: '2026-08-03T00:00:00Z' }],
      comments: [{ body: 'VERDICT: APPROVE', createdAt: '2026-08-02T00:00:00Z' }]
    }
    const facts = toPrFacts(raw)
    expect(facts.labels).toEqual(['vinaya/tier:1', 'vinaya/waiver:docs'])
    expect(facts.issueNumber).toBe(7)
    expect(facts.reviewActivityAt).toBe('2026-08-02T00:00:00Z')
    expect(facts.followUpCommits).toBe(1)
    expect(facts.mergeCommitOid).toBe('abc123')
  })

  it('issueNumber is null when the body carries no Closes reference', () => {
    const raw: PrDetailRaw = {
      number: 1,
      headRefName: 'task/example-v1/1',
      title: 't',
      body: 'no closes reference here',
      labels: [],
      mergedAt: '2026-08-01T00:00:00Z',
      mergeCommit: null,
      commits: [],
      comments: []
    }
    const facts = toPrFacts(raw)
    expect(facts.issueNumber).toBeNull()
    expect(facts.mergeCommitOid).toBeNull()
  })
})

describe('runGates', () => {
  it('marks issue-rationale and premise not-applicable when there is nothing to check', () => {
    const facts = baseFacts({ body: 'no premise block here', issueNumber: null })
    const gates = runGates(facts, null, null)
    expect(gates['issue-rationale'].applicable).toBe(false)
    expect(gates.premise.applicable).toBe(false)
    expect(gates['brief-shape'].applicable).toBe(true)
  })

  it('runs the premise gate against the injected file reader when the body carries a Premise: block', () => {
    const body = ['**Premise:**', '- src/thing.ts contains: export function thing'].join('\n')
    const facts = baseFacts({ body })
    const passingReader = () => 'export function thing() {}'
    const failingReader = () => 'export function other() {}'

    expect(runGates(facts, null, passingReader).premise).toEqual({ applicable: true, pass: true, errors: [] })
    const failed = runGates(facts, null, failingReader).premise
    expect(failed.applicable).toBe(true)
    expect(failed.pass).toBe(false)
    expect(failed.errors.length).toBeGreaterThan(0)
  })

  it('a null file reader marks the premise gate not-applicable even when a Premise: block exists', () => {
    const body = ['**Premise:**', '- src/thing.ts contains: export function thing'].join('\n')
    const facts = baseFacts({ body })
    expect(runGates(facts, null, null).premise.applicable).toBe(false)
  })

  it('runs issue-rationale against the supplied issue body when present', () => {
    const facts = baseFacts({ issueNumber: 7 })
    const gates = runGates(facts, 'a body with none of the rationale fields', null)
    expect(gates['issue-rationale']).toEqual({ applicable: true, pass: false, errors: gates['issue-rationale'].errors })
    expect(gates['issue-rationale'].errors.length).toBeGreaterThan(0)
  })
})

describe('computeRates', () => {
  function row(overrides: Partial<EvalRow> = {}): EvalRow {
    return {
      facts: baseFacts(),
      issueBody: null,
      outcome: 'clean',
      gates: { 'brief-shape': PASS_ALL, 'issue-rationale': NOT_APPLICABLE, premise: NOT_APPLICABLE },
      ...overrides
    }
  }

  it('reports null rates and firstTryGreenRate on an empty sample', () => {
    const report = computeRates([])
    expect(report.totalSamples).toBe(0)
    expect(report.firstTryGreenRate).toBeNull()
    for (const gr of report.gateRates) {
      expect(gr.falsePositiveRate).toBeNull()
      expect(gr.falseNegativeRate).toBeNull()
    }
  })

  it('counts a gate failing a clean PR as a false positive', () => {
    const rows = [
      row({
        outcome: 'clean',
        gates: { 'brief-shape': FAIL, 'issue-rationale': NOT_APPLICABLE, premise: NOT_APPLICABLE }
      })
    ]
    const report = computeRates(rows)
    const briefShape = report.gateRates.find((g) => g.gate === 'brief-shape')
    expect(briefShape).toMatchObject({ falsePositives: 1, cleanSamples: 1, falsePositiveRate: 1 })
  })

  it('counts a gate passing a rework PR as a false negative', () => {
    const rows = [
      row({
        outcome: 'rework',
        gates: { 'brief-shape': PASS_ALL, 'issue-rationale': NOT_APPLICABLE, premise: NOT_APPLICABLE }
      })
    ]
    const report = computeRates(rows)
    const briefShape = report.gateRates.find((g) => g.gate === 'brief-shape')
    expect(briefShape).toMatchObject({ falseNegatives: 1, reworkSamples: 1, falseNegativeRate: 1 })
  })

  it('excludes not-applicable gate verdicts from that gate denominator', () => {
    const rows = [
      row({
        outcome: 'clean',
        gates: { 'brief-shape': PASS_ALL, 'issue-rationale': NOT_APPLICABLE, premise: NOT_APPLICABLE }
      })
    ]
    const report = computeRates(rows)
    const issueRationale = report.gateRates.find((g) => g.gate === 'issue-rationale')
    expect(issueRationale).toMatchObject({ applicableSamples: 0, cleanSamples: 0, falsePositiveRate: null })
  })

  it('waived PRs count toward neither the clean nor the rework denominator', () => {
    const rows = [row({ outcome: 'waived' })]
    const report = computeRates(rows)
    expect(report.outcomeCounts).toEqual({ clean: 0, rework: 0, waived: 1 })
    const briefShape = report.gateRates.find((g) => g.gate === 'brief-shape')
    expect(briefShape).toMatchObject({ cleanSamples: 0, reworkSamples: 0 })
    expect(report.firstTryGreenRate).toBe(0)
  })

  it('first-try-green rate is the fraction of the sample that merged clean', () => {
    const rows = [
      row({ outcome: 'clean' }),
      row({ outcome: 'clean' }),
      row({ outcome: 'rework' }),
      row({ outcome: 'waived' })
    ]
    const report = computeRates(rows)
    expect(report.firstTryGreenCount).toBe(2)
    expect(report.firstTryGreenRate).toBe(0.5)
  })
})
