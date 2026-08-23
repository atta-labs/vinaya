import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

function writeBody(cwd: string, name: string, content: string): string {
  const p = join(cwd, name)
  writeFileSync(p, content, 'utf8')
  return p
}

describe('vinaya milestone create --validate-only', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-milestone-test-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses before any forge write when the goal is absent', () => {
    const bodyFile = writeBody(cwd, 'body.md', 'Release: 1.0.0')
    const r = runCli(['milestone', 'create', '--validate-only', '--title', 'A title', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const finding = JSON.parse(line)
      expect(finding.check).toBe('milestone-shape')
      expect(finding.message.toLowerCase()).toContain('goal')
    }
  })

  it('refuses before any forge write when Release: is malformed', () => {
    const bodyFile = writeBody(cwd, 'body.md', 'The goal.\n\nRelease: whenever it ships')
    const r = runCli(['milestone', 'create', '--validate-only', '--title', 'A title', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const finding = JSON.parse(line)
      expect(finding.check).toBe('milestone-shape')
      expect(finding.message).toContain('Release')
    }
  })

  it('refuses before any forge write when the intents section does not parse', () => {
    const bodyFile = writeBody(cwd, 'body.md', 'The goal.\n\n### Tranche intents\nnot a bullet line')
    const r = runCli(['milestone', 'create', '--validate-only', '--title', 'A title', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      const finding = JSON.parse(line)
      expect(finding.check).toBe('milestone-shape')
      expect(finding.message.toLowerCase()).toContain('intents')
    }
  })

  it('refuses when --title is missing', () => {
    const bodyFile = writeBody(cwd, 'body.md', 'The goal.')
    const r = runCli(['milestone', 'create', '--validate-only', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.message).toContain('--title')
  })

  it('refuses when --body-file is missing', () => {
    const r = runCli(['milestone', 'create', '--validate-only', '--title', 'A title'], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.message).toContain('--body-file')
  })

  it('passes a well-formed body carrying goal, Release, and intents', () => {
    const bodyFile = writeBody(
      cwd,
      'body.md',
      [
        'Ship the milestone model.',
        '',
        'Release: 1.0.0',
        '',
        '### Tranche intents',
        '- vinaya-milestone-model-v1: A milestone can be created and refused when malformed.'
      ].join('\n')
    )
    const r = runCli(['milestone', 'create', '--validate-only', '--title', 'A title', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('passes a goal-only body — Release and intents are both optional', () => {
    const bodyFile = writeBody(cwd, 'body.md', 'A milestone with no version and no declared tranches yet.')
    const r = runCli(['milestone', 'create', '--validate-only', '--title', 'A title', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })
})
