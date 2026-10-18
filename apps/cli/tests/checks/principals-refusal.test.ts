import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { CHECK_SCHEMA_VERSION, type CheckError } from '../../src/checks/contract'
import { EVIDENCE_PLACEHOLDER_TEXT } from '../../src/checks/evidence-fresh-logic'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'

/**
 * Every check that decides who counts as a Principal, spawned for real with
 * a fake `gh` first on `PATH` whose default-branch `vinaya.config.json` read
 * either answers HTTP 404 (`not-configured`) or fails with a non-404 error
 * (`read-failed`). Each refusal must reach the runner as `CheckError` JSON
 * lines — never plain text or an uncaught exception, which the runner marks
 * as malformed output and which would lose the named fix.
 *
 * `not-configured` refuses in every check. `read-failed` refuses in the trust
 * decisions and is one warning in the push-time checks, which then treat the
 * result that needed the list as unknown.
 */

// The fix every refusal names, spelled out rather than imported: this suite
// spawns the checks and reads only their output, so it imports no source
// module the checks resolve through.
const PRINCIPALS_NOT_CONFIGURED_FIX = 'add "principals": [...] to vinaya.config.json on the default branch'

const BIN_DIR = join(import.meta.dir, '../../src/checks/bin')
const TRANCHE = 'fixture-tranche'
const TASK_BRANCH = `task/${TRANCHE}/1`

type ConfigMode = 'not-configured' | 'read-failed'

let dirs: string[] = []

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/**
 * A scratch repository: `main` with one commit, the task branch checked out
 * one commit ahead. `origin` is a GitHub URL (the repository the coherence,
 * first-push-dispatch and dispatch-readiness checks resolve) unless
 * `localOrigin`, for the review gate, whose head and base resolve through
 * `git ls-remote origin`.
 */
function scratchRepo(localOrigin = false): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'principals-refusal-'))
  dirs.push(dir)
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@example.com'])
  g(['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  g(['add', '-A'])
  g(['commit', '-qm', 'base'])
  g(['checkout', '-qb', TASK_BRANCH])
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  g(['add', '-A'])
  g(['commit', '-qm', 'edit'])
  g(['remote', 'add', 'origin', localOrigin ? dir : 'https://github.com/o/r.git'])
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  return { dir, head }
}

/**
 * The fake `gh`. The default-branch config read fails per `mode`; every other
 * read the checks make before their Principal read is answered from the
 * `STUB_*` variables, and anything else fails loudly.
 */
function fakeGh(dir: string, mode: ConfigMode): string {
  const ghDir = join(dir, 'fakebin')
  mkdirSync(ghDir, { recursive: true })
  const failure =
    mode === 'not-configured'
      ? 'gh: Not Found (HTTP 404)'
      : 'HTTP 401: Bad credentials (https://api.github.com/repos/o/r/contents/vinaya.config.json)'
  writeFileSync(
    join(ghDir, 'gh'),
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
const out = (s) => { process.stdout.write(s); process.exit(0) }
if (args[0] === 'api' && String(args[1]).endsWith('/contents/vinaya.config.json')) {
  process.stderr.write(${JSON.stringify(failure)} + '\\n')
  process.exit(1)
}
if (args[0] === 'pr' && args[1] === 'view') out(process.env.STUB_PR_VIEW_JSON ?? '{}')
if (args[0] === 'pr' && args[1] === 'list') out('[]')
if (args[0] === 'issue' && args[1] === 'view') out(process.env.STUB_ISSUE_VIEW_JSON ?? '{}')
if (args[0] === 'api' && /\\/issues\\/\\d+\\/comments/.test(String(args[1]))) out(process.env.STUB_COMMENTS_JSON ?? '[]')
if (args[0] === 'api' && String(args[1]).includes('/timeline')) out(process.env.STUB_TIMELINE_JSON ?? '[]')
process.stderr.write('fake gh: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
  )
  chmodSync(join(ghDir, 'gh'), 0o755)
  return ghDir
}

async function runCheck(
  bin: string,
  dir: string,
  mode: ConfigMode,
  env: Record<string, string>
): Promise<{ exitCode: number; lines: CheckError[]; stderr: string }> {
  const ghDir = fakeGh(dir, mode)
  const spawnEnv: Record<string, string | undefined> = {
    ...stripVinayaEnv(),
    PATH: `${ghDir}:${process.env.PATH}`,
    GITHUB_REPOSITORY: 'o/r',
    ...env
  }
  // No forge credential and no repository override: the Principal read is
  // the fake `gh`'s alone, and no later forge read reaches a real forge.
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'AEG_REPO', 'PR_NUMBER', 'PR_BODY', 'PR_LABELS', 'BRANCH']) {
    if (!(key in env)) delete spawnEnv[key]
  }
  const { status, stderr } = await spawnBudgetedAsync(['bun', join(BIN_DIR, bin)], { cwd: dir, env: spawnEnv })
  const lines = stderr
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as CheckError
      } catch {
        return { malformed: l } as unknown as CheckError
      }
    })
  return { exitCode: status, lines, stderr }
}

