/**
 * The repository CI's mandatory policy: what `.github/workflows/ci.yml` runs
 * whatever a pull request changes. Policy only — never a dependency edge:
 * which tests read which files lives in the test inventory
 * (`scripts/test-suites/inventory.json`), and the CI plan
 * (`scripts/ci/impact-plan.ts`) adds these duties to what the change
 * requires, each stated with its own reason.
 */

/** A job of `ci.yml`, by its key. */
export type CiJob =
  | 'build'
  | 'test-shared-packages'
  | 'test-cli'
  | 'test-cli-config-anchor'
  | 'sandbox-conformance'
  | 'sandbox-conformance-macos'
  | 'aggregate'

export type GovernanceObligation = {
  id: string
  kind: 'mandatory' | 'security' | 'ratchet' | 'compatibility' | 'merge-authority' | 'oracle'
  job: CiJob
  /** The step that discharges it, by name, when one step does. */
  step?: string
  /** `every-run`: every pull request and every default-branch commit. `default-branch`: every default-branch commit. */
  when: 'every-run' | 'default-branch'
  duty: string
}

export const GOVERNANCE_OBLIGATIONS: readonly GovernanceObligation[] = [
  {
    id: 'managed-files-match-generator',
    kind: 'compatibility',
    job: 'build',
    step: 'vinaya doctor — managed files match their generator',
    when: 'every-run',
    duty: 'doctor, run from the CLI this job builds, finds no drift between the managed workflows and hooks and their generator'
  },
  {
    id: 'architecture-ratchet',
    kind: 'ratchet',
    job: 'build',
    step: 'Test the architecture ratchet against the base',
    when: 'every-run',
    duty: 'the counted architecture ratchet holds against the base commit'
  },
  {
    id: 'inventory-gate',
    kind: 'mandatory',
    job: 'build',
    step: 'Check the test inventory and run the repository suite',
    when: 'every-run',
    duty: 'the test inventory validates and the repository suite — the inventory, relocation and schedule proofs among it — runs, documentation-only pull requests included'
  },
  {
    id: 'ci-plan',
    kind: 'merge-authority',
    job: 'build',
    step: "Build this pull request's CI plan",
    when: 'every-run',
    duty: 'one plan bound to the base, the approved head and the tested tree decides every job below, its schedule checked whole'
  },
  {
    id: 'default-branch-full-run',
    kind: 'mandatory',
    job: 'build',
    when: 'default-branch',
    duty: 'a push to the default branch runs every job and every test of every suite'
  },
  {
    id: 'selector-oracle',
    kind: 'oracle',
    job: 'test-cli',
    when: 'default-branch',
    duty: "the independent file-selector oracle in apps/cli/tests/lib/test-selector.test.ts runs on every default-branch commit, as the full run's part"
  },
  {
    id: 'required-check',
    kind: 'merge-authority',
    job: 'aggregate',
    step: 'Every mandatory job succeeded and every job the CI plan requires succeeded',
    when: 'every-run',
    duty: '`Vinaya CI` succeeds only when the plan is valid, bound to this head and tested tree, and every job it requires succeeded'
  }
]

/**
 * The job outside the required set: the macOS sandbox suite keeps running on
 * every pull request and every default-branch commit, as before, in its own
 * workflow (`.github/workflows/sandbox-conformance-macos.yml`), and its
 * result is advisory — never a job `Vinaya CI` needs, and never one the CI
 * run waits for.
 */
export const ADVISORY_JOBS: Readonly<Partial<Record<CiJob, string>>> = {
  'sandbox-conformance-macos':
    'advisory: the macOS sandbox suite runs on every run in its own workflow, outside the plan and the Vinaya CI aggregate; neither its queue nor its result blocks completion'
}
