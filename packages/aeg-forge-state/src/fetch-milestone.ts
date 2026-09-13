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
 * The intents heading's own section body — from just after `### Tranche
 * intents` to the next heading or end of text — or `null` when there is no
 * such heading at all. Shared by every intents reader below so the
 * section-slicing logic exists exactly once in this file.
 */
function intentsSection(text: string): string | null {
  const start = text.match(INTENTS_HEADING)
  if (!start || start.index === undefined) return null
  const rest = text.slice(start.index + start[0].length)
  const next = rest.match(NEXT_HEADING)
  return rest.slice(0, next && next.index !== undefined ? next.index : rest.length)
}

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
  const section = intentsSection(text)
  if (section === null) return ''

  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const m = trimmed.match(INTENT_BULLET)
    if (m && (m[1] ?? '').toLowerCase() === slug.toLowerCase()) return (m[2] ?? '').trim()
  }
  return ''
}

export type MilestoneIntentLine = { slug: string; goal: string }

/**
 * Every `- <slug>: <goal>` bullet a Milestone's `### Tranche intents` section
 * declares, in source order (`vinaya milestone status`) — the enumeration
 * `intentGoalForSlug`'s reverse, per-slug lookup cannot answer on its own
 * (it needs the slug already; this needs none). Shares `intentsSection` and
 * `INTENT_BULLET` with `intentGoalForSlug` rather than re-deriving the
 * section, so this is one parser read two ways, not a second one. A line
 * that doesn't match the bullet grammar is silently skipped — the same
 * permissiveness `intentGoalForSlug` already has (a malformed line simply
 * never matches any slug there either); rejecting a genuinely malformed body
 * is `checkMilestoneShape`'s job at write time, not this read-side reader's.
 */
export function intentLines(description: string): MilestoneIntentLine[] {
  const text = stripCode(description, { inlineSpans: 'keep' })
  const section = intentsSection(text)
  if (section === null) return []

  const lines: MilestoneIntentLine[] = []
  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const m = trimmed.match(INTENT_BULLET)
    if (m) lines.push({ slug: (m[1] ?? '').toLowerCase(), goal: (m[2] ?? '').trim() })
  }
  return lines
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
  number: number
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
 * way — a real population of open and closed Milestones (across this repo
 * and attalabs) predates the label model and depends on this never changing
 * underneath them. The rule does not depend on how many; it holds for any
 * count. `matchesLegacyMilestone` is the one predicate every reader below
 * shares, so "is this slug legacy" can never drift between them.
 */
function matchesLegacyMilestone(milestones: GhMilestone[], slug: string): GhMilestone | null {
  return milestones.find((m) => m.title === slug) ?? null
}

/**
 * Lowercase, digits, and hyphens, ending in a `-v<N>` version suffix — every
 * one of this repo's real legacy-titled Milestones is shaped exactly this
 * way (`vinaya-milestone-model-v1`, `vinaya-selfgov-v1`, `aeg-seam-hardening-v1`,
 * …; confirmed live against this repo's real Milestones, round 4 of code
 * review), with no exception. This
 * is deliberately tighter than "any kebab-case string": an earlier version
 * of this guard accepted any lowercase, hyphenated title, which still
 * phantom-matched a plausible Architect product-goal title like
 * `improve-onboarding-flow` (round 3 finding) — the `-v<N>` suffix is a
 * narrower, still-real-data-precedented signal a free-text title is
 * unlikely to end with by accident. `open_issues`/`closed_issues` (also
 * present on the Milestone API response) was considered and rejected as a
 * stronger signal: a legacy-titled Milestone's tasks are label-tracked, not
 * milestone-attached, so its native Issue counts can legitimately read zero
 * while the tranche itself is still active (confirmed live against
 * `vinaya-milestone-model-v1` while it was that tranche's active Milestone —
 * since closed, but the underlying fact does not depend on any one
 * Milestone's current state) — gating on that count would misclassify a
 * real, currently-active tranche as inactive.
 *
 * Residual, knowingly accepted gap: an Architect who deliberately titles a
 * product-goal Milestone to end in `-v<N>` still slips through. No
 * shape-only heuristic can fully close this without cross-referencing real
 * forge state per candidate (an extra fetch per Milestone, out of this
 * task's surface) — the same class of trade-off `tranche-model.md` §5
 * already documents openly for conflict detection: shape catches the
 * overwhelmingly common case; a deliberately adversarial title is not
 * defended against.
 */
const TRANCHE_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*-v\d+$/

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

/**
 * Module contract: a new reader of a legacy-titled Milestone goes through
 * `resolveLegacyFacts`, never this function directly — correct derivation
 * for the live closed-legacy tranches whose real Issues moved under `adopt`
 * depends on that routing (see `resolveLegacyFacts`'s doc comment), and the
 * async index path bypassed the predicate entirely once before.
 */
function factsFromLegacyMilestone(milestone: GhMilestone): MilestoneFacts {
  return {
    goal: milestone.description ?? '',
    lifecycle: milestone.state === 'closed' ? 'complete' : 'active'
  }
}

