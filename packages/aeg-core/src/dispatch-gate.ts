/**
 * Dispatch-readiness composition (aeg-governance-hardening task 11, #324).
 * Pure — no `fs`, no `fetch`. Composes the forge/rationale/provenance/
 * archival facts the CLI shim (`bin/verify-dispatch.ts`) gathers (reusing
 * `parseTranche`, `hasProvenance`, `taskRefFromBranch`,
 * `checkIssueRationale`, `fetchProvenance` — never re-implementing any of
 * them) into one `{ ready, blockers }` verdict, one blocker string per
 * failing predicate.
 *
 * Every predicate here mechanizes a prose precondition that `roles/
 * developer.md`'s entry gate and `contracts/brief-developer.md` currently
 * state as something the Developer must re-derive by hand — the exact gap
 * this task exists to close: four Developer agents independently re-derived
 * (and stopped on) the same archival fact from scratch, at real token cost,
 * hours after it first became true (aeg-governance-hardening's 2026-07-02/03
 * live-fire wave).
 *
 * Message style mirrors `coherence-checks.ts`'s A1/A2/T2/etc. family: one
 * line per failure, naming the exact task/Issue/PR involved.
 */

import type { Task } from './types'
import { isPrincipal, PRINCIPAL_ALLOWLIST } from './waiver-label'

export type DispatchIssueFact = { number: number; state: 'open' | 'closed' } | null

export type DispatchEdgeFact = {
  /** The edge's target task id, as written in the topology's depends-on/conflicts-with cell. */
  id: string
  /** The target task's Issue number, if known — for message readability only. */
  issue: number | null
}

export type DispatchDependsOnFact = DispatchEdgeFact & {
  merged: boolean
  /**
   * `false` when the resolver could not find any tranche/task/Issue matching
   * this edge at all — a fact distinct from `merged: false`, which means the
   * edge resolved to a real target that just hasn't merged yet. Conflating
   * the two produced a false "not merged yet" claim for #193's
   * `vinaya-milestone-model-v1 2` edge, which had genuinely already merged
   * (#196) — the message this distinction exists to correct. Absent or
   * `true` for every edge the resolver actually matched to a target,
   * including one whose target lookup itself then failed (an outage), which
   * stays under the existing conservative `merged: false` default rather
   * than this one.
   */
  resolved?: boolean
  /**
   * Hand-close recognition facts (task `vinaya-engine-v1` 21, #99) — a
   * second, narrower path alongside `merged` for a dependency Issue closed
   * directly by a recognized Principal, with a stated `COMPLETED` reason,
   * rather than via a merged PR. All three are `null`/absent when the edge
   * is unresolvable or the target issue is open/has no close event — in
   * which case this path never fires and only `merged` matters, same as
   * before this task.
   */
  issueState?: 'open' | 'closed' | null
  stateReason?: 'completed' | 'not_planned' | null
  closedByActor?: string | null
}

/**
 * True when a dependency Issue was closed directly by a recognized Principal
 * with a stated `COMPLETED` reason — the second, narrower "done" path this
 * task adds alongside `merged`. Deliberately conjunctive and centralized
 * here (not duplicated per caller): the trap this task exists to avoid is
 * "any closed Issue with a comment counts," so every condition below is a
 * real forge fact, not a prose claim —
 *   - `issueState === 'closed'`: the Issue is actually closed.
 *   - `stateReason === 'completed'`: GitHub's own close reason says resolved,
 *     not `not_planned` (abandoned — the opposite of resolved).
 *   - `closedByActor` is the GitHub login that performed the CLOSED_EVENT
 *     (not a claim in a comment body) and is a member of the recognized
 *     Principal allowlist.
 */
function isHandClosedByRecognizedPrincipal(
  dep: Pick<DispatchDependsOnFact, 'issueState' | 'stateReason' | 'closedByActor'>,
  principalAllowlist: string[]
): boolean {
  return (
    dep.issueState === 'closed' &&
    dep.stateReason === 'completed' &&
    isPrincipal(dep.closedByActor ?? null, principalAllowlist)
  )
}

export type DispatchConflictsWithFact = DispatchEdgeFact & { openOrInFlight: boolean }

