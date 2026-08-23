import { type GhIssue, ghIssueListByAnyLabel } from './gh'
import { trancheLabel } from './labels'

export type IssueMilestoneFact = { issue: number; milestoneTitle: string | null }

/**
 * The pure half of `listIssueMilestonesForSlug`: for the OPEN Issues in an
 * already-fetched labeled-Issue list, each Issue's GitHub-native milestone
 * title (or `null` when unattached).
 *
 * Split out so a caller that already holds the slug's Issues (via
 * `fetchTrancheIssuesAsync`, the same query the task-list derivation runs)
 * derives L4's facts from them instead of re-fetching. The wrapper below
 * still exists for callers that hold nothing — it reuses the same
 * `ghIssueListByAnyLabel` *function*, but that only ever avoided a second
 * IMPLEMENTATION, never a second round trip.
 */
export function issueMilestonesFromIssues(issues: GhIssue[]): IssueMilestoneFact[] {
  return issues
    .filter((i) => i.state === 'OPEN')
    .map((i) => ({ issue: i.number, milestoneTitle: i.milestone?.title ?? null }))
}

/**
 * For OPEN Issues carrying `vinaya/tranche:<slug>`, each Issue's GitHub-native
 * milestone title (or `null` when unattached) — fetching the list itself
 * (aeg-review-gate-v1 task 1 follow-up: the L4 coherence check).
 *
 * Unchanged by vinaya-milestone-model-v1 task 1: this reader still reports
 * the raw attachment fact for every slug it is asked about, legacy or not.
 * The meaning of that fact changed — a Milestone may now legitimately hold
 * several tranches, so "the attached Milestone's title differs from this
 * Issue's own tranche slug" is no longer inherently drift — but that
 * judgment belongs to the caller (`checkL4`, restricted by its own caller in
 * `verify-coherence.ts` to legacy-titled slugs only), not to this fetch.
 */
export function listIssueMilestonesForSlug(owner: string, repo: string, slug: string): IssueMilestoneFact[] {
  return issueMilestonesFromIssues(ghIssueListByAnyLabel(owner, repo, [trancheLabel(slug)]))
}
