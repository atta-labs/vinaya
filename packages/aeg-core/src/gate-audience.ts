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

/** A gate that adopters run, and the `coreCheckRegistry()` name it ships
 * under. `ring` mirrors `apps/cli/src/checks/registry.ts`'s `CORE_CHECK_RING`
 * value for that same name — duplicated here, not imported, because
 * `aeg-core` cannot import `apps/cli` (see this file's own module comment on
 * the dependency-cycle constraint `coreCheckRegistry()` runs into). Kept
 * from drifting by `registry-ring-parity.test.ts` (`apps/cli`), which is the
 * only place both sides are in scope at once — same shape as
 * `shipped-bin-audience.test.ts`'s existing `shippedAs` cross-check. This is
 * the "registry-derived fact" `registry-scaffold.ts` reads to place a stub
 * row for an aeg-core-bin G2 candidate that IS registry-backed; a candidate
 * with no entry here gets no stub (see `registry-scaffold.ts`). */
export type ShippedGate = { shippedAs: string | string[]; ring: 0 | 1 | 2 }
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
  'check-branch-topology': { shippedAs: 'branch-topology', ring: 0 },
  'check-first-push-dispatch': { shippedAs: 'first-push-dispatch', ring: 0 },
  'check-no-disk-state': { shippedAs: 'no-disk-state', ring: 0 },
  'verify-brief': { shippedAs: 'brief-shape', ring: 0 },
  'verify-coherence': { shippedAs: 'coherence', ring: 0 },
  'verify-dispatch': { shippedAs: 'dispatch-readiness', ring: 0 },
  'verify-docs': { shippedAs: ['doc-coverage', 'doc-coverage-push'], ring: 0 },
  'verify-registry': { shippedAs: 'registry-gates', ring: 0 },
  'verify-review-gate': { shippedAs: 'review-gate', ring: 1 },
  'verify-single-plan-pr': { shippedAs: 'single-plan-pr', ring: 0 },
  'verify-test-plan': { shippedAs: 'test-plan', ring: 1 },

  'check-direct-main-push': {
    internal:
      'Reaches adopters through `vinaya audit --only=direct-push`, not the check registry: it is a ring-2 sweep over merge history keyed on `GITHUB_SHA`, run by the generated archivist job on push to the default branch. It has no diff to key on, so there is nothing for `vinaya check` to run it against.'
  },
  'check-push-target': {
    internal:
      'A pre-push hook helper: it takes a branch name as `argv[2]` and answers one `gh pr list --head <branch>` question, for a caller that already knows which ref is being pushed. Adopters reach the same question through the registered `dead-branch-push`, which resolves the branch itself when `BRANCH` is unset. Registering this one too would add a second entry answering an identical forge query with a worse interface.'
  },
  'verify-task': {
    internal:
      "A composite that shells this repo's own `typecheck`/`lint`/`test`/`build` scripts by name. Those names are this monorepo's toolchain (bun + turbo + biome), not an adopter's; the shipped equivalent of its intent is `vinaya check --all`, which is portable by construction."
  }
}

/**
 * The other half, and the one the motivating case actually lives in.
 *
 * `reader-resolvable-prose` has no bin under `packages/aeg-core/bin/` at all —
 * its logic is `src/reader-resolvable-prose.ts` and its only executable is
 * `apps/cli/src/checks/bin/check-reader-resolvable-prose.ts`. So the map above
 * would never have seen it, and an earlier revision of this file claimed it as
 * the reason the file exists while leaving it uncovered. Review caught that;
 * this is the fix, not a re-wording.
 *
 * Enumerating the SHIPPED check bins asks the question that case actually
 * poses: here is an executable adopters could run — is it registered, and if
 * not, why not? `coreCheckRegistry()` lives in `apps/cli`, which `aeg-core`
 * cannot import without closing a dependency cycle, so the declaration lives
 * here and `apps/cli`'s own suite does the asserting.
 *
 * `check-reader-resolvable-prose`/`check-retired-vocabulary`: both used to live here as `internal` — hardcoded monorepo-specific
 * doctrine paths made them unreachable through an adopter's own registry.
 * Both are now config-driven (`vinaya.config.json`'s `proseGates`) and
 * registered in `coreCheckRegistry()` as `reader-resolvable-prose` /
 * `retired-vocabulary`, so neither belongs in this map any more — this repo's
 * own `shipped-bin-audience.test.ts` refuses a bin declared in BOTH places.
 */
export const SHIPPED_BIN_AUDIENCE: Record<string, GateAudience> = {}

/**
 * `name` -> `ring` for every check registered in `coreCheckRegistry()` whose
 * bin lives under `apps/cli/src/checks/bin/` — the direct analogue of
 * `ShippedGate.ring` above, for the OTHER directory. Mirrors
 * `apps/cli/src/checks/registry.ts`'s `CORE_CHECK_RING` — duplicated, not
 * imported, for the identical dependency-cycle reason `ShippedGate.ring`'s
 * own comment gives: `aeg-core` cannot import `apps/cli`. This is the
 * registry-derived fact `registry-scaffold.ts` reads to place a stub row for
 * an `apps/cli/src/checks/bin/` G2 candidate; a bin whose stripped name has
 * no entry here gets no stub — same no-guess discipline `classify()`
 * already applies to `packages/aeg-core/bin/` candidates via
 * `GATE_AUDIENCE`. Kept from drifting by `shipped-bin-audience.test.ts`
 * (`apps/cli`)'s own ring-parity block, the only place both sides are in
 * scope at once — same shape as this file's `ShippedGate.ring` check.
 */
export const CLI_CHECK_RING: Readonly<Record<string, 0 | 1 | 2>> = {
  'brief-shape': 0,
  'pr-report-density': 0,
  'doc-coverage': 0,
  coherence: 0,
  'dispatch-readiness': 0,
  'closes-n': 1,
  'single-plan-pr': 0,
  'surface-scope': 0,
  'test-plan': 1,
  'body-bare-digits': 1,
  'no-disk-state': 0,
  'registry-gates': 0,
  'review-gate': 1,
  'branch-topology': 0,
  'dead-branch-push': 0,
  'first-push-dispatch': 0,
  'doc-coverage-push': 0,
  'issue-assignment': 0,
  'evidence-fresh': 1,
  'reader-resolvable-prose': 0,
  'retired-vocabulary': 0,
  'doctrine-no-procedures': 0,
  'doctrine-portability': 0,
  'workspace-escape': 0,
  'exec-bits': 0,
  'changeset-coverage': 0,
  'quoted-command': 0,
  'main-branch-refusal': 0,
  'token-collection-wired': 0,
  'token-report': 1,
  'pr-premise-reassert': 0,
  // The six write-only rules named apart — `ownWorkflow: true`
  // each, same ring reasoning as `review-gate`/`body-bare-digits` above.
  'issue-title-grammar': 1,
  'issue-objectives-numbering': 1,
  'issue-parts-coverage': 1,
  'issue-surface-globs': 1,
  'issue-tranche-label': 1,
  'issue-milestone-attach': 1
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
  'eval-agent-compliance',
  'open-issue',
  'open-pr',
  'report-tokens'
] as const

export function isShipped(a: GateAudience): a is ShippedGate {
  return 'shippedAs' in a
}
