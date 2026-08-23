import {
  type GhIssue,
  ghApiGet,
  ghApiGetAllPagesAsync,
  ghApiGetAsync,
  ghIssueListByLabel,
  ghIssueListByLabelAsync
} from './gh'
import { trancheLabel, trancheSlugOf } from './labels'
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

type GhLabel = {
  name: string
}

/**
 * A tranche's identity is its `vinaya/tranche:<slug>` label
 * (vinaya-milestone-model-v1 task 1) — a Milestone is no longer required to
 * exist, and one Milestone may legitimately hold several tranches. The
 * legacy exception, kept forever with no backfill: a Milestone titled
 * EXACTLY a tranche slug (no prefix/suffix convention) is still read the old
 * way — twelve open and roughly forty-five closed Milestones in this repo
 * predate the label model and depend on this never changing underneath
 * them. `matchesLegacyMilestone` is the one predicate every reader below
 * shares, so "is this slug legacy" can never drift between them.
 */
function matchesLegacyMilestone(milestones: GhMilestone[], slug: string): GhMilestone | null {
  return milestones.find((m) => m.title === slug) ?? null
}

function factsFromLegacyMilestone(milestone: GhMilestone): MilestoneFacts {
  return {
    goal: milestone.description ?? '',
    lifecycle: milestone.state === 'closed' ? 'complete' : 'active'
  }
}

/**
 * The new-path lifecycle rule (§2 of Issue #191): `planned` when the label
 * carries no Issues yet, `active` when any is open, `complete` when at least
 * one exists and every one is closed. The at-least-one guard is not
 * optional — a freshly created label with zero Issues must NOT read as
 * `complete` (a Milestone holding it would wrongly report the tranche
 * finished).
 */
function lifecycleFromIssues(issues: GhIssue[]): Lifecycle {
  if (issues.length === 0) return 'planned'
  return issues.some((i) => i.state === 'OPEN') ? 'active' : 'complete'
}

/**
 * Matching rule: exact title match against the tranche slug wins first
 * (the legacy path, forever). Otherwise the tranche is derived from its
 * `vinaya/tranche:<slug>`-labeled Issues — never `null` any more: a slug
 * with no legacy Milestone and no Issues yet is a real, `planned` tranche,
 * not an absent one. The `| null` return type is kept for source
 * compatibility with existing callers (e.g. `open-issue.ts`'s cosmetic
 * Milestone auto-attach), which treat "not active" and "unknown" the same
 * way either side of a `?.`.
 */
export function findMilestoneForSlug(owner: string, repo: string, slug: string): MilestoneFacts | null {
  const milestones = ghApiGet<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=all&per_page=100`)
  const legacy = matchesLegacyMilestone(milestones, slug)
  if (legacy) return factsFromLegacyMilestone(legacy)

  const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
  return { goal: '', lifecycle: lifecycleFromIssues(issues) }
}

export type ActiveTrancheRef = { slug: string; goal: string }

/** One Milestone-plus-label fetch, split every way its readers ask for it — see `indexTrancheMilestonesAsync`. */
export type TrancheMilestoneIndex = {
  /** Every tranche whose derived lifecycle is `active`, in `listActiveTrancheSlugs`'s shape and order. */
  active: ActiveTrancheRef[]
  /** Every tranche whose derived lifecycle is `complete`, in `listArchivedTrancheSlugs`'s shape and order. */
  archived: ActiveTrancheRef[]
  /** Tranche slug → the same facts `findMilestoneForSlug` returns for it. */
  facts: Map<string, MilestoneFacts>
  /**
   * Slugs backed by a Milestone titled exactly the slug — the legacy 1:1
   * regime. This is the set L4's exact-title-match invariant is still
   * meaningful for: once a Milestone can legitimately hold several
   * tranches, an Issue's attached-Milestone title no longer needs to equal
   * every OTHER slug it might carry, so L4 must restrict itself to this set
   * rather than every active slug.
   */
  legacySlugs: Set<string>
}

/** Every `vinaya/tranche:*`-prefixed label the repo carries, mapped to its slug. */
function trancheSlugsFromLabels(labels: GhLabel[]): string[] {
  const slugs: string[] = []
  for (const l of labels) {
    const slug = trancheSlugOf(l.name)
    if (slug !== null) slugs.push(slug)
  }
  return slugs
}

/**
 * Lists every tranche whose derived lifecycle is ACTIVE — the forge-native
 * enumeration of "which tranches are currently active", now sourced from
 * BOTH the legacy Milestone-title population and the `vinaya/tranche:*`
 * label population, deduplicated by slug. `state=all` on the Milestone
 * fetch (not `state=open`, unlike before this task) is required for
 * correctness, not merely completeness: a slug legacy-matches a CLOSED
 * Milestone just as permanently as an open one, and that slug must never
 * fall through to the label-derived path — an accidental label reuse on a
 * closed legacy tranche must not resurrect it as active.
 */
export function listActiveTrancheSlugs(owner: string, repo: string): ActiveTrancheRef[] {
  const milestones = ghApiGet<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=all&per_page=100`)
  const labels = ghApiGet<GhLabel[]>(`repos/${owner}/${repo}/labels?per_page=100`)
  const slugs = new Set<string>([...milestones.map((m) => m.title), ...trancheSlugsFromLabels(labels)])

  const active: ActiveTrancheRef[] = []
  for (const slug of slugs) {
    const legacy = matchesLegacyMilestone(milestones, slug)
    if (legacy) {
      const facts = factsFromLegacyMilestone(legacy)
      if (facts.lifecycle === 'active') active.push({ slug, goal: facts.goal })
      continue
    }
    const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
    if (lifecycleFromIssues(issues) === 'active') active.push({ slug, goal: '' })
  }
  return active
}

