/**
 * A process the driver's own tools start — a push running the pre-push hook and
 * its tests, a check run, an evidence refresh — ends when the driver does.
 *
 * Those tools call the child synchronously, because the effect chain they sit
 * in is synchronous. A synchronous call blocks the driver's event loop, so a
 * signal handler registered in the driver cannot run until the child finishes,
 * and a driver killed outright never runs one at all. The child therefore
 * carries its own guard: `guardedSpawnSync` starts it through a small watcher
 * process that runs the real command in a process group of its own and, when
 * the driver that started the watcher is gone, signals exactly that group.
 *
 * Only the group the watcher itself created is ever signalled — never a process
 * found by name and never a scan of the system — so a parallel loop on the same
 * host is untouched. SIGTERM goes first, so a check runner inside the group
 * forwards it to the groups it started itself; SIGKILL follows after a grace
 * period for anything that ignores it.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

/** How long a signalled group gets to exit on SIGTERM before it is killed. */
export const GUARD_KILL_GRACE_MS = 10_000

/** How often the watcher checks that its driver is still its parent. */
export const GUARD_POLL_MS = 250

const GUARD_ARGV_ENV = 'VINAYA_TOOL_GUARD_ARGV'
const GUARD_GRACE_ENV = 'VINAYA_TOOL_GUARD_GRACE_MS'
const GUARD_POLL_ENV = 'VINAYA_TOOL_GUARD_POLL_MS'

/**
 * The watcher, run with `<runtime> -e`. It reads its command from the
 * environment, so it depends on no file path and behaves the same under `bun`
 * from source and `node` from a published build.
 */
const GUARD_SOURCE = `
const { spawn } = require('node:child_process')
const [command, ...args] = JSON.parse(process.env.${GUARD_ARGV_ENV})
const graceMs = Number(process.env.${GUARD_GRACE_ENV})
const pollMs = Number(process.env.${GUARD_POLL_ENV})
const env = { ...process.env }
delete env.${GUARD_ARGV_ENV}
delete env.${GUARD_GRACE_ENV}
delete env.${GUARD_POLL_ENV}
const driverPid = process.ppid
const child = spawn(command, args, { detached: true, stdio: 'inherit', env })
child.on('error', (err) => {
  process.stderr.write(command + ': ' + err.message + '\\n')
  process.exit(127)
})
child.on('exit', (code, signal) => {
  process.exit(code === null ? 128 + (signal === 'SIGKILL' ? 9 : 15) : code)
})
let stopping = false
function stopGroup() {
  if (stopping || child.pid === undefined) return
  stopping = true
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    process.exit(137)
  }, graceMs)
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stopGroup)
setInterval(() => { if (process.ppid !== driverPid) stopGroup() }, pollMs)
`

/**
 * `spawnSync(command, args, options)`, with the child ended when the calling
 * process ends. The result has `spawnSync`'s own shape: `status` is the
 * command's exit code, `stdout`/`stderr` its captured streams, and a command
 * that could not start reports status 127 with the reason on `stderr`.
 */
export function guardedSpawnSync(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'> & {
    guardGraceMs?: number
    guardPollMs?: number
  } = {}
): SpawnSyncReturns<string> {
  const { guardGraceMs, guardPollMs, ...spawnOptions } = options
  return spawnSync(process.argv[0] as string, ['-e', GUARD_SOURCE], {
    ...spawnOptions,
    encoding: 'utf8',
    env: {
      ...(spawnOptions.env ?? process.env),
      [GUARD_ARGV_ENV]: JSON.stringify([command, ...args]),
      [GUARD_GRACE_ENV]: String(guardGraceMs ?? GUARD_KILL_GRACE_MS),
      [GUARD_POLL_ENV]: String(guardPollMs ?? GUARD_POLL_MS)
    }
  })
}
