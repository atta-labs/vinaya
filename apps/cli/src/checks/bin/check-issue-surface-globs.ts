#!/usr/bin/env bun

/**
 * Core check: issue-surface-globs. Thin adapter over `@attalabs/aeg-core`'s
 * `checkSurfaceGlobsResolve` — one of the five write-only rules named
 * apart. `validates: 'issue'`: a `## Surface` `in:` glob resolving to a
 * real tracked file is a property of a task Issue's own body, never a pull
 * request's.
 *
 * `resolvesToFile` shells to `git ls-files` (`expandGlob`, the SAME
 * implementation `apps/cli/src/lib/brief-assembly.ts`'s render path and
 * `forge-write.ts`'s `validateIssueContent` already use) — the gate and the
 * renderer can never disagree about whether a glob resolves.
 *
 * scope: full, ownWorkflow: true — invoked by name only from
 * `apps/cli/src/lib/forge-write.ts`'s `runIssueChecks` (the Issue write
 * gate's runner), never from `vinaya check --all`.
 */

import { checkSurfaceGlobsResolve } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { readIssueCheckEnv } from '../issue-check-env'
import { expandGlob } from '../../lib/brief-assembly'

const CHECK_NAME = 'issue-surface-globs'

function main(): void {
  const { body } = readIssueCheckEnv()
  if (!body) process.exit(0)

  const result = checkSurfaceGlobsResolve(body, (glob) => expandGlob(glob).length > 0)
  if (result.status === 'pass') process.exit(0)

  for (const message of result.errors) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message,
      agent_recovery_prompt:
        'Fix the named `## Surface` `in:` glob so it matches at least one real tracked file (a typo, or a directory that does not exist yet), then re-run `vinaya check issue-surface-globs`.'
    })
  }
  process.exit(1)
}

main()
