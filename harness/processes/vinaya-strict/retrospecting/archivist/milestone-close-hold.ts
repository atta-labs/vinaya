// The one decision "may this Milestone close", shared by `vinaya archive
// tranche` and `vinaya milestone close` so the two never answer it
// differently. Each caller supplies its own special case for the tranche it
// is closing through the per-slug lifecycle reader.

import {
  type deriveTrancheFromForge,
  intentLines,
  milestoneLifecycleFromTrancheLifecycles
} from '@attalabs/aeg-forge-state'

/** The three lifecycles a tranche can be in, read off the one derivation `@attalabs/aeg-forge-state` owns rather than restated here. */
export type TrancheLifecycle = Awaited<ReturnType<typeof deriveTrancheFromForge>>['lifecycle']

export type DeclaredTranche = { slug: string; lifecycle: TrancheLifecycle }

/**
 * Every tranche a Milestone's `### Tranche intents` section declares, with
 * each one's lifecycle read by `readLifecycle` — in production the
 * `deriveTrancheFromForge` composition `vinaya milestone status` prints, so
 * "is that tranche done" is answered exactly once in this product.
 *
 * The tranche being closed is the caller's to report: it is `complete` by
 * construction once its own labeled Issues are all closed, and re-deriving
 * it would read a legacy Milestone titled exactly the slug — still open,
 * because closing it is what the caller is about to do — as `active`,
 * leaving the tranche blocking its own Milestone forever.
 */
export async function declaredTranches(
  description: string,
  readLifecycle: (slug: string) => Promise<TrancheLifecycle>
): Promise<DeclaredTranche[]> {
  const rows: DeclaredTranche[] = []
  for (const intent of intentLines(description)) {
    rows.push({ slug: intent.slug, lifecycle: await readLifecycle(intent.slug) })
  }
  return rows
}

/**
 * Whether the Milestone may close, and — when it may not — every reason it
 * stays open, in the words the prompt and the closing message both print.
 *
 * Two independent holds, because a Milestone is a product goal and a tranche
 * is one slice of it. An attached Issue still open is the older hold (a
 * shared Milestone's other tenants). A tranche the Milestone DECLARES but
 * that has no Issues yet is the second: it is real, `planned` work the
 * Milestone is still committed to, invisible to any count of attached
 * Issues, and closing on that count alone marked most of a product finished
 * the first time a tranche of it completed. `milestoneLifecycleFromTrancheLifecycles`
 * is what reads the declared set — never `.every(...)` inline, whose
 * vacuous truth on an empty list is the same bug in a new place.
 *
 * A Milestone declaring no `### Tranche intents` section at all keeps the
 * older rule untouched: nothing declared, nothing to hold it open. A
 * section present but carrying no line this parser can read is NOT that
 * case — an unreadable declaration is a declaration, and it holds.
 */
export function milestoneCloseDecision(input: {
  otherWorkOpen: boolean
  declaresIntents: boolean
  declared: readonly DeclaredTranche[]
}): { close: true } | { close: false; reasons: string[] } {
  const reasons: string[] = []
  if (input.otherWorkOpen) reasons.push('other tasks remain')
  if (
    input.declaresIntents &&
    milestoneLifecycleFromTrancheLifecycles(input.declared.map((d) => d.lifecycle)) !== 'complete'
  ) {
    const unfinished = input.declared.filter((d) => d.lifecycle !== 'complete')
    reasons.push(
      unfinished.length > 0
        ? `unfinished tranches it declares: ${unfinished.map((d) => `${d.slug} (${d.lifecycle})`).join(', ')}`
        : 'it declares a `### Tranche intents` section with no readable tranche line'
    )
  }
  return reasons.length === 0 ? { close: true } : { close: false, reasons }
}
