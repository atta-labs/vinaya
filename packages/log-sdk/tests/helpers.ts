import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { type ConnectOptions, connect } from '../src/index.js'

/** A directory with no settings files, so a test never reads the real repository's. */
export const NO_SETTINGS_ROOT = '/nonexistent-log-sdk-test-root'

const runtimeDirs: string[] = []
afterAll(() => {
  for (const dir of runtimeDirs) rmSync(dir, { recursive: true, force: true })
})

/** Each handle gets its own local copy, so no test finds another test's open run in it. */
export function harness(options: Partial<ConnectOptions> = {}) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'log-sdk-writer-'))
  runtimeDirs.push(runtimeDir)
  const spans = new InMemorySpanExporter()
  const logs = new InMemoryLogRecordExporter()
  const errors: unknown[] = []
  const handle = connect({
    runId: 'run-1',
    repository: 'acme/widgets',
    repoRoot: NO_SETTINGS_ROOT,
    runtimeDir,
    spanProcessors: [new SimpleSpanProcessor(spans)],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logs })],
    onError: (e) => errors.push(e),
    ...options
  })
  return { handle, spans, logs, errors }
}

export function spanNamed(spans: InMemorySpanExporter, name: string) {
  return spans.getFinishedSpans().filter((s) => s.name === name)
}
