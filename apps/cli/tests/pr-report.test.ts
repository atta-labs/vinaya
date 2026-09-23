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
  defaultTestRunCache,
  extractAgentCommandLines,
  type GateOutcome,
  type GateRunner,
  type GateRunResult,
  GitCommandError,
  groupCFailed,
  MissingEvidenceAnchorError,
  prReportCommand,
  prReportExitCode,
  recordGreenTestRun,
  renderGroupC,
  replaceEvidenceBlock,
  resolveCommandTimeoutMs,
  runAgentCommand,
  spliceIntoLiveBody,
  type TestRunCache,
  type TestRunCacheRecord,
  UnresolvableMergeBaseError,
  writeTokensBlock
} from '../src/commands/pr-report'
import { resolveTokenReportCapabilityWith } from '../src/lib/pr-report-engine'
import { spawnBudgetedAsync, stripVinayaEnv } from './lib/process-fixture'

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
  it('captures stdout, a zero exit code, and never times out for a fast command', async () => {
    const result = await runAgentCommand('echo hello')
    expect(result.output).toBe('hello')
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it("captures a non-zero exit code and the command's own output", async () => {
    const result = await runAgentCommand('echo oops >&2; exit 3')
    expect(result.output).toBe('oops')
    expect(result.exitCode).toBe(3)
  })

  it('never forwards GH_TOKEN/GITHUB_TOKEN to a §9 command (Principal ruling, PR open-1 addendum)', async () => {
    const previousGhToken = process.env.GH_TOKEN
    const previousGithubToken = process.env.GITHUB_TOKEN
    process.env.GH_TOKEN = 'secret-gh-token'
    process.env.GITHUB_TOKEN = 'secret-github-token'
    try {
      const result = await runAgentCommand('env')
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
  it('a command that exceeds an explicit timeoutMs is recorded with that exact budget, never a bare "timeout"', async () => {
    const result = await runAgentCommand('sleep 5', 50)
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

  it('runAgentCommand with no explicit timeoutMs picks up the config-resolved budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-timeout-wired-'))
    writeFileSync(join(dir, 'vinaya.config.json'), JSON.stringify({ report: { commandTimeoutMs: 50 } }))
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const result = await runAgentCommand('sleep 5')
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
    expect(
      groupCFailed({ commands: [{ command: 'x', output: '', exitCode: 0, timedOut: false, overflowed: false }] })
    ).toBe(false)
  })

  it('true when any command exited non-zero', () => {
    expect(
      groupCFailed({ commands: [{ command: 'x', output: '', exitCode: 1, timedOut: false, overflowed: false }] })
    ).toBe(true)
  })

  it('true when any command timed out', () => {
    expect(
      groupCFailed({
        commands: [{ command: 'x', output: 'timeout', exitCode: null, timedOut: true, overflowed: false }]
      })
    ).toBe(true)
  })

  it('true when any command overflowed its output budget (O4, Issue #707)', () => {
    expect(
      groupCFailed({
        commands: [{ command: 'x', output: 'output overflow', exitCode: null, timedOut: false, overflowed: true }]
      })
    ).toBe(true)
  })

  it('false for zero commands', () => {
    expect(groupCFailed({ commands: [] })).toBe(false)
  })
})

describe('computeGroupC — extracts and runs, end to end', () => {
  it('runs every command in the fenced list and records its real output', async () => {
    const body = ['## Test Plan', '', '```', 'echo one → one', 'echo two → two', '```'].join('\n')
    const groupC = await computeGroupC(body)
    expect(groupC.commands).toHaveLength(2)
    expect(groupC.commands[0]).toEqual({
      command: 'echo one',
      output: 'one',
      exitCode: 0,
      timedOut: false,
      overflowed: false
    })
    expect(groupC.commands[1]).toEqual({
      command: 'echo two',
      output: 'two',
      exitCode: 0,
      timedOut: false,
      overflowed: false
    })
  })

  it('is the empty commands list for a body with no Test Plan command list', async () => {
    expect(await computeGroupC('Test Plan: unit-tests-only')).toEqual({ commands: [] })
  })

  // Round 3 review, F2 (test-honesty): a `[agent]` command that itself reads
  // `PR_BODY` (any `vinaya check` invocation, e.g. `closes-n`) used to always
  // see an empty body here — `runAgentCommand`'s own env never carried it —
  // so Group C's own evidence could never demonstrate a Test Plan's
  // "→ exits 0" claim for such a command, no matter when it ran.
  it('threads the graded body through as PR_BODY, so a command that reads it sees the SAME text Group C extracted its own command list from', async () => {
    const body = ['## Test Plan', '', '```', 'echo "body was: $PR_BODY"', '```'].join('\n')
    const groupC = await computeGroupC(body)
    expect(groupC.commands[0]?.output).toBe(`body was: ${body}`)
  })

  it('threads PR_NUMBER/BRANCH through when the caller supplies them, never on its own', async () => {
    const body = ['## Test Plan', '', '```', 'echo "pr=$PR_NUMBER branch=$BRANCH"', '```'].join('\n')
    const withoutExtras = await computeGroupC(body)
    expect(withoutExtras.commands[0]?.output).toBe('pr= branch=')
    const withExtras = await computeGroupC(body, undefined, { PR_NUMBER: '623', BRANCH: 'task/worker-isolation-v1/3' })
    expect(withExtras.commands[0]?.output).toBe('pr=623 branch=task/worker-isolation-v1/3')
  })
})

/** An in-memory `TestRunCache` for a test — no disk, no shared state with another test or the real machine's runtime directory. */
function memoryTestRunCache(): TestRunCache {
  const store = new Map<string, TestRunCacheRecord>()
  return {
    get: (key) => store.get(key),
    set: (key, record) => store.set(key, record)
  }
}

function initTestGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
}

// Issue #707, O3 — a Test-plan command that already ran green against the
// exact head and working tree is reused, never run again, and the evidence
// names the run it reused. `counterFile` (appended to by the command itself)
// is the ground truth for "did this actually re-run", independent of
// whatever `runAgentCommand` reports about itself.
describe('runAgentCommand / computeGroupC — test-run reuse (O3, Issue #707)', () => {
  it('a second run of the identical command against the identical head and working tree reuses the first — the command itself never runs twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-reuse-'))
    initTestGitRepo(dir)
    const cache = memoryTestRunCache()
    // Outside `dir` on purpose: the command's OWN write must never itself
    // become an untracked file the working-tree hash picks up, or every
    // "same tree" run would look different from the last.
    const counterFile = join(mkdtempSync(join(tmpdir(), 'pr-report-reuse-counter-')), 'counter.txt')
    const command = `echo -n x >> ${counterFile}`

    const first = await runAgentCommand(command, undefined, dir, {}, cache)
    expect(first.reusedFrom).toBeUndefined()
    expect(first.exitCode).toBe(0)
    expect(readFileSync(counterFile, 'utf8')).toBe('x')

    const second = await runAgentCommand(command, undefined, dir, {}, cache)
    expect(second.reusedFrom).toBeDefined()
    expect(second.reusedFrom).toContain('pr-report')
    expect(second.exitCode).toBe(0)
    expect(second.timedOut).toBe(false)
    expect(second.overflowed).toBe(false)
    // The counter file still holds exactly one `x` — the command itself was
    // never spawned a second time.
    expect(readFileSync(counterFile, 'utf8')).toBe('x')
  })

  it('a working-tree change invalidates reuse — the command runs again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-reuse-tree-'))
    initTestGitRepo(dir)
    const cache = memoryTestRunCache()
    const counterFile = join(mkdtempSync(join(tmpdir(), 'pr-report-reuse-tree-counter-')), 'counter.txt')
    const command = `echo -n x >> ${counterFile}`

    await runAgentCommand(command, undefined, dir, {}, cache)
    expect(readFileSync(counterFile, 'utf8')).toBe('x')

    // A real, uncommitted change to the working tree — the same head, a
    // different tree.
    writeFileSync(join(dir, 'README.md'), 'hello, changed\n')

    const afterChange = await runAgentCommand(command, undefined, dir, {}, cache)
    expect(afterChange.reusedFrom).toBeUndefined()
    expect(readFileSync(counterFile, 'utf8')).toBe('xx')
  })

  it('a failing command is never cached — reruns every time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-reuse-fail-'))
    initTestGitRepo(dir)
    const cache = memoryTestRunCache()
    const counterFile = join(mkdtempSync(join(tmpdir(), 'pr-report-reuse-fail-counter-')), 'counter.txt')
    const command = `echo -n x >> ${counterFile}; exit 1`

    const first = await runAgentCommand(command, undefined, dir, {}, cache)
    expect(first.exitCode).toBe(1)
    expect(first.reusedFrom).toBeUndefined()

    const second = await runAgentCommand(command, undefined, dir, {}, cache)
    expect(second.exitCode).toBe(1)
    expect(second.reusedFrom).toBeUndefined()
    // Ran twice — a failing result is never a green run worth reusing.
    expect(readFileSync(counterFile, 'utf8')).toBe('xx')
  })

  it('computeGroupC threads the cache through every command in the list, and a second call on the same head/tree finishes without re-running any of them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-reuse-groupc-'))
    initTestGitRepo(dir)
    const cache = memoryTestRunCache()
    const counterFile = join(mkdtempSync(join(tmpdir(), 'pr-report-reuse-groupc-counter-')), 'counter.txt')
    const body = ['## Test Plan', '', '```', `echo -n a >> ${counterFile}`, `echo -n b >> ${counterFile}`, '```'].join(
      '\n'
    )

    const first = await computeGroupC(body, dir, {}, cache)
    expect(first.commands.every((c) => c.reusedFrom === undefined)).toBe(true)
    expect(readFileSync(counterFile, 'utf8')).toBe('ab')

    const started = performance.now()
    const second = await computeGroupC(body, dir, {}, cache)
    const elapsedMs = performance.now() - started
    expect(second.commands.every((c) => c.reusedFrom !== undefined)).toBe(true)
    expect(readFileSync(counterFile, 'utf8')).toBe('ab')
    // Reused, not re-run — no process spawn on the second pass, so this
    // stays well under the second it would cost to fork `bash -c` twice more.
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('renderGroupC names the run a reused command reused, right below its own fence', () => {
    const rendered = renderGroupC({
      commands: [
        {
          command: 'bun test x.test.ts',
          output: '1 pass, 0 fail',
          exitCode: 0,
          timedOut: false,
          overflowed: false,
          reusedFrom: 'a green run recorded 2026-09-24T00:00:00.000Z (pr-report)'
        }
      ]
    })
    expect(rendered).toContain('1 pass, 0 fail')
    expect(rendered).toContain('Reused from a green run recorded 2026-09-24T00:00:00.000Z (pr-report) — not re-run.')
  })
})

