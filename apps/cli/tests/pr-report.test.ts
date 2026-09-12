import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTokenReportEntries, resolveMeteringCapability, sumLedger } from '@attalabs/aeg-core'
import { describe, expect, it } from 'bun:test'
import {
  agentCommandText,
  anyGateFailed,
  bodiesAgreeOutsideRegions,
  buildReport,
  collectTokensAddition,
  composeWrittenBody,
  computeGroupA,
  computeGroupC,
  DEFAULT_COMMAND_TIMEOUT_MS,
  extractAgentCommandLines,
  type GateOutcome,
  type GateRunner,
  type GateRunResult,
  GitCommandError,
  groupCFailed,
  MissingEvidenceAnchorError,
  prReportCommand,
  prReportExitCode,
  replaceEvidenceBlock,
  resolveCommandTimeoutMs,
  runAgentCommand,
  spliceIntoLiveBody,
  UnresolvableMergeBaseError,
  writeTokensBlock
} from '../src/commands/pr-report'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

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
    // Non-empty body: a `pr-report-density`/`doc-coverage`-shaped pass on an
    // EMPTY body renders `skipped` (O3, see the dedicated describe block
    // below) — this test is about section shape, not that distinction, so it
    // uses a real body like any actual invocation would carry.
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      body: 'a real PR body'
    })
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
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES, body: '' })
    expect(result.block).toContain(`git diff ${FIXED_GROUP_A.base}...${FIXED_GROUP_A.head} --numstat`)
    // The old hardcoded label would lie on the `main`/BASE_SHA fallback path — must be gone.
    expect(result.block).not.toContain('$(git merge-base origin/main HEAD)')
  })

  it('every line is transcribed command output — no summary/count/rewrite of the gate result', async () => {
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => FAILING_GATES, body: '' })
    // The exact error message string survives verbatim, not a paraphrase or count.
    expect(result.block).toContain('C5: apps/cli/src/foo.ts touches a bound doc')
    expect(result.block).not.toMatch(/\d+ (pass|fail)(ed|ing)?\b/i)
  })

  it('gatesFailed is true when any gate outcome is fail/error/timeout', async () => {
    const passing = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES, body: '' })
    const failing = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => FAILING_GATES, body: '' })
    expect(passing.gatesFailed).toBe(false)
    expect(failing.gatesFailed).toBe(true)
  })

  it('is byte-identical across two runs at the same inputs, regardless of outcome array order', async () => {
    const shuffled: GateRunResult = { outcomes: [...PASSING_GATES.outcomes].reverse(), failed: false }
    const first = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES, body: '' })
    const second = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => shuffled, body: '' })
    expect(first.block).toBe(second.block)
  })

  it('carries no free-text field — every emitted field traces to a group', async () => {
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES, body: '' })
    // Only the three labelled sections and the Head line — no Summary/Notes/etc.
    const headings = [...result.blockInner.matchAll(/^###.*$/gm)].map((m) => m[0])
    expect(headings).toEqual([
      '### Group A — recomputable',
      '### Group B — attested',
      '### Group C — Test Plan commands'
    ])
  })

  it('excludes evidence-fresh from Group B entirely — grading the block this run is about to replace reads as a live red it is not (O6, misread on PR #409)', async () => {
    const staleEvidenceFresh: GateRunResult = {
      outcomes: [
        { name: 'brief-shape', status: 'pass', errors: [] },
        {
          name: 'evidence-fresh',
          status: 'fail',
          errors: [{ severity: 'error', message: 'the AEG:EVIDENCE block is malformed' }]
        }
      ],
      failed: true
    }
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => staleEvidenceFresh, body: '' })
    expect(result.block).not.toContain('evidence-fresh')
    expect(result.gateOutcomes.map((o) => o.name)).not.toContain('evidence-fresh')
  })

  it('a stale evidence-fresh: fail is never counted toward gatesFailed on its own — a genuinely clean run stays clean', async () => {
    const onlyEvidenceFreshFails: GateRunResult = {
      outcomes: [
        { name: 'brief-shape', status: 'pass', errors: [] },
        { name: 'evidence-fresh', status: 'fail', errors: [{ severity: 'error', message: 'stale block' }] }
      ],
      failed: true
    }
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => onlyEvidenceFreshFails, body: '' })
    expect(result.gatesFailed).toBe(false)
  })

  it('a REAL failure alongside a stale evidence-fresh still fails — exclusion is scoped to evidence-fresh only', async () => {
    const both: GateRunResult = {
      outcomes: [
        {
          name: 'doc-coverage',
          status: 'fail',
          errors: [{ severity: 'error', message: 'C5: apps/cli/src/foo.ts touches a bound doc' }]
        },
        { name: 'evidence-fresh', status: 'fail', errors: [{ severity: 'error', message: 'stale block' }] }
      ],
      failed: true
    }
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => both, body: '' })
    expect(result.gatesFailed).toBe(true)
    expect(result.block).toContain('doc-coverage: fail')
    expect(result.block).not.toContain('evidence-fresh')
  })
})

