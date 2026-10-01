/**
 * A human label (O5, `apps/cli/specs/log-sync.md`, "The questions"): a fact
 * the Log never captured, supplied from outside it — a later reversal, an
 * incident, a human's verdict that a gate's rejection was false. A label is
 * an optional input to a question, never a row the Log stored; with none
 * supplied, every figure that depends on one reads unknown with the reason
 * `'no labels recorded'`, never zero.
 */

export type HumanLabelKind = 'false_rejection' | 'reversal' | 'incident'

export type HumanLabel = {
  kind: HumanLabelKind
  /** The unit of work (work reference) this label concerns. */
  unit: string
  /** Where this label came from — a Principal ruling, an incident report, a forge comment — freeform, attributed by whoever supplied it. */
  provenance: string
}

/** The reason every label-dependent figure reads unknown when no label was supplied. */
export const NO_LABELS_REASON = 'no labels recorded'
