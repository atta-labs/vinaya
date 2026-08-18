import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  anyGateFailed,
  buildReport,
  computeGroupA,
  type GateOutcome,
  type GateRunResult,
  replaceEvidenceBlock,
  UnresolvableMergeBaseError
} from '../src/commands/pr-report'

// Fixed inputs throughout — no real `git`/`gh` calls, no real gate suite. See
// pr-report.ts's module doc, "Recursion, and why gate running is
// injectable": this test suite runs under `bunx turbo test`, and a case here
// that let `--write` shell out to the real `check --all --diff-only` would
// couple a unit test of this command's formatting logic to the CLI's own
// build/network-dependent checks.
const FIXED_GROUP_A = {
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  numstat: '2\t1\tapps/cli/src/commands/pr-report.ts'
}

const PASSING_GATES: GateRunResult = {
  outcomes: [
    { name: 'brief-shape', status: 'pass', errors: [] },
    { name: 'doc-coverage', status: 'pass', errors: [] }
  ],
  failed: false
}

const FAILING_GATES: GateRunResult = {
  outcomes: [
    { name: 'brief-shape', status: 'pass', errors: [] },
    {
      name: 'doc-coverage',
      status: 'fail',
      errors: [{ severity: 'error', message: 'C5: apps/cli/src/foo.ts touches a bound doc' }]
    }
  ],
  failed: true
}

describe('buildReport', () => {
  it('emits Group A and Group B as distinguishable, anchor-wrapped sections', async () => {
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES })
    expect(result.block).toStartWith('<!-- AEG:EVIDENCE:START -->')
    expect(result.block).toEndWith('<!-- AEG:EVIDENCE:END -->')
    expect(result.block).toContain('### Group A — recomputable')
    expect(result.block).toContain('### Group B — attested')
    expect(result.block).toContain(`Head: ${FIXED_GROUP_A.head}`)
    expect(result.block).toContain(FIXED_GROUP_A.numstat)
    expect(result.block).toContain('brief-shape: pass')
    expect(result.block).toContain('doc-coverage: pass')
  })

  it("Group A's command line names the REAL resolved base and head, not a hardcoded origin/main label", async () => {
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES })
    expect(result.block).toContain(`git diff ${FIXED_GROUP_A.base}...${FIXED_GROUP_A.head} --numstat`)
    // The old hardcoded label would lie on the `main`/BASE_SHA fallback path — must be gone.
    expect(result.block).not.toContain('$(git merge-base origin/main HEAD)')
  })

  it('every line is transcribed command output — no summary/count/rewrite of the gate result', async () => {
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => FAILING_GATES })
    // The exact error message string survives verbatim, not a paraphrase or count.
    expect(result.block).toContain('C5: apps/cli/src/foo.ts touches a bound doc')
    expect(result.block).not.toMatch(/\d+ (pass|fail)(ed|ing)?\b/i)
  })

  it('gatesFailed is true when any gate outcome is fail/error/timeout', async () => {
    const passing = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES })
    const failing = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => FAILING_GATES })
    expect(passing.gatesFailed).toBe(false)
    expect(failing.gatesFailed).toBe(true)
  })

  it('is byte-identical across two runs at the same inputs, regardless of outcome array order', async () => {
    const shuffled: GateRunResult = { outcomes: [...PASSING_GATES.outcomes].reverse(), failed: false }
    const first = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES })
    const second = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => shuffled })
    expect(first.block).toBe(second.block)
  })

  it('carries no free-text field — every emitted field traces to a group', async () => {
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES })
    // Only the two labelled sections and the Head line — no Summary/Notes/etc.
    const headings = [...result.blockInner.matchAll(/^###.*$/gm)].map((m) => m[0])
    expect(headings).toEqual(['### Group A — recomputable', '### Group B — attested'])
  })
})

describe('anyGateFailed — the fail/error/timeout computation, tested directly (mutation-survivor fix)', () => {
  // Direct tests, not routed through `buildReport`'s injected `{ failed }`
  // fixtures: those only prove pass-through, never re-derive this
  // computation, which is exactly how the original test suite stayed green
  // with `FAILING_STATUSES` narrowed to `['fail']` alone (review finding).
  const outcome = (status: string): GateOutcome => ({ name: 'x', status, errors: [] })

  it('false when every outcome is pass or skipped', () => {
    expect(anyGateFailed([outcome('pass'), outcome('skipped')])).toBe(false)
  })

  it('true when any outcome is "fail"', () => {
    expect(anyGateFailed([outcome('pass'), outcome('fail')])).toBe(true)
  })

  it('true when any outcome is "error"', () => {
    expect(anyGateFailed([outcome('pass'), outcome('error')])).toBe(true)
  })

  it('true when any outcome is "timeout"', () => {
    expect(anyGateFailed([outcome('pass'), outcome('timeout')])).toBe(true)
  })

  it('false for an empty outcome list', () => {
    expect(anyGateFailed([])).toBe(false)
  })
})

