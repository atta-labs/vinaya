/**
 * state-machine-model.ts — the canonical, code-owned model of AEG's execution
 * state machine: what it reads, what it can conclude, and the ordered rules
 * that get from one to the other. Pure data, zero I/O — the same discipline as
 * `actions.ts` and `waiver-label.ts` (one pure-data list, read by both
 * the logic and the rendered docs, so the two can never drift). Its only
 * non-type import is `label()` from the sibling pure-data label vocabulary
 * (`@attalabs/aeg-forge-state`'s `labels.ts`), so the label names this model quotes
 * cannot drift from the ones the mechanism actually matches.
 *
 * Three parts, in the order a reader needs them:
 *
 *   1. `FORGE_FACT_INPUTS` — every `ForgeFacts` field and the GitHub object it
 *      is read from. The inputs are the whole source of truth: status is
 * *derived* from forge objects, never written down. Descriptive
 *      only — the mapping itself is performed by `map-forge-facts.ts`.
 *   2. `DERIVED_STATUSES` — the statuses derivation can conclude.
 *   3. `DERIVATION_RULES` — the ordered rule list, first match wins.
 *
 * **Order is load-bearing, not incidental.** `blocked` must win over every
 * other conclusion; the reopened-after-merge rules must precede the plain
 * `merged` rule or a reopened Issue would permanently read `merged` off a
 * stale fact; the closed-Issue rules (`closed-not-planned`, `closed-without-
 * merge`) must precede `branch-exists`/`issue-open` — neither of those two
 * checks `issueState`, so a closed Issue whose task branch was never cleaned
 * up used to be swallowed by `branch-exists` and read as permanently
 * `in-flight` instead of `dropped`/`incoherent` (issue-545, O6). `deriveStatus`
 * (`derive-tranche.ts`) executes this list verbatim, so reordering entries
 * here changes real status everywhere — every gate, the Studio, and the CLI
 * read their status through it.
 *
 * **Deliberately not imported here: the label vocabulary.** Derivation works
 * on `ForgeFacts` — booleans and enums — never on label *strings*; the one
 * label that matters arrives pre-read as the `blockedLabel` fact. Importing
 * `@attalabs/aeg-forge-state` for its `LABELS` would also drag that package's
 * `node:child_process` into any browser bundle rendering this model, the same
 * hazard `diagram-model.ts` documents for `ACTIONS`. Label names live in
 * `@attalabs/aeg-forge-state`'s `labels.ts`; this module names them only in prose.
 */

import { label } from '@attalabs/aeg-forge-state'
import type { ForgeFacts } from '@attalabs/aeg-types'
import type { DerivedStatus } from './types'

// ---------- 1. Inputs ----------

export type ForgeFactInput = {
  /** The `ForgeFacts` field, as the deriver sees it. */
  fact: keyof ForgeFacts
  /** The GitHub object and field it is read from, before mapping. */
  readsFrom: string
  /** What the fact means to derivation. */
  meaning: string
}

/**
 * One entry per `ForgeFacts` field. `closedAt` / `mergedAt` are carried for
 * the coherence oracle rather than for status, and are marked as such — they
 * are inputs to the model's world, but no derivation rule reads them.
 */
