import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DevToolContext } from '../../../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { gitPath } from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import {
  beginStoragePushes,
  endStoragePushes,
  NO_LOCAL_TESTS_MARKER,
  runReadyGateLive,
  stagedPullRequestStore,
  withV2DevTools
} from './flow-v2-live'

// The live wiring of version 2: the staged pull request, the storage-push marker and the ready push run through
// the worktree's real pre-push hook, against throwaway repositories.

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-v2-live-'))
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
    expect(tmp).toContain('vinaya-ready-gate-')
    expect(existsSync(tmp)).toBe(false)
  })
})