function expectValid(line: CheckError, check: string): void {
  expect(line.schema).toBe(CHECK_SCHEMA_VERSION)
  expect(line.check).toBe(check)
  expect(typeof line.message).toBe('string')
  expect(typeof line.agent_recovery_prompt).toBe('string')
}

/** Exactly one `CheckError` line, of `error` severity, naming the fix or the reason — and exit 1. */
function expectRefusal(
  result: { exitCode: number; lines: CheckError[]; stderr: string },
  check: string,
  mode: ConfigMode
) {
  expect(result.lines, result.stderr).toHaveLength(1)
  const [line] = result.lines as [CheckError]
  expectValid(line, check)
  expect(line.severity).toBe('error')
  if (mode === 'not-configured') expect(line.message).toContain(PRINCIPALS_NOT_CONFIGURED_FIX)
  else expect(line.message).toContain('Bad credentials')
  expect(result.exitCode).toBe(1)
}

/** Exactly one `warning` line naming the failed Principal read, whatever else the check goes on to report. */
function expectPrincipalWarning(result: { lines: CheckError[]; stderr: string }, check: string): void {
  const principal = result.lines.filter((l) => typeof l.message === 'string' && l.message.includes('Principal'))
  expect(principal, result.stderr).toHaveLength(1)
  const [line] = principal as [CheckError]
  expectValid(line, check)
  expect(line.severity).toBe('warning')
  expect(line.message).toContain('Principal read failed')
  expect(line.message).toContain('Bad credentials')
}

// The inputs that carry each check to its Principal read.
const placeholderEvidence = [
  '<!-- AEG:EVIDENCE:START -->',
  EVIDENCE_PLACEHOLDER_TEXT,
  '<!-- AEG:EVIDENCE:END -->'
].join('\n')
const taskBody = 'Closes #7\n\n## Test Plan\n\n- [ ] something\n'

