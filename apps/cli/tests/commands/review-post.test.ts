import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict, OBJECTIVES_SINCE_ISSUE } from '@attalabs/aeg-core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  checkObjectiveIdCoverage,
  checkRenderedComment,
  deriveCodeReviewVerdict,
  deriveSecurityVerdict,
  type Finding,
  findingsOutsideDelta,
  findPriorVerdictComment,
  invalidObjectiveEvidenceReason,
  isEscalationClass,
  missingPriorIds,
  type ObjectiveResult,
  ObjectivesParseError,
  parseChangedLineRanges,
  parseObjectivesFile,
  parsePriorFindingIds,
  renderCodeReviewComment,
  renderEscalationComment,
  renderObjectivesBlock,
  renderSecurityComment,
  verifyPostedCodeReview,
  verifyPostedEscalation,
  verifyPostedSecurity
} from '../../src/commands/review-post'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX = join(CLI_ROOT, 'src', 'index.ts')
const HEAD = 'a'.repeat(40)
const TOKENS = {
  taskId: 't',
  model: 'claude-sonnet-5',
  tokensIn: '-',
  tokensOut: '-',
  cost: '-',
  sessionId: 'sess-abc123'
}

type CliResult = { status: number; stdout: string; stderr: string }

function runCli(args: string[], opts: { cwd: string; env?: Record<string, string | undefined> }): CliResult {
  try {
    const stdout = execFileSync('bun', [INDEX, ...args], {
      cwd: opts.cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? process.env
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/**
 * A deliberately broken `gh`, placed ahead of the real one on `PATH` — the
 * same trick `pr-verify-evidence-cwd.test.ts` uses. Any refusal test that
 * claims "before any forge contact" runs against this: if the command ever
 * actually calls `gh`, the stub's stderr line proves it and the test fails
 * loudly rather than passing for the wrong reason.
 */
function brokenGhPath(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-broken-'))
  const gh = join(dir, 'gh')
  writeFileSync(gh, '#!/bin/sh\necho "gh: unreachable (test stub)" >&2\nexit 1\n')
  chmodSync(gh, 0o755)
  return { dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}` } }
}

/**
 * A working `gh` stub that serves `pr view --json headRefName`, `pr view
 * --json headRefOid`, `pr view --json comments`, `api .../git/ref/heads/<branch>`
 * and `pr comment --body-file` against a small JSON state file in `stateDir`
 * — round-tripping a posted comment back into the next `--json comments`
 * fetch, the way the real forge does. Writing it as a Bun script (not
 * `/bin/sh`) is what makes the JSON read-modify-write tractable.
 *
 * `headRefName` resolves to a branch name no real repo under test ever
 * literally has (`stub-branch`), so `git ls-remote origin refs/heads/<name>`
 * always comes back empty and `resolveHeadSha` falls through to the
 * `git/ref/heads` API stub below, which answers with the same `headSha` the
 * caller passed — preserving every existing test's semantics (the value
 * that used to come straight from `headRefOid`) without asserting anything
 * about a real branch's true head. The stale-vs-true disagreement itself is
 * covered by its own dedicated test, below, against a real throwaway repo.
 */
function workingGhPath(
  stateDir: string,
  headSha: string,
  author: string
): { dir: string; env: Record<string, string> } {
  // Seed empty only if the caller hasn't already seeded fixture comments —
  // `seedComments` may run before or after this, and must never be clobbered.
  try {
    readFileSync(join(stateDir, 'comments.json'), 'utf8')
  } catch {
    writeFileSync(join(stateDir, 'comments.json'), '[]')
  }
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-working-'))
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const commentsPath = ${JSON.stringify(join(stateDir, 'comments.json'))}
function readComments() {
  try { return JSON.parse(readFileSync(commentsPath, 'utf8')) } catch { return [] }
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefName')) {
  process.stdout.write('stub-branch')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid')) {
  process.stdout.write(${JSON.stringify(headSha)})
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/git/ref/heads/stub-branch') {
  process.stdout.write(${JSON.stringify(headSha)})
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
  process.stdout.write('Closes #1')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
  const list = readComments()
  process.stdout.write(JSON.stringify({ comments: list.map((c) => ({ body: c.body, author: { login: c.author } })) }))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'comment') {
  const bodyFile = args[args.indexOf('--body-file') + 1]
  const body = readFileSync(bodyFile, 'utf8')
  const list = readComments()
  list.push({ body, author: ${JSON.stringify(author)} })
  writeFileSync(commentsPath, JSON.stringify(list))
  process.stdout.write('https://github.com/atta-labs/vinaya/pull/1#issuecomment-1')
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
  )
  chmodSync(gh, 0o755)
  return { dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}` } }
}

function seedComments(stateDir: string, comments: Array<{ body: string; author: string }>): void {
  writeFileSync(join(stateDir, 'comments.json'), JSON.stringify(comments))
}

/**
 * Same shape as `workingGhPath`, plus a caller-chosen PR body (`resolveObjectivesForPr`'s
 * `gh pr view --json body` read) and an optional Issue body (`gh issue view`,
 * only reached when `prBody` carries a `Closes #N` at/above `OBJECTIVES_SINCE_ISSUE`)
 * — for the objectives-resolution tests below, which need to control what
 * `resolveObjectivesForPr` sees.
 */
function workingGhPathWithObjectives(
  stateDir: string,
  headSha: string,
  author: string,
  prBody: string,
  issueBody?: string
): { dir: string; env: Record<string, string> } {
  try {
    readFileSync(join(stateDir, 'comments.json'), 'utf8')
  } catch {
    writeFileSync(join(stateDir, 'comments.json'), '[]')
  }
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-objectives-'))
  const gh = join(dir, 'gh')
  writeFileSync(
    gh,
    `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const commentsPath = ${JSON.stringify(join(stateDir, 'comments.json'))}
function readComments() {
  try { return JSON.parse(readFileSync(commentsPath, 'utf8')) } catch { return [] }
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefName')) {
  process.stdout.write('stub-branch')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid')) {
  process.stdout.write(${JSON.stringify(headSha)})
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/git/ref/heads/stub-branch') {
  process.stdout.write(${JSON.stringify(headSha)})
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
  process.stdout.write(${JSON.stringify(prBody)})
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'view') {
  ${issueBody === undefined ? "process.stderr.write('GraphQL: could not resolve to an Issue with the number of 1.')\n  process.exit(1)" : `process.stdout.write(${JSON.stringify(issueBody)})\n  process.exit(0)`}
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
  const list = readComments()
  process.stdout.write(JSON.stringify({ comments: list.map((c) => ({ body: c.body, author: { login: c.author } })) }))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'comment') {
  const bodyFile = args[args.indexOf('--body-file') + 1]
  const body = readFileSync(bodyFile, 'utf8')
  const list = readComments()
  list.push({ body, author: ${JSON.stringify(author)} })
  writeFileSync(commentsPath, JSON.stringify(list))
  process.stdout.write('https://github.com/atta-labs/vinaya/pull/1#issuecomment-1')
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
  )
  chmodSync(gh, 0o755)
  return { dir, env: { PATH: `${dir}:${process.env.PATH ?? ''}` } }
}

describe('deriveCodeReviewVerdict — the command decides, not the caller', () => {
  it('no findings → APPROVE', () => {
    expect(deriveCodeReviewVerdict([])).toBe('APPROVE')
  })
  it('MAJOR only → APPROVE', () => {
    expect(deriveCodeReviewVerdict([{ severity: 'MAJOR', location: 'a.ts:1', description: 'x' }])).toBe('APPROVE')
  })
  it('one BLOCKER → REQUEST_CHANGES', () => {
    expect(
      deriveCodeReviewVerdict([
        { severity: 'MINOR', location: 'a.ts:1', description: 'x' },
        { severity: 'BLOCKER', location: 'b.ts:2', description: 'y' }
      ])
    ).toBe('REQUEST_CHANGES')
  })
})

describe('deriveSecurityVerdict — the command decides, not the caller', () => {
  it('no findings → PASS', () => {
    expect(deriveSecurityVerdict([])).toBe('PASS')
  })
  it('MEDIUM/LOW only → PASS', () => {
    expect(
      deriveSecurityVerdict([
        { severity: 'MEDIUM', location: 'a.ts:1', description: 'x' },
        { severity: 'LOW', location: 'b.ts:1', description: 'y' }
      ])
    ).toBe('PASS')
  })
  it('a HIGH → FAIL', () => {
    expect(deriveSecurityVerdict([{ severity: 'HIGH', location: 'a.ts:1', description: 'x' }])).toBe('FAIL')
  })
  it('a CRITICAL → FAIL', () => {
    expect(deriveSecurityVerdict([{ severity: 'CRITICAL', location: 'a.ts:1', description: 'x' }])).toBe('FAIL')
  })
})

describe('review post — end-to-end derivation refusals (brief Test Plan)', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-derive-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('--escalate together with --verdict refuses before any forge contact', () => {
    const { dir, env } = brokenGhPath()
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--escalate',
          'strategy',
          '--summary',
          'x',
          '--verdict',
          'APPROVE',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--escalate')
      expect(r.stderr).toContain('--verdict')
      expect(r.stderr).not.toContain('unreachable (test stub)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a BLOCKER finding with --verdict APPROVE refuses naming REQUEST_CHANGES, before any forge contact', () => {
    const { dir, env } = brokenGhPath()
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, 'BLOCKER|src/foo.ts:1|off-by-one\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--verdict',
          'APPROVE',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('REQUEST_CHANGES')
      expect(r.stderr).not.toContain('unreachable (test stub)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a matching --verdict is accepted (no disagreement refusal) — proceeds to (and fails on) the forge call', () => {
    const { dir, env } = brokenGhPath()
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, 'MAJOR|src/foo.ts:1|nit\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--verdict',
          'APPROVE',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      // No disagreement — reaches the forge call, which the broken stub fails.
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('unreachable (test stub)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('omitting --verdict entirely derives it silently', () => {
    const { dir, env } = brokenGhPath()
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, 'BLOCKER|src/foo.ts:1|off-by-one\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      // No --verdict given at all: derives REQUEST_CHANGES and proceeds to the forge call.
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('unreachable (test stub)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isEscalationClass', () => {
  it('accepts the three declared classes', () => {
    expect(isEscalationClass('authority')).toBe(true)
    expect(isEscalationClass('strategy')).toBe(true)
    expect(isEscalationClass('product')).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isEscalationClass('urgent')).toBe(false)
    expect(isEscalationClass('')).toBe(false)
  })
})

describe('renderEscalationComment — never a line the gate reads as a verdict', () => {
  it('renders ESCALATE and Judged head, and carries no VERDICT substring anywhere', () => {
    const body = renderEscalationComment({
      ...TOKENS,
      headSha: HEAD,
      escalationClass: 'strategy',
      summary: 'the brief assumes approach A but the codebase went a different way',
      role: 'review',
      roleLabel: 'Reviewer',
      objectivesVersion: null
    })
    expect(body).toContain('ESCALATE: strategy')
    expect(body).toContain(`Judged head: ${HEAD}`)
    expect(body).not.toContain('VERDICT')
  })

  it('self-verifies as no-verdict through both real gate extractors', () => {
    const body = renderEscalationComment({
      ...TOKENS,
      headSha: HEAD,
      escalationClass: 'product',
      summary: 'x',
      role: 'security',
      roleLabel: 'Security',
      objectivesVersion: null
    })
    expect(extractCodeReviewVerdict([body]).danglingNote).not.toBeNull()
    expect(extractSecurityReviewVerdict([body]).danglingNote).not.toBeNull()
    expect(verifyPostedEscalation([{ body, author: 'daniboomerang' }], body).ok).toBe(true)
  })

  it('a real VERDICT comment present elsewhere does not make an unrelated escalation self-verify clean — verifyPostedEscalation matches by exact posted body', () => {
    const escalation = renderEscalationComment({
      ...TOKENS,
      headSha: HEAD,
      escalationClass: 'authority',
      summary: 'x',
      role: 'review',
      roleLabel: 'Reviewer',
      objectivesVersion: null
    })
    const result = verifyPostedEscalation([{ body: 'VERDICT: APPROVE', author: 'daniboomerang' }], escalation)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('could not be found on re-fetch')
  })
})

describe('review post — escalation refusals (brief Part 2)', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-escalate-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('refuses an unknown escalation class before any forge contact', () => {
    const { dir, env } = brokenGhPath()
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--escalate',
          'urgent',
          '--summary',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('authority')
      expect(r.stderr).toContain('strategy')
      expect(r.stderr).toContain('product')
      expect(r.stderr).not.toContain('unreachable (test stub)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an escalation carrying a BLOCKER finding, before any forge contact', () => {
    const { dir, env } = brokenGhPath()
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, 'BLOCKER|src/foo.ts:1|off-by-one\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--escalate',
          'strategy',
          '--summary',
          'x',
          '--findings-file',
          findingsFile,
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('BLOCKER')
      expect(r.stderr).not.toContain('unreachable (test stub)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an escalation carrying a CRITICAL/HIGH finding for the security role', () => {
    const { dir, env } = brokenGhPath()
    const findingsFile = join(cwd, 'findings.txt')
    writeFileSync(findingsFile, 'HIGH|src/foo.ts:1|hardcoded key\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'security',
          '--pr',
          '1',
          '--escalate',
          'authority',
          '--summary',
          'x',
          '--findings-file',
          findingsFile,
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('CRITICAL/HIGH')
      expect(r.stderr).not.toContain('unreachable (test stub)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('posts and self-verifies a clean escalation end-to-end', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gh-state-'))
    const { dir, env } = workingGhPath(stateDir, HEAD, 'daniboomerang')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--escalate',
          'strategy',
          '--summary',
          'the brief needs a Type 1 decision it does not specify',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('ESCALATE: strategy')
      expect(r.stdout).toContain('Self-verification: clean')
      // The rendered, actually-posted comment — not just the pure-function
      // unit test above — never contains the substring the merge-verdict
      // workflow triggers on.
      expect(r.stdout).not.toContain('VERDICT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('review post — verdict binds to the true branch head, not a stale headRefOid (Issue #402 O1)', () => {
  it('resolves the head via git ls-remote over gh pr view headRefOid, warning on disagreement', () => {
    const repo = mkdtempSync(join(tmpdir(), 'vinaya-review-post-truehead-'))
    const identityEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'x',
      GIT_AUTHOR_EMAIL: 'x@x.com',
      GIT_COMMITTER_NAME: 'x',
      GIT_COMMITTER_EMAIL: 'x@x.com'
    }
    execFileSync('git', ['init', '-q'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'old'], { cwd: repo, env: identityEnv })
    const oldSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    // The push `gh pr view` hasn't caught up with yet.
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'new'], { cwd: repo, env: identityEnv })
    const newSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    execFileSync('git', ['remote', 'add', 'origin', repo], { cwd: repo })
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    const stateDir = mkdtempSync(join(tmpdir(), 'gh-state-truehead-'))
    writeFileSync(join(stateDir, 'comments.json'), '[]')
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-truehead-'))
    const gh = join(dir, 'gh')
    writeFileSync(
      gh,
      `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const commentsPath = ${JSON.stringify(join(stateDir, 'comments.json'))}
function readComments() {
  try { return JSON.parse(readFileSync(commentsPath, 'utf8')) } catch { return [] }
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefName')) {
  process.stdout.write(${JSON.stringify(branch)})
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid')) {
  process.stdout.write(${JSON.stringify(oldSha)})
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
  process.stdout.write('Closes #1')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view' && args.includes('comments')) {
  const list = readComments()
  process.stdout.write(JSON.stringify({ comments: list.map((c) => ({ body: c.body, author: { login: c.author } })) }))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'comment') {
  const bodyFile = args[args.indexOf('--body-file') + 1]
  const body = readFileSync(bodyFile, 'utf8')
  const list = readComments()
  list.push({ body, author: 'daniboomerang' })
  writeFileSync(commentsPath, JSON.stringify(list))
  process.stdout.write('https://github.com/atta-labs/vinaya/pull/1#issuecomment-1')
  process.exit(0)
}
process.stderr.write('gh stub: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
    )
    chmodSync(gh, 0o755)
    const env = { PATH: `${dir}:${process.env.PATH ?? ''}` }
    try {
      // `spawnSync`, not `runCli`: `runCli` discards stderr on a successful
      // (exit 0) run, and the headRefOid-disagreement warning below is
      // logged on the success path, not a failure path.
      const r = spawnSync(
        'bun',
        [
          INDEX,
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } }
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain(`Judged head: ${newSha}`)
      expect(r.stdout).not.toContain(oldSha)
      expect(r.stderr).toContain('disagrees with the true head')
      expect(r.stderr).toContain(oldSha)
      expect(r.stderr).toContain(newSha)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('parsePriorFindingIds', () => {
  it('reads ids off rendered finding lines and the Judged head line', () => {
    const body = [
      'VERDICT: REQUEST CHANGES',
      '',
      `Judged head: ${HEAD}`,
      '',
      'FINDINGS (ordered by severity):',
      '1. [BLOCKER] a.ts:1 — F1 correctness: off-by-one',
      '2. [MINOR] b.ts:2 — F2 readability: nit'
    ].join('\n')
    expect(parsePriorFindingIds(body)).toEqual({ ids: ['F1', 'F2'], objectiveIds: [], judgedHead: HEAD })
  })

  it('de-duplicates a repeated id and returns null judgedHead when absent', () => {
    const body = '1. [MAJOR] a.ts:1 — F3 perf: slow\n2. [MAJOR] a.ts:2 — F3 perf resolved: fixed'
    expect(parsePriorFindingIds(body)).toEqual({ ids: ['F3'], objectiveIds: [], judgedHead: null })
  })

  it('finds no ids in an ordinary "None." findings section', () => {
    expect(parsePriorFindingIds('FINDINGS (ordered by severity):\nNone.').ids).toEqual([])
  })

  it('reads objective ids off a rendered OBJECTIVES: block too (#412, O1), de-duplicated', () => {
    const body = ['OBJECTIVES:', 'O1: MET — clean.', 'O2: NOT MET — missing test.', 'O1: MET — clean.'].join('\n')
    expect(parsePriorFindingIds(body).objectiveIds).toEqual(['O1', 'O2'])
  })
})

describe('missingPriorIds', () => {
  it('is empty when every prior id is carried forward with a state', () => {
    const findings: Finding[] = [
      { severity: 'MINOR', location: 'a.ts:1', description: 'F1 readability resolved: fixed' }
    ]
    expect(missingPriorIds(['F1'], findings)).toEqual([])
  })

  it('names an id present with no state token as still missing', () => {
    const findings: Finding[] = [
      { severity: 'MINOR', location: 'a.ts:1', description: 'F1 readability: still here, no state' }
    ]
    expect(missingPriorIds(['F1'], findings)).toEqual(['F1'])
  })

  it('names an id absent from the new findings file entirely', () => {
    expect(missingPriorIds(['F1', 'F2'], [])).toEqual(['F1', 'F2'])
  })
})

describe('parseChangedLineRanges — bounds are exactly the -U0 hunk headers', () => {
  it('parses a single-file, single-hunk diff', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -5,0 +6,3 @@', '+x', '+y', '+z'].join(
      '\n'
    )
    expect(parseChangedLineRanges(diff)).toEqual({ 'a.ts': [[6, 8]] })
  })

  it('a single-line hunk with no count defaults to a span of one', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-x', '+y'].join('\n')
    expect(parseChangedLineRanges(diff)).toEqual({ 'a.ts': [[1, 1]] })
  })

  it('a pure-deletion hunk (zero new-side count) contributes no range', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3,2 +2,0 @@', '-x', '-y'].join('\n')
    expect(parseChangedLineRanges(diff)).toEqual({})
  })

  it('tracks multiple files independently', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +2,1 @@',
      '+x',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -10,0 +11,2 @@',
      '+y',
      '+z'
    ].join('\n')
    expect(parseChangedLineRanges(diff)).toEqual({ 'a.ts': [[2, 2]], 'b.ts': [[11, 12]] })
  })
})

