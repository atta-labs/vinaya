import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  ADAPTERS,
  CASES_PATH,
  HELD_OUT_PATH,
  SOURCE_CITATION_FLOOR,
  TRIALS_PER_TASK,
  developmentDigest,
  formatReport,
  gradeSourceUse,
  loadCaseFile,
  loadHeldOutCases,
  reportSourceCitation,
  sha256,
  type SourceCitationCase,
  type TrialObservation
} from './source-citation-suite'

describe('source citation corpus', () => {
  it('pins the development split without reading held-out content', () => {
    const reads: string[] = []
    const file = loadCaseFile((path) => {
      reads.push(path)
      if (path === HELD_OUT_PATH) throw new Error('held-out content was read')
      return readFileSync(path, 'utf8')
    })
    expect(loadCaseFile().splits.development.digest).toBe(developmentDigest(loadCaseFile().cases))
    expect(reads).toEqual([CASES_PATH])
    expect(file).toBeDefined()
  })

  it('refuses held-out content before digest approval and verifies bytes after approval', () => {
    const file = loadCaseFile()
    let reads = 0
    expect(() =>
      loadHeldOutCases(file, undefined, () => {
        reads += 1
        return ''
      })
    ).toThrow('only with --approve-held-out')
    expect(reads).toBe(0)
    const text = readFileSync(HELD_OUT_PATH, 'utf8')
    expect(sha256(text)).toBe(file.splits.heldOut.digest)
    expect(loadHeldOutCases(file, file.splits.heldOut.digest)).toHaveLength(file.splits.heldOut.index.length)
  })
})

describe('source citation code grader', () => {
  const file = loadCaseFile()
  for (const testCase of file.cases) {
    it(`detects ${testCase.class}`, () => {
      expect(gradeSourceUse(testCase).verdict === 'pass').toBe(testCase.expectedPass)
    })
  }

  it('requires receipt, manifest identity, current digest and relevance together', () => {
    const base = file.cases.find((value) => value.class === 'correct-citation')!
    expect(gradeSourceUse({ ...base, receipts: [] }).reasons).toContain('no relevant delivered source cited')
    expect(gradeSourceUse({ ...base, manifest: [{ ...base.manifest[0]!, relevant: false }] }).reasons).toContain(
      `irrelevant source: ${base.manifest[0]!.source}`
    )
    expect(gradeSourceUse({ ...base, receipts: [{ ...base.receipts[0]!, sha256: '0'.repeat(64) }] }).reasons).toContain(
      `no current controller receipt: ${base.manifest[0]!.source}`
    )
  })
})

describe('source citation report', () => {
  it('reports both adapters, fixed floor, counts, trials and cost', () => {
    const source = 'https://docs.example.test/current'
    const digest = 'a'.repeat(64)
    const cases: SourceCitationCase[] = [
      {
        id: 'report-source-required',
        class: 'correct-citation',
        requiresSource: true,
        request: 'Use the source.',
        manifest: [{ source, sha256: digest, relevant: true }],
        receipts: [{ source, sha256: digest, recorded: true, decision: 'counted' }],
        acceptedResult: { status: 'completed', sourceUses: [{ source, use: 'Applied the current rule.' }] },
        expectedPass: true
      },
      {
        id: 'report-no-source',
        class: 'no-source-balance',
        requiresSource: false,
        request: 'Do the self-contained edit.',
        manifest: [],
        receipts: [],
        acceptedResult: { status: 'completed', sourceUses: [] },
        expectedPass: true
      }
    ]
    const observations: TrialObservation[] = ADAPTERS.flatMap((adapter) =>
      cases.flatMap((testCase) =>
        Array.from({ length: TRIALS_PER_TASK }, (_, trial) => ({
          adapter,
          taskId: testCase.id,
          trial,
          result: testCase.acceptedResult,
          cost: {
            reportedSpendUsd: adapter === 'claude-code' ? 0.01 : null,
            inputTokens: 10,
            outputTokens: 4,
            wallMs: 20
          }
        }))
      )
    )
    const report = reportSourceCitation('development', cases, observations)
    expect(report.floor).toBe(SOURCE_CITATION_FLOOR)
    expect(report.floorHolds).toBe(true)
    expect(report.adapters.map((value) => value.adapter)).toEqual([...ADAPTERS])
    expect(report.adapters.every((value) => value.taskCount === 2 && value.trials === 6)).toBe(true)
    expect(formatReport(report)).toContain('2 tasks × 3 trials per adapter')
    expect(formatReport(report)).toContain('reported spend')
  })
})
