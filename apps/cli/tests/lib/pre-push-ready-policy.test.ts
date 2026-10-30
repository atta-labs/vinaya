/**
 * The ready-tests policy: the trusted opt-in, the driver's deferral marker, the hook's decision, and the generated
 * hook's own deferral step executed as real shell.
 */
import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deferralMarkerText,
  isReadyCiCommand,
  parseDeferralMarker,
  parseDeferredTestsRecord,
  pushedHeadOf,
  READY_TESTS_CHECK,
  READY_TESTS_WORKFLOW,
  readyCiPlanCommand,
  readyTestsPolicyOf,
  readTrustedReadyTestsPolicy,
  resolveReadyTestsDeferral
} from '../../src/lib/pre-push-ready-policy.js'
import { spawnSyncBudgeted, stripVinayaEnv } from './process-fixture.js'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(CLI_ROOT, '..', '..')
const SCRIPT = join(CLI_ROOT, 'src', 'lib', 'pre-push-ready-policy.ts')
const HEAD = 'a'.repeat(40)
const NOW = Date.parse('2026-10-29T00:00:00Z')
const DRIVER = { pid: 4242, startTime: 'Thu Oct 29 00:00:00 2026' }
const CI = { mode: 'ci' as const, workflow: READY_TESTS_WORKFLOW, check: READY_TESTS_CHECK }

const marker = (fields: Record<string, unknown> = {}) =>
  deferralMarkerText({
    kind: 'ready',
    runId: 'run-1',
    branch: 'task/issue-1',
    driver: DRIVER,
    head: HEAD,
    expiresAt: new Date(NOW + 60_000).toISOString(),
    ...fields
  } as never)

const decide = (over: Partial<Parameters<typeof resolveReadyTestsDeferral>[0]> = {}) => {
  const asked: string[] = []
  const decision = resolveReadyTestsDeferral({
    pushMode: 'ready',
    marker: marker(),
    branch: 'task/issue-1',
    pushedHead: HEAD,
    now: NOW,
    isDriverAlive: (driver) => driver.pid === DRIVER.pid && driver.startTime === DRIVER.startTime,
    openPullRequests: () => {
      asked.push('pr')
      return [9]
    },
    readPolicy: () => {
      asked.push('policy')
      return CI
    },
    ...over
  })
  return { decision, asked }
}

describe('the trusted opt-in', () => {
  it('absent means local tests; only the supported pair opts in', () => {
    expect(readyTestsPolicyOf(null)).toEqual({ mode: 'local' })
    expect(readyTestsPolicyOf({ prePush: { alwaysRun: [] } } as never)).toEqual({ mode: 'local' })
    expect(readyTestsPolicyOf({ prePush: { readyTests: CI } } as never)).toEqual(CI)
  })

  it('is read from the default branch, and a failed read throws rather than permitting deferral', () => {
    expect(readTrustedReadyTestsPolicy(() => ({ prePush: { readyTests: CI } }) as never)).toEqual(CI)
    expect(() =>
      readTrustedReadyTestsPolicy(() => {
        throw new Error('could not read the trust-anchor config from the default branch')
      })
    ).toThrow('could not read')
  })

  it("this repository's own default-branch configuration opts in to required-CI ready tests", () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'vinaya.config.json'), 'utf8')) as Parameters<
      typeof readyTestsPolicyOf
    >[0]
    expect(readyTestsPolicyOf(config)).toEqual({ mode: 'ci', workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' })
  })
})