/**
 * Lists every tranche whose derived lifecycle is COMPLETE (#515's original
 * "archived" list, extended past Milestones the same way `listActiveTrancheSlugs`
 * was). Mirrors its shape, query, and legacy/label split exactly — see that
 * function's doc comment for the `state=all` rationale, which applies
 * identically here.
 */
export function listArchivedTrancheSlugs(owner: string, repo: string): ActiveTrancheRef[] {
  const milestones = ghApiGet<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=all&per_page=100`)
  const labels = ghApiGet<GhLabel[]>(`repos/${owner}/${repo}/labels?per_page=100`)
  const slugs = new Set<string>([...milestones.map((m) => m.title), ...trancheSlugsFromLabels(labels)])

  const archived: ActiveTrancheRef[] = []
  for (const slug of slugs) {
    const legacy = matchesLegacyMilestone(milestones, slug)
    if (legacy) {
      const facts = factsFromLegacyMilestone(legacy)
      if (facts.lifecycle === 'complete') archived.push({ slug, goal: facts.goal })
      continue
    }
    const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
    if (lifecycleFromIssues(issues) === 'complete') archived.push({ slug, goal: '' })
  }
  return archived
}

/**
 * Every Milestone-or-label question answered from a bounded set of fetches:
 * the active/archived slug lists, the per-slug `MilestoneFacts`, AND which
 * slugs are legacy — everything `findMilestoneForSlug`/`listActiveTrancheSlugs`/
 * `listArchivedTrancheSlugs` otherwise re-derive with their own full round
 * trips.
 *
 * Two calls are paid once regardless of tranche count — the Milestone list
 * and the label list, both paginated (`ghApiGetAllPagesAsync`, unlike the
 * three single-purpose sync readers above, which stay on the un-paginated
 * `ghApiGet` they always used). What is NOT free: a label-derived (non-legacy)
 * slug's Issues still need their own fetch, since Issue state is the only
 * source of that slug's lifecycle. Those run concurrently
 * (`Promise.all`), not one after another — the same discipline
 * `verify-coherence.ts`'s sweep already applies to its own per-slug fetches.
 *
 * Legacy slugs pay nothing beyond the two up-front fetches — their facts
 * come from the Milestone list alone, exactly as before this task.
 */
export async function indexTrancheMilestonesAsync(owner: string, repo: string): Promise<TrancheMilestoneIndex> {
  // Paginated: Milestones and labels are both append-only in practice
  // (labels are rarely deleted; closed Milestones never are), so a single
  // 100-item page is a countdown, not a bound, for the same reason
  // documented at `ghApiGetAllPagesAsync`'s own definition.
  const [milestones, labels] = await Promise.all([
    ghApiGetAllPagesAsync<GhMilestone>(`repos/${owner}/${repo}/milestones?state=all&per_page=100`),
    ghApiGetAllPagesAsync<GhLabel>(`repos/${owner}/${repo}/labels?per_page=100`)
  ])

  const active: ActiveTrancheRef[] = []
  const archived: ActiveTrancheRef[] = []
  const facts = new Map<string, MilestoneFacts>()
  const legacySlugs = new Set<string>(milestones.map((m) => m.title))

  for (const m of milestones) {
    const ref = { slug: m.title, goal: m.description ?? '' }
    const f = factsFromLegacyMilestone(m)
    if (f.lifecycle === 'complete') archived.push(ref)
    else active.push(ref)
    facts.set(m.title, f)
  }

  const newPathSlugs = trancheSlugsFromLabels(labels).filter((slug) => !legacySlugs.has(slug))
  const uniqueNewPathSlugs = [...new Set(newPathSlugs)]
  const fetchedIssues = await Promise.all(
    uniqueNewPathSlugs.map((slug) => ghIssueListByLabelAsync(owner, repo, trancheLabel(slug)))
  )

  uniqueNewPathSlugs.forEach((slug, i) => {
    const issues = fetchedIssues[i] ?? []
    const lifecycle = lifecycleFromIssues(issues)
    const f: MilestoneFacts = { goal: '', lifecycle }
    facts.set(slug, f)
    if (lifecycle === 'active') active.push({ slug, goal: '' })
    else if (lifecycle === 'complete') archived.push({ slug, goal: '' })
    // 'planned' (zero Issues) appears in neither list — same degrade as
    // before this task, when a slug with no Milestone appeared in neither.
  })

  return { active, archived, facts, legacySlugs }
}

/**
 * Async twin of `listActiveTrancheSlugs` — same map, but built from
 * `indexTrancheMilestonesAsync` rather than repeating the sync version's own
 * legacy/label split a third time. No known caller today (re-exported only);
 * routing through the index is strictly cheaper than a literal duplicate of
 * the sync path would have been once that path grew a per-slug Issue fetch.
 */
export async function listActiveTrancheSlugsAsync(owner: string, repo: string): Promise<ActiveTrancheRef[]> {
  return (await indexTrancheMilestonesAsync(owner, repo)).active
}

/** Async twin of `listArchivedTrancheSlugs` — see `listActiveTrancheSlugsAsync`'s doc comment. */
export async function listArchivedTrancheSlugsAsync(owner: string, repo: string): Promise<ActiveTrancheRef[]> {
  return (await indexTrancheMilestonesAsync(owner, repo)).archived
}