describe('buildReport — graded body source (O2)', () => {
  it('names the drafted file as the graded source in --write mode', async () => {
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      body: 'a real drafted body',
      gradedBodySource: 'write'
    })
    expect(result.block).toContain('Graded body: the drafted body file (`--write`)')
  })

  it('names the live pull-request body as the graded source in --push mode', async () => {
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      body: 'a real live body',
      gradedBodySource: 'push'
    })
    expect(result.block).toContain('Graded body: the live pull-request body (`--push`)')
  })
})

describe('buildReport — no-body checks render skipped, never pass (O3)', () => {
  it('a body-reading check that passed on an empty body renders skipped, never pass', async () => {
    const emptyBodyGates: GateRunResult = {
      outcomes: [
        // `pr-report-density` declares `PR_BODY` in its registry env and
        // exits 0 with no error when handed an empty body — the exact shape
        // of PR #481's incident.
        { name: 'pr-report-density', status: 'pass', errors: [] },
        // Doesn't read PR_BODY at all — a real pass, must stay pass.
        { name: 'exec-bits', status: 'pass', errors: [] }
      ],
      failed: false
    }
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => emptyBodyGates,
      body: '',
      gradedBodySource: 'write'
    })
    expect(result.block).toContain('pr-report-density: skipped')
    expect(result.block).not.toContain('pr-report-density: pass')
    expect(result.block).toContain('exec-bits: pass')
    expect(result.gateOutcomes.find((o) => o.name === 'pr-report-density')?.status).toBe('skipped')
  })

  it('a body-reading check that genuinely FAILED on an empty body is left alone — never upgraded to skipped', async () => {
    const emptyBodyGates: GateRunResult = {
      outcomes: [
        {
          name: 'closes-n',
          status: 'fail',
          errors: [{ severity: 'error', message: 'no Closes #N in the PR body' }]
        }
      ],
      failed: true
    }
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => emptyBodyGates,
      body: '',
      gradedBodySource: 'write'
    })
    expect(result.block).toContain('closes-n: fail')
    expect(result.gatesFailed).toBe(true)
  })

  it('a body-reading check is NOT rendered skipped when the graded body is non-empty — a real pass stays pass', async () => {
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      body: 'a real drafted body',
      gradedBodySource: 'write'
    })
    expect(result.block).toContain('brief-shape: pass')
    expect(result.block).not.toContain('brief-shape: skipped')
  })
})

