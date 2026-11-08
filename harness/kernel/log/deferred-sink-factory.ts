import type { LogSinkFactory } from './log-sink.js'

/**
 * The default Log sink's factory, registered by an entry point that must not load the sink itself at startup. The
 * sink module builds its default sink from this when no factory was installed directly, so a process that never
 * logs never loads the sink, its schema or its writers.
 */
let deferred: (() => LogSinkFactory) | undefined

export function registerDeferredLogSinkFactory(load: () => LogSinkFactory): void {
  deferred = load
}

/** The registered factory, loaded on this first call, or `undefined` when none was registered. */
export function loadDeferredLogSinkFactory(): LogSinkFactory | undefined {
  return deferred?.()
}
