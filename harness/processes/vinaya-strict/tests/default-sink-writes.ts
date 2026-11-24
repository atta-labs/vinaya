/**
 * Test support: writes an earlier-format event through the process's default sink, for tests that prove the sink's own
 * behaviour (its destination, its queue, its exit). No source of the harness imports this file.
 */
import { defaultLogSink, drainLogSink, type LogEventInput, type LogSyncOptions } from '../../../kernel/log/log-sink'

export { drainLogSink }

export function log(e: LogEventInput): void {
  defaultLogSink().log(e)
}

export function logSync(e: LogEventInput, opts?: LogSyncOptions): void {
  defaultLogSink().logSync(e, opts)
}
