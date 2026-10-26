// Owner: agent D (containment of interrupted test runs, the registry backend).
// Shared interface only: types and stubs, no behaviour yet. The test-temp sweep calls `stopRegistered` to end a
// run's surviving processes before it deletes that run's directories.
//
// A process is known by its pid plus its start time, so a reused pid is never mistaken for the original. A child
// registers before it does any work and the supervisor acknowledges it; stopping sends TERM, waits, then KILL.
// Limit: a subprocess that never registers (an adopter's own uninstrumented tool) is not contained by this backend.

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
}

export interface StopOptions {
  /** How long to wait after TERM before sending KILL. */
  graceMs: number
}

/** What stopping a run's processes did. */
export interface StopReport {
  backend: ContainmentBackend
  terminated: ProcessIdentity[]
  killed: ProcessIdentity[]
  /** Processes that were already gone, or whose pid now belongs to a different start time. */
  alreadyGone: ProcessIdentity[]
}

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`)
}

/** The backend this host will use for a run. */
export function selectContainmentBackend(): ContainmentBackend {
  return notImplemented('selectContainmentBackend')
}

/** Records `process` for `runToken` and returns once the registration is durable (the acknowledgement). */
export function registerProcess(_process: RegisteredProcess): Promise<void> {
  return notImplemented('registerProcess')
}

/** The identity of a live process, or null when `pid` is not running. */
export function identityOf(_pid: number): ProcessIdentity | null {
  return notImplemented('identityOf')
}

/** True when `identity` is still the same running process (same pid and same start time). */
export function isSameProcessAlive(_identity: ProcessIdentity): boolean {
  return notImplemented('isSameProcessAlive')
}

/** Stops every process registered for `runToken`: TERM, wait `graceMs`, then KILL. */
export function stopRegistered(_runToken: string, _opts: StopOptions): Promise<StopReport> {
  return notImplemented('stopRegistered')
}
