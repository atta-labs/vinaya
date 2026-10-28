// The layer-G suites: each loads its derived cases from a file pinned by
// digest, renders them with the Vinaya renderer and grades them with the
// generic graders alone. Every derived case's reference passes, and every
// known-bad variant that applies fails the grader it targets and no other.
// Held-out results are asserted as counts and failing case ids only.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { findBannedTerms } from '../../src/lib/dev-review-eval/banned-terms'
import { GENERIC_GRADERS } from '../../src/lib/dev-review-eval/generic-graders'
import { validateNeutralCase } from '../../src/lib/dev-review-eval/neutral-case'
import { LIVE_SUITE_LAYERS } from '../../src/lib/dev-review-eval/freeze-record'
import { loadCaseFile as loadDeveloperCaseFile } from './developer-capability-suite'
import {
  DERIVED_FILE_DIGESTS,
  DEVELOPER_DERIVED,
  DerivedFileRefused,
  developerReferenceCases,
  developmentCases,
  developmentVariants,
  GENERIC_SUITES_PROCESS_LAYER,
  type GenericSuiteKey,
  genericSuite,
  HELD_OUT_IDS,
  heldOutCases,
  heldOutVariants,
  roundTrip
} from './generic-suites'
import {
  DERIVED_FILES,
  GENERIC_SUITE_IDS,
  LOOP_CAPABILITIES,
  LOOP_VARIANTS,
  loadRevisionFacts
} from './recut-generic-cases'

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const KEYS = Object.keys(GENERIC_SUITE_IDS) as GenericSuiteKey[]
const HELD_OUT_KEYS: GenericSuiteKey[] = [
  'developer',
  'codeReviewer',
  'securityReviewer',
  'sourceCitation',
  'wholeLoop'
]
const heldOutApproval = (key: GenericSuiteKey) =>
  key === 'developer'
    ? DERIVED_FILE_DIGESTS.developer.heldOut
    : key === 'sourceCitation'
      ? DERIVED_FILE_DIGESTS.sourceCitation.heldOut
      : key === 'wholeLoop'
        ? DERIVED_FILE_DIGESTS.wholeLoop.heldOut
        : DERIVED_FILE_DIGESTS.reviewer.heldOut
const referenceCases = (key: GenericSuiteKey, split: 'development' | 'held-out') =>
  DEVELOPER_DERIVED.includes(key) ? developerReferenceCases(split) : []

/** The six generic graders a whole-loop case must pass. */
const LOOP_GRADERS = [
  'generic-hidden-tests',
  'generic-scope-kept',
  'generic-review-bound',
  'generic-decision-bound',
  'generic-change-bound',
  'generic-effects-once'
]

/** A reader that refuses every held-out file, so a development path that reaches one fails. */
const developmentOnly = (path: string) => {
  if (/held-out/.test(path)) throw new Error(`development loading opened ${path}`)
  return readFileSync(path)
}

describe('the derived files', () => {
  it('match their pinned digests', () => {
    const files: [string, string][] = [
      [DERIVED_FILES.developer.development, DERIVED_FILE_DIGESTS.developer.development],
      [DERIVED_FILES.developer.heldOut, DERIVED_FILE_DIGESTS.developer.heldOut],
      [DERIVED_FILES.reviewer.development, DERIVED_FILE_DIGESTS.reviewer.development],
      [DERIVED_FILES.reviewer.heldOut, DERIVED_FILE_DIGESTS.reviewer.heldOut],
      [DERIVED_FILES.sourceCitation.development, DERIVED_FILE_DIGESTS.sourceCitation.development],
      [DERIVED_FILES.sourceCitation.heldOut, DERIVED_FILE_DIGESTS.sourceCitation.heldOut],
      [DERIVED_FILES.wholeLoop.development, DERIVED_FILE_DIGESTS.wholeLoop.development],
      [DERIVED_FILES.wholeLoop.heldOut, DERIVED_FILE_DIGESTS.wholeLoop.heldOut]
    ]
    for (const [path, pinned] of files)
      expect({ path, sha256: sha256(readFileSync(path)) }).toEqual({ path, sha256: pinned })
  })

  it('name layer-G suites the registry declares', () => {
    for (const key of KEYS) {
      const name = GENERIC_SUITE_IDS[key].split('@')[0] as keyof typeof LIVE_SUITE_LAYERS
      expect({ name, layer: LIVE_SUITE_LAYERS[name] }).toEqual({ name, layer: GENERIC_SUITES_PROCESS_LAYER })
    }
  })
})

