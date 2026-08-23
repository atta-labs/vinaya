import { type GhIssue, ghApiGet, ghApiGetAllPagesAsync, ghIssueListByLabel, ghIssueListByLabelAsync } from './gh'
import { trancheLabel, trancheSlugOf } from './labels'
import { unwrapValue } from './list-tasks'
import { stripCode } from './strip-code'
import type { Lifecycle } from '@attalabs/aeg-types'

export type MilestoneFacts = {
  goal: string
  lifecycle: Lifecycle
}

/**
 * Reads the `Release:` field from a Milestone description — this package's
 * own copy of the grammar `@attalabs/aeg-core`'s `milestone-validation.ts`
 * defines (`vinaya-milestone-model-v1` task 2): line-anchored, `**`-optional
 * on both sides, code fences stripped first, first match wins. Duplicated
 * rather than imported because this package sits BELOW `aeg-core` in the
 * dependency graph (`aeg-core → aeg-forge-state`) and cannot import back up
 * — the same layering that already gives `Project:` two independent readers
 * (`list-tasks.ts`'s `PROJECT_FIELD` and `issue-validation.ts`'s
 * `declaredProjects`). This reader is tolerant, not a gate: a malformed or
 * absent field both read as `null` here — refusing a malformed value at
 * write time is `checkMilestoneShape`'s job, not this one's.
 *
 * No production caller reads this yet: `MilestoneFacts.goal` stays the raw
 * description, deliberately, so the legacy 1:1 path's output is unchanged by
 * this task. This is the read-side counterpart the future adopt-a-Milestone
 * work (out of this task's surface) will consume — shipped now, proven by
 * its own tests, so that work does not also have to invent the parser.
 */
const RELEASE_FIELD = /^\s*(?:\*\*)?Release(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/im
const RELEASE_VALUE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/

export function releaseFromDescription(description: string): string | null {
  const m = stripCode(description, { inlineSpans: 'keep' }).match(RELEASE_FIELD)
  if (!m) return null
  const raw = unwrapValue(m[1] ?? '')
  return RELEASE_VALUE.test(raw) ? raw : null
}

const INTENTS_HEADING = /^#{1,6}\s*Tranche intents\s*$/im
const NEXT_HEADING = /^#{1,6}\s+\S/m
const INTENT_BULLET = /^-\s+([a-z0-9][a-z0-9-]*)\s*:\s*(.+)$/i

/**
 * The tranche goal is never stored — it is the `### Tranche intents` line
 * matching `slug` in a Milestone's description (vinaya-milestone-model-v1
 * task 2, settled decision). A label with no intent line resolves to `''`,
 * exactly as an unmilestoned tranche did before this task. Same intents
 * grammar as `@attalabs/aeg-core`'s `milestone-validation.ts`, duplicated for
 * the same layering reason `releaseFromDescription` is.
 */
export function intentGoalForSlug(description: string, slug: string): string {
  const text = stripCode(description, { inlineSpans: 'keep' })
  const start = text.match(INTENTS_HEADING)
  if (!start || start.index === undefined) return ''
  const rest = text.slice(start.index + start[0].length)
  const next = rest.match(NEXT_HEADING)
  const section = rest.slice(0, next && next.index !== undefined ? next.index : rest.length)

  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const m = trimmed.match(INTENT_BULLET)
    if (m && (m[1] ?? '').toLowerCase() === slug.toLowerCase()) return (m[2] ?? '').trim()
  }
  return ''
}

/**
 * A Milestone's OWN lifecycle, aggregated one altitude above
 * `lifecycleFromIssues`: a Milestone holding zero tranches — or holding only
 * tranches that are themselves still `planned` — derives `planned`, never
 * `complete`. Without the explicit zero-length/all-planned guard,
 * `[].every(...)` is vacuously `true` in JS, which is exactly the bug this
 * guard exists to close: a freshly created, empty milestone must not report
 * itself finished.
 *
 * No production caller aggregates a live Milestone's tranches into this yet
 * — that requires enumerating which tranches a Milestone declares and
 * fetching each one's own lifecycle, the adopt-a-Milestone read pipeline
 * this task does not build (out of surface). Proven directly against its
 * own unit tests instead, which is what the zero-tranche case actually
 * needs today: a Milestone declaring no intents derives `planned` by
 * construction, with nothing to fetch.
 */
