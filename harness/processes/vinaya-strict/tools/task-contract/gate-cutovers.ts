/**
 * The five gate cutovers as data — one Issue/PR number per gate below which
 * that gate is grandfathered (an Issue/PR older than the cutover passes
 * unconditionally). Pure — no `fs`, no `fetch`, no config read: the caller
 * resolves the effective cutovers once (`resolveGateCutovers`,
 * `apps/cli/src/lib/config.ts`, reading `vinaya.config.json`'s optional
 * `gateCutovers` key) and passes them into the pure validators, exactly the
 * seam `ReviewPolicy`/`resolveReviewPolicy` already use for the review
 * thresholds.
 *
 * Each field is `number | null`, and **`null` means NO CUTOVER** — the gate
 * applies to every Issue/PR, from number 1. That is the whole point of moving
 * these numbers out of hardcoded constants and into an optional config key: a
 * repository that declares no `gateCutovers` resolves every field to `null`
 * here (`NO_GATE_CUTOVERS`), so its Issue 1 is held to the same gates a
 * high-numbered Issue is (O1). A repository whose Issues predate a gate — this
 * one — sets the numbers in its own `vinaya.config.json` so its older Issues
 * and pull requests are judged exactly as before (O2). See
 * `packages/sources/src/config-reference.ts`'s `gateCutovers` entry (O3).
 *
 * The built-in constants that were these numbers (`OBJECTIVES_SINCE_ISSUE`
 * etc., still exported from `issue-validation.ts`/`brief-validation.ts`) remain
 * as the DEFAULT parameter value of each pure validator, so a caller that does
 * not resolve config (a test, an authoring path with no repo config in hand)
 * keeps this repository's historical behaviour. Every ENFORCEMENT path resolves
 * config and passes the value explicitly, and an absent key resolves to `null`
 * there — never to the constant — which is what makes O1 hold.
 */
export type GateCutovers = {
  /** `## Objectives` Issue gate (`checkIssueObjectives`). */
  objectivesSinceIssue: number | null
  /** `## Surface`/`## Parts`/`## Test plan`/`## Stop conditions` Issue gate (`checkIssueBriefSections`). */
  briefSectionsSinceIssue: number | null
  /** `## Documentation` Issue gate, folded into `checkIssueBriefSections`. */
  documentationSinceIssue: number | null
  /** The four brief-shape rules' PR rollout (`partitionBriefErrorsByRollout`). */
  briefRulesSincePr: number | null
  /** The `[agent]`-checkbox refusal's PR rollout (`checkNoAgentBoxes` via the same partition). */
  agentBoxesRefusedSincePr: number | null
}

/** No cutover on any gate — every gate applies from Issue/PR 1. The resolved value for a repository that declares no `gateCutovers` key (O1). */
export const NO_GATE_CUTOVERS: GateCutovers = {
  objectivesSinceIssue: null,
  briefSectionsSinceIssue: null,
  documentationSinceIssue: null,
  briefRulesSincePr: null,
  agentBoxesRefusedSincePr: null
}
