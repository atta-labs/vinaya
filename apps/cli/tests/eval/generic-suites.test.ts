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
import {
  DERIVED_FILE_DIGESTS,
  DerivedFileRefused,
  developerReferenceCases,
  developmentCases,
  GENERIC_SUITES_PROCESS_LAYER,
  type GenericSuiteKey,
  genericSuite,
  HELD_OUT_IDS,
  heldOutCases,
  roundTrip
} from './generic-suites'
import { DERIVED_FILES, GENERIC_SUITE_IDS } from './recut-generic-cases'

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const KEYS = Object.keys(GENERIC_SUITE_IDS) as GenericSuiteKey[]
const HELD_OUT_KEYS: GenericSuiteKey[] = ['developer', 'codeReviewer', 'securityReviewer', 'sourceCitation']
const heldOutApproval = (key: GenericSuiteKey) =>
  key === 'developer'
    ? DERIVED_FILE_DIGESTS.developer.heldOut
    : key === 'sourceCitation'
      ? DERIVED_FILE_DIGESTS.sourceCitation.heldOut
      : DERIVED_FILE_DIGESTS.reviewer.heldOut

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
      [DERIVED_FILES.sourceCitation.heldOut, DERIVED_FILE_DIGESTS.sourceCitation.heldOut]
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
    expect(counts).toEqual({ developer: 28, codeReviewer: 6, securityReviewer: 6, sourceCitation: 7 })
  })

  it('derives a change case per developer case, a review case per reviewer case and an answer case per citation case', () => {
    const kinds = Object.fromEntries(KEYS.map((key) => [key, [...new Set(developmentCases(key).map((c) => c.kind))]]))
    expect(kinds).toEqual({
      developer: ['change'],
      codeReviewer: ['review'],
      securityReviewer: ['review'],
      sourceCitation: ['answer']
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
      const result = await roundTrip(
        key,
        developmentCases(key),
        key === 'developer' ? developerReferenceCases('development') : []
      )
      expect(result.failures).toEqual([])
      expect(result.cases).toBeGreaterThan(0)
      expect(result.variants).toBeGreaterThanOrEqual(result.cases)
    })
  }

  for (const key of HELD_OUT_KEYS) {
    it(`${GENERIC_SUITE_IDS[key]}: every held-out reference passes and every applicable variant fails its grader`, async () => {
      const result = await roundTrip(
        key,
        heldOutCases(key, heldOutApproval(key)),
        key === 'developer' ? developerReferenceCases('held-out') : []
      )
      // A failure names its case by id and digest and the check only, never its content.
      expect(result.failures.map((f) => `${f.id} ${f.digest} ${f.check}`)).toEqual([])
      expect(result.cases).toBe(HELD_OUT_IDS[key].length)
    })
  }
})
