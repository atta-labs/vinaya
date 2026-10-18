// The Vinaya renderer's round trip: every committed neutral case's reference
// solution, rendered and extracted, passes every generic grader for its kind;
// each known-bad variant that applies fails the grader it targets; and the
// graders' logic digests do not depend on the renderer.
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { GENERIC_GRADERS } from '../../src/lib/dev-review-eval/generic-graders'
import { NEUTRAL_CASE_KINDS, validateNeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import { OUTCOME_NAMES } from '../../src/lib/dev-review-eval/neutral-outcomes'
import {
  extractOutcomes,
  MAPPING_LOGIC,
  MAPPING_SOURCES,
  MAPPING_TABLES,
  rendererVersionOf,
  TOOL_CAPABILITIES,
  VINAYA_RENDERER_VERSION,
  type VinayaTrialRecord
} from '../../src/lib/dev-review-eval/vinaya-renderer'
import {
  type FixtureEntry,
  KNOWN_BAD_VARIANTS,
  loadFixture,
  referenceRecord,
  renderOrThrow
} from './vinaya-trial-records'
import { spawnSyncBudgeted, stripVinayaEnv } from '../lib/process-fixture'

const fixture = loadFixture()

function outcomesOf(record: VinayaTrialRecord) {
  const extracted = extractOutcomes(record)
  if (!extracted.ok) throw new Error(`extract refused: ${JSON.stringify(extracted.refusal)}`)
  expect(extracted.rendererVersion).toBe(VINAYA_RENDERER_VERSION)
  return extracted.outcomes
}

const graderById = (id: string) => {
  const grader = GENERIC_GRADERS.find((g) => g.identity.id === id)
  if (grader === undefined) throw new Error(`no generic grader ${id}`)
  return grader
}

const reference = (entry: FixtureEntry) => referenceRecord(entry, renderOrThrow(entry.case))

describe('the committed neutral cases', () => {
  it('are valid, cover every kind, and include a clean and a seeded review', () => {
    for (const entry of fixture) expect(validateNeutralCase(entry.case).ok).toBe(true)
    expect(new Set(fixture.map((e) => e.case.kind))).toEqual(new Set(NEUTRAL_CASE_KINDS))
    const reviews = fixture.map((e) => e.case).filter((c) => c.kind === 'review')
    expect(reviews.some((c) => c.kind === 'review' && c.adjudication.clean)).toBe(true)
    expect(reviews.some((c) => c.kind === 'review' && !c.adjudication.clean)).toBe(true)
  })
})

describe('each reference solution, rendered and extracted', () => {
  for (const entry of fixture) {
    it(`${entry.case.id} passes every generic grader that applies to a ${entry.case.kind} case`, async () => {
      const outcomes = outcomesOf(reference(entry))
      expect(Object.keys(outcomes).sort()).toEqual([...OUTCOME_NAMES].sort())
      const applicable = GENERIC_GRADERS.filter((g) => g.appliesTo.includes(entry.case.kind))
      expect(applicable.length).toBeGreaterThan(0)
      for (const grader of applicable) {
        const verdict = await grader.grade({ case: entry.case, outcomes })
        expect({ grader: grader.identity.id, ...verdict }).toEqual({ grader: grader.identity.id, verdict: 'pass' })
      }
    })
  }
})

describe('each known-bad variant, rendered and extracted', () => {
  for (const variant of KNOWN_BAD_VARIANTS) {
    it(`${variant.name} applies to some case`, () => {
      expect(fixture.some((entry) => variant.plant(reference(entry), entry) !== null)).toBe(true)
    })
    for (const entry of fixture) {
      const bad = variant.plant(reference(entry), entry)
      if (bad === null) continue
      it(`${variant.name} on ${entry.case.id} fails ${variant.graderId} and only that grader`, async () => {
        const outcomes = outcomesOf(bad)
        for (const grader of GENERIC_GRADERS.filter((g) => g.appliesTo.includes(entry.case.kind))) {
          const verdict = await grader.grade({ case: entry.case, outcomes })
          expect({ grader: grader.identity.id, verdict: verdict.verdict }).toEqual({
            grader: grader.identity.id,
            verdict: grader.identity.id === variant.graderId ? 'fail' : 'pass'
          })
        }
      })
    }
  }

  it('applies every variant its kind admits to each case', () => {
    for (const entry of fixture) {
      const c = entry.case
      const applied = KNOWN_BAD_VARIANTS.filter((v) => v.plant(reference(entry), entry) !== null).map((v) => v.graderId)
      const expected = [
        ...(c.kind !== 'review' ? ['generic-hidden-tests'] : []),
        ...(c.kind !== 'review' && c.authorizedScope.protected.length > 0 ? ['generic-scope-kept'] : []),
        ...(c.kind === 'review' && !c.adjudication.clean ? ['generic-planted-defects-found'] : []),
        ...(Object.values(TOOL_CAPABILITIES).some((cap) => !c.grantedCapabilities.includes(cap))
          ? ['generic-capabilities-granted']
          : []),
        ...(c.deliveredDocuments.some((d) => d.relevant) ? ['generic-documents-used'] : [])
      ]
      expect({ id: c.id, applied }).toEqual({ id: c.id, applied: expected })
    }
  })
})

describe('an outcome the record does not carry', () => {
  const removable = [
    'pullRequest',
    'measuredChange',
    'hiddenTests',
    'checks',
    'reviews',
    'readyForMerge',
    'developerTurnResult',
    'receipts',
    'trace',
    'effects'
  ] as const
  for (const entry of fixture) {
    it(`fails every grader that reads it, for ${entry.case.id}`, async () => {
      const base = reference(entry)
      for (const key of removable) {
        const record = { ...base, [key]: undefined } as VinayaTrialRecord
        const outcomes = outcomesOf(record)
        const unavailable = OUTCOME_NAMES.filter((name) => outcomes[name].status === 'unavailable')
        for (const grader of GENERIC_GRADERS) {
          const reads = Object.entries(grader.reads)
            .filter(([, kinds]) => kinds?.includes(entry.case.kind))
            .map(([name]) => name)
          if (!reads.some((name) => (unavailable as string[]).includes(name))) continue
          const verdict = await grader.grade({ case: entry.case, outcomes })
          expect({ key, grader: grader.identity.id, verdict: verdict.verdict }).toEqual({
            key,
            grader: grader.identity.id,
            verdict: 'fail'
          })
        }
      }
    })
  }

  it('reports a loop with no ready-for-merge result as no Decision, which fails the decision grader', async () => {
    const entry = fixture.find((e) => e.case.kind === 'loop') as FixtureEntry
    const outcomes = outcomesOf({ ...reference(entry), readyForMerge: null })
    expect(outcomes['O-decision'].status).toBe('absent')
    expect((await graderById('generic-decision-bound').grade({ case: entry.case, outcomes })).verdict).toBe('fail')
  })
})

describe('the generic graders and the renderer', () => {
  it('leave every grader logic digest unchanged whether or not the renderer is loaded', () => {
    // A fresh process that loads the graders and never the renderer.
    const graders = join(import.meta.dir, '../../src/lib/dev-review-eval/generic-graders.ts')
    const script = `const { GENERIC_GRADERS } = await import(${JSON.stringify(graders)}); console.log(JSON.stringify(GENERIC_GRADERS.map((g) => [g.identity.id, g.identity.logicDigest])))`
    const run = spawnSyncBudgeted(process.execPath, ['--eval', script], { encoding: 'utf8', env: stripVinayaEnv() })
    expect(run.status).toBe(0)
    const alone = JSON.parse(run.stdout.trim()) as [string, string][]
    expect(GENERIC_GRADERS.map((g) => [g.identity.id, g.identity.logicDigest])).toEqual(alone)
  })

  it('changes the renderer version, and no grader digest, when the mapping changes', () => {
    const digests = GENERIC_GRADERS.map((g) => g.identity.logicDigest)
    const changed = rendererVersionOf(
      { ...MAPPING_TABLES, TOOL_CAPABILITIES: { ...TOOL_CAPABILITIES, WebFetch: 'read_document' } },
      MAPPING_LOGIC,
      MAPPING_SOURCES
    )
    expect(changed).not.toBe(VINAYA_RENDERER_VERSION)
    expect(GENERIC_GRADERS.map((g) => g.identity.logicDigest)).toEqual(digests)
  })
})