export function milestoneLifecycleFromTrancheLifecycles(lifecycles: Lifecycle[]): Lifecycle {
  if (lifecycles.length === 0 || lifecycles.every((l) => l === 'planned')) return 'planned'
  return lifecycles.every((l) => l === 'complete') ? 'complete' : 'active'
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

/**
 * Lowercase, digits, and hyphens only, with AT LEAST ONE hyphen (two or more
 * segments) — every real tranche slug in this repo's own forge is shaped
 * this way (`aeg-forge-state-v1`, `done-v1`, `tranche-0`, …), and no real one
 * is a single bare word. Deliberately NOT `list-tasks.ts`'s `PROJECT_SLUG`
 * (`/^[a-z0-9][a-z0-9-]*$/i`): that shape is right for a `Project:` field
 * value, which a human may type in any case, but wrong here — its `i` flag
 * let a single-word, mixed-case Architect title (`MilestoneModel`, `Vinaya`)
 * pass as slug-shaped in an earlier version of this guard (code review round
 * 2 caught it live), and its single-segment tolerance would pass a lowercase
 * one-word title the same way. Requiring a hyphen is the one property every
 * real slug shares that an ordinary short free-text title is unlikely to.
 */
const TRANCHE_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/

/**
 * Every Milestone whose title is even SLUG-SHAPED — the candidate universe
 * for "is this title a legacy tranche" enumeration (vinaya-milestone-model-v1
 * task 2, fixing a live bug a code review caught). Before this guard, the
 * three enumeration functions below (`listActiveTrancheSlugs`,
 * `listArchivedTrancheSlugs`, `indexTrancheMilestonesAsync`) fed EVERY
 * Milestone's title into their candidate-slug set unconditionally — safe
 * only while every Milestone was created 1:1 by the Planner with
 * title-equals-slug. Once the Architect can create a Milestone with an
 * arbitrary free-text title (a product goal, not a tranche), that title
 * could trivially legacy-match itself and the Milestone would be listed as a
 * phantom tranche, its raw description read as the "goal".
 */
function slugShapedTitles(milestones: GhMilestone[]): string[] {
  return milestones.map((m) => m.title).filter((t) => TRANCHE_SLUG_SHAPE.test(t))
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
 * The goal for a label-derived (non-legacy) tranche: the first matching
 * `### Tranche intents` line found across every fetched Milestone, in list
 * order — `''` when none declares one, exactly as an unmilestoned tranche
 * read before this task (vinaya-milestone-model-v1 task 2).
 */
function goalFromMilestones(milestones: GhMilestone[], slug: string): string {
  for (const m of milestones) {
    const goal = intentGoalForSlug(m.description ?? '', slug)
    if (goal) return goal
  }
  return ''
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
  return { goal: goalFromMilestones(milestones, slug), lifecycle: lifecycleFromIssues(issues) }
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
  const slugs = new Set<string>([...slugShapedTitles(milestones), ...trancheSlugsFromLabels(labels)])

  const active: ActiveTrancheRef[] = []
  for (const slug of slugs) {
    const legacy = matchesLegacyMilestone(milestones, slug)
    if (legacy) {
      const facts = factsFromLegacyMilestone(legacy)
      if (facts.lifecycle === 'active') active.push({ slug, goal: facts.goal })
      continue
    }
    const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
    if (lifecycleFromIssues(issues) === 'active') active.push({ slug, goal: goalFromMilestones(milestones, slug) })
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
  const slugs = new Set<string>([...slugShapedTitles(milestones), ...trancheSlugsFromLabels(labels)])

  const archived: ActiveTrancheRef[] = []
  for (const slug of slugs) {
    const legacy = matchesLegacyMilestone(milestones, slug)
    if (legacy) {
      const facts = factsFromLegacyMilestone(legacy)
      if (facts.lifecycle === 'complete') archived.push({ slug, goal: facts.goal })
      continue
    }
    const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
    if (lifecycleFromIssues(issues) === 'complete') archived.push({ slug, goal: goalFromMilestones(milestones, slug) })
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
  const legacySlugs = new Set<string>(slugShapedTitles(milestones))

  for (const m of milestones) {
    // Skip a free-text-titled (Architect) Milestone entirely — it is not a
    // tranche and must not be indexed as one. See `slugShapedTitles`'s doc
    // comment.
    if (!legacySlugs.has(m.title)) continue
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
    const goal = goalFromMilestones(milestones, slug)
    const f: MilestoneFacts = { goal, lifecycle }
    facts.set(slug, f)
    if (lifecycle === 'active') active.push({ slug, goal })
    else if (lifecycle === 'complete') archived.push({ slug, goal })
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
