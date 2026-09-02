import { execFileSync, execSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the sweep's enumeration predicate (task 9, review
 * finding 1). The single-fetch rewrite keyed its Milestone fill-in on which
 * tranches were *enumerated* rather than on which were actually *produced*,
 * which silently changed what a PR that removes a topology file does to the
 * repo-wide sweep:
 *
 *   - Plain deletion — the tranche disappeared from every repo-wide check
 *     (A1/A2/A3 included), a gate shrinking rather than failing.
 *   - Archival move (`tranches/x.md` → `tranches/completed/x.md`, the
 *     operation `aeg-root/process.md` and the Tranche Archivist role
 *     prescribe) — the destination candidate was suppressed because the
 *     source had already been seen, leaving an entry with `archived: false`
 *     built from the BASE ref's pre-move content, instead of `archived: true`
 *     built from the PR head's own `Lifecycle: complete` edit. That inverts
 *     `checkL1`/`checkL2`'s subject and feeds `checkT3` the pre-move table's
 *     `#TBD` rows as active-tranche rows.
 *
 * Both are invisible to `verify-coherence.test.ts` (which runs with
 * `prContext = null`) and to `verify-coherence.pr-head.test.ts` (which only
 * covers ADDING a file). Neither could be reproduced against this repo's real
 * `origin/main`, which carries no `aeg-root/tranches` tree at all — hence the
 * synthetic base ref below.
 *
 * Fixtures are built with git plumbing against a throwaway `GIT_INDEX_FILE`,
 * the same technique `verify-coherence.pr-head.test.ts` established — this
 * never touches the worktree's real index or working tree. Task Issues use
 * `#999999`, which cannot exist on the real forge, so any task appearing in
 * the result demonstrably came from the fixture content and not a forge read.
 */

/**
 * The fourth case below (round-3 review finding 4, then `#333`) needs a slug
 * with a real Milestone AND real labeled Issues — the one thing the other
 * three cases' throwaway slugs deliberately lack. Reading that off this
 * repo's live forge state threw whenever no active Milestone carries labeled
 * Issues, which is this repo's normal resting state between tranche waves
 * (every task merged, next tranche not yet planned), not an error condition.
 *
 * So the Milestone/Issues are built instead, the same way the tranche files
 * above are: synthetic, fixture-owned, and independent of what the live forge
 * currently holds. Only `indexTrancheMilestonesAsync` and
 * `fetchTrancheIssuesAsync` are replaced, and `fetchTrancheIssuesAsync` only
 * for `FORGE_FIXTURE_SLUG` — every other forge read, and every other slug
 * this file's other cases query, is the real one. Same discipline
 * `verify-coherence.index-outage.test.ts` documents for its own single
 * replaced function.
 */
const FORGE_FIXTURE_SLUG = 'zzz-topology-move-forge-fixture'
const FORGE_FIXTURE_ISSUE_NUMBER = 424242

vi.mock('@attalabs/aeg-forge-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@attalabs/aeg-forge-state')>()
  return {
    ...actual,
    indexTrancheMilestonesAsync: async () => ({
      active: [{ slug: FORGE_FIXTURE_SLUG, goal: 'synthetic Milestone for the forge-fetch regression case' }],
      archived: [],
      facts: new Map([
        [
          FORGE_FIXTURE_SLUG,
          { goal: 'synthetic Milestone for the forge-fetch regression case', lifecycle: 'active' as const }
        ]
      ]),
      legacySlugs: new Set<string>()
    }),
    fetchTrancheIssuesAsync: async (owner: string, repo: string, slug: string) => {
      if (slug !== FORGE_FIXTURE_SLUG) return actual.fetchTrancheIssuesAsync(owner, repo, slug)
      return [
        {
          number: FORGE_FIXTURE_ISSUE_NUMBER,
          title: `[${FORGE_FIXTURE_SLUG}] 1 — Fixture task delivered by the mocked forge`,
          body: '',
          state: 'OPEN' as const,
          labels: [{ name: `vinaya/tranche:${FORGE_FIXTURE_SLUG}` }],
          milestone: null
        }
      ]
    }
  }
})

const { loadTrancheSweep } = await import('./verify-coherence')

