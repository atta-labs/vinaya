import { execFileSync, execSync } from 'node:child_process'
import { fetchTrancheIssuesAsync, indexTrancheMilestonesAsync, resolveRepo } from '@attalabs/aeg-forge-state'
import { describe, expect, it } from 'vitest'
import { loadTrancheSweep } from './verify-coherence'

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
   */
  it('fetches the forge for a deleted tranche whose Milestone is real, so its tasks survive the deletion', async () => {
    const live = await liveTrancheWithIssues()
    const livePath = `aeg-root/tranches/${live.slug}.md`

    // Base carries a topology file for a REAL tranche slug, with one row that
    // exists nowhere on the forge; the PR deletes that file.
    const base = commitWithFiles('origin/main', { [livePath]: trancheFileContent(live.slug, 'active') }, 'fixture base')
    const head = commitWithFiles(base, { [livePath]: '' }, 'fixture head: delete the tranche file')

    const sweep = await loadTrancheSweep({ prHeadSha: head, touchedFiles: new Set([livePath]) }, live.slug, base)

    const entries = sweep.files.filter((f) => f.slug === live.slug)
    expect(entries).toHaveLength(1)

    // The forge WAS consulted for this slug: at least one task carries a real
    // Issue number. With the fill-in keyed on enumeration, `needForge` skips
    // the slug, `trancheFromIssues` receives `[]`, and the only task left is
    // the fixture's own unreachable `#999999` row.
    const issues = entries[0]?.tranche.tasks.map((t) => t.issue) ?? []
    expect(issues.filter((n) => n !== null && n !== 999999).length).toBeGreaterThan(0)
    expect(sweep.issuesBySlug.get(live.slug)?.length ?? 0).toBeGreaterThan(0)
  }, 120_000)
})

/**
 * The first active Milestone in this repo that has at least one
 * `vinaya/tranche:<slug>`-labeled Issue. Resolved live rather than hardcoded:
 * a pinned slug becomes a false red the day that tranche is archived.
 */
async function liveTrancheWithIssues(): Promise<{ slug: string }> {
  const repo = await resolveRepo()
  if (!repo) throw new Error('no repo resolved — this test needs a live forge')

  const index = await indexTrancheMilestonesAsync(repo.owner, repo.repo)
  for (const { slug } of index.active) {
    const issues = await fetchTrancheIssuesAsync(repo.owner, repo.repo, slug)
    if (issues.length > 0) return { slug }
  }
  throw new Error('no active Milestone in this repo carries labeled Issues — cannot observe the fetch predicate')
}
