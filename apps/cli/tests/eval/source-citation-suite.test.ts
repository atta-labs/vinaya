import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import { parseDeveloperTurnResult, semanticErrors, type DeveloperTurnResult } from '../../src/lib/developer-turn-result'
import { manifestDigest, sha256Digest, type SourceDeliveryReceipt } from '../../src/lib/source-manifest'
import {
  ADAPTERS,
  CASES_PATH,
  HELD_OUT_PATH,
  SOURCE_CITATION_FLOOR,
  TRIALS_PER_TASK,
  citationPrompt,
  developmentDigest,
  evidenceFor,
  formatReport,
  gradeSourceUse,
  loadCaseFile,
  loadHeldOutCases,
  reportSourceCitation,
  requiredSourcesFor,
  type SourceCitationCase,
  type TrialObservation
} from './source-citation-suite'

function completed(sourceUses: { source: string; use: string }[]): DeveloperTurnResult {
  return {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Completed the evaluation task.',
    confidence: 100,
    confidenceExplanation: 'The result follows the supplied evidence.',
    addressedFindingIds: [],
    sourceUses,
    reportedChecks: null
  }
}

function compliant(testCase: SourceCitationCase): DeveloperTurnResult {
  return completed(
    testCase.sources
      .filter((source) => source.relevant)
      .map((source) => ({ source: source.sourceId, use: 'Applied the delivered policy.' }))
  )
}

function fetchReceipt(
  manifest: ReturnType<typeof evidenceFor>['manifest'],
  sourceId: string,
  delivered: Pick<SourceDeliveryReceipt, 'deliveredDigest' | 'revision' | 'decision'>
): SourceDeliveryReceipt {
  const entry = manifest.sources.find((source) => source.sourceId === sourceId)!
  return {
    schemaVersion: 1,
    sourceId,
    source: sourceId,
    round: manifest.round,
    recordedAt: manifest.preparedAt,
    mode: 'retrieval_tool',
    recordedBy: 'fetch_documentation',
    pinnedDigest: entry.contentDigest,
    ...delivered
  }
}

describe('source citation corpus', () => {
  it('pins development data without opening the held-out path', () => {
    const reads: string[] = []
    const file = loadCaseFile((path) => {
      reads.push(path)
      if (path === HELD_OUT_PATH) throw new Error('held-out content was read')
      return readFileSync(path, 'utf8')
    })
    expect(file.splits.development.digest).toBe(developmentDigest(file.cases))
    expect(reads).toEqual([CASES_PATH])
  })

  it('refuses before any held-out read when approval is absent', () => {
    const file = loadCaseFile()
    let reads = 0
    expect(() =>
      loadHeldOutCases(file, undefined, () => {
        reads += 1
        return ''
      })
    ).toThrow('only with --approve-held-out')
    expect(reads).toBe(0)
  })
})