describe('findingsOutsideDelta', () => {
  const ranges = { 'a.ts': [[10, 20] as [number, number]] }

  it('keeps a finding whose line falls inside a changed range', () => {
    const findings: Finding[] = [{ severity: 'MINOR', location: 'a.ts:15', description: 'x' }]
    expect(findingsOutsideDelta(findings, ranges)).toEqual([])
  })

  it('surfaces a finding whose line falls outside every changed range', () => {
    const findings: Finding[] = [{ severity: 'MINOR', location: 'a.ts:5', description: 'x' }]
    expect(findingsOutsideDelta(findings, ranges)).toEqual(findings)
  })

  it('surfaces a finding in a file with no entry in changedRanges at all', () => {
    const findings: Finding[] = [{ severity: 'MINOR', location: 'other.ts:5', description: 'x' }]
    expect(findingsOutsideDelta(findings, ranges)).toEqual(findings)
  })

  it('surfaces a finding whose location cannot be parsed', () => {
    const findings: Finding[] = [{ severity: 'MINOR', location: 'no-colon-here', description: 'x' }]
    expect(findingsOutsideDelta(findings, ranges)).toEqual(findings)
  })
})

describe('findPriorVerdictComment', () => {
  it('returns null when no comment carries a clear verdict — round one', () => {
    expect(findPriorVerdictComment(['just some prose'], extractCodeReviewVerdict)).toBeNull()
  })

  it('returns the most recent comment that parses clean, matching the extractors\' own "latest wins" rule', () => {
    const older = `VERDICT: REQUEST CHANGES\n\nJudged head: ${'b'.repeat(40)}`
    const newer = `VERDICT: APPROVE\n\nJudged head: ${HEAD}`
    expect(findPriorVerdictComment([older, newer], extractCodeReviewVerdict)).toBe(newer)
  })
})

