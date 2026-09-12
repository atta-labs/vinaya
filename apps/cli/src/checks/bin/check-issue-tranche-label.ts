#!/usr/bin/env bun

/**
 * Core check: issue-tranche-label. Thin adapter over `@attalabs/aeg-core`'s
 * `checkTrancheLabelPresence` — one of the six write-only rules named in
 * task 17, O2. `validates: 'issue'`: a task-shaped body carrying a
 * `vinaya/tranche:*` label is a property of a task Issue, never a pull
 * request.
 *
 * scope: full, ownWorkflow: true — invoked by name from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (Issue write time) and
 * from `packages/aeg-core/bin/verify-coherence.ts`'s open-Issue sweep, never
 * from `vinaya check --all`.
 */

import { checkTrancheLabelPresence } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { readIssueCheckEnv } from '../issue-check-env'

const CHECK_NAME = 'issue-tranche-label'

function main(): void {
  const { body, labels } = readIssueCheckEnv()
  if (!body) process.exit(0)

  const result = checkTrancheLabelPresence(body, labels)
  if (result.status === 'pass') process.exit(0)

  for (const message of result.errors) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message,
      agent_recovery_prompt:
        'Add a `vinaya/tranche:<slug>` label (e.g. `--label vinaya/tranche:<slug>`), then re-run `vinaya check issue-tranche-label`.'
    })
  }
  process.exit(1)
}

main()
