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

describe('the Summary line is verified, not attested', () => {
  const HEAD = 'a'.repeat(40)
  const NUMSTAT = '10\t0\ta.ts\n2\t1\tb.ts'
  const block = (summary: string | null) =>
    [`Head: ${HEAD}`, ...(summary === null ? [] : [`Summary: ${summary}`]), '', '```', NUMSTAT, '```'].join('\n')

  it('passes when the summary agrees with the numstat', () => {
    const r = compareEvidenceBlock(block('2 files changed, 12 insertions(+), 1 deletion(-)'), HEAD, NUMSTAT)
    expect(r.status).toBe('pass')
  })

  it('fails a summary that overstates the change', () => {
    const r = compareEvidenceBlock(block('9 files changed, 900 insertions(+), 0 deletions(-)'), HEAD, NUMSTAT)
    expect(r.status).toBe('fail')
    if (r.status === 'fail') expect(r.errors.join('\n')).toContain('`Summary:` line does not match')
  })

  // A body written before the emitter produced this line is still valid.
  it('accepts a block with no summary at all', () => {
    expect(compareEvidenceBlock(block(null), HEAD, NUMSTAT).status).toBe('pass')
  })
})

describe('the exempt Summary line is the compared Summary line', () => {
  const HEAD = 'a'.repeat(40)
  const NUMSTAT = '1\t0\ta.ts'
  const HONEST = 'Summary: 1 file changed, 1 insertion(+), 0 deletions(-)'
  const FAKE = 'Summary: 900 files changed, 5000 insertions(+), 0 deletions(-)'

  /**
   * The bypass this closes: `body-bare-digits` blanks fenced and `<details>`
   * content before it looks for the summary, so a `Summary:` inside the Group B
   * fence is invisible to it and the next one — in prose — is the line it
   * exempts. While this side matched the raw region, the two disagreed about
   * which line came first: the fenced one was verified and the fabricated one
   * was exempted, scoring zero violations AND a passing evidence-fresh.
   */
  it('ignores a Summary line inside a fence, so a fabricated one below it is compared', () => {
    const region = [`Head: ${HEAD}`, '', '```', NUMSTAT, '```', '', '```', HONEST, '```', '', FAKE].join('\n')
    const r = compareEvidenceBlock(region, HEAD, NUMSTAT)
    expect(r.status).toBe('fail')
    if (r.status === 'fail') expect(r.errors.join('\n')).toContain('`Summary:` line does not match')
  })

  // Every spelling of "hidden from the digit check": a local
  // re-implementation closed backticks and `<details>` and still left tilde
  // fences and indented fences open. Sharing `maskCode` closes the class.
  it.each([
    ['backtick fence', ['```', HONEST, '```']],
    ['tilde fence', ['~~~', HONEST, '~~~']],
    ['three-space-indented fence', ['   ```', HONEST, '   ```']],
    ['details span', ['<details>', HONEST, '</details>']]
  ])('ignores a Summary hidden by a %s, so the fabricated one below is compared', (_label, decoy) => {
    const region = [`Head: ${HEAD}`, '', '```', NUMSTAT, '```', '', ...decoy, '', FAKE].join('\n')
    expect(compareEvidenceBlock(region, HEAD, NUMSTAT).status).toBe('fail')
  })

  it('ignores a Summary line inside a <details> span for the same reason', () => {
    const region = [`Head: ${HEAD}`, '', '```', NUMSTAT, '```', '', '<details>', HONEST, '</details>', '', FAKE].join(
      '\n'
    )
    expect(compareEvidenceBlock(region, HEAD, NUMSTAT).status).toBe('fail')
  })

  it('still accepts the emitted shape, where Summary precedes every fence', () => {
    const region = [`Head: ${HEAD}`, HONEST, '', '```', NUMSTAT, '```'].join('\n')
    expect(compareEvidenceBlock(region, HEAD, NUMSTAT).status).toBe('pass')
  })

  it('treats a block whose only Summary is fenced as having none', () => {
    const region = [`Head: ${HEAD}`, '', '```', NUMSTAT, '```', '', '```', FAKE, '```'].join('\n')
    expect(compareEvidenceBlock(region, HEAD, NUMSTAT).status).toBe('pass')
  })
})

describe('the masked region comes from the masked body, not from masking the region', () => {
  const HEAD = 'a'.repeat(40)
  const NUMSTAT = '1\t0\ta.ts'
  const HONEST = 'Summary: 1 file changed, 1 insertion(+), 0 deletions(-)'
  const FAKE = 'Summary: 900 files changed, 12000 insertions(+), 3 deletions(-)'

  /**
   * Masking is context-sensitive: a `<details>` pair whose tags sit OUTSIDE the
   * region is invisible when the region is masked alone, while the other side —
   * which masks the whole body and slices — sees the region blanked entirely.
   * The honest line was read here and the fabricated one was exempt there.
   */
  it('uses a caller-supplied masked region when the enclosing context is masked', () => {
    const region = [`Head: ${HEAD}`, HONEST, FAKE, '', '```', NUMSTAT, '```'].join('\n')
    const maskedRegion = region
      .split('\n')
      .map((l) => ' '.repeat(l.length))
      .join('\n')
    // Every line blanked: no Summary survives, so there is nothing to compare
    // and the block is not silently blessed on the strength of a hidden line.
    expect(compareEvidenceBlock(region, HEAD, NUMSTAT, maskedRegion).status).toBe('pass')
  })

  it('compares the raw text of whichever line the mask leaves standing', () => {
    const region = [`Head: ${HEAD}`, FAKE, '', '```', NUMSTAT, '```'].join('\n')
    const r = compareEvidenceBlock(region, HEAD, NUMSTAT, region)
    expect(r.status).toBe('fail')
    if (r.status === 'fail') expect(r.errors.join('\n')).toContain('900 files changed')
  })

  it('falls back to masking the region when no masked region is supplied', () => {
    const region = [`Head: ${HEAD}`, HONEST, '', '```', NUMSTAT, '```'].join('\n')
    expect(compareEvidenceBlock(region, HEAD, NUMSTAT).status).toBe('pass')
  })
})