describe('review post — round-two refusals (brief Part 3), end-to-end against a real throwaway git repo', () => {
  let repo: string
  let stateDir: string
  let judgedHead: string
  let resolvedHead: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vinaya-review-post-round2-repo-'))
    const identityEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'x',
      GIT_AUTHOR_EMAIL: 'x@x.com',
      GIT_COMMITTER_NAME: 'x',
      GIT_COMMITTER_EMAIL: 'x@x.com'
    }
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'foo.ts'), 'line1\nline2\nline3\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env: identityEnv })
    judgedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    writeFileSync(join(repo, 'src', 'foo.ts'), 'line1\nline2\nline3\nline4\nline5\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'add lines 4-5'], { cwd: repo, env: identityEnv })
    resolvedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()

    // `computeChangedRanges` now does `git fetch origin <resolvedHead>` before
    // diffing — a self-referential `origin` (this same repo, by path) makes
    // that fetch a real, successful no-op: every commit it could ask for
    // already exists locally.
    execFileSync('git', ['remote', 'add', 'origin', repo], { cwd: repo })

    stateDir = mkdtempSync(join(tmpdir(), 'gh-state-round2-'))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  })

  function priorComment(findingLine: string): string {
    return [
      'VERDICT: REQUEST CHANGES',
      '',
      `Judged head: ${judgedHead}`,
      '',
      'BRIEF CONFORMANCE: x',
      'SPEC CONFORMANCE: x',
      '',
      'FINDINGS (ordered by severity):',
      findingLine,
      '',
      'SCOPE: x',
      'TESTS: x',
      'DOCS: x'
    ].join('\n')
  }

  it('refuses when the new findings file drops a prior id without a state', () => {
    seedComments(stateDir, [
      { body: priorComment('1. [MINOR] src/foo.ts:4 — F1 readability: nit'), author: 'daniboomerang' }
    ])
    const { dir, env } = workingGhPath(stateDir, resolvedHead, 'daniboomerang')
    const findingsFile = join(repo, 'findings.txt')
    // F1 is never mentioned at all in round two.
    writeFileSync(findingsFile, 'MINOR|src/foo.ts:5|a different nit\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd: repo, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('F1')
      expect(r.stderr).toContain('without a state')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a non-blocking finding whose file:line is outside the delta since the judged head', () => {
    seedComments(stateDir, [
      { body: priorComment('1. [MINOR] src/foo.ts:4 — F1 readability: nit'), author: 'daniboomerang' }
    ])
    const { dir, env } = workingGhPath(stateDir, resolvedHead, 'daniboomerang')
    const findingsFile = join(repo, 'findings.txt')
    // F1 carried forward with a state (satisfies the id-carry check), but a
    // NEW finding sits on line 1 — never touched since judgedHead.
    writeFileSync(
      findingsFile,
      ['MINOR|src/foo.ts:4|F1 readability resolved: fixed', 'MINOR|src/foo.ts:1|unrelated, unchanged line'].join('\n')
    )
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd: repo, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('src/foo.ts:1')
      expect(r.stderr).toContain('outside the diff')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a BLOCKER outside the delta is still accepted — round two never exempts a blocking severity', () => {
    seedComments(stateDir, [
      { body: priorComment('1. [MINOR] src/foo.ts:4 — F1 readability: nit'), author: 'daniboomerang' }
    ])
    const { dir, env } = workingGhPath(stateDir, resolvedHead, 'daniboomerang')
    const findingsFile = join(repo, 'findings.txt')
    writeFileSync(
      findingsFile,
      [
        'MINOR|src/foo.ts:4|F1 readability resolved: fixed',
        'BLOCKER|src/foo.ts:1|a real bug, on an untouched line'
      ].join('\n')
    )
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd: repo, env: { ...process.env, ...env } }
      )
      // Not refused by the outside-delta check — reaches the real post and
      // self-verifies clean against the working stub.
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('VERDICT: REQUEST CHANGES')
      expect(r.stdout).toContain('Self-verification: clean')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prior F1-F3 restated with states at locations outside the delta are accepted — a carried-forward id is never new scope (round 6 ruling on #392, F1)', () => {
    seedComments(stateDir, [
      {
        body: priorComment(
          [
            '1. [MINOR] src/foo.ts:1 — F1 readability: nit',
            '2. [MINOR] src/foo.ts:2 — F2 readability: nit',
            '3. [MINOR] src/foo.ts:3 — F3 readability: nit'
          ].join('\n')
        ),
        author: 'daniboomerang'
      }
    ])
    const { dir, env } = workingGhPath(stateDir, resolvedHead, 'daniboomerang')
    const findingsFile = join(repo, 'findings.txt')
    // All three restated at their TRUE (untouched-since-judgedHead) locations,
    // each carrying a state — none of them is new scope, so the delta filter
    // must not see them at all.
    writeFileSync(
      findingsFile,
      [
        'MINOR|src/foo.ts:1|F1 readability resolved: fixed',
        'MINOR|src/foo.ts:2|F2 readability reproduced: still there',
        'MINOR|src/foo.ts:3|F3 readability open: not yet addressed'
      ].join('\n')
    )
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd: repo, env: { ...process.env, ...env } }
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Self-verification: clean')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a NEW non-blocking finding outside the delta is still refused even when prior ids are correctly carried (round 6 ruling on #392, F1)', () => {
    seedComments(stateDir, [
      { body: priorComment('1. [MINOR] src/foo.ts:4 — F1 readability: nit'), author: 'daniboomerang' }
    ])
    const { dir, env } = workingGhPath(stateDir, resolvedHead, 'daniboomerang')
    const findingsFile = join(repo, 'findings.txt')
    // F1 carried forward with a state at a location outside the delta (fine —
    // it is the record). F4 is brand new, id-less, and also outside the
    // delta — the exemption is for carried ids only, not for every finding
    // once one carried id is present.
    writeFileSync(
      findingsFile,
      ['MINOR|src/foo.ts:4|F1 readability resolved: fixed', 'MINOR|src/foo.ts:2|a brand-new nit, on an old line'].join(
        '\n'
      )
    )
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd: repo, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('src/foo.ts:2')
      expect(r.stderr).toContain('outside the diff')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('no prior verdict comment on the PR — round one, no round-two checks at all', () => {
    seedComments(stateDir, [])
    const { dir, env } = workingGhPath(stateDir, resolvedHead, 'daniboomerang')
    const findingsFile = join(repo, 'findings.txt')
    writeFileSync(findingsFile, 'MINOR|src/foo.ts:1|first-round nit, on an old line\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--findings-file',
          findingsFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd: repo, env: { ...process.env, ...env } }
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Self-verification: clean')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('self-verification refuses cross-role contamination', () => {
  const PRINCIPALS = ['daniboomerang']
  const asComment = (body: string, author: string | null = 'daniboomerang') => [{ body, author }]

  // Both markers are read from a comment's first THREE lines only (round-4
  // ruling, `#392`) — the contaminating line must sit inside that window to
  // actually exercise the check; a line past it would extract as no verdict
  // by construction, proving nothing about the cross-role check itself.
  it('a code-review post that also re-parses as a security VERDICT fails self-verification', () => {
    const body = `VERDICT: APPROVE\nVERDICT: PASS\nJudged head: ${HEAD}`
    const result = verifyPostedCodeReview(asComment(body), 'APPROVE', HEAD, PRINCIPALS, body, null)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('cross-role contamination')
    expect(result.reason).toContain('security')
  })

  it('a security post that also re-parses as a code-review VERDICT fails self-verification', () => {
    const body = `VERDICT: PASS\nVERDICT: APPROVE\nJudged head: ${HEAD}`
    const result = verifyPostedSecurity(asComment(body), 'PASS', HEAD, PRINCIPALS, body, null)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('cross-role contamination')
    expect(result.reason).toContain('code-review')
  })

  it('an ordinary clean code-review post does not trip the cross-role check', () => {
    const body = `VERDICT: APPROVE\n\nJudged head: ${HEAD}`
    expect(verifyPostedCodeReview(asComment(body), 'APPROVE', HEAD, PRINCIPALS, body, null).ok).toBe(true)
  })

  it('an ordinary clean security post does not trip the cross-role check', () => {
    const body = `VERDICT: PASS\n\nJudged head: ${HEAD}`
    expect(verifyPostedSecurity(asComment(body), 'PASS', HEAD, PRINCIPALS, body, null).ok).toBe(true)
  })

  it('a security PASS never cross-reads as a code-review LGTM even though both extractors could plausibly hit unrelated text', () => {
    // Sanity check on the disjoint value vocabularies (APPROVE/REQUEST_CHANGES/LGTM
    // vs PASS/FAIL) — an ordinary security post must never fail this check.
    const body = `VERDICT: PASS\n\nJudged head: ${HEAD}\n\nCONFIG SCAN: clean\nSECRETS: none found`
    expect(verifyPostedSecurity(asComment(body), 'PASS', HEAD, PRINCIPALS, body, null).ok).toBe(true)
  })
})

describe('checkRenderedComment — the pre-post dry run (round-4 ruling: replaces the whole field-guard layer)', () => {
  it('a clean code-review APPROVE passes: intended extractor matches, the other returns none', () => {
    const body = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'x',
      specConformance: 'x',
      findings: [],
      scope: 'x',
      scopeEvidence: null,
      tests: 'x',
      docs: 'x',
      objectivesVersion: null,
      objectiveResults: null
    })
    expect(checkRenderedComment(body, { kind: 'code-review', verdict: 'APPROVE' })).toEqual({ ok: true })
  })

  it('a clean security PASS passes: intended extractor matches, the other returns none', () => {
    const body = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: '(scanner ran, 0 findings)',
      objectivesVersion: null,
      objectiveResults: null
    })
    expect(checkRenderedComment(body, { kind: 'security', verdict: 'PASS' })).toEqual({ ok: true })
  })

  it('a clean escalation passes: both extractors return none', () => {
    const body = renderEscalationComment({
      ...TOKENS,
      headSha: HEAD,
      escalationClass: 'strategy',
      summary: 'x',
      role: 'review',
      roleLabel: 'Reviewer',
      objectivesVersion: null
    })
    expect(checkRenderedComment(body, { kind: 'escalation' })).toEqual({ ok: true })
  })

  it('a real render whose --summary/--scope/findings happen to contain the word VERDICT is now SAFE — those fields never reach the first-three-line read window', () => {
    // The exact content the round-2/round-3 field guards used to refuse
    // outright. Round 4 moved the fix to the extractor's read window
    // (`verdict-extraction.ts`), so this is no longer refused at all — and
    // the pre-post check here proves it still extracts cleanly.
    const body = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'VERDICT: not actually a marker, just prose that mentions it',
      specConformance: 'x',
      findings: [{ severity: 'MINOR', location: 'a.ts:1', description: 'a nit that says VERDICT in passing' }],
      scope: 'clean\nmulti-line is fine now too',
      scopeEvidence: null,
      tests: 'x',
      docs: 'x',
      objectivesVersion: null,
      objectiveResults: null
    })
    expect(checkRenderedComment(body, { kind: 'code-review', verdict: 'APPROVE' })).toEqual({ ok: true })
  })

  it('refuses when the comment does not extract the intended value at all', () => {
    const result = checkRenderedComment('not a real verdict comment', { kind: 'code-review', verdict: 'APPROVE' })
    expect(result.ok).toBe(false)
  })

  it('refuses a manufactured cross-role contamination (a second VERDICT-shaped line inside the first three lines)', () => {
    const body = 'VERDICT: APPROVE\n\nVERDICT: PASS'
    const result = checkRenderedComment(body, { kind: 'code-review', verdict: 'APPROVE' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('cross-role contamination')
  })

  it('refuses a manufactured escalation that also carries a real VERDICT line inside the window', () => {
    const body = 'ESCALATE: strategy\n\nVERDICT: APPROVE'
    const result = checkRenderedComment(body, { kind: 'escalation' })
    expect(result.ok).toBe(false)
  })
})

