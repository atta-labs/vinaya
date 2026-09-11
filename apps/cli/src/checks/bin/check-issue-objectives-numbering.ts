#!/usr/bin/env bun

/**
 * Core check: issue-objectives-numbering. Thin adapter over
 * `@attalabs/aeg-core`'s `checkIssueObjectives` — one of the six write-only
 * rules named in task 17, O2. `validates: 'issue'`: `## Objectives`
 * numbering is a property of a task Issue's own body, never a pull request's.
 *
 * scope: full, ownWorkflow: true — invoked by name from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (Issue write time) and
 * from `packages/aeg-core/bin/verify-coherence.ts`'s open-Issue sweep, never
 * from `vinaya check --all`.
 */

import { checkIssueObjectives } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { readIssueCheckEnv } from '../issue-check-env'

const CHECK_NAME = 'issue-objectives-numbering'

function main(): void {
  const { body, issueNumber } = readIssueCheckEnv()
  if (!body) process.exit(0)

  const result = checkIssueObjectives(body, issueNumber)
  if (result.status === 'pass') process.exit(0)

  for (const message of result.errors) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message,
      agent_recovery_prompt:
        'Fix the `## Objectives` section named above — numbered `O<n>. <sentence>` lines, one observable outcome each, no gaps — then re-run `vinaya check issue-objectives-numbering`.'
    })
  }
  process.exit(1)
}

main()
