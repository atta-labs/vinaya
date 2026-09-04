/**
 * The three implementations of edge resolution disagreed for months, and the
 * comment in each claimed they agreed. `apps/cli`'s two checks now share
 * `checks/edge-resolve.ts`; `packages/aeg-core/bin/verify-dispatch.ts` cannot
 * import from `apps/cli` and keeps its own. These tests pin the answers both
 * sides must give, so the next divergence fails here rather than in a gate that
 * blocks a task forever while its sibling reports READY.
 *
 * Every case below is a shape that actually occurred:
 *   - `#192` merged via PR `195` — the live edge on atta-labs/vinaya#197
 *   - `vinaya-milestone-model-v1 #192` — the slug-qualified form the grammar
 *     sanctions as a single literal token inside a labeled `Depends-on:`/
 *     `Conflicts-with:` field's own comma list (never synthesized from a
 *     separate span — Issue #347 removed that mechanism)
 *   - `#110` closed NOT_PLANNED — a real abandoned task Issue in this repo
 */

import { describe, expect, it } from 'bun:test'
import { clearEdgeCache, edgeFromIssueJson, resolveEdge } from '../../src/checks/edge-resolve'

const REPO = { owner: 'atta-labs', repo: 'vinaya' }
const NO_TASKS = new Map<string, { id: string; issue: number | null }>()
const NO_FACTS = new Map<string, { prState?: string }>()

const MERGED_VIA_PR = {
  state: 'CLOSED',
  stateReason: 'COMPLETED',
  closedByPullRequestsReferences: [{ number: 195 }]
}
const ABANDONED = { state: 'CLOSED', stateReason: 'NOT_PLANNED', closedByPullRequestsReferences: [] }
const STILL_OPEN = { state: 'OPEN', closedByPullRequestsReferences: [] }

describe('edge resolution — what counts as merged', () => {
  it('an Issue closed by a merged pull request is merged', () => {
    const e = edgeFromIssueJson(192, MERGED_VIA_PR)
    expect(e.merged).toBe(true)
    expect(e.issueState).toBe('closed')
    expect(e.stateReason).toBe('completed')
    expect(e.resolved).toBe(true)
  })

  it('an Issue closed NOT_PLANNED is NOT merged — abandoned work shipped nothing', () => {
    const e = edgeFromIssueJson(110, ABANDONED)
    expect(e.merged).toBe(false)
    expect(e.stateReason).toBe('not_planned')
  })

  it('closed with no closing pull request is not merged, whatever the reason says', () => {
    const e = edgeFromIssueJson(1, { state: 'CLOSED', stateReason: 'COMPLETED', closedByPullRequestsReferences: [] })
    expect(e.merged).toBe(false)
  })

  it('an open Issue is not merged', () => {
    expect(edgeFromIssueJson(193, STILL_OPEN).merged).toBe(false)
  })
})

describe('edge resolution — a conflict edge never reports in-flight from Issue state', () => {
  /**
   * `open` feeds `DispatchConflictsWithFact.openOrInFlight`, and
   * `verify-dispatch.ts` deliberately returns `false` for every cross-tranche
   * conflict: a conflict only matters while a PR is genuinely open, and no PR
   * has been observed here. Deriving it from Issue state would block a
   * cross-tranche conflict from Issue creation through merge, contradicting
   * `aeg-root/tranche-model.md`'s definition of the predicate.
   */
  it('is false for an open Issue', () => {
    expect(edgeFromIssueJson(193, STILL_OPEN).open).toBe(false)
  })

  it('is false for a closed one too', () => {
    expect(edgeFromIssueJson(192, MERGED_VIA_PR).open).toBe(false)
  })
})