export const FORGE_FACT_INPUTS: ForgeFactInput[] = [
  {
    fact: 'issueState',
    readsFrom: 'Issue.state (OPEN | CLOSED)',
    meaning: 'Whether the task Issue is still open — the anchor for the honest terminal statuses.'
  },
  {
    fact: 'assigned',
    readsFrom: 'Issue.assignees (count > 0)',
    meaning: 'An assignee exists. No longer affects derivation: assigned and unassigned are both todo.'
  },
  {
    fact: 'branchExists',
    readsFrom: 'Ref refs/heads/task/<tranche>/<id>',
    meaning: 'A task branch has been published — the todo → in-flight transition, written by git push, not by hand.'
  },
  {
    fact: 'prState',
    readsFrom: 'PullRequest.state (OPEN | CLOSED | MERGED)',
    meaning: 'Whether work is proposed or landed. CLOSED-without-merge collapses to none — AEG models open/merged/none.'
  },
  {
    fact: 'reviewDecision',
    readsFrom: 'PullRequest.reviewDecision',
    meaning: "Only 'changes_requested' flips status; approved-but-unmerged stays in-review."
  },
  {
    fact: 'blockedLabel',
    readsFrom: `Issue.labels contains '${label('blocked')}'`,
    meaning: 'Execution halted pending an external unblock. Wins over every other rule.'
  },
  {
    fact: 'stateReason',
    readsFrom: 'Issue.stateReason (COMPLETED | NOT_PLANNED | REOPENED | null)',
    meaning: 'Separates a legitimate drop from an incoherent close on a closed, never-merged Issue.'
  },
  {
    fact: 'closedAt',
    readsFrom: 'Issue.closedAt',
    meaning: 'Timestamp for the coherence oracle grandfather cutoff. No derivation rule reads it.'
  },
  {
    fact: 'mergedAt',
    readsFrom: 'PullRequest.mergedAt',
    meaning: 'Timestamp for the coherence oracle grandfather cutoff. No derivation rule reads it.'
  },
  {
    fact: 'closedByActor',
    readsFrom: 'ClosedEvent.actor.login (most recent timeline CLOSED_EVENT)',
    meaning:
      'GitHub login that hand-closed the Issue. No task-status derivation rule reads it — it is consumed by dispatch-gate.ts/coherence-checks.ts A1 to recognize a hand-closed dependency as resolved (task vinaya-engine-v1 21, #99), not by this status model.'
  }
]

// ---------- 2. Statuses ----------

/**
 * Every value `DerivedStatus` admits. `backlog` is a project-level concept and
 * is never emitted by derivation inside a tranche — tranche tasks
 * are committed work, so their floor is `todo`. It stays in the set because
 * the type still admits it and consumers still render it.
 */
export const DERIVED_STATUSES: DerivedStatus[] = [
  'backlog',
  'todo',
  'in-flight',
  'in-review',
  'changes-requested',
  'merged',
  'blocked',
  'dropped',
  'incoherent'
]

/** The statuses derivation can actually conclude — every value except `backlog`. */
export const DERIVABLE_STATUSES: DerivedStatus[] = DERIVED_STATUSES.filter((s) => s !== 'backlog')

// ---------- 3. Rules ----------

export type DerivationRule = {
  /** Stable identifier — safe to cite from docs and tests. */
  id: string
  /**
   * Which step of the canonical chain this rule implements. Two steps branch
   * on a second fact and are expressed as an adjacent pair of rules sharing a
   * step number, so that every rule stays a flat predicate → status pair
   * rather than a status-returning function.
   */
  chainStep: number
  /** The condition in prose, for rendered docs. */
  when: string
  /** The condition in code. First rule to match decides the status. */
  matches: (facts: ForgeFacts | undefined) => boolean
  /** The status this rule concludes. */
  status: DerivedStatus
  /** Why the rule sits at this position — the part reordering would destroy. */
  why: string
}

/**
 * The ordered chain. First match wins. No single rule here is unconditional
 * any more (issue-545, O6 narrowed `closed-without-merge`'s predicate to
 * `issueState === 'closed'` so it could move ahead of `branch-exists`/
 * `issue-open` without swallowing every open Issue too) — totality is
 * guaranteed one level up, by `deriveStatusFromModel`'s own trailing
 * fallback, not by a catch-all entry in this list.
 *
 * Every predicate is written to be safe against `undefined` facts even though
 * only the first rule can observe that case — the guard is structural, so
 * adding a rule above the others can never turn into a null dereference.
 */