describe('the hook’s deferral decision', () => {
  it('a live driver’s ready marker for this branch and head defers, once the trusted policy opts in', () => {
    const { decision, asked } = decide()
    expect(decision).toMatchObject({ defer: true, policy: CI })
    expect(asked).toEqual(['policy'])
  })

  it.each([
    ['no marker', { marker: null }],
    ['a malformed marker', { marker: 'storage\n' }],
    ['a bare environment value and no marker', { marker: null, pushMode: 'ready' }],
    ['a wrong-branch marker', { branch: 'task/issue-2' }],
    ['a marker on a non-task branch', { branch: 'main', marker: marker({ branch: 'main' }) }],
    ['an expired marker', { now: NOW + 60_000 }],
    ['a dead driver', { isDriverAlive: () => false }],
    ['a reused pid', { isDriverAlive: (d: { startTime: string }) => d.startTime === 'another' }],
    ['another head', { pushedHead: 'b'.repeat(40) }],
    ['a ready marker on a default push', { pushMode: 'default' }]
  ])('%s grants nothing, and never reads the policy', (_name, over) => {
    const { decision, asked } = decide(over as never)
    expect('defer' in decision && decision.defer).toBe(false)
    expect(asked).not.toContain('policy')
  })

  it('a repair marker defers only for the branch’s one open pull request it names', () => {
    const repair = marker({ kind: 'repair', head: undefined, pr: 9 })
    expect(decide({ marker: repair, pushMode: 'default' }).decision).toMatchObject({ defer: true })
    for (const open of [[], [10], [9, 10]])
      expect(decide({ marker: repair, pushMode: 'default', openPullRequests: () => open }).decision).toMatchObject({
        defer: false
      })
    const failed = decide({
      marker: repair,
      pushMode: 'default',
      openPullRequests: () => {
        throw new Error('gh: HTTP 502')
      }
    })
    expect(failed.decision).toMatchObject({ defer: false })
    expect(failed.asked).not.toContain('policy')
    expect(decide({ marker: repair, pushMode: 'storage' }).decision).toMatchObject({ defer: false })
  })

  it('a default branch that does not opt in runs the tests; a failed policy read behind a live marker refuses', () => {
    expect(decide({ readPolicy: () => ({ mode: 'local' }) }).decision).toMatchObject({ defer: false })
    const refused = decide({
      readPolicy: () => {
        throw new Error('rate limited')
      }
    }).decision
    expect(refused).toMatchObject({ refuse: expect.stringContaining('rate limited') })
  })

  it('reads the pushed head from git’s own pre-push stdin', () => {
    const refs = `refs/heads/task/issue-1 ${HEAD} refs/heads/task/issue-1 ${'0'.repeat(40)}\n`
    expect(pushedHeadOf(refs, 'task/issue-1')).toBe(HEAD)
    expect(pushedHeadOf(refs, 'task/issue-2')).toBeNull()
  })

  it('parses only well-formed markers and records bound to the head and run', () => {
    expect(parseDeferralMarker(marker())).toMatchObject({ kind: 'ready', head: HEAD })
    expect(parseDeferralMarker(marker({ driver: { pid: 0, startTime: 'x' } }))).toBeNull()
    expect(parseDeferralMarker(marker({ kind: 'repair', head: undefined }))).toBeNull()
    const record = JSON.stringify({
      version: 1,
      kind: 'ready',
      head: HEAD,
      branch: 'b',
      runId: 'r',
      workflow: 'w',
      check: 'c',
      recordedAt: 'now'
    })
    expect(parseDeferredTestsRecord(record, { head: HEAD, runId: 'r' })).not.toBeNull()
    expect(parseDeferredTestsRecord(record, { head: 'b'.repeat(40) })).toBeNull()
    expect(parseDeferredTestsRecord(record, { head: HEAD, runId: 'other' })).toBeNull()
  })

  it('names the required check on its automatic Test Plan line, recognised by its first word only', () => {
    expect(readyCiPlanCommand(CI)).toBe('required-ci "Vinaya CI" .github/workflows/ci.yml')
    expect(isReadyCiCommand(readyCiPlanCommand(CI))).toBe(true)
    expect(isReadyCiCommand('echo required-ci')).toBe(false)
  })
})

