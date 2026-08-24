import { describe, expect, it } from 'bun:test'
import { classifyBranchProtectionError } from '../src/lib/detect.js'

// `gh api repos/<owner>/<repo>/branches/main/protection` exits non-zero for
// three genuinely different reasons — only two of them are KNOWN, real
// answers (unprotected / plan-required); everything else is truly unknown.
// Pulled into its own pure function (`lib/detect.ts`) specifically so this is
// testable without shelling out to a real `gh` — see that file's doc comment
// for the live incident this fixes (a private repo without a paid GitHub
// plan reported "could not be determined" in the same doctor run that had
// just reported gh as authenticated and the remote as present).
describe('classifyBranchProtectionError', () => {
  it('classifies a 404 as unprotected (false) — a real, known answer', () => {
    expect(classifyBranchProtectionError('gh: Branch not protected (HTTP 404)')).toBe(false)
  })

  it('classifies the GitHub-Pro-required 403 as plan-required, not the generic unknown', () => {
    const stderr = 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'
    expect(classifyBranchProtectionError(stderr)).toBe('plan-required')
  })

  it('recognizes the alternate GitHub phrasing (make this repository public)', () => {
    const stderr = 'gh: Upgrade to a paid plan or make this repository public to use this endpoint. (HTTP 403)'
    expect(classifyBranchProtectionError(stderr)).toBe('plan-required')
  })

  it('does not widen the 403 branch to swallow a real permission failure (stays unknown, not "unprotected"\'s sibling)', () => {
    expect(classifyBranchProtectionError('gh: Resource not accessible by integration (HTTP 403)')).toBeNull()
  })

  it('classifies an unrelated auth/network failure as unknown (null)', () => {
    expect(classifyBranchProtectionError('gh: authentication required')).toBeNull()
  })

  it('classifies empty stderr as unknown (null)', () => {
    expect(classifyBranchProtectionError('')).toBeNull()
  })
})
