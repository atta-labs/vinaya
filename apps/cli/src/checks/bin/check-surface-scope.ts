#!/usr/bin/env bun

/**
 * Core check: surface-scope (O7). A task-branch PR whose
 * changed files fall inside its own Issue's declared `## Surface` `out:`
 * globs is refused, naming the file and the glob it crosses — an
 * undeclared boundary crossing caught mechanically instead of by a
 * reviewer's eye.
 *
 * `scope: diff` — a branch's own changed-file list decides this, the same
 * `git diff --name-only <base>...HEAD` every sibling diff-scoped adapter
 * here uses (`single-plan-pr`, `closes-n`, …), so this also runs pre-PR
 * from a push-time hook, not only in CI.
 *
 * Dormant, never blocking, for exactly ONE reason: the branch is not a task
 * branch at all (`taskBranchTopologyFields` returns `null`) — O7 binds a
 * "task-branch PR", so a non-task branch (a `changeset-release/*` bot PR, a
 * one-off `chore/*` branch) is categorically outside this check's scope,
 * the same posture `check-branch-topology.ts`'s identical `!fields` guard
 * already takes for the sibling gate. This is a scope boundary, not a
 * loophole: a task's Developer is bound (`roles/developer.md` entry gate
 * item 6, and the `first-push-dispatch` push-time gate) to use the real
 * `task/<tranche>/<n>` branch name, so renaming a real task's branch to
 * dodge this check would trip that gate first. Security review flagged
 * this path as fail-open alongside three others; Principal ruling: leave
 * THIS one dormant — flipping it to a refusal would fail two branches
 * already open on the forge that predate this gate entirely
 * (`changeset-release/main` #452, `chore/vinaya-0.25.1-republish` #448,
 * neither a task branch), and deciding otherwise is the same
 * cutover-by-number call `BRIEF_SECTIONS_SINCE_ISSUE` already is — the
 * Principal's to make, not this task's. See the PR body/comments for the
 * report.
 *
 * Every OTHER resolution failure now REFUSES by name instead of passing
 * silently, per that same ruling: the repo/forge/Issue-number lookup
 * cannot be completed; the Issue's body cannot be fetched; the Issue
 * carries no well-formed `## Surface` (a malformed or below-cutover Surface
 * — `checkIssueBriefSections`/`issue create`/`edit` already refuse a
 * malformed Surface at authoring time going forward, so a task-branch PR
 * reaching this check with one is either pre-cutover or a hole in that
 * upstream gate, and either way "cannot determine scope" is not a pass);
 * or the Issue's `## Surface` declares an `out:` line that resolves to zero
 * globs. An author with a genuinely Surface-less task gets a named refusal
 * naming what would satisfy it, never a green tick.
 */

import { execFileSync } from 'node:child_process'
import { checkSurfaceScope, parseIssueSurface, taskBranchTopologyFields } from '@attalabs/aeg-core'
import { createForgeSource } from '@attalabs/vinaya-sources'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'surface-scope'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

function changedFiles(base: string): string[] {
  return git(['diff', '--name-only', `${base}...HEAD`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Same shape every other check-bin adapter here resolves the repo with — see `check-branch-topology.ts`'s identical helper. */
function resolveRepo(): { owner: string; repo: string } | null {
  const fromEnv = process.env.AEG_REPO
  if (fromEnv) {
    const m = fromEnv.match(/^([^/]+)\/(.+)$/)
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] }
  }
  const url = git(['remote', 'get-url', 'origin'])
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh?.[1] && ssh[2]) return { owner: ssh[1], repo: ssh[2] }
  const https = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (https?.[1] && https[2]) return { owner: https[1], repo: https[2] }
  return null
}

function fetchIssueBody(issue: number): string | null {
  try {
    const out = execFileSync('gh', ['issue', 'view', String(issue), '--json', 'body'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return (JSON.parse(out) as { body: string }).body
  } catch {
    return null
  }
}

/** Emits one refusal and exits 1 — the shared shape every named resolution-failure path below uses. */
function refuse(message: string, agent_recovery_prompt: string): never {
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: CHECK_NAME,
    severity: 'error',
    message: `surface-scope: ${message}`,
    agent_recovery_prompt
  })
  process.exit(1)
}

async function main(): Promise<void> {
  const branch = process.env.BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const fields = taskBranchTopologyFields(branch)
  if (!fields) process.exit(0)

  const repo = resolveRepo()
  if (!repo) {
    refuse(
      `branch \`${branch}\` names a task, but this repository's owner/repo could not be resolved from \`AEG_REPO\` or \`git remote get-url origin\` — cannot look up which Issue's Surface bounds this PR.`,
      'Set AEG_REPO=owner/repo, or confirm `git remote get-url origin` resolves to a GitHub URL, then re-run `vinaya check surface-scope`.'
    )
  }

  let issue: number | null = null
  try {
    const source = createForgeSource({ owner: repo.owner, repo: repo.repo })
    const topology = await source.getTranche(fields.tranche)
    const task = topology?.tasks.find((t) => t.id === fields.taskId) ?? null
    issue = task?.issue ?? null
  } catch (err) {
    refuse(
      `could not reach the forge to resolve tranche \`${fields.tranche}\`'s topology: ${(err as Error).message}`,
      'Confirm `gh auth status` passes and the forge is reachable, then re-run `vinaya check surface-scope`.'
    )
  }
  if (issue === null) {
    refuse(
      `no Issue number is recorded for task \`${fields.taskId}\` in tranche \`${fields.tranche}\`'s forge topology — cannot look up which Issue's Surface bounds this PR.`,
      'Confirm this task has a real forge Issue and that the topology row carries its number, then re-run `vinaya check surface-scope`.'
    )
  }

  const body = fetchIssueBody(issue)
  if (body === null) {
    refuse(
      `could not fetch Issue #${issue}'s body via \`gh issue view\` — cannot read its \`## Surface\` section.`,
      'Confirm `gh auth status` passes and that the Issue exists, then re-run `vinaya check surface-scope`.'
    )
  }

  const surface = parseIssueSurface(body)
  if (!surface.ok) {
    refuse(
      `Issue #${issue} carries no well-formed \`## Surface\` section (${surface.errors.join('; ')}) — this task's boundary cannot be determined, so its scope cannot be enforced.`,
      `Add a well-formed \`## Surface\` section (an \`in:\` glob list and an \`out:\` glob list) to Issue #${issue} via \`vinaya issue edit\`, which re-validates it, then re-run \`vinaya check surface-scope\`.`
    )
  }
  if (surface.value.out.length === 0) {
    refuse(
      `Issue #${issue}'s \`## Surface\` \`out:\` line resolves to zero globs — an empty boundary is not an enforceable one.`,
      `Add at least one real \`out:\` glob to Issue #${issue}'s \`## Surface\` via \`vinaya issue edit\`, then re-run \`vinaya check surface-scope\`.`
    )
  }

  const base = process.env.BASE_SHA || 'origin/main'
  let files = changedFiles(base)
  if (files.length === 0) files = changedFiles('main')

  const result = checkSurfaceScope(files, surface.value.out)
  if (!result.ok) {
    for (const v of result.violations) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: `surface-scope: \`${v.file}\` falls inside Issue #${issue}'s \`## Surface\` \`out:\` glob \`${v.glob}\` — this task's own declared surface excludes it.`,
        agent_recovery_prompt:
          "Either the file genuinely belongs outside this task (drop the change from this PR), or the Issue's own `## Surface` `out:` list is wrong (fix it via `vinaya issue edit`, which re-validates it) — then re-run `vinaya check surface-scope`.",
        file: v.file
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
