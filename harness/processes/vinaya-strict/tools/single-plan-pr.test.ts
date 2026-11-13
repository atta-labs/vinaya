import { describe, expect, it } from 'bun:test'
import { LEGACY_TRANCHES_DIR } from './legacy-paths'
import { checkSinglePlanPr, trancheSlugFromTopologyPath, touchesAnyTopology } from './single-plan-pr'

describe('trancheSlugFromTopologyPath', () => {
  it('parses the slug from an active tranche topology file', () => {
    expect(trancheSlugFromTopologyPath(`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`)).toBe('sample-tranche-v1')
  })

  it('returns null for a completed/ (archived) topology file', () => {
    expect(trancheSlugFromTopologyPath(`${LEGACY_TRANCHES_DIR}/completed/vada-production-v1.md`)).toBeNull()
  })

  it('returns null for README.md', () => {
    expect(trancheSlugFromTopologyPath('doctrine/tranche-model.md')).toBeNull()
  })

  it('returns null for a .tokens.md ledger file', () => {
    expect(trancheSlugFromTopologyPath(`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.tokens.md`)).toBeNull()
  })

  it('returns null for an unrelated file', () => {
    expect(trancheSlugFromTopologyPath('packages/core/bin/open-pr.ts')).toBeNull()
  })
})

describe('checkSinglePlanPr — single-plan-PR guard (task 19 / #336)', () => {
  it('passes trivially for an ordinary task-branch PR (no topology file touched)', () => {
    const branchFiles = ['packages/core/bin/open-pr.ts', 'packages/core/bin/open-pr.test.ts']
    const otherOpenPrs = [{ number: 100, files: [`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`] }]
    expect(checkSinglePlanPr(branchFiles, otherOpenPrs)).toEqual({ ok: true })
  })

  it('passes when two plan-branch diffs touch DIFFERENT tranches topology files', () => {
    const branchFiles = [`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`]
    const otherOpenPrs = [{ number: 200, files: [`${LEGACY_TRANCHES_DIR}/other-tranche-v1.md`] }]
    expect(checkSinglePlanPr(branchFiles, otherOpenPrs)).toEqual({ ok: true })
  })

  it('refuses when two plan-branch diffs touch the SAME tranche topology file, naming the other PR', () => {
    const branchFiles = [`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`]
    const otherOpenPrs = [{ number: 352, files: [`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`] }]
    const result = checkSinglePlanPr(branchFiles, otherOpenPrs)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('#352')
    expect(result.message).toContain('sample-tranche-v1')
  })

  it('passes when no other open PR touches any topology file at all', () => {
    const branchFiles = [`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`]
    expect(checkSinglePlanPr(branchFiles, [])).toEqual({ ok: true })
  })

  it('ignores an archived (completed/) topology file touched by another PR', () => {
    const branchFiles = [`${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`]
    const otherOpenPrs = [{ number: 300, files: [`${LEGACY_TRANCHES_DIR}/completed/sample-tranche-v1.md`] }]
    expect(checkSinglePlanPr(branchFiles, otherOpenPrs)).toEqual({ ok: true })
  })
})

describe('touchesAnyTopology', () => {
  it('is true when at least one file is an active topology file', () => {
    expect(touchesAnyTopology(['README.md', `${LEGACY_TRANCHES_DIR}/sample-tranche-v1.md`])).toBe(true)
  })

  it('is false for an ordinary task-branch diff', () => {
    expect(touchesAnyTopology(['packages/core/bin/open-pr.ts', 'packages/core/src/index.ts'])).toBe(false)
  })

  it('is false for an empty file list', () => {
    expect(touchesAnyTopology([])).toBe(false)
  })
})