// Round-2 review, BLOCKER — O3 promises reuse "in the pre-push hook or an
// earlier pr report", but nothing ever wrote a `source: 'pre-push'` record.
// `recordGreenTestRun` is what the hook's own `pre-push-cache-test-run.ts`
// calls; these tests prove the write it makes is the SAME cache a later
// `computeGroupC` reads from — the hook-then-report sequence the finding
// said was unreachable.
describe('recordGreenTestRun — the pre-push hook half of O3 reuse (round-2 review, BLOCKER)', () => {
  it('a run recorded with source "pre-push" is reused by a later computeGroupC, named as such', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-prepush-reuse-'))
    initTestGitRepo(dir)
    const cache = memoryTestRunCache()

    const recorded = await recordGreenTestRun('bun test x.test.ts', '3 pass, 0 fail', dir, 'pre-push', cache)
    expect(recorded).toBe(true)

    const body = ['## Test Plan', '', '```', 'bun test x.test.ts', '```'].join('\n')
    const groupC = await computeGroupC(body, dir, {}, cache)
    expect(groupC.commands[0]?.output).toBe('3 pass, 0 fail')
    expect(groupC.commands[0]?.reusedFrom).toContain('pre-push')
  })

  it('returns false and records nothing when the working tree cannot be resolved (no git repo at all)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-prepush-nogit-'))
    const cache = memoryTestRunCache()
    const recorded = await recordGreenTestRun('echo hi', 'hi', dir, 'pre-push', cache)
    expect(recorded).toBe(false)
  })

  it("defaultTestRunCache() with no args is a real, usable cache (the pre-push script's own default before a PR exists)", () => {
    const cache = defaultTestRunCache()
    expect(typeof cache.get).toBe('function')
    expect(typeof cache.set).toBe('function')
  })

  it('the real generated hook script (pre-push-cache-test-run.ts), spawned as a subprocess, writes a record a later computeGroupC reuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-prepush-script-'))
    initTestGitRepo(dir)
    const runtimeDir = mkdtempSync(join(tmpdir(), 'pr-report-prepush-script-runtime-'))
    const logFile = join(dir, 'captured-output.txt')
    writeFileSync(logFile, '2 pass, 0 fail\n')
    const scriptPath = join(CLI_ROOT, 'src', 'lib', 'pre-push-cache-test-run.ts')

    await spawnBudgetedAsync(
      ['bun', scriptPath, 'bun test y.test.ts', logFile],
      { cwd: dir, env: { ...stripVinayaEnv(), VINAYA_RUNTIME_DIR: runtimeDir } },
      undefined,
      'pre-push-cache-test-run.ts'
    )

    const cachePath = join(runtimeDir, 'tasks-execution', 'unscoped', 'output', 'test-run-cache.json')
    const cacheContents = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, { source: string }>
    const records = Object.values(cacheContents)
    expect(records).toHaveLength(1)
    expect(records[0]?.source).toBe('pre-push')
  })
})

