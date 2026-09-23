import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anchoredRegion } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import { EVIDENCE_PLACEHOLDER_TEXT, compareEvidenceBlock } from '../../src/checks/evidence-fresh-logic'
import { type ResolvedRegion, ScanContext, resolveAnchoredRegion } from '../../src/checks/scan-context'
import { type GroupCCommandResult, renderGroupC } from '../../src/commands/pr-report'
import { EVIDENCE_SUMMARY_PREFIX, summariseNumstat } from '../../src/lib/numstat'

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
    `${EVIDENCE_SUMMARY_PREFIX}\`${summariseNumstat(numstat)}\``,
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

/** Resolves through the real, shared path — the same one `check-evidence-fresh` uses. */
function regionOf(body: string): ResolvedRegion {
  const resolved = resolveAnchoredRegion(ScanContext.from(body), 'EVIDENCE')
  if (resolved === null) throw new Error('fixture body carries no AEG:EVIDENCE block')
  if (resolved === 'hidden') throw new Error('fixture body hides its AEG:EVIDENCE block in a <details> block')
  return resolved
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

describe('compareEvidenceBlock — the untouched placeholder (O1)', () => {
  function placeholderBody(): string {
    return [
      '## Evidence',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      EVIDENCE_PLACEHOLDER_TEXT,
      '<!-- AEG:EVIDENCE:END -->'
    ].join('\n')
  }

  it('a body whose evidence block is the untouched placeholder passes on a fresh head — no driver report has run yet', () => {
    const result = compareEvidenceBlock(regionOf(placeholderBody()), HEAD, NUMSTAT)
    expect(result.status).toBe('pass')
  })

  it('passes regardless of the supplied Group C expectation or patchIdOf — the placeholder never binds to a head at all', () => {
    let calls = 0
    const countingPatchId = () => {
      calls += 1
      return 'irrelevant'
    }
    const result = compareEvidenceBlock(regionOf(placeholderBody()), HEAD, NUMSTAT, ['some command'], countingPatchId)
    expect(result.status).toBe('pass')
    expect(calls).toBe(0)
  })

  it('a stale FILLED block still fails — the placeholder pass never masks a real, out-of-date report', () => {
    const staleHead = 'b'.repeat(40)
    const body = evidenceBody(staleHead, NUMSTAT)
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT)
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.join('\n')).toContain('Group B is stale')
  })

  it('a body carrying extra text alongside the placeholder line is NOT treated as the placeholder — still malformed, still fails', () => {
    const body = [
      '<!-- AEG:EVIDENCE:START -->',
      EVIDENCE_PLACEHOLDER_TEXT,
      'plus a hand-typed line',
      '<!-- AEG:EVIDENCE:END -->'
    ].join('\n')
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT)
    expect(result.status).toBe('fail')
  })

  // Security review, HIGH: a real, already-posted block hand-edited back to
  // the exact placeholder text must never re-exempt itself from the
  // fabrication check just by reverting to that literal string — the
  // exemption is for a genuinely fresh head, not a re-writable escape hatch.
  it('hasPriorDeveloperRound=true refuses the placeholder — a round already happened, so a real report should exist', () => {
    const result = compareEvidenceBlock(regionOf(placeholderBody()), HEAD, NUMSTAT, undefined, undefined, true)
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.join('\n')).toMatch(/already had at least one developer round/)
  })

  it('hasPriorDeveloperRound=false still passes — explicitly confirmed no round has ever happened', () => {
    const result = compareEvidenceBlock(regionOf(placeholderBody()), HEAD, NUMSTAT, undefined, undefined, false)
    expect(result.status).toBe('pass')
  })

  it('hasPriorDeveloperRound omitted (a caller with nothing to compute it from) still passes — unchanged, pure-fixture behavior', () => {
    const result = compareEvidenceBlock(regionOf(placeholderBody()), HEAD, NUMSTAT)
    expect(result.status).toBe('pass')
  })
})

