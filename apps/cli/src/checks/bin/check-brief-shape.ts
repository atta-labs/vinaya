#!/usr/bin/env bun

/**
 * Core check: brief-shape. Thin adapter over `@attalabs/aeg-core`'s
 * `checkBriefSections` — mirrors `packages/aeg-core/bin/verify-brief.ts`'s
 * input assembly (PR_BODY/BRANCH env, tier via `readTierFromPrBody`, the
 * non-task/non-brief-shaped bypass, `requireClosesN: isTaskBranch(branch)`
 * — #870), but emits the check contract (JSON lines on stderr, exit 0/1)
 * instead of human text — the reason this is a new executable rather than a
 * wrapper around `bin/*` (`packages/aeg-core/bin/*` is out of this task's
 * boundary to edit).
 *
 * scope: diff — the PR body is what's graded; the one filesystem read added
 * here (task 10, Issue #385) is the workspace `package.json` manifests, read
 * once to build `checkConsumerTests`'s consumer enumeration — not a diff of
 * the repo's own content, so the "diff" scope is otherwise unchanged.
 */

import { readdirSync, readFileSync } from 'node:fs'
import {
  checkBriefSections,
  deriveWorkspacePackageDomains,
  isBriefShaped,
  isTaskBranch,
  readTierFromPrBody
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'brief-shape'

/** Immediate child directory names of `dir` — `deriveWorkspacePackageDomains`'s injected filesystem access. Missing/unreadable `dir` degrades to `[]`, never throws. */
function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * `checkConsumerTests`'s consumer enumeration (task 10, Issue #385) — the
 * workspace `packages/*` directories (`deriveWorkspacePackageDomains`, the
 * same "workspace-domain derivation" `blast-radius-domains.ts` already
 * provides — reused rather than re-enumerated) whose own `package.json`
 * `dependencies`/`devDependencies` names `@attalabs/<pkg>`. Manifests are
 * read once per invocation, not per §4 pkg mention.
 */
function buildConsumersOf(): (pkg: string) => string[] {
  const root = readJson('package.json')
  const workspaces = Array.isArray(root.workspaces) ? (root.workspaces as string[]) : []
  const domains = deriveWorkspacePackageDomains(workspaces, listDirs)

  return (pkg: string): string[] =>
    domains.filter((domain) => {
      if (domain === `packages/${pkg}`) return false
      const manifest = readJson(`${domain}/package.json`)
      const deps = {
        ...(manifest.dependencies as Record<string, string> | undefined),
        ...(manifest.devDependencies as Record<string, string> | undefined)
      }
      return `@attalabs/${pkg}` in deps
    })
}

function main(): void {
  const prBody = process.env.PR_BODY ?? ''
  if (!prBody) {
    // No PR body to check (local dev outside a CI/PR context) — nothing to do.
    process.exit(0)
  }

  const branch = process.env.BRANCH ?? ''
  const taskBranch = isTaskBranch(branch)

  // A non-task branch whose body isn't brief-shaped has no brief to grade —
  // an ordinary one-line dependency-bump PR must not be forced to grow one
  // (mirrors verify-brief.ts's identical bypass).
  if (branch && !taskBranch && !isBriefShaped(prBody)) {
    process.exit(0)
  }

  const { errors } = checkBriefSections(prBody, readTierFromPrBody, {
    requireClosesN: taskBranch,
    consumersOf: buildConsumersOf()
  })

  if (errors.length > 0) {
    for (const message of errors) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt:
          'Open the PR body and add or fix the section named above, following the canonical PR-body template ' +
          '(`aeg-root/roles/developer.md` § PR body — canonical form / `aeg-root/templates/pr-report-template.md`). ' +
          'Commit the corrected PR body, then re-run `vinaya check brief-shape`.'
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
