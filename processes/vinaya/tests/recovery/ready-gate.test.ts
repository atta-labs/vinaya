import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAILED_TESTS_RECORD, gitPath } from '../../../../apps/cli/src/lib/pre-push-failed-tests'
import { identityOf } from '../../../../apps/cli/src/lib/process-registry'
import { ReadyGateCancelledError, runReadyGateLive } from '../../loops/dev-review/v2/flow-v2-live'
import type { RecoveryRunner } from './runners'

// The ready-gate test run is cancellable and contained. Only version 2 of the Engine flow has a ready gate, so the
// cases name that runner alone.

const READY_GATE_RUNNERS: readonly RecoveryRunner[] = ['engine-v2']

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ready-gate-recovery-'))
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
