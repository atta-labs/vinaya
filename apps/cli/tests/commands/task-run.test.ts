import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

type CliResult = { status: number; stdout: string; stderr: string }

/**
 * `cwd` defaults to this repo's own root (the historical behavior every
 * pre-existing test here relies on) — but that root now declares
 * `dispatch.agent` in its own `vinaya.config.json` (O10, task-run-v1 13,
 * `#508`), so a test asserting the NO-config `--agent` refusal must pass an
 * isolated `cwd` carrying no such file, same as `O10`'s own fallback test
 * below passes one that deliberately does.
 */
/**
 * Issue #660, O3 round 3 — `task run` reaches `task-run-background.ts`'s
 * `acquireOwnership`, the same driver-lock/control-store surface
 * `apps/cli/tests/lib/dispatch.test.ts`'s own `stripVinayaEnv` + budget
 * already guards: a leaked `VINAYA_RUNTIME_DIR` from a dispatched session's
 * own environment survives past this fixture's `HOME` override
 * (`resolveRuntimeDirUncached` checks it first), and an unbounded
 * `execFileSync` call hangs with zero diagnostic under lock contention.
 */
function stripVinayaEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  return out
}

const SUBPROCESS_BUDGET_MS = 18_000

function runCli(args: string[], opts?: { cwd?: string; home?: string }): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      env: { ...stripVinayaEnv(process.env), ...(opts?.home ? { HOME: opts.home } : {}) },
      timeout: SUBPROCESS_BUDGET_MS,
      killSignal: 'SIGKILL'
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; signal?: string | null }
    if (err.signal) {
      throw new Error(
        `vinaya task run subprocess killed by ${err.signal} after exceeding its ${SUBPROCESS_BUDGET_MS}ms budget ` +
          `(args: ${args.join(' ')})\n--- stdout ---\n${err.stdout ?? ''}\n--- stderr ---\n${err.stderr ?? ''}`
      )
    }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/**
 * A directory with no `vinaya.config.json` up its tree (unlike this repo's
 * own root) AND, passed as `home` too, no `~/.vinaya/config.json` either —
 * full isolation from both this repo's own `dispatch.agent` default (O10,
 * task-run-v1 13, `#508`) and whatever the real machine's global config
 * carries.
 */
function isolatedCwd(): string {
  return mkdtempSync(join(tmpdir(), 'vinaya-task-run-test-'))
}

