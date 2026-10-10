/**
 * sibling-conflict-facts.ts — the dispatch check's second `Conflicts-with`
 * fact source: every open sibling of the tranche whose own list names the
 * dispatched task. The write gate accepts an edge declared on either side;
 * this is what lets the dispatch gate see the one the dispatched Issue
 * itself never lists. The edge test is `siblingsSharingConflictEdge`
 * (`@attalabs/aeg-core`), which wraps the write gate's own reader.
 *
 * Takes the already-fetched open-Issue listing and an injected resolver, so
 * it adds no forge read and is testable without one.
 */

import { siblingsSharingConflictEdge, type DispatchConflictsWithFact } from '@attalabs/aeg-core'
import { parseRationaleDeps } from '@attalabs/aeg-forge-state'

export type OpenSiblingIssue = { number: number; body: string }
export type ResolveConflictEdge = (edge: string) => Promise<{ issue: number | null; open: boolean }>

export async function resolveSiblingConflictFacts(
  subject: { issue: number | null; conflictsWith: string[] },
  openIssues: OpenSiblingIssue[],
  alreadyResolved: readonly DispatchConflictsWithFact[],
  resolve: ResolveConflictEdge
): Promise<DispatchConflictsWithFact[]> {
  if (subject.issue === null) return []
  const named = siblingsSharingConflictEdge(
    { ref: String(subject.issue), conflictsWith: subject.conflictsWith },
    openIssues.map((i) => ({ ref: String(i.number), conflictsWith: parseRationaleDeps(i.body).conflictsWith }))
  )
  const seen = new Set(alreadyResolved.map((f) => f.issue).filter((n): n is number => n !== null))
  const facts: DispatchConflictsWithFact[] = []
  for (const sib of named) {
    if (seen.has(Number(sib.ref))) continue
    const r = await resolve(`#${sib.ref}`)
    facts.push({ id: `#${sib.ref}`, issue: r.issue, openOrInFlight: r.open })
  }
  return facts
}
