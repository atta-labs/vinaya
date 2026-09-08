#!/usr/bin/env bun

/**
 * archive-task — post-merge Archivist automation (aeg-governance-hardening
 * task 5d, #309). Thin I/O shim: resolves the merged PR from `MERGE_SHA` via
 * `gh`, gathers `MergedPrFacts`, and calls the pure `buildProvenanceBlock` /
 * `taskRefFromBranch` / `hasProvenance` homed in `@attalabs/aeg-core`. Mirrors
 * `bin/verify-brief.ts`'s exact shape (chdir to repo root; read env; call the
 * pure function; print; exit).
 *
 * Task-PR eligibility is an OR of two signals, not branch-name-only: a
 * `task/<tranche>/<id>` branch, OR the closed Issue itself carrying an
 * `vinaya/tranche:*` label (checked live via `gh issue view --json labels`).
 * Branch-name-only detection silently skipped a real task closure once
 * (#524/#530 — a tracked Issue closed by an ad-hoc `fix/*`-branch PR).
 *
 * Fail-loud discipline (/#305 live-fire, Planner trap 6): no step here
 * catches and swallows a `gh`/API error into a silent success. A `gh` call
 * throwing propagates as an uncaught exception — non-zero exit, the error
 * printed. A red post-merge job on `main` is a signal; it can never block a
 * merge since it runs strictly after one.
 */

import { execSync } from 'node:child_process'
import { join } from 'node:path'
import {
  AEG_BRIEF_V1_MARKER,
  buildProvenanceBlock,
  extractIssue,
  hasProvenance,
  isEligibleForProvenance,
  taskRefFromBranch
} from '../src/index'
import type { MergedPrFacts } from '../src/index'

const REPO_ROOT = join(import.meta.dir, '../../..')
process.chdir(REPO_ROOT)

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

function shJson<T>(cmd: string): T {
  return JSON.parse(sh(cmd)) as T
}

type AssociatedPr = { number: number }
/**
 * `gh pr view --json comments` already returns each comment's `author`, so
 * this shim's fetch carries it. It is carried NO FURTHER: nothing in this
 * file calls `aggregateTaskTokenRows`, which is the one consumer the author
 * exists for, so the provenance path below still reads comment bodies alone
 * (`hasProvenance`, the verdict extractors) and drops the author on the
 * floor. Typed here rather than discarded at the parse boundary because the
 * author is what separates a role's own `Tokens:` report from a stranger's
 * pasted table — every agent in this model posts under the Principal's own
 * `gh` identity — and a future call site in this shim must not have to
 * rediscover that the field was available all along.
 */
type PrView = {
  number: number
  headRefName: string
  body: string
  mergedAt: string
  comments: { body: string; author?: { login?: string } | null }[]
}

export function main(): void {
  const mergeSha = process.env.MERGE_SHA ?? ''
  if (!mergeSha) {
    console.error('[archive-task] MERGE_SHA env var is required.')
    process.exit(1)
  }

  const associated = shJson<AssociatedPr[]>(`gh api repos/{owner}/{repo}/commits/${mergeSha}/pulls`)
  if (associated.length === 0) {
    console.log(`[archive-task] no associated PR for merge ${mergeSha} — skip.`)
    process.exit(0)
  }

  const prNumber = (associated[0] as AssociatedPr).number
  const pr = shJson<PrView>(`gh pr view ${prNumber} --json number,headRefName,body,mergedAt,comments`)

  // Branch-name-only detection silently skipped a real task closure: an Issue
  // carrying a `vinaya/tranche:*` label, closed by a `fix/*`-branch PR.
  // `isEligibleForProvenance` (pure, unit-tested) makes the actual decision;
  // this shim only fetches the two facts it needs — the branch ref, and the
  // closed Issue's live labels.
  const { issue: primaryIssue } = extractIssue(pr.body)
  const ref = taskRefFromBranch(pr.headRefName)
  let issueLabels: string[] = []
  if (ref === null && primaryIssue !== null) {
    issueLabels = shJson<{ labels: { name: string }[] }>(`gh issue view ${primaryIssue} --json labels`).labels.map(
      (l) => l.name
    )
  }

  if (!isEligibleForProvenance(ref, issueLabels)) {
    console.log(
      `[archive-task] non-task branch (${pr.headRefName}) and closing Issue carries no vinaya/tranche:* label — skip.`
    )
    process.exit(0)
  }

  const comments = pr.comments.map((c) => c.body)
  if (hasProvenance(comments)) {
    console.log(`[archive-task] provenance already present on PR #${pr.number} — skip (idempotent).`)
    process.exit(0)
  }

  // The task Issue's frozen `aeg:brief:v1` comment URL (plan-brief-v1 task 2,
  // #427) — a best-effort resolution: no Issue, no such comment (a
  // pre-cutover task, or one dispatched by hand), or a failed fetch all
  // degrade to `null`, which `buildProvenanceBlock` reports as DANGLING
  // rather than blocking the merge-adjacent archival this shim runs after.
  let briefCommentUrl: string | null = null
  if (primaryIssue !== null) {
    try {
      const issueComments = shJson<{ comments: { body: string; url: string }[] }>(
        `gh issue view ${primaryIssue} --json comments`
      )
      const briefComment = issueComments.comments.find((c) => c.body.split('\n')[0] === AEG_BRIEF_V1_MARKER)
      briefCommentUrl = briefComment?.url ?? null
    } catch {
      briefCommentUrl = null
    }
  }

  const facts: MergedPrFacts = {
    number: pr.number,
    headRefName: pr.headRefName,
    body: pr.body,
    mergedAt: pr.mergedAt,
    mergeSha,
    comments,
    briefCommentUrl
  }

  const { block, issue, dangling } = buildProvenanceBlock(facts)

  console.log(`[archive-task] posting provenance block to PR #${pr.number}...`)
  execSync(`gh pr comment ${pr.number} --body-file -`, { input: block, encoding: 'utf8' })
  console.log(`[archive-task] provenance block posted to PR #${pr.number}.`)

  if (dangling.length > 0) {
    console.log(`[archive-task] DANGLING (${dangling.length}): ${dangling.join('; ')}`)
  }

  if (issue !== null) {
    console.log(`[archive-task] closing Issue #${issue}...`)
    execSync(`gh issue close ${issue}`, { encoding: 'utf8' })
    const state = shJson<{ state: string }>(`gh issue view ${issue} --json state`).state
    if (state !== 'CLOSED') {
      console.error(`[archive-task] FAILED — Issue #${issue} did not confirm CLOSED (state: ${state}).`)
      process.exit(1)
    }
    console.log(`[archive-task] Issue #${issue} confirmed CLOSED.`)
  } else {
    console.log('[archive-task] no Issue to close — Closes #N absent from PR body.')
  }

  console.log('[archive-task] PASS.')
  process.exit(0)
}

if (import.meta.main) {
  main()
}
