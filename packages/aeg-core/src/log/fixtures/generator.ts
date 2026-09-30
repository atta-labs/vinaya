/**
 * The seeded recorder the fixture executions are built with. Every time, event
 * id, run id and commit below is drawn from a stream keyed by the seed and the
 * execution's name — never from the clock, a random source, or a counter that
 * outlives one call — so building the same execution twice yields the same
 * bytes. Every valid line goes through the real `buildHeader`, so a header
 * change reaches the fixtures and fails their test rather than drifting.
 */

import { createHash } from 'node:crypto'
import { buildHeader } from '../envelope'
import type { Host, Provenance, Role } from '../schema'

export const FIXTURE_SEED = 'vinaya-fixture-seed-1'
export const FIXTURE_REPO = 'example/fixture'
export const FIXTURE_EPOCH = '2026-09-01T00:00:00.000Z'
export const FIXTURE_VINAYA_VERSION = '0.35.0'
/** The CLI version of the low-trust line: older than the release that began attributing every line. */
export const LOW_TRUST_VINAYA_VERSION = '0.30.1'

const FIXTURE_DOCTRINE = 'fixture-doctrine'
const FIXTURE_HOSTNAME = 'fixture-host'
const ONE_DAY_MS = 86_400_000

/** How a reader is expected to classify a line: fully valid, a schema version no build knows, or a known version that fails validation. */
export type FixtureValidity = 'valid' | 'unknown_version' | 'invalid'

export type FixtureLine = { raw: string; validity: FixtureValidity }

/** The body of one event: its family and event name plus that family's own fields. `meta`, `subject` and `payload` come from the recorder. */
export type EventBody = { kind: string; event: string } & Record<string, unknown>

export type EmitOptions = {
  role?: Role
  round?: number
  /** A commit: recorded on `subject.sha` and `meta.work.revision` together. Absent, the line records no commit at all. */
  sha?: string
  host?: Host
  provenance?: Provenance
}

/** mulberry32 — a tiny seeded generator; quality is irrelevant here, determinism is the point. */
function stream(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Recorder = {
  /** The Issue number every line of this execution belongs to. */
  issue: number
  /** The pull request number of this execution's task. */
  pr: number
  lines: FixtureLine[]
  /** Hex digits drawn from the seeded stream. */
  hex(length: number): string
  /** An integer in `[min, max]` drawn from the seeded stream. */
  int(min: number, max: number): number
  /** A commit identifier drawn from the seeded stream. */
  sha(): string
  /** The next review comment id for this execution. */
  commentId(): number
  /** Milliseconds elapsed since the execution's first line. */
  elapsedMs(): number
  /** The current clock, as an ISO time, after advancing by a seeded step. */
  tick(): Date
  /** Builds the next valid line's object (advancing the clock and sequence) without storing it. */
  build(body: EventBody, options?: EmitOptions): Record<string, unknown>
  /** Stores an already-built object as a line. */
  push(object: Record<string, unknown>, validity?: FixtureValidity): Record<string, unknown>
  /** Stores raw text as it is. */
  pushRaw(raw: string, validity: FixtureValidity): void
  /** Builds and stores one valid line. */
  emit(body: EventBody, options?: EmitOptions): Record<string, unknown>
}

/**
 * One recorder per execution. `index` places the execution on the calendar —
 * each starts a day after the one before — and `name` keys its stream, so two
 * executions never share ids. Nothing here survives the call that made it.
 */
export function createRecorder(seed: string, name: string, index: number, issue: number): Recorder {
  const draw = stream(`${seed}:${name}`)
  const startMs = Date.parse(FIXTURE_EPOCH) + index * ONE_DAY_MS
  let clockMs = startMs
  let seq = 0
  let comment = 1000 + Math.floor(draw() * 1000)
  const lines: FixtureLine[] = []
  const hex = (length: number): string => {
    let out = ''
    while (out.length < length)
      out += Math.floor(draw() * 0x10000)
        .toString(16)
        .padStart(4, '0')
    return out.slice(0, length)
  }
  const int = (min: number, max: number): number => min + Math.floor(draw() * (max - min + 1))
  const runId = `run-${name}-${hex(8)}`
  const processId = `proc-${hex(8)}`
  const tick = (): Date => {
    clockMs += int(1000, 60_000)
    return new Date(clockMs)
  }

  const recorder: Recorder = {
    issue,
    pr: issue + 100,
    lines,
    hex,
    int,
    sha: () => hex(12),
    commentId: () => ++comment,
    elapsedMs: () => clockMs - startMs,
    tick,
    build(body, options = {}) {
      const header = buildHeader({
        now: tick(),
        runId,
        seq: seq++,
        repo: FIXTURE_REPO,
        vinaya: FIXTURE_VINAYA_VERSION,
        doctrine: FIXTURE_DOCTRINE,
        host: options.host ?? 'loop',
        hostname: FIXTURE_HOSTNAME,
        env: {
          ...(options.role ? { role: options.role } : {}),
          task: String(issue),
          ...(options.round !== undefined ? { round: String(options.round) } : {})
        },
        eventId: `evt-${hex(12)}`,
        processId,
        ...(options.provenance ? { provenance: options.provenance } : {}),
        ...(options.sha ? { subject: { sha: options.sha } } : {})
      })
      if (options.sha && header.meta.schema === 3) header.meta.work.revision = options.sha
      const { kind, event, ...fields } = body
      return { ...header, kind, event, payload: {}, ...fields }
    },
    push(object, validity = 'valid') {
      lines.push({ raw: JSON.stringify(object), validity })
      return object
    },
    pushRaw(raw, validity) {
      lines.push({ raw, validity })
    },
    emit(body, options) {
      return recorder.push(recorder.build(body, options))
    }
  }
  return recorder
}
