/**
 * Issue self-assignment at task-run start. Pure — no `fs`, no `gh`/`git`
 * shell-outs. The CLI's writer (`assignIssueAtRunStart`,
 * `apps/cli/src/lib/dispatch-task.ts`, called by `runTask` once the run's
 * Issue is resolved and the live-driver refusal has passed) gathers the
 * facts — who is currently assigned, who `gh` is authenticated as — and this
 * evaluator decides whether to assign.
 *
 * Produces the signal Studio's dispatch-visibility chip
 * renders: `facts.assigned = assigneesCount > 0`. Without it, assignment
 * happened only when the Principal remembered to assign by hand, so a
 * genuinely in-flight task looked identical to an untouched one. A task run
 * starting is the moment a task genuinely goes in flight, so that is the
 * moment this fires; "first" means the run starts and the Issue has no
 * assignee yet.
 *
 * Every guard skips rather than errors — this is a visibility nicety, never
 * a gate. In particular: `assignees`/`login` arriving as `null` (a failed
 * `gh` call) means "no signal", and no-signal means no action — never a
 * guess, never a block. Such a skip is marked `missingFact` so the caller
 * can warn about it, unlike the silent already-assigned no-op.
 */

export type IssueAssignmentInput = {
  /** The task's Issue number. */
  issue: number
  /** Current assignee logins on the Issue, or `null` when the fetch failed. */
  assignees: string[] | null
  /** The authenticated `gh` login, or `null` when unresolvable. Never a hardcoded fallback. */
  login: string | null
}

export type IssueAssignmentDecision =
  | { action: 'assign'; issue: number; login: string; reason: string }
  | { action: 'skip'; missingFact: boolean; reason: string }

export function decideIssueAssignment(input: IssueAssignmentInput): IssueAssignmentDecision {
  const { issue, assignees, login } = input

  if (assignees === null) {
    return {
      action: 'skip',
      missingFact: true,
      reason: `Could not read Issue #${issue}'s current assignees — skipping rather than risking a double-assign (fail-open, never a guess).`
    }
  }

  if (assignees.length > 0) {
    return {
      action: 'skip',
      missingFact: false,
      reason: `Issue #${issue} is already assigned (${assignees.join(', ')}) — no-op.`
    }
  }

  if (login === null) {
    return {
      action: 'skip',
      missingFact: true,
      reason:
        'Could not resolve the identity `gh` is authenticated as — never assigning anyone other than that identity, so skipping.'
    }
  }

  return {
    action: 'assign',
    issue,
    login,
    reason: `Task run starting on unassigned Issue #${issue} — assigning it to @${login} (the authenticated identity).`
  }
}
