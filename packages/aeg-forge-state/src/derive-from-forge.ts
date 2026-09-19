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
 *   - the tranche's identity is its `vinaya/tranche:<slug>` label
 *     → `goal` + `lifecycle`, via
 *     `findMilestoneForSlug`: a Milestone titled exactly `slug` (the legacy
 *     regime, kept forever) supplies both; otherwise both are derived from
 *     the label's own Issues (`goal` is always `''` for a label-only
 *     tranche — display-only, and this task invents no new home for it;
 *     `lifecycle` is `planned`/`active`/`complete` per the at-least-one
 *     guard). Never absent any more — a slug with nothing yet resolves as
 *     `planned`, not as a missing fact for this function's `?? 'active'`
 *     default to silently paper over.
 *   - `vinaya/tranche:<slug>`-labeled Issues → the task list, including
 *     `Depends-on`/`Conflicts-with` edges parsed from each Issue's
 *     "Dependency rationale" section
 *
 * `backlog` has no forge equivalent yet (the file's `## Backlog` section is
 * project-level prose with no owning Issue) — always `[]` here.
 *
 * `known` (optional `{ goal, lifecycle }`): when the caller already holds the
 * slug's facts — e.g. `indexTrancheMilestonesAsync`'s repo-wide sweep, which
 * indexes every Milestone AND every `vinaya/tranche:*` label up front —
 * passing them skips the redundant per-slug `findMilestoneForSlug` re-fetch
 * (which otherwise re-pulls the entire Milestone list, the entire label
 * list, and — for a label-only slug — that slug's Issues a second time).
 * Omit it and the facts are derived here as before. The task fetch is now
 * async (`listTasksForSlugAsync`) so the fan-outs that call this genuinely
 * parallelize; the signature is unchanged for existing 3-arg callers
 * (already `async`, already awaited).
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