/**
 * `matchesLegacyMilestone`'s "kept forever, no exception" title match was
 * written for a Milestone that never changes underneath a slug — true for
 * every pre-migration Milestone, false the moment `vinaya milestone adopt`
 * exists. `adopt` closes the old 1:1 Milestone (never deletes it — the
 * retired-Milestone provenance is deliberate) and reattaches that slug's
 * real Issues to a different, still-open Milestone. The old Milestone still
 * legacy-matches by title, is still closed, and `factsFromLegacyMilestone`
 * still reads that as `complete` forever — even though the tranche's real
 * work is active somewhere else. Measured live on `vinaya-agentic-interface-v1`:
 * Milestone #7 (legacy title match) closed, 0 native issues; the label's
 * real Issues (#150–152, two open) live under Milestone #13 "Flows become
 * files" — every reader using the legacy path alone reported the tranche
 * `complete` with zero active tranches left in the whole repo.
 *
 * `labelIssues` — this slug's own `vinaya/tranche:<slug>`-labeled Issues,
 * fetched regardless of legacy status now — is the tiebreak, but ONLY when
 * the Milestone is `closed`. `adopt` is the only real-world path that
 * produces a non-empty label population under a legacy title match, and
 * `adopt` always closes the Milestone it retires — an open legacy Milestone
 * with label Issues attached is not a state this system's own write path
 * produces today. Gating on `closed` matters for real: an open legacy
 * Milestone already reads `active` correctly via its own `state`
 * (`factsFromLegacyMilestone`), and if its label Issues happened to be
 * empty or all-closed (stray manual labeling, a partial migration), an
 * ungated override would wrongly flip a genuinely active tranche to
 * `complete` — the exact class of bug this function exists to fix, in the
 * opposite direction. An empty label set on a CLOSED Milestone means
 * genuinely nothing lives under the label — either a pre-label-model
 * historical tranche (the original ~57 Milestones this function was written
 * for) or a legacy Milestone nobody has adopted away from — and the
 * Milestone's own `state` is still the right, and only available, answer.
 */
function resolveLegacyFacts(milestone: GhMilestone, labelIssues: GhIssue[]): MilestoneFacts {
  if (milestone.state === 'closed' && labelIssues.length > 0) {
    return { goal: milestone.description ?? '', lifecycle: lifecycleFromIssues(labelIssues) }
  }
  return factsFromLegacyMilestone(milestone)
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
  const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
  if (legacy) return resolveLegacyFacts(legacy, issues)

  return { goal: goalFromMilestones(milestones, slug), lifecycle: lifecycleFromIssues(issues) }
}

/** The `gh`-resolvable identity of a Milestone: `--milestone` accepts a TITLE, never a number or a slug. */
export type MilestoneAttachTarget = { number: number; title: string }

/**
 * The OPEN Milestone a new task Issue's `--milestone` flag should name.
 * `gh issue create --milestone <value>` resolves `<value>` by TITLE — a
 * tranche's SLUG is only ever a valid title in the legacy 1:1 regime
 * (Milestone titled exactly the slug). Once a Milestone can hold several
 * tranches via `### Tranche intents` (vinaya-milestone-model-v1), the slug
 * is not a title at all, and handing `gh` the slug for an intent-declared
 * tranche fails outright (a Milestone with that exact title does not exist).
 *
 * Two candidates, legacy first (kept forever, per `matchesLegacyMilestone`'s
 * own contract): the exact-slug-titled Milestone, if it is still open —
 * attach there. A CLOSED legacy Milestone is never itself a valid target,
 * but it must NOT short-circuit the search: `vinaya milestone adopt`
 * (`milestone-model.md` §4) closes the old 1:1 Milestone and reattaches the
 * slug's real Issues to a different, still-open, intent-declaring Milestone
 * — the exact live shape this repo runs. Falling through to the intent
 * search on a closed legacy match is required, not optional, or every
 * adopted tranche gets no auto-attach ever, forever, which is the very gap
 * this function exists to close. Otherwise (no legacy match, or a closed
 * one): the first OPEN Milestone whose description declares this slug's
 * intent line — first in list order, a deterministic tie-break when more
 * than one somehow declares the same slug (`gh`'s own stable milestone
 * ordering; a genuine collision is a data problem this function does not
 * try to arbitrate). `null` when nothing matches at all: no open Milestone
 * owns this slug yet, which is not an error — a tranche's first Issue may
 * legitimately precede its own Milestone.
 */
export function resolveMilestoneAttachTarget(milestones: GhMilestone[], slug: string): MilestoneAttachTarget | null {
  const legacy = matchesLegacyMilestone(milestones, slug)
  if (legacy?.state === 'open') return { number: legacy.number, title: legacy.title }

  const intentMatch = milestones.find((m) => m.state === 'open' && intentGoalForSlug(m.description ?? '', slug) !== '')
  return intentMatch ? { number: intentMatch.number, title: intentMatch.title } : null
}

