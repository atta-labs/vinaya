// `vinaya archive` — the post-merge Archivist, callable directly instead of
// only from the `post-merge` job in the generated `vinaya-archivist.yml`
// (see lib/artifacts.ts's `archivistWorkflow()`). Thin I/O shim mirroring
// this monorepo's own `packages/aeg-core/bin/archive-task.ts`: resolves the
// merged PR from a merge SHA via `gh`, gathers `MergedPrFacts`, and calls
// the pure `buildProvenanceBlock` / `taskRefFromBranch` / `hasProvenance` /
// `isEligibleForProvenance` homed in `@attalabs/aeg-core` — already a CLI
// dependency (see artifacts.ts's own `@attalabs/aeg-core` import).
//
// Repo/owner resolution goes through this CLI's own `detectGitRepo()`
// (lib/detect.ts) — the same path every other command uses — never a
// second auth/repo-resolution mechanism.

import { execFileSync } from 'node:child_process'
import {
  buildProvenanceBlock,
  extractIssue,
  hasProvenance,
  isEligibleForProvenance,
  taskRefFromBranch,
  trancheLabel,
  type MergedPrFacts
} from '@attalabs/aeg-core'
import { detectGitRepo, type RepoInfo } from '../lib/detect.js'
import { closeStdin, promptYesNo } from '../lib/prompt.js'
import { loadConfig } from '../lib/config.js'

// `rings.ring2_asyncAudits` is additive, never disabling: `false` (or absent
// — every pre-existing `vinaya init` starter config reads `false` here) is a
// no-op, leaving the Archivist's real work running exactly as it does today,
// unconditionally, for every existing adopter. `true` is the new opt-in
// accelerator — the only value that changes behavior — and skips it. An
// unreadable/invalid config resolves the same as absent: real work runs.
function ring2Accelerated(): boolean {
  return loadConfig()?.rings?.ring2_asyncAudits === true
}

export type ArchiveDeps = {
  detectRepo: () => Promise<RepoInfo | null>
}

function realDeps(): ArchiveDeps {
  return { detectRepo: detectGitRepo }
}

function sh(args: string[], input?: string): string {
  return execFileSync(args[0] as string, args.slice(1), { encoding: 'utf8', input }).trim()
}

function shJson<T>(args: string[]): T {
  return JSON.parse(sh(args)) as T
}

type AssociatedPr = { number: number }
type PrView = {
  number: number
  headRefName: string
  body: string
  mergedAt: string
  comments: { body: string }[]
}

function parseMergeSha(args: string[]): string | null {
  for (const a of args) {
    const m = a.match(/^--merge-sha=(.+)$/)
    if (m) return m[1] as string
  }
  return null
}