// Round-2 security review, HIGH — `git()` collapsed ANY failure (a lock, a
// missing binary, a broken worktree) to `''`, indistinguishable from a real
// empty answer, so two DIFFERENT unresolvable working trees running the
// identical command could collide on the same cache key and one's cached
// output would be presented as evidence for the other's run. Fixed: any git
// failure now makes the whole key resolution `null`, which every caller
// treats as "no caching this call" — never a key, so never a collision.
describe('testRunCacheKey — a git failure disables caching, never fabricates a colliding key (round-2 security review, HIGH)', () => {
  it('two different non-git directories running the identical command never share a cached result', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'pr-report-nogit-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'pr-report-nogit-b-'))
    const cache = memoryTestRunCache()
    const counterA = join(mkdtempSync(join(tmpdir(), 'pr-report-nogit-counter-a-')), 'counter.txt')
    const counterB = join(mkdtempSync(join(tmpdir(), 'pr-report-nogit-counter-b-')), 'counter.txt')

    const first = await runAgentCommand(`echo -n x >> ${counterA}`, undefined, dirA, {}, cache)
    expect(first.reusedFrom).toBeUndefined()
    // Same command text, a DIFFERENT unresolvable directory — if the git
    // failure collapsed to a shared key, this would incorrectly reuse A's
    // result instead of running for real.
    const second = await runAgentCommand(`echo -n x >> ${counterB}`, undefined, dirB, {}, cache)
    expect(second.reusedFrom).toBeUndefined()
    expect(readFileSync(counterA, 'utf8')).toBe('x')
    expect(readFileSync(counterB, 'utf8')).toBe('x')
  })

  it('a git repo real head still caches normally — the fix narrows only the failure case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-realgit-'))
    initTestGitRepo(dir)
    const cache = memoryTestRunCache()
    const counterFile = join(mkdtempSync(join(tmpdir(), 'pr-report-realgit-counter-')), 'counter.txt')
    const command = `echo -n x >> ${counterFile}`
    await runAgentCommand(command, undefined, dir, {}, cache)
    const second = await runAgentCommand(command, undefined, dir, {}, cache)
    expect(second.reusedFrom).toBeDefined()
  })
})