/** Forge-fetching sibling of `resolveMilestoneAttachTarget` — the injected-lookup boundary callers wire in. */
export function findMilestoneAttachTargetForSlug(
  owner: string,
  repo: string,
  slug: string
): MilestoneAttachTarget | null {
  const milestones = ghApiGet<GhMilestone[]>(`repos/${owner}/${repo}/milestones?state=all&per_page=100`)
  return resolveMilestoneAttachTarget(milestones, slug)
}

/** True when argv already carries an explicit `--milestone`/`-m` flag — the caller's choice always wins over auto-attach. */
export function hasExplicitMilestoneFlag(args: string[]): boolean {
  return args.some((a) => a === '--milestone' || a === '-m' || a.startsWith('--milestone='))
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
    const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
    if (legacy) {
      const facts = resolveLegacyFacts(legacy, issues)
      if (facts.lifecycle === 'active') active.push({ slug, goal: facts.goal })
      continue
    }
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
    const issues = ghIssueListByLabel(owner, repo, trancheLabel(slug))
    if (legacy) {
      const facts = resolveLegacyFacts(legacy, issues)
      if (facts.lifecycle === 'complete') archived.push({ slug, goal: facts.goal })
      continue
    }
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
 * `ghApiGet` they always used). Both legacy AND label-derived slugs need
 * their own Issues fetch now — see `resolveLegacyFacts`'s doc comment for
 * why a legacy slug is no longer free: `vinaya milestone adopt` closes the
 * old 1:1 Milestone without deleting it, so its title still legacy-matches
 * while the tranche's real Issues move to a different, still-open Milestone.
 * All fetches run concurrently (`Promise.all`), not one after another — the
 * same discipline `verify-coherence.ts`'s sweep already applies to its own
 * per-slug fetches.
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
  const legacyMilestoneBySlug = new Map<string, GhMilestone>(
    milestones.filter((m) => legacySlugs.has(m.title)).map((m) => [m.title, m])
  )

  const newPathSlugs = trancheSlugsFromLabels(labels).filter((slug) => !legacySlugs.has(slug))
  const uniqueNewPathSlugs = [...new Set(newPathSlugs)]

  const uniqueLegacySlugs = [...legacySlugs]
  const [legacyIssuesBySlug, newPathIssuesBySlug] = await Promise.all([
    Promise.all(uniqueLegacySlugs.map((slug) => ghIssueListByLabelAsync(owner, repo, trancheLabel(slug)))),
    Promise.all(uniqueNewPathSlugs.map((slug) => ghIssueListByLabelAsync(owner, repo, trancheLabel(slug))))
  ])

  uniqueLegacySlugs.forEach((slug, i) => {
    const m = legacyMilestoneBySlug.get(slug)
    if (!m) return
    const ref = { slug, goal: m.description ?? '' }
    const f = resolveLegacyFacts(m, legacyIssuesBySlug[i] ?? [])
    if (f.lifecycle === 'complete') archived.push(ref)
    else if (f.lifecycle === 'active') active.push(ref)
    facts.set(slug, f)
  })
  uniqueNewPathSlugs.forEach((slug, i) => {
    const issues = newPathIssuesBySlug[i] ?? []
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

/**
 * Every distinct tranche (`vinaya/tranche:*` label) among the Issues
 * attached to one Milestone, by its native number — the fact `dispatch-gate`
 * needs to know whether a bare `Depends-on`/`Conflicts-with` edge id on an
 * Issue in this Milestone is genuinely ambiguous (issue-545, O3): a Milestone
 * holding two or more tranches means the same bare id could belong to
 * either, where a Milestone holding only one (the ordinary case) leaves no
 * real ambiguity. `state=all` — a closed sibling task still counts toward
 * "this Milestone holds N tranches" exactly as an open one does; the tranche
 * count is a structural fact about the Milestone, not about which of its
 * Issues remain open.
 *
 * Labels only, paginated: a Milestone's Issue count is
 * unbounded, and this predicate needs nothing off an Issue but its labels —
 * fetching the REST default (full issue, including `body`) through
 * `ghApiGetAllPagesAsync`'s own `-q` server-side filter means the buffered
 * call only ever has to hold one page's worth of `{labels}` objects, never
 * one page's worth of full issue bodies (found live against this repo's own
 * Milestone #15, 80+ Issues with full bodies: the old single, unpaginated,
 * un-filtered `ghApiGet` fetch overran `execFileSync`'s default output
 * buffer, `ENOBUFS`, before this predicate ever ran). Raising the buffer
 * size would not have fixed this — a Milestone can always grow past
 * whatever ceiling was picked; only fetching less per Issue scales.
 */
export async function tranchesAttachedToMilestone(
  owner: string,
  repo: string,
  milestoneNumber: number
): Promise<string[]> {
  const issues = await ghApiGetAllPagesAsync<{ labels: Array<{ name: string } | string> }>(
    `repos/${owner}/${repo}/issues?milestone=${milestoneNumber}&state=all`,
    { jq: '[.[] | {labels: .labels}]' }
  )
  const slugs = new Set<string>()
  for (const issue of issues) {
    for (const label of issue.labels) {
      const name = typeof label === 'string' ? label : label.name
      const slug = trancheSlugOf(name)
      if (slug !== null) slugs.add(slug)
    }
  }
  return [...slugs]
}