describe('development loading', () => {
  it('loads every suite without opening a held-out file, each case valid and its statement free of process terms', () => {
    const counts: Record<string, number> = {}
    for (const key of KEYS) {
      const cases = developmentCases(key, developmentOnly)
      counts[key] = cases.length
      for (const c of cases) {
        expect(validateNeutralCase(c).ok).toBe(true)
        expect({ id: c.id, banned: findBannedTerms(c.taskStatement) }).toEqual({ id: c.id, banned: [] })
      }
      const suite = genericSuite(key, developmentOnly)
      expect(suite.splits.development).toEqual(cases.map((c) => c.id))
      expect(suite.splits.heldOut).toEqual([...HELD_OUT_IDS[key]])
    }
    expect(counts).toEqual({ developer: 28, codeReviewer: 6, securityReviewer: 6, sourceCitation: 7, wholeLoop: 28 })
  })

  it('makes the whole-loop suite a layer-L6 suite with its own files and held-out index', () => {
    expect(genericSuite('wholeLoop', developmentOnly).layer).toBe('L6')
    expect(genericSuite('developer', developmentOnly).layer).toBe('L5')
    expect(DERIVED_FILES.wholeLoop.development).not.toBe(DERIVED_FILES.developer.development)
    expect(DERIVED_FILES.wholeLoop.heldOut).not.toBe(DERIVED_FILES.developer.heldOut)
    expect(DERIVED_FILE_DIGESTS.wholeLoop.heldOut).not.toBe(DERIVED_FILE_DIGESTS.developer.heldOut)
    expect(HELD_OUT_IDS.wholeLoop).not.toBe(HELD_OUT_IDS.developer)
  })

  it('derives a change case per developer case, a review case per reviewer case and an answer case per citation case', () => {
    const kinds = Object.fromEntries(KEYS.map((key) => [key, [...new Set(developmentCases(key).map((c) => c.kind))]]))
    expect(kinds).toEqual({
      developer: ['change'],
      codeReviewer: ['review'],
      securityReviewer: ['review'],
      sourceCitation: ['answer'],
      wholeLoop: ['loop']
    })
  })

  it('refuses a derived file whose bytes differ from its pin', () => {
    const tampered = (path: string) => Buffer.concat([readFileSync(path), Buffer.from(' ')])
    expect(() => developmentCases('developer', tampered)).toThrow(DerivedFileRefused)
  })
})

describe('held-out loading', () => {
  it('opens a held-out file only for an approval naming its pinned digest', () => {
    for (const key of HELD_OUT_KEYS) {
      expect(() => heldOutCases(key, 'f'.repeat(64))).toThrow(DerivedFileRefused)
      expect(heldOutCases(key, heldOutApproval(key)).map((c) => c.id)).toEqual([...HELD_OUT_IDS[key]])
    }
    expect(() => heldOutCases('sourceCitation', DERIVED_FILE_DIGESTS.sourceCitation.development)).toThrow(
      DerivedFileRefused
    )
    // The whole-loop held-out file opens for its own digest, never the developer suite's.
    expect(() => heldOutCases('wholeLoop', DERIVED_FILE_DIGESTS.developer.heldOut)).toThrow(DerivedFileRefused)
    expect(() => heldOutVariants('wholeLoop', 'f'.repeat(64))).toThrow(DerivedFileRefused)
  })

  it('holds only valid cases whose statements are free of process terms, reported by id only', () => {
    for (const key of HELD_OUT_KEYS) {
      const failing = heldOutCases(key, heldOutApproval(key))
        .filter((c) => !validateNeutralCase(c).ok || findBannedTerms(c.taskStatement).length > 0)
        .map((c) => c.id)
      expect({ key, failing }).toEqual({ key, failing: [] })
    }
  })
})