// Round-2 security review, MEDIUM — the cache key's working-tree hash
// excluded gitignored paths entirely (`git status` with no `--ignored`), so
// a behavioral change confined to a single gitignored file (a `.env`, a
// locally patched generated file) was invisible to the key: the tree read
// as unchanged and a stale cached result kept being reused.
describe("testRunCacheKey — an ignored file's own content is part of the working-tree hash (round-2 security review, MEDIUM)", () => {
  it('editing a gitignored file invalidates reuse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-ignored-'))
    initTestGitRepo(dir)
    writeFileSync(join(dir, '.gitignore'), 'secret.env\n')
    writeFileSync(join(dir, 'secret.env'), 'FIRST=1\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'ignore secret.env'], { cwd: dir })
    const cache = memoryTestRunCache()
    const counterFile = join(mkdtempSync(join(tmpdir(), 'pr-report-ignored-counter-')), 'counter.txt')
    const command = `echo -n x >> ${counterFile}`

    await runAgentCommand(command, undefined, dir, {}, cache)
    expect(readFileSync(counterFile, 'utf8')).toBe('x')

    // Only the ignored file changes — no tracked file, nothing new/untracked.
    writeFileSync(join(dir, 'secret.env'), 'FIRST=2\n')

    const afterIgnoredChange = await runAgentCommand(command, undefined, dir, {}, cache)
    expect(afterIgnoredChange.reusedFrom).toBeUndefined()
    expect(readFileSync(counterFile, 'utf8')).toBe('xx')
  })
})

