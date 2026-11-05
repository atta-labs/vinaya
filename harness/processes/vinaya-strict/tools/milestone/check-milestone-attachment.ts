/**
 * A typed diff between "which Issues the tranche label says belong to this
 * Milestone" and "which Issues GitHub's own `milestone` field actually
 * attaches to it" — the precondition `tranche-archivist.md` step 3 asserted
 * as fact ("stay attached… that attachment is the durable historical
 * record") without ever checking it. No network inside this
 * function: both lists are fetched and injected by the caller
 * (`milestoneCloseCommand`), exactly the discipline `resolveMilestoneAttachTarget`
 * already applies to its own `milestones` input.
 */
export type MilestoneAttachmentReport =
  | { status: 'clean' }
  | {
      status: 'mismatch'
      /** Labeled Issue numbers with no native attachment to this Milestone. */
      unattached: number[]
      /**
       * Issue numbers natively attached to this Milestone that do not carry
       * the tranche label. This also catches a Milestone shared with a
       * still-open sibling tranche (`vinaya milestone adopt`,
       * `milestone-model.md` §4) — refusing rather than closing out from
       * under it is the correct, conservative behavior, not a false positive.
       */
      foreign: number[]
    }

/**
 * `labeledIssueNumbers`: every Issue carrying this tranche's
 * `vinaya/tranche:<slug>` label. `attachedIssueNumbers`: every Issue GitHub's
 * own `milestone` field attaches to the target Milestone. Order-independent;
 * duplicates in either input do not affect the result.
 */
export function checkMilestoneAttachment(
  labeledIssueNumbers: number[],
  attachedIssueNumbers: number[]
): MilestoneAttachmentReport {
  const attachedSet = new Set(attachedIssueNumbers)
  const labeledSet = new Set(labeledIssueNumbers)
  const unattached = labeledIssueNumbers.filter((n) => !attachedSet.has(n))
  const foreign = attachedIssueNumbers.filter((n) => !labeledSet.has(n))
  if (unattached.length === 0 && foreign.length === 0) return { status: 'clean' }
  return { status: 'mismatch', unattached, foreign }
}
