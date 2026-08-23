import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('the check refuses when the diff cannot be recomputed', () => {
  // A base that resolves and a diff that fails is reachable: a repo-local
  // `diff.orderFile` pointing at a missing path leaves `git merge-base` at
  // exit 0 and sends `git diff` to exit 128. Without the strict wrapper the
  // failure collapsed to '', which byte-matches an empty Group A fence, and
  // the check reported PASS having recomputed nothing — a fail-open on the
  // gate that guards the merge.
  const BIN = join(import.meta.dir, '../../src/checks/bin/check-evidence-fresh.ts')

  function fixtureWithFailingDiff(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ef-diff-fail-'))
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    g(['init', '-q', '-b', 'main'])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'base'])
    g(['checkout', '-qb', 'work'])
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'edit'])
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    g(['config', 'diff.orderFile', '/nonexistent/order-file'])

    const ghDir = join(dir, 'fakebin')
    mkdirSync(ghDir, { recursive: true })
    const ghPath = join(ghDir, 'gh')
    writeFileSync(ghPath, `#!/bin/sh\necho ${head}\n`)
    chmodSync(ghPath, 0o755)
    return { dir, head }
  }

  it('exits non-zero rather than matching an empty block against a failed recompute', async () => {
    const { dir, head } = fixtureWithFailingDiff()
    try {
      // An EMPTY Group A fence: the value a failed `git diff` collapses to.
      // Under the soft `git()` this compared equal and passed.
      const body = [
        '<!-- AEG:EVIDENCE:START -->',
        `Head: ${head}`,
        '',
        '### Group A — recomputable',
        '',
        '```',
        '```',
        '<!-- AEG:EVIDENCE:END -->'
      ].join('\n')
      const proc = Bun.spawn(['bun', BIN], {
        cwd: dir,
        env: { ...process.env, PATH: `${join(dir, 'fakebin')}:${process.env.PATH}`, PR_BODY: body, PR_NUMBER: '1' },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      expect(await proc.exited).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