/**
 * Removed the predicate that consumed this fact
 * (`checkDispatchReadiness` no longer blocks on it) — automated the
 * signal (per-task provenance posting) this predicate existed to protect,
 * making the row-adjacency gate itself the stale part, not the automation.
 * Kept, dormant, rather than deleted: several callers (`bin/verify-dispatch.ts`,
 * both Studio/Vinaya `map-dispatch-input.ts` mappers) still assemble this
 * fact as harmless dead plumbing, and `DispatchGateInput.priorTask` below
 * remains the exact shape needed to test the predicate's absence.
 */
export type DispatchPriorTaskFact = {
  id: string
  issue: number | null
  issueClosed: boolean
  prMerged: boolean
  hasProvenance: boolean
}

export type DispatchPriorTrancheFact = {
  project: string
  /** null when this project has no prior tranche at all — the gate passes trivially for it. */
  priorTrancheSlug: string | null
  archived: boolean
}

export type DispatchGateInput = {
  trancheSlug: string
  /** The topology row for this task, as parsed by `parseTranche`. */
  task: Task
  /** null when the task has no Issue (#TBD/blank) OR the Issue number doesn't resolve on the forge (phantom ref). */
  issue: DispatchIssueFact
  /** `checkIssueRationale` result for this task's Issue — irrelevant (treated as passing) when `issue` is null. */
  issueRationalePass: boolean
  dependsOn: DispatchDependsOnFact[]
  conflictsWith: DispatchConflictsWithFact[]
  /**
   * The immediately-prior task in this same tranche's topology, or null
   * when this is the first task. no longer read by
   * `checkDispatchReadiness` — dormant field, kept for caller compatibility.
   */
  priorTask: DispatchPriorTaskFact | null
  /** One entry per project named in `task.projects`. */
  priorTrancheArchival: DispatchPriorTrancheFact[]
  /**
   * Overrides `PRINCIPAL_ALLOWLIST` for hand-close recognition when
   * provided — an adopter repo's own `vinaya.config.json` `principals`
   * field, resolved by the CLI bin before calling in (never read from here;
   * this stays pure). Defaults to `PRINCIPAL_ALLOWLIST` when omitted, same
   * pattern as `checkReviewGate`'s `principalAllowlist` (`review-gate.ts`) —
   * hardcoding this repo's own principal made that gate unpassable on any
   * adopter repo; the same mistake here would silently do the same to the
   * hand-close path.
   */
  principalAllowlist?: string[]
}

export type DispatchResult = { ready: boolean; blockers: string[] }

/**
 * True when a parsed `depends-on` edge points back at its own host task.
 *
 * A self-dependency is unsatisfiable by construction, so it is never a real
 * gate state — its presence is proof of a defect in the edge text or in its
 * resolution. `parseRationaleDeps` (`@attalabs/aeg-forge-state`) reads only
 * a labeled `Depends-on:`/`Conflicts-with:` field's own comma-separated,
 * id-shaped tokens; since Issue #347 an unlabeled/bare span elsewhere in the
 * "Dependency rationale" section is never read as an edge, whatever its
 * shape (`parse-rationale-deps.ts`'s own module comment states the rule). A
 * slug-qualified token in that list (`aeg-governance-hardening #368`) still
 * resolves its trailing bare number against the NAMED tranche, not the host
 * — a resolver bug there is what would land a task depending on itself, on
 * that tranche's own task `1`.
 *
 * Reported as an INTERNAL error rather than through the ordinary
 * "not merged yet" branch below, because that message reads as a legitimate
 * serialization and invites the reader to route around it: two Developer
 * agents faced with exactly this gate concluded it was a false positive and
 * committed with `--no-verify` to get past their hooks. Naming it a tool bug
 * converts "agent improvises around a nonsense gate" into "agent escalates,"
 * which is the behavior the gate architecture assumes.
 *
 * Two arms, because the edge can carry either shape: a resolved Issue number
 * equal to this task's own, or — the live case — a bare same-tranche id equal
 * to this task's own id.
 */
