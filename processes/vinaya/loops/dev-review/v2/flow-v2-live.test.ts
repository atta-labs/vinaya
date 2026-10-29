import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DevToolContext } from '../../../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { gitPath, LAST_PUSH_RESULT, SELECTION_NOTE } from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import {
  DEFERRAL_MARKER_TTL_MS,
  parseDeferralMarker,
  READY_DEFERRAL_MARKER
} from '../../../../../apps/cli/src/lib/pre-push-ready-policy'
import {
  lookupGreenRun,
  type TestRunCache,
  type TestRunCacheRecord
} from '../../../../../apps/cli/src/lib/pr-report-engine'
import {
  beginReadyDeferral,
  beginStoragePushes,
  endReadyDeferral,
  endStoragePushes,
  liveV2Functions,
  NO_LOCAL_TESTS_MARKER,
  READY_GATE_DEADLINE_MS,
  readFetchedMainTip,
  readyGateEvidence,
  runExplicitCommandsLive,
  runReadyGateLive,
  stagedPullRequestStore,
  withV2DevTools
} from './flow-v2-live'

// The live wiring of version 2: the staged pull request, the storage-push marker and the ready push run through
// the worktree's real pre-push hook, against throwaway repositories.

function repo(): string {
  const dir = fixtureDir('flow-v2-live-')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  git('init', '-q', '-b', 'task/issue-1')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
  return dir
}

const baseTools = (calls: string[]): DevToolContext =>
  ({
    publishChanges: async () => {
      calls.push('publish')
      return { ok: true, result: { pushedHead: 'h1' } }
    },
    openPullRequest: async () => {
      calls.push('open')
      return { ok: true, result: { prNumber: 9 } }
    },
    updatePullRequestBody: async () => {
      calls.push('update')
      return { ok: true, result: { prNumber: 9 } }
    }
  }) as unknown as DevToolContext

