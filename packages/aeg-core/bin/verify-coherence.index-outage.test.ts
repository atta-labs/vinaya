import { execFileSync, execSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

/**
 * What the sweep reports when its enumeration authority is gone (round-3
 * review finding 1).
 *
 * The Milestone index is the ONLY authority L4 and L5 have. When its read
 * fails, `sweep.milestones` is null and the active-tranche list is empty —
 * which both checks read as "no active tranche has any drift" and report
 * clean. The pre-refactor code could not do this: L4/L5 called
 * `listActiveTrancheSlugs` synchronously and uncaught, so an index failure
 * killed the run. Catching it (the fix for round-2 finding 2) removed the
 * crash and, on the branch where a topology file keeps `files` non-empty,
 * replaced it with a vacuous green — a gate reporting pass over checks that
 * never ran, which is the one failure class this oracle exists to prevent.
 *
 * Both branches are asserted here: nothing enumerable at all (the guard that
 * already existed), and something enumerable from a topology file (the one
 * that was missing). Only `indexTrancheMilestonesAsync` is replaced; every
 * other forge read is the real one, so this measures the actual control flow
 * of a real run rather than a fully-stubbed imitation of it.
 */

vi.mock('@attalabs/aeg-forge-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@attalabs/aeg-forge-state')>()
  return {
    ...actual,
    indexTrancheMilestonesAsync: async () => {
      throw new Error('simulated forge outage — HTTP 503: No server is currently available')
    }
  }
})

const { runCoherenceChecks } = await import('./verify-coherence')
const { resolveGithubToken } = await import('@attalabs/aeg-forge-state')

const SLUG = 'zzz-index-outage-fixture'
const ACTIVE_PATH = `aeg-root/tranches/${SLUG}.md`

/** A commit on top of `origin/main` carrying one synthetic topology file. Same plumbing technique as the pr-head test. */
function commitWithTrancheFile(): string {
  const indexFile = execSync('mktemp', { encoding: 'utf8' }).trim()
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }
  const content = [
    `# Tranche: ${SLUG} — synthetic`,
    '',
    'Lifecycle: active',
    '',
    'Goal: synthetic fixture for the Milestone-index outage test.',
    '',
    '## Tasks (topology)',
    '',
    '| # | Task | Issue | Project(s) | Depends-on | Conflicts-with |',
    '|---|------|-------|-----------|------------|----------------|',
    '| 1 | Synthetic task | #999999 | aeg | — | — |',
    ''
  ].join('\n')

  execFileSync('git', ['read-tree', 'origin/main'], { env })
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8', env })
    .toString()
    .trim()
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${ACTIVE_PATH}`], { env })
  const tree = execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim()
  const commit = execFileSync('git', ['commit-tree', tree, '-p', 'origin/main', '-m', 'index-outage fixture'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: 'AEG test fixture',
      GIT_AUTHOR_EMAIL: 'aeg-test-fixture@localhost',
      GIT_COMMITTER_NAME: 'AEG test fixture',
      GIT_COMMITTER_EMAIL: 'aeg-test-fixture@localhost'
    }
  }).trim()
  execFileSync('rm', ['-f', indexFile])
  return commit
}

describe('a lost Milestone index is reported, never passed over', () => {
  it('withholds L4 and L5 and reports the gap when a topology file keeps the sweep non-empty', async () => {
    if (!(await resolveGithubToken())) throw new Error('this test needs a live forge token (GITHUB_TOKEN or gh auth)')

    const head = commitWithTrancheFile()
    const { results, forgeUnavailable } = await runCoherenceChecks({
      prContext: { prHeadSha: head, touchedFiles: new Set([ACTIVE_PATH]) }
    })

    // The synthetic tranche IS present — so the "nothing could be enumerated"
    // guard does not fire, and this is the branch that used to pass silently.
    expect(results.some((r) => r.check === 'L3')).toBe(true)

    // Neither check may report a verdict it had no authority to reach.
    expect(results.some((r) => r.check === 'L4')).toBe(false)
    expect(results.some((r) => r.check === 'L5')).toBe(false)

    const forgeFailure = results.find(
      (r) => r.check === 'FORGE' && r.status === 'fail' && /L4 and L5/.test(r.note ?? '')
    )
    expect(forgeFailure).toBeDefined()
    expect(forgeFailure?.note).toContain('severity:infra')
    expect(forgeUnavailable).toBe(true)
  }, 180_000)

  it('refuses the whole run when the index is lost and nothing local can stand in', async () => {
    // No PR context: this repo carries no topology file at all, so an index
    // failure leaves zero tranches — every check would pass by default.
    const { results, forgeUnavailable } = await runCoherenceChecks()

    expect(results.some((r) => r.check === 'L4')).toBe(false)
    expect(results.some((r) => r.check === 'A1')).toBe(false)
    const forgeFailure = results.find((r) => r.check === 'FORGE' && r.status === 'fail')
    expect(forgeFailure?.note).toMatch(/no tranche could be enumerated/)
    expect(forgeUnavailable).toBe(true)
  }, 120_000)
})