describe('prReportCommand — --write forwards PR_BODY/BRANCH to Group B, never PR_NUMBER (O1)', () => {
  class ExitCalled extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`)
    }
  }

  async function runCapturingExit(args: string[], testOverrides?: { gateRunner?: GateRunner }): Promise<void> {
    const originalExit = process.exit
    process.exit = ((code?: number) => {
      throw new ExitCalled(code)
    }) as never
    try {
      await prReportCommand(args, testOverrides)
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err
    } finally {
      process.exit = originalExit
    }
  }

  it("forwards the drafted body file's text and the current branch to Group B the same way --push forwards the live body, and never sets PR_NUMBER", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-write-env-'))
    const originalCwd = process.cwd()
    const originalPrBody = process.env.PR_BODY
    const originalBranch = process.env.BRANCH
    const originalPrNumber = process.env.PR_NUMBER
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
      execFileSync('git', ['checkout', '-q', '-b', 'task/task-run-v1/5'], { cwd: dir })

      const bodyPath = join(dir, 'body.md')
      writeFileSync(bodyPath, 'a real drafted body\n')

      let capturedEnv: { PR_BODY?: string; BRANCH?: string; PR_NUMBER?: string } = {}
      const recordingRunner: GateRunner = () => {
        capturedEnv = {
          PR_BODY: process.env.PR_BODY,
          BRANCH: process.env.BRANCH,
          PR_NUMBER: process.env.PR_NUMBER
        }
        return PASSING_GATES
      }

      delete process.env.PR_NUMBER
      process.chdir(dir)
      await runCapturingExit(['--write', bodyPath], { gateRunner: recordingRunner })

      expect(capturedEnv.PR_BODY).toBe('a real drafted body\n')
      expect(capturedEnv.BRANCH).toBe('task/task-run-v1/5')
      expect(capturedEnv.PR_NUMBER).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
      if (originalPrBody === undefined) delete process.env.PR_BODY
      else process.env.PR_BODY = originalPrBody
      if (originalBranch === undefined) delete process.env.BRANCH
      else process.env.BRANCH = originalBranch
      if (originalPrNumber === undefined) delete process.env.PR_NUMBER
      else process.env.PR_NUMBER = originalPrNumber
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('extractAgentCommandLines / agentCommandText — task 12, #387', () => {
  it('extracts each non-blank line of the first fenced block in the Test Plan section', () => {
    const body = ['## Test Plan', '', '```', 'bun run test → 0 fail', 'bun run typecheck → clean', '```'].join('\n')
    expect(extractAgentCommandLines(body)).toEqual(['bun run test → 0 fail', 'bun run typecheck → clean'])
  })

  it('is empty for the unit-tests-only sentinel', () => {
    expect(extractAgentCommandLines('Test Plan: unit-tests-only')).toEqual([])
  })

  it('is empty when the body has no locatable Test Plan section at all', () => {
    expect(extractAgentCommandLines('## Summary\n\nno test plan here')).toEqual([])
  })

  it('is empty for the pre-#387 checkbox shape — no fenced block to read', () => {
    const body = ['## Test Plan', '', '- [ ] **[agent]** `bun run test` → green.'].join('\n')
    expect(extractAgentCommandLines(body)).toEqual([])
  })

  it('agentCommandText strips the trailing "→ <observable>" half of a line', () => {
    expect(agentCommandText('bun run test → summary line ends "0 fail"')).toBe('bun run test')
  })

  it('agentCommandText returns the whole line unchanged when there is no arrow', () => {
    expect(agentCommandText('bun run test')).toBe('bun run test')
  })
})

describe('runAgentCommand — real subprocess, no network', () => {
  it('captures stdout, a zero exit code, and never times out for a fast command', () => {
    const result = runAgentCommand('echo hello')
    expect(result.output).toBe('hello')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it("captures a non-zero exit code and the command's own output", () => {
    const result = runAgentCommand('echo oops >&2; exit 3')
    expect(result.output).toBe('oops')
    expect(result.exitCode).toBe(3)
  })

  it('never forwards GH_TOKEN/GITHUB_TOKEN to a §9 command (Principal ruling, PR open-1 addendum)', () => {
    const previousGhToken = process.env.GH_TOKEN
    const previousGithubToken = process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'secret-gh-token'
    process.env.GITHUB_TOKEN = 'secret-github-token'
    try {
      const result = runAgentCommand('env')
      expect(result.output).not.toContain('secret-gh-token')
      expect(result.output).not.toContain('secret-github-token')
      expect(result.output).not.toContain('GH_TOKEN')
      expect(result.output).not.toContain('GITHUB_TOKEN')
    } finally {
      if (previousGhToken === undefined) {
        delete process.env.GH_TOKEN
      } else {
        process.env.GH_TOKEN = previousGhToken
      }
      if (previousGithubToken === undefined) {
        delete process.env.GITHUB_TOKEN
      } else {
        process.env.GITHUB_TOKEN = previousGithubToken
      }
    }
  })

  // issue-545, O5 — the budget is policy (`report.commandTimeoutMs`), and a
  // command that exceeds it is recorded with the budget it exceeded.
  it('a command that exceeds an explicit timeoutMs is recorded with that exact budget, never a bare "timeout"', () => {
    const result = runAgentCommand('sleep 5', 50)
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.output).toBe('timeout (budget 50ms)')
  })
})

describe('resolveCommandTimeoutMs (issue-545, O5)', () => {
  it('defaults to DEFAULT_COMMAND_TIMEOUT_MS (900000) with no vinaya.config.json report key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-timeout-default-'))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(resolveCommandTimeoutMs()).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    } finally {
      process.chdir(cwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads report.commandTimeoutMs from vinaya.config.json when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-timeout-config-'))
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ report: { commandTimeoutMs: 1_800_000 } }))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(resolveCommandTimeoutMs()).toBe(1_800_000)
    } finally {
      process.chdir(cwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runAgentCommand with no explicit timeoutMs picks up the config-resolved budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-timeout-wired-'))
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ report: { commandTimeoutMs: 50 } }))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const result = runAgentCommand('sleep 5')
      expect(result.timedOut).toBe(true)
      expect(result.output).toBe('timeout (budget 50ms)')
    } finally {
      process.chdir(cwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('groupCFailed', () => {
  it('false when every command exited 0', () => {
    expect(groupCFailed({ commands: [{ command: 'x', output: '', exitCode: 0, timedOut: false }] })).toBe(false)
  })

  it('true when any command exited non-zero', () => {
    expect(groupCFailed({ commands: [{ command: 'x', output: '', exitCode: 1, timedOut: false }] })).toBe(true)
  })

  it('true when any command timed out', () => {
    expect(groupCFailed({ commands: [{ command: 'x', output: 'timeout', exitCode: null, timedOut: true }] })).toBe(true)
  })

  it('false for zero commands', () => {
    expect(groupCFailed({ commands: [] })).toBe(false)
  })
})

describe('computeGroupC — extracts and runs, end to end', () => {
  it('runs every command in the fenced list and records its real output', () => {
    const body = ['## Test Plan', '', '```', 'echo one → one', 'echo two → two', '```'].join('\n')
    const groupC = computeGroupC(body)
    expect(groupC.commands).toHaveLength(2)
    expect(groupC.commands[0]).toEqual({ command: 'echo one', output: 'one', exitCode: 0, timedOut: false })
    expect(groupC.commands[1]).toEqual({ command: 'echo two', output: 'two', exitCode: 0, timedOut: false })
  })

  it('is the empty commands list for a body with no Test Plan command list', () => {
    expect(computeGroupC('Test Plan: unit-tests-only')).toEqual({ commands: [] })
  })
})

describe('buildReport — Group C wiring', () => {
  it('renders every command and its output inside the Group C fence, and folds a failing command into gatesFailed', async () => {
    const body = ['## Test Plan', '', '```', 'echo hi → hi', 'exit 1 → never reached cleanly', '```'].join('\n')
    const result = await buildReport({ groupA: FIXED_GROUP_A, gateRunner: () => PASSING_GATES, body })
    expect(result.block).toContain('### Group C — Test Plan commands')
    expect(result.block).toContain('#### C1: `echo hi`')
    expect(result.block).toContain('hi')
    expect(result.block).toContain('#### C2: `exit 1`')
    expect(result.block).toContain('[exit 1]')
    expect(result.gatesFailed).toBe(true)
  })

  it('renders the "no commands" placeholder, and does not fail the report, for a unit-tests-only body', async () => {
    const result = await buildReport({
      groupA: FIXED_GROUP_A,
      gateRunner: () => PASSING_GATES,
      body: 'Test Plan: unit-tests-only'
    })
    expect(result.block).toContain('(no [agent] commands in the Test Plan section)')
    expect(result.gatesFailed).toBe(false)
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
    // The message claims nothing about a file being written: this function
    // writes none, and only the caller knows whether Evidence landed or where
    // (code review, PR #369).
    expect(refusal).not.toContain('AEG:EVIDENCE')
    // `vinaya tokens` prints a `Tokens:` line, never a `|`-delimited row, so
    // the remedy must say transcribe — telling a reader to paste that output
    // into the block puts a non-`|` line inside it, which truncates
    // `parseTokenReportEntries` for every row appended after it.
    expect(refusal).toContain('transcribe')
    expect(refusal).not.toMatch(/paste it into\s+the `## Token report` table/)
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

  // The classification these docs ASSERT, pinned as behaviour.
  //
  // `apps/cli/README.md`, this module's doc comments and the changeset all
  // state which incapable reason a given pointer state produces. Three review
  // rounds were spent on those sentences being wrong in prose while the code
  // was right, and prose has no gate: `quoted-command` sweeps only
  // `${doctrineRoot}/**/*.md` (this repo: `aeg-root/`, `proseGates` unset), so
  // a citation marker in a README, a `.ts` file or a changeset is never read,
  // and its predicate wants a verbatim quote rather than a paraphrase anyway.
  //
  // What CAN be mechanised is the fact underneath: if the classification ever
  // moves, these go red and name the docs that claim otherwise — no reviewer
  // needs to suspect a particular word first.
  describe('the incapable classification those docs describe', () => {
    const deps = (over: Partial<Parameters<typeof resolveMeteringCapability>[0]>) => ({
      env: { TMPDIR: '/tmp', CLAUDE_PROJECT_DIR: '/proj' } as Record<string, string | undefined>,
      cwd: '/proj',
      exists: () => true,
      readFile: () => '',
      ...over
    })

    it('classifies an owned-but-unreadable pointer as `pointer-unusable`', () => {
      const cap = resolveMeteringCapability(
        deps({
          readFile: () => {
            throw new Error('EACCES: permission denied')
          }
        })
      )
      expect(cap.capable).toBe(false)
      expect(cap.capable === false && cap.reason).toBe('pointer-unusable')
    })

    it('classifies a STALE pointer as `no-transcript-resolved`, not `pointer-unusable`', () => {
      const cap = resolveMeteringCapability(
        deps({
          env: { TMPDIR: '/tmp', CLAUDE_PROJECT_DIR: '/proj', CLAUDE_CODE_SESSION_ID: 'mine' },
          readFile: () => 'theirs\t/somewhere/their-transcript.jsonl'
        })
      )
      expect(cap.capable).toBe(false)
      // The whole point: a stale pointer is another session's, so it is not
      // this session's wiring, so it REFUSES rather than keeping a row.
      expect(cap.capable === false && cap.reason).toBe('no-transcript-resolved')
    })
  })

  // The exit half of the same fix. `prReportCommand` ends in `process.exit`,
  // so without this the widened condition rested on a manual run alone —
  // narrowing it back to `gatesFailed` would leave every other test green
  // (code review, PR #369).
  it('exits non-zero for a refused token row, a failing gate, or both — and zero for neither', () => {
    expect(prReportExitCode({ gatesFailed: false, tokensRefused: false })).toBe(0)
    expect(prReportExitCode({ gatesFailed: false, tokensRefused: true })).toBe(1)
    expect(prReportExitCode({ gatesFailed: true, tokensRefused: false })).toBe(1)
    // Both failing is still ONE non-zero exit, never a second reason lost.
    expect(prReportExitCode({ gatesFailed: true, tokensRefused: true })).toBe(1)
  })
})