function isSelfDependency(dep: DispatchDependsOnFact, task: Task, issue: DispatchIssueFact): boolean {
  if (dep.issue !== null && issue !== null && dep.issue === issue.number) return true
  const bare = dep.id.trim().replace(/^#/, '')
  return bare.toLowerCase() === task.id.trim().toLowerCase()
}

export function checkDispatchReadiness(input: DispatchGateInput): DispatchResult {
  const { trancheSlug, task } = input
  const taskLabel = `task ${task.id} (tranche ${trancheSlug})`
  const principalAllowlist = input.principalAllowlist ?? PRINCIPAL_ALLOWLIST
  const blockers: string[] = []

  // Issue-existence — the topology row itself has no Issue number.
  if (task.issue === null) {
    blockers.push(
      `dispatch-gate issue-existence: ${taskLabel} has no Issue (#TBD or blank) in the topology — not dispatchable until the Planner cuts the Issue.`
    )
  } else if (input.issue === null) {
    // Row names an Issue number, but it doesn't resolve on the forge — phantom ref (T1's fail class).
    blockers.push(
      `dispatch-gate issue-existence: ${taskLabel} names Issue #${task.issue}, but it does not resolve to a real GitHub Issue (phantom reference).`
    )
  }

  // Planner-rationale completeness — only evaluable when the Issue itself resolved.
  if (input.issue !== null && !input.issueRationalePass) {
    blockers.push(
      `dispatch-gate rationale: Issue #${input.issue.number} for ${taskLabel} fails the rationale gate (checkIssueRationale) — the Planner must complete the eight-field rationale before this task is dispatchable.`
    )
  }

  // Depends-on merged — OR hand-closed by a recognized Principal (task
  // `vinaya-engine-v1` 21, #99): a second, narrower path for a dependency
  // Issue closed directly rather than via a merged PR.
  for (const dep of input.dependsOn) {
    // Evaluated BEFORE the unresolvable branch: a self-reference that also
    // failed to resolve is still a parser bug, and reporting it as an
    // unresolvable edge would send the reader to correct edge text that is
    // not actually the fault.
    if (isSelfDependency(dep, task, input.issue)) {
      const issueStr = input.issue !== null ? `#${input.issue.number}` : '?'
      blockers.push(
        `dispatch-gate INTERNAL: parsed a self-dependency for task ${task.id} (${issueStr}) — this is a parser bug in parseRationaleDeps, not a real dependency. Please report it upstream. Re-run once the rationale is corrected or the fix ships.`
      )
      continue
    }
    if (dep.resolved === false) {
      // Distinct from the "not merged yet" branch below (#196): this edge
      // never resolved to any tranche/task/Issue at all, so a "not merged"
      // claim would misattribute the failure to the forge rather than to
      // the edge text. Still blocks — the conservative default is correct
      // for a genuinely unresolvable edge — but says so honestly.
      blockers.push(
        `dispatch-gate depends-on: ${taskLabel} depends on "${dep.id}", which is UNRESOLVABLE — the resolver could not find a matching tranche/task/Issue for this edge (not a claim about merge status). Not dispatchable until the edge is corrected.`
      )
      continue
    }
    if (!dep.merged && !isHandClosedByRecognizedPrincipal(dep, principalAllowlist)) {
      const issueStr = dep.issue !== null ? ` (#${dep.issue})` : ''
      blockers.push(
        `dispatch-gate depends-on: ${taskLabel} depends on ${dep.id}${issueStr}, whose PR is not merged yet — not dispatchable, it serializes behind it.`
      )
    }
  }

  // Conflicts-with not open/in-flight.
  for (const c of input.conflictsWith) {
    if (c.openOrInFlight) {
      const issueStr = c.issue !== null ? ` (#${c.issue})` : ''
      blockers.push(
        `dispatch-gate conflicts-with: ${taskLabel} conflicts with ${c.id}${issueStr}, whose PR is open or in-flight — not dispatchable until it merges.`
      )
    }
  }

  // Prior-task archival / row-adjacency predicate REMOVED (2026-07-13).
  // The retired predicate required every earlier table row's full archival (Issue
  // closed, PR merged, provenance posted) regardless of whether that row was
  // a declared dependency automated the provenance-posting signal
  // this existed to protect, so the blanket row-order block outlived its
  // justification. `input.priorTask` is still accepted (dormant) for caller
  // compatibility; see the type's doc comment above.

  // Prior-tranche archival, per project named in Project(s).
  for (const proj of input.priorTrancheArchival) {
    if (proj.priorTrancheSlug !== null && !proj.archived) {
      blockers.push(
        `dispatch-gate prior-tranche-archival: project \`${proj.project}\`'s previous tranche \`${proj.priorTrancheSlug}\` is not archived — the Tranche Archivist must run before new work on this product.`
      )
    }
  }

  return { ready: blockers.length === 0, blockers }
}
