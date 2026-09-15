import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `vinaya log export-artifact` end to end — the task-path job's own half, run against a real `HOME` scratch
 * dir so the outbox lives under a throwaway `~/.vinaya/outbox/`, same
 * discipline as `log-flush.test.ts`. Never spawns `gh` — this command holds
 * no credential and never touches the forge.
 */

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
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

function runCli(args: string[], cwd: string, env: Record<string, string | undefined>): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      encoding: 'utf8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:test-owner/test-repo.git'], { cwd })
}

function ndjsonLine(runId: string, seq: number, issue: number | null): string {
  return JSON.stringify({
    meta: {
      schema: 1,
      ts: '2026-09-15T00:00:00.000Z',
      run_id: runId,
      seq,
      repo: 'test-owner/test-repo',
      vinaya: '0.0.0',
      doctrine: 'unknown',
      host: 'ci',
      machine: 'deadbeef'
    },
    subject: { issue, role: 'developer' },
    kind: 'gate',
    event: 'checked',
    payload: {},
    check: 'typecheck',
    check_version: null,
    policy_version: null,
    input_fingerprint: null,
    outcome: 'pass'
  })
}

function seedOutboxFile(home: string, repoDir: string, issue: number | 'none', content: string): string {
  const p = join(home, '.vinaya', 'outbox', repoDir, `${issue}.ndjson`)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
  return p
}

describe('vinaya log export-artifact', () => {
  it('concatenates every outbox bucket into one file, verbatim', () => {
    const cwd = tempDir('log-export-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-export-home-')
    seedOutboxFile(home, 'test-owner-test-repo', 'none', `${ndjsonLine('r1', 0, null)}\n${ndjsonLine('r1', 1, null)}\n`)
    seedOutboxFile(home, 'test-owner-test-repo', 564, `${ndjsonLine('r2', 0, 564)}\n`)

    const dest = join(tempDir('log-export-dest-'), 'vinaya-task-log.ndjson')
    const r = runCli(['log', 'export-artifact', dest], cwd, { HOME: home })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('wrote 3 record(s)')
    const lines = readFileSync(dest, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(lines.length).toBe(3)
    expect(lines.map((l) => l.meta.run_id)).toEqual(['r1', 'r1', 'r2'])
  })

  it('an empty (or missing) outbox writes nothing and still exits 0 — no gate events this run is not a failure', () => {
    const cwd = tempDir('log-export-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-export-home-')
    const dest = join(tempDir('log-export-dest-'), 'vinaya-task-log.ndjson')

    const r = runCli(['log', 'export-artifact', dest], cwd, { HOME: home })

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('no outbox content')
    expect(() => readFileSync(dest, 'utf8')).toThrow()
  })

  it('a cancelled run leaves a partial, torn final line — export still copies it verbatim rather than losing the whole file (O2)', () => {
    const cwd = tempDir('log-export-cwd-')
    initGitRepo(cwd)
    const home = tempDir('log-export-home-')
    // A complete first record followed by a torn one, as a kill mid-write
    // (SIGTERM/SIGKILL) would leave it — no trailing newline, cut mid-JSON.
    const torn = `${ndjsonLine('r1', 0, null)}\n{"meta":{"schema":1,"run_id":"r1","seq":1`
    seedOutboxFile(home, 'test-owner-test-repo', 'none', torn)

    const dest = join(tempDir('log-export-dest-'), 'vinaya-task-log.ndjson')
    const r = runCli(['log', 'export-artifact', dest], cwd, { HOME: home })

    expect(r.status).toBe(0)
    const content = readFileSync(dest, 'utf8')
    expect(content).toContain('"seq":0')
    // The torn line is still present, byte for byte — this function never
    // repairs, truncates, or silently drops it; a caller downstream
    // (the collector's own validation) is what turns it into an explicit gap.
    expect(content).toContain('{"meta":{"schema":1,"run_id":"r1","seq":1')
  })
})