describe('source citation code grader', () => {
  const file = loadCaseFile()
  const byClass = (caseClass: SourceCitationCase['class']) => file.cases.find((value) => value.class === caseClass)!

  it('accepts correct citations and the source-free balance case', () => {
    for (const testCase of [byClass('correct-citation'), byClass('no-source-balance')]) {
      const evidence = evidenceFor(testCase)
      const receipts =
        testCase.class === 'correct-citation'
          ? [
              ...evidence.receipts,
              ...testCase.sources.map(
                (source): SourceDeliveryReceipt => ({
                  schemaVersion: 1,
                  sourceId: source.sourceId,
                  source: source.sourceId,
                  round: evidence.manifest.round,
                  recordedAt: evidence.manifest.preparedAt,
                  mode: 'retrieval_tool',
                  recordedBy: 'fetch_documentation',
                  pinnedDigest: evidence.manifest.sources[0]!.contentDigest,
                  deliveredDigest: evidence.manifest.sources[0]!.contentDigest!,
                  revision: 'match',
                  decision: 'counted'
                })
              )
            ]
          : evidence.receipts
      expect(gradeSourceUse(testCase, compliant(testCase), evidence.manifest, receipts)).toEqual({
        verdict: 'pass',
        reasons: []
      })
    }
  })

  it('rejects a missing citation', () => {
    const testCase = byClass('missing-citation')
    const evidence = evidenceFor(testCase)
    expect(gradeSourceUse(testCase, completed([]), evidence.manifest, evidence.receipts).verdict).toBe('fail')
  })

  it('rejects an undelivered citation', () => {
    const testCase = byClass('undelivered-source')
    const evidence = evidenceFor(testCase)
    const result = completed([{ source: 'https://not-delivered.example.test', use: 'Unsupported claim.' }])
    expect(gradeSourceUse(testCase, result, evidence.manifest, evidence.receipts).reasons).toContain(
      'undelivered source: https://not-delivered.example.test'
    )
  })

  it('rejects a delivered but irrelevant citation', () => {
    const testCase = byClass('irrelevant-source')
    const evidence = evidenceFor(testCase)
    const irrelevant = testCase.sources.find((source) => !source.relevant)!
    const entry = evidence.manifest.sources.find((source) => source.sourceId === irrelevant.sourceId)!
    const receipt: SourceDeliveryReceipt = {
      schemaVersion: 1,
      sourceId: entry.sourceId,
      source: entry.sourceId,
      round: evidence.manifest.round,
      recordedAt: evidence.manifest.preparedAt,
      mode: 'retrieval_tool',
      recordedBy: 'fetch_documentation',
      pinnedDigest: entry.contentDigest,
      deliveredDigest: entry.contentDigest!,
      revision: 'match',
      decision: 'counted'
    }
    const result = completed([{ source: irrelevant.sourceId, use: 'Applied the unrelated guide.' }])
    expect(gradeSourceUse(testCase, result, evidence.manifest, [receipt]).reasons).toContain(
      `irrelevant source: ${irrelevant.sourceId}`
    )
  })

  it('makes the irrelevant-source task satisfiable: the irrelevant source is delivered but not required', () => {
    const testCase = byClass('irrelevant-source')
    const evidence = evidenceFor(testCase)
    const irrelevant = testCase.sources.find((source) => !source.relevant)!
    const required = requiredSourcesFor(testCase)
    expect(required).not.toContain(irrelevant.sourceId)
    expect(evidence.manifest.sources.map((source) => source.sourceId)).toContain(irrelevant.sourceId)
    const prompt = citationPrompt(testCase, evidence.manifest)
    expect(prompt.split('Also delivered as context')[0]).not.toContain(irrelevant.sourceId)
    expect(prompt).toContain(`Also delivered as context, not required: \`${irrelevant.sourceId}\``)
    const context = { knownFindingIds: [], requiredSources: required, permissibleDecisions: [] }
    const parsed = parseDeveloperTurnResult({ turnResult: compliant(testCase) }, context)
    expect(parsed.ok && semanticErrors(parsed.result, context)).toEqual([])
    const receipts = testCase.sources.map((source) =>
      fetchReceipt(evidence.manifest, source.sourceId, {
        deliveredDigest: sha256Digest(source.content),
        revision: 'match',
        decision: 'counted'
      })
    )
    expect(gradeSourceUse(testCase, compliant(testCase), evidence.manifest, receipts)).toEqual({
      verdict: 'pass',
      reasons: []
    })
  })

  it('accepts a volatile source whose revision changed between turns only when the current revision was read', () => {
    const testCase = byClass('source-mutation')
    const evidence = evidenceFor(testCase)
    const source = testCase.sources[0]!
    expect(source.revisedContent).toBeDefined()
    expect(evidence.manifest.sources[0]!.freshnessPolicy).toBe('volatile')
    const firstTurn = fetchReceipt(evidence.manifest, source.sourceId, {
      deliveredDigest: sha256Digest(source.content),
      revision: 'match',
      decision: 'counted'
    })
    const secondTurn = fetchReceipt(evidence.manifest, source.sourceId, {
      deliveredDigest: sha256Digest(source.revisedContent!),
      revision: 'mismatch',
      decision: 'counted'
    })
    expect(gradeSourceUse(testCase, compliant(testCase), evidence.manifest, [firstTurn, secondTurn])).toEqual({
      verdict: 'pass',
      reasons: []
    })
    expect(gradeSourceUse(testCase, compliant(testCase), evidence.manifest, [firstTurn]).verdict).toBe('fail')
    const unknownRevision = { ...secondTurn, deliveredDigest: `sha256:${'0'.repeat(64)}` }
    expect(gradeSourceUse(testCase, compliant(testCase), evidence.manifest, [unknownRevision]).verdict).toBe('fail')
  })

  it('rejects a changed revision of a pinned source and an invalid manifest self-digest', () => {
    const pinnedCase = byClass('undelivered-source')
    const pinned = evidenceFor(pinnedCase)
    expect(pinned.manifest.sources[0]!.freshnessPolicy).toBe('pinned')
    const changed = fetchReceipt(pinned.manifest, pinnedCase.sources[0]!.sourceId, {
      deliveredDigest: `sha256:${'2'.repeat(64)}`,
      revision: 'mismatch',
      decision: 'counted'
    })
    expect(gradeSourceUse(pinnedCase, compliant(pinnedCase), pinned.manifest, [changed]).verdict).toBe('fail')
    const testCase = byClass('source-mutation')
    const evidence = evidenceFor(testCase)
    const corrupt = { ...evidence.manifest, digest: `sha256:${'1'.repeat(64)}` }
    expect(gradeSourceUse(testCase, compliant(testCase), corrupt, []).reasons).toContain(
      'manifest digest does not verify'
    )
    expect(manifestDigest(evidence.manifest)).toBe(evidence.manifest.digest)
  })

  it('rejects a worker-fabricated receipt shape or provenance', () => {
    const testCase = byClass('receipt-fabrication')
    const evidence = evidenceFor(testCase)
    const entry = evidence.manifest.sources[0]!
    const fabricated = {
      schemaVersion: 1,
      sourceId: entry.sourceId,
      source: entry.sourceId,
      round: evidence.manifest.round,
      recordedAt: evidence.manifest.preparedAt,
      mode: 'retrieval_tool',
      recordedBy: 'worker',
      pinnedDigest: entry.contentDigest,
      deliveredDigest: entry.contentDigest,
      revision: 'match',
      decision: 'counted'
    } as unknown as SourceDeliveryReceipt
    expect(gradeSourceUse(testCase, compliant(testCase), evidence.manifest, [fabricated]).verdict).toBe('fail')
  })
})