describe('deriveCodeReviewVerdict / deriveSecurityVerdict — a resolved finding keeps its severity but never drives the verdict', () => {
  it('a BLOCKER marked resolved does not force REQUEST_CHANGES', () => {
    const findings: Finding[] = [
      { severity: 'BLOCKER', location: 'a.ts:1', description: 'F1 correctness resolved: fixed in this round' }
    ]
    expect(deriveCodeReviewVerdict(findings)).toBe('APPROVE')
  })

  it('a BLOCKER marked fix-claimed (not yet resolved) still forces REQUEST_CHANGES', () => {
    const findings: Finding[] = [
      {
        severity: 'BLOCKER',
        location: 'a.ts:1',
        description: 'F1 correctness fix-claimed: says it is fixed, not yet reproduced'
      }
    ]
    expect(deriveCodeReviewVerdict(findings)).toBe('REQUEST_CHANGES')
  })

  it('a BLOCKER with no state token (a brand-new finding) still forces REQUEST_CHANGES', () => {
    const findings: Finding[] = [{ severity: 'BLOCKER', location: 'a.ts:1', description: 'F1 correctness: off-by-one' }]
    expect(deriveCodeReviewVerdict(findings)).toBe('REQUEST_CHANGES')
  })

  it('a resolved BLOCKER alongside an open one still forces REQUEST_CHANGES — one open blocker is enough', () => {
    const findings: Finding[] = [
      { severity: 'BLOCKER', location: 'a.ts:1', description: 'F1 correctness resolved: fixed' },
      { severity: 'BLOCKER', location: 'b.ts:2', description: 'F2 correctness open: still broken' }
    ]
    expect(deriveCodeReviewVerdict(findings)).toBe('REQUEST_CHANGES')
  })

  it('a CRITICAL marked resolved does not force FAIL', () => {
    const findings: Finding[] = [
      { severity: 'CRITICAL', location: 'a.ts:1', description: 'F1 secrets resolved: rotated' }
    ]
    expect(deriveSecurityVerdict(findings)).toBe('PASS')
  })

  it('a HIGH marked resolved does not force FAIL', () => {
    const findings: Finding[] = [
      { severity: 'HIGH', location: 'a.ts:1', description: 'F1 injection resolved: sanitized' }
    ]
    expect(deriveSecurityVerdict(findings)).toBe('PASS')
  })

  it('a HIGH marked reproduced still forces FAIL', () => {
    const findings: Finding[] = [
      { severity: 'HIGH', location: 'a.ts:1', description: 'F1 injection reproduced: still exploitable' }
    ]
    expect(deriveSecurityVerdict(findings)).toBe('FAIL')
  })
})