describe('computeGroupA — real git, no origin/main fallback (found live, own dogfood run)', () => {
  // A bare local fixture with NO `origin` remote at all — several existing
  // apps/cli fixtures are exactly this shape, and running this command
  // inside one is exactly how the bug below was found: `git merge-base
  // origin/main HEAD` fails outright, and the ORIGINAL code silently
  // swallowed that to an empty base, producing a Group A that claimed no
  // diff existed even though the fixture carried a real one.
  function initFixtureWithFeatureBranch(baseBranch: string): string {
    const root = mkdtempSync(join(tmpdir(), 'pr-report-groupa-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git(['init', '-q', '-b', baseBranch])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(root, 'a.txt'), 'hello\n')
    git(['add', 'a.txt'])
    git(['commit', '-q', '-m', 'Chore: initial'])
    git(['checkout', '-qb', 'feature/x'])
    writeFileSync(join(root, 'a.txt'), 'hello\nworld\n')
    git(['commit', '-aq', '-m', 'Feat: add a line'])
    return root
  }

  function withFixtureCwd<T>(root: string, fn: () => T): T {
    const originalCwd = process.cwd()
    try {
      process.chdir(root)
      return fn()
    } finally {
      process.chdir(originalCwd)
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('resolves a real, non-empty diff via the `main` fallback when `origin/main` does not exist', () => {
    const root = initFixtureWithFeatureBranch('main')
    withFixtureCwd(root, () => {
      const groupA = computeGroupA()
      expect(groupA.base).not.toBe('')
      expect(groupA.numstat).toContain('a.txt')
    })
  })

  it('refuses (UnresolvableMergeBaseError) rather than writing an empty diff when the default branch is `master` — neither `origin/main` nor `main` resolves', () => {
    const root = initFixtureWithFeatureBranch('master')
    withFixtureCwd(root, () => {
      expect(() => computeGroupA()).toThrow(UnresolvableMergeBaseError)
      try {
        computeGroupA()
      } catch (err) {
        expect(err).toBeInstanceOf(UnresolvableMergeBaseError)
        const e = err as UnresolvableMergeBaseError
        expect(e.triedRefs).toEqual(['origin/main', 'main'])
        expect(e.message).toContain('origin/main')
        expect(e.message).toContain('main')
      }
    })
  })

  it('BASE_SHA overrides the primary resolution attempt (escape hatch for a non-main default branch)', () => {
    const root = initFixtureWithFeatureBranch('master')
    const originalBaseSha = process.env.BASE_SHA
    withFixtureCwd(root, () => {
      process.env.BASE_SHA = 'master'
      try {
        const groupA = computeGroupA()
        expect(groupA.base).not.toBe('')
        expect(groupA.numstat).toContain('a.txt')
      } finally {
        if (originalBaseSha === undefined) delete process.env.BASE_SHA
        else process.env.BASE_SHA = originalBaseSha
      }
    })
  })
})

describe('replaceEvidenceBlock', () => {
  it('replaces content between existing anchors in place, leaving the rest of the body untouched', () => {
    const body = [
      '## Summary',
      '',
      'why this shape.',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      'stale content',
      '<!-- AEG:EVIDENCE:END -->',
      '',
      '## Scope'
    ].join('\n')
    const updated = replaceEvidenceBlock(body, 'Head: deadbeef')
    expect(updated).toContain('## Summary')
    expect(updated).toContain('## Scope')
    expect(updated).not.toContain('stale content')
    expect(updated).toContain('Head: deadbeef')
  })

  it('appends a fresh anchored pair when the body carries none yet', () => {
    const updated = replaceEvidenceBlock('## Summary\n\nwhy.', 'Head: deadbeef')
    expect(updated).toContain('<!-- AEG:EVIDENCE:START -->')
    expect(updated).toContain('<!-- AEG:EVIDENCE:END -->')
    expect(updated).toContain('Head: deadbeef')
  })

  it('ignores a fenced decoy anchor pair and replaces the real, non-fenced one — regression, found live in this task’s own PR body', () => {
    // A body that quotes a worked example of its own anchor (exactly what
    // this command's Test Plan evidence does) must not have its
    // replacement written into the quoted example.
    const body = [
      '## Test plan',
      '',
      '- [x] example output:',
      '',
      '  ```',
      '  <!-- AEG:EVIDENCE:START -->',
      '  decoy — quoted example, not the real field',
      '  <!-- AEG:EVIDENCE:END -->',
      '  ```',
      '',
      '## Evidence',
      '',
      '<!-- AEG:EVIDENCE:START -->',
      'stale content',
      '<!-- AEG:EVIDENCE:END -->',
      '',
      '## Scope'
    ].join('\n')
    const updated = replaceEvidenceBlock(body, 'Head: deadbeef')
    expect(updated).toContain('decoy — quoted example, not the real field')
    expect(updated).not.toContain('stale content')
    expect(updated).toContain('## Scope')
    // Exactly one real (unfenced) Head line — the decoy is untouched, not duplicated.
    const realHeadLines = updated.split('\n').filter((line) => line.trim() === 'Head: deadbeef')
    expect(realHeadLines).toHaveLength(1)
  })
})