export async function runArchive(args: string[], deps: ArchiveDeps): Promise<number> {
  if (ring2Accelerated()) {
    process.stdout.write(
      '[vinaya archive] rings.ring2_asyncAudits is `true` (opt-in accelerator) — skipping, nothing changed.\n'
    )
    return 0
  }

  const repo = await deps.detectRepo()
  if (!repo) {
    console.error('Error: not a git repository. Run `vinaya archive` from inside your repo.')
    return 1
  }
  if (!repo.owner || !repo.repo) {
    console.error('Error: could not resolve a GitHub owner/repo from the `origin` remote.')
    return 1
  }
  const repoFlag = `${repo.owner}/${repo.repo}`

  const mergeSha = parseMergeSha(args) ?? sh(['git', 'rev-parse', 'HEAD'])

  const associated = shJson<AssociatedPr[]>(['gh', 'api', `repos/${repoFlag}/commits/${mergeSha}/pulls`])
  if (associated.length === 0) {
    process.stdout.write(`[vinaya archive] no associated PR for merge ${mergeSha} — skip.\n`)
    return 0
  }

  const prNumber = (associated[0] as AssociatedPr).number
  const pr = shJson<PrView>([
    'gh',
    'pr',
    'view',
    String(prNumber),
    '-R',
    repoFlag,
    '--json',
    'number,headRefName,body,mergedAt,comments'
  ])

  // Same OR-of-two-signals eligibility as archive-task.ts: a
  // `task/<tranche>/<id>` branch, or the closed Issue itself carrying a
  // `vinaya/tranche:*` label — branch-name-only detection silently skips a
  // real task closure otherwise.
  const ref = taskRefFromBranch(pr.headRefName)
  let issueLabels: string[] = []
  if (ref === null) {
    const { issue: candidateIssue } = extractIssue(pr.body)
    if (candidateIssue !== null) {
      issueLabels = shJson<{ labels: { name: string }[] }>([
        'gh',
        'issue',
        'view',
        String(candidateIssue),
        '-R',
        repoFlag,
        '--json',
        'labels'
      ]).labels.map((l) => l.name)
    }
  }

  if (!isEligibleForProvenance(ref, issueLabels)) {
    process.stdout.write(
      `[vinaya archive] non-task branch (${pr.headRefName}) and closing Issue carries no vinaya/tranche:* label — skip.\n`
    )
    return 0
  }

  const comments = pr.comments.map((c) => c.body)
  if (hasProvenance(comments)) {
    process.stdout.write(`[vinaya archive] provenance already present on PR #${pr.number} — skip (idempotent).\n`)
    return 0
  }

  const facts: MergedPrFacts = {
    number: pr.number,
    headRefName: pr.headRefName,
    body: pr.body,
    mergedAt: pr.mergedAt,
    mergeSha,
    comments
  }

  const { block, issue, dangling } = buildProvenanceBlock(facts)

  process.stdout.write(`[vinaya archive] posting provenance block to PR #${pr.number}...\n`)
  sh(['gh', 'pr', 'comment', String(pr.number), '-R', repoFlag, '--body-file', '-'], block)
  process.stdout.write(`[vinaya archive] provenance block posted to PR #${pr.number}.\n`)

  if (dangling.length > 0) {
    process.stdout.write(`[vinaya archive] DANGLING (${dangling.length}): ${dangling.join('; ')}\n`)
  }

  if (issue !== null) {
    process.stdout.write(`[vinaya archive] closing Issue #${issue}...\n`)
    sh(['gh', 'issue', 'close', String(issue), '-R', repoFlag])
    const state = shJson<{ state: string }>([
      'gh',
      'issue',
      'view',
      String(issue),
      '-R',
      repoFlag,
      '--json',
      'state'
    ]).state
    if (state !== 'CLOSED') {
      console.error(`[vinaya archive] FAILED — Issue #${issue} did not confirm CLOSED (state: ${state}).`)
      return 1
    }
    process.stdout.write(`[vinaya archive] Issue #${issue} confirmed CLOSED.\n`)
  } else {
    process.stdout.write('[vinaya archive] no Issue to close — Closes #N absent from PR body.\n')
  }

  process.stdout.write('[vinaya archive] PASS.\n')
  return 0
}

export async function archiveCommand(args: string[]): Promise<void> {
  process.exit(await runArchive(args, realDeps()))
}

// ---------------------------------------------------------------------------
// vinaya archive tranche <slug> — the tranche-level bookend. Refuses (no
// --force) if any Issue carrying `vinaya/tranche:<slug>` is still open —
// closing a tranche with unresolved work is never silently allowed, matching
// this product's refuse-by-default posture everywhere else. When the
// tranche is complete AND a legacy Milestone titled exactly the slug exists,
// closes that Milestone (the archival mechanism this repo has today). --yes
// skips the confirm prompt, same convention as init/eject/upgrade.
// ---------------------------------------------------------------------------

type Milestone = { number: number; title: string }
type LabeledIssueRef = { number: number; title: string; state: 'OPEN' | 'CLOSED' }

function parseTrancheArgs(args: string[]): { slug: string | null; yes: boolean } {
  const yes = args.includes('--yes')
  const slug = args.find((a) => !a.startsWith('--')) ?? null
  return { slug, yes }
}

/**
 * The pure derivation this command now runs on: given every Issue carrying
 * `vinaya/tranche:<slug>` (any state), which of the three archival outcomes
 * applies. Split out from `runArchiveTranche` so the exact new logic — "is
 * this tranche done" answered from its own labeled Issues rather than from
 * a Milestone — is unit-testable with no `gh`/`execFileSync` mocking at all,
 * matching this repo's pure-evaluator/I-O-shim split used throughout
 * `packages/aeg-core` (`coherence-checks.ts`, `fetch-milestone.ts`, …).
 */
