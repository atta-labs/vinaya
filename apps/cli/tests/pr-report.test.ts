import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTokenReportEntries, sumLedger } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import {
  anyGateFailed,
  buildReport,
  collectTokensAddition,
  composeWrittenBody,
  computeGroupA,
  type GateOutcome,
  type GateRunResult,
  GitCommandError,
  replaceEvidenceBlock,
  UnresolvableMergeBaseError,
  writeTokensBlock
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

describe('computeGroupA refuses rather than degrading', () => {
  // An unresolvable merge-base throws. The same collapse can survive behind
  // the other two git calls: `git()` returns '' for a FAILED command
  // and for one that legitimately printed nothing, so a failure produced the
  // exact bytes a genuinely empty diff produces — and the check, recomputing
  // the same way, compared '' to '' and passed having verified nothing.

  it('throws on an unborn branch instead of emitting an empty head and diff', () => {
    // No commits yet, so `git rev-parse HEAD` exits non-zero. This previously
    // short-circuited BOTH ternaries in computeGroupA, so resolveMergeBase was
    // never reached and nothing refused.
    const dir = mkdtempSync(join(tmpdir(), 'c126-unborn-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
      const cwd = process.cwd()
      process.chdir(dir)
      try {
        expect(() => computeGroupA()).toThrow(GitCommandError)
      } finally {
        process.chdir(cwd)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a genuinely empty diff is still a normal, non-throwing answer', () => {
    // The distinction the fix rests on: empty OUTPUT is a real verified
    // answer; a failed COMMAND is not. Only the latter throws.
    const dir = mkdtempSync(join(tmpdir(), 'c126-empty-'))
    try {
      const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
      g(['init', '-q', '-b', 'main'])
      g(['config', 'user.email', 't@example.com'])
      g(['config', 'user.name', 'test'])
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      g(['add', '-A'])
      g(['commit', '-qm', 'base'])
      const cwd = process.cwd()
      process.chdir(dir)
      try {
        const result = computeGroupA()
        expect(result.numstat).toBe('')
        expect(result.head).not.toBe('')
        expect(result.base).not.toBe('')
      } finally {
        process.chdir(cwd)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('writeTokensBlock', () => {
  const ROW_1 = '| 3: develop | Developer | claude-sonnet-5 | 100 | 50 | — | 2026-08-29 |'
  const ROW_2 = '| 3: develop | Developer | claude-sonnet-5 | 200 | 75 | — | 2026-08-30 |'

  it('sites a fresh anchored block inside an existing `## Token report` heading, replacing its placeholder content', () => {
    const body = [
      '## Summary',
      '',
      'why this shape.',
      '',
      '## Token report',
      '',
      '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
      '|---|---|---|---|---|---|---|',
      '| [task-id]: develop | Developer | [model] | [exact in] | [exact out] | [cost] | [YYYY-MM-DD] |'
    ].join('\n')
    const updated = writeTokensBlock(body, ROW_1)
    expect(updated).toContain('## Summary')
    expect(updated).toContain('<!-- AEG:TOKENS:START -->')
    expect(updated).toContain('<!-- AEG:TOKENS:END -->')
    expect(updated).toContain(ROW_1)
    expect(updated).not.toContain('[task-id]: develop')
  })

  it('creates a fresh `## Token report` heading and block when the body carries no heading at all', () => {
    const updated = writeTokensBlock('## Summary\n\nwhy.', ROW_1)
    expect(updated).toContain('## Summary')
    expect(updated).toContain('## Token report')
    expect(updated).toContain('<!-- AEG:TOKENS:START -->')
    expect(updated).toContain(ROW_1)
  })

  it('appends a second row on re-entry, leaving the first row unmodified — never a sum, never an overwrite', () => {
    const first = writeTokensBlock('## Summary\n\nwhy.', ROW_1)
    const second = writeTokensBlock(first, ROW_2)
    expect(second).toContain(ROW_1)
    expect(second).toContain(ROW_2)
    // Exactly one anchor pair — the append lands INSIDE the existing block, never a second block.
    expect(second.match(/<!-- AEG:TOKENS:START -->/g)).toHaveLength(1)
    expect(second.match(/<!-- AEG:TOKENS:END -->/g)).toHaveLength(1)
    // Row 1 precedes row 2 — a real append, not a prepend or a reorder.
    expect(second.indexOf(ROW_1)).toBeLessThan(second.indexOf(ROW_2))
  })

  it('ignores a fenced decoy AEG:TOKENS pair pasted as Test Plan evidence when locating the real block to append into', () => {
    const body = [
      '## Test plan',
      '',
      '- [x] example output:',
      '',
      '  ```',
      '  <!-- AEG:TOKENS:START -->',
      '  | decoy | pasted | as | evidence | — | — | — |',
      '  <!-- AEG:TOKENS:END -->',
      '  ```',
      '',
      '## Token report',
      '',
      '<!-- AEG:TOKENS:START -->',
      '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
      '|---|---|---|---|---|---|---|',
      ROW_1,
      '<!-- AEG:TOKENS:END -->'
    ].join('\n')
    const updated = writeTokensBlock(body, ROW_2)
    expect(updated).toContain('decoy | pasted | as | evidence')
    // The decoy is untouched — exactly two real (unfenced) START anchors would mean the
    // decoy got treated as real; there must be exactly the two literal occurrences total
    // (one decoy, one real), and ROW_2 must land next to the real block, not the decoy.
    const realBlockStart = updated.indexOf('## Token report')
    expect(updated.indexOf(ROW_2)).toBeGreaterThan(realBlockStart)
  })

  it('round-trips two appended rows through parseTokenReportEntries into two matching LedgerRows', () => {
    const first = writeTokensBlock('## Summary\n\nwhy.', ROW_1)
    const second = writeTokensBlock(first, ROW_2)
    const rows = parseTokenReportEntries(second)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ phase: '3: develop', role: 'Developer', tokensIn: 100, tokensOut: 50 })
    expect(rows[1]).toMatchObject({ phase: '3: develop', role: 'Developer', tokensIn: 200, tokensOut: 75 })
  })
})

// Task 7 (#274): the block already appends any given row without collapsing
// or merging — task 3's `writeTokensBlock` is role-agnostic by construction
// (no dedup, no lookup by role). What this proves is narrower: that a
// Developer row, a Brief Author row and a Planner row — each produced through
// the same shipped `--role`/`--phase` mechanism `pr-report.ts` already wires
// up — round-trip through `parseTokenReportEntries` into three distinct,
// correctly-attributed `LedgerRow`s, that no earlier row's bytes are touched
// by a later append, and that `sumLedger` (the read-time aggregate §12
// requires) reflects all three rather than the last-written one.
describe('AEG:TOKENS carries distinct rows per role (task 7, #274)', () => {
  const DEV_ROW = '| 7: develop | Developer | claude-sonnet-5 | 6050 | 200 | — | 2026-09-01 |'
  const BRIEF_AUTHOR_ROW = '| 7: brief | Brief Author | claude-sonnet-5 | 1210 | 80 | — | 2026-09-01 |'
  const PLANNER_ROW = '| 7: plan | Planner | claude-sonnet-5 | 2720 | 150 | — | 2026-09-01 |'

  it('appends a Brief Author row then a Planner row onto an existing Developer row without collapsing any of the three', () => {
    const withDev = writeTokensBlock('## Summary\n\nwhy.', DEV_ROW)
    const withBriefAuthor = writeTokensBlock(withDev, BRIEF_AUTHOR_ROW)
    const final = writeTokensBlock(withBriefAuthor, PLANNER_ROW)

    expect(final).toContain(DEV_ROW)
    expect(final).toContain(BRIEF_AUTHOR_ROW)
    expect(final).toContain(PLANNER_ROW)
    // Exactly one anchor pair throughout — three rows inside one block, never three blocks.
    expect(final.match(/<!-- AEG:TOKENS:START -->/g)).toHaveLength(1)
    expect(final.match(/<!-- AEG:TOKENS:END -->/g)).toHaveLength(1)
    // Append order preserved.
    expect(final.indexOf(DEV_ROW)).toBeLessThan(final.indexOf(BRIEF_AUTHOR_ROW))
    expect(final.indexOf(BRIEF_AUTHOR_ROW)).toBeLessThan(final.indexOf(PLANNER_ROW))

    const rows = parseTokenReportEntries(final)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ phase: '7: develop', role: 'Developer', tokensIn: 6050, tokensOut: 200 })
    expect(rows[1]).toMatchObject({ phase: '7: brief', role: 'Brief Author', tokensIn: 1210, tokensOut: 80 })
    expect(rows[2]).toMatchObject({ phase: '7: plan', role: 'Planner', tokensIn: 2720, tokensOut: 150 })
  })

  it('leaves each prior row byte-for-byte untouched as later rows are appended', () => {
    const withDev = writeTokensBlock('## Summary\n\nwhy.', DEV_ROW)
    const withBriefAuthor = writeTokensBlock(withDev, BRIEF_AUTHOR_ROW)
    const final = writeTokensBlock(withBriefAuthor, PLANNER_ROW)

    // The Developer row's own line is identical across all three bodies.
    const devLine = (body: string) => body.split('\n').find((l) => l.includes('Developer'))
    expect(devLine(withDev)).toBe(devLine(withBriefAuthor))
    expect(devLine(withBriefAuthor)).toBe(devLine(final))

    // The Brief Author row's own line is identical before and after the Planner append.
    const briefAuthorLine = (body: string) => body.split('\n').find((l) => l.includes('Brief Author'))
    expect(briefAuthorLine(withBriefAuthor)).toBe(briefAuthorLine(final))
  })

  it('sums all three rows at read time — never fewer, never the last row alone', () => {
    const withDev = writeTokensBlock('## Summary\n\nwhy.', DEV_ROW)
    const withBriefAuthor = writeTokensBlock(withDev, BRIEF_AUTHOR_ROW)
    const final = writeTokensBlock(withBriefAuthor, PLANNER_ROW)

    const totals = sumLedger(parseTokenReportEntries(final))
    expect(totals).toMatchObject({ tokensIn: 6050 + 1210 + 2720, tokensOut: 200 + 80 + 150, rows: 3 })
  })
})

describe('collectTokensAddition', () => {
  it('renders real figures from a resolvable transcript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-tokens-'))
    const transcriptPath = join(dir, 'transcript.jsonl')
    try {
      const line = (id: string, out: number) =>
        JSON.stringify({
          type: 'assistant',
          message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: out } }
        })
      writeFileSync(transcriptPath, `${line('m1', 50)}\n${line('m2', 25)}\n`)
      const addition = collectTokensAddition({
        phase: '3: develop',
        role: 'Developer',
        date: '2026-08-29',
        transcriptPath
      })
      expect(addition).toEqual({
        collected: true,
        row: '| 3: develop | Developer | claude-sonnet-5 | 200 | 75 | — | 2026-08-29 |'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never fabricates a `0/0/—` row for an unresolvable transcript — `—` cells plus the probe reason inline, one line only', () => {
    const addition = collectTokensAddition({
      phase: '3: develop',
      role: 'Developer',
      date: '2026-08-29',
      transcriptPath: '/nonexistent/path/does/not/exist.jsonl'
    })
    expect(addition.collected).toBe(true)
    const row = addition.collected ? addition.row : ''
    expect(row.split('\n')).toHaveLength(1)
    expect(row).toContain('transcript-unreadable')
    expect(row).toBe('| 3: develop | Developer | — (transcript-unreadable) | — | — | — | 2026-08-29 |')
    expect(row).not.toMatch(/\|\s*0\s*\|\s*0\s*\|/)
  })

  it('still renders the inline-reason row for a corroborated but empty transcript — `transcript-empty` is unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-tokens-empty-'))
    const transcriptPath = join(dir, 'transcript.jsonl')
    try {
      writeFileSync(transcriptPath, '')
      const addition = collectTokensAddition({
        phase: '3: develop',
        role: 'Developer',
        date: '2026-08-29',
        transcriptPath
      })
      expect(addition).toEqual({
        collected: true,
        row: '| 3: develop | Developer | — (transcript-empty) | — | — | — | 2026-08-29 |'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Issue #365. `no-transcript-resolved` means this session resolved no
 * transcript of its own — no pointer file, or one it cannot corroborate. It
 * does NOT mean the host cannot meter, which is the only case
 * `aeg-root/roles/developer.md` sanctions a blank token cell for. The
 * emitter must therefore withhold the row rather than assert that fact, while
 * still writing the Evidence block: `developer.md` makes this command's exit
 * code the Developer's pre-open verification run, so an abort-before-write
 * would leave every unwired host unable to populate Evidence at all.
 *
 * The unwired state is produced by pointing `TMPDIR`/`CLAUDE_PROJECT_DIR` at
 * a fresh empty directory (no pointer file can exist there) and clearing
 * `CLAUDE_CODE_SESSION_ID` — `hardenedMeteringDeps` reads `process.env` live,
 * and `collectTokensAddition` builds its deps per call.
 */
describe('collectTokensAddition refuses rather than claiming the host cannot meter (#365)', () => {
  function withUnwiredEnv<T>(fn: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-unwired-'))
    const saved = {
      TMPDIR: process.env.TMPDIR,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID
    }
    process.env.TMPDIR = dir
    process.env.CLAUDE_PROJECT_DIR = dir
    delete process.env.CLAUDE_CODE_SESSION_ID
    try {
      return fn()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('returns a refusal, not a row, when no transcript resolves', () => {
    const addition = withUnwiredEnv(() =>
      collectTokensAddition({ phase: '3: develop', role: 'Developer', date: '2026-08-29' })
    )
    expect(addition.collected).toBe(false)
    const refusal = addition.collected ? '' : addition.refusal
    expect(refusal).toContain('vinaya pr report: refused')
    expect(refusal).toContain('no-transcript-resolved')
    // Both ways out are named, so the refusal is actionable rather than terminal.
    expect(refusal).toContain('--transcript')
    expect(refusal).toContain('--in <tokens-in> --out <tokens-out>')
    // The row it would have written is exactly what must not appear anywhere.
    expect(refusal).not.toContain('| — | — | — |')
  })

  // Template-shaped: an Evidence anchor pair under its own heading, the Token
  // report heading last — the body `aeg-root/templates/pr-report-template.md`
  // produces, and the shape `writeTokensBlock` sites a fresh block into.
  const TEMPLATE_BODY = [
    '## Summary',
    '',
    'why.',
    '',
    '## Evidence',
    '',
    '<!-- AEG:EVIDENCE:START -->',
    '[populated by `vinaya pr report --write`]',
    '<!-- AEG:EVIDENCE:END -->',
    '',
    '## Token report',
    ''
  ].join('\n')

  it('still writes the Evidence block when the token row is refused', () => {
    const written = composeWrittenBody(TEMPLATE_BODY, 'Head: abc', { collected: false, refusal: 'refused' })
    expect(written).toContain('<!-- AEG:EVIDENCE:START -->')
    expect(written).toContain('Head: abc')
    expect(written).not.toContain('<!-- AEG:TOKENS:START -->')
    expect(written).not.toContain('no-transcript-resolved')
  })

  it('writes both blocks when a row was collected', () => {
    const row = '| 3: develop | Developer | claude-sonnet-5 | 200 | 75 | — | 2026-08-29 |'
    const written = composeWrittenBody(TEMPLATE_BODY, 'Head: abc', { collected: true, row })
    expect(written).toContain('<!-- AEG:EVIDENCE:START -->')
    expect(written).toContain('Head: abc')
    expect(written).toContain('<!-- AEG:TOKENS:START -->')
    expect(written).toContain(row)
  })
})