// A template-shaped body with real (non-fenced) `AEG:EVIDENCE` and
// `AEG:TOKENS` pairs already seeded — the shape
// `aeg-root/templates/pr-report-template.md` produces and a live,
// already-open PR body actually has (both pairs are pre-seeded at open, per
// the template; `--push` only ever runs after that). `spliceIntoLiveBody`
// must leave everything outside the two pairs byte-for-byte untouched.
const LIVE_BODY = [
  '## Summary',
  '',
  'why this shipped, in the author’s own words.',
  '',
  '## Evidence',
  '',
  '<!-- AEG:EVIDENCE:START -->',
  'stale Head: deadbeef',
  '<!-- AEG:EVIDENCE:END -->',
  '',
  '## Scope',
  '',
  '**Tier:** 1',
  '',
  '## Token report',
  '',
  '<!-- AEG:TOKENS:START -->',
  '| Phase | Role | Agent/Model | Tokens in | Tokens out | Cost | Date |',
  '|---|---|---|---|---|---|---|',
  '<!-- AEG:TOKENS:END -->',
  ''
].join('\n')

describe('spliceIntoLiveBody', () => {
  it('keeps every byte outside the AEG:EVIDENCE/AEG:TOKENS regions, replacing only the block content', () => {
    const { body: updated } = spliceIntoLiveBody(LIVE_BODY, 'Head: freshsha', { collected: false, refusal: 'refused' })
    expect(updated).toContain('## Summary')
    expect(updated).toContain('why this shipped, in the author’s own words.')
    expect(updated).toContain('## Scope')
    expect(updated).toContain('**Tier:** 1')
    expect(updated).not.toContain('stale Head: deadbeef')
    expect(updated).toContain('Head: freshsha')
  })

  it('refuses (throws, writes nothing) on a live body with no real AEG:EVIDENCE pair — never appends one', () => {
    const noPair = '## Summary\n\nwhy.\n\n## Scope\n\n**Tier:** 1'
    expect(() => spliceIntoLiveBody(noPair, 'Head: freshsha', { collected: false, refusal: 'refused' })).toThrow(
      MissingEvidenceAnchorError
    )
  })

  it('refuses on a live body whose only AEG:EVIDENCE pair sits inside a fenced code block', () => {
    const fencedOnly = [
      '## Summary',
      '',
      'why.',
      '',
      '```',
      '<!-- AEG:EVIDENCE:START -->',
      'example only, never real',
      '<!-- AEG:EVIDENCE:END -->',
      '```',
      '',
      '## Scope'
    ].join('\n')
    expect(() => spliceIntoLiveBody(fencedOnly, 'Head: freshsha', { collected: false, refusal: 'refused' })).toThrow(
      MissingEvidenceAnchorError
    )
  })

  it('skips the token splice (no false drift) when the live body carries no real AEG:TOKENS pair, even with a collected row', () => {
    const noTokensPair =
      '## Summary\n\nwhy.\n\n<!-- AEG:EVIDENCE:START -->\nstale\n<!-- AEG:EVIDENCE:END -->\n\n## Scope'
    const { body: updated, tokensSpliced } = spliceIntoLiveBody(noTokensPair, 'Head: freshsha', {
      collected: true,
      row: '| 7: develop | Developer | claude-sonnet-5 | 200 | 75 | — | 2026-09-03 |'
    })
    expect(tokensSpliced).toBe(false)
    expect(updated).not.toContain('AEG:TOKENS')
    expect(updated).not.toContain('claude-sonnet-5')
    expect(updated).toContain('Head: freshsha')
  })
})

