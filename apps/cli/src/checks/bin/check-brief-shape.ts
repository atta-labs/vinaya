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

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import {
  BRIEF_RULES_SINCE_PR,
  buildConsumersOf as buildConsumersOfShared,
  checkBriefSections,
  extractIssue,
  hasObjectivesHeading,
  isBriefShaped,
  isIssueNotFoundError,
  isTaskBranch,
  type Objective,
  OBJECTIVES_SINCE_ISSUE,
  type PackageManifest,
  objectivesOf,
  partitionBriefErrorsByRollout,
  readTierFromPrBody,
  resolveNewestFrozenBrief
} from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'

const CHECK_NAME = 'brief-shape'

type IssueCommentsJson = { comments: Array<{ body: string; author?: { login?: string } | null }> }

function fetchIssueComments(issueNumber: number): IssueCommentsJson {
  const out = execFileSync('gh', ['issue', 'view', String(issueNumber), '--json', 'comments'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return JSON.parse(out) as IssueCommentsJson
}

type GradedBodyResolution = { ok: true; body: string } | { ok: false; message: string }

/**
 * The body `checkBriefSections` actually grades. On a task branch, the
 * brief lives on the task Issue's frozen `aeg:brief:v<k>` comment, posted by
 * `vinaya task brief`/`dispatchTask` — never in the PR body — so that
 * comment, not `PR_BODY`, is what this check grades. A non-task (standalone
 * `fix/*`) branch is unchanged: its brief, if any, is still authored
 * directly into the PR body.
 *
 * Resolved through `@attalabs/aeg-core`'s `resolveNewestFrozenBrief`
 * (task 4, Issue #483, O3) — the same single resolver the review
 * loop uses, so a supersession is picked up here too rather than this
 * check grading a stale, since-corrected version.
 */
function resolveGradedBody(prBody: string, taskBranch: boolean): GradedBodyResolution {
  if (!taskBranch) return { ok: true, body: prBody }

  const { issue } = extractIssue(prBody)
  if (issue === null) {
    return { ok: false, message: 'not dispatched — no `Closes #N` in the PR body to resolve the task Issue.' }
  }

  let json: IssueCommentsJson
  try {
    json = fetchIssueComments(issue)
  } catch (err) {
    // Same treatment `resolveObjectivesApplicability` already gives an
    // unresolvable Issue number just below (a fixture's placeholder
    // `Closes #999`, a deleted Issue): additive exemption, never a new
    // hard-failure mode for a resource nothing required before this task.
    // A DIFFERENT fetch failure (network, auth, rate-limit) still hard-fails.
    if (isIssueNotFoundError(err)) {
      return { ok: true, body: prBody }
    }
    return {
      ok: false,
      message: `could not fetch Issue #${issue}'s comments (\`gh issue view\`) to grade the dispatched brief: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const allowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
  const comments = json.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
  const resolved = resolveNewestFrozenBrief(comments, allowlist)
  if (!resolved) {
    return { ok: false, message: `not dispatched — no \`aeg:brief:v<k>\` comment on Issue #${issue}.` }
  }

  return { ok: true, body: resolved.content }
}

/** Immediate child directory names of `dir` — `deriveWorkspaceMemberDirs`'s injected filesystem access. Missing/unreadable `dir` degrades to `[]`, never throws. */
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

function readManifest(dir: string): PackageManifest | null {
  const manifest = readJson(`${dir}/package.json`)
  return Object.keys(manifest).length === 0 ? null : (manifest as PackageManifest)
}

/**
 * `checkConsumerTests`'s consumer enumeration (task 10, Issue #385; round-2
 * ruling items 3/4) — `@attalabs/aeg-core`'s `buildConsumersOf`, the SAME
 * enumeration `packages/aeg-core/bin/verify-brief.ts` wires for the
 * authoring-time entry point, so CI and pre-dispatch can never disagree
 * about which workspace members count as consumers.
 */
function buildConsumersOf(): (pkg: string) => string[] {
  const root = readJson('package.json')
  const workspaces = Array.isArray(root.workspaces) ? (root.workspaces as string[]) : []
  return buildConsumersOfShared(workspaces, listDirs, readManifest)
}

function fetchIssueBody(issueNumber: number): string {
  return execFileSync('gh', ['issue', 'view', String(issueNumber), '--json', 'body', '--jq', '.body'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

type ObjectivesResolution =
  | { applies: false }
  | { applies: true; objectives: Objective[] }
  | { applies: true; fetchError: string }

/**
 * Same applicability rule `verify-brief.ts`'s `resolveIssueObjectives`
 * uses — `applies: false` skips the objectives checks entirely: a task
 * branch whose `Closes #N` is missing/malformed, an Issue below
 * `OBJECTIVES_SINCE_ISSUE`, a standalone brief with no `## Objectives`
 * section at all, or an Issue number that does not resolve (a fixture's
 * placeholder `Closes #999`, a deleted Issue) — additive exemptions, never
 * a new hard-failure mode for a resource nothing required before this
 * task. A DIFFERENT fetch failure (network, `gh` auth, rate-limit) is its
 * own named finding (`fetchError`) instead: it means the comparison could
 * not be run, not that it passed, and CI must report that rather than
 * silently passing on exactly the failure mode most likely in practice.
 */
function resolveObjectivesApplicability(prBody: string, taskBranch: boolean): ObjectivesResolution {
  if (!taskBranch) {
    if (!hasObjectivesHeading(prBody)) return { applies: false }
    const own = objectivesOf(prBody)
    return { applies: true, objectives: own.ok ? own.objectives : [] }
  }
  const { issue } = extractIssue(prBody)
  if (issue === null || issue < OBJECTIVES_SINCE_ISSUE) return { applies: false }
  try {
    const parsed = objectivesOf(fetchIssueBody(issue))
    // A malformed section on an at/above-cutover Issue is `checkIssueObjectives`'s
    // own failure to diagnose, not this gate's — skip rather than comparing
    // the brief against an Issue the Issue gate should already have refused.
    return parsed.ok ? { applies: true, objectives: parsed.objectives } : { applies: false }
  } catch (err) {
    if (isIssueNotFoundError(err)) {
      process.stdout.write(
        `brief-shape: Issue #${issue} does not resolve (\`gh issue view\`) — skipping the objectives checks for this run.\n`
      )
      return { applies: false }
    }
    return {
      applies: true,
      fetchError: `could not fetch Issue #${issue}'s body (\`gh issue view\`) to compare Objectives: ${(err as Error).message}`
    }
  }
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

  const gradedBodyResolution = resolveGradedBody(prBody, taskBranch)
  if (!gradedBodyResolution.ok) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `brief-shape: ${gradedBodyResolution.message}`,
      agent_recovery_prompt:
        'Dispatch this task with `vinaya task dispatch <tranche> <n>` (posts the `aeg:brief:v1` Issue comment), or check `gh auth status`/network, then re-run `vinaya check brief-shape`.'
    })
    process.exit(1)
  }
  const gradedBody = gradedBodyResolution.body

  const objectivesResolution = resolveObjectivesApplicability(prBody, taskBranch)
  if (objectivesResolution.applies && 'fetchError' in objectivesResolution) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `brief-validation objectives copy: ${objectivesResolution.fetchError}`,
      agent_recovery_prompt: 'Check `gh auth status` and network, then re-run `vinaya check brief-shape`.'
    })
    process.exit(1)
  }

  const { errors } = checkBriefSections(gradedBody, readTierFromPrBody, {
    requireClosesN: taskBranch,
    consumersOf: buildConsumersOf(),
    issueObjectives: objectivesResolution.applies ? objectivesResolution.objectives : undefined
  })

  // Grandfathering (task 10 round-2 ruling addendum 1) — a PR opened before
  // BRIEF_RULES_SINCE_PR predates the four rules `checkBriefSections` added
  // this task; a finding from one of them is informational there, never a
  // failure. `verify-brief.ts` (no PR number, authoring time) has no such
  // exemption — grandfathering is a CI rollout concern, not a grammar
  // relaxation. A missing/unparseable PR_NUMBER parses to `null`, which
  // `partitionBriefErrorsByRollout` treats as NOT grandfathered (fail-closed).
  const parsedPrNumber = Number.parseInt(process.env.PR_NUMBER ?? '', 10)
  const prNumber = Number.isInteger(parsedPrNumber) ? parsedPrNumber : null
  const { blocking, info } = partitionBriefErrorsByRollout(errors, prNumber)

  if (info.length > 0) {
    process.stdout.write(
      `${CHECK_NAME}: PR #${prNumber} is below BRIEF_RULES_SINCE_PR #${BRIEF_RULES_SINCE_PR} — ${info.length} finding(s) grandfathered, not a failure:\n${info.join('\n')}\n`
    )
  }

  if (blocking.length > 0) {
    for (const message of blocking) {
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