describe('each G suite, rendered and graded by the generic graders only', () => {
  it('grades with layer-G graders and nothing else', () => {
    for (const grader of GENERIC_GRADERS) expect(grader.identity.layer).toBe('G')
  })

  for (const key of KEYS) {
    it(`${GENERIC_SUITE_IDS[key]}: every development reference passes and every applicable variant fails its grader`, async () => {
      const result = await roundTrip(key, developmentCases(key), referenceCases(key, 'development'))
      expect(result.failures).toEqual([])
      expect(result.cases).toBeGreaterThan(0)
      expect(result.variants).toBeGreaterThanOrEqual(result.cases)
      if (key === 'wholeLoop') {
        // Each of the six loop graders is the target of a variant that applies to every loop case.
        const untargeted = Object.entries(result.targeted)
          .filter(([, graders]) => LOOP_GRADERS.some((g) => !graders.includes(g)))
          .map(([id]) => id)
        expect(untargeted).toEqual([])
      }
    })
  }

  for (const key of HELD_OUT_KEYS) {
    it(`${GENERIC_SUITE_IDS[key]}: every held-out reference passes and every applicable variant fails its grader`, async () => {
      const result = await roundTrip(key, heldOutCases(key, heldOutApproval(key)), referenceCases(key, 'held-out'))
      // A failure names its case by id and digest and the check only, never its content.
      expect(result.failures.map((f) => `${f.id} ${f.digest} ${f.check}`)).toEqual([])
      expect(result.cases).toBe(HELD_OUT_IDS[key].length)
      if (key === 'wholeLoop') {
        const untargeted = Object.entries(result.targeted)
          .filter(([, graders]) => LOOP_GRADERS.some((g) => !graders.includes(g)))
          .map(([id]) => id)
        expect(untargeted).toEqual([])
      }
    })
  }
})

describe('the whole-loop suite', () => {
  it('cuts each loop case from the developer case of the same id, keeping every field but its kind and grants', () => {
    const changes = developmentCases('developer')
    const loops = developmentCases('wholeLoop')
    expect(loops.map((c) => c.id)).toEqual(changes.map((c) => c.id))
    for (const loop of loops) {
      const { kind, grantedCapabilities, ...kept } = loop
      const {
        kind: _changeKind,
        grantedCapabilities: _changeGrants,
        ...changeKept
      } = changes.find((c) => c.id === loop.id) as (typeof changes)[number]
      expect(kind).toBe('loop')
      expect(grantedCapabilities).toEqual([...LOOP_CAPABILITIES])
      expect(kept).toEqual(changeKept)
    }
  })

  it('marks the live variants beside the cases, never inside one', () => {
    const facts = loadRevisionFacts()
    const developerFile = loadDeveloperCaseFile()
    // Every developer capability case, development and held-out, had its review rounds read.
    expect([...facts.read].sort()).toEqual(
      [...developerFile.splits.development.ids, ...developerFile.splits.heldOut.index.map((e) => e.id)].sort()
    )
    expect(Object.keys(facts.revisionRounds).every((id) => facts.read.includes(id))).toBe(true)

    const cases = developmentCases('wholeLoop')
    const variants = developmentVariants('wholeLoop')
    expect(Object.keys(variants)).toEqual([...LOOP_VARIANTS])
    const ids = cases.map((c) => c.id)
    for (const variant of LOOP_VARIANTS) {
      const marked = variants[variant] ?? []
      expect(marked.length).toBeGreaterThan(0)
      expect(marked).toEqual([...marked].sort())
      expect(marked.every((id) => ids.includes(id))).toBe(true)
    }
    expect(variants['source-requiring']).toEqual(
      cases
        .filter((c) => c.deliveredDocuments.length > 0)
        .map((c) => c.id)
        .sort()
    )
    expect(variants['reviewer-requested-revision']).toEqual(
      ids.filter((id) => (facts.revisionRounds[id] ?? []).length > 0).sort()
    )
    expect(variants['reviewer-requested-revision']).not.toContain('pr-1312')
    for (const c of cases) expect(Object.keys(c)).not.toContain('variants')
    // No other suite marks a variant.
    for (const key of KEYS.filter((k) => k !== 'wholeLoop')) expect(developmentVariants(key)).toEqual({})
  })

  it('marks the held-out cases the same way, reported as counts only', () => {
    const facts = loadRevisionFacts()
    const cases = heldOutCases('wholeLoop', DERIVED_FILE_DIGESTS.wholeLoop.heldOut)
    const variants = heldOutVariants('wholeLoop', DERIVED_FILE_DIGESTS.wholeLoop.heldOut)
    const counts = Object.fromEntries(LOOP_VARIANTS.map((v) => [v, (variants[v] ?? []).length]))
    expect(counts).toEqual({
      'source-requiring': cases.filter((c) => c.deliveredDocuments.length > 0).length,
      'reviewer-requested-revision': cases.filter((c) => (facts.revisionRounds[c.id] ?? []).length > 0).length
    })
    expect(Object.values(counts).every((n) => n > 0)).toBe(true)
  })
})
