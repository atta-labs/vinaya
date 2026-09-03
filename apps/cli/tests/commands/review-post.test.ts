import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractCodeReviewVerdict, extractSecurityReviewVerdict } from '@attalabs/aeg-core'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  deriveCodeReviewVerdict,
  deriveSecurityVerdict,
  type Finding,
  findingsOutsideDelta,
  findPriorVerdictComment,
  isEscalationClass,
  missingPriorIds,
  parseChangedLineRanges,
  parsePriorFindingIds,
  renderEscalationComment,
  verifyPostedEscalation
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
 * A working `gh` stub that serves `pr view --json headRefOid`, `pr view
 * --json comments`, and `pr comment --body-file` against a small JSON state
 * file in `stateDir` — round-tripping a posted comment back into the next
 * `--json comments` fetch, the way the real forge does. Writing it as a Bun
 * script (not `/bin/sh`) is what makes the JSON read-modify-write tractable.
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
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid')) {
  process.stdout.write(${JSON.stringify(headSha)})
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
      roleLabel: 'Reviewer'
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
      roleLabel: 'Security'
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
      roleLabel: 'Reviewer'
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
    } finally {
      rmSync(dir, { recursive: true, force: true })
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
    expect(parsePriorFindingIds(body)).toEqual({ ids: ['F1', 'F2'], judgedHead: HEAD })
  })

  it('de-duplicates a repeated id and returns null judgedHead when absent', () => {
    const body = '1. [MAJOR] a.ts:1 — F3 perf: slow\n2. [MAJOR] a.ts:2 — F3 perf resolved: fixed'
    expect(parsePriorFindingIds(body)).toEqual({ ids: ['F3'], judgedHead: null })
  })

  it('finds no ids in an ordinary "None." findings section', () => {
    expect(parsePriorFindingIds('FINDINGS (ordered by severity):\nNone.').ids).toEqual([])
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
    const { dir, env } = workingGhPath(stateDir, judgedHead, 'daniboomerang')
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
    const { dir, env } = workingGhPath(stateDir, judgedHead, 'daniboomerang')
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
    const { dir, env } = workingGhPath(stateDir, judgedHead, 'daniboomerang')
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

  it('no prior verdict comment on the PR — round one, no round-two checks at all', () => {
    seedComments(stateDir, [])
    const { dir, env } = workingGhPath(stateDir, judgedHead, 'daniboomerang')
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
