import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { WAIVER_LABEL } from '@attalabs/aeg-core'
import { type CheckError, CHECK_SCHEMA_VERSION } from '../../src/checks/contract'
import { EVIDENCE_PLACEHOLDER_TEXT } from '../../src/checks/evidence-fresh-logic'
import { spawnBudgetedAsync, stripVinayaEnv } from '../lib/process-fixture'

/**
 * Every check that decides who counts as a Principal reads the list from the
 * default branch's `vinaya.config.json` with no built-in fallback. Each is
 * spawned here with a fake `gh` first on `PATH` whose default-branch
 * configuration read answers HTTP 404 (`not-configured`) or fails with a
 * non-404 error (`read-failed`), and the refusal must arrive as valid
 * `CheckError` lines — never plain text, never an uncaught exception, both of
 * which the runner marks as malformed output, losing the named fix.
 */
const BIN_DIR = join(import.meta.dir, '../../src/checks/bin')
const FIX = 'add "principals": [...] to vinaya.config.json on the default branch'
const READ_FAILED = 'could not read "principals" from vinaya.config.json on the default branch'
const NETWORK_ERROR = 'error connecting to api.github.com'

type PrincipalRead = 'not-configured' | 'read-failed'

/** Env a parent run (a hook, a CI step) may carry that would steer a spawned check off this fixture. */
const STEERING_ENV = [
  'AEG_REPO',
  'BASE_SHA',
  'BRANCH',
  'GITHUB_REPOSITORY',
  'PR_BODY',
  'PR_BODY_FILE',
  'PR_LABELS',
  'PR_NUMBER',
  'PREMISE_FILE',
  'PULL_REQUEST_HEAD_SHA',
  'WAIVER_LABEL_ACTOR'
]

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * A repository with a `main` base commit and a `work` branch one commit
 * ahead. `origin` is a GitHub URL for the checks that resolve their
 * repository only from `AEG_REPO` or `origin`; the review gate needs a local
 * `origin` instead, so `git ls-remote` resolves the head and base it reads
 * before the Principal list. `origin: 'none'` resolves no repository at all.
 */
function scratchRepo(origin: 'github' | 'local' | 'none'): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'principals-refusal-'))
  dirs.push(dir)
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@example.com'])
  g(['config', 'user.name', 'test'])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  g(['add', '-A'])
  g(['commit', '-qm', 'base'])
  g(['checkout', '-qb', 'work'])
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  g(['add', '-A'])
  g(['commit', '-qm', 'edit'])
  if (origin === 'github') g(['remote', 'add', 'origin', 'https://github.com/atta-labs/vinaya.git'])
  if (origin === 'local') g(['remote', 'add', 'origin', dir])
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  return { dir, sha }
}

/**
 * The fake `gh`: one pull request (carrying the docs waiver label, so both
 * documentation-coverage checks reach their Principal read), one Issue with
 * no tranche label, no edges and no comments, no pull request for the
 * branch — and a
 * default-branch configuration read that refuses the way `read` names.
 */
