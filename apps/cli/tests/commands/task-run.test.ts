import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
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

  it('refuses with no --agent at all', () => {
    const r = runCli(['task', 'run', 'task-run-v1', '2'])
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
})