export function trancheArchivalStatus(
  issues: LabeledIssueRef[]
): { kind: 'no-tranche' } | { kind: 'open'; openIssues: LabeledIssueRef[] } | { kind: 'complete' } {
  if (issues.length === 0) return { kind: 'no-tranche' }
  const openIssues = issues.filter((i) => i.state === 'OPEN')
  if (openIssues.length > 0) return { kind: 'open', openIssues }
  return { kind: 'complete' }
}

/**
 * A tranche's identity is its `vinaya/tranche:<slug>` label, not a Milestone
 * number: this command used to find an open Milestone titled the slug FIRST and list its Issues
 * via `?milestone=<number>` — a query that returns every Issue the Milestone
 * holds, not just this tranche's, so once one Milestone can legitimately
 * hold several tranches that query would silently close siblings the moment
 * their own task Issues (correctly) still showed open. Both the matching
 * rule and the Issue listing now go through the label instead: "is this
 * tranche done" is answered from its OWN Issues, before anything asks
 * whether a Milestone exists to close.
 *
 * Closing a Milestone is still this command's mechanism for legacy
 * (title-equals-slug) tranches — the only kind that exist today, since the
 * write side that can create a shared or label-only tranche is task 2's
 * scope, not this one's. A complete tranche with no matching Milestone
 * (unreachable today, reachable once task 2 ships) reports done with
 * nothing to close, rather than erroring — there is no archival mechanism
 * for it yet to invoke.
 */
export async function runArchiveTranche(args: string[], deps: ArchiveDeps): Promise<number> {
  const { slug, yes } = parseTrancheArgs(args)
  if (!slug) {
    console.error('Usage: vinaya archive tranche <slug> [--yes]')
    return 2
  }

  const repo = await deps.detectRepo()
  if (!repo) {
    console.error('Error: not a git repository. Run `vinaya archive tranche` from inside your repo.')
    return 1
  }
  if (!repo.owner || !repo.repo) {
    console.error('Error: could not resolve a GitHub owner/repo from the `origin` remote.')
    return 1
  }
  const repoFlag = `${repo.owner}/${repo.repo}`

  const issues = shJson<LabeledIssueRef[]>([
    'gh',
    'issue',
    'list',
    '-R',
    repoFlag,
    '--label',
    trancheLabel(slug),
    '--state',
    'all',
    '--json',
    'number,title,state',
    '--limit',
    '200'
  ])
  const status = trancheArchivalStatus(issues)
  if (status.kind === 'no-tranche') {
    console.error(`Error: no tranche found for '${slug}' in ${repoFlag} — no Issues carry ${trancheLabel(slug)}.`)
    return 1
  }
  if (status.kind === 'open') {
    console.error(
      `Error: tranche '${slug}' still has ${status.openIssues.length} open task(s) — refusing to close:\n` +
        status.openIssues.map((i) => `  #${i.number} — ${i.title}`).join('\n')
    )
    return 1
  }

  const milestones = shJson<Milestone[]>(['gh', 'api', `repos/${repoFlag}/milestones?state=open&per_page=100`])
  const milestone = milestones.find((m) => m.title === slug)
  if (!milestone) {
    process.stdout.write(
      `Tranche '${slug}' is complete (${issues.length} task(s), all closed) — no open Milestone to close.\n`
    )
    return 0
  }

  if (!yes) {
    const ok = await promptYesNo(`Close tranche '${slug}' (Milestone #${milestone.number}, all tasks closed)?`, false)
    closeStdin()
    if (!ok) {
      process.stdout.write('Aborted. Nothing was changed.\n')
      return 0
    }
  }

  sh(['gh', 'api', '-X', 'PATCH', `repos/${repoFlag}/milestones/${milestone.number}`, '-f', 'state=closed'])
  process.stdout.write(`Tranche '${slug}' closed (Milestone #${milestone.number}).\n`)
  return 0
}

export async function archiveTrancheCommand(args: string[]): Promise<void> {
  process.exit(await runArchiveTranche(args, realDeps()))
}