describe('bodiesAgreeOutsideRegions', () => {
  it('is true when only the AEG:EVIDENCE/AEG:TOKENS regions were regenerated', () => {
    const before = LIVE_BODY
    const { body: after } = spliceIntoLiveBody(before, 'Head: freshsha', {
      collected: true,
      row: '| 7: develop | Developer | claude-sonnet-5 | 200 | 75 | — | 2026-09-03 |'
    })
    expect(bodiesAgreeOutsideRegions(before, after)).toBe(true)
  })

  it('is false when a single byte outside those regions changed', () => {
    const before = LIVE_BODY
    const after = LIVE_BODY.replace('## Scope', '## SCOPE')
    expect(bodiesAgreeOutsideRegions(before, after)).toBe(false)
  })
})

describe('vinaya pr report --push CLI surface', () => {
  it('refuses --push together with --write, before touching the forge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-cli-'))
    try {
      const result = runCli(['pr', 'report', '--write', 'body.md', '--push', '383'], dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/--write and --push are mutually exclusive/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('usage line mentions --push', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-cli-'))
    try {
      const result = runCli(['pr', 'report', '--push'], dir)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--push <pr>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a non-numeric --push value before touching the forge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-cli-'))
    try {
      const result = runCli(['pr', 'report', '--push', '--transcript'], dir)
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/is not a PR number/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses --body-file without --push', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-cli-'))
    try {
      const bodyPath = join(dir, 'body.md')
      writeFileSync(bodyPath, 'whatever')
      const result = runCli(['pr', 'report', '--body-file', bodyPath], dir)
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/--body-file only applies alongside --push/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a --body-file that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-cli-'))
    try {
      const result = runCli(['pr', 'report', '--push', '383', '--body-file', join(dir, 'missing.md')], dir)
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/does not exist/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- O6 (#543): --push --body-file writes the WHOLE local body, not only the regenerated blocks ---

describe('prReportCommand — --push --body-file writes the whole local body (#543 O6)', () => {
  class ExitCalled extends Error {
    constructor(public code: number | undefined) {
      super(`process.exit(${code})`)
    }
  }

  async function runCapturingExit(args: string[], testOverrides?: { gateRunner?: GateRunner }): Promise<void> {
    const originalExit = process.exit
    process.exit = ((code?: number) => {
      throw new ExitCalled(code)
    }) as never
    try {
      await prReportCommand(args, testOverrides)
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err
    } finally {
      process.exit = originalExit
    }
  }

  it("pushes the local body-file's own Decisions bullet — a section outside the AEG:EVIDENCE/AEG:TOKENS blocks — to the forge fake, not only the regenerated blocks", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-bodyfile-'))
    const binDir = mkdtempSync(join(tmpdir(), 'vinaya-pr-report-push-bodyfile-bin-'))
    const forgeStore = join(dir, 'forge-body.txt')
    const originalCwd = process.cwd()
    const originalPath = process.env.PATH
    const originalPrBody = process.env.PR_BODY
    const originalBranch = process.env.BRANCH
    const originalPrNumber = process.env.PR_NUMBER
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
      execFileSync('git', ['checkout', '-q', '-b', 'task/task-run-v1/6'], { cwd: dir })

      // Ring 1 skips `runBodyChecks` entirely — this test is about the
      // whole-body write path, not the body-validating check registry.
      // `false` skips the ring since issue-545 O2 inverted these keys'
      // meaning (`true` now RUNS a ring, not skips it — config.ts's
      // `MANAGED_MANIFEST_VERSION` doc comment, version 3).
      writeFileSync(
        join(dir, 'vinaya.config.json'),
        JSON.stringify({ rings: { ring1_forgeWriteInterception: false, ring2_asyncAudits: false } })
      )

      // A minimal forge fake: `pr view` prints whatever `pr edit --body-file`
      // last wrote, so a real round trip through the fake proves the push
      // landed — not merely that this command CALLED `gh`.
      writeFileSync(forgeStore, 'placeholder — never read for this mode')
      const ghScript = `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s' "$(cat "${forgeStore}")"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  cp "$5" "${forgeStore}"
  exit 0
fi
echo "unhandled fake gh call: $*" >&2
exit 1
`
      const ghPath = join(binDir, 'gh')
      writeFileSync(ghPath, ghScript)
      execFileSync('chmod', ['+x', ghPath])

      const bodyPath = join(dir, 'body.md')
      writeFileSync(
        bodyPath,
        [
          '## Decisions',
          '',
          '- config key name: chose `reviewPolicy.maxRounds` over a bare `maxRounds` — same namespace as the two thresholds.',
          '',
          '## Test plan',
          '',
          'Test Plan: unit-tests-only',
          '',
          '## Evidence',
          '',
          '## Scope',
          '',
          '**Tier:** 1'
        ].join('\n')
      )

      delete process.env.PR_NUMBER
      process.chdir(dir)
      process.env.PATH = `${binDir}:${originalPath}`
      await runCapturingExit(['--push', '383', '--body-file', bodyPath], { gateRunner: () => PASSING_GATES })

      const pushedBody = readFileSync(forgeStore, 'utf8')
      // The Decisions bullet — outside both generated blocks — reached the
      // forge fake whole, not only the regenerated Evidence/Tokens content.
      expect(pushedBody).toContain('## Decisions')
      expect(pushedBody).toContain('chose `reviewPolicy.maxRounds`')
      expect(pushedBody).toContain('AEG:EVIDENCE:START')
      expect(pushedBody).toContain('Head:')
    } finally {
      process.chdir(originalCwd)
      process.env.PATH = originalPath
      if (originalPrBody === undefined) delete process.env.PR_BODY
      else process.env.PR_BODY = originalPrBody
      if (originalBranch === undefined) delete process.env.BRANCH
      else process.env.BRANCH = originalBranch
      if (originalPrNumber === undefined) delete process.env.PR_NUMBER
      else process.env.PR_NUMBER = originalPrNumber
      rmSync(dir, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    }
  })
})
