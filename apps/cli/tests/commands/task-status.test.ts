import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya task status` end-to-end, against a `gh` stub on `PATH` and a
 * scratch `$HOME` for the outbox — the Sizing story from `#515`'s
 * rationale: "a fake forge with three task Issues and an outbox with one
 * running pid, one pause record, one published effect marker prints three
 * lines in the three states; the single-task form prints the resume
 * command."
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd: CLI_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/** Drops the shared trust-anchor helper's own stdout warning (`config.ts`'s `loadTrustAnchorConfig`) — a `gh` stub on `PATH` never resolves it, and the line belongs to that helper, not to this command's contract (`review-status.test.ts`'s own identical convention). */
function withoutTrustAnchorWarning(stdout: string): string {
  return stdout
    .split('\n')
    .filter((l) => !l.startsWith('⚠ could not read the trust-anchor config'))
    .join('\n')
}

function outputLines(stdout: string): string[] {
  return withoutTrustAnchorWarning(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

function principalComment(body: string) {
  return { body, author: { login: 'daniboomerang' } }
}

function frozenBriefComment(): { body: string; author: { login: string } } {
  return principalComment('<!-- aeg:brief:v1 -->\nBrief hash: deadbeef\n\nA brief body.')
}

const ISSUES = [
  { number: 601, title: '[demo] 1 — Running task', labels: [{ name: 'vinaya/tranche:demo' }] },
  { number: 602, title: '[demo] 2 — Paused task', labels: [{ name: 'vinaya/tranche:demo' }] },
  { number: 603, title: '[demo] 3 — Published task', labels: [{ name: 'vinaya/tranche:demo' }] },
  // O2: a backlog Issue — no `vinaya/tranche:*` label at all.
  // 604 carries an outbox dir (a real dispatched task) and is expected to
  // list; 605 carries none and must be pre-filtered before ever costing an
  // `issue view` call (the stub below fails loudly if 605 is ever fetched).
  { number: 604, title: 'A backlog bug that grew into a real task', labels: [] },
  { number: 605, title: 'An ordinary open Issue, never dispatched', labels: [] }
]

const PR_BY_BRANCH: Record<string, number> = {
  'task/demo/1': 701,
  'task/demo/2': 702,
  'task/demo/3': 703,
  'task/issue-604': 704
}

function stubGh(home: string): string {
  const dir = join(home, 'fake-forge')
  mkdirSync(dir, { recursive: true })
  const gh = join(dir, 'gh')
  const prCases = Object.entries(PR_BY_BRANCH)
    .map(
      ([branch, number]) =>
        `    ${branch}) cat <<'JSON'\n${JSON.stringify([{ number, headRefName: branch }])}\nJSON\n    ;;`
    )
    .join('\n')
  const script = `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
${JSON.stringify(ISSUES)}
JSON
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ]; then
  case "$3" in
    605)
      echo "gh stub: issue view unexpectedly called for Issue 605 (no outbox dir — must be pre-filtered, O2)" >&2
      exit 1
      ;;
    *)
      cat <<'JSON'
${JSON.stringify({ comments: [frozenBriefComment()] })}
JSON
      ;;
  esac
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  case "$4" in
${prCases}
    *) echo '[]' ;;
  esac
  exit 0
fi
echo "gh stub: unhandled: $*" >&2
exit 1
`
  writeFileSync(gh, script)
  chmodSync(gh, 0o755)
  return dir
}

/**
 * Pinned so the runtime directory these fixtures write into is deterministic.
 * Without it, `run-paths.ts` resolves the repo from `git remote get-url
 * origin` in whatever checkout the test runs from, and the fixture and the
 * CLI under test would disagree about the directory on a fork or a rename.
 */
const FIXTURE_REPO_SEGMENT = 'acme-widget'

function setUp(): { home: string; env: Record<string, string> } {
  const home = tempDir('vinaya-task-status-home-')
  const forgeDir = stubGh(home)
  return {
    home,
    env: { HOME: home, PATH: `${forgeDir}:${process.env.PATH ?? ''}`, AEG_REPO: 'acme/widget' }
  }
}

/** The task's own run folder — `run-paths.ts`'s layout, written out by hand so these fixtures assert against literal strings rather than the code under test. */
function taskRunDir(home: string, task: number): string {
  return join(home, '.vinaya', 'runtime', FIXTURE_REPO_SEGMENT, 'tasks-execution', String(task))
}

/**
 * Places a fixture file by the same classification production uses: the
 * driver lock at the task folder's root, a held verdict in its own round's
 * folder, and the pause state and effect markers in `control/`.
 */
function writeRunFile(home: string, task: number, name: string, content: unknown): void {
  const held = /^round-(\d+)-(reviewer|security)\.md$/.exec(name)
  const dir = held
    ? join(taskRunDir(home, task), 'rounds', held[1] as string)
    : name === 'driver.pid.json'
      ? taskRunDir(home, task)
      : join(taskRunDir(home, task), 'control')
  const file = held ? `${held[2]}.md` : name
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

describe('vinaya task status — router wiring', () => {
  it("the 'task' router names 'status' among its expected subcommands", () => {
    const r = runCli(['task', 'bogus'], {})
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("Unknown 'task' subcommand")
    expect(r.stderr).toContain('status')
  })
})

describe('vinaya task status (O1/O3 — the list form)', () => {
  it('prints one line per open task with a frozen brief, each in its derived state', () => {
    const { home, env } = setUp()
    writeRunFile(home, 601, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    writeRunFile(home, 602, 'pause-state.json', {
      task: 602,
      round: 1,
      head: 'abc123',
      branch: 'task/demo/2',
      prNumber: 702,
      reason: 'escalation',
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
    writeRunFile(home, 603, 'effect-1-reviewer-verdict.json', { effectId: 'a', status: 'posted' })
    writeRunFile(home, 603, 'effect-1-security-verdict.json', { effectId: 'b', status: 'posted' })

    const r = runCli(['task', 'status'], env)

    expect(outputLines(r.stdout)).toEqual([
      `[demo] 1 — Issue #601 — PR #701 — running (pid ${process.pid})`,
      '[demo] 2 — Issue #602 — PR #702 — paused (escalation)',
      '[demo] 3 — Issue #603 — PR #703 — published'
    ])
    expect(r.status).toBe(0)
  })

  it('prints no driver for a task with a frozen brief but nothing in the outbox', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status'], env)
    expect(outputLines(r.stdout)).toEqual([
      '[demo] 1 — Issue #601 — PR #701 — no driver',
      '[demo] 2 — Issue #602 — PR #702 — no driver',
      '[demo] 3 — Issue #603 — PR #703 — no driver'
    ])
    expect(r.status).toBe(0)
  })

  // O2: a backlog Issue with a frozen brief and a driver lock
  // renders one row, right alongside the tranche-labeled ones — same shape,
  // `[backlog]` in place of a tranche slug and the Issue number as its id.
  // Issue 605 (no outbox dir at all) never appears — the pre-filter never
  // even asks the forge about it (the stub fails loudly if it does).
  it('lists a frozen backlog task beside tranche tasks — one row like a tranche task, in its derived state', () => {
    const { home, env } = setUp()
    writeRunFile(home, 601, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    writeRunFile(home, 602, 'pause-state.json', {
      task: 602,
      round: 1,
      head: 'abc123',
      branch: 'task/demo/2',
      prNumber: 702,
      reason: 'escalation',
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
    writeRunFile(home, 603, 'effect-1-reviewer-verdict.json', { effectId: 'a', status: 'posted' })
    writeRunFile(home, 603, 'effect-1-security-verdict.json', { effectId: 'b', status: 'posted' })
    writeRunFile(home, 604, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })

    const r = runCli(['task', 'status'], env)

    expect(outputLines(r.stdout)).toEqual([
      `[demo] 1 — Issue #601 — PR #701 — running (pid ${process.pid})`,
      '[demo] 2 — Issue #602 — PR #702 — paused (escalation)',
      '[demo] 3 — Issue #603 — PR #703 — published',
      `[backlog] 604 — Issue #604 — PR #704 — running (pid ${process.pid})`
    ])
    expect(r.status).toBe(0)
  })

  it('--json returns the same fields in the schema-1 envelope', () => {
    const { home, env } = setUp()
    writeRunFile(home, 601, 'driver.pid.json', { pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })

    const r = runCli(['task', 'status', '--json'], env)
    const parsed = JSON.parse(withoutTrustAnchorWarning(r.stdout)) as {
      schema: number
      data: {
        tasks: Array<{ tranche: string; id: string; issue: number; pr: { number: number } | null; state: unknown }>
      }
    }
    expect(parsed.schema).toBe(1)
    expect(parsed.data.tasks).toHaveLength(3)
    expect(parsed.data.tasks[0]).toEqual({
      tranche: 'demo',
      id: '1',
      issue: 601,
      pr: { number: 701 },
      state: { kind: 'running', pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' }
    })
  })
})

describe('vinaya task status <tranche> <n> (O2 — the single-task form)', () => {
  it('prints the resume command for a paused task', () => {
    const { home, env } = setUp()
    writeRunFile(home, 602, 'pause-state.json', {
      task: 602,
      round: 1,
      head: 'abc123',
      branch: 'task/demo/2',
      prNumber: 702,
      reason: 'escalation',
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
    writeRunFile(home, 602, 'round-1-reviewer.md', 'VERDICT: REQUEST CHANGES\n\nJudged head: abc123\n')
    writeRunFile(home, 602, 'round-1-security.md', 'VERDICT: PASS\n\nJudged head: abc123\n')

    const r = runCli(['task', 'status', 'demo', '2'], env)

    expect(outputLines(r.stdout)).toEqual([
      '[demo] 2 — Issue #602 — PR #702 — paused (escalation)',
      'reviewer (round 1): VERDICT: REQUEST CHANGES',
      'security (round 1): VERDICT: PASS',
      'Resume with: vinaya dev-review-loop --resume 702'
    ])
    expect(r.status).toBe(0)
  })

  it('prints no resume line for a published task', () => {
    const { home, env } = setUp()
    writeRunFile(home, 603, 'effect-1-reviewer-verdict.json', { effectId: 'a', status: 'posted' })
    writeRunFile(home, 603, 'effect-1-security-verdict.json', { effectId: 'b', status: 'posted' })

    const r = runCli(['task', 'status', 'demo', '3'], env)

    expect(outputLines(r.stdout)).toEqual(['[demo] 3 — Issue #603 — PR #703 — published'])
    expect(r.status).toBe(0)
  })

  it('refuses naming the task when it is not an open task Issue', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', 'demo', '99'], env)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('task 99 in tranche `demo` is not an open task Issue')
  })

  it('refuses with usage on a lone tranche argument', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', 'demo'], env)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage: vinaya task status')
  })
})

// task-run-v1 task 15, O6: `--follow` tails the task's per-run driver log
// live — argv refusals here, the tail-read wiring proven with a bounded
// (timeout-killed, `tail -f` is never expected to exit on its own) run below.
describe('vinaya task status --follow (task-run-v1 task 15, O6)', () => {
  it('refuses with usage when --follow is given with no tranche/n and no --issue', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', '--follow'], env)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage: vinaya task status')
  })

  it('refuses a non-numeric --issue value', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', '--issue', 'nope', '--follow'], env)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--issue must be numeric')
  })

  it('refuses naming the task when the <tranche> <n> form does not resolve to an open task Issue', () => {
    const { env } = setUp()
    const r = runCli(['task', 'status', 'demo', '99', '--follow'], env)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('task 99 in tranche `demo` is not an open task Issue')
  })

  it("--issue <n> --follow prints the log file's existing content, then keeps running (killed by timeout, same as a real tail -f)", () => {
    const { home, env } = setUp()
    const logPath = join(taskRunDir(home, 521), 'output', 'driver.log')
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(
      logPath,
      '=== run started 2026-09-12T00:00:00.000Z role=dev-review-loop pid=1 ===\n[developer] hello\n'
    )

    let caught: { stdout?: string } | null = null
    try {
      execFileSync('bun', [INDEX, 'task', 'status', '--issue', '521', '--follow'], {
        cwd: CLI_ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        timeout: 1500
      })
    } catch (e) {
      caught = e as { stdout?: string }
    }
    expect(caught).not.toBeNull()
    expect(String(caught?.stdout ?? '')).toContain('[developer] hello')
  })
})
