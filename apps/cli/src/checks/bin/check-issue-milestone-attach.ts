#!/usr/bin/env bun

/**
 * Core check: issue-milestone-attach. Thin adapter over
 * `@attalabs/aeg-core`'s `checkMilestoneAttach` — one of the six write-only
 * rules named in task 17, O2. `validates: 'issue'`: a task Issue's live
 * Milestone matching its tranche label's resolved target is a property of
 * the Issue itself, never a pull request.
 *
 * Every fact this needs (`CURRENT_MILESTONE_TITLE`/`RESOLVED_MILESTONE_TITLE`)
 * is precomputed by the caller (`runIssueChecks`) rather than re-fetched here
 * — the caller already resolved both while running its own gates.
 *
 * scope: full, ownWorkflow: true — invoked by name from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (Issue write time) and
 * from `packages/aeg-core/bin/verify-coherence.ts`'s open-Issue sweep, never
 * from `vinaya check --all`.
 */

import { checkMilestoneAttach } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { readIssueCheckEnv } from '../issue-check-env'

const CHECK_NAME = 'issue-milestone-attach'

function main(): void {
  const { labels, currentMilestoneTitle, resolvedMilestoneTitle } = readIssueCheckEnv()

  const result = checkMilestoneAttach(labels, currentMilestoneTitle, resolvedMilestoneTitle)
  if (result.status === 'pass') process.exit(0)

  for (const message of result.errors) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message,
      agent_recovery_prompt:
        'Attach this task Issue to the named Milestone (`--milestone <title>`), then re-run `vinaya check issue-milestone-attach`.'
    })
  }
  process.exit(1)
}

main()
