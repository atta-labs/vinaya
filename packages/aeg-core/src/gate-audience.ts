/**
 * Who each governance gate under `packages/aeg-core/bin/` is FOR.
 *
 * The problem this closes: this repository holds two parallel worlds — the
 * gates it runs on itself (`packages/aeg-core/bin/*`) and the checks an
 * adopter runs through the published CLI (`apps/cli/src/checks/bin/*`) — and
 * nothing asserted a relationship between them. Membership of the shipped set
 * was defined by ABSENCE from `coreCheckRegistry()`, which means a deliberate
 * exclusion and a forgotten port left exactly the same trace.
 *
 * `reader-resolvable-prose` is the instructive case, and the reason this file
 * exists. That call was made carefully and its reasoning written up well — in
 * a paragraph of prose inside `registry.ts`. It is right, and it is invisible
 * to tooling. A good decision and an unmade decision looked identical, so the
 * next one might simply not get made.
 *
 * So `internal` is a thing you must SAY, with a reason, rather than something
 * you can forget to notice. `gate-audience.test.ts` enumerates the bin
 * directory and fails when a gate is in neither column.
 *
 * **This is deliberately NOT a field on `CheckSpec`.** Adopter-defined checks
 * in `vinaya.config.json` produce that same shape (`lib/config.ts`), so an
 * `audience` field there would push an internal-governance concept into
 * adopter-facing config, where it means nothing and cannot be answered.
 * The question is about THIS repo's own bins, so the declaration lives here.
 *
 * Adding a gate to `bin/` and nothing else is now a failing build, naming the
 * file. That is the whole mechanism; deciding which column a given gate
 * belongs in stays a human judgement, which is the point.
 */

/** A gate that adopters run, and the `coreCheckRegistry()` name it ships under. */
export type ShippedGate = { shippedAs: string }
/** A gate this repo runs on itself, and why it cannot or should not ship. */
export type InternalGate = { internal: string }
export type GateAudience = ShippedGate | InternalGate

/**
 * Keyed by basename (no extension) of each `packages/aeg-core/bin/*.ts` that
 * is a GATE — something that inspects a repo and passes or fails. Non-gate
 * tooling in the same directory (forge writers, one-shot reporters) is listed
 * in `NON_GATE_BINS` below rather than given a fake audience.
 */
export const GATE_AUDIENCE: Record<string, GateAudience> = {
  'check-branch-topology': { shippedAs: 'branch-topology' },
  'check-first-push-dispatch': { shippedAs: 'first-push-dispatch' },
  'check-no-disk-state': { shippedAs: 'no-disk-state' },
  'verify-brief': { shippedAs: 'brief-shape' },
  'verify-coherence': { shippedAs: 'coherence' },
  'verify-dispatch': { shippedAs: 'dispatch-readiness' },
  'verify-docs': { shippedAs: 'doc-coverage' },
  'verify-registry': { shippedAs: 'registry-gates' },
  'verify-review-gate': { shippedAs: 'review-gate' },
  'verify-single-plan-pr': { shippedAs: 'single-plan-pr' },
  'verify-test-plan': { shippedAs: 'test-plan' },

  'check-direct-main-push': {
    internal:
      'Reaches adopters through `vinaya audit --only=direct-push`, not the check registry: it is a ring-2 scheduled sweep over merge history, not a per-PR gate, so it has no diff to key on and nothing for `vinaya check` to run it against.'
  },
  'check-push-target': {
    internal:
      'Its adopter-facing half is `dead-branch-push`, which re-derives the same question from forge state. This bin additionally reads local push refs, which only exist in a working checkout mid-push — an adopter running `vinaya check` in CI has no such state.'
  },
  'verify-task': {
    internal:
      "A composite that shells this repo's own `typecheck`/`lint`/`test`/`build` scripts by name. Those names are this monorepo's toolchain (bun + turbo + biome), not an adopter's; the shipped equivalent of its intent is `vinaya check --all`, which is portable by construction."
  }
}

/**
 * Files in `bin/` that are not gates and therefore have no audience: forge
 * writers and one-shot reporters. Listed explicitly rather than pattern-matched
 * so a NEW file cannot slip through by being named unlike a gate.
 */
export const NON_GATE_BINS = [
  'archive-task',
  'assign-task-issue',
  'dead-branch-audit',
  'open-issue',
  'open-pr',
  'report-tokens'
] as const

export function isShipped(a: GateAudience): a is ShippedGate {
  return 'shippedAs' in a
}
