import type { Tranche } from '@attalabs/aeg-types'
import type { GhIssue } from './gh'
import { findMilestoneForSlug, type MilestoneFacts } from './fetch-milestone'
import { fetchTrancheIssuesAsync, tasksFromIssues } from './list-tasks'

/**
 * The pure composition step: an already-fetched labeled-Issue list plus
 * already-known Milestone facts → the same `Tranche` `deriveTrancheFromForge`
 * returns, with zero I/O of its own.
 *
 * Exists for the repo-wide sweeps that index every Milestone up front and
 * fetch each slug's Issues once (`verify-coherence.ts`'s `loadTrancheFiles`):
 * routing those through the fetching entry point below would re-pull both
 * halves per slug. Degradation is identical — a slug with no Milestone gets
 * `''`/`'active'`, matching `parseTranche`'s own no-marker default.
 */
export function trancheFromIssues(slug: string, issues: GhIssue[], known?: MilestoneFacts | null): Tranche {
  return {
    name: slug,
    lifecycle: known?.lifecycle ?? 'active',
    goal: known?.goal ?? '',
    tasks: tasksFromIssues(issues),
    backlog: []
  }
}

/**
 * Derives an `@attalabs/aeg-types` `Tranche` purely from forge objects:
 *   - a Milestone titled exactly `slug` → `goal` + `lifecycle` (absent when no
 *     Milestone exists yet for this tranche — a real transitional state,
 *     not an error; `goal`/`lifecycle` then degrade to `''`/`'active'`,
 *     mirroring `parseTranche`'s own no-marker default)
 *   - `vinaya/tranche:<slug>`-labeled Issues → the task list, including
 *     `Depends-on`/`Conflicts-with` edges parsed from each Issue's
 *     "Dependency rationale" section
 *
 * `backlog` has no forge equivalent yet (the file's `## Backlog` section is
 * project-level prose with no owning Issue) — always `[]` here.
 *
 * `known` (optional `{ goal, lifecycle }`): when the caller already holds the
 * Milestone facts — e.g. a Studio enumeration that listed every open/closed
 * Milestone up front, so goal comes from the Milestone description and
 * lifecycle from which list the slug came from — passing them skips the
 * redundant per-slug `findMilestoneForSlug` re-fetch (which otherwise re-pulls
 * the entire Milestone list once per slug). Omit it and the Milestone is
 * fetched here as before. The task fetch is now async (`listTasksForSlugAsync`)
 * so the fan-outs that call this genuinely parallelize; the signature is
 * unchanged for existing 3-arg callers (already `async`, already awaited).
 */
export async function deriveTrancheFromForge(
  owner: string,
  repo: string,
  slug: string,
  known?: MilestoneFacts
): Promise<Tranche> {
  const milestone = known ?? findMilestoneForSlug(owner, repo, slug)
  const issues = await fetchTrancheIssuesAsync(owner, repo, slug)

  return trancheFromIssues(slug, issues, milestone)
}
