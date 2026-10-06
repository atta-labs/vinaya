/**
 * The one way a driver is launched out of an interactive shell: detached, in
 * its own process group, so it keeps running after the process that launched
 * it exits. The background task run, the Operator's `task_start` and the
 * Operator's `task_resume` all start their driver through `launchDetached`,
 * and the two Operator tools confirm it came up through the one
 * `waitForLiveDriver`, so none of them carries a copy that could drift from
 * the others.
 *
 * `detached: true` makes the child the leader of its own process group and
 * session, which is what lets it outlive the terminal or server that spawned
 * it. No `nohup` and no shell wrapper stands in for it.
 */

import { type ChildProcess, spawn, type StdioOptions } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isDriverPidAlive, readDriverLock } from './dev-review-loop/pause-resume.js'

/** Starts `program` detached, in its own process group, with `stdio` as given. The caller closes any descriptor it opened for `stdio` once this returns. */
export function launchDetached(program: string, args: string[], stdio: StdioOptions): ChildProcess {
  return spawn(program, args, { detached: true, stdio })
}

/** Re-invokes the exact interpreter and entry script this process was started with, detached — so a launch behaves the same whether the caller ran `bun apps/cli/src/index.ts` from source or a published `vinaya` binary. */
export function launchSelfDetached(argv: string[], stdio: StdioOptions): ChildProcess {
  return launchDetached(process.argv[0] as string, [process.argv[1] as string, ...argv], stdio)
}

/**
 * What launching a driver and waiting for its own confirmation produced:
 *
 *   - `confirmed` — the run's driver lock appeared and named a live pid inside
 *     the bounded wait.
 *   - `starting` — the wait ended first and the launched process is STILL
 *     ALIVE: a run whose preparation outlasted the wait, never a failed start.
 *   - `exited` — the process exited, or never spawned, first. The only failed
 *     start.
 *
 * `pid` is the launched child's own pid, recorded on the caller's claim so a
 * later call can re-check liveness against the process itself.
 */
export type LaunchResult =
  | { status: 'confirmed'; pid: number | null }
  | { status: 'starting'; pid: number | null }
  | { status: 'exited'; error: Error }

export function readCapturedStderr(path: string): string {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    return raw ? ` — captured stderr:\n${raw}` : ''
  } catch {
    return ''
  }
}

/**
 * Races the spawned child's own `error`/`exit` against its task's driver lock
 * appearing and naming a live pid — never a sleep-then-assume. Whichever
 * happens first decides the outcome; the loser's listeners and timers are torn
 * down so this never resolves twice.
 *
 * The wait itself running out decides NOTHING about the run: the child is
 * still alive (its own `exit` would have won the race otherwise), so the
 * outcome is `starting`, not a failure. Raising `timeoutMs` would only move
 * that cliff, since a slow forge or a large start-of-run sweep can outlast any
 * fixed wait.
 */
export function waitForLiveDriver(
  child: ChildProcess,
  root: string,
  task: number,
  stderrPath: string,
  timeoutMs: number,
  pollMs: number
): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let settled = false
    const finishAlive = (status: 'confirmed' | 'starting') => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      child.removeAllListeners('error')
      child.removeAllListeners('exit')
      // The run is alive and must outlive this process — unref only now, never
      // before the race is decided, so a premature exit is still observed.
      child.unref()
      resolve({ status, pid: child.pid ?? null })
    }
    const finishDead = (reason: string) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      resolve({ status: 'exited', error: new Error(`${reason}${readCapturedStderr(stderrPath)}`) })
    }
    child.on('error', (err) => finishDead(`spawn failed: ${err instanceof Error ? err.message : String(err)}`))
    child.on('exit', (code, signal) =>
      finishDead(
        `process exited before its driver confirmed alive (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
      )
    )
    const poll = setInterval(() => {
      const lock = readDriverLock(root, task)
      if (lock && isDriverPidAlive(lock.pid)) finishAlive('confirmed')
    }, pollMs)
    const timer = setTimeout(() => finishAlive('starting'), timeoutMs)
  })
}