describe('the policy entrypoint, run as the hook runs it', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-ready-policy-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init', '-q', '-b', 'task/issue-1')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    return dir
  }
  const run = (dir: string, env: Record<string, string>) =>
    spawnSyncBudgeted('bun', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...stripVinayaEnv(), ...env } })

  it('with no marker it answers local, asks the forge nothing, and clears a record an earlier push left', () => {
    const dir = repo()
    try {
      mkdirSync(join(dir, '.git', 'vinaya'), { recursive: true })
      const stale = join(dir, '.git', 'vinaya', 'ready-tests-deferred.json')
      writeFileSync(stale, '{}')
      const result = run(dir, { VINAYA_PUSH_MODE: 'ready', PATH: `${join(dir, 'no-gh')}:${process.env.PATH}` })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('local\n')
      expect(existsSync(stale)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a marker whose driver is gone answers local', () => {
    const dir = repo()
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
      mkdirSync(join(dir, '.git', 'vinaya'), { recursive: true })
      writeFileSync(
        join(dir, '.git', 'vinaya', 'ready-deferral'),
        marker({
          head,
          driver: { pid: 2 ** 22 + 7, startTime: 'gone' },
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        })
      )
      const result = run(dir, {
        VINAYA_PUSH_MODE: 'ready',
        VINAYA_PUSH_REFS: `refs/heads/task/issue-1 ${head} refs/heads/task/issue-1 ${head}`
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('local\n')
      expect(existsSync(join(dir, '.git', 'vinaya', 'ready-tests-deferred.json'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the generated hook’s deferral step, executed', () => {
  const HOOK = readFileSync(join(REPO_ROOT, '.vinaya', 'hooks', 'pre-push'), 'utf8')
  // The committed hook's own lines from the policy call through the selector call (doctor holds it equal to the generator's).
  const start = HOOK.indexOf('VINAYA_READY_TESTS="$(')
  const end = HOOK.indexOf('VINAYA_SELECTED_TESTS="$(')
  const step = HOOK.slice(start, HOOK.indexOf('\n', end) + 1)

  it('runs after the typecheck and before the test selector', () => {
    expect(HOOK.indexOf('bunx turbo typecheck --affected')).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(HOOK.indexOf('bunx turbo typecheck --affected'))
    expect(start).toBeGreaterThan(HOOK.indexOf('check --all --local'))
    expect(end).toBeGreaterThan(start)
  })

  function runStep(policyAnswer: string, policyExit: number, seededRecord?: string) {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-ready-hook-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const recordPath = join(dir, 'pre-push-failed-tests.json')
      if (seededRecord !== undefined) writeFileSync(recordPath, seededRecord)
      // A stand-in `bun`: the policy entrypoint answers as told; the selector and the recorder leave a mark when invoked.
      writeFileSync(
        join(bin, 'bun'),
        [
          '#!/bin/sh',
          'case "$1" in',
          `  *pre-push-ready-policy.ts) echo "${policyAnswer}"; exit ${policyExit} ;;`,
          `  *pre-push-select-tests.ts) touch "${join(dir, 'selector-ran')}"; exit 0 ;;`,
          `  *pre-push-record-tests.ts) touch "${join(dir, 'recorder-ran')}"; exit 0 ;;`,
          'esac',
          'exit 0'
        ].join('\n')
      )
      chmodSync(join(bin, 'bun'), 0o755)
      const result = spawnSyncBudgeted('sh', ['-c', step], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin` }
      })
      return {
        status: result.status,
        out: `${result.stdout}${result.stderr}`,
        selector: existsSync(join(dir, 'selector-ran')),
        recorder: existsSync(join(dir, 'recorder-ran')),
        record: seededRecord === undefined ? null : readFileSync(recordPath)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('deferred: reports the deferral and exits zero without invoking the selector', () => {
    const result = runStep('deferred', 0)
    expect(result.status).toBe(0)
    expect(result.out).toContain('vinaya pre-push: tests deferred to required CI')
    expect(result.selector).toBe(false)
  })

  it('deferred: a seeded passing record is left byte-identical and neither the selector nor the recorder runs', () => {
    const passingRecord = `${JSON.stringify({ version: 2, kind: 'passed', head: HEAD, branch: 'task/issue-1', selection: ['/r/a.test.ts'], selectionCompleted: true, context: 'ctx', recordedAt: '2026-10-29T00:00:00.000Z' }, null, 2)}\n`
    const result = runStep('deferred', 0, passingRecord)
    expect(result.status).toBe(0)
    expect(result.selector).toBe(false)
    expect(result.recorder).toBe(false)
    expect(result.record?.equals(Buffer.from(passingRecord))).toBe(true)
  })

  it('local: the selector runs as before', () => {
    const result = runStep('local', 0)
    expect(result.status).toBe(0)
    expect(result.out).not.toContain('deferred')
    expect(result.selector).toBe(true)
  })

  it('a refusal stops the push before the selector', () => {
    const result = runStep('', 1)
    expect(result.status).toBe(1)
    expect(result.selector).toBe(false)
  })
})
