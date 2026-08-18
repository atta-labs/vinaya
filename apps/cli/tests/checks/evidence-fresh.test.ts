import { anchoredRegion } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import { compareEvidenceBlock } from '../../src/checks/evidence-fresh-logic'

const HEAD = 'a'.repeat(40)
const NUMSTAT = '2\t1\tapps/cli/src/commands/pr-report.ts\n1\t0\tapps/cli/src/index.ts'

function evidenceBody(head: string, numstat: string): string {
  return [
    '## Summary',
    '',
    'why this shape.',
    '',
    '<!-- AEG:EVIDENCE:START -->',
    `Head: ${head}`,
    '',
    '### Group A — recomputable',
    '',
    '`git diff $(git merge-base origin/main HEAD)...HEAD --numstat`',
    '',
    '```',
    numstat,
    '```',
    '',
    '### Group B — attested',
    '',
    '`vinaya check --all --diff-only`',
    '',
    '```',
    'brief-shape: pass',
    '```',
    '<!-- AEG:EVIDENCE:END -->'
  ].join('\n')
}

function regionOf(body: string): string {
  const region = anchoredRegion(body, 'EVIDENCE')
  if (region === null) throw new Error('fixture body carries no AEG:EVIDENCE block')
  return region
}

describe('compareEvidenceBlock — mutation proofs (fix/pr-report-emitter §9)', () => {
  it('(a) block matches head → pass', () => {
    const body = evidenceBody(HEAD, NUMSTAT)
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT)
    expect(result.status).toBe('pass')
  })

  it('(b) one character altered in the Group A diff stat → fail (the fabrication case)', () => {
    const mutatedNumstat = NUMSTAT.replace('2\t1\t', '9\t1\t')
    const body = evidenceBody(HEAD, mutatedNumstat)
    // Recompute is anchored on the REAL numstat — the mutated body's stored
    // text is what's under test, not what's "actually" recomputed.
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT)
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.join('\n')).toContain('Group A does not match')
  })

  it('(c) sha altered → fail, naming both', () => {
    const staleHead = 'b'.repeat(40)
    const body = evidenceBody(staleHead, NUMSTAT)
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT)
    expect(result.status).toBe('fail')
    const message = result.status === 'fail' ? result.errors.join('\n') : ''
    expect(message).toContain(staleHead)
    expect(message).toContain(HEAD)
    expect(message).toContain('Group B is stale')
  })

  it('(d) no AEG:EVIDENCE block → pass (caller bypasses before calling compareEvidenceBlock)', () => {
    const body = ['## Summary', '', 'no evidence block here.'].join('\n')
    expect(anchoredRegion(body, 'EVIDENCE')).toBeNull()
  })

  it('(e) no PR body → pass (caller bypasses before calling compareEvidenceBlock)', () => {
    expect(anchoredRegion('', 'EVIDENCE')).toBeNull()
  })

  it('a mutation that reverts the check would still be caught: an unmutated body against a DIFFERENT real numstat fails', () => {
    // Pins that this function is load-bearing, not a no-op: feeding it a
    // genuinely different actual value must fail even when the block itself
    // is well-formed and internally consistent.
    const body = evidenceBody(HEAD, NUMSTAT)
    const differentActual = '5\t5\tsome/other/file.ts'
    const result = compareEvidenceBlock(regionOf(body), HEAD, differentActual)
    expect(result.status).toBe('fail')
  })

  it('malformed block (no Head line) → fail rather than a silent pass', () => {
    const malformed = ['<!-- AEG:EVIDENCE:START -->', '```', NUMSTAT, '```', '<!-- AEG:EVIDENCE:END -->'].join('\n')
    const result = compareEvidenceBlock(regionOf(malformed), HEAD, NUMSTAT)
    expect(result.status).toBe('fail')
  })
})