const cases: Array<{
  check: string
  bin: string
  localOrigin?: boolean
  env: (head: string) => Record<string, string>
  readFailed: 'refuse' | 'warn'
  readFailedExit?: number
}> = [
  {
    check: 'review-gate',
    bin: 'check-review-gate.ts',
    localOrigin: true,
    readFailed: 'refuse',
    env: (head) => ({
      PR_NUMBER: '1',
      STUB_PR_VIEW_JSON: JSON.stringify({
        number: 1,
        comments: [],
        labels: [],
        headRefName: TASK_BRANCH,
        headRefOid: head,
        baseRefName: 'main',
        body: ''
      })
    })
  },
  {
    check: 'evidence-fresh',
    bin: 'check-evidence-fresh.ts',
    readFailed: 'refuse',
    env: (head) => ({
      PR_NUMBER: '1',
      BASE_SHA: 'main',
      PR_BODY: placeholderEvidence,
      STUB_PR_VIEW_JSON: JSON.stringify({ headRefOid: head, baseRefName: 'main' })
    })
  },
  {
    check: 'brief-shape',
    bin: 'check-brief-shape.ts',
    readFailed: 'refuse',
    env: () => ({ PR_BODY: taskBody, BRANCH: TASK_BRANCH })
  },
  {
    check: 'test-plan',
    bin: 'check-test-plan.ts',
    readFailed: 'refuse',
    env: (head) => ({ PR_BODY: taskBody, BRANCH: TASK_BRANCH, PULL_REQUEST_HEAD_SHA: head })
  },
  {
    check: 'principal-test-plan-wait',
    bin: 'check-principal-test-plan-wait.ts',
    readFailed: 'refuse',
    env: (head) => ({ PR_BODY: taskBody, BRANCH: TASK_BRANCH, PULL_REQUEST_HEAD_SHA: head })
  },
  {
    check: 'doc-coverage',
    bin: 'check-doc-coverage.ts',
    readFailed: 'refuse',
    env: () => ({
      PR_NUMBER: '1',
      BASE_SHA: 'main',
      STUB_PR_VIEW_JSON: JSON.stringify({ labels: [{ name: 'vinaya/waiver:docs' }] })
    })
  },
  {
    check: 'doc-coverage-push',
    bin: 'check-doc-coverage-push.ts',
    readFailed: 'warn',
    readFailedExit: 0,
    env: () => ({ BASE_SHA: 'main', PR_LABELS: 'vinaya/waiver:docs' })
  },
  {
    check: 'dispatch-readiness',
    bin: 'check-dispatch-readiness.ts',
    readFailed: 'warn',
    readFailedExit: 0,
    env: () => ({
      BRANCH: 'task/issue-541',
      STUB_ISSUE_VIEW_JSON: JSON.stringify({ number: 541, state: 'OPEN', body: '', labels: [] })
    })
  },
  {
    check: 'coherence',
    bin: 'check-coherence.ts',
    readFailed: 'warn',
    env: () => ({ BRANCH: TASK_BRANCH })
  },
  {
    check: 'first-push-dispatch',
    bin: 'check-first-push-dispatch.ts',
    readFailed: 'warn',
    readFailedExit: 0,
    env: () => ({ BRANCH: TASK_BRANCH })
  }
]

describe('a Principal-resolving check refuses when no Principal is configured, naming the fix', () => {
  for (const c of cases) {
    it(`${c.check}: one error CheckError and exit 1`, async () => {
      const { dir, head } = scratchRepo(c.localOrigin)
      expectRefusal(await runCheck(c.bin, dir, 'not-configured', c.env(head)), c.check, 'not-configured')
    })
  }

  it('a repository that resolves no repository identity is not-configured too', async () => {
    const { dir } = scratchRepo()
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: dir })
    const result = await runCheck('check-brief-shape.ts', dir, 'read-failed', {
      PR_BODY: taskBody,
      BRANCH: TASK_BRANCH,
      GITHUB_REPOSITORY: ''
    })
    expectRefusal(result, 'brief-shape', 'not-configured')
  })
})

describe('a failed Principal read refuses a trust decision and warns at push time', () => {
  for (const c of cases) {
    if (c.readFailed === 'refuse') {
      it(`${c.check}: one error CheckError naming the reason, and exit 1`, async () => {
        const { dir, head } = scratchRepo(c.localOrigin)
        expectRefusal(await runCheck(c.bin, dir, 'read-failed', c.env(head)), c.check, 'read-failed')
      })
    } else {
      it(`${c.check}: one warning CheckError naming the failed Principal read${c.readFailedExit === 0 ? ', and exit 0' : ''}`, async () => {
        const { dir, head } = scratchRepo(c.localOrigin)
        const result = await runCheck(c.bin, dir, 'read-failed', c.env(head))
        expectPrincipalWarning(result, c.check)
        if (c.readFailedExit !== undefined) {
          expect(result.lines, result.stderr).toHaveLength(1)
          expect(result.exitCode).toBe(c.readFailedExit)
        }
      })
    }
  }
})
