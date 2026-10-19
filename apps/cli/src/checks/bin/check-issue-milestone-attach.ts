#!/usr/bin/env bun

/**
 * Core check: issue-milestone-attach. Thin adapter over
 * `@attalabs/aeg-core`'s `checkMilestoneAttach` — one of the five write-only
 * rules named apart. `validates: 'issue'`: a task Issue's live
 * Milestone matching its tranche label's resolved target is a property of
 * the Issue itself, never a pull request.
 *
 * Every fact this needs (`CURRENT_MILESTONE_TITLE`/`RESOLVED_MILESTONE_TITLE`)
 * is precomputed by the caller (`runIssueChecks`) rather than re-fetched here.
 *
 * scope: full, ownWorkflow: true — invoked by name from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks`, which both callers
 * of the edit-path gate reach: the Issue edit gate (`vinaya issue edit`) and
 * the dispatch write gate (`vinaya task run`/`task brief`). Never from
 * `vinaya check --all`, and never on create.
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
