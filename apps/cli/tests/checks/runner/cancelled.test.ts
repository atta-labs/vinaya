import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 * `log`) actually writing — redirecting `HOME` is what makes its output
 * readable without touching the real machine's `~/.vinaya`.
 */
describe('runChecks — SIGINT/SIGTERM records every in-flight check as cancelled', () => {
  it('an interrupted check gets one gate line with outcome cancelled, not silence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vinaya-gate-cancelled-'))
    const wrapper = Bun.spawn(['bun', RUN_AND_HANG], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, HOME: home, VINAYA_TASK: '905' }
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

    const outboxDir = join(home, '.vinaya', 'outbox')
    const repoDirs = readdirSync(outboxDir)
    expect(repoDirs.length).toBeGreaterThan(0)
    const path = join(outboxDir, repoDirs[0] as string, '905.ndjson')
    const lines = readFileSync(path, 'utf8')
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
})
