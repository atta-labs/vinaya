import { createHash, randomBytes } from 'node:crypto'

/** A span's identity inside one trace: the trace and the span, as lowercase hex. */
export type SpanParent = { traceId: string; spanId: string }

/** The run's trace id: the first sixteen bytes of the SHA-256 of the run id, as 32 lowercase hex characters. */
export function traceIdFor(runId: string): string {
  return createHash('sha256').update(runId).digest().subarray(0, 16).toString('hex')
}

/** A span id both processes derive alike: the first eight bytes of the SHA-256 of the run id, a NUL byte and the key. */
export function spanIdFor(runId: string, key: string): string {
  return createHash('sha256')
    .update(runId)
    .update(Buffer.from([0]))
    .update(key)
    .digest()
    .subarray(0, 8)
    .toString('hex')
}

function randomSpanId(): string {
  for (;;) {
    const id = randomBytes(8).toString('hex')
    if (id !== '0000000000000000') return id
  }
}

/**
 * An id generator of OpenTelemetry's shape (`generateTraceId`, `generateSpanId`)
 * without importing it. Its trace id is always the run's; its next span id is
 * the one set by `useNextSpanId` just before a span starts, else a random one.
 */
export function createRunIdGenerator(runId: string) {
  const traceId = traceIdFor(runId)
  let next: string | undefined
  return {
    generateTraceId(): string {
      return traceId
    },
    generateSpanId(): string {
      if (next !== undefined) {
        const id = next
        next = undefined
        return id
      }
      return randomSpanId()
    },
    useNextSpanId(id: string | undefined): void {
      next = id
    }
  }
}

export type RunIdGenerator = ReturnType<typeof createRunIdGenerator>