// Issue #707, O4 — an output-buffer overflow is reported as its own outcome,
// never folded into a timeout. Node kills the child on either condition and
// sets `killed: true` both times, so `code` must be checked first.
describe('runAgentCommand — output-buffer overflow is its own outcome, never a timeout (O4, Issue #707)', () => {
  it('a command whose output exceeds the buffer budget is reported as an overflow, not a timeout', async () => {
    // A tiny budget and a command that produces far more than it, but returns
    // almost instantly — proving the failure is about SIZE, not TIME. If this
    // were mis-reported as a timeout, `output` would read `timeout (budget
    // ...ms)`; `overflowed` would be false.
    const result = await runAgentCommand(
      'head -c 100000 /dev/zero | tr "\\0" "x"',
      60_000,
      undefined,
      {},
      undefined,
      1024
    )
    expect(result.overflowed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('output overflow')
    expect(result.output).not.toContain('timeout')
  })

  it('renderGroupC and groupCFailed treat an overflow as a failure, with its own status marker', () => {
    const groupC = {
      commands: [
        {
          command: 'x',
          output: 'output overflow (budget 1024 bytes)',
          exitCode: null,
          timedOut: false,
          overflowed: true
        }
      ]
    }
    expect(groupCFailed(groupC)).toBe(true)
    expect(renderGroupC(groupC)).toContain('[output overflow]')
  })

  it('a genuine timeout at the same small budget is still reported as a timeout, never an overflow', async () => {
    const result = await runAgentCommand('sleep 5', 50, undefined, {}, undefined, 1024)
    expect(result.timedOut).toBe(true)
    expect(result.overflowed).toBe(false)
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

  async function withFixtureCwd<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const originalCwd = process.cwd()
    try {
      process.chdir(root)
      return await fn()
    } finally {
      process.chdir(originalCwd)
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('resolves a real, non-empty diff via the `main` fallback when `origin/main` does not exist', async () => {
    const root = initFixtureWithFeatureBranch('main')
    await withFixtureCwd(root, async () => {
      const groupA = await computeGroupA()
      expect(groupA.base).not.toBe('')
      expect(groupA.numstat).toContain('a.txt')
    })
  })

  it('refuses (UnresolvableMergeBaseError) rather than writing an empty diff when the default branch is `master` — neither `origin/main` nor `main` resolves', async () => {
    const root = initFixtureWithFeatureBranch('master')
    await withFixtureCwd(root, async () => {
      await expect(computeGroupA()).rejects.toThrow(UnresolvableMergeBaseError)
      try {
        await computeGroupA()
      } catch (err) {
        expect(err).toBeInstanceOf(UnresolvableMergeBaseError)
        const e = err as UnresolvableMergeBaseError
        expect(e.triedRefs).toEqual(['origin/main', 'main'])
        expect(e.message).toContain('origin/main')
        expect(e.message).toContain('main')
      }
    })
  })

  it('BASE_SHA overrides the primary resolution attempt (escape hatch for a non-main default branch)', async () => {
    const root = initFixtureWithFeatureBranch('master')
    const originalBaseSha = process.env.BASE_SHA
    await withFixtureCwd(root, async () => {
      process.env.BASE_SHA = 'master'
      try {
        const groupA = await computeGroupA()
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

  it('throws on an unborn branch instead of emitting an empty head and diff', async () => {
    // No commits yet, so `git rev-parse HEAD` exits non-zero. This previously
    // short-circuited BOTH ternaries in computeGroupA, so resolveMergeBase was
    // never reached and nothing refused.
    const dir = mkdtempSync(join(tmpdir(), 'c126-unborn-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
      const cwd = process.cwd()
      process.chdir(dir)
      try {
        await expect(computeGroupA()).rejects.toThrow(GitCommandError)
      } finally {
        process.chdir(cwd)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a genuinely empty diff is still a normal, non-throwing answer', async () => {
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
        const result = await computeGroupA()
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

/**
 * `resolveTokenReportCapabilityWith` (O1, #608, round-2 review MAJOR finding
 * F1) — `recoverUsageFromDispatchTee` and `resolveMeteringCapability` each
 * had unit coverage in isolation, but nothing proved the MERGE: a
 * `no-transcript-resolved` verdict plus a real recovered summary actually
 * becoming a `capable: true` result carrying that summary and the tee's own
 * path. Every case below is a fake `TokenReportCapabilityDeps` — no real
 * transcript, launch record, or tee file touched.
 */
describe('resolveTokenReportCapabilityWith (O1, #608)', () => {
  const RECOVERY = {
    summary: {
      components: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      model: 'claude-sonnet-5',
      messageCount: 1
    },
    teePath: '/fake/dispatch-output/effect-abc.log'
  }

  it('no-transcript-resolved + a real recovery: merges into capable:true carrying the recovered summary and teePath', () => {
    const result = resolveTokenReportCapabilityWith({
      resolveMetering: () => ({ capable: false, reason: 'no-transcript-resolved', detail: 'no pointer' }),
      recoverFromTee: () => RECOVERY
    })
    expect(result).toEqual({ capable: true, transcriptPath: RECOVERY.teePath, summary: RECOVERY.summary })
  })

  it('no-transcript-resolved + no recovery: the original incapable verdict passes through unchanged', () => {
    const incapable = { capable: false, reason: 'no-transcript-resolved', detail: 'no pointer' } as const
    const result = resolveTokenReportCapabilityWith({
      resolveMetering: () => incapable,
      recoverFromTee: () => null
    })
    expect(result).toEqual(incapable)
  })

  it('already capable: recovery is never even consulted', () => {
    let recoverCalled = false
    const capable = {
      capable: true,
      transcriptPath: '/real/transcript.jsonl',
      summary: {
        components: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        model: 'x',
        messageCount: 1
      }
    } as const
    const result = resolveTokenReportCapabilityWith({
      resolveMetering: () => capable,
      recoverFromTee: () => {
        recoverCalled = true
        return RECOVERY
      }
    })
    expect(result).toEqual(capable)
    expect(recoverCalled).toBe(false)
  })

  it('incapable for a wiring-defect reason (not no-transcript-resolved): recovery is never consulted, the real diagnosis stands', () => {
    let recoverCalled = false
    const wiringBroken = { capable: false, reason: 'pointer-unusable', detail: 'stale pointer' } as const
    const result = resolveTokenReportCapabilityWith({
      resolveMetering: () => wiringBroken,
      recoverFromTee: () => {
        recoverCalled = true
        return RECOVERY
      }
    })
    expect(result).toEqual(wiringBroken)
    expect(recoverCalled).toBe(false)
  })

  it('passes the caller-supplied transcriptPath straight through to resolveMetering', () => {
    let seenPath: string | undefined
    resolveTokenReportCapabilityWith(
      {
        resolveMetering: (transcriptPath) => {
          seenPath = transcriptPath
          return { capable: false, reason: 'transcript-unreadable', detail: 'x' }
        },
        recoverFromTee: () => null
      },
      '/explicit/transcript.jsonl'
    )
    expect(seenPath).toBe('/explicit/transcript.jsonl')
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
 *
 * `VINAYA_RUN_ID`/`VINAYA_ROLE`/`VINAYA_TASK` are cleared too (O1, #608):
 * `resolveTokenReportCapability` now also tries
 * `recoverUsageFromDispatchTee`, which reads these three live off
 * `process.env` — and when this whole suite itself runs inside a real
 * dispatched developer session (as it does when a Developer runs its own
 * `bun test` from a `vinaya dispatch developer` turn), those three are
 * genuinely set to THIS session's own real values, and a real launch record
 * plus tee log for this exact run can genuinely exist on this machine.
 * Left uncleared, that real, unrelated state leaks into a test asserting
 * "no wiring, no recovery" and non-deterministically turns a refusal into a
 * real collected row (found live: exactly this, on the authoring machine).
 */
describe('collectTokensAddition refuses rather than claiming the host cannot meter (#365)', () => {
  function withUnwiredEnv<T>(fn: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'pr-report-unwired-'))
    const saved = {
      TMPDIR: process.env.TMPDIR,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
      VINAYA_RUN_ID: process.env.VINAYA_RUN_ID,
      VINAYA_ROLE: process.env.VINAYA_ROLE,
      VINAYA_TASK: process.env.VINAYA_TASK
    }
    process.env.TMPDIR = dir
    process.env.CLAUDE_PROJECT_DIR = dir
    delete process.env.CLAUDE_CODE_SESSION_ID
    delete process.env.VINAYA_RUN_ID
    delete process.env.VINAYA_ROLE
    delete process.env.VINAYA_TASK
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
