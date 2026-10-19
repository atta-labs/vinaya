#!/usr/bin/env bun

/**
 * Core check: first-push-dispatch. Thin adapter over `@attalabs/aeg-core`'s
 * `checkFirstPushDispatchGate` — mirrors `packages/aeg-core/bin/check-first-push-dispatch.ts`'s
 * gate shape (only evaluates on a task branch's genuinely first push, no PR
 * yet), emitting the check contract instead of human text.
 *
 * Documented divergence from the reference script: that script shells out
 * to `bun packages/aeg-core/bin/verify-dispatch.ts` — a path that exists
 * only inside THIS monorepo checkout, never in an arbitrary adopter repo
 * `vinaya init` installs into. This adapter instead classifies readiness
 * the same way the already-registered `dispatch-readiness` check does:
 * `checkDispatchReadiness` (`@attalabs/aeg-core`) fed with forge facts read via
 * `createForgeSource` (`@attalabs/vinaya-sources`) — the same
 * `@attalabs/aeg-core` + `@attalabs/vinaya-sources`-only boundary every check in
 * this directory already keeps. Same fail-open contract as the reference:
 * any forge-reachability failure classifies as `UNKNOWN`, which the pure
 * gate evaluator maps to `allow` — a transient outage must never block a
 * first push, and never passes silently: each unknown writes one `warning`
 * finding and the check still exits 0. `prExists` is self-derived via
 * `gh pr list --head <branch>` (the reference script instead trusts a
 * caller-supplied flag; this adapter has no such caller to trust, so it
 * derives the same fact `dead-branch-push` already derives the same way). A
 * failed read of it is its own third answer, never "no pull request".
 *
 * scope: full — reads the live forge, not the local diff.
 */

import { execFileSync } from 'node:child_process'
import {
  checkDispatchReadiness,
  checkFirstPushDispatchGate,
  checkIssueRationale,
  fetchForgeFacts,
  fetchOpenIssuesByLabel,
  isEntryPoint,
  parseTaskBranch,
  type DispatchConflictsWithFact,
  type DispatchDependsOnFact,
  type DispatchGateInput,
  type DispatchReadinessFact
} from '@attalabs/aeg-core'
import { resolvePriorTrancheArchival } from '@attalabs/aeg-forge-state'
import { createForgeSource } from '@attalabs/vinaya-sources'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { resolveTrustedPrincipals } from '../../lib/config'
import { resolveEdge } from '../edge-resolve'
import { warnOnUnreadPrincipals } from '../principals-refusal'

const CHECK_NAME = 'first-push-dispatch'

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

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

type PrExists = 'EXISTS' | 'NONE' | 'UNKNOWN'

function prExistsFor(branch: string): PrExists {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    const entries = JSON.parse(out) as Array<{ number: number }>
    return entries.length > 0 ? 'EXISTS' : 'NONE'
  } catch {
    return 'UNKNOWN'
  }
}

/** True once a Principal-read warning has been written, so a readiness `UNKNOWN` it caused adds no second warning. */
let principalWarned = false

function warn(message: string, recovery: string): void {
  emitCheckError({
    schema: CHECK_SCHEMA_VERSION,
    check: CHECK_NAME,
    severity: 'warning',
    message: `${CHECK_NAME}: ${message}`,
    agent_recovery_prompt: recovery
  })
}

/**
 * The first push's readiness from the assembled gate input and the archival
 * resolution's failure: `UNKNOWN` (fail-open, like any unreachable forge) when
 * a read the archival answer depends on failed, otherwise `READY` or
 * `NOT_READY` from the gate.
 */
export function firstPushArchivalReadiness(
  input: DispatchGateInput,
  infraFailure: string | null
): DispatchReadinessFact {
  if (infraFailure !== null) return 'UNKNOWN'
  return checkDispatchReadiness(input).ready ? 'READY' : 'NOT_READY'
}

/**
 * Best-effort readiness classification — any forge failure degrades to
 * `UNKNOWN` (fail-open), never a thrown error. The one exception is the
 * Principal list, resolved right after the repository and before any forge
 * read, outside the catch-all: no Principal configured refuses the push (one
 * `error` line, exit 1); a failed read is one warning and readiness `UNKNOWN`.
 */