describe('compareEvidenceBlock — patch-identity fallback on a stale Head (#497)', () => {
  const staleHead = 'b'.repeat(40)

  it('a stored head differing from the real head passes when both share the same patch identity — a clean rebase', () => {
    const body = evidenceBody(staleHead, NUMSTAT)
    const samePatchId = () => 'same-patch-id'
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, undefined, samePatchId)
    expect(result.status).toBe('pass')
  })

  it('a stored head differing from the real head still fails, naming both shas and stating the patch changed, when patch identities differ', () => {
    const body = evidenceBody(staleHead, NUMSTAT)
    const differentPatchId = (sha: string) => `patch-of-${sha}`
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, undefined, differentPatchId)
    expect(result.status).toBe('fail')
    const message = result.status === 'fail' ? result.errors.join('\n') : ''
    expect(message).toContain(staleHead)
    expect(message).toContain(HEAD)
    expect(message).toContain('Group B is stale')
    expect(message).toContain('the patch changed')
  })

  it('a stored head whose commit is unreachable (`patchIdOf` returns null) still fails, never treated as a match', () => {
    const body = evidenceBody(staleHead, NUMSTAT)
    const unreachablePatchId = () => null
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, undefined, unreachablePatchId)
    expect(result.status).toBe('fail')
    const message = result.status === 'fail' ? result.errors.join('\n') : ''
    expect(message).toContain('the patch changed')
  })

  it('no `patchIdOf` supplied falls back to sha equality alone, unchanged from before this task', () => {
    const body = evidenceBody(staleHead, NUMSTAT)
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT)
    expect(result.status).toBe('fail')
    const message = result.status === 'fail' ? result.errors.join('\n') : ''
    expect(message).not.toContain('the patch changed')
  })

  it('a matching head is never run through `patchIdOf` at all', () => {
    const body = evidenceBody(HEAD, NUMSTAT)
    let calls = 0
    const countingPatchId = () => {
      calls += 1
      return 'irrelevant'
    }
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, undefined, countingPatchId)
    expect(result.status).toBe('pass')
    expect(calls).toBe(0)
  })
})

function groupCResult(command: string, output: string): GroupCCommandResult {
  return { command, output, exitCode: 0, timedOut: false, overflowed: false }
}

/** A block carrying a real `renderGroupC` render — appended after Group B, exactly as `pr-report.ts` emits it. */
function evidenceBodyWithGroupC(head: string, numstat: string, commands: GroupCCommandResult[]): string {
  const withoutEnd = evidenceBody(head, numstat).replace('<!-- AEG:EVIDENCE:END -->', '')
  return [withoutEnd, '', renderGroupC({ commands }), '<!-- AEG:EVIDENCE:END -->'].join('\n')
}

