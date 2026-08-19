import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const FORGE_FIXTURES = join(CLI_ROOT, 'tests', 'fixtures', 'forge')

const ISSUE_CONFIG = {
  briefSchema: { issue: { sections: [{ builtin: 'issueRationale' }] } }
}

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

describe('vinaya issue create --validate-only', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-test-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(ISSUE_CONFIG), 'utf8')
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses a task Issue (tranche:* label) lacking the rationale', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-no-rationale.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const lines = r.stderr.trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(8)
    for (const line of lines) {
      const finding = JSON.parse(line)
      expect(finding.check).toBe('brief-schema')
      expect(finding.agent_recovery_prompt).toContain('vinaya issue create')
    }
  })

  it('passes a task Issue carrying the full rationale', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('passes a non-task Issue through unvalidated (no tranche label)', () => {
    const r = runCli(
      ['issue', 'create', '--validate-only', '--body-file', join(FORGE_FIXTURES, 'issue-no-rationale.md')],
      cwd
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })

  it('--json emits an enveloped outcome for a validated task Issue', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--json',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.validated).toBe(true)
    expect(parsed.data.written).toBe(false)
  })
})

// The three content checks `open-issue.ts` gates task Issues on
// (`checkBlastRadiusScope`, `checkNoBriefContent`, `checkRationaleNamesDocs`)
// never reached `apps/cli`'s real validation path until this task — real,
// adversarial CLI invocations, not a source-only read (the same gap this
// task exists to close was invisible to a prior source-only read).
describe('vinaya issue create --validate-only — content gate', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-issue-content-test-'))
    writeFileSync(join(cwd, 'vinaya.config.json'), JSON.stringify(ISSUE_CONFIG), 'utf8')
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses a rationale that touches a shared package without a second project or ack', () => {
    // A real git repo with a legacy `.aeg/packages` collision-domain entry and
    // a single-project registry that does NOT own the named domain — the
    // shape `checkBlastRadiusScope` exists to catch.
    execFileSync('git', ['init', '--quiet'], { cwd })
    mkdirSync(join(cwd, '.aeg'), { recursive: true })
    writeFileSync(join(cwd, '.aeg', 'packages'), 'packages/ui\n', 'utf8')
    mkdirSync(join(cwd, '.vinaya'), { recursive: true })
    writeFileSync(
      join(cwd, '.vinaya', 'projects.md'),
      [
        '## Registry',
        '',
        '| Project | Path | Specs | Per-project state |',
        '|---------|------|-------|---------------------|',
        '| vinaya | `.` | `specs/` | (state tracked globally for now) |',
        ''
      ].join('\n'),
      'utf8'
    )

    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-blast-radius-violation.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('issue-content')
    expect(finding.message).toContain('blast radius')
    expect(finding.message).toContain('packages/ui')
  })

  it('refuses an Issue body carrying a brief-shaped section', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-brief-content.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('issue-content')
    expect(finding.message).toContain('Technical surface map')
  })

  it('refuses a rationale that names no concrete doc/skill path', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-no-doc-path.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('issue-content')
    expect(finding.message).toContain('docs read')
  })

  it('passes a task Issue that clears both the presence gate and the content gate', () => {
    const r = runCli(
      [
        'issue',
        'create',
        '--validate-only',
        '--body-file',
        join(FORGE_FIXTURES, 'issue-valid.md'),
        '--label',
        'vinaya/tranche:demo'
      ],
      cwd
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
  })
})