async function classifyReadiness(trancheSlug: string, taskId: string): Promise<DispatchReadinessFact> {
  const repo = resolveRepo()
  if (!repo) return 'UNKNOWN'

  let principalAllowlist: string[]
  try {
    principalAllowlist = resolveTrustedPrincipals()
  } catch (err) {
    warnOnUnreadPrincipals(CHECK_NAME, err)
    principalWarned = true
    return 'UNKNOWN'
  }

  try {
    const source = createForgeSource({ owner: repo.owner, repo: repo.repo })
    const tranche = await source.getTranche(trancheSlug)
    const task = tranche.tasks.find((t) => t.id === taskId)
    if (!task) return 'NOT_READY'

    const taskRefs = tranche.tasks.map((t) => ({ id: t.id, issue: t.issue }))
    const snapshot = await fetchForgeFacts({
      owner: repo.owner,
      repo: repo.repo,
      tranche: trancheSlug,
      tasks: taskRefs
    })

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
    const openIssuesBySlug = await fetchOpenIssuesByLabel([trancheSlug], repo.owner, repo.repo, token)
    const openIssues = openIssuesBySlug.get(trancheSlug) ?? []

    const issueFacts = task.issue !== null ? snapshot.facts.get(task.id) : undefined
    const issue =
      task.issue !== null && issueFacts
        ? { number: task.issue, state: (issueFacts.issueState === 'closed' ? 'closed' : 'open') as 'open' | 'closed' }
        : null

    const openIssueMatch = task.issue !== null ? openIssues.find((i) => i.number === task.issue) : undefined
    const issueRationalePass = openIssueMatch ? checkIssueRationale(openIssueMatch.body).status !== 'fail' : true

    const taskById = new Map(tranche.tasks.map((t) => [t.id, t]))
    const factsByTaskId = snapshot.facts

    const dependsOn: DispatchDependsOnFact[] = await Promise.all(
      task.dependsOn.map(async (dep) => {
        const r = await resolveEdge(dep, taskById, factsByTaskId, repo)
        return {
          id: dep,
          issue: r.issue,
          merged: r.merged,
          resolved: r.resolved,
          issueState: r.issueState,
          stateReason: r.stateReason,
          closedByActor: r.closedByActor
        }
      })
    )
    const conflictsWith: DispatchConflictsWithFact[] = await Promise.all(
      task.conflictsWith.map(async (c) => {
        const r = await resolveEdge(c, taskById, factsByTaskId, repo)
        return { id: c, issue: r.issue, openOrInFlight: r.open }
      })
    )

    const archival = await resolvePriorTrancheArchival(task.projects, trancheSlug, repo)

    const input: DispatchGateInput = {
      trancheSlug,
      task,
      issue,
      issueRationalePass,
      dependsOn,
      conflictsWith,
      priorTask: null,
      priorTrancheArchival: archival.facts,
      principalAllowlist
    }

    return firstPushArchivalReadiness(input, archival.infraFailure)
  } catch {
    return 'UNKNOWN'
  }
}

async function main(): Promise<void> {
  const branch = process.env.BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const parsed = parseTaskBranch(branch)

  let readiness: DispatchReadinessFact = 'READY'
  let prExists = false

  if (parsed) {
    const found = prExistsFor(branch)
    if (found === 'EXISTS') {
      prExists = true
    } else if (found === 'UNKNOWN') {
      readiness = 'UNKNOWN'
      warn(
        `the forge could not say whether \`${branch}\` already has a pull request (the \`gh pr list\` read failed), so dispatch readiness was not checked and the push is allowed.`,
        'Confirm `gh auth status` passes and the forge is reachable, then re-run `vinaya check first-push-dispatch`.'
      )
    } else {
      readiness = await classifyReadiness(parsed.tranche, parsed.taskId)
      if (readiness === 'UNKNOWN' && !principalWarned) {
        warn(
          `dispatch readiness for \`${branch}\` is unknown (the forge could not be read or the repository could not be resolved), so the push is allowed unchecked.`,
          'Confirm `gh auth status` passes, the forge is reachable and `origin` names the GitHub repository, then re-run `vinaya check first-push-dispatch`.'
        )
      }
    }
  }

  const result = checkFirstPushDispatchGate({ branch, prExists, readiness })

  if (result.verdict === 'refuse') {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: result.reason,
      agent_recovery_prompt:
        "Resolve the named dispatch blocker before this task branch's first push, then re-run `vinaya check first-push-dispatch`."
    })
    process.exit(1)
  }

  process.exit(0)
}

if (isEntryPoint(import.meta.url, 'check-first-push-dispatch')) {
  main()
}