describe('withV2DevTools', () => {
  test('while no pull request is open: publish is a storage push, open and update stage the body', async () => {
    const dir = repo()
    const store = stagedPullRequestStore(join(dir, 'run'))
    const calls: string[] = []
    const pushes: string[] = []
    const tools = withV2DevTools(baseTools(calls), {
      worktreePath: dir,
      runId: 'run-1',
      branch: 'task/1',
      store,
      findOpenPullRequest: () => null,
      onStoragePush: (head) => pushes.push(head)
    })
    expect((await tools.publishChanges('Feat(x): y')).ok).toBe(true)
    expect(pushes).toEqual(['h1'])
    expect(existsSync(gitPath(dir, 'vinaya/push-mode') as string)).toBe(true)
    const opened = await tools.openPullRequest('Feat(x): y', 'Closes #1')
    expect(opened.ok && (opened.result as unknown as { staged: boolean }).staged).toBe(true)
    await tools.updatePullRequestBody('Closes #1\n\nmore')
    expect(store.read()).toEqual({ title: 'Feat(x): y', body: 'Closes #1\n\nmore' })
    expect(calls).toEqual(['publish'])
  })

  test('once a pull request is open every tool is the version 1 one, and no storage push is reported', async () => {
    const dir = repo()
    const calls: string[] = []
    const pushes: string[] = []
    const tools = withV2DevTools(baseTools(calls), {
      worktreePath: dir,
      runId: 'run-1',
      branch: 'task/1',
      store: stagedPullRequestStore(join(dir, 'run')),
      findOpenPullRequest: () => ({ number: 9 }),
      onStoragePush: (head) => pushes.push(head)
    })
    await tools.publishChanges('Feat(x): y')
    await tools.openPullRequest('t', 'b')
    await tools.updatePullRequestBody('b')
    expect(calls).toEqual(['publish', 'open', 'update'])
    expect(pushes).toEqual([])
  })

  test('run_checks runs the local checks with the staged body while no pull request is open', async () => {
    const dir = repo()
    const store = stagedPullRequestStore(join(dir, 'run'))
    store.write({ title: 't', body: 'Closes #1' })
    const seen: Record<string, string>[] = []
    const calls: string[] = []
    const base = { ...baseTools(calls), runChecks: async () => ({ ok: true, result: { passed: false, output: 'v1' } }) }
    const tools = withV2DevTools(base as unknown as DevToolContext, {
      worktreePath: dir,
      runId: 'run-1',
      store,
      findOpenPullRequest: () => null,
      onStoragePush: () => {},
      branch: 'task/issue-1',
      runLocalChecks: (env) => {
        seen.push(env)
        return { passed: true, output: 'local' }
      }
    })
    expect(await tools.runChecks()).toEqual({ ok: true, result: { passed: true, output: 'local' } })
    expect(seen).toEqual([{ BRANCH: 'task/issue-1', PR_BODY: 'Closes #1' }])
  })

  test('a staged body the opening checks refuse is refused at once, and nothing is saved', async () => {
    const dir = repo()
    const store = stagedPullRequestStore(join(dir, 'run'))
    const tools = withV2DevTools(baseTools([]), {
      worktreePath: dir,
      runId: 'run-1',
      branch: 'task/1',
      store,
      findOpenPullRequest: () => null,
      onStoragePush: () => {},
      validateBody: async () => ({ ok: false, reason: 'closes-n: no Closes line' })
    })
    const result = await tools.openPullRequest('t', 'no closes')
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).toContain('closes-n: no Closes line')
    expect(store.read()).toBeNull()
  })

  test('the storage marker is written and removed', () => {
    const dir = repo()
    beginStoragePushes(dir, { runId: 'run-1', branch: 'task/1' })
    const marker = gitPath(dir, 'vinaya/push-mode') as string
    expect(existsSync(marker)).toBe(true)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      version: 1,
      mode: 'storage',
      runId: 'run-1',
      branch: 'task/1',
      pid: process.pid
    })
    endStoragePushes(dir)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('runReadyGateLive', () => {
  const withHook = (dir: string, body: string) => {
    const hooks = join(dir, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\n${body}\n`)
    chmodSync(join(hooks, 'pre-push'), 0o755)
  }

  const headOf = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

  test('runs the hook in ready mode against the default branch, with the push ref line on its stdin', async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'read line; echo "mode=$VINAYA_PUSH_MODE base=$VINAYA_PUSH_BASE ref=$line"; exit 0')
    const result = await runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(result.passed).toBe(true)
    expect(result.output).toContain(
      `mode=ready base=origin/main ref=refs/heads/task/issue-1 ${head} refs/heads/task/issue-1 ${head}`
    )
  })

  test('refuses, without running the hook, when the worktree head is not the approved head', async () => {
    const dir = repo()
    withHook(dir, 'echo HOOK-RAN; exit 0')
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head: 'f'.repeat(40),
      remoteHead: null
    })
    expect(result.passed).toBe(false)
    expect(result.output).toContain('not the approved head')
    expect(result.output).not.toContain('HOOK-RAN')
  })

  test('refuses, without running the hook, when the worktree holds uncommitted changes', async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'echo HOOK-RAN; exit 0')
    writeFileSync(join(dir, 'stray.ts'), 'export {}\n')
    const result = await runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(result.passed).toBe(false)
    expect(result.output).toContain('uncommitted changes')
    expect(result.output).not.toContain('HOOK-RAN')
  })

  test('a refusing hook with no fresh record fails every test (`all`)', async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'echo refused; exit 1')
    const result = await runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(result.passed).toBe(false)
    expect(result.failed).toBe('all')
  })

  for (const recorded of ['fresh', 'stale', 'missing', 'passed'] as const) {
    test(`a failed ready push immediately logs only its files and wall time (${recorded})`, async () => {
      const dir = repo()
      const head = headOf(dir)
      if (recorded !== 'missing') {
        const path = gitPath(dir, LAST_PUSH_RESULT) as string
        mkdirSync(join(dir, '.git', 'vinaya'), { recursive: true })
        writeFileSync(
          path,
          JSON.stringify({
            version: 1,
            outcome: recorded === 'passed' ? 'passed' : 'failed',
            head: recorded === 'stale' ? 'old' : head,
            failed: ['a.test.ts', 'b.test.ts'],
            selection: null
          })
        )
      }
      withHook(dir, 'echo private-test-output; exit 1')
      const lines: string[] = []
      let tick = 0
      const result = await runReadyGateLive({
        worktreePath: dir,
        branch: 'task/issue-1',
        head,
        remoteHead: head,
        now: () => (tick++ === 0 ? 1000 : 3500),
        log: (line) => lines.push(line)
      })
      expect(result.passed).toBe(false)
      const failures = lines.filter((line) => line.startsWith('ready push failed:'))
      expect(failures).toEqual([
        `ready push failed: ${recorded === 'fresh' ? 'a.test.ts, b.test.ts' : 'all'}; wall time 2500 ms`
      ])
      expect(lines.join('\n')).not.toContain('private-test-output')
    })
  }

  test('a repository with no pre-push hook is the logged no-local-tests state, not a silent pass', async () => {
    const dir = repo()
    const lines: string[] = []
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'b',
      head: headOf(dir),
      remoteHead: null,
      log: (line) => lines.push(line)
    })
    expect(result.passed).toBe(true)
    expect(result.localTests).toBe('none')
    expect(lines.join('\n')).toContain(NO_LOCAL_TESTS_MARKER)
  })

  test('a hook that declares no test runner is the logged no-local-tests state', async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, `echo "${NO_LOCAL_TESTS_MARKER} (no test runner declared)"; exit 0`)
    const lines: string[] = []
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      log: (line) => lines.push(line)
    })
    expect(result.passed).toBe(true)
    expect(result.localTests).toBe('none')
    expect(lines.some((line) => line.includes(NO_LOCAL_TESTS_MARKER))).toBe(true)
  })

  test('logs the containment backend before the tests start', async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'exit 0')
    const lines: string[] = []
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      registryDir: join(dir, 'registry'),
      log: (line) => lines.push(line)
    })
    expect(result.passed).toBe(true)
    expect(result.localTests).toBeUndefined()
    expect(lines[0]).toContain('containment backend: registry')
  })

  describe('the deadline', () => {
    // A fake clock: the deadline fires at once and records the limit it was asked for.
    const fakeClock = () => {
      const asked: number[] = []
      const startDeadline = (fire: () => void, ms: number) => {
        asked.push(ms)
        fire()
        return () => {}
      }
      return { asked, startDeadline }
    }
    const hangingHook = (dir: string) => withHook(dir, 'sleep 30')

    test('a configured limit is the deadline, and the timeout line names those minutes', async () => {
      const dir = repo()
      const head = headOf(dir)
      hangingHook(dir)
      const clock = fakeClock()
      const lines: string[] = []
      const result = await runReadyGateLive({
        worktreePath: dir,
        branch: 'task/issue-1',
        head,
        remoteHead: head,
        deadlineMs: 45 * 60_000,
        startDeadline: clock.startDeadline,
        log: (line) => lines.push(line)
      })
      expect(clock.asked).toEqual([45 * 60_000])
      expect(result.timedOut).toBe(true)
      expect(result.limitMinutes).toBe(45)
      expect(lines).toContain('ready push: timed out after 45 min; the test run was stopped')
    })

    test('the default of twenty minutes applies when no limit is given', async () => {
      const dir = repo()
      const head = headOf(dir)
      hangingHook(dir)
      const clock = fakeClock()
      const lines: string[] = []
      const result = await runReadyGateLive({
        worktreePath: dir,
        branch: 'task/issue-1',
        head,
        remoteHead: head,
        startDeadline: clock.startDeadline,
        log: (line) => lines.push(line)
      })
      expect(clock.asked).toEqual([READY_GATE_DEADLINE_MS])
      expect(result.limitMinutes).toBe(20)
      expect(lines).toContain('ready push: timed out after 20 min; the test run was stopped')
    })

    test('a stopped run reports how many files the selector had chosen for this commit', async () => {
      const dir = repo()
      const head = headOf(dir)
      hangingHook(dir)
      mkdirSync(join(dir, '.git', 'vinaya'), { recursive: true })
      writeFileSync(
        join(dir, '.git', SELECTION_NOTE),
        JSON.stringify({
          version: 1,
          mode: 'full',
          head,
          fullCount: 3,
          selected: ['a.test.ts', 'b.test.ts', 'c.test.ts']
        })
      )
      const result = await runReadyGateLive({
        worktreePath: dir,
        branch: 'task/issue-1',
        head,
        remoteHead: head,
        startDeadline: fakeClock().startDeadline
      })
      expect(result.selectedCount).toBe(3)
    })

    test('a note left by another commit is not counted', async () => {
      const dir = repo()
      const head = headOf(dir)
      hangingHook(dir)
      mkdirSync(join(dir, '.git', 'vinaya'), { recursive: true })
      writeFileSync(
        join(dir, '.git', SELECTION_NOTE),
        JSON.stringify({ version: 1, mode: 'full', head: 'old', fullCount: 1, selected: ['a.test.ts'] })
      )
      const result = await runReadyGateLive({
        worktreePath: dir,
        branch: 'task/issue-1',
        head,
        remoteHead: head,
        startDeadline: fakeClock().startDeadline
      })
      expect(result.selectedCount).toBeUndefined()
    })

    test('the live functions pass the policy limit to the ready push', async () => {
      const dir = repo()
      const head = headOf(dir)
      hangingHook(dir)
      const clock = fakeClock()
      const functions = liveV2Functions({
        worktreePath: dir,
        branch: 'task/issue-1',
        store: stagedPullRequestStore(join(dir, 'run')),
        findOpenPullRequest: () => null,
        remoteHead: () => head,
        openWithDeveloperTool: async () => ({ ok: false, error: { message: 'unused' } }) as never,
        readyPushDeadlineMs: () => 90 * 60_000,
        startDeadline: clock.startDeadline
      })
      const gate = await functions.runReadyGate({ head })
      expect(clock.asked).toEqual([90 * 60_000])
      expect(gate.limitMinutes).toBe(90)
    })
  })

  test('the hook starts only once its registration is acknowledged, in its own process group', async () => {
    const dir = repo()
    const head = headOf(dir)
    const registry = join(dir, 'registry')
    // The hook reports whether a registration for its own pid existed when it started, and its group.
    withHook(
      dir,
      `found=$(grep -l "pid.:$$," "${registry}"/*/*.json 2>/dev/null | head -1); echo "registered=\${found:+yes} pgid=$(ps -o pgid= -p $$ | tr -d ' ') pid=$$"; exit 0`
    )
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      registryDir: registry
    })
    expect(result.output).toContain('registered=yes')
    const match = /pgid=(\d+) pid=(\d+)/.exec(result.output)
    expect(match?.[1]).toBe(match?.[2])
    // The run's registrations are removed once it ends.
    expect(existsSync(registry) ? readdirSync(registry) : []).toEqual([])
  })

  test('the repository hook receives only its explicit environment and no planted driver credentials', async () => {
    const dir = repo()
    const head = headOf(dir)
    const keys = [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'VINAYA_RUNTIME_DIR',
      'UNDECLARED_TEST_SETTING'
    ]
    const previous = keys.map((key) => process.env[key])
    try {
      for (const key of keys) process.env[key] = 'planted-driver-secret'
      withHook(dir, 'env | sort')
      const result = await runReadyGateLive({
        worktreePath: dir,
        branch: 'task/issue-1',
        head,
        remoteHead: head,
        registryDir: join(dir, 'registry')
      })
      expect(result.passed).toBe(true)
      expect(result.output).not.toContain('planted-driver-secret')
      for (const key of keys) expect(result.output).not.toContain(`${key}=`)
      expect(result.output).toContain('PATH=')
      expect(result.output).toContain('HOME=')
      expect(result.output).toContain('TMPDIR=')
      expect(result.output).toContain('VINAYA_PUSH_MODE=ready')
    } finally {
      for (const [i, key] of keys.entries()) {
        if (previous[i] === undefined) delete process.env[key]
        else process.env[key] = previous[i]
      }
    }
  })

  test('the selected tests see their own temp folder, removed when the run ends', async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'echo "tmp=$TMPDIR"; touch "$TMPDIR/left-behind"; exit 0')
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      registryDir: join(dir, 'registry')
    })
    const tmp = /tmp=(\S+)/.exec(result.output)?.[1] ?? ''
    expect(tmp).toBeTruthy()
    expect(existsSync(tmp)).toBe(false)
  })
})

// The default branch's tip a conflict repair is proven against: read from the driver-built URL and fetched from it,
// never through the worktree's own `origin`, and null when it cannot be read.
describe('readFetchedMainTip', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  const setUp = () => {
    const remote = fixtureDir('main-tip-remote-')
    git(remote, 'init', '-q', '-b', 'main')
    git(remote, 'commit', '-q', '--allow-empty', '-m', 'base')
    const worktree = fixtureDir('main-tip-worktree-')
    git(worktree, 'clone', '-q', remote, '.')
    // A tip the worktree has never seen, and a worktree `origin` that points somewhere else entirely.
    git(remote, 'commit', '-q', '--allow-empty', '-m', 'main moves')
    const tip = git(remote, 'rev-parse', 'HEAD')
    git(worktree, 'remote', 'set-url', 'origin', join(fixtureDir('main-tip-elsewhere-'), 'missing.git'))
    return { remote, worktree, tip }
  }

  test('fetches the tip from the URL into the worktree object store, not through its origin', () => {
    const { remote, worktree, tip } = setUp()
    expect(() => git(worktree, 'cat-file', '-e', `${tip}^{commit}`)).toThrow()
    expect(readFetchedMainTip(worktree, `file://${remote}`)).toBe(tip)
    expect(git(worktree, 'cat-file', '-t', tip)).toBe('commit')
  })

  test('is null when the run names no URL, or the URL cannot be read', () => {
    const { worktree } = setUp()
    expect(readFetchedMainTip(worktree, null)).toBeNull()
    expect(readFetchedMainTip(worktree, `file://${join(worktree, 'no-such-repo')}`)).toBeNull()
  })
})

describe('readyGateEvidence for a repaired head', () => {
  test('a ready push that passed on the pre-merge head never stands in for the merge', async () => {
    const dir = fixtureDir('ready-evidence-repaired-')
    const resultPath = join(dir, 'ready-gate.json')
    const judged = 'a'.repeat(40)
    const merged = 'b'.repeat(40)
    writeFileSync(
      resultPath,
      JSON.stringify({
        head: judged,
        gate: { passed: true, output: 'ok', selection: null, failed: [], wallMs: 1 }
      })
    )
    await expect(readyGateEvidence({ body: 'Closes #1', head: merged, resultPath, worktreePath: dir })).rejects.toThrow(
      'no successful ready-gate result for the approved head'
    )
  })
})

describe('the ready push deferring its selected tests to required CI', () => {
  const headOf = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  const withHook = (dir: string, body: string) => {
    const hooks = join(dir, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-push'), `#!/bin/sh\n${body}\n`)
    chmodSync(join(hooks, 'pre-push'), 0o755)
  }
  // What the generated hook's deferral step records: the head and run, bound to the marker the driver wrote.
  const deferringHook = (runId: string) =>
    [
      'm="$(git rev-parse --git-path vinaya/ready-deferral)"',
      '[ -f "$m" ] || { echo "no marker"; exit 0; }',
      'read -r line; set -- $line',
      `printf '{"version":1,"kind":"ready","head":"%s","branch":"task/issue-1","runId":"${runId}","workflow":".github/workflows/ci.yml","check":"Vinaya CI","recordedAt":"now"}' "$2" > "$(git rev-parse --git-path vinaya/ready-tests-deferred.json)"`,
      'echo "vinaya pre-push: tests deferred to required CI"',
      'exit 0'
    ].join('\n')

  test('a marked ready push whose hook deferred reads `deferred` from the head- and run-bound record; the marker is gone after', async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, deferringHook('run-1'))
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      deferTests: true,
      runId: 'run-1'
    })
    expect(result).toMatchObject({
      passed: true,
      localTests: 'deferred',
      requiredCi: { check: 'Vinaya CI' },
      selection: null
    })
    expect(existsSync(gitPath(dir, READY_DEFERRAL_MARKER) as string)).toBe(false)
  })

  test("another run's record, or a push the driver did not mark, is never deferred", async () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, deferringHook('someone-else'))
    const other = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      deferTests: true,
      runId: 'run-1'
    })
    expect(other.localTests).toBeUndefined()
    withHook(dir, deferringHook('run-1'))
    const unmarked = await runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(unmarked.localTests).toBeUndefined()
    expect(unmarked.output).toContain('no marker')
  })

  test('a nested fixture printing the no-local-tests marker inside a real test run never makes it the no-runner state', async () => {
    const dir = repo()
    const head = headOf(dir)
    // The hook ran a nonempty selection (its record says so) while a test's own fixture printed the marker line.
    const record = JSON.stringify({
      version: 1,
      head,
      branch: 'task/issue-1',
      mode: 'ready',
      outcome: 'passed',
      selection: { version: 1, mode: 'full', head, fullCount: 1, selected: ['a.test.ts'] },
      failed: [],
      elapsedSeconds: 1,
      recordedAt: new Date().toISOString()
    })
    withHook(
      dir,
      [
        `mkdir -p "$(dirname "$(git rev-parse --git-path ${LAST_PUSH_RESULT})")"`,
        `printf '%s' '${record}' > "$(git rev-parse --git-path ${LAST_PUSH_RESULT})"`,
        `echo "${NO_LOCAL_TESTS_MARKER} (no test runner declared)"`,
        'echo "vinaya pre-push: selected 1 file(s), 1s — all green"',
        'exit 0'
      ].join('\n')
    )
    const result = await runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(result.passed).toBe(true)
    expect(result.localTests).toBeUndefined()
    expect(result.selection?.selected).toEqual(['a.test.ts'])
  })

  test('the deferral marker names this driver, the run, the branch and the head, and expires', () => {
    const dir = repo()
    expect(
      beginReadyDeferral(dir, { kind: 'ready', runId: 'run-1', branch: 'task/issue-1', head: 'a'.repeat(40) }, () => 0)
    ).toBe(true)
    const marker = parseDeferralMarker(readFileSync(gitPath(dir, READY_DEFERRAL_MARKER) as string, 'utf8'))
    expect(marker).toMatchObject({
      kind: 'ready',
      runId: 'run-1',
      branch: 'task/issue-1',
      driver: { pid: process.pid }
    })
    expect(Date.parse(marker?.expiresAt ?? '')).toBe(DEFERRAL_MARKER_TTL_MS)
    endReadyDeferral(dir)
    expect(existsSync(gitPath(dir, READY_DEFERRAL_MARKER) as string)).toBe(false)
  })

  test('a starting run removes a deferral marker an earlier run left', () => {
    const dir = repo()
    beginReadyDeferral(dir, { kind: 'repair', runId: 'old', branch: 'task/issue-1', pr: 9 })
    liveV2Functions({
      worktreePath: dir,
      branch: 'task/issue-1',
      store: stagedPullRequestStore(join(dir, 'run')),
      findOpenPullRequest: () => null,
      remoteHead: () => null,
      openWithDeveloperTool: async () => ({ ok: true, result: { prNumber: 1 } })
    })
    expect(existsSync(gitPath(dir, READY_DEFERRAL_MARKER) as string)).toBe(false)
  })
})

describe('a driver-owned repair push on the run’s own open pull request', () => {
  const marked = (dir: string) => existsSync(gitPath(dir, READY_DEFERRAL_MARKER) as string)

  test('with the default branch opting in, the publish carries a repair marker for that pull request, removed after', async () => {
    const dir = repo()
    let seen: unknown = null
    const base = {
      ...baseTools([]),
      publishChanges: async () => {
        seen = parseDeferralMarker(readFileSync(gitPath(dir, READY_DEFERRAL_MARKER) as string, 'utf8'))
        return { ok: true, result: { pushedHead: 'h2' } }
      }
    } as unknown as DevToolContext
    const tools = withV2DevTools(base, {
      worktreePath: dir,
      runId: 'run-1',
      branch: 'task/issue-1',
      store: stagedPullRequestStore(join(dir, 'run')),
      findOpenPullRequest: () => ({ number: 9 }),
      onStoragePush: () => {},
      readyTestsPolicy: () => POLICY_CI,
      checkBaseline: () => ({ ok: true })
    })
    expect((await tools.publishChanges('Fix(x): y')).ok).toBe(true)
    expect(seen).toMatchObject({ kind: 'repair', pr: 9, runId: 'run-1', branch: 'task/issue-1' })
    expect(marked(dir)).toBe(false)
  })

  test('no opt-in, a failed policy read or no open pull request writes no repair marker', async () => {
    for (const [policy, open] of [
      [() => ({ mode: 'local' as const }), { number: 9 }],
      [
        () => {
          throw new Error('offline')
        },
        { number: 9 }
      ],
      [() => POLICY_CI, null]
    ] as const) {
      const dir = repo()
      let sawMarker = false
      const base = {
        ...baseTools([]),
        publishChanges: async () => {
          sawMarker = marked(dir)
          return { ok: true, result: { pushedHead: 'h' } }
        }
      } as unknown as DevToolContext
      const tools = withV2DevTools(base, {
        worktreePath: dir,
        runId: 'run-1',
        branch: 'task/issue-1',
        store: stagedPullRequestStore(join(dir, 'run')),
        findOpenPullRequest: () => open,
        onStoragePush: () => {},
        readyTestsPolicy: policy
      })
      await tools.publishChanges('Fix(x): y')
      expect(sawMarker).toBe(false)
    }
  })

  test('a stale loop baseline refuses the repair publish before anything runs', async () => {
    const dir = repo()
    const calls: string[] = []
    const tools = withV2DevTools(baseTools(calls), {
      worktreePath: dir,
      runId: 'run-1',
      branch: 'task/issue-1',
      store: stagedPullRequestStore(join(dir, 'run')),
      findOpenPullRequest: () => ({ number: 9 }),
      onStoragePush: () => {},
      readyTestsPolicy: () => POLICY_CI,
      checkBaseline: () => ({ ok: false, reason: 'refresh the baseline' })
    })
    const result = await tools.publishChanges('Fix(x): y')
    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
    expect(marked(dir)).toBe(false)
  })
})

describe('the explicit Test Plan commands the driver runs at the publication boundary', () => {
  const memoryCache = (): TestRunCache => {
    const store = new Map<string, TestRunCacheRecord>()
    return { get: (key) => store.get(key), set: (key, record) => void store.set(key, record) }
  }
  const headOf = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  const counter = () => join(fixtureDir('explicit-counter-'), 'runs')
  const count = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').length : 0)

  test('a command runs once and records its receipt; an unchanged head reuses it; a merge head runs it again', async () => {
    const dir = repo()
    const runs = counter()
    const cache = memoryCache()
    const command = `cd . && printf x >> ${JSON.stringify(runs)}`
    const run = (head: string) =>
      runExplicitCommandsLive({
        worktreePath: dir,
        head,
        branch: 'task/issue-1',
        body: '',
        commands: [command],
        deadlineAt: Date.now() + 60_000,
        cache
      })
    const first = await run(headOf(dir))
    expect(first.outcome).toBe('passed')
    expect(count(runs)).toBe(1)
    const second = await run(headOf(dir))
    expect(second.outcome).toBe('passed')
    expect(second.results[0]?.reusedFrom).toBeDefined()
    expect(count(runs)).toBe(1)
    // A driver-made merge head is a new state: its receipt is obtained by running the command again.
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'merge'], {
      cwd: dir
    })
    const merged = await run(headOf(dir))
    expect(merged.outcome).toBe('passed')
    expect(merged.results[0]?.reusedFrom).toBeUndefined()
    expect(count(runs)).toBe(2)
  })

  test('a failing command stops the phase with its command and output, and records no receipt', async () => {
    const dir = repo()
    const cache = memoryCache()
    const failing = 'echo "expected 1 to be 2"; exit 3'
    const result = await runExplicitCommandsLive({
      worktreePath: dir,
      head: headOf(dir),
      branch: 'b',
      body: '',
      commands: [failing, 'echo never'],
      deadlineAt: Date.now() + 60_000,
      cache
    })
    expect(result.outcome).toBe('failed')
    expect(result.results).toEqual([
      expect.objectContaining({ command: failing, outcome: 'failed', exitCode: 3, output: 'expected 1 to be 2' })
    ])
    expect(await lookupGreenRun(failing, dir, cache)).toBeNull()
  })

  test('a command past its limit is stopped as a timeout, never a pass', async () => {
    const dir = repo()
    const result = await runExplicitCommandsLive({
      worktreePath: dir,
      head: headOf(dir),
      branch: 'b',
      body: '',
      commands: ['sleep 30'],
      deadlineAt: Date.now() + 60_000,
      cache: memoryCache(),
      commandTimeoutMs: 300
    })
    expect(result.outcome).toBe('timed-out')
  })

  test('a cancel stops the phase', async () => {
    const dir = repo()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    await expect(
      runExplicitCommandsLive({
        worktreePath: dir,
        head: headOf(dir),
        branch: 'b',
        body: '',
        commands: ['sleep 30'],
        deadlineAt: Date.now() + 60_000,
        cache: memoryCache(),
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled')
  })

  test('a head that is not the published one runs nothing', async () => {
    const dir = repo()
    const runs = counter()
    const result = await runExplicitCommandsLive({
      worktreePath: dir,
      head: 'f'.repeat(40),
      branch: 'b',
      body: '',
      commands: [`printf x >> ${runs}`],
      deadlineAt: Date.now() + 60_000,
      cache: memoryCache()
    })
    expect(result.outcome).toBe('drift')
    expect(count(runs)).toBe(0)
  })
})

const POLICY_CI = { mode: 'ci' as const, workflow: '.github/workflows/ci.yml', check: 'Vinaya CI' }
