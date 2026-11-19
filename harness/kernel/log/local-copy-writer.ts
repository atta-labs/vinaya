import { randomUUID } from 'node:crypto'
import { createLiveEarlierConverter as createConverter } from '../../../packages/log-sdk/src/contract/convert-live.js'
import { mapEarlierEvent } from '../../../packages/log-sdk/src/contract/convert-map.js'
import { createConvertedCopy } from '../../../packages/log-sdk/src/local-copy/converted-copy.js'
import { sendLocalCopy } from '../../../packages/log-sdk/src/sender/send.js'
import type { LogEvent } from './schema.js'

/** The longest the sink's drain waits on sending the local copy, whatever the OpenTelemetry address does. */
export const LOCAL_COPY_SEND_BOUND_MS = 3_000
/** The least time between the starts of two sends from one process. */
export const LOCAL_COPY_SEND_INTERVAL_MS = 2_000

export type OtlpAddressDecision =
  | { kind: 'address'; url: string; headers?: Record<string, string> | undefined }
  | { kind: 'none'; reason: string }

export type LocalCopyWriterDeps = {
  /** The text of a report; called at most once per process. */
  warn: (message: string) => void
  /** The home directory redaction rewrites to `~`. */
  home: () => string
  /** Decides the OpenTelemetry address; asked at most once per process. */
  address: () => Promise<OtlpAddressDecision> | OtlpAddressDecision
  fetch?: ((url: string, init: RequestInit) => Promise<Response>) | undefined
  sendBoundMs?: number
  sendIntervalMs?: number
  now?: () => number
}

type RunCopy = {
  converter: ReturnType<typeof createConverter>
  copy: ReturnType<typeof createConvertedCopy>
}

type Pending = { event: LogEvent; folder: string }

let lastTarget: { folder: string; repository: string | undefined } | undefined

/** Where this process's local copy is, as the last event any sink recorded put it; `undefined` before any. */
export function localCopyTarget(): { folder: string; repository: string | undefined } | undefined {
  return lastTarget
}

/** The sink's second write: converts each recorded event and keeps this process's own files of the run's local copy. */
export function createLocalCopyWriter(deps: LocalCopyWriterDeps) {
  const writerId = randomUUID()
  const bound = deps.sendBoundMs ?? LOCAL_COPY_SEND_BOUND_MS
  const interval = deps.sendIntervalMs ?? LOCAL_COPY_SEND_INTERVAL_MS
  const now = deps.now ?? Date.now
  const runs = new Map<string, RunCopy>()
  const queue: Pending[] = []
  let warned = false
  let scheduled: ReturnType<typeof setImmediate> | undefined

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

  function write({ event, folder }: Pending): void {
    const runId = event.meta.run_id
    const key = `${folder}\0${runId}`
    let run = runs.get(key)
    if (run === undefined) {
      run = {
        converter: createConverter(runId, [], deps.home()),
        copy: createConvertedCopy({
          runId,
          writerId,
          repository: event.meta.repo ?? undefined,
          folder
        })
      }
      runs.set(key, run)
    }
    // An end may follow a start another process wrote, at any time after this process first saw the run.
    const ends = event.kind === 'dispatch' || event.kind === 'role_attempt' || mapEarlierEvent(event).mode === 'end'
    if (ends) run.converter.learn(run.copy.openStarts())
    run.copy.append(run.converter.convert(event))
  }

  /** Writes everything queued, in the order it was queued; synchronous. */
  function flush(): void {
    if (scheduled !== undefined) {
      clearImmediate(scheduled)
      scheduled = undefined
    }
    while (queue.length > 0) {
      const next = queue.shift() as Pending
      try {
        write(next)
      } catch (error) {
        warnOnce(error)
      }
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
  let target: { folder: string; repository: string | undefined } | undefined

  async function sendOnce(deadline?: number): Promise<void> {
    if (target === undefined) return
    const decision = await resolved()
    if (decision.kind !== 'address') return
    const report = await sendLocalCopy({
      folder: target.folder,
      ...(target.repository === undefined ? {} : { repository: target.repository }),
      url: decision.url,
      ...(decision.headers === undefined ? {} : { headers: decision.headers }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deadline === undefined ? {} : { deadline })
    })
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

  function schedule(): void {
    if (scheduled !== undefined) return
    scheduled = setImmediate(() => {
      scheduled = undefined
      flush()
    })
    scheduled.unref?.()
  }

  function remember(event: LogEvent, folder: string): void {
    target = { folder, repository: event.meta.repo ?? undefined }
    lastTarget = target
  }

  return {
    writerId,
    /** Queues one recorded event for the local copy, written off the caller's write; call order is kept. */
    record(event: LogEvent, folder: string): void {
      remember(event, folder)
      queue.push({ event, folder })
      schedule()
      requestSend()
    },
    /** Writes one recorded event, and every one queued before it, before returning. */
    recordSync(event: LogEvent, folder: string): void {
      remember(event, folder)
      queue.push({ event, folder })
      flush()
    },
    flush,
    /** Everything queued is in the local copy; then the local copy is sent for at most the bound. */
    async drain(): Promise<void> {
      flush()
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

export type LocalCopyWriter = ReturnType<typeof createLocalCopyWriter>