export const DERIVATION_RULES: DerivationRule[] = [
  {
    id: 'no-facts',
    chainStep: 1,
    when: 'No forge facts for this task',
    matches: (facts) => !facts,
    status: 'todo',
    why: 'A task absent from the forge snapshot is committed work not yet started — never backlog, inside a tranche.'
  },
  {
    id: 'blocked-label',
    chainStep: 2,
    when: 'The blocked label is present',
    matches: (facts) => facts?.blockedLabel === true,
    status: 'blocked',
    why: 'Blocked wins over every other conclusion — a halted task must not read as progressing, whatever its branch or PR says.'
  },
  {
    id: 'reopened-after-merge-with-branch',
    chainStep: 3,
    when: 'Issue is open, a PR already merged, and a task branch exists',
    matches: (facts) => facts?.issueState === 'open' && facts.prState === 'merged' && facts.branchExists,
    status: 'in-flight',
    why: 'Must precede the plain merged rule: the Issue reopened and new work is already published, so the historical merge is stale.'
  },
  {
    id: 'reopened-after-merge-no-branch',
    chainStep: 3,
    when: 'Issue is open and a PR already merged, but no task branch exists',
    matches: (facts) => facts?.issueState === 'open' && facts.prState === 'merged',
    status: 'todo',
    why: 'Same reopen case, work not restarted. Without it a reopened Issue would read merged forever — GitHub never retracts merge history.'
  },
  {
    id: 'pr-merged',
    chainStep: 4,
    when: 'A PR for this task is merged',
    matches: (facts) => facts?.prState === 'merged',
    status: 'merged',
    why: 'The terminal success state. Reached only once the reopen exceptions above have declined the facts.'
  },
  {
    id: 'pr-open-changes-requested',
    chainStep: 5,
    when: 'A PR is open and review requested changes',
    matches: (facts) => facts?.prState === 'open' && facts.reviewDecision === 'changes_requested',
    status: 'changes-requested',
    why: 'Must precede the plain open-PR rule, which would otherwise swallow it as in-review and hide that the ball is back with the Developer.'
  },
  {
    id: 'pr-open',
    chainStep: 5,
    when: 'A PR is open',
    matches: (facts) => facts?.prState === 'open',
    status: 'in-review',
    why: 'Opening the PR is itself the in-flight → in-review transition; no status is ever written to record it.'
  },
  {
    id: 'closed-not-planned',
    chainStep: 6,
    when: 'Issue closed NOT_PLANNED, with no merged PR',
    matches: (facts) => facts?.issueState === 'closed' && facts.stateReason === 'not_planned',
    status: 'dropped',
    why: 'A legitimately abandoned task. Must precede branch-exists/issue-open (issue-545, O6): neither checks issueState, so a closed NOT_PLANNED Issue whose task branch was never cleaned up used to be swallowed by branch-exists and read as in-flight forever.'
  },
  {
    id: 'closed-without-merge',
    chainStep: 6,
    when: 'Issue closed for any other reason, with no merged PR',
    matches: (facts) => facts?.issueState === 'closed',
    status: 'incoherent',
    why: "The honest terminal case for a closed, unprovable Issue. Same ordering fix as closed-not-planned (issue-545, O6) and for the identical reason: must precede branch-exists/issue-open or a closed Issue with a lingering branch read as in-flight instead. No longer the list’s unconditional catch-all — `deriveStatusFromModel`’s own trailing fallback (below) is what keeps the function total now that this predicate is scoped to `issueState === 'closed'`."
  },
  {
    id: 'branch-exists',
    chainStep: 7,
    when: 'A task branch exists, with no PR',
    matches: (facts) => facts?.branchExists === true,
    status: 'in-flight',
    why: "Publishing the branch is the todo → in-flight transition. Below the PR rules (a PR is the stronger signal) and below the closed-Issue rules (issue-545, O6) — every fact set reaching this rule already has issueState === 'open'."
  },
  {
    id: 'issue-open',
    chainStep: 8,
    when: 'The Issue is open, with no branch and no PR',
    matches: (facts) => facts?.issueState === 'open',
    status: 'todo',
    why: 'Not started. Assigned or not, both are todo inside a tranche.'
  }
]

/**
 * Execute the model: the first rule whose predicate matches decides the
 * status. `deriveStatus` in `derive-tranche.ts` delegates here, so the
 * rendered rules and the real derivation are the same list — the whole point
 * of the discipline.
 *
 * The trailing `return 'incoherent'` is this function's own totality
 * guarantee (issue-545, O6): no rule in `DERIVATION_RULES` is unconditional
 * any more, so the type checker cannot see the list as exhaustive, and in
 * practice every real `ForgeFacts` (`issueState` is always `'open'` or
 * `'closed'`) is fully covered by the rules above it — this line exists for
 * the type checker and as a defensive floor, not as the reachable case
 * `state-machine-model.test.ts` used to assert of the last array entry.
 */
export function deriveStatusFromModel(facts: ForgeFacts | undefined): DerivedStatus {
  for (const rule of DERIVATION_RULES) {
    if (rule.matches(facts)) return rule.status
  }
  return 'incoherent'
}
