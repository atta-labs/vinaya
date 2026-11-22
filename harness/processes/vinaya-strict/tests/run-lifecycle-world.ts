import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '../../../../packages/log-sdk/src/index.js'
import { createRunRecorder, type RunRecorder } from '../../../kernel/log/run-recorder.js'

/** A run's local copy as the tests read it: the spans and events the Log handle wrote, and a clock they move by hand. */
export type RunLifecycleWorld = {
  folder: string
  runtimeDir: string
  /** A process's recorder over the one local copy; each call is one more process working on the same run. */
  process: () => RunRecorder
  /** Moves the fake clock forward, running every timer that comes due. */
  advance: (ms: number) => void
  spans: () => any[]
  events: () => any[]
  errors: unknown[]
}

const REPOSITORY = 'atta-labs/vinaya'

export function createRunLifecycleWorld(): RunLifecycleWorld {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-run-lifecycle-'))
  const folder = join(dir, 'logs')
  const root = mkdtempSync(join(tmpdir(), 'vinaya-run-lifecycle-root-'))
  const errors: unknown[] = []
  let now = Date.parse('2026-11-22T00:00:00Z')
  const timers: { id: number; at: number; fn: () => void }[] = []
  let nextTimer = 1
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimer++
      timers.push({ id, at: now + ms, fn })
      return { id, unref: () => {} }
    },
    clearTimeout: (timer: unknown) => {
      const id = (timer as { id?: number } | undefined)?.id
      const at = timers.findIndex((t) => t.id === id)
      if (at >= 0) timers.splice(at, 1)
    }
  }
  const advance = (ms: number): void => {
    const target = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]
      if (due === undefined || due.at > target) break
      timers.shift()
      now = Math.max(now, due.at)
      due.fn()
    }
    now = target
  }
  const records = (signal: 'traces' | 'logs'): any[] => {
    let names: string[] = []
    try {
      names = readdirSync(join(folder, 'atta-labs-vinaya')).filter((n) => n.endsWith(`.${signal}.jsonl`))
    } catch {}
    return names.flatMap((name) =>
      readFileSync(join(folder, 'atta-labs-vinaya', name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    )
  }
  return {
    folder,
    runtimeDir: dir,
    errors,
    advance,
    process: () =>
      createRunRecorder({
        runId: () => 'run-1',
        workRef: () => '2208',
        repository: () => REPOSITORY,
        place: (repository) => ({ folder, repository }),
        processIdentity: () => ({ name: 'vinaya-strict', version: '0.5.8' }),
        sender: () => ({ request: () => {}, remember: () => {}, drain: async () => {} }),
        home: () => dir,
        cwd: () => root,
        onError: (error) => errors.push(error),
        connect: (options) => connect({ ...options, timers: clock })
      }),
    spans: () =>
      records('traces').flatMap((r) => r.resourceSpans.flatMap((g: any) => g.scopeSpans.flatMap((s: any) => s.spans))),
    events: () =>
      records('logs').flatMap((r) => r.resourceLogs.flatMap((g: any) => g.scopeLogs.flatMap((s: any) => s.logRecords)))
  }
}

/** One attribute of a stored span or event, as the plain value. */
export function attributeOf(record: any, key: string): unknown {
  const value = record.attributes?.find((a: any) => a.key === key)?.value
  if (value === undefined) return undefined
  if (value.intValue !== undefined) return Number(value.intValue)
  return value.stringValue ?? value.boolValue ?? value.doubleValue
}

/** The name a stored event carries. */
export const eventNameOf = (event: any): string =>
  event.eventName ?? (event.attributes?.find((a: any) => a.key === 'event.name')?.value?.stringValue as string)
