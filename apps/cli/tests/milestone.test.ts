import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], cwd: string): CliResult {
  try {
    // `env: process.env` is explicit, not redundant: Bun's `execFileSync`
    // snapshots the environment at process start rather than re-reading
    // `process.env` at call time, so a test's PATH mutation (installing a
    // fake `gh`) is invisible to this subprocess without it.
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

function writeBody(cwd: string, name: string, content: string): string {
  const p = join(cwd, name)
  writeFileSync(p, content, 'utf8')
  return p
}

// ---------------------------------------------------------------------------
// `vinaya milestone adopt` — fake `gh` on PATH, same technique
// `tests/waiver.test.ts` uses: a shell script that logs every invocation's
// argv and returns canned JSON, so the refusal/write-ordering tests prove
// the real shape of what `adopt` shells out to without touching a real forge.
// ---------------------------------------------------------------------------

function initGitRepo(cwd: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:test-owner/test-repo.git'], { cwd })
}

type IssueFixture = { number: number; state: 'OPEN' | 'CLOSED'; milestone: { title: string } | null }
type MilestoneFixture = { number: number; title: string; state: 'open' | 'closed' }

function fakeAdoptGh(
  logPath: string,
  opts: { labels: string[]; milestones: MilestoneFixture[]; issuesBySlug: Record<string, IssueFixture[]> }
): string {
  const labelsJson = JSON.stringify(opts.labels.map((name) => ({ name })))
  const milestonesJson = JSON.stringify(opts.milestones)
  const issueCases = Object.entries(opts.issuesBySlug)
    .map(([slug, issues]) => `  *"vinaya/tranche:${slug}"*) echo '${JSON.stringify(issues)}' ;;`)
    .join('\n')
  return `#!/usr/bin/env sh
echo "$@" >> "${logPath}"
case "$*" in
  *"labels?per_page="*) echo '${labelsJson}' ;;
  *"milestones?state=all"*) echo '${milestonesJson}' ;;
${issueCases}
  *"issue edit"*) echo 'https://github.com/test-owner/test-repo/issues/1' ;;
  *"PATCH"*) echo '{}' ;;
  *) echo '[]' ;;
esac
exit 0
`
}

let binDir: string
let logPath: string
let originalPath: string | undefined

function installFakeAdoptGh(opts: {
  labels: string[]
  milestones: MilestoneFixture[]
  issuesBySlug: Record<string, IssueFixture[]>
}): void {
  binDir = join(tmpdir(), `vinaya-adopt-gh-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(binDir, { recursive: true })
  logPath = join(binDir, 'gh.log')
  writeFileSync(logPath, '')
  writeFileSync(join(binDir, 'gh'), fakeAdoptGh(logPath, opts), { mode: 0o755 })
  originalPath = process.env.PATH
  process.env.PATH = `${binDir}:${originalPath ?? ''}`
}

function ghLog(): string {
  return readFileSync(logPath, 'utf8')
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

describe('vinaya milestone adopt', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-milestone-adopt-test-'))
    initGitRepo(cwd)
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    process.env.PATH = originalPath
    rmSync(binDir, { recursive: true, force: true })
  })

  const target: MilestoneFixture = { number: 10, title: 'test-goal-v1', state: 'open' }

  it('moves a tranche into the target and closes its old Milestone (happy path)', () => {
    installFakeAdoptGh({
      labels: ['vinaya/tranche:tranche-a'],
      milestones: [target, { number: 5, title: 'tranche-a', state: 'open' }],
      issuesBySlug: {
        'tranche-a': [
          { number: 101, state: 'OPEN', milestone: { title: 'tranche-a' } },
          { number: 102, state: 'CLOSED', milestone: { title: 'tranche-a' } }
        ]
      }
    })

    const r = runCli(['milestone', 'adopt', '--target', 'test-goal-v1', '--slug', 'tranche-a'], cwd)

    expect(r.status).toBe(0)
    const log = ghLog()
    expect(log).toContain('issue edit 101 -R test-owner/test-repo --milestone test-goal-v1')
    expect(log).toContain('issue edit 102 -R test-owner/test-repo --milestone test-goal-v1')
    expect(log).toContain('api -X PATCH repos/test-owner/test-repo/milestones/5 -f state=closed')
    expect(r.stdout).toContain('old Milestone #5 closed')
  })

  it('refuses an unknown slug before any write', () => {
    installFakeAdoptGh({ labels: [], milestones: [target], issuesBySlug: {} })

    const r = runCli(['milestone', 'adopt', '--target', 'test-goal-v1', '--slug', 'no-such-tranche'], cwd)

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('unknown-slug')
    const log = ghLog()
    expect(log).not.toContain('issue edit')
    expect(log).not.toContain('PATCH')
  })

  it('refuses a slug whose label carries no Issues before any write', () => {
    installFakeAdoptGh({
      labels: ['vinaya/tranche:empty-tranche'],
      milestones: [target],
      issuesBySlug: { 'empty-tranche': [] }
    })

    const r = runCli(['milestone', 'adopt', '--target', 'test-goal-v1', '--slug', 'empty-tranche'], cwd)

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no-issues')
    const log = ghLog()
    expect(log).not.toContain('issue edit')
    expect(log).not.toContain('PATCH')
  })

  it('refuses a target that does not exist before any write', () => {
    installFakeAdoptGh({
      labels: ['vinaya/tranche:tranche-a'],
      milestones: [],
      issuesBySlug: { 'tranche-a': [{ number: 101, state: 'OPEN', milestone: null }] }
    })

    const r = runCli(['milestone', 'adopt', '--target', 'no-such-goal-v1', '--slug', 'tranche-a'], cwd)

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('does not exist')
    const log = ghLog()
    expect(log).not.toContain('issue edit')
    expect(log).not.toContain('PATCH')
  })

  it('refuses a target that is closed before any write', () => {
    installFakeAdoptGh({
      labels: ['vinaya/tranche:tranche-a'],
      milestones: [{ number: 10, title: 'closed-goal-v1', state: 'closed' }],
      issuesBySlug: { 'tranche-a': [{ number: 101, state: 'OPEN', milestone: null }] }
    })

    const r = runCli(['milestone', 'adopt', '--target', 'closed-goal-v1', '--slug', 'tranche-a'], cwd)

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('is closed')
    const log = ghLog()
    expect(log).not.toContain('issue edit')
    expect(log).not.toContain('PATCH')
  })

  it('refuses a slug already adopted into a different Milestone before any write', () => {
    installFakeAdoptGh({
      labels: ['vinaya/tranche:tranche-a'],
      milestones: [target],
      issuesBySlug: {
        'tranche-a': [{ number: 101, state: 'OPEN', milestone: { title: 'other-goal-v1' } }]
      }
    })

    const r = runCli(['milestone', 'adopt', '--target', 'test-goal-v1', '--slug', 'tranche-a'], cwd)

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('already-adopted')
    const log = ghLog()
    expect(log).not.toContain('issue edit')
    expect(log).not.toContain('PATCH')
  })

  it('writes nothing — not even the valid slug — when one slug in the batch is invalid', () => {
    installFakeAdoptGh({
      labels: ['vinaya/tranche:tranche-a'],
      milestones: [target],
      issuesBySlug: {
        'tranche-a': [{ number: 201, state: 'OPEN', milestone: null }]
      }
    })

    const r = runCli(
      ['milestone', 'adopt', '--target', 'test-goal-v1', '--slug', 'tranche-a', '--slug', 'no-such-tranche'],
      cwd
    )

    expect(r.status).toBe(1)
    expect(r.stderr).toContain('unknown-slug')
    const log = ghLog()
    expect(log).not.toContain('issue edit 201')
    expect(log).not.toContain('PATCH')
  })
})
