// Containment of interrupted test runs: a supervisor-owned registry of the processes a run started. The test-temp
// sweep calls `stopRegistered` to end a run's surviving processes before it deletes that run's directories.
//
// A process is known by its pid plus its start time, so a reused pid is never mistaken for the original. A child
// registers before it does any work and the supervisor acknowledges it; stopping sends TERM, waits, then KILL.
// A registered process group is signalled as a group, so its undetached descendants stop with it.
// Limit: a subprocess that never registers and leaves the registered group (an adopter's own uninstrumented tool
// that detaches, for example with `setsid`) is not contained by this backend, on any OS.

import { execFileSync } from 'node:child_process'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Which containment backend a run used; logged before tests start. */
export type ContainmentBackend = 'registry' | 'cgroup-scope'

/** A process as the registry knows it. */
export interface ProcessIdentity {
  pid: number
  /** The process start time as the OS reports it, used to tell a live owner from a reused pid. */
  startTime: string
}

/** One registered process of a run. */
export interface RegisteredProcess extends ProcessIdentity {
  /** The run the process belongs to. */
  runToken: string
  /** A short label for logs, for example the fixture that spawned it. */
  label: string
  /** True when the process leads its own process group: stopping it signals the whole group. */
  processGroup?: boolean
  /** Members observed while the leader identity was still verified. */
  members?: ProcessIdentity[]
}

export interface StopOptions {
  /** How long to wait after TERM before sending KILL. */
  graceMs: number
  /** The registry folder; defaults to `registryDir()`. */
  dir?: string
}

/** What stopping a run's processes did. */
export interface StopReport {
  backend: ContainmentBackend
  terminated: ProcessIdentity[]
  killed: ProcessIdentity[]
  /** Processes that were already gone, or whose pid now belongs to a different start time. */
  alreadyGone: ProcessIdentity[]
}

/** Where registrations live: `VINAYA_PROCESS_REGISTRY_DIR`, else `~/.vinaya/process-registry`. */
export function registryDir(): string {
  return process.env.VINAYA_PROCESS_REGISTRY_DIR || join(homedir(), '.vinaya', 'process-registry')
}

/** A run token as a safe folder name. */
const runFolder = (dir: string, runToken: string): string => join(dir, encodeURIComponent(runToken))

/**
 * The backend this host will use for a run. The registry is used on every OS; a cgroup scope backend is not built,
 * so a run on Linux uses the registry too and its log line says so.
 */
export function selectContainmentBackend(): ContainmentBackend {
  return 'registry'
}

/** The line a run logs before its tests start, naming the backend and what it does not contain. */
export function containmentLogLine(backend: ContainmentBackend): string {
  return `containment backend: ${backend} (the test run's process group is stopped on cancel and deadline; a subprocess that leaves that group without registering is not contained)`
}

/**
 * Records `process` for `runToken` and returns once the registration is durable (the acknowledgement): the record
 * is written, flushed and renamed into place before this resolves, so a crash after it still leaves the record.
 */
export async function registerProcess(entry: RegisteredProcess, opts: { dir?: string } = {}): Promise<void> {
  if (entry.processGroup && isSameProcessAlive(entry)) entry = { ...entry, members: observedGroupMembers(entry) }
  const folder = runFolder(opts.dir ?? registryDir(), entry.runToken)
  mkdirSync(folder, { recursive: true })
  const final = join(folder, `${entry.pid}.json`)
  const temp = `${final}.${process.pid}.tmp`
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, final)
}

/** The processes registered for `runToken`. */
export function registeredProcesses(runToken: string, opts: { dir?: string } = {}): RegisteredProcess[] {
  const folder = runFolder(opts.dir ?? registryDir(), runToken)
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return []
  }
  const entries: RegisteredProcess[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const value = JSON.parse(readFileSync(join(folder, name), 'utf8')) as RegisteredProcess
      if (Number.isInteger(value.pid) && typeof value.startTime === 'string') entries.push(value)
    } catch {
      // A torn or foreign file is not a registration.
    }
  }
  return entries
}

/** Linux: the start time in clock ticks since boot, field 22 of `/proc/<pid>/stat`. */
function linuxStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

