/**
 * edge-resolve.ts — one resolver for a dependency/conflict edge, shared by
 * every check that reads one.
 *
 * There were three copies of this logic — `check-dispatch-readiness.ts`,
 * `check-first-push-dispatch.ts`, and `packages/aeg-core/bin/verify-dispatch.ts`
 * — and they disagreed. The first two hardcoded `merged: false` for any
 * cross-tranche `#NNN` edge while the third resolved it, so `verify-dispatch`
 * reported READY while the blocking CI gate refused, permanently, for any task
 * carrying a cross-tranche dependency. A comment in each of the first two
 * claimed parity with the third.
 *
 * This module is the one implementation the two CLI checks now share. It does
 * not remove the third: `verify-dispatch.ts` lives in `@attalabs/aeg-core`'s
 * `bin/` and cannot import from `apps/cli`. `checks/edge-parity.test.ts` holds
 * them to the same answers instead, so a future divergence fails a test rather
 * than being found in production months later.
 */

import { execFileSync } from 'node:child_process'
import { deriveTrancheFromForge, fetchForgeFacts, splitSlugQualifiedEdge } from '@attalabs/aeg-forge-state'

export type ResolvedEdge = {
  issue: number | null
  merged: boolean
  open: boolean
  issueState: 'open' | 'closed' | null
  stateReason: 'completed' | 'not_planned' | null
  closedByActor: string | null
  /**
   * `false` only when this edge matched no known shape at all — not a
   * same-tranche task id, nothing containing `#NNN`, and (for a
   * slug-qualified edge) either the slug or the task id doesn't resolve on
   * the forge. Distinct from every other field staying at its unmerged/
   * not-open default, which also covers a resolvable edge whose target
   * lookup itself failed (an outage) — that case is `resolved: true`.
   */
  resolved: boolean
}

export type EdgeTaskRef = { id: string; issue: number | null }

export type EdgeFactsSubset = {
  prState?: string
  issueState?: 'open' | 'closed' | null
  stateReason?: 'completed' | 'not_planned' | null
  closedByActor?: string | null
}

export type EdgeRepo = { owner: string; repo: string }

/**
 * Unanchored, deliberately: `verify-dispatch.ts`'s `directIssueNumFromEdge`
 * uses `/#(\d+)/` and its docstring says it matches "a prose cell containing
 * `#NNN`". An anchored `^#(\d+)$` looks equivalent and is not — it misses the
 * slug-qualified form `<slug> #NNN`, which the edge grammar sanctions
 * (`SLUG_QUALIFIED_ID` in `@attalabs/aeg-forge-state`, whose own example is
 * `aeg-governance-hardening #NNN`) and which a labeled `Depends-on:`/
 * `Conflicts-with:` field's own comma list carries as a single literal
 * token — `parseRationaleDeps` never synthesizes it from a separate span
 * (a real fix removed that mechanism; only a labeled field's own
 * comma-separated, id-shaped tokens are read at all). Anchoring here
 * reintroduced the exact divergence this module exists to remove, in the
 * more common form.
 */
const DIRECT_ISSUE_REF = /#(\d+)/

type IssueStateJson = {
  state?: string
  stateReason?: string
  closedByPullRequestsReferences?: Array<{ number?: number }>
}

/** Keyed by `owner/repo#number`, not by number. A bare number is only unique
 * within one repository, and a cache that assumes otherwise is a trap waiting
 * for the first caller that evaluates two. */
const issueCache = new Map<string, IssueStateJson | null>()

/**
 * One `gh issue view` for the three facts the gate actually needs. `--json
 * state` alone is the weakest available answer: `stateReason` and
 * `closedByPullRequestsReferences` come from the identical call, and the second
 * is the real "this landed" fact.
 *
 * Returns `null` on any failure — missing auth, network, rate limit, malformed
 * JSON, `gh` absent. The caller treats `null` as unresolved, so an outage
 * blocks rather than passing. That is what the original conservative default
 * was for; it was only ever wrong for the case where the answer was one query
 * away.
 */