describe("vinaya task run — router wiring (O2's 'run' subcommand)", () => {
  it("the 'task' router now names 'run' among its expected subcommands", () => {
    const r = runCli(['task', 'bogus'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("Unknown 'task' subcommand")
    expect(r.stderr).toContain('run')
  })
})

describe('vinaya task run — argv parsing', () => {
  it('refuses with no tranche/task id', () => {
    const r = runCli(['task', 'run'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage: vinaya task run')
    expect(r.stderr).toContain('--agent')
  })

  it('refuses a non-numeric task id', () => {
    const r = runCli(['task', 'run', 'task-run-v1', 'two', '--agent', 'claude'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('task id must be numeric')
  })

  it('refuses with no --agent at all and no `dispatch.agent` config to fall back to', () => {
    const home = isolatedCwd()
    const cwd = isolatedCwd()
    const r = runCli(['task', 'run', 'task-run-v1', '2'], { cwd, home })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--agent')
    expect(r.stderr).toContain('is required')
  })

  it('refuses an --agent value outside claude|codex|gemini', () => {
    const r = runCli(['task', 'run', 'task-run-v1', '2', '--agent', 'skills'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('claude')
    expect(r.stderr).toContain('codex')
    expect(r.stderr).toContain('gemini')
  })

  it('refuses --agent with no value', () => {
    const r = runCli(['task', 'run', 'task-run-v1', '2', '--agent'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--agent')
  })

  it("has no --resume flag of its own (O2 — resuming is the loop's existing path)", () => {
    const r = runCli(['task', 'run'])
    expect(r.stderr).not.toContain('--resume')
  })

  it('refuses an unrecognized flag rather than silently dropping it (round 2 security review, MEDIUM)', () => {
    const r = runCli(['task', 'run', 'task-run-v1', '2', '--agent', 'claude', '--bogus'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('unrecognized flag')
    expect(r.stderr).toContain("'--bogus'")
  })

  it('refuses an unrecognized flag even when a valid --agent is also present, plural wording for two+', () => {
    const r = runCli(['task', 'run', 'task-run-v1', '2', '--agent', 'claude', '--one', '--two'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('unrecognized flags')
    expect(r.stderr).toContain("'--one'")
    expect(r.stderr).toContain("'--two'")
  })

  it('resolves --agent from `dispatch.agent` in vinaya.config.json when omitted (O10, task-run-v1 13, #508)', () => {
    const home = isolatedCwd()
    const cwd = isolatedCwd()
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify({ dispatch: { agent: 'claude' } }))
    // No `--agent` flag at all, and a bogus tranche/task id no real repo
    // carries — if the config fallback did NOT resolve an agent, this would
    // stop at the same usage refusal (exit `2`, "--agent ... is required")
    // the no-config test above asserts. Getting past that into `runTask`'s
    // own failure (a real repo/tranche it cannot resolve, exit `3`) is the
    // proof the fallback supplied one.
    const r = runCli(['task', 'run', 'bogus-tranche-xyz', '999'], { cwd, home })
    expect(r.stderr).not.toContain('--agent')
    expect(r.status).toBe(3)
  })
})

// issue-661, round 2 (O1): `--model` is a known flag, parsed through to
// `runTask`'s own `RunTaskInput.model` — never refused as unrecognized, and
// never required (its absence resolves through the library's own
// class-to-model precedence, out of this command's own concern).
describe('vinaya task run --model — argv parsing (issue-661, round 2, O1)', () => {
  it('is a known flag, not refused as unrecognized', () => {
    const r = runCli(['task', 'run', 'task-run-v1', '2', '--agent', 'claude', '--model', 'opus'])
    expect(r.stderr).not.toContain('unrecognized flag')
  })

  it('reaches past argv parsing into `runTask` itself (a real repo/tranche it cannot resolve, exit 3) — proof the value was accepted rather than short-circuited by usage', () => {
    const r = runCli(['task', 'run', 'bogus-tranche-xyz', '999', '--agent', 'claude', '--model', 'opus'])
    expect(r.stderr).not.toContain('Usage: vinaya task run')
    expect(r.status).toBe(3)
  })

  it('is accepted the same way under --issue', () => {
    const r = runCli(['task', 'run', '--issue', '999999', '--agent', 'claude', '--model', 'opus'])
    expect(r.stderr).not.toContain('unrecognized flag')
    expect(r.stderr).not.toContain('Usage: vinaya task run')
    expect(r.status).toBe(3)
  })
})

// task-run-v1 task 15, O1: `--issue <n>` is `task run`'s tranche-less form —
// argv parsing only, mirroring the `<tranche> <n>` block above.
describe('vinaya task run --issue — argv parsing (task-run-v1 task 15, O1)', () => {
  it('refuses both --issue and a positional tranche/n together', () => {
    const r = runCli(['task', 'run', 'task-run-v1', '2', '--issue', '521', '--agent', 'claude'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('pass either <tranche> <n> or --issue <n>, never both')
  })

  it('refuses a non-numeric --issue value', () => {
    const r = runCli(['task', 'run', '--issue', 'five-twenty-one', '--agent', 'claude'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--issue must be numeric')
  })

  it('refuses with no --agent at all under --issue too', () => {
    const home = isolatedCwd()
    const cwd = isolatedCwd()
    const r = runCli(['task', 'run', '--issue', '521'], { cwd, home })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--agent')
    expect(r.stderr).toContain('is required')
  })
})