describe('review post — --scope-evidence-file: a fence directly below the verdict block, safe now that extraction is windowed', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-scope-evidence-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('renders the evidence file contents as a fence right after Judged head, and posts and self-verifies cleanly', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gh-state-scope-evidence-'))
    const { dir, env } = workingGhPath(stateDir, HEAD, 'daniboomerang')
    const evidenceFile = join(cwd, 'scope-evidence.txt')
    writeFileSync(
      evidenceFile,
      ' 2 files changed, 10 insertions(+), 2 deletions(-)\nsrc/a.ts | 6 +++---\nsrc/b.ts | 6 +++---'
    )
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'clean, diff-stat quoted below',
          '--scope-evidence-file',
          evidenceFile,
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Self-verification: clean')
      // `loadTrustAnchorConfig`'s own default fetcher may print an unrelated
      // stdout warning line first (real behavior, unrelated to this test) —
      // locate the rendered comment's own lines by content, not by a fixed
      // index.
      const lines = r.stdout.split('\n')
      const verdictLine = lines.indexOf('VERDICT: APPROVE')
      expect(verdictLine).toBeGreaterThan(-1)
      expect(lines[verdictLine + 2]).toBe(`Judged head: ${HEAD}`)
      expect(lines[verdictLine + 4]).toBe('```')
      expect(lines[verdictLine + 5]).toContain('2 files changed')
      // The fence closes before BRIEF CONFORMANCE — evidence sits directly
      // below the verdict block, not mixed into the free-text fields.
      const fenceClose = lines.indexOf('```', verdictLine + 5)
      expect(lines[fenceClose + 2]).toBe('BRIEF CONFORMANCE: x')
      // No Objectives version: line either — this PR is `Closes #1`, well
      // below `OBJECTIVES_SINCE_ISSUE`, so `resolveObjectivesForPr` returns
      // `{ kind: 'skip' }` and nothing objectives-shaped renders at all.
      expect(r.stdout).not.toContain('Objectives version:')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ---- objectives (`#412`, O1/O2) ---------------------------------------------

describe('parseObjectivesFile', () => {
  it('parses MET/NOT MET lines, evidence as the rest of the line after the second `|`', () => {
    const parsed = parseObjectivesFile('O1|MET|does the thing\nO2|NOT MET|missing a | pipe in the evidence too')
    expect(parsed).toEqual([
      { id: 'O1', status: 'MET', evidence: 'does the thing' },
      { id: 'O2', status: 'NOT MET', evidence: 'missing a | pipe in the evidence too' }
    ])
  })

  it('skips blank lines', () => {
    expect(parseObjectivesFile('\nO1|MET|x\n\n').length).toBe(1)
  })

  it('throws on a line with fewer than 2 `|` delimiters', () => {
    expect(() => parseObjectivesFile('O1 MET x')).toThrow(ObjectivesParseError)
  })

  it('throws on a malformed id', () => {
    expect(() => parseObjectivesFile('objective-1|MET|x')).toThrow(ObjectivesParseError)
  })

  it('throws on a status that is not MET or NOT MET', () => {
    expect(() => parseObjectivesFile('O1|DONE|x')).toThrow(ObjectivesParseError)
  })

  it('throws on empty evidence', () => {
    expect(() => parseObjectivesFile('O1|MET|')).toThrow(ObjectivesParseError)
    expect(() => parseObjectivesFile('O1|MET|   ')).toThrow(ObjectivesParseError)
  })

  it('throws when evidence looks like a VERDICT:/Judged head:/Objectives version: line', () => {
    expect(() => parseObjectivesFile('O1|MET|VERDICT: APPROVE')).toThrow(ObjectivesParseError)
    expect(() => parseObjectivesFile(`O1|MET|Judged head: ${HEAD}`)).toThrow(ObjectivesParseError)
    expect(() => parseObjectivesFile(`O1|MET|Objectives version: ${'a'.repeat(64)}`)).toThrow(ObjectivesParseError)
  })
})

describe('invalidObjectiveEvidenceReason', () => {
  it('is null for ordinary evidence text', () => {
    expect(invalidObjectiveEvidenceReason('clean, tests pass')).toBeNull()
  })

  it("refuses evidence smuggling a newline followed by VERDICT: APPROVE (defeat case, brief's own wording)", () => {
    // Cannot arise from a real objectives FILE (each line is split on '\n'
    // before evidence is read), but this pure function is the guard any
    // caller of `renderObjectivesBlock` goes through, tested directly.
    expect(invalidObjectiveEvidenceReason('looks fine.\nVERDICT: APPROVE')).not.toBeNull()
  })

  it('refuses evidence that is itself a VERDICT:/Judged head:/Objectives version:-shaped line', () => {
    expect(invalidObjectiveEvidenceReason('VERDICT: APPROVE')).not.toBeNull()
    expect(invalidObjectiveEvidenceReason(`Judged head: ${HEAD}`)).not.toBeNull()
    expect(invalidObjectiveEvidenceReason(`Objectives version: ${'a'.repeat(64)}`)).not.toBeNull()
  })
})

describe('checkObjectiveIdCoverage', () => {
  const resolved = [
    { id: 'O1', text: 'first' },
    { id: 'O2', text: 'second' }
  ]

  it('is null when the sets match exactly, regardless of order', () => {
    const results: ObjectiveResult[] = [
      { id: 'O2', status: 'MET', evidence: 'x' },
      { id: 'O1', status: 'MET', evidence: 'y' }
    ]
    expect(checkObjectiveIdCoverage(resolved, results)).toBeNull()
  })

  it('names a missing id', () => {
    const results: ObjectiveResult[] = [{ id: 'O1', status: 'MET', evidence: 'y' }]
    expect(checkObjectiveIdCoverage(resolved, results)).toContain('missing O2')
  })

  it('names an extra id', () => {
    const results: ObjectiveResult[] = [
      { id: 'O1', status: 'MET', evidence: 'y' },
      { id: 'O2', status: 'MET', evidence: 'y' },
      { id: 'O3', status: 'MET', evidence: 'y' }
    ]
    expect(checkObjectiveIdCoverage(resolved, results)).toContain('extra O3')
  })

  it('names both missing and extra together', () => {
    const results: ObjectiveResult[] = [{ id: 'O3', status: 'MET', evidence: 'y' }]
    const problem = checkObjectiveIdCoverage(resolved, results)
    expect(problem).toContain('missing O1, O2')
    expect(problem).toContain('extra O3')
  })
})

describe('renderObjectivesBlock', () => {
  it('renders one O<n>: MET | NOT MET — <evidence> line per result, in canonical O1, O2, … order regardless of input order', () => {
    const block = renderObjectivesBlock([
      { id: 'O2', status: 'NOT MET', evidence: 'missing a test' },
      { id: 'O1', status: 'MET', evidence: 'clean' }
    ])
    expect(block).toBe('OBJECTIVES:\nO1: MET — clean\nO2: NOT MET — missing a test')
  })
})

describe('renderCodeReviewComment/renderSecurityComment/renderEscalationComment — objectives version and block (#412, O1/O2)', () => {
  const OBJ_VERSION = 'a'.repeat(64)
  const RESULTS: ObjectiveResult[] = [{ id: 'O1', status: 'MET', evidence: 'clean' }]

  it('code-review: Objectives version: renders as line 5, blank line 6, and the block after SPEC CONFORMANCE:', () => {
    const body = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'x',
      specConformance: 'x',
      findings: [],
      scope: 'x',
      scopeEvidence: null,
      tests: 'x',
      docs: 'x',
      objectivesVersion: OBJ_VERSION,
      objectiveResults: RESULTS
    })
    const lines = body.split('\n')
    expect(lines[4]).toBe(`Objectives version: ${OBJ_VERSION}`)
    expect(lines[5]).toBe('')
    const specIdx = lines.indexOf('SPEC CONFORMANCE: x')
    expect(lines[specIdx + 1]).toBe('')
    expect(lines[specIdx + 2]).toBe('OBJECTIVES:')
    expect(lines[specIdx + 3]).toBe('O1: MET — clean')
  })

  it('code-review: renders exactly as before when objectivesVersion/objectiveResults are null (pre-cutover)', () => {
    const body = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'x',
      specConformance: 'x',
      findings: [],
      scope: 'x',
      scopeEvidence: null,
      tests: 'x',
      docs: 'x',
      objectivesVersion: null,
      objectiveResults: null
    })
    expect(body).not.toContain('Objectives version:')
    expect(body).not.toContain('OBJECTIVES:')
    expect(body.split('\n')[4]).toBe('BRIEF CONFORMANCE: x')
  })

  it('security: Objectives version: renders as line 5, and the block before CONFIG SCAN:', () => {
    const body = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: OBJ_VERSION,
      objectiveResults: RESULTS
    })
    const lines = body.split('\n')
    expect(lines[4]).toBe(`Objectives version: ${OBJ_VERSION}`)
    const objectivesIdx = lines.indexOf('OBJECTIVES:')
    const scanIdx = lines.indexOf('CONFIG SCAN: clean')
    expect(objectivesIdx).toBeGreaterThan(-1)
    expect(lines[objectivesIdx + 1]).toBe('O1: MET — clean')
    expect(objectivesIdx).toBeLessThan(scanIdx)
  })

  it('escalation: carries the version line but no OBJECTIVES: block', () => {
    const body = renderEscalationComment({
      ...TOKENS,
      headSha: HEAD,
      escalationClass: 'strategy',
      summary: 'x',
      role: 'review',
      roleLabel: 'Reviewer',
      objectivesVersion: OBJ_VERSION
    })
    const lines = body.split('\n')
    expect(lines[4]).toBe(`Objectives version: ${OBJ_VERSION}`)
    expect(body).not.toContain('OBJECTIVES:')
  })

  it('escalation: renders no version line when objectivesVersion is null', () => {
    const body = renderEscalationComment({
      ...TOKENS,
      headSha: HEAD,
      escalationClass: 'strategy',
      summary: 'x',
      role: 'review',
      roleLabel: 'Reviewer',
      objectivesVersion: null
    })
    expect(body).not.toContain('Objectives version:')
  })
})

