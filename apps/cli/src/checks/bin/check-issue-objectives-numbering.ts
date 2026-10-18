#!/usr/bin/env bun

/**
 * Core check: issue-objectives-numbering. Thin adapter over
 * `@attalabs/aeg-core`'s `checkIssueObjectives` — one of the five write-only
 * rules named apart. `validates: 'issue'`: `## Objectives`
 * numbering is a property of a task Issue's own body, never a pull request's.
 *
 * scope: full, ownWorkflow: true — invoked by name only from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (the Issue write
 * gate's runner), never from `vinaya check --all`.
 * The coherence sweep never spawns this executable, but its R1 rule runs the
 * same rule function, `checkIssueObjectives`, directly — both in
 * `packages/aeg-core/bin/verify-coherence.ts` and in `vinaya check coherence`.
 */

import { checkIssueObjectives } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadConfig, resolveGateCutovers } from '../../lib/config'
import { readIssueCheckEnv } from '../issue-check-env'

const CHECK_NAME = 'issue-objectives-numbering'

function main(): void {
  const { body, issueNumber } = readIssueCheckEnv()
  if (!body) process.exit(0)

  // An absent `gateCutovers.objectivesSinceIssue` resolves to `null` (no
  // cutover — grade every Issue from 1, O1); this repo restates its own (O2).
  const { objectivesSinceIssue } = resolveGateCutovers(loadConfig())
  const result = checkIssueObjectives(body, issueNumber, objectivesSinceIssue)
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