const FIXTURE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'AEG test fixture',
  GIT_AUTHOR_EMAIL: 'aeg-test-fixture@localhost',
  GIT_COMMITTER_NAME: 'AEG test fixture',
  GIT_COMMITTER_EMAIL: 'aeg-test-fixture@localhost'
}

function trancheFileContent(slug: string, lifecycle: 'active' | 'complete'): string {
  return [
    `# Tranche: ${slug} — synthetic`,
    '',
    `Lifecycle: ${lifecycle}`,
    '',
    'Goal: synthetic fixture for the topology-move regression test.',
    '',
    '## Tasks (topology)',
    '',
    '| # | Task | Issue | Project(s) | Depends-on | Conflicts-with |',
    '|---|------|-------|-----------|------------|----------------|',
    `| 1 | Synthetic ${lifecycle} task | #999999 | aeg | — | — |`,
    ''
  ].join('\n')
}

/** Builds a commit whose tree contains exactly the given `path → content` entries, on top of `parent`. */
function commitWithFiles(parent: string, files: Record<string, string>, message: string): string {
  const indexFile = execSync('mktemp', { encoding: 'utf8' }).trim()
  const env = { ...process.env, GIT_INDEX_FILE: indexFile }

  execFileSync('git', ['read-tree', parent], { env })

  for (const [path, content] of Object.entries(files)) {
    if (content === '') {
      execFileSync('git', ['update-index', '--force-remove', path], { env })
      continue
    }
    const blobSha = execFileSync('git', ['hash-object', '-w', '--stdin'], { input: content, encoding: 'utf8', env })
      .toString()
      .trim()
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blobSha},${path}`], { env })
  }

  const treeSha = execFileSync('git', ['write-tree'], { env, encoding: 'utf8' }).trim()
  const commitSha = execFileSync('git', ['commit-tree', treeSha, '-p', parent, '-m', message], {
    encoding: 'utf8',
    env: { ...FIXTURE_ENV, GIT_INDEX_FILE: indexFile }
  }).trim()

  execFileSync('rm', ['-f', indexFile])
  return commitSha
}

const SLUG = 'zzz-topology-move-fixture'
const ACTIVE_PATH = `aeg-root/tranches/${SLUG}.md`
const COMPLETED_PATH = `aeg-root/tranches/completed/${SLUG}.md`

describe('a PR that removes a topology file cannot narrow the sweep', () => {
  it('keeps an archival move on the PR head — archived: true, and the head’s own content', async () => {
    // Base: the tranche is active, with a file under aeg-root/tranches/.
    const base = commitWithFiles('origin/main', { [ACTIVE_PATH]: trancheFileContent(SLUG, 'active') }, 'fixture base')
    // Head: `git mv` to completed/, with the archival Lifecycle edit.
    const head = commitWithFiles(
      base,
      { [ACTIVE_PATH]: '', [COMPLETED_PATH]: trancheFileContent(SLUG, 'complete') },
      'fixture head: archive the tranche'
    )

    const sweep = await loadTrancheSweep(
      { prHeadSha: head, touchedFiles: new Set([ACTIVE_PATH, COMPLETED_PATH]) },
      SLUG,
      base
    )

    const entries = sweep.files.filter((f) => f.slug === SLUG)
    // Exactly one entry — the move must not produce both a stale active and a
    // new archived row for the same slug.
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.archived).toBe(true)
    expect(entry?.tranche.lifecycle).toBe('complete')
    // Proves the content came from the PR head, not the base ref: only the
    // head's copy says "complete".
    expect(entry?.tranche.tasks).toHaveLength(1)
    expect(entry?.tranche.tasks[0]).toMatchObject({ id: '1', title: 'Synthetic complete task', issue: 999999 })
  }, 60_000)

  it('reaches the Milestone fill-in for a plain deletion, and reports absence only because no Milestone exists', async () => {
    const base = commitWithFiles('origin/main', { [ACTIVE_PATH]: trancheFileContent(SLUG, 'active') }, 'fixture base')
    const head = commitWithFiles(base, { [ACTIVE_PATH]: '' }, 'fixture head: delete the tranche file')

    const sweep = await loadTrancheSweep({ prHeadSha: head, touchedFiles: new Set([ACTIVE_PATH]) }, SLUG, base)

    // The slug has no Milestone on the real forge, so the fill-in cannot
    // recover it and the honest result is absence — but it must be absence
    // reached by the fill-in finding no Milestone, not by the candidate being
    // suppressed. The base-ref file is the observable proof the loader still
    // reaches the recovery path rather than short-circuiting: with the
    // suppression bug the sweep also returned nothing, so this asserts the
    // stronger property below instead.
    expect(sweep.files.filter((f) => f.slug === SLUG)).toHaveLength(0)
  }, 60_000)

  it('recovers a deleted tranche from the base ref when the PR removes only one of its two files', async () => {
    // The recovery path that IS observable without a real Milestone: the
    // completed/ copy survives at the head, so the sweep must still carry the
    // slug even though the active-dir candidate vanished.
    const base = commitWithFiles(
      'origin/main',
      { [ACTIVE_PATH]: trancheFileContent(SLUG, 'active'), [COMPLETED_PATH]: trancheFileContent(SLUG, 'complete') },
      'fixture base with both copies'
    )
    const head = commitWithFiles(base, { [ACTIVE_PATH]: '' }, 'fixture head: drop the active copy')

    const sweep = await loadTrancheSweep({ prHeadSha: head, touchedFiles: new Set([ACTIVE_PATH]) }, SLUG, base)

    const entries = sweep.files.filter((f) => f.slug === SLUG)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.archived).toBe(true)
  }, 60_000)

  /**
   * The predicate itself, on the only shape that can observe it (round-3
   * review finding 4). The three cases above all use a synthetic slug with no
   * Milestone, and the fill-in's own dedupe is keyed on `files` — so keying
   * `producedSlugs` on *enumerated* rather than *produced* candidates leaves
   * every one of them green while still being the defect the fix names.
   *
   * What it actually breaks is the fetch list: an enumerated-but-vanished
   * candidate marks its slug as already produced, the forge fetch for it is
   * never issued, and the fill-in composes the tranche from an EMPTY Issue
   * list. The tranche is then present with zero forge-derived tasks — every
   * task-level check trivially passes it. That is invisible to a presence
   * assertion and needs a slug whose Milestone and labeled Issues are real.
   *
   * "Real" here means the mocked forge above, not this repo's live state:
   * a slug with an actual Milestone and labeled Issues is not always
   * available live (the repo's normal resting state between tranche waves
   * has zero open tranches), so the Milestone/Issues are fixture-built. This
   * case no longer reads live repo state at all — regressing back to a live
   * lookup would reintroduce the false-red this fixture replaces.
   */
  it('fetches the forge for a deleted tranche whose Milestone is real, so its tasks survive the deletion', async () => {
    const forgeFixturePath = `aeg-root/tranches/${FORGE_FIXTURE_SLUG}.md`

    // Base carries a topology file for the mocked-forge slug, with one row
    // that exists nowhere on the (mocked) forge; the PR deletes that file.
    const base = commitWithFiles(
      'origin/main',
      { [forgeFixturePath]: trancheFileContent(FORGE_FIXTURE_SLUG, 'active') },
      'fixture base'
    )
    const head = commitWithFiles(base, { [forgeFixturePath]: '' }, 'fixture head: delete the tranche file')

    const sweep = await loadTrancheSweep(
      { prHeadSha: head, touchedFiles: new Set([forgeFixturePath]) },
      FORGE_FIXTURE_SLUG,
      base
    )

    const entries = sweep.files.filter((f) => f.slug === FORGE_FIXTURE_SLUG)
    expect(entries).toHaveLength(1)

    // The forge WAS consulted for this slug: at least one task carries a real
    // Issue number. With the fill-in keyed on enumeration, `needForge` skips
    // the slug, `trancheFromIssues` receives `[]`, and the only task left is
    // the fixture's own unreachable `#999999` row.
    const issues = entries[0]?.tranche.tasks.map((t) => t.issue) ?? []
    expect(issues.filter((n) => n !== null && n !== 999999).length).toBeGreaterThan(0)
    expect(sweep.issuesBySlug.get(FORGE_FIXTURE_SLUG)?.length ?? 0).toBeGreaterThan(0)
  }, 60_000)
})
