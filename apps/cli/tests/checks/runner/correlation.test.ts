import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogSink, type LogSinkDeps } from '../../../src/lib/log-sink'
import type { CheckSpec } from '../../../src/checks/contract'
import { runChecks } from '../../../src/checks/runner'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'checks')
const PASSING = join(FIXTURES, 'passing-check.ts')

function fullScope(overrides: Partial<CheckSpec> & Pick<CheckSpec, 'name' | 'run'>): CheckSpec {
  return { scope: 'full', ...overrides }
}

const BASE_OPTS = { parallel: 1, diffOnly: false, changedFiles: null, defaultTimeoutMs: 5000 }

// Same delay `log-sink.test.ts` uses — the sink's own write is a fire-and-
// forget `.then()` chain (a `resolveRepo()` read races the JSON write).
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150))

function sinkFor(dir: string, env: NodeJS.ProcessEnv): ReturnType<typeof createLogSink> {
  const deps: Partial<LogSinkDeps> = {
    outboxRoot: () => join(dir, 'outbox'),
    // [task-files-v1] 5: `log()` now resolves its destination through
    // `resolveLogDestination` rather than always writing under
    // `outboxRoot()` — pinned to a folder matching `readGateLines`'s own
    // expected layout below.
    resolveLogDestination: () => ({ kind: 'folder', folder: join(dir, 'outbox') }),
    home: () => dir,
    hostname: () => 'test-host',
    cwd: () => dir,
    now: () => new Date('2026-09-15T00:00:00.000Z'),
    env: () => env,
    resolveRepo: () => Promise.resolve({ owner: 'atta-labs', repo: 'vinaya' }),
    vinayaVersion: () => '0.0.0-test',
    stderr: () => {}
  }
  return createLogSink(deps)
}

function readGateLines(dir: string, issue: string): Array<Record<string, unknown>> {
  const path = join(dir, 'outbox', 'atta-labs-vinaya', `${issue}.ndjson`)
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'gate')
}

/**
 * Hook, CLI and CI are distinguished ONLY by
 * `meta.host` (derived from the real environment `hostFromEnv` reads,
 * `apps/cli/src/lib/log-sink.ts`), never by anything `runner.ts` invents
 * itself. Each caller here is its own `createLogSink` instance — the same
 * shape a real hook process, a real interactive CLI process and a real CI
 * process each are (three separate `vinaya` invocations, never one process
 * wearing three hats) — writing into the SAME outbox file, the way three
 * real separate check-runner invocations against the same task actually do.
 */
describe('runChecks — gate correlation across hook/CLI/CI callers', () => {
  it('one gate line per spec, per call — never more, never fewer, for a single invocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-gate-correlation-'))
    const sink = sinkFor(dir, { VINAYA_TASK: '900' })
    const specs = [fullScope({ name: 'a', run: PASSING }), fullScope({ name: 'b', run: PASSING })]
    await runChecks(specs, { ...BASE_OPTS, log: sink.log })
    await flush()
    const lines = readGateLines(dir, '900')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.check).sort()).toEqual(['a', 'b'])
  })

  it('a hook-invoked run reads meta.host: "hook" — never collapsed into plain "cli"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-gate-correlation-'))
    const sink = sinkFor(dir, { VINAYA_TASK: '901', VINAYA_HOST: 'hook' })
    await runChecks([fullScope({ name: 'a', run: PASSING })], { ...BASE_OPTS, log: sink.log })
    await flush()
    const [line] = readGateLines(dir, '901')
    expect((line?.meta as Record<string, unknown>)?.host).toBe('hook')
  })

  it('a CI-invoked run (GITHUB_ACTIONS set) reads meta.host: "ci"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-gate-correlation-'))
    const sink = sinkFor(dir, { VINAYA_TASK: '902', GITHUB_ACTIONS: 'true' })
    await runChecks([fullScope({ name: 'a', run: PASSING })], { ...BASE_OPTS, log: sink.log })
    await flush()
    const [line] = readGateLines(dir, '902')
    expect((line?.meta as Record<string, unknown>)?.host).toBe('ci')
  })

  it('a plain interactive run reads meta.host: "cli"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-gate-correlation-'))
    const sink = sinkFor(dir, { VINAYA_TASK: '903' })
    await runChecks([fullScope({ name: 'a', run: PASSING })], { ...BASE_OPTS, log: sink.log })
    await flush()
    const [line] = readGateLines(dir, '903')
    expect((line?.meta as Record<string, unknown>)?.host).toBe('cli')
  })

  it('hook then CI on the SAME check name produce two independently-attributed lines, never one merged/deduped line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-gate-correlation-'))
    const hookSink = sinkFor(dir, { VINAYA_TASK: '904', VINAYA_HOST: 'hook' })
    const ciSink = sinkFor(dir, { VINAYA_TASK: '904', GITHUB_ACTIONS: 'true' })
    const spec = fullScope({ name: 'shared-check', run: PASSING })
    await runChecks([spec], { ...BASE_OPTS, log: hookSink.log })
    await runChecks([spec], { ...BASE_OPTS, log: ciSink.log })
    await flush()
    const lines = readGateLines(dir, '904')
    expect(lines).toHaveLength(2)
    const hosts = lines.map((l) => (l.meta as Record<string, unknown>).host).sort()
    expect(hosts).toEqual(['ci', 'hook'])
    // Each caller's own run_id stays its own — never coalesced into one.
    const runIds = new Set(lines.map((l) => (l.meta as Record<string, unknown>).run_id))
    expect(runIds.size).toBe(2)
  })
})