describe('compareEvidenceBlock — Group C is attested, never re-run (task 12, Principal rulings PR open-1/open-2)', () => {
  it('passes when the stored heading matches — the command output is never compared', () => {
    const body = evidenceBodyWithGroupC(HEAD, NUMSTAT, [
      groupCResult('echo hi', 'whatever this printed, never compared')
    ])
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, ['echo hi'])
    expect(result.status).toBe('pass')
  })

  it("fails, naming Group C, when the stored command heading disagrees with the body's own §9 list", () => {
    const body = evidenceBodyWithGroupC(HEAD, NUMSTAT, [groupCResult('echo hi', 'hi')])
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, ['echo bye'])
    expect(result.status).toBe('fail')
    expect(result.status === 'fail' && result.errors.join('\n')).toContain("Group C's command headings")
  })

  it('fails on a stored command list shorter or longer than the expected §9 list, not just a content mismatch', () => {
    const body = evidenceBodyWithGroupC(HEAD, NUMSTAT, [groupCResult('echo hi', 'hi')])
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, ['echo hi', 'echo bye'])
    expect(result.status).toBe('fail')
  })

  it('a body with no ### Group C heading is never faulted for lacking Group C, even when the caller supplies an expected list', () => {
    const body = evidenceBody(HEAD, NUMSTAT)
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, ['echo hi'])
    expect(result.status).toBe('pass')
  })

  it("an output line shaped like a command heading (or the old '$ ' delimiter) is never mistaken for a real command boundary — the Principal ruling PR open-2 fix", () => {
    // `bun run test`'s own progress output can print a line that starts
    // with `$ ` — the exact ambiguity `open-2` closed by moving the
    // boundary off fence contents entirely. A decoy heading-shaped line in
    // the output is equally inert: only the REAL rendered heading (one per
    // `GroupCCommandResult`) is ever a boundary.
    const decoyOutput = ['$ turbo test', '#### C99: `rm -rf /`', 'real output line'].join('\n')
    const body = evidenceBodyWithGroupC(HEAD, NUMSTAT, [groupCResult('bun run test', decoyOutput)])
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, ['bun run test'])
    expect(result.status).toBe('pass')
  })

  it('a real second command is still detected as a distinct heading, never folded into the first', () => {
    const body = evidenceBodyWithGroupC(HEAD, NUMSTAT, [
      groupCResult('echo one', 'one'),
      groupCResult('echo two', 'two')
    ])
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT, ['echo one', 'echo three'])
    expect(result.status).toBe('fail')
    const message = result.status === 'fail' ? result.errors.join('\n') : ''
    expect(message).toContain('"echo one"')
    expect(message).toContain('"echo two"')
  })

  it('skips the Group C comparison entirely when the caller passes no expected list', () => {
    const body = evidenceBodyWithGroupC(HEAD, NUMSTAT, [groupCResult('echo hi', 'hi')])
    const result = compareEvidenceBlock(regionOf(body), HEAD, NUMSTAT)
    expect(result.status).toBe('pass')
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

describe('the check refuses a placeholder body once a developer round has already posted (security review, HIGH)', () => {
  const BIN = join(import.meta.dir, '../../src/checks/bin/check-evidence-fresh.ts')

  function fixtureRepo(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), 'ef-placeholder-'))
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    g(['init', '-q', '-b', 'main'])
    g(['config', 'user.email', 't@example.com'])
    g(['config', 'user.name', 'test'])
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    g(['add', '-A'])
    g(['commit', '-qm', 'base'])
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    return { dir, head }
  }

  function writeGhStub(
    dir: string,
    head: string,
    comments: Array<{ body: string; author?: { login: string } }>
  ): string {
    const ghDir = join(dir, 'fakebin')
    mkdirSync(ghDir, { recursive: true })
    const ghPath = join(ghDir, 'gh')
    writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$5" = "headRefOid,baseRefName" ]; then
  echo '{"headRefOid":"${head}","baseRefName":"main"}'
  exit 0
fi
if [ "$5" = "comments" ]; then
  echo '${JSON.stringify({ comments })}'
  exit 0
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
    )
    chmodSync(ghPath, 0o755)
    return ghDir
  }

  function placeholderBody(): string {
    return ['<!-- AEG:EVIDENCE:START -->', EVIDENCE_PLACEHOLDER_TEXT, '<!-- AEG:EVIDENCE:END -->'].join('\n')
  }

  it('no developer-round comment exists yet — the placeholder passes (a genuinely fresh PR)', async () => {
    const { dir, head } = fixtureRepo()
    try {
      const ghDir = writeGhStub(dir, head, [])
      const proc = Bun.spawn(['bun', BIN], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${ghDir}:${process.env.PATH}`,
          BASE_SHA: 'main',
          PR_BODY: placeholderBody(),
          PR_NUMBER: '1'
        },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      expect(await proc.exited).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a developer-round comment from the allowlisted principal already exists — the placeholder is refused, never a silent pass', async () => {
    const { dir, head } = fixtureRepo()
    try {
      const ghDir = writeGhStub(dir, head, [
        { body: '<!-- aeg:developer:round-1 --> Head: deadbeef', author: { login: 'daniboomerang' } }
      ])
      const proc = Bun.spawn(['bun', BIN], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${ghDir}:${process.env.PATH}`,
          BASE_SHA: 'main',
          PR_BODY: placeholderBody(),
          PR_NUMBER: '1'
        },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      expect(exitCode).not.toBe(0)
      expect(stderr).toMatch(/already had at least one developer round/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The marker's mere TEXT is no longer a trustworthy signal either way —
  // only a comment authored by an allowlisted principal counts.
  it('a marker-shaped comment from an unlisted account is no signal — the placeholder still passes (LOW: forged-marker griefing closed)', async () => {
    const { dir, head } = fixtureRepo()
    try {
      const ghDir = writeGhStub(dir, head, [
        { body: '<!-- aeg:developer:round-1 --> Head: deadbeef', author: { login: 'random-commenter' } }
      ])
      const proc = Bun.spawn(['bun', BIN], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${ghDir}:${process.env.PATH}`,
          BASE_SHA: 'main',
          PR_BODY: placeholderBody(),
          PR_NUMBER: '1'
        },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      expect(await proc.exited).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A comment with no `author` at all (the shape a deleted-and-never-
  // recreated marker leaves nothing to find) is exactly as much "no signal"
  // as one from an untrusted account — never treated as if a principal had
  // posted it.
  it('a marker-shaped comment with no author at all is no signal — the placeholder still passes', async () => {
    const { dir, head } = fixtureRepo()
    try {
      const ghDir = writeGhStub(dir, head, [{ body: '<!-- aeg:developer:round-1 --> Head: deadbeef' }])
      const proc = Bun.spawn(['bun', BIN], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${ghDir}:${process.env.PATH}`,
          BASE_SHA: 'main',
          PR_BODY: placeholderBody(),
          PR_NUMBER: '1'
        },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      expect(await proc.exited).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