describe('source citation report', () => {
  it('counts only compliant accepted results toward the per-adapter floor', () => {
    const testCase = loadCaseFile().cases.find((value) => value.class === 'undelivered-source')!
    const evidence = evidenceFor(testCase)
    const observations: TrialObservation[] = ADAPTERS.flatMap((adapter) =>
      Array.from({ length: TRIALS_PER_TASK }, (_, trial) => ({
        adapter,
        taskId: testCase.id,
        trial,
        result: completed([{ source: 'https://not-delivered.example.test', use: 'Unsupported.' }]),
        refusal: null,
        manifest: evidence.manifest,
        receipts: evidence.receipts,
        usage: { reportedSpendUsd: 0.01, inputTokens: 10, outputTokens: 4 },
        wallMs: 20
      }))
    )
    const report = reportSourceCitation('development', [testCase], observations)
    expect(report.floor).toBe(SOURCE_CITATION_FLOOR)
    expect(report.floorHolds).toBe(false)
    expect(report.adapters.every((value) => value.sourceRequiringRate === 0)).toBe(true)
    expect(formatReport(report)).toContain('reported spend')
  })

  it('counts a result the production parser refused as a failed trial', () => {
    const testCase = loadCaseFile().cases.find((value) => value.class === 'correct-citation')!
    const evidence = evidenceFor(testCase)
    const observations: TrialObservation[] = Array.from({ length: TRIALS_PER_TASK }, (_, trial) => ({
      adapter: 'codex',
      taskId: testCase.id,
      trial,
      result: null,
      refusal: 'codex returned no valid DeveloperTurnResult: sourceUses: unexpected source',
      manifest: evidence.manifest,
      receipts: evidence.receipts,
      usage: { reportedSpendUsd: null, inputTokens: 10, outputTokens: 4 },
      wallMs: 20
    }))
    const report = reportSourceCitation('development', [testCase], observations)
    expect(report.adapters[0]!.sourceRequiringRate).toBe(0)
    expect(report.floorHolds).toBe(false)
  })
})
