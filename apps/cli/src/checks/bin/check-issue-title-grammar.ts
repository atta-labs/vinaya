#!/usr/bin/env bun

/**
 * Core check: issue-title-grammar. Thin adapter over `@attalabs/aeg-core`'s
 * `checkForgeTitle` — one of the six write-only rules named in task 17, O2.
 * `validates: 'issue'`: title grammar only ever applies to a task Issue's own
 * title, never a pull request's — this check has no pull-request body to
 * grade and is never selected into a pull-request workflow.
 *
 * scope: full, ownWorkflow: true — invoked by name from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (Issue write time) and
 * from `packages/aeg-core/bin/verify-coherence.ts`'s open-Issue sweep, never
 * from `vinaya check --all`.
 */

import { checkForgeTitle } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { readIssueCheckEnv } from '../issue-check-env'

const CHECK_NAME = 'issue-title-grammar'

function main(): void {
  const { title } = readIssueCheckEnv()
  if (title === null) process.exit(0) // no title given (e.g. an edit that doesn't change it) — nothing to grade.

  const result = checkForgeTitle(title)
  if (result.status === 'pass') process.exit(0)

  for (const message of result.errors) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message,
      agent_recovery_prompt:
        'Rewrite the Issue title to match the forge-title grammar (`Type: description` / `Type(scope): description`, or `[tranche] id — description`), then re-run `vinaya check issue-title-grammar`.'
    })
  }
  process.exit(1)
}

main()
