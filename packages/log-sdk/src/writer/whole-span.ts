import type { TimeInput } from '@opentelemetry/api'
import type { SpanParent } from '../contract/ids.js'
import { type Attrs, endSpan, startSpan, type WriterCore } from './attributes.js'

/**
 * Writes one span whole — its start and end may have fallen in different
 * processes. The span starts through the tracer at `startTime` under `parent`
 * with the id generator set to `own.spanId`, and ends at `endTime`, so it is
 * stamped, processed and exported like every other span.
 */
export function writeWholeSpan(
  handle: WriterCore,
  name: string,
  own: SpanParent,
  parent: SpanParent | undefined,
  startTime: TimeInput,
  endTime: TimeInput,
  attributes: Attrs = {}
): void {
  if (!handle.enabled) return
  if (own.traceId !== handle.traceId) {
    throw new Error(`span ${own.spanId} belongs to trace ${own.traceId}, not this run's ${handle.traceId}`)
  }
  const ref = startSpan(handle, {
    name,
    startedEvent: '',
    attrs: attributes,
    parent,
    spanId: own.spanId,
    startTime,
    emitStarted: false
  })
  endSpan(handle, ref, {}, endTime)
}
