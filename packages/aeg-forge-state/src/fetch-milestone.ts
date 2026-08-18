import { ghApiGet, ghApiGetAllPagesAsync, ghApiGetAsync } from './gh'
import type { Lifecycle } from '@attalabs/aeg-types'

export type MilestoneFacts = {
  goal: string
  lifecycle: Lifecycle
}

type GhMilestone = {
  title: string
  description: string | null
  state: 'open' | 'closed'
}

/**
 * Matching rule: exact title match against the tranche slug. A Milestone
 * titled anything other than the slug verbatim (no prefix/suffix convention)
 * is not considered a match. Returns `null` when no Milestone exists yet for
 * this slug — a real, expected transitional state during rollout, not an
 * error (most tranches today have no Milestone).
 */
export function findMilestoneForSlug(owner: string, repo: string, slug: string): MilestoneFacts | null {
  const milestones = ghApiGet<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=all&per_page=100`)
  const match = milestones.find((m) => m.title === slug)
  if (!match) return null
  return {
    goal: match.description ?? '',
    lifecycle: match.state === 'closed' ? 'complete' : 'active'
  }
}

export type ActiveTrancheRef = { slug: string; goal: string }

/** One Milestone fetch, split every way its readers ask for it — see `indexTrancheMilestonesAsync`. */
export type TrancheMilestoneIndex = {
  /** Open Milestones, in `listActiveTrancheSlugs`'s shape and order. */
  active: ActiveTrancheRef[]
  /** Closed Milestones, in `listArchivedTrancheSlugs`'s shape and order. */
  archived: ActiveTrancheRef[]
  /** Milestone title → the same facts `findMilestoneForSlug` returns; absent ⇒ that reader's `null`. */
  facts: Map<string, MilestoneFacts>
}

/**
 * Lists every OPEN Milestone as an active-tranche slug — the forge-native
 * enumeration of "which tranches are currently active" — a
 * tranche's Goal/Lifecycle lives on a Milestone titled exactly its slug.
 */
export function listActiveTrancheSlugs(owner: string, repo: string): ActiveTrancheRef[] {
  const milestones = ghApiGet<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=open&per_page=100`)
  return milestones.map((m) => ({ slug: m.title, goal: m.description ?? '' }))
}

/**
 * Lists every CLOSED Milestone as an archived-tranche slug — the
 * forge-native enumeration of "which tranches are complete" (#515).
 * Mirrors `listActiveTrancheSlugs`'s shape and query, `state=closed`
 * instead of `open`. `deriveTrancheFromForge`'s Issue lookup already queries
 * `--state all` (`gh.ts`'s `ghIssueListByLabel`), so a closed Milestone's
 * `vinaya/tranche:<slug>`-labeled Issues (themselves closed, merged PRs) resolve
 * correctly through the same task-list derivation active tranches use.
 */
export function listArchivedTrancheSlugs(owner: string, repo: string): ActiveTrancheRef[] {
  const milestones = ghApiGet<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=closed&per_page=100`)
  return milestones.map((m) => ({ slug: m.title, goal: m.description ?? '' }))
}

/**
 * Every Milestone question answered from ONE `state=all` fetch: the
 * active/archived slug lists AND the per-slug `MilestoneFacts` that
 * `findMilestoneForSlug` otherwise re-derives with its own full round trip.
 *
 * The three single-purpose readers above each re-pull the entire Milestone
 * list, so a caller that needs the active list, the archived list, and one
 * `MilestoneFacts` per slug pays `2 + N` identical round trips for data that
 * is one response. `verify-coherence.ts`'s repo-wide sweep measured 9 of
 * them (~5.9 s of a 26 s run) against a 6-Milestone repo. The readers stay —
 * a caller that genuinely wants one fact should not have to index everything
 * — but any caller in a loop over slugs should index once and read from here.
 *
 * Lifecycle mapping is `findMilestoneForSlug`'s, unchanged: `closed` →
 * `complete`, anything else → `active`. A slug with no Milestone is simply
 * absent from `facts`, which is the same `null` the per-slug reader returns.
 */
export async function indexTrancheMilestonesAsync(owner: string, repo: string): Promise<TrancheMilestoneIndex> {
  // Paginated, unlike the three single-purpose readers above. Milestones are
  // append-only — closed ones are never deleted — so a single 100-item page is
  // a countdown, not a bound, and this index is the enumeration authority a
  // repo-wide sweep trusts: silent truncation there means tranches vanishing
  // from every check with no error. Measured headroom at the time of writing:
  // atta-labs/vinaya 6 total, atta-labs/attalabs 35 total.
  const milestones = await ghApiGetAllPagesAsync<GhMilestone>(
    `repos/${owner}/${repo}/milestones?state=all&per_page=100`
  )
  const active: ActiveTrancheRef[] = []
  const archived: ActiveTrancheRef[] = []
  const facts = new Map<string, MilestoneFacts>()
  for (const m of milestones) {
    const ref = { slug: m.title, goal: m.description ?? '' }
    if (m.state === 'closed') archived.push(ref)
    else active.push(ref)
    facts.set(m.title, {
      goal: m.description ?? '',
      lifecycle: m.state === 'closed' ? 'complete' : 'active'
    })
  }
  return { active, archived, facts }
}

/** Async twin of `listActiveTrancheSlugs` — non-blocking `gh` exec, same map. */
export async function listActiveTrancheSlugsAsync(owner: string, repo: string): Promise<ActiveTrancheRef[]> {
  const milestones = await ghApiGetAsync<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=open&per_page=100`)
  return milestones.map((m) => ({ slug: m.title, goal: m.description ?? '' }))
}

/** Async twin of `listArchivedTrancheSlugs` — non-blocking `gh` exec, same map. */
export async function listArchivedTrancheSlugsAsync(owner: string, repo: string): Promise<ActiveTrancheRef[]> {
  const milestones = await ghApiGetAsync<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=closed&per_page=100`)
  return milestones.map((m) => ({ slug: m.title, goal: m.description ?? '' }))
}