/** Other OSes: `ps`'s full start time. */
function psStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/** The identity of a live process, or null when `pid` is not running. */
export function identityOf(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const startTime = process.platform === 'linux' ? linuxStartTime(pid) : psStartTime(pid)
  return startTime === null ? null : { pid, startTime }
}

/** True when `identity` is still the same running process (same pid and same start time). */
export function isSameProcessAlive(identity: ProcessIdentity): boolean {
  return identityOf(identity.pid)?.startTime === identity.startTime
}

/** True while a process group with id `pgid` has any member. */
function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Members observed while the original leader remains alive; never inferred from a bare PGID. */
function observedGroupMembers(entry: RegisteredProcess): ProcessIdentity[] {
  if (!isSameProcessAlive(entry)) return entry.members ?? []
  try {
    const rows = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const members = rows
      .trim()
      .split('\n')
      .flatMap((line) => {
        const [pid, group] = line.trim().split(/\s+/).map(Number)
        if (group !== entry.pid || pid === undefined || pid === entry.pid) return []
        const member = identityOf(pid)
        return member ? [member] : []
      })
    return isSameProcessAlive(entry) ? members : (entry.members ?? [])
  } catch {
    return entry.members ?? []
  }
}

/** A leaderless number is never ownership proof; at least one recorded member must still match. */
export function registeredProcessOwned(
  entry: RegisteredProcess,
  inspect = {
    identity: identityOf,
    groupExists,
    groupOf: (pid: number): number | null => {
      try {
        return (
          Number(
            execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore']
            }).trim()
          ) || null
        )
      } catch {
        return null
      }
    }
  }
): boolean {
  const now = inspect.identity(entry.pid)
  if (now !== null) return now.startTime === entry.startTime
  return (
    entry.processGroup === true &&
    (entry.members ?? []).some(
      (member) =>
        inspect.identity(member.pid)?.startTime === member.startTime && inspect.groupOf(member.pid) === entry.pid
    )
  )
}

function signal(entry: RegisteredProcess, sig: NodeJS.Signals): void {
  if (!registeredProcessOwned(entry)) return
  try {
    process.kill(entry.processGroup ? -entry.pid : entry.pid, sig)
  } catch {
    // Already gone.
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Stops every process registered for `runToken`: TERM, wait `graceMs`, then KILL. Removes the run's records. */
export async function stopRegistered(runToken: string, opts: StopOptions): Promise<StopReport> {
  const dir = opts.dir ?? registryDir()
  const entries = registeredProcesses(runToken, { dir })
  const identity = (entry: RegisteredProcess): ProcessIdentity => ({ pid: entry.pid, startTime: entry.startTime })
  const report: StopReport = { backend: 'registry', terminated: [], killed: [], alreadyGone: [] }
  const live: RegisteredProcess[] = []
  for (const entry of entries) {
    if (entry.processGroup && isSameProcessAlive(entry)) {
      entry.members = observedGroupMembers(entry)
      // Persist the independent identities before TERM can remove the leader.
      await registerProcess(entry, { dir })
    }
    if (registeredProcessOwned(entry)) {
      live.push(entry)
      continue
    }
    if (entry.processGroup && identityOf(entry.pid) === null && groupExists(entry.pid))
      throw new Error(
        `process registry: group ${entry.pid} has no verifiable recorded member; refusing to signal an unowned group`
      )
    report.alreadyGone.push(identity(entry))
  }
  for (const entry of live) signal(entry, 'SIGTERM')
  const deadline = Date.now() + Math.max(0, opts.graceMs)
  let remaining = live
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())))
    remaining = remaining.filter((entry) => registeredProcessOwned(entry))
  }
  for (const entry of live) if (!remaining.includes(entry)) report.terminated.push(identity(entry))
  for (const entry of remaining) {
    signal(entry, 'SIGKILL')
    report.killed.push(identity(entry))
  }
  // KILL cannot be ignored; wait briefly so a caller deleting the run's directories next never races the exit.
  const killDeadline = Date.now() + 2000
  while (remaining.length > 0 && Date.now() < killDeadline) {
    await sleep(20)
    remaining = remaining.filter((entry) => registeredProcessOwned(entry))
  }
  rmSync(runFolder(dir, runToken), { recursive: true, force: true })
  return report
}
