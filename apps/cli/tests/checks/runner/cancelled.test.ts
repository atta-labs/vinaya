import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedConfigFixture } from '../../lib/process-fixture'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'checks')
const RUN_AND_HANG = join(FIXTURES, 'run-and-hang.ts')

/**
 * A check killed by SIGINT/SIGTERM never reaches one of
 * `runOne`'s own `return` statements, so it can only be recorded from the
 * signal handler itself (`installSignalForwarding`'s `forward`). Exercised
 * out-of-process, same as `runner.test.ts`'s own SIGINT-forwarding test —
 * sending SIGINT to the test runner itself would kill the whole suite. The
 * wrapper calls the REAL, un-injected `runChecks` (no `log` override), so
 * this is the real production singleton (`apps/cli/src/lib/log-sink.ts`'s
 * `log`) actually writing — `isolatedConfigFixture`'s `HOME` is what makes
 * its output readable without touching the real machine's `~/.vinaya`.
 *
 * That same fixture's working directory is what keeps the destination the
 * wrapper writes to knowable at all: the child resolves its configuration by
 * walking up from its own `cwd`, so run inside this repository it reads this
 * repository's `logs` setting, and the day that setting names a server this
 * file's reads find nothing on disk. The fixture's own directory holds an
 * empty `vinaya.config.json`, which is where that walk stops.
 *
 * `stripVinayaEnv`, which the fixture's env also carries, matters for a
 * third reason ([task-files-v1] 5): `log()`'s own default destination is
 * resolved through `runtimeDirForRepo`, which honours a leaked
 * `VINAYA_RUNTIME_DIR` from THIS test process's own environment ahead of
 * `$HOME` entirely — the exact cross-run collision Issue #660 closed for
 * every other real-process fixture. This file is still on
 * `process-fixture-coverage.test.ts`'s own grandfather list (it carries no
 * kill-budget evidence at its own spawn scope, a separate, later-task
 * concern), so this fixes only the leak, not full compliance.
 */
describe('runChecks — SIGINT/SIGTERM records every in-flight check as cancelled', () => {
  it('an interrupted check gets one gate line with outcome cancelled, not silence', async () => {
    const fixture = isolatedConfigFixture('vinaya-gate-cancelled-')
    const wrapper = Bun.spawn(['bun', RUN_AND_HANG], {
      cwd: fixture.cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...fixture.env, VINAYA_TASK: '905' }
    })

    // Give the wrapper time to start and spawn its own (detached) check
    // child before interrupting it — same delay `runner.test.ts` uses for
    // the identical wrapper.
    await new Promise((resolve) => setTimeout(resolve, 500))
    wrapper.kill('SIGINT')
    await wrapper.exited

    // Grace period for the fire-and-forget log write plus the SIGTERM/
    // SIGKILL escalation to finish.
    await new Promise((resolve) => setTimeout(resolve, 500))

    // The default `logs` destination is a folder under the fixture's own
    // `runtimeDir` — `<runtimeDir>/logs/<repo>/<task>.ndjson`. Both the
    // `runtimeDir` and the inner `logs/` folder are named by the same repo
    // segment, the one the fixture's own `AEG_REPO` declares.
    const lines = readFileSync(join(fixture.logsDir, '905.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const gateLines = lines.filter((l) => l.kind === 'gate')
    expect(gateLines).toHaveLength(1)
    expect(gateLines[0].check).toBe('hang')
    expect(gateLines[0].outcome).toBe('cancelled')
    expect(gateLines[0].reason).toBe('signal:SIGINT')
  }, 10_000)

  it('a second SIGINT before the kill-grace exit does not double-emit the cancelled observation', async () => {
    const fixture = isolatedConfigFixture('vinaya-gate-cancelled-double-')
    const wrapper = Bun.spawn(['bun', RUN_AND_HANG], {
      cwd: fixture.cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...fixture.env, VINAYA_TASK: '905' }
    })

    await new Promise((resolve) => setTimeout(resolve, 500))
    // Two signals within the KILL_GRACE_MS window before `process.exit` fires
    // — a double Ctrl+C, or a supervisor sending TERM then INT/KILL — must
    // still yield exactly one `cancelled` gate observation per check.
    wrapper.kill('SIGINT')
    wrapper.kill('SIGINT')
    await wrapper.exited

    await new Promise((resolve) => setTimeout(resolve, 500))

    // The default `logs` destination is a folder under the fixture's own
    // `runtimeDir` — `<runtimeDir>/logs/<repo>/<task>.ndjson`. Both the
    // `runtimeDir` and the inner `logs/` folder are named by the same repo
    // segment, the one the fixture's own `AEG_REPO` declares.
    const lines = readFileSync(join(fixture.logsDir, '905.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const gateLines = lines.filter((l) => l.kind === 'gate')
    expect(gateLines).toHaveLength(1)
    expect(gateLines[0].check).toBe('hang')
    expect(gateLines[0].outcome).toBe('cancelled')
  }, 10_000)
})
