import { fixtureDir } from '../../../../../apps/cli/tests/lib/test-temp-fixture'
import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DevToolContext } from '../../../../../apps/cli/src/lib/task-tools/dev-tools-server'
import { gitPath } from '../../../../../apps/cli/src/lib/pre-push-failed-tests'
import {
  beginStoragePushes,
  endStoragePushes,
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

  test('runs the hook in ready mode against the default branch, with the push ref line on its stdin', () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'read line; echo "mode=$VINAYA_PUSH_MODE base=$VINAYA_PUSH_BASE ref=$line"; exit 0')
    const result = runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(result.passed).toBe(true)
    expect(result.output).toContain(
      `mode=ready base=origin/main ref=refs/heads/task/issue-1 ${head} refs/heads/task/issue-1 ${head}`
    )
  })

  test('refuses, without running the hook, when the worktree head is not the approved head', () => {
    const dir = repo()
    withHook(dir, 'echo HOOK-RAN; exit 0')
    const result = runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head: 'f'.repeat(40),
      remoteHead: null
    })
    expect(result.passed).toBe(false)
    expect(result.output).toContain('not the approved head')
    expect(result.output).not.toContain('HOOK-RAN')
  })

  test('refuses, without running the hook, when the worktree holds uncommitted changes', () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'echo HOOK-RAN; exit 0')
    writeFileSync(join(dir, 'stray.ts'), 'export {}\n')
    const result = runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(result.passed).toBe(false)
    expect(result.output).toContain('uncommitted changes')
    expect(result.output).not.toContain('HOOK-RAN')
  })

  test('a refusing hook with no fresh record fails every test (`all`)', () => {
    const dir = repo()
    const head = headOf(dir)
    withHook(dir, 'echo refused; exit 1')
    const result = runReadyGateLive({ worktreePath: dir, branch: 'task/issue-1', head, remoteHead: head })
    expect(result.passed).toBe(false)
    expect(result.failed).toBe('all')
  })

  test('a repository with no pre-push hook has nothing to run', () => {
    const dir = repo()
    expect(runReadyGateLive({ worktreePath: dir, branch: 'b', head: headOf(dir), remoteHead: null }).passed).toBe(true)
  })
})
