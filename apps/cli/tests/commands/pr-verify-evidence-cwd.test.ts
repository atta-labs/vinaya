import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * The cwd guard, which closes the third false-MATCH path found in this command.
 *
 * `buildReport()` spawns the gate suite with `cwd: process.cwd()`, and several
 * gates resolve their scan root from it. From a subdirectory there is no
 * `aeg-root/` above them, so a whole class of findings silently vanishes from
 * the regenerated Group B — and a published block with exactly those findings
 * deleted compares MATCH. Two reviewers demonstrated it independently.
 *
 * Driving the real binary rather than a unit, because the defect is entirely in
 * what the spawned suite inherits; no pure function can observe it.
 */
describe('pr verify-evidence — refuses outside the repository root', () => {
  const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const ENTRY = join(REPO_ROOT, 'apps/cli/src/index.ts')

  /**
   * Runs the command from `cwd` and returns its exit code and stderr.
   *
   * `BASE_SHA` is set on purpose. It trips `assertNoBaseOverride`, which runs
   * immediately AFTER the cwd guard and before anything reaches the network —
   * so every case here terminates on a local guard and the suite never depends
   * on `gh`, a live pull request, or a working connection. Without it the
   * root-cwd case fell through to a real forge call and flaked.
   */
  function run(cwd: string): { code: number; stderr: string } {
    try {
      execFileSync('bun', [ENTRY, 'pr', 'verify-evidence', '310'], {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, GITHUB_REPOSITORY: 'atta-labs/vinaya', BASE_SHA: 'deadbeef' }
      })
      return { code: 0, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      return { code: e.status ?? -1, stderr: e.stderr ?? '' }
    }
  }

  it('refuses from a subdirectory, before doing any work', () => {
    const { code, stderr } = run(join(REPO_ROOT, 'apps/cli'))
    expect(code).toBe(2)
    expect(stderr).toContain('run this from the repository root')
    // The refusal must precede the regeneration. If it did not, the command
    // would have spawned the narrowed gate suite before noticing — which is
    // the whole defect, only slower.
    expect(stderr).not.toContain('comparing #310')
  })

  it('refuses from a deeper subdirectory too', () => {
    const { code, stderr } = run(join(REPO_ROOT, 'apps/cli/src/commands'))
    expect(code).toBe(2)
    // Assert the MESSAGE, not just the code. Every guard in this module exits
    // 2, so a bare `toBe(2)` passes whenever any of them fires — including
    // with this guard deleted. Under mutation that test was green and proved
    // nothing, which is the non-discriminating shape a reviewer caught in the
    // sibling pull request's hardening suite.
    expect(stderr).toContain('run this from the repository root')
  })

  it('does NOT refuse on cwd grounds at the repository root', () => {
    // Reaches a LATER guard, which is the point: the cwd guard let it through.
    // Asserting the absence of the cwd message alone would pass even if the
    // command died earlier for some unrelated reason, so this also pins which
    // guard it did reach.
    const { code, stderr } = run(REPO_ROOT)
    expect(stderr).not.toContain('run this from the repository root')
    expect(code).toBe(2)
    // It must reach a LATER guard — which one depends on whether this working
    // tree happens to be clean, so pinning a single message would flake. What
    // is deterministic is that execution got PAST the cwd guard.
    expect(stderr).toMatch(/BASE_SHA is set|uncommitted or untracked changes/)
  })
})
