#!/usr/bin/env bun

/**
 * Core check: issue-parts-coverage. Thin adapter over `@attalabs/aeg-core`'s
 * `checkPartsCiteDefinedObjectives` — one of the five write-only rules named
 * apart. `validates: 'issue'`: `## Parts` citing a real Objective id
 * is a property of a task Issue's own body, never a pull request's.
 *
 * scope: full, ownWorkflow: true — invoked by name only from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (the Issue write
 * gate's runner), never from `vinaya check --all`.
 * The coherence sweep never spawns this executable, but its R1 rule runs the
 * same rule function, `checkPartsCiteDefinedObjectives`, directly — both in
 * `packages/aeg-core/bin/verify-coherence.ts` and in `vinaya check coherence`.
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
