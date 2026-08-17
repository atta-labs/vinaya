#!/usr/bin/env bun

/**
 * Core check: doc-coverage. Thin adapter over `@attalabs/aeg-core`'s C5 evaluator
 * (`evaluateC5` + `parseDocOwners`/`readDocAcks`, used internally by
 * `evaluateC5`), emitting the check contract instead of human text.
 *
 * The waiver-label lookup is resolved live via `gh`, from `PR_NUMBER` —
 * mirrors `check-review-gate.ts`'s `fetchPr`/`fetchWaiverLabelActor` pair.
 * An earlier version instead expected the CALLER (the generated CI workflow)
 * to inject `PR_LABELS`/`WAIVER_LABEL_ACTOR` env vars; no generated
 * `vinaya-checks.yml` — old or current — ever set them, so an applied
 * `vinaya/waiver:docs` label was silently unreachable by this check in every
 * adopter's CI (caught live on atta-labs/attalabs#948). Self-resolving here
 * needs no workflow template change and fixes every already-generated
 * `vinaya-checks.yml` in place.
 *
 * scope: diff — the whole point of C5 is "did this diff's code changes touch
 * a bound doc."
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { DOC_OWNERS_PATH, evaluateC5, isWaiverLabelActorVerified, WAIVER_LABEL } from '@attalabs/aeg-core'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'

// No chdir: `DOC_OWNERS_PATH` (`.vinaya/doc-owners`) and the `git diff` below
// must resolve relative to the CALLER's cwd — the repo `vinaya check` is
// meant to evaluate — never a fixed location derived from wherever this
// script physically lives. The runner's spawn() already inherits the
// caller's cwd with no override, so no chdir is needed.
const CHECK_NAME = 'doc-coverage'

// Array-form execFileSync — no shell, so `base` (env-controlled) is passed
// to git as an inert literal argv element, never shell-interpreted.
function git(args: string[]): string {
  try {
    // stdio explicitly piped (not left to default inheritance) — a failing
    // git call (e.g. no `origin/main` in the caller's repo, expected and
    // caught below) must never leak its own stderr onto THIS check's stderr
    // stream, which the runner treats as the versioned CheckError channel;
    // an unswallowed raw git error there reads as "check emitted garbage"
    // (status: 'error'), never a silent pass, even though this function's
    // own contract is "swallow the failure, return ''".
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

function resolvePrBody(): string {
  if (process.env.PR_BODY) return process.env.PR_BODY
  if (process.env.PR_BODY_FILE) {
    try {
      return readFileSync(process.env.PR_BODY_FILE, 'utf8')
    } catch {
      return ''
    }
  }
  return ''
}

type PrLabelsView = { labels: { name: string }[] }

function fetchPrLabels(prNumber: number): string[] | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'labels'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return (JSON.parse(out) as PrLabelsView).labels.map((l) => l.name)
  } catch {
    return null
  }
}

type TimelineLabeledEvent = { event: string; actor?: { login: string } | null; label?: { name: string } | null }

function fetchWaiverLabelActor(prNumber: number, label: string): string | null {
  try {
    const out = execFileSync('gh', ['api', `repos/{owner}/{repo}/issues/${prNumber}/timeline`, '--paginate'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const events = JSON.parse(out) as TimelineLabeledEvent[]
    const matches = events.filter((e) => e.event === 'labeled' && e.label?.name === label)
    return matches[matches.length - 1]?.actor?.login ?? null
  } catch {
    return null
  }
}

/**
 * A waiver is honored only when `vinaya/waiver:docs` is present on the PR
 * AND the actor of its most recent labeling timeline event is a configured
 * principal. `PR_NUMBER` is already provided by every generated
 * `vinaya-checks.yml` (`test-plan`/`closes-n` depend on it too), so no new
 * CI wiring is required for this to work.
 */
function waiverActive(): boolean {
  const prNumberStr = process.env.PR_NUMBER
  if (!prNumberStr) return false
  const prNumber = Number(prNumberStr)
  const labels = fetchPrLabels(prNumber)
  if (!labels?.includes(WAIVER_LABEL)) return false
  // Trust anchor: GitHub-API default-branch read, never the PR's own
  // checkout. See `loadTrustAnchorConfig` in lib/config.ts.
  const labelActor = fetchWaiverLabelActor(prNumber, WAIVER_LABEL)
  return isWaiverLabelActorVerified({
    label: WAIVER_LABEL,
    labels,
    labelActor,
    principalAllowlist: resolvePrincipalAllowlist(loadTrustAnchorConfig())
  })
}

function main(): void {
  const base = process.env.BASE_SHA || 'origin/main'
  let changed = changedFiles(base)
  if (changed.length === 0) changed = changedFiles('main')
  if (changed.length === 0) {
    process.exit(0)
  }

  const content = existsSync(DOC_OWNERS_PATH) ? readFileSync(DOC_OWNERS_PATH, 'utf8') : null
  const result = evaluateC5(changed, content, resolvePrBody(), existsSync, waiverActive())

  if (result.errors.length > 0) {
    for (const message of result.errors) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt:
          'Read the doc pointer named in the finding above, apply the change your code edit implies, and commit both ' +
          'files in this PR. If the doc genuinely does not need updating, ask a principal to apply the `vinaya/waiver:docs` ' +
          'label rather than editing around this finding — you cannot self-serve that waiver.'
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
