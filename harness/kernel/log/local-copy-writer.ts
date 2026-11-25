import { join } from 'node:path'
import {
  defaultRuntimeDir as sdkDefaultRuntimeDir,
  resolveSettings as sdkResolveSettings,
  sendLocalCopy
} from '@attalabs/vinaya-log-sdk'
import { isInsideRepo } from '../run-paths.js'

/** The longest a drain waits on sending the local copy, whatever the OpenTelemetry address does. */
export const LOCAL_COPY_SEND_BOUND_MS = 3_000
/** The least time between the starts of two sends from one process. */
export const LOCAL_COPY_SEND_INTERVAL_MS = 2_000

export type OtlpAddressDecision =
  | { kind: 'address'; url: string; headers?: Record<string, string> | undefined }
  | { kind: 'none'; reason: string }

/** Where a run's local copy is kept: the Log folder, and the repository the records are filed under. */
export type LocalCopyPlace = { folder: string; repository: string | undefined }

/** What decides the local copy's folder for a repository. */
export type LocalCopyFolderInputs = {
  home: string
  cwd: string
  /** The runtime directory the process was handed, when it was handed one. */
  handedRuntimeDir: string | undefined
  /** Whether the process is an unattended one, which reads no working-tree setting for the folder. */
  unattended: boolean
}

/**
 * The local copy sits where `vinaya log send` reads it: the SDK settings' `logs.folder`, else `<runtimeDir>/logs`,
 * never the destination's own folder, which holds today's per-Issue files. An unattended process reads no working
 * tree setting for it, and the runtime directory the process was handed wins, as for today's default folder.
 * `undefined` when recording is off.
 */
export function resolveLocalCopyFolder(
  inputs: LocalCopyFolderInputs,
  repository: string | undefined
): string | undefined {
  const vinayaHome = join(inputs.home, '.vinaya')
  if (inputs.handedRuntimeDir) return join(inputs.handedRuntimeDir, 'logs')
  if (inputs.unattended) return join(sdkDefaultRuntimeDir(repository, vinayaHome), 'logs')
  const resolved = sdkResolveSettings({
    repoRoot: inputs.cwd,
    ...(repository === undefined ? {} : { repository }),
    vinayaHome
  })
  if (!resolved.ok || resolved.settings.logs === false) return undefined
  const configured = (resolved.settings.logs || undefined)?.folder
  // A configured folder inside the working tree is never used; the runtime directory's is.
  return configured !== undefined && !isInsideRepo(configured, inputs.cwd)
    ? configured
    : join(resolved.settings.runtimeDir, 'logs')
}

export type LocalCopySenderDeps = {
  /** The text of a report; called at most once per sender. */
  warn: (message: string) => void
  /** Decides the OpenTelemetry address; asked at most once per sender. */
  address: () => Promise<OtlpAddressDecision> | OtlpAddressDecision
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined
  sendBoundMs?: number
  sendIntervalMs?: number
  now?: () => number
}

/** Sends of one folder never overlap within the process, whichever sender asks. */
const folderSends = new Map<string, Promise<unknown>>()

function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = folderSends.get(key) ?? Promise.resolve()
  const next = previous.then(work, work)
  const tracked = next.catch(() => undefined)
  folderSends.set(key, tracked)
  void tracked.then(() => {
    if (folderSends.get(key) === tracked) folderSends.delete(key)
  })
  return next
}

/**
 * Sends a local copy to the OpenTelemetry address the harness's address rule resolves (recording off, trust anchor,
 * CI credential): at most one send at a time, not more often than the interval, and a drain waits no longer than the
 * bound. It depends on nothing but the folder the records are in.
 */
export function createLocalCopySender(deps: LocalCopySenderDeps) {
  const bound = deps.sendBoundMs ?? LOCAL_COPY_SEND_BOUND_MS
  const interval = deps.sendIntervalMs ?? LOCAL_COPY_SEND_INTERVAL_MS
  const now = deps.now ?? Date.now
  let warned = false
  const warnOnce = (error: unknown): void => {
    if (warned) return
    warned = true
    try {
      deps.warn(
        `vinaya: the OpenTelemetry local copy failed — ${error instanceof Error ? error.message : String(error)}\n`
      )
    } catch {
      // A report that cannot be written is not a failure of the write it reports.
    }
  }

  let address: Promise<OtlpAddressDecision> | undefined
  const resolved = (): Promise<OtlpAddressDecision> => {
    address ??= Promise.resolve()
      .then(() => deps.address())
      .catch((error) => {
        warnOnce(error)
        return { kind: 'none', reason: 'the address could not be resolved' } as const
      })
    return address
  }

  let inFlight: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  let lastStart = Number.NEGATIVE_INFINITY
  let target: LocalCopyPlace | undefined

  async function sendOnce(deadline?: number): Promise<void> {
    const place = target
    if (place === undefined) return
    const decision = await resolved()
    if (decision.kind !== 'address') return
    const report = await serialized(`${place.folder}\0${place.repository ?? ''}`, () =>
      sendLocalCopy({
        folder: place.folder,
        ...(place.repository === undefined ? {} : { repository: place.repository }),
        url: decision.url,
        ...(decision.headers === undefined ? {} : { headers: decision.headers }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        ...(deadline === undefined ? {} : { deadline })
      })
    )
    // Records not delivered now are sent by a later send; only a failure to read or keep state is a defect.
    const broken = report.failures.find((failure) => failure.reason.includes('unavailable'))
    if (broken !== undefined) warnOnce(new Error(broken.reason))
  }

  function runSend(): void {
    timer = undefined
    dirty = false
    lastStart = now()
    inFlight = sendOnce()
      .catch(warnOnce)
      .finally(() => {
        inFlight = undefined
        if (dirty) requestSend()
      })
  }

  /** Asks for a send soon: at most one at a time, and not more often than the interval. */
  function requestSend(): void {
    if (inFlight !== undefined || timer !== undefined) {
      dirty = true
      return
    }
    timer = setTimeout(runSend, Math.max(0, lastStart + interval - now()))
    // A process with nothing else to do ends; its drain, or a later process, sends what is left.
    timer.unref?.()
  }

  return {
    /** Remembers where the copy is and asks for a send soon. */
    request(place: LocalCopyPlace): void {
      target = place
      requestSend()
    },
    /** Remembers where the copy is without asking for a send. */
    remember(place: LocalCopyPlace): void {
      target = place
    },
    /** Sends what is in the copy, waiting no longer than the bound. */
    async drain(): Promise<void> {
      if (target === undefined) return
      let expired: ReturnType<typeof setTimeout> | undefined
      const deadline = now() + bound
      try {
        await Promise.race([
          (async () => {
            if (timer !== undefined) {
              clearTimeout(timer)
              timer = undefined
            }
            await inFlight
            await sendOnce(deadline)
          })().catch(warnOnce),
          new Promise<void>((resolve) => {
            expired = setTimeout(resolve, bound)
          })
        ])
      } finally {
        clearTimeout(expired)
      }
    }
  }
}

export type LocalCopySender = ReturnType<typeof createLocalCopySender>
