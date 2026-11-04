import type { CheckSpec } from './contract'

/**
 * Whether `--all` selects this check. A pure predicate over one spec —
 * deliberately not over a spec list, and with no registry/config loading
 * folded in: the two callers assemble their lists differently
 * (`commands/check.ts` filters the resolved list including an adopter's
 * custom checks; `scripts/verify-published-lifecycle.ts` filters
 * `coreCheckRegistry()` alone) and must stay free to.
 *
 * Exported so the shipped selection and the lifecycle script's derived
 * expectation apply the SAME rule. Each once re-derived `!ownWorkflow`
 * inline — a verifier re-implementing its subject's predicate is testing
 * its own copy, and any second condition added to `--all`'s selection
 * would have reached `check.ts` but not the script, which would then
 * report a divergence that was its own (the drift class removed one
 * level up, where the expectation was a hand-maintained count).
 *
 * A check with `ownWorkflow` is withheld because its dedicated workflow
 * already reports it — see `CheckSpec.ownWorkflow` and the `review-gate`
 * entry below for why a second `--all` copy freezes at push-time verdicts.
 */
export function runsUnderAll(spec: CheckSpec): boolean {
  return !spec.ownWorkflow
}

let registry: CheckSpec[] | undefined
export function installCheckRegistry(checks: CheckSpec[]): void {
  registry = checks
}
export function installedCheckRegistry(): CheckSpec[] {
  if (!registry) throw new Error('No check registry installed; call installCheckRegistry from the composition root.')
  return registry
}