describe('edge resolution — a failed lookup blocks, it never passes', () => {
  it('null json resolves to unmerged and unknown, so the gate refuses', () => {
    const e = edgeFromIssueJson(192, null)
    expect(e).toEqual({
      issue: 192,
      merged: false,
      open: false,
      issueState: null,
      stateReason: null,
      closedByActor: null,
      // `#NNN` is a recognized edge shape — the lookup itself failing (an
      // outage) is a different fact from the edge never matching anything at
      // all (#196): still `resolved: true`, same conservative `merged: false`.
      resolved: true
    })
  })

  it('an unrecognised state is not treated as either', () => {
    const e = edgeFromIssueJson(195, { state: 'MERGED', closedByPullRequestsReferences: [] })
    expect(e.merged).toBe(false)
    expect(e.issueState).toBeNull()
  })
})

describe('edge resolution — which edge shapes are recognised', () => {
  /**
   * The regression this file exists for. An anchored `^#(\d+)$` matches the
   * bare form and silently misses `<slug> #NNN`, which `verify-dispatch.ts`
   * resolves via its unanchored `/#(\d+)/`. That gap is invisible in review and
   * terminal in production.
   */
  it('recognises the slug-qualified #NNN form the grammar sanctions', async () => {
    clearEdgeCache()
    const bare = await resolveEdge('#999999999', NO_TASKS, NO_FACTS, REPO)
    const qualified = await resolveEdge('some-tranche #999999999', NO_TASKS, NO_FACTS, REPO)
    expect(qualified.issue).toBe(bare.issue)
    expect(qualified.issue).toBe(999999999)
  })

  /**
   * The #196 regression: `some-tranche 2` is the documented cross-tranche
   * form with a BARE task id (no `#`), the one row the pre-fix resolver
   * silently missed. `resolveSibling` is faked so this never hits the
   * network — it pins the resolution logic, not `deriveTrancheFromForge`.
   */
  it('resolves a slug-qualified bare task id via the sibling tranche', async () => {
    const fakeSibling = async (slug: string) =>
      slug === 'some-tranche'
        ? {
            tasks: new Map([['2', { id: '2', issue: 4242 }]]),
            facts: new Map([['2', { prState: 'merged' as const }]])
          }
        : null
    const e = await resolveEdge('some-tranche 2', NO_TASKS, NO_FACTS, REPO, fakeSibling)
    expect(e.issue).toBe(4242)
    expect(e.merged).toBe(true)
    expect(e.resolved).toBe(true)
  })

  it('reports UNRESOLVABLE (not unmerged) for an unknown slug', async () => {
    const fakeSibling = async () => null
    const e = await resolveEdge('unknown-tranche 2', NO_TASKS, NO_FACTS, REPO, fakeSibling)
    expect(e.resolved).toBe(false)
    expect(e.issue).toBeNull()
    expect(e.merged).toBe(false)
  })

  it('reports UNRESOLVABLE (not unmerged) for an unknown task id in a known slug', async () => {
    const fakeSibling = async () => ({ tasks: new Map(), facts: new Map() })
    const e = await resolveEdge('some-tranche 99', NO_TASKS, NO_FACTS, REPO, fakeSibling)
    expect(e.resolved).toBe(false)
    expect(e.issue).toBeNull()
    expect(e.merged).toBe(false)
  })

  it('prefers a same-tranche task id over an issue lookup', async () => {
    const tasks = new Map([['2', { id: '2', issue: 4242 }]])
    const facts = new Map([['2', { prState: 'merged' }]])
    const e = await resolveEdge('2', tasks, facts, REPO)
    expect(e.issue).toBe(4242)
    expect(e.merged).toBe(true)
    expect(e.resolved).toBe(true)
  })
})

describe('edge resolution — the cache is keyed by repository, not by number', () => {
  it('does not let one repo answer for another', async () => {
    clearEdgeCache()
    const a = await resolveEdge('#999999999', NO_TASKS, NO_FACTS, { owner: 'atta-labs', repo: 'vinaya' })
    const b = await resolveEdge('#999999999', NO_TASKS, NO_FACTS, { owner: 'other', repo: 'elsewhere' })
    // Both lookups fail (the Issue does not exist), so both are unresolved —
    // the point is that the second was attempted at all rather than served a
    // cached answer belonging to a different repository.
    expect(a.merged).toBe(false)
    expect(b.merged).toBe(false)
  })
})