function fakeGh(dir: string, sha: string, read: PrincipalRead): string {
  const ghDir = join(dir, 'fakebin')
  mkdirSync(ghDir, { recursive: true })
  const pr = {
    number: 1,
    comments: [],
    labels: [{ name: WAIVER_LABEL }],
    headRefName: 'work',
    headRefOid: sha,
    baseRefName: 'main',
    body: 'Closes #7'
  }
  const issue = { number: 7, state: 'OPEN', body: '', labels: [], comments: [] }
  const refusal =
    read === 'not-configured'
      ? "process.stderr.write('gh: Not Found (HTTP 404)\\n')"
      : `process.stderr.write(${JSON.stringify(`${NETWORK_ERROR}\n`)})`
  writeFileSync(
    join(ghDir, 'gh'),
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
if (args[0] === 'api' && String(args[1]).endsWith('/contents/vinaya.config.json')) {
  ${refusal}
  process.exit(1)
}
if (args[0] === 'api' && String(args[1]).includes('/issues/7/comments')) {
  process.stdout.write('[]')
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write(${JSON.stringify(JSON.stringify(pr))})
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write('[]')
  process.exit(0)
}
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(${JSON.stringify(JSON.stringify(issue))})
  process.exit(0)
}
process.stderr.write('fake gh: unhandled invocation: ' + args.join(' ') + '\\n')
process.exit(1)
`
  )
  chmodSync(join(ghDir, 'gh'), 0o755)
  return ghDir
}

type Run = { exitCode: number; errors: CheckError[]; principalLines: CheckError[] }

async function runCheck(
  bin: string,
  origin: 'github' | 'local' | 'none',
  read: PrincipalRead,
  env: (sha: string) => Record<string, string>,
  repoIdentity = true
): Promise<Run> {
  const { dir, sha } = scratchRepo(origin)
  const ghDir = fakeGh(dir, sha, read)
  const base = stripVinayaEnv()
  for (const key of STEERING_ENV) delete base[key]
  const { status, stderr } = await spawnBudgetedAsync(['bun', join(BIN_DIR, bin)], {
    cwd: dir,
    env: {
      ...base,
      PATH: `${ghDir}:${process.env.PATH}`,
      ...(repoIdentity ? { GITHUB_REPOSITORY: 'atta-labs/vinaya' } : {}),
      ...env(sha)
    }
  })
  const lines = stderr.split('\n').filter((l) => l.trim() !== '')
  const errors = lines.map((line) => {
    // Every stderr line must be a CheckError: anything else is the malformed
    // output the runner reports as `status: 'error'`.
    const parsed = JSON.parse(line) as CheckError
    expect(parsed.schema).toBe(CHECK_SCHEMA_VERSION)
    expect(typeof parsed.message).toBe('string')
    expect(typeof parsed.agent_recovery_prompt).toBe('string')
    expect(['error', 'warning']).toContain(parsed.severity)
    return parsed
  })
  return {
    exitCode: status,
    errors,
    principalLines: errors.filter((e) => e.message.includes(FIX) || e.message.includes(READ_FAILED))
  }
}

const TASK_BRANCH = 'task/some-tranche/1'

const CHECKS: Record<
  string,
  { bin: string; origin: 'github' | 'local'; env: (sha: string) => Record<string, string> }
> = {
  'review-gate': { bin: 'check-review-gate.ts', origin: 'local', env: () => ({ PR_NUMBER: '1' }) },
  'evidence-fresh': {
    bin: 'check-evidence-fresh.ts',
    origin: 'local',
    env: () => ({
      PR_NUMBER: '1',
      BASE_SHA: 'main',
      PR_BODY: ['<!-- AEG:EVIDENCE:START -->', EVIDENCE_PLACEHOLDER_TEXT, '<!-- AEG:EVIDENCE:END -->'].join('\n')
    })
  },
  'brief-shape': {
    bin: 'check-brief-shape.ts',
    origin: 'local',
    env: () => ({ PR_BODY: 'Closes #7', BRANCH: TASK_BRANCH })
  },
  'test-plan': {
    bin: 'check-test-plan.ts',
    origin: 'local',
    env: (sha) => ({ PR_BODY: 'Closes #7', BRANCH: TASK_BRANCH, PULL_REQUEST_HEAD_SHA: sha })
  },
  'principal-test-plan-wait': {
    bin: 'check-principal-test-plan-wait.ts',
    origin: 'local',
    env: (sha) => ({ PR_BODY: 'Closes #7', BRANCH: TASK_BRANCH, PULL_REQUEST_HEAD_SHA: sha })
  },
  'doc-coverage': {
    bin: 'check-doc-coverage.ts',
    origin: 'local',
    env: () => ({ PR_NUMBER: '1', BASE_SHA: 'main' })
  },
  'doc-coverage-push': {
    bin: 'check-doc-coverage-push.ts',
    origin: 'local',
    env: () => ({ PR_LABELS: WAIVER_LABEL, BASE_SHA: 'main' })
  },
  'dispatch-readiness': {
    bin: 'check-dispatch-readiness.ts',
    origin: 'github',
    env: () => ({ BRANCH: 'task/issue-7' })
  },
  coherence: { bin: 'check-coherence.ts', origin: 'github', env: () => ({ BRANCH: TASK_BRANCH }) },
  'first-push-dispatch': {
    bin: 'check-first-push-dispatch.ts',
    origin: 'github',
    env: () => ({ BRANCH: TASK_BRANCH })
  }
}

describe('no Principal configured — every Principal-deciding check refuses, naming the fix', () => {
  for (const [name, check] of Object.entries(CHECKS)) {
    it(`${name}: one error CheckError naming the fix, exit 1`, async () => {
      const run = await runCheck(check.bin, check.origin, 'not-configured', check.env)
      expect(run.errors).toHaveLength(1)
      expect(run.principalLines).toHaveLength(1)
      expect(run.principalLines[0]?.severity).toBe('error')
      expect(run.principalLines[0]?.message).toContain(FIX)
      expect(run.exitCode).toBe(1)
    })
  }

  it('a repository that resolves no identity (no origin, no GITHUB_REPOSITORY) is not-configured, never a failed read', async () => {
    const check = CHECKS['brief-shape']
    if (!check) throw new Error('brief-shape fixture missing')
    const run = await runCheck(check.bin, 'none', 'read-failed', check.env, false)
    expect(run.errors).toHaveLength(1)
    expect(run.principalLines[0]?.message).toContain(FIX)
    expect(run.principalLines[0]?.message).toContain('no repository resolves')
    expect(run.exitCode).toBe(1)
  })
})

describe('the Principal read failed — a trust decision refuses, naming the reason', () => {
  for (const name of [
    'review-gate',
    'evidence-fresh',
    'brief-shape',
    'test-plan',
    'principal-test-plan-wait',
    'doc-coverage'
  ]) {
    it(`${name}: one error CheckError naming the failed read, exit 1`, async () => {
      const check = CHECKS[name]
      if (!check) throw new Error(`${name} fixture missing`)
      const run = await runCheck(check.bin, check.origin, 'read-failed', check.env)
      expect(run.errors).toHaveLength(1)
      expect(run.principalLines).toHaveLength(1)
      expect(run.principalLines[0]?.severity).toBe('error')
      expect(run.principalLines[0]?.message).toContain(READ_FAILED)
      expect(run.principalLines[0]?.message).toContain(NETWORK_ERROR)
      expect(run.principalLines[0]?.message).not.toContain(FIX)
      expect(run.exitCode).toBe(1)
    })
  }
})

describe('the Principal read failed — a push-time check warns once and treats the result as unknown', () => {
  for (const name of ['dispatch-readiness', 'doc-coverage-push', 'coherence', 'first-push-dispatch']) {
    it(`${name}: exactly one warning CheckError naming the failed Principal read`, async () => {
      const check = CHECKS[name]
      if (!check) throw new Error(`${name} fixture missing`)
      const run = await runCheck(check.bin, check.origin, 'read-failed', check.env)
      expect(run.principalLines).toHaveLength(1)
      expect(run.principalLines[0]?.severity).toBe('warning')
      expect(run.principalLines[0]?.message).toContain(READ_FAILED)
      expect(run.principalLines[0]?.message).toContain(NETWORK_ERROR)
      // Coherence's exit is left to its other rules, which read the forge
      // this fixture does not serve; the other three have nothing else to fail.
      if (name !== 'coherence') {
        expect(run.errors).toHaveLength(1)
        expect(run.exitCode).toBe(0)
      }
    })
  }
})
