import { describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Core parity: each core check's verdict agrees with its `bin/*` equivalent
 * on the same input. Covers brief-shape vs `bin/verify-brief.ts` — the case
 * §3/§9 name explicitly. Compares exit-code verdicts (pass/fail), not exact
 * message text — the two intentionally emit different shapes (JSON check
 * contract vs human text), by design (§2: "the existing bins do not honor
 * the error contract").
 */

// tests/checks -> tests -> cli -> apps -> repo root. This was `../../../../..`
// and pointed at `apps/vinaya/cli/...`: both correct in attalabs, where this
// file sat one directory deeper, and both stale after the extraction. A wrong
// path makes `bun <missing-file>` exit 1, which is why the bad-body case above
// kept passing — on a missing file rather than on the check's verdict.
const REPO_ROOT = join(import.meta.dir, '../../../..')
const CHECK_BIN = join(REPO_ROOT, 'apps/cli/src/checks/bin/check-brief-shape.ts')
const VERIFY_BRIEF = join(REPO_ROOT, 'packages/aeg-core/bin/verify-brief.ts')

// A stale path is invisible to an exit-code comparison, so assert the targets
// exist before comparing verdicts.
for (const target of [CHECK_BIN, VERIFY_BRIEF]) {
  if (!existsSync(target)) throw new Error(`core-parity: target does not exist: ${target}`)
}

/** A fake `gh` on PATH whose `issue view` subcommand exits 1 printing `stderrText` — for exercising the fetch-failure branch of the Objectives comparison without a real network call. */
function fakeGhPath(stderrText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'core-parity-fake-gh-'))
  const gh = join(dir, 'gh')
  writeFileSync(gh, `#!/bin/sh\necho '${stderrText}' 1>&2\nexit 1\n`)
  chmodSync(gh, 0o755)
  return `${dir}:${process.env.PATH}`
}

const TASK_BRIEF_CLOSING_500 = [
  'Closes #500',
  '',
  '**For:** Sonnet (test)',
  '**Project:** aeg-core',
  '',
  '## Summary',
  '',
  'x',
  '',
  '## Pre-flight',
  '',
  'git worktree add .worktrees/task/iter/3 -b task/iter/3 origin/main',
  '',
  '## Technical surface map',
  '',
  '- `packages/aeg-core/src/foo.ts`',
  '',
  '## Test plan',
  '',
  'Test Plan: unit-tests-only',
  '',
  '## Documentation-update list',
  '',
  '- none',
  '',
  '## Stop conditions',
  '',
  '- Pre-flight failure.',
  '',
  '## Constraints',
  '',
  '**Autonomy:** Do not stop to ask clarifying questions.',
  '',
  '## Scope',
  '',
  'x',
  '',
  '**Tier:** 0'
].join('\n')

async function runExit(cmd: string[], env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
    cwd: REPO_ROOT
  })
  return await proc.exited
}

describe('core-parity: brief-shape vs bin/verify-brief.ts', () => {
  it('agree (both fail) on a known-bad PR_BODY missing every required section', async () => {
    const badBody = 'Just a one-line PR body with no required sections.'
    const env = { PR_BODY: badBody, BRANCH: 'task/vinaya-cli-v1/3' }
    const [checkExit, binExit] = await Promise.all([
      runExit(['bun', CHECK_BIN], env),
      runExit(['bun', VERIFY_BRIEF], env)
    ])
    expect(checkExit).toBe(1)
    expect(binExit).toBe(1)
  })

  it('agree (both pass) when PR_BODY is empty — nothing to check', async () => {
    const env = { PR_BODY: '', BRANCH: 'task/vinaya-cli-v1/3' }
    const [checkExit, binExit] = await Promise.all([
      runExit(['bun', CHECK_BIN], env),
      runExit(['bun', VERIFY_BRIEF], env)
    ])
    expect(checkExit).toBe(0)
    expect(binExit).toBe(0)
  })

  // dev-review-loop-v1 task 1: on a non-task branch, the objectives checks
  // are the quick-lane rule — applying only when the body opts in with its
  // own `## Objectives` section. Neither entry point calls `gh` for this
  // case (no Issue to fetch), so this stays a pure, network-free agreement.
  it('agree (both fail) on a non-task branch whose opted-in `## Objectives` section is malformed', async () => {
    // Brief-shaped (>= 2 of the four markers `isBriefShaped` requires) so
    // neither entry point takes the non-brief bypass before reaching the
    // objectives quick lane.
    const badObjectivesBody = [
      '## Objectives',
      '',
      '1. wrong grammar — missing the `O` prefix.',
      '',
      '## Technical surface map',
      '',
      '- `packages/aeg-core/src/brief-validation.ts`',
      '',
      '## Stop conditions',
      '',
      '- Pre-flight failure.'
    ].join('\n')
    const env = { PR_BODY: badObjectivesBody, BRANCH: 'fix/x' }
    const [checkExit, binExit] = await Promise.all([
      runExit(['bun', CHECK_BIN], env),
      runExit(['bun', VERIFY_BRIEF], env)
    ])
    expect(checkExit).toBe(1)
    expect(binExit).toBe(1)
  })

  // review round 1, finding 4: a failed `gh issue view` must not be treated
  // uniformly — an Issue that genuinely doesn't resolve skips the comparison,
  // but any OTHER failure (network, auth, rate-limit) must hard-fail rather
  // than silently pass. Both entry points agree on both.
  it('agree (both pass) when the linked Issue genuinely does not resolve — skip, not a failure', async () => {
    const path = fakeGhPath(
      'GraphQL: Could not resolve to an issue or pull request with the number of 500. (repository.issue)'
    )
    const env = { PR_BODY: TASK_BRIEF_CLOSING_500, BRANCH: 'task/iter/3', PATH: path }
    const [checkExit, binExit] = await Promise.all([
      runExit(['bun', CHECK_BIN], env),
      runExit(['bun', VERIFY_BRIEF], env)
    ])
    expect(checkExit).toBe(0)
    expect(binExit).toBe(0)
  })

  it('agree (both fail) on a genuine fetch failure — never silently skipped', async () => {
    const path = fakeGhPath('gh: authentication failed')
    const env = { PR_BODY: TASK_BRIEF_CLOSING_500, BRANCH: 'task/iter/3', PATH: path }
    const [checkExit, binExit] = await Promise.all([
      runExit(['bun', CHECK_BIN], env),
      runExit(['bun', VERIFY_BRIEF], env)
    ])
    expect(checkExit).toBe(1)
    expect(binExit).toBe(1)
  })
})
