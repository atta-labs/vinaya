#!/usr/bin/env bun

/**
 * Core check: issue-parts-coverage. Thin adapter over `@attalabs/aeg-core`'s
 * `checkPartsCiteDefinedObjectives` — one of the six write-only rules named
 * in task 17, O2. `validates: 'issue'`: `## Parts` citing a real Objective id
 * is a property of a task Issue's own body, never a pull request's.
 *
 * scope: full, ownWorkflow: true — invoked by name from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (Issue write time) and
 * from `packages/aeg-core/bin/verify-coherence.ts`'s open-Issue sweep, never
 * from `vinaya check --all`.
 */

import { checkPartsCiteDefinedObjectives } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { readIssueCheckEnv } from '../issue-check-env'

const CHECK_NAME = 'issue-parts-coverage'

function main(): void {
  const { body } = readIssueCheckEnv()
  if (!body) process.exit(0)

  const result = checkPartsCiteDefinedObjectives(body)
  if (result.status === 'pass') process.exit(0)

  for (const message of result.errors) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message,
      agent_recovery_prompt:
        'Fix the named Part to cite an objective id the `## Objectives` section actually defines, or add the missing objective, then re-run `vinaya check issue-parts-coverage`.'
    })
  }
  process.exit(1)
}

main()
