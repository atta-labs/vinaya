import { describe, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FAILED_TESTS_RECORD, gitPath } from '../../../../apps/cli/src/lib/pre-push-failed-tests'
import { identityOf } from '../../../../apps/cli/src/lib/process-registry'
import { fixtureDir } from '../../../../apps/cli/tests/lib/test-temp-fixture'
import { ReadyGateCancelledError, runReadyGateLive, sweepReadyGateRuns } from '../../loops/dev-review/v2/flow-v2-live'
import { createTestTempRun, readOwnerMarker, removeTestTempRun } from '../../../../apps/cli/src/lib/test-temp'
import type { RecoveryRunner } from './runners'

// The ready-gate test run is cancellable and contained. Only version 2 of the Engine flow has a ready gate, so the
// cases name that runner alone.

const READY_GATE_RUNNERS: readonly RecoveryRunner[] = ['engine-v2']

function repo(): string {
  const dir = fixtureDir('ready-gate-recovery-')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  git('init', '-q', '-b', 'task/issue-1')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base')
  return dir
}

const headOf = (dir: string) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()

/** A hook that starts a background test process and a foreground one, records both pids and its temp folder. */
function slowHook(dir: string, pids: string): void {
  const hooks = join(dir, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(
    join(hooks, 'pre-push'),
    `#!/bin/sh
sleep 300 &
echo "$!" >> "${pids}"
touch "$TMPDIR/test-fixture"
echo "$TMPDIR" > "${pids}.tmp"
sleep 300 &
echo "$!" >> "${pids}"
wait
`
  )
  chmodSync(join(hooks, 'pre-push'), 0o755)
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const pidsIn = (path: string): number[] =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => Number(line))
    : []

describe.each(READY_GATE_RUNNERS)('%s', () => {
  test('recovery reaps a killed driver’s detached gate before deleting its owned storage', async () => {
    const dir = repo()
    const pids = join(dir, '.git', 'owned-pids')
    slowHook(dir, pids)
    const script = join(dir, '.git', 'driver.ts')
    const modulePath = new URL('../../loops/dev-review/v2/flow-v2-live.ts', import.meta.url).pathname
    writeFileSync(
      script,
      `import {runReadyGateLive} from ${JSON.stringify(modulePath)}; await runReadyGateLive(${JSON.stringify({ worktreePath: dir, branch: 'task/issue-1', head: headOf(dir) })})`
    )
    const live = createTestTempRun('ready-gates')
    const driver = spawn('bun', [script], { env: process.env, stdio: 'ignore' })
    let owned = ''
    let children: number[] = []
    try {
      await waitFor(() => existsSync(`${pids}.tmp`) && pidsIn(pids).length === 2)
      owned = readFileSync(`${pids}.tmp`, 'utf8').trim()
      children = pidsIn(pids)
      expect(readOwnerMarker(owned)?.owner.pid).toBe(driver.pid!)
      const metadata = JSON.parse(readFileSync(join(owned, 'registry.json'), 'utf8'))
      expect(metadata.token).toBe(readOwnerMarker(owned)?.owner.runToken)
      const died = new Promise<void>((resolve) => driver.once('exit', () => resolve()))
      driver.kill('SIGKILL')
      await died
      expect(children.some((pid) => identityOf(pid) !== null)).toBe(true)
      await sweepReadyGateRuns()
      expect(existsSync(owned)).toBe(false)
      expect(existsSync(live.dir)).toBe(true)
      await waitFor(() => children.every((pid) => identityOf(pid) === null), 1000)
    } finally {
      driver.kill('SIGKILL')
      for (const pid of children) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await sweepReadyGateRuns()
      const cleanup = removeTestTempRun(live)
      expect(cleanup.failed).toEqual([])
    }
  })

  test('a cancel during the ready-gate run ends every registered process and removes its directories', async () => {
    const dir = repo()
    const head = headOf(dir)
    const pids = join(dir, 'pids')
    const registry = join(dir, 'registry')
    slowHook(dir, pids)
    const controller = new AbortController()
    const run = runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      signal: controller.signal,
      registryDir: registry
    })
    await waitFor(() => pidsIn(pids).length === 2)
    const tmp = readFileSync(`${pids}.tmp`, 'utf8').trim()
    expect(existsSync(join(tmp, 'test-fixture'))).toBe(true)
    controller.abort()
    await expect(run).rejects.toBeInstanceOf(ReadyGateCancelledError)
    for (const pid of pidsIn(pids)) expect(identityOf(pid)).toBeNull()
    expect(existsSync(tmp)).toBe(false)
    expect(existsSync(registry) ? readdirSync(registry) : []).toEqual([])
  })

  test('the deadline settles even when an unregistered detached child holds the output pipe open', async () => {
    const dir = repo()
    const head = headOf(dir)
    const pidFile = join(dir, '.git', 'detached-pid')
    const script = join(dir, '.git', 'detach.ts')
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 1, 2] });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.unref();`
    )
    writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), `exec '${process.execPath}' '${script}'`)
    const run = runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      deadlineMs: 500,
      registryDir: join(dir, '.git', 'registry')
    })
    let result: Awaited<typeof run> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await waitFor(() => existsSync(pidFile))
      result = await Promise.race([
        run,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 2500)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      // Only this fixture's recorded, detached child is outside the registry's containment guarantee.
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (identityOf(pid) !== null) process.kill(-pid, 'SIGKILL')
      await run
    }
    expect(result).not.toBeNull()
    expect(result?.timedOut).toBe(true)
  })

  for (const code of ['ENOSPC', 'EACCES'])
    test(`registration failure ${code} reaps the unacknowledged gated child`, async () => {
      const dir = repo()
      const head = headOf(dir)
      const started = join(dir, '.git', 'hook-started')
      writeFileSync(join(dir, '.git', 'hooks', 'pre-push'), `touch '${started}'`)
      let pid = 0
      try {
        await expect(
          runReadyGateLive({
            worktreePath: dir,
            branch: 'task/issue-1',
            head,
            remoteHead: head,
            registryDir: join(dir, '.git', 'registry'),
            register: async (entry) => {
              pid = entry.pid
              throw Object.assign(new Error(`${code}: registration refused`), { code })
            }
          })
        ).rejects.toThrow(`${code}: registration refused`)
        expect(pid).toBeGreaterThan(0)
        expect(existsSync(started)).toBe(false)
        expect(identityOf(pid)).toBeNull()
      } finally {
        if (pid > 0 && identityOf(pid) !== null) process.kill(-pid, 'SIGKILL')
      }
    })

  test('a ready gate past its deadline records a timeout instead of hanging', async () => {
    const dir = repo()
    const head = headOf(dir)
    const pids = join(dir, 'pids')
    slowHook(dir, pids)
    // A stale refusal record: a stopped run leaves no complete one, so the next ready push must run in full.
    const record = gitPath(dir, FAILED_TESTS_RECORD) as string
    mkdirSync(join(record, '..'), { recursive: true })
    writeFileSync(record, '{}')
    const started = Date.now()
    const result = await runReadyGateLive({
      worktreePath: dir,
      branch: 'task/issue-1',
      head,
      remoteHead: head,
      deadlineMs: 1500,
      registryDir: join(dir, 'registry')
    })
    expect(Date.now() - started).toBeLessThan(15000)
    expect(result.passed).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(result.failed).toBe('all')
    expect(result.output).toContain('timed out')
    for (const pid of pidsIn(pids)) expect(identityOf(pid)).toBeNull()
    expect(existsSync(record)).toBe(false)
  })
})
