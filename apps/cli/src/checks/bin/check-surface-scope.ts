#!/usr/bin/env bun

/**
 * Core check: surface-scope (plan-brief-v1 8, O7). A task-branch PR whose
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
 * Dormant, never blocking, when any of: the branch is not a task branch
 * (`taskBranchTopologyFields` returns `null`); the forge/repo cannot be
 * resolved or reached (a transient outage must never block every push —
 * same posture `single-plan-pr`'s `gh pr list` failure already takes);
 * the task's topology row carries no Issue number yet; the Issue's body
 * carries no well-formed `## Surface` (below the brief-sections cutover,
 * or malformed — `checkIssueBriefSections`/`issue create`/`edit` already
 * catch a malformed Surface at authoring time, so this check does not
 * duplicate that refusal); or the Issue declares no `out:` globs at all.
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

async function main(): Promise<void> {
  const branch = process.env.BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const fields = taskBranchTopologyFields(branch)
  if (!fields) process.exit(0)

  const repo = resolveRepo()
  if (!repo) process.exit(0)

  let issue: number | null = null
  try {
    const source = createForgeSource({ owner: repo.owner, repo: repo.repo })
    const topology = await source.getTranche(fields.tranche)
    const task = topology?.tasks.find((t) => t.id === fields.taskId) ?? null
    issue = task?.issue ?? null
  } catch {
    process.exit(0)
  }
  if (issue === null) process.exit(0)

  const body = fetchIssueBody(issue)
  if (body === null) process.exit(0)

  const surface = parseIssueSurface(body)
  if (!surface.ok || surface.value.out.length === 0) process.exit(0)

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
          'Either the file genuinely belongs outside this task (drop the change from this PR), or the Issue\'s own `## Surface` `out:` list is wrong (fix it via `vinaya issue edit`, which re-validates it) — then re-run `vinaya check surface-scope`.',
        file: v.file
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