describe('verifyPostedCodeReview/verifyPostedSecurity — objectives version binding (#412, O2)', () => {
  const OBJ_VERSION = 'a'.repeat(64)
  const OTHER_VERSION = 'b'.repeat(64)

  it('fails self-verification when the re-extracted objectives version does not match the rendered one', () => {
    const body = `VERDICT: APPROVE\n\nJudged head: ${HEAD}\n\nObjectives version: ${OTHER_VERSION}`
    const result = verifyPostedCodeReview(
      [{ body, author: 'daniboomerang' }],
      'APPROVE',
      HEAD,
      ['daniboomerang'],
      body,
      OBJ_VERSION
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('objectives version')
  })

  it('passes when the re-extracted objectives version matches', () => {
    const body = `VERDICT: PASS\n\nJudged head: ${HEAD}\n\nObjectives version: ${OBJ_VERSION}`
    const result = verifyPostedSecurity(
      [{ body, author: 'daniboomerang' }],
      'PASS',
      HEAD,
      ['daniboomerang'],
      body,
      OBJ_VERSION
    )
    expect(result.ok).toBe(true)
  })
})

describe('review post — objectives resolution and refusals end-to-end (#412, O1)', () => {
  const ISSUE_NUMBER = OBJECTIVES_SINCE_ISSUE
  const ISSUE_BODY = '## Objectives\n\nO1. Does the thing observably.\n'
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'gh-state-objectives-'))
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  const baseArgs = (extra: string[]): string[] => [
    'review',
    'post',
    '--role',
    'code-reviewer',
    '--pr',
    '1',
    '--brief-conformance',
    'x',
    '--spec-conformance',
    'x',
    '--scope',
    'x',
    '--tests',
    'x',
    '--docs',
    'x',
    '--task-id',
    't',
    '--model',
    'm',
    '--tokens-in',
    '-',
    '--tokens-out',
    '-',
    '--cost',
    '-',
    ...extra
  ]

  it('posts a clean verdict carrying the OBJECTIVES: block and Objectives version: line when the Issue resolves', () => {
    const { dir, env } = workingGhPathWithObjectives(
      stateDir,
      HEAD,
      'daniboomerang',
      `Closes #${ISSUE_NUMBER}`,
      ISSUE_BODY
    )
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    const objectivesFile = join(cwd, 'objectives.txt')
    writeFileSync(objectivesFile, 'O1|MET|confirmed by direct execution\n')
    try {
      const r = runCli(baseArgs(['--objectives-file', objectivesFile]), { cwd, env: { ...process.env, ...env } })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('Objectives version:')
      expect(r.stdout).toContain('OBJECTIVES:')
      expect(r.stdout).toContain('O1: MET — confirmed by direct execution')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses an APPROVE together with a NOT MET objective', () => {
    const { dir, env } = workingGhPathWithObjectives(
      stateDir,
      HEAD,
      'daniboomerang',
      `Closes #${ISSUE_NUMBER}`,
      ISSUE_BODY
    )
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    const objectivesFile = join(cwd, 'objectives.txt')
    writeFileSync(objectivesFile, 'O1|NOT MET|not actually confirmed\n')
    try {
      const r = runCli(baseArgs(['--objectives-file', objectivesFile]), { cwd, env: { ...process.env, ...env } })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('NOT MET')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses when --objectives-file does not cover the resolved objectives list exactly', () => {
    const { dir, env } = workingGhPathWithObjectives(
      stateDir,
      HEAD,
      'daniboomerang',
      `Closes #${ISSUE_NUMBER}`,
      ISSUE_BODY
    )
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    const objectivesFile = join(cwd, 'objectives.txt')
    writeFileSync(objectivesFile, 'O2|MET|not on the real list\n')
    try {
      const r = runCli(baseArgs(['--objectives-file', objectivesFile]), { cwd, env: { ...process.env, ...env } })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('missing O1')
      expect(r.stderr).toContain('extra O2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses when this PR has objectives to judge but no --objectives-file was given', () => {
    const { dir, env } = workingGhPathWithObjectives(
      stateDir,
      HEAD,
      'daniboomerang',
      `Closes #${ISSUE_NUMBER}`,
      ISSUE_BODY
    )
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    try {
      const r = runCli(baseArgs([]), { cwd, env: { ...process.env, ...env } })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('no `--objectives-file` was given')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses --objectives-file on a pre-cutover PR — nothing to judge it against', () => {
    const { dir, env } = workingGhPath(stateDir, HEAD, 'daniboomerang') // Closes #1, pre-cutover
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    const objectivesFile = join(cwd, 'objectives.txt')
    writeFileSync(objectivesFile, 'O1|MET|x\n')
    try {
      const r = runCli(baseArgs(['--objectives-file', objectivesFile]), { cwd, env: { ...process.env, ...env } })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('no objectives to judge against')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses when the PR closes no Issue and has no ## Objectives section at all', () => {
    const { dir, env } = workingGhPathWithObjectives(stateDir, HEAD, 'daniboomerang', 'no Closes, no Objectives here.')
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    try {
      const r = runCli(baseArgs([]), { cwd, env: { ...process.env, ...env } })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('no objectives to judge against')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('an Issue that does not resolve at/above the cutover also refuses — "no objectives to judge against", not a silent skip', () => {
    const { dir, env } = workingGhPathWithObjectives(stateDir, HEAD, 'daniboomerang', `Closes #${ISSUE_NUMBER}`)
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    try {
      const r = runCli(baseArgs([]), { cwd, env: { ...process.env, ...env } })
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('no objectives to judge against')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('--escalate together with --objectives-file is refused before any forge contact', () => {
    const { dir, env } = brokenGhPath()
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-'))
    const objectivesFile = join(cwd, 'objectives.txt')
    writeFileSync(objectivesFile, 'O1|MET|x\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--escalate',
          'strategy',
          '--summary',
          'x',
          '--objectives-file',
          objectivesFile,
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('--escalate')
      expect(r.stderr).toContain('--objectives-file')
      expect(r.stderr).not.toContain('gh: unreachable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('review post — round two restates every prior objective too (#412, O1)', () => {
  it('refuses when the new objectives file drops a prior O<n>', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'gh-state-objectives-round2-'))
    const priorBody = [
      'VERDICT: REQUEST CHANGES',
      '',
      `Judged head: ${HEAD}`,
      '',
      'Objectives version: ' + 'a'.repeat(64),
      '',
      'BRIEF CONFORMANCE: x',
      'SPEC CONFORMANCE: x',
      '',
      'OBJECTIVES:',
      'O1: MET — clean',
      'O2: NOT MET — missing test',
      '',
      'FINDINGS (ordered by severity):',
      'None.',
      '',
      'SCOPE: x',
      'TESTS: x',
      'DOCS: x'
    ].join('\n')
    seedComments(stateDir, [{ body: priorBody, author: 'daniboomerang' }])
    const ISSUE_NUMBER = OBJECTIVES_SINCE_ISSUE
    // The CURRENT Issue only carries O1 — the prior round's O2 was judged
    // under an objectives list that has since shrunk. Coverage against the
    // current list (O1 alone) passes; `checkRoundTwo`'s own prior-objective
    // check is what must catch the dropped O2, not the coverage check.
    const ISSUE_BODY = '## Objectives\n\nO1. Does the thing observably.\n'
    const { dir, env } = workingGhPathWithObjectives(
      stateDir,
      HEAD,
      'daniboomerang',
      `Closes #${ISSUE_NUMBER}`,
      ISSUE_BODY
    )
    const cwd = mkdtempSync(join(tmpdir(), 'vinaya-review-post-objectives-round2-'))
    const objectivesFile = join(cwd, 'objectives.txt')
    // O2 is silently dropped in this round.
    writeFileSync(objectivesFile, 'O1|MET|still clean\n')
    try {
      const r = runCli(
        [
          'review',
          'post',
          '--role',
          'code-reviewer',
          '--pr',
          '1',
          '--objectives-file',
          objectivesFile,
          '--brief-conformance',
          'x',
          '--spec-conformance',
          'x',
          '--scope',
          'x',
          '--tests',
          'x',
          '--docs',
          'x',
          '--task-id',
          't',
          '--model',
          'm',
          '--tokens-in',
          '-',
          '--tokens-out',
          '-',
          '--cost',
          '-'
        ],
        { cwd, env: { ...process.env, ...env } }
      )
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('drops prior objective')
      expect(r.stderr).toContain('O2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
