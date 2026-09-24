import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'bun:test'

/**
 * `vinaya task sweep [--include-legacy] [--json]` end-to-end, against a
 * `gh` stub on `PATH` and a scratch `$HOME` — the same fixture shape
 * `task-status.test.ts` already uses for this driver's other forge-reading
 * commands.
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

/** Same leak this command's siblings already guard against (`task-status.test.ts`'s own doc comment) — a dispatched session's own `VINAYA_*` env must never leak into this fixture's isolated `$HOME`. */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  // Left in place, a leaked GITHUB_ACTIONS makes a spawned child's own
  // log() resolve its destination to 'none' (log-sink.ts's
  // resolveLogDestinationFrom) instead of the folder/server a test expects
  // — the same leak #721 fixed for the in-process loop harness.
  delete out.GITHUB_ACTIONS
  return out
}

function runCli(args: string[], env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd: CLI_ROOT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...stripVinayaEnv(process.env), ...env },
      timeout: 18_000,
      killSignal: 'SIGKILL'
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string | null }
    if (err.signal) {
      throw new Error(
        `vinaya task sweep subprocess killed by ${err.signal} after exceeding its budget (args: ${args.join(' ')})\n` +
          `--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/** Backlog-shaped (no `vinaya/tranche:*` label) so `developerBranchFor` derives `task/issue-<n>` from a single `--json labels` read, with no title fetch to stub. */
const ISSUE_STATE: Record<number, 'OPEN' | 'CLOSED'> = { 811: 'CLOSED', 812: 'OPEN', 813: 'OPEN', 814: 'OPEN' }
const PR_BY_BRANCH: Record<string, { number: number; state: string }> = {
  'task/issue-812': { number: 900, state: 'MERGED' }
}

function stubGh(home: string): string {
  const dir = join(home, 'fake-forge')
  mkdirSync(dir, { recursive: true })
  const gh = join(dir, 'gh')
  const stateCases = Object.entries(ISSUE_STATE)
    .map(([n, state]) => `    ${n}) echo '${JSON.stringify({ state })}' ;;`)
    .join('\n')
  const prCases = Object.entries(PR_BY_BRANCH)
    .map(
      ([branch, pr]) =>
        `    ${branch}) cat <<'JSON'\n${JSON.stringify([{ number: pr.number, state: pr.state, headRefName: branch }])}\nJSON\n    ;;`
    )
    .join('\n')
  const script = `#!/bin/sh
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "state" ]; then
  case "$3" in
${stateCases}
    *) echo "gh stub: unhandled issue view state for $3" >&2; exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "view" ] && [ "$4" = "--json" ] && [ "$5" = "labels" ]; then
  echo '{"labels":[]}'
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

const FIXTURE_REPO_SEGMENT = 'acme-widget'

function setUp(): { home: string; env: Record<string, string> } {
  const home = tempDir('vinaya-task-sweep-home-')
  const forgeDir = stubGh(home)
  return {
    home,
    env: { HOME: home, PATH: `${forgeDir}:${process.env.PATH ?? ''}`, AEG_REPO: 'acme/widget' }
  }
}

function taskRunDir(home: string, task: number): string {
  return join(home, '.vinaya', 'runtime', FIXTURE_REPO_SEGMENT, 'tasks-execution', String(task))
}

function writeTaskFolder(home: string, task: number, files: Record<string, unknown> = {}): void {
  mkdirSync(taskRunDir(home, task), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(name === 'driver.pid.json' ? taskRunDir(home, task) : join(taskRunDir(home, task), 'control'), {
      recursive: true
    })
    const dir = name === 'driver.pid.json' ? taskRunDir(home, task) : join(taskRunDir(home, task), 'control')
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
  }
}

function outputLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

describe('vinaya task sweep — router wiring', () => {
  it("the 'task' router names 'sweep' among its expected subcommands", () => {
    const r = runCli(['task', 'bogus'], {})
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("Unknown 'task' subcommand")
    expect(r.stderr).toContain('sweep')
  })
})

describe('vinaya task sweep (O1) — the modern layout', () => {
  it('removes a finished-by-closed-Issue folder, removes a finished-by-merged-PR folder, keeps an open one and a live one, printing each with its reason', () => {
    const { home, env } = setUp()
    writeTaskFolder(home, 811)
    writeTaskFolder(home, 812)
    writeTaskFolder(home, 813)
    writeTaskFolder(home, 814, { 'driver.pid.json': { pid: process.pid, startedAt: '2026-09-21T00:00:00.000Z' } })

    const r = runCli(['task', 'sweep'], env)
    expect(r.status).toBe(0)

    const lines = outputLines(r.stdout)
    expect(lines.some((l) => l.startsWith('removed Issue #811') && l.includes('closed'))).toBe(true)
    expect(lines.some((l) => l.startsWith('removed Issue #812') && l.includes('merged'))).toBe(true)
    expect(lines.some((l) => l.startsWith('kept Issue #813') && l.includes('open'))).toBe(true)
    expect(lines.some((l) => l.startsWith('kept Issue #814') && l.includes('live'))).toBe(true)

    expect(existsSync(taskRunDir(home, 811))).toBe(false)
    expect(existsSync(taskRunDir(home, 812))).toBe(false)
    expect(existsSync(taskRunDir(home, 813))).toBe(true)
    expect(existsSync(taskRunDir(home, 814))).toBe(true)
  })

  it('--json emits the enveloped machine form', () => {
    const { home, env } = setUp()
    writeTaskFolder(home, 811)

    const r = runCli(['task', 'sweep', '--json'], env)
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as { schema: number; data: { modern: { removed: unknown[] } } }
    expect(parsed.schema).toBe(1)
    expect(parsed.data.modern.removed.length).toBe(1)
  })

  it('an unrecognized flag is a usage error', () => {
    const r = runCli(['task', 'sweep', '--bogus'], {})
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--bogus')
  })
})

describe('vinaya task sweep --include-legacy (O3)', () => {
  it('lists a legacy dispatch-output entry as unattributable without --include-legacy, and never deletes it either way', () => {
    const { home, env } = setUp()
    mkdirSync(join(home, '.vinaya', 'dispatch-output'), { recursive: true })
    writeFileSync(join(home, '.vinaya', 'dispatch-output', 'effect-abc123.log'), 'raw bytes')

    const withoutFlag = runCli(['task', 'sweep'], env)
    expect(withoutFlag.status).toBe(0)
    expect(withoutFlag.stdout).toContain('legacy [dispatch-output]')
    expect(withoutFlag.stdout).toContain('unattributable')
    expect(existsSync(join(home, '.vinaya', 'dispatch-output', 'effect-abc123.log'))).toBe(true)

    const withFlag = runCli(['task', 'sweep', '--include-legacy'], env)
    expect(withFlag.status).toBe(0)
    expect(withFlag.stdout).toContain('legacy [dispatch-output]')
    expect(existsSync(join(home, '.vinaya', 'dispatch-output', 'effect-abc123.log'))).toBe(true)
  })
})
