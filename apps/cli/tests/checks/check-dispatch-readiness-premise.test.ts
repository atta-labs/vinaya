import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'

/**
 * Bin-level regression for the `PREMISE_FILE` wiring (task 10, #59). The
 * bin's forge-dependent path (a real task branch) needs a live `gh`/network
 * round-trip that isn't hermetic to spawn in CI — `reassertPremiseFile`'s own
 * unit tests (`premise-reassert-logic.test.ts`) cover the pass/fail/missing-
 * file/no-pins decision logic directly. What this file proves instead: on a
 * non-task branch (the existing, unchanged bypass — `main` matches no
 * `task/<tranche>/<n>` pattern), the check still exits `0` with no findings
 * whether or not `PREMISE_FILE` is set — i.e. this task's addition changes
 * nothing about the pre-existing "nothing to evaluate here" path, satisfying
 * the unset-env "byte-equivalent in shape to pre-change behavior" test-plan
 * item at the wiring level.
 */
const REPO_ROOT = join(import.meta.dir, '../../../..')
const BIN = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-dispatch-readiness.ts')

async function run(env: Record<string, string>): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(['bun', BIN], {
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
    stdout: 'ignore',
    stderr: 'pipe'
  })
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stderr }
}

describe('check-dispatch-readiness: PREMISE_FILE on a non-task branch (bypass unaffected)', () => {
  it('PREMISE_FILE unset: exits 0 with no findings (pre-existing bypass, unchanged)', async () => {
    const result = await run({ BRANCH: 'main' })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.trim()).toBe('')
  })

  it('PREMISE_FILE set to a nonexistent path: bypass still fires first — exits 0, no premise error raised', async () => {
    const result = await run({ BRANCH: 'main', PREMISE_FILE: '/tmp/does-not-exist-premise-file.md' })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.trim()).toBe('')
  })
})
