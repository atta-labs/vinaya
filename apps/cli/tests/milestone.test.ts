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
type MilestoneFixture = { number: number; title: string; description?: string; state: 'open' | 'closed' }

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

/**
 * Shared by every fake-`gh`-on-PATH fixture in this file: a fresh scratch
 * dir plus an empty log file, ready for a fixture-specific script to be
 * written into it. Split from `activateFakeGh` because a script's own
 * content sometimes needs the log/stdin paths this returns (e.g. `edit`'s
 * fixture embeds `gh.stdin`'s path in the script it writes).
 */
function newFakeGhBinDir(prefix: string): { dir: string; log: string } {
  const dir = join(tmpdir(), `vinaya-${prefix}-gh-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'gh.log')
  writeFileSync(log, '')
  return { dir, log }
}

/** Writes the fake `gh` script and puts `dir` at the front of PATH — the second half every fixture shares. */
function activateFakeGh(dir: string, script: string): void {
  writeFileSync(join(dir, 'gh'), script, { mode: 0o755 })
  originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath ?? ''}`
}

function installFakeAdoptGh(opts: {
  labels: string[]
  milestones: MilestoneFixture[]
  issuesBySlug: Record<string, IssueFixture[]>
}): void {
  const { dir, log } = newFakeGhBinDir('adopt')
  binDir = dir
  logPath = log
  activateFakeGh(dir, fakeAdoptGh(log, opts))
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

// ---------------------------------------------------------------------------
// `vinaya milestone edit` — same fake-`gh`-on-PATH technique, but the fake
// captures stdin too: `edit`'s write is a `gh api -X PATCH --input -`, and
// the round-trip test needs the exact bytes sent, not just that a PATCH fired.
// ---------------------------------------------------------------------------

let stdinPath: string

/** `patchFails: true` simulates the PATCH request itself failing (e.g. a 404) — the fake still captures stdin first, so a failure test can assert what was ABOUT to be sent. */
function fakeEditGh(logPathArg: string, stdinPathArg: string, milestoneNumber: number, patchFails: boolean): string {
  const patchCase = patchFails
    ? `cat > "${stdinPathArg}"; echo 'gh: milestone not found (HTTP 404)' 1>&2; exit 1`
    : `cat > "${stdinPathArg}"; echo '{"number":${milestoneNumber},"html_url":"https://github.com/test-owner/test-repo/milestone/${milestoneNumber}"}'`
  return `#!/usr/bin/env sh
echo "$@" >> "${logPathArg}"
case "$*" in
  *"-X PATCH"*) ${patchCase} ;;
  *) echo '[]' ;;
esac
exit 0
`
}

function installFakeEditGh(milestoneNumber: number, opts?: { patchFails?: boolean }): void {
  const { dir, log } = newFakeGhBinDir('edit')
  binDir = dir
  logPath = log
  stdinPath = join(dir, 'gh.stdin')
  activateFakeGh(dir, fakeEditGh(log, stdinPath, milestoneNumber, opts?.patchFails ?? false))
}

describe('vinaya milestone edit', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-milestone-edit-test-'))
    initGitRepo(cwd)
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    process.env.PATH = originalPath
    rmSync(binDir, { recursive: true, force: true })
  })

  it('refuses a malformed body before the write — nothing reaches the forge', () => {
    installFakeEditGh(12)
    const bodyFile = writeBody(cwd, 'body.md', 'Release: 1.0.0')
    const r = runCli(['milestone', 'edit', '12', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('milestone-shape')
    expect(ghLog()).not.toContain('PATCH')
  })

  it('a well-formed body round-trips: the PATCH sent carries the exact same description', () => {
    installFakeEditGh(12)
    const body = [
      'Determinism hardening.',
      '',
      'Release: 0.20.0',
      '',
      '### Tranche intents',
      '- vinaya-engine-v1: engine work covered by this goal.'
    ].join('\n')
    const bodyFile = writeBody(cwd, 'body.md', body)
    const r = runCli(['milestone', 'edit', '12', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('milestone/12')
    expect(ghLog()).toContain('-X PATCH repos/test-owner/test-repo/milestones/12')
    const sent = JSON.parse(readFileSync(stdinPath, 'utf8')) as { description: string }
    expect(sent.description).toBe(body)
  })

  it('the PATCH payload never carries a title field — only the description changes', () => {
    installFakeEditGh(12)
    const bodyFile = writeBody(cwd, 'body.md', 'A well-formed goal, no version, no intents yet.')
    const r = runCli(['milestone', 'edit', '12', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(0)
    const sent = JSON.parse(readFileSync(stdinPath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(sent)).toEqual(['description'])
  })

  it('surfaces a PATCH failure as a refusal instead of crashing', () => {
    installFakeEditGh(12, { patchFails: true })
    const bodyFile = writeBody(cwd, 'body.md', 'A well-formed goal, no version, no intents yet.')
    const r = runCli(['milestone', 'edit', '12', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('forge-fetch')
    expect(finding.message).toContain('milestone not found')
    // The fake still captures what was about to be sent — proves the CLI
    // reached the real gh call with the right body before gh itself failed.
    const sent = JSON.parse(readFileSync(stdinPath, 'utf8')) as { description: string }
    expect(sent.description).toContain('A well-formed goal')
  })

  it('--validate-only writes nothing', () => {
    installFakeEditGh(12)
    const bodyFile = writeBody(cwd, 'body.md', 'A well-formed goal, no version, no intents yet.')
    const r = runCli(['milestone', 'edit', '12', '--validate-only', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('PASS')
    expect(ghLog()).not.toContain('PATCH')
  })

  it('refuses when the Milestone number is missing', () => {
    installFakeEditGh(12)
    const bodyFile = writeBody(cwd, 'body.md', 'A goal.')
    const r = runCli(['milestone', 'edit', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.message).toContain('Milestone number')
    expect(ghLog()).not.toContain('PATCH')
  })

  it('refuses a non-numeric Milestone number before any write — it is interpolated straight into a gh api REST path', () => {
    installFakeEditGh(12)
    const bodyFile = writeBody(cwd, 'body.md', 'A goal.')
    const r = runCli(['milestone', 'edit', 'twelve', '--body-file', bodyFile], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.message).toContain('digits only')
    expect(ghLog()).not.toContain('PATCH')
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

  // Reproduces the exact shape `vinaya-milestone-model-v1` was found stranded
  // in on the live forge: its Issues carry no native milestone at all
  // (`milestone: null`, never `demilestoned` — confirmed via the live Issue
  // timelines, which show neither a `milestoned` nor `demilestoned` event
  // ever), and its own legacy 1:1 Milestone is ALREADY closed — because that
  // Milestone was closed by `archive tranche` (which only ever closes-by-title,
  // never reattaches) before `adopt` existed at all, not by a prior, buggy
  // `adopt` run. Root-cause finding: this is a SKIPPED reattach — `adopt` was
  // simply never invoked for this slug — not a partial-write or ordering bug
  // in the code below, which (as this test proves) reattaches every Issue and
  // correctly no-ops on an already-closed legacy Milestone.
  it('reattaches a tranche whose Issues carry no Milestone and whose legacy Milestone is already closed', () => {
    installFakeAdoptGh({
      labels: ['vinaya/tranche:stranded-tranche'],
      milestones: [target, { number: 8, title: 'stranded-tranche', state: 'closed' }],
      issuesBySlug: {
        'stranded-tranche': [
          { number: 191, state: 'CLOSED', milestone: null },
          { number: 192, state: 'CLOSED', milestone: null }
        ]
      }
    })

    const r = runCli(['milestone', 'adopt', '--target', 'test-goal-v1', '--slug', 'stranded-tranche'], cwd)

    expect(r.status).toBe(0)
    const log = ghLog()
    expect(log).toContain('issue edit 191 -R test-owner/test-repo --milestone test-goal-v1')
    expect(log).toContain('issue edit 192 -R test-owner/test-repo --milestone test-goal-v1')
    // Legacy Milestone #8 was already closed — no PATCH should re-close it.
    expect(log).not.toContain('milestones/8')
    expect(r.stdout).toContain('stranded-tranche: 2 Issue(s)')
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

// ---------------------------------------------------------------------------
// `vinaya milestone close` (Issue #301) — the attachment gate the raw
// `gh api .../milestones/<n> -X PATCH -f state=closed` recipe in
// `tranche-archivist.md` step 3 never had. Same fake-`gh`-on-PATH technique:
// one case for the Milestone list fetch, one for the `--label`-filtered
// labeled-Issue fetch, one for the `--milestone`-filtered attached-Issue
// fetch, and PATCH for the close write itself.
// ---------------------------------------------------------------------------

function fakeCloseGh(
  logPathArg: string,
  opts: {
    milestones: MilestoneFixture[]
    labeledIssuesBySlug: Record<string, IssueFixture[]>
    attachedIssuesByTitle: Record<string, IssueFixture[]>
  }
): string {
  // `printf '%s\n'`, never `echo` — a Milestone description can carry real
  // newlines (`### Tranche intents` needs its own line), and dash's `echo`
  // is XSI-conformant: it reinterprets a literal `\n` inside the quoted JSON
  // as an actual newline BEFORE `gh api`'s caller ever sees it, corrupting
  // the JSON (`Unterminated string`) the moment a fixture's description
  // isn't single-line. `printf`'s `%s` argument is never escape-expanded.
  const milestonesJson = JSON.stringify(opts.milestones)
  const labelCases = Object.entries(opts.labeledIssuesBySlug)
    .map(([slug, issues]) => `  *"--label vinaya/tranche:${slug}"*) printf '%s\\n' '${JSON.stringify(issues)}' ;;`)
    .join('\n')
  const attachedCases = Object.entries(opts.attachedIssuesByTitle)
    .map(([title, issues]) => `  *"--milestone ${title} --state"*) printf '%s\\n' '${JSON.stringify(issues)}' ;;`)
    .join('\n')
  return `#!/usr/bin/env sh
echo "$@" >> "${logPathArg}"
case "$*" in
  *"milestones?state=all"*) printf '%s\\n' '${milestonesJson}' ;;
${labelCases}
${attachedCases}
  *"-X PATCH"*) printf '%s\\n' '{"number":1,"html_url":"https://github.com/test-owner/test-repo/milestone/1"}' ;;
  *) printf '%s\\n' '[]' ;;
esac
exit 0
`
}

function installFakeCloseGh(opts: {
  milestones: MilestoneFixture[]
  labeledIssuesBySlug: Record<string, IssueFixture[]>
  attachedIssuesByTitle: Record<string, IssueFixture[]>
}): void {
  const { dir, log } = newFakeGhBinDir('close')
  binDir = dir
  logPath = log
  activateFakeGh(dir, fakeCloseGh(log, opts))
}

describe('vinaya milestone close', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-milestone-close-test-'))
    initGitRepo(cwd)
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    process.env.PATH = originalPath
    rmSync(binDir, { recursive: true, force: true })
  })

  it('closes the legacy-titled Milestone when every labeled Issue is attached and nothing foreign is (clean path)', () => {
    installFakeCloseGh({
      milestones: [{ number: 5, title: 'tranche-a', state: 'open' }],
      labeledIssuesBySlug: {
        'tranche-a': [
          { number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } },
          { number: 102, state: 'CLOSED', milestone: { title: 'tranche-a' } }
        ]
      },
      attachedIssuesByTitle: {
        'tranche-a': [
          { number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } },
          { number: 102, state: 'CLOSED', milestone: { title: 'tranche-a' } }
        ]
      }
    })

    const r = runCli(['milestone', 'close', '--slug', 'tranche-a'], cwd)

    expect(r.status).toBe(0)
    expect(ghLog()).toContain('-X PATCH repos/test-owner/test-repo/milestones/5')
    expect(r.stdout).toContain('milestone/1')
  })

  it('resolves an intent-declared Milestone by its own title, not the slug, and closes it (clean path)', () => {
    const description = ['Ship the Engine.', '', '### Tranche intents', '- engine-v1: Real agent spawn.'].join('\n')
    installFakeCloseGh({
      milestones: [{ number: 64, title: 'Engine', description, state: 'open' }],
      labeledIssuesBySlug: {
        'engine-v1': [{ number: 981, state: 'CLOSED', milestone: { title: 'Engine' } }]
      },
      attachedIssuesByTitle: {
        Engine: [{ number: 981, state: 'CLOSED', milestone: { title: 'Engine' } }]
      }
    })

    const r = runCli(['milestone', 'close', '--slug', 'engine-v1'], cwd)

    expect(r.status).toBe(0)
    expect(ghLog()).toContain('-X PATCH repos/test-owner/test-repo/milestones/64')
  })

  it('refuses — names the Issue and the repair path — when a labeled Issue is never attached (the live #301 defect)', () => {
    installFakeCloseGh({
      milestones: [{ number: 5, title: 'tranche-a', state: 'open' }],
      labeledIssuesBySlug: {
        'tranche-a': [
          { number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } },
          { number: 102, state: 'CLOSED', milestone: null }
        ]
      },
      attachedIssuesByTitle: {
        'tranche-a': [{ number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } }]
      }
    })

    const r = runCli(['milestone', 'close', '--slug', 'tranche-a'], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('milestone-close')
    expect(finding.message).toContain('#102')
    expect(finding.agent_recovery_prompt).toContain('gh issue edit')
    expect(ghLog()).not.toContain('PATCH')
  })

  it("refuses — names the foreign Issue — when the Milestone holds an Issue outside the closing tranche's label", () => {
    installFakeCloseGh({
      milestones: [{ number: 5, title: 'tranche-a', state: 'open' }],
      labeledIssuesBySlug: {
        'tranche-a': [{ number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } }]
      },
      attachedIssuesByTitle: {
        'tranche-a': [
          { number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } },
          { number: 999, state: 'OPEN', milestone: { title: 'tranche-a' } }
        ]
      }
    })

    const r = runCli(['milestone', 'close', '--slug', 'tranche-a'], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('milestone-close')
    expect(finding.message).toContain('#999')
    expect(finding.message).toContain('do not carry')
    expect(ghLog()).not.toContain('PATCH')
  })

  it('refuses before any write when no open Milestone resolves for the slug', () => {
    installFakeCloseGh({ milestones: [], labeledIssuesBySlug: {}, attachedIssuesByTitle: {} })

    const r = runCli(['milestone', 'close', '--slug', 'no-such-tranche'], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('milestone-close')
    expect(finding.message).toContain('No OPEN Milestone resolves')
    expect(ghLog()).not.toContain('PATCH')
  })

  it('--validate-only verifies attachment and writes nothing', () => {
    installFakeCloseGh({
      milestones: [{ number: 5, title: 'tranche-a', state: 'open' }],
      labeledIssuesBySlug: {
        'tranche-a': [{ number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } }]
      },
      attachedIssuesByTitle: {
        'tranche-a': [{ number: 101, state: 'CLOSED', milestone: { title: 'tranche-a' } }]
      }
    })

    const r = runCli(['milestone', 'close', '--slug', 'tranche-a', '--validate-only'], cwd)

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('verified')
    expect(ghLog()).not.toContain('PATCH')
  })

  it('refuses when --slug is missing', () => {
    installFakeCloseGh({ milestones: [], labeledIssuesBySlug: {}, attachedIssuesByTitle: {} })

    const r = runCli(['milestone', 'close'], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.message).toContain('--slug')
    expect(ghLog()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// `vinaya milestone status` — read-only: for each `- <slug>: …` line in a
// Milestone's `### Tranche intents` section, prints the tranche's derived
// lifecycle and issue counts. Same fake-`gh`-on-PATH technique as every
// sibling `milestone` describe block above: the single-Milestone GET, and
// one `--label`-filtered issue-list per declared slug — the same call
// `deriveTrancheFromForge`'s own `findMilestoneForSlug` (sync) and
// `fetchTrancheIssuesAsync` (async) halves both make, so one case answers
// both.
// ---------------------------------------------------------------------------

type StatusIssueFixture = {
  number: number
  state: 'OPEN' | 'CLOSED'
  stateReason?: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | null
}

function statusIssueJson(issues: StatusIssueFixture[]): string {
  return JSON.stringify(
    issues.map((i) => ({
      number: i.number,
      title: 'x',
      body: '',
      state: i.state,
      labels: [],
      milestone: null,
      stateReason: i.stateReason ?? null
    }))
  )
}

function fakeStatusGh(
  logPathArg: string,
  opts: { milestone: MilestoneFixture; issuesBySlug: Record<string, StatusIssueFixture[]> }
): string {
  const milestoneJson = JSON.stringify(opts.milestone)
  const issueCases = Object.entries(opts.issuesBySlug)
    .map(([slug, issues]) => `  *"--label vinaya/tranche:${slug}"*) printf '%s\\n' '${statusIssueJson(issues)}' ;;`)
    .join('\n')
  return `#!/usr/bin/env sh
echo "$@" >> "${logPathArg}"
case "$*" in
  *"milestones/${opts.milestone.number}"*) printf '%s\\n' '${milestoneJson}' ;;
  *"milestones?state=all"*) printf '%s\\n' '[]' ;;
${issueCases}
  *) printf '%s\\n' '[]' ;;
esac
exit 0
`
}

function installFakeStatusGh(opts: {
  milestone: MilestoneFixture
  issuesBySlug: Record<string, StatusIssueFixture[]>
}): void {
  const { dir, log } = newFakeGhBinDir('status')
  binDir = dir
  logPath = log
  activateFakeGh(dir, fakeStatusGh(log, opts))
}

function installFake404StatusGh(number: number): void {
  const { dir, log } = newFakeGhBinDir('status-404')
  binDir = dir
  logPath = log
  activateFakeGh(
    dir,
    `#!/usr/bin/env sh
echo "$@" >> "${log}"
case "$*" in
  *"milestones/${number}"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  *) printf '%s\\n' '[]' ;;
esac
`
  )
}

describe('vinaya milestone status', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-milestone-status-test-'))
    initGitRepo(cwd)
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    process.env.PATH = originalPath
    rmSync(binDir, { recursive: true, force: true })
  })

  it("prints lifecycle and issue counts for planned, active, and complete tranches (brief's own three-slug shape)", () => {
    installFakeStatusGh({
      milestone: {
        number: 15,
        title: 'A task finishes itself',
        state: 'open',
        description: [
          'The goal.',
          '',
          '### Tranche intents',
          '- planned-v1: not started yet.',
          '- active-v1: in flight.',
          '- complete-v1: shipped.'
        ].join('\n')
      },
      issuesBySlug: {
        'planned-v1': [],
        'active-v1': [
          { number: 1, state: 'CLOSED', stateReason: 'COMPLETED' },
          { number: 2, state: 'OPEN' }
        ],
        'complete-v1': [
          { number: 3, state: 'CLOSED', stateReason: 'COMPLETED' },
          { number: 4, state: 'CLOSED', stateReason: 'COMPLETED' },
          { number: 5, state: 'CLOSED', stateReason: 'NOT_PLANNED' }
        ]
      }
    })

    const r = runCli(['milestone', 'status', '15'], cwd)

    expect(r.status).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines[0]).toBe('A task finishes itself (#15, open)')
    expect(lines).toContain('planned-v1 planned 0 issues')
    expect(lines).toContain('active-v1 active 2 issues · 1 merged · 1 open')
    expect(lines).toContain('complete-v1 complete 3 issues · 2 merged · 1 not planned')
  })

  it('--json prints the same rows enveloped, schema 1', () => {
    installFakeStatusGh({
      milestone: {
        number: 15,
        title: 'A task finishes itself',
        state: 'open',
        description: ['Goal.', '', '### Tranche intents', '- planned-v1: not started yet.'].join('\n')
      },
      issuesBySlug: { 'planned-v1': [] }
    })

    const r = runCli(['milestone', 'status', '15', '--json'], cwd)

    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.schema).toBe(1)
    expect(parsed.data.milestone).toEqual({ number: 15, title: 'A task finishes itself', state: 'open' })
    expect(parsed.data.tranches).toEqual([
      { slug: 'planned-v1', lifecycle: 'planned', issues: 0, counts: { merged: 0, open: 0, notPlanned: 0 } }
    ])
  })

  it("a closed Milestone's header says closed", () => {
    installFakeStatusGh({
      milestone: {
        number: 22,
        title: 'Shipped goal',
        state: 'closed',
        description: ['Goal.', '', '### Tranche intents', '- done-v1: finished.'].join('\n')
      },
      issuesBySlug: { 'done-v1': [{ number: 1, state: 'CLOSED', stateReason: 'COMPLETED' }] }
    })

    const r = runCli(['milestone', 'status', '22'], cwd)

    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n')[0]).toBe('Shipped goal (#22, closed)')
  })

  it('prints "no tranche intents declared" when the body has no Tranche intents section', () => {
    installFakeStatusGh({
      milestone: { number: 30, title: 'No intents yet', state: 'open', description: 'Just a goal, no intents.' },
      issuesBySlug: {}
    })

    const r = runCli(['milestone', 'status', '30'], cwd)

    expect(r.status).toBe(0)
    expect(r.stdout.trim().split('\n')).toEqual(['No intents yet (#30, open)', 'no tranche intents declared'])
  })

  it('refuses with the number when the Milestone does not exist', () => {
    installFake404StatusGh(999)

    const r = runCli(['milestone', 'status', '999'], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('milestone-status')
    expect(finding.message).toContain('999')
  })

  it('refuses when the number argument is missing or not digits', () => {
    installFakeStatusGh({ milestone: { number: 1, title: 'x', state: 'open', description: '' }, issuesBySlug: {} })

    const r = runCli(['milestone', 'status'], cwd)

    expect(r.status).toBe(1)
    const finding = JSON.parse(r.stderr.trim().split('\n')[0] as string)
    expect(finding.check).toBe('forge-args')
    expect(ghLog()).toBe('')
  })
})
