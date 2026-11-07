import { execFileSync } from 'node:child_process'
import { programCommandLine } from '../../programs.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'apps', 'cli')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[]): CliResult {
  try {
    const stdout = execFileSync('bun', programCommandLine(args) ?? [INDEX, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('vinaya task — router wiring', () => {
  it("refuses an unknown 'task' subcommand", () => {
    const r = runCli(['task', 'bogus'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("Unknown 'task' subcommand")
    expect(r.stderr).toContain('run')
  })

  it("refuses 'task' with no subcommand", () => {
    const r = runCli(['task'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("Unknown 'task' subcommand")
  })
})

describe('vinaya task brief --supersede — argv parsing (task-run-v1 task 4, #483, O3)', () => {
  it('refuses with no tranche/task id', () => {
    const r = runCli(['task', 'brief'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage: vinaya-task-brief')
    expect(r.stderr).toContain('--supersede')
  })

  it('refuses a non-numeric task id', () => {
    const r = runCli(['task', 'brief', 'plan-brief-v1', 'two'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('task id must be numeric')
  })

  it('refuses --supersede with no --reason', () => {
    const r = runCli(['task', 'brief', 'plan-brief-v1', '427', '--supersede'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--supersede requires --reason')
  })

  it('refuses a bare --reason with no --supersede', () => {
    const r = runCli(['task', 'brief', 'plan-brief-v1', '427', '--reason', 'wrong tier'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--reason is only meaningful with --supersede')
  })
})

// task-run-v1 task 15, O1: `--issue <n>` is `task brief`'s tranche-less form
// — argv parsing only, mirroring the `<tranche> <n>` block above.
describe('vinaya task brief --issue — argv parsing (task-run-v1 task 15, O1)', () => {
  it('refuses both --issue and a positional tranche/n together', () => {
    const r = runCli(['task', 'brief', 'plan-brief-v1', '427', '--issue', '521'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('pass either <tranche> <n> or --issue <n>, never both')
  })

  it('refuses a non-numeric --issue value', () => {
    const r = runCli(['task', 'brief', '--issue', 'five-twenty-one'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--issue must be numeric')
  })

  it('refuses --supersede with no --reason under --issue too', () => {
    const r = runCli(['task', 'brief', '--issue', '521', '--supersede'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--supersede requires --reason')
  })
})

describe('vinaya task brief --supersede --surface-in — argv parsing (O3)', () => {
  it('refuses --surface-in with no --supersede', () => {
    const r = runCli(['task', 'brief', 'plan-brief-v1', '427', '--surface-in', 'apps/cli/src/commands'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--surface-in is only meaningful with --supersede')
  })

  it('refuses --surface-in with no value', () => {
    const r = runCli(['task', 'brief', 'plan-brief-v1', '427', '--supersede', '--reason', 'widen', '--surface-in'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--surface-in <glob1,glob2,...> was passed with no value')
  })

  it('refuses --surface-in resolving to zero globs (a bare comma)', () => {
    const r = runCli([
      'task',
      'brief',
      'plan-brief-v1',
      '427',
      '--supersede',
      '--reason',
      'widen',
      '--surface-in',
      ' , '
    ])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--surface-in resolved to zero globs')
  })

  it('mentions --surface-in in the usage line', () => {
    const r = runCli(['task', 'brief'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--surface-in')
  })

  it('refuses --surface-in with no --supersede under --issue too', () => {
    const r = runCli(['task', 'brief', '--issue', '521', '--surface-in', 'apps/cli/src/commands'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('--surface-in is only meaningful with --supersede')
  })
})