function fetchIssueState(num: number, repo: EdgeRepo): IssueStateJson | null {
  const key = `${repo.owner}/${repo.repo}#${num}`
  if (issueCache.has(key)) return issueCache.get(key) ?? null
  let out: IssueStateJson | null = null
  try {
    const raw = execFileSync(
      'gh',
      [
        'issue',
        'view',
        String(num),
        '-R',
        `${repo.owner}/${repo.repo}`,
        '--json',
        'state,stateReason,closedByPullRequestsReferences'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    out = JSON.parse(raw) as IssueStateJson
  } catch {
    out = null
  }
  issueCache.set(key, out)
  return out
}

/** One sibling tranche's tasks + forge facts — everything a slug-qualified
 * edge (`<slug> <n>`) needs to resolve the same way a same-tranche edge
 * resolves. */
export type SiblingTranche = { tasks: Map<string, EdgeTaskRef>; facts: Map<string, EdgeFactsSubset> }

/** Injectable so tests can fake a sibling tranche without a real forge call.
 * `null` means the slug does not resolve on the forge at all. The default
 * impl reuses `deriveTrancheFromForge`/`fetchForgeFacts` — the same
 * primitives `check-dispatch-readiness.ts` already calls for its own
 * tranche, not a second forge-read path. */
export type SiblingTrancheResolver = (slug: string, repo: EdgeRepo) => Promise<SiblingTranche | null>

const defaultResolveSiblingTranche: SiblingTrancheResolver = async (slug, repo) => {
  let tranche: Awaited<ReturnType<typeof deriveTrancheFromForge>>
  try {
    tranche = await deriveTrancheFromForge(repo.owner, repo.repo, slug)
  } catch {
    return null
  }
  const taskRefs = tranche.tasks.map((t) => ({ id: t.id, issue: t.issue }))
  const snapshot = await fetchForgeFacts({ owner: repo.owner, repo: repo.repo, tranche: slug, tasks: taskRefs })
  return {
    tasks: new Map(tranche.tasks.map((t) => [t.id, { id: t.id, issue: t.issue }])),
    facts: snapshot.facts
  }
}

/** Keyed by `owner/repo:slug` — mirrors `issueCache`'s repo-scoping reasoning. */
const siblingTrancheCache = new Map<string, SiblingTranche | null>()

/** Test seam — the parity test drives real fixtures through the pure half. */
export function clearEdgeCache(): void {
  issueCache.clear()
  siblingTrancheCache.clear()
}

/**
 * The pure half: given the JSON `gh` returned, what is true of this edge.
 *
 * `merged` requires a merged pull request to have closed the Issue, not merely
 * that the Issue is closed. An Issue closed `NOT_PLANNED` was abandoned and
 * shipped nothing; treating it as merged would let it satisfy a dependency gate
 * and would route around `dispatch-gate.ts`'s `isHandClosedByRecognizedPrincipal`,
 * the conjunctive guard built to refuse exactly that. This repo's own derivation
 * already draws the line the same way — `derive-tranche.ts` maps `NOT_PLANNED`
 * to *dropped (legitimately abandoned)*.
 *
 * `open` is always `false` on this path. It feeds `DispatchConflictsWithFact`'s
 * `openOrInFlight`, and a conflict only matters while a PR is genuinely open —
 * `verify-dispatch.ts` returns `false` here for that stated reason. Deriving it
 * from Issue state instead would block a cross-tranche conflict from Issue
 * creation through merge, which contradicts `aeg-root/tranche-model.md`'s
 * definition of the conflicts predicate.
 *
 * `closedByActor` stays `null`: the closing actor is not in this response, so
 * the hand-closed-by-a-Principal path cannot fire for a cross-tranche edge.
 * Conservative, and correct — that path exists for a Principal closing an Issue
 * in the tranche being dispatched.
 */
export function edgeFromIssueJson(num: number, json: IssueStateJson | null): ResolvedEdge {
  if (json === null) {
    return {
      issue: num,
      merged: false,
      open: false,
      issueState: null,
      stateReason: null,
      closedByActor: null,
      resolved: true
    }
  }
  const state = json.state === 'CLOSED' ? 'closed' : json.state === 'OPEN' ? 'open' : null
  const reason =
    json.stateReason === 'COMPLETED' ? 'completed' : json.stateReason === 'NOT_PLANNED' ? 'not_planned' : null
  const closedByMergedPr = (json.closedByPullRequestsReferences ?? []).length > 0
  return {
    issue: num,
    merged: state === 'closed' && closedByMergedPr,
    open: false,
    issueState: state,
    stateReason: reason,
    closedByActor: null,
    resolved: true
  }
}

/**
 * Resolve one edge: a same-tranche task id from already-fetched facts, a
 * `#NNN` reference by looking the Issue up, or a slug-qualified bare task id
 * (`<slug> <n>`) by looking the sibling tranche up — the same
 * `SLUG_QUALIFIED_ID` form `@attalabs/aeg-forge-state`'s grammar sanctions
 * and `packages/aeg-core/bin/verify-dispatch.ts`'s resolver already handles.
 */
export async function resolveEdge(
  id: string,
  taskById: Map<string, EdgeTaskRef>,
  factsByTaskId: Map<string, EdgeFactsSubset>,
  repo: EdgeRepo,
  resolveSibling: SiblingTrancheResolver = defaultResolveSiblingTranche
): Promise<ResolvedEdge> {
  const target = taskById.get(id)
  if (target) {
    const facts = target.issue !== null ? factsByTaskId.get(target.id) : undefined
    return {
      issue: target.issue,
      merged: facts?.prState === 'merged',
      open: facts?.prState === 'open',
      issueState: facts?.issueState ?? null,
      stateReason: facts?.stateReason ?? null,
      closedByActor: facts?.closedByActor ?? null,
      resolved: true
    }
  }
  const direct = id.match(DIRECT_ISSUE_REF)
  if (direct) {
    const num = Number(direct[1])
    return edgeFromIssueJson(num, fetchIssueState(num, repo))
  }
  const qualified = splitSlugQualifiedEdge(id)
  if (qualified) {
    const cacheKey = `${repo.owner}/${repo.repo}:${qualified.slug}`
    let sibling = siblingTrancheCache.get(cacheKey)
    if (sibling === undefined) {
      sibling = await resolveSibling(qualified.slug, repo)
      siblingTrancheCache.set(cacheKey, sibling)
    }
    const siblingTask = sibling?.tasks.get(qualified.bareId)
    if (sibling && siblingTask) {
      const facts = siblingTask.issue !== null ? sibling.facts.get(siblingTask.id) : undefined
      return {
        issue: siblingTask.issue,
        merged: facts?.prState === 'merged',
        open: facts?.prState === 'open',
        issueState: facts?.issueState ?? null,
        stateReason: facts?.stateReason ?? null,
        closedByActor: facts?.closedByActor ?? null,
        resolved: true
      }
    }
  }
  // Neither a same-tranche task id, anything containing a `#NNN` reference,
  // nor a slug-qualified edge whose slug AND task both resolve on the forge.
  // Genuinely unresolvable with this toolset — the one case where the
  // conservative default is the honest answer rather than a missing query.
  return {
    issue: null,
    merged: false,
    open: false,
    issueState: null,
    stateReason: null,
    closedByActor: null,
    resolved: false
  }
}
