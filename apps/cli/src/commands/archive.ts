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
  formatTokensLine,
  hasProvenance,
  isEligibleForProvenance,
  parseDeveloperRoundMarker,
  resolveMeteringCapability,
  taskRefFromBranch,
  trancheLabel,
  type MergedPrFacts,
  type MeteringCapability,
  type TranscriptSummary
} from '@attalabs/aeg-core'
import {
  deriveTrancheFromForge,
  hasTrancheIntentsSection,
  intentLines,
  milestoneLifecycleFromTrancheLifecycles
} from '@attalabs/aeg-forge-state'
import { detectGitRepo, type RepoInfo } from '../lib/detect.js'
import { closeStdin, promptYesNo } from '../lib/prompt.js'
import { loadConfig } from '../lib/config.js'
import { realDeps as meteringRealDeps } from './tokens.js'

// `rings.ring2_asyncAudits` means what it says: `true` (the default — an
// absent key resolves the same way) RUNS the async audits, so the
// Archivist's real work runs exactly as it always has. `false` is the
// opt-OUT — the only value that changes behavior — and skips it. An
// unreadable/invalid config resolves the same as absent: real work runs.
// (Prior to issue-545/O2 this boolean's sense was inverted; `vinaya upgrade`
// migrates a config still holding the old values.)
function ring2AsyncAuditsDisabled(): boolean {
  return loadConfig()?.rings?.ring2_asyncAudits === false
}

export type ArchiveDeps = {
  detectRepo: () => Promise<RepoInfo | null>
  /** Injected so the Archivist token-row decision (`renderArchiveTokensLine`) is testable without touching real transcripts/env — same seam `doctor.ts`'s `DoctorDeps` already uses for the identical probe. */
  meteringCapability: () => MeteringCapability
}

function realDeps(): ArchiveDeps {
  return { detectRepo: detectGitRepo, meteringCapability: () => resolveMeteringCapability(meteringRealDeps()) }
}

/**
 * True when a `capable: true` probe still summarized to zero tokens across
 * every component. Distinct from `resolveMeteringCapability`'s own
 * `transcript-empty` (zero *messages*) — this is zero *tokens* from at least
 * one real message, an edge case the probe itself doesn't classify as
 * incapable. Treated as its own failure rather than silently formatting as
 * `0/0/—`: a capable host's blank is not the `—` case §12 sanctions
 * (`aeg-root/roles/developer.md`) — that placeholder means "the host has no
 * usage API," never "the host reported nothing usable this turn."
 */
function isEmptySummary(summary: TranscriptSummary): boolean {
  const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = summary.components
  return inputTokens === 0 && outputTokens === 0 && cacheCreationInputTokens === 0 && cacheReadInputTokens === 0
}

export type ArchiveTokensResult = { line: string | null; dangling: string | null }

/**
 * Renders the Archivist's own one-line `Tokens: …` report from an
 * already-resolved probe result — pure, so every branch is directly
 * testable with a literal `MeteringCapability` value, no fake transcript or
 * env needed. Mirrors `roles/reviewer.md`/`security.md`'s bare-line
 * convention (never the Developer's table row): appended as its own line in
 * the provenance comment, `parseTokensLines` already scans any comment body
 * for that shape, so Studio's live token-ledger read picks this up with no
 * new parser — closing the exact gap `roles/archivist.md` flags as having
 * "no durable home today" for the Archivist's own turn.
 *
 * `capable: false` posts the sanctioned all-`—` line (never degrades — this
 * repo's toolchain runs `vinaya archive` from CI as often as from an agent
 * session, and a genuinely incapable host is the one case `—` is for).
 * `capable: true` but empty — see `isEmptySummary` — omits the line (`line:
 * null`) rather than posting a misleading zero, and returns a `dangling`
 * note for the CALLER to fold into the provenance comment alongside its own
 * DANGLING trailer. This never aborts the whole post: a BLOCKER review
 * finding — an earlier version of this function returned a hard refusal
 * that `runArchive` used to skip posting the comment and closing the Issue
 * entirely, collateral-damaging a duty this feature has nothing to do with
 * over one missing token row. The brief's own §10 names that exact
 * trade-off ("losing provenance to gain a token row is a bad trade") as a
 * Principal-only call — the fix is to never force it: provenance and
 * Issue-closure proceed unconditionally, and the anomaly is flagged, not
 * silently swallowed and not blocking.
 */
export function renderArchiveTokensLine(
  capability: MeteringCapability,
  phase: string,
  role: string
): ArchiveTokensResult {
  if (!capability.capable) {
    return { line: formatTokensLine({ phase, role, summary: null }), dangling: null }
  }
  if (isEmptySummary(capability.summary)) {
    return {
      line: null,
      dangling:
        `Archivist Tokens: line omitted — metering probe reports capable (transcript ${capability.transcriptPath}) ` +
        `but summarized to zero tokens across ${capability.summary.messageCount} message(s); posting a real zero ` +
        'would misrepresent the turn, and `—` is sanctioned only for a genuinely incapable host.'
    }
  }
  return { line: formatTokensLine({ phase, role, summary: capability.summary }), dangling: null }
}

function sh(args: string[], input?: string): string {
  // `env: process.env` explicit rather than relying on execFileSync's own
  // default: measured live under Bun, an omitted `env` resolves `PATH`
  // against a snapshot taken at process start, so a test that mutates
  // `process.env.PATH` after that (to place a fake `gh` ahead of the real
  // one — `detect.test.ts`'s sanctioned PATH-boundary technique, since
  // module-level mocking is rejected repo-wide) silently falls through to
  // the real binary. Passing it explicitly is also just Node's own
  // documented default made real under this runtime.
  return execFileSync(args[0] as string, args.slice(1), { encoding: 'utf8', input, env: process.env }).trim()
}

function shJson<T>(args: string[]): T {
  return JSON.parse(sh(args)) as T
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

function parseMergeSha(args: string[]): string | null {
  for (const a of args) {
    const m = a.match(/^--merge-sha=(.+)$/)
    if (m) return m[1] as string
  }
  return null
}

export async function runArchive(args: string[], deps: ArchiveDeps): Promise<number> {
  if (ring2AsyncAuditsDisabled()) {
    process.stdout.write('[vinaya archive] rings.ring2_asyncAudits is `false` — skipping, nothing changed.\n')
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

  const phase = `${ref ? ref.taskId : pr.headRefName}: archive`
  const tokensResult = renderArchiveTokensLine(deps.meteringCapability(), phase, 'Archivist')
  // A missing/anomalous Tokens row is never a reason to withhold the whole
  // comment: provenance and Issue-closure are a separate, pre-existing duty
  // this feature must not put at risk (a BLOCKER review finding — an earlier
  // version refused the entire post here, losing both over one token row).
  const tokensAddition = tokensResult.line !== null ? tokensResult.line : `DANGLING (tokens): ${tokensResult.dangling}`
  const blockWithTokens = `${block}\n\n${tokensAddition}`

  process.stdout.write(`[vinaya archive] posting provenance block to PR #${pr.number}...\n`)
  sh(['gh', 'pr', 'comment', String(pr.number), '-R', repoFlag, '--body-file', '-'], blockWithTokens)
  process.stdout.write(`[vinaya archive] provenance block posted to PR #${pr.number}.\n`)

  if (dangling.length > 0) {
    process.stdout.write(`[vinaya archive] DANGLING (${dangling.length}): ${dangling.join('; ')}\n`)
  }
  if (tokensResult.dangling !== null) {
    process.stdout.write(`[vinaya archive] DANGLING (tokens): ${tokensResult.dangling}\n`)
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
// tranche is complete and its own task Issues are attached to a Milestone
// (never a Milestone titled exactly the slug, the retired legacy
// assumption), writes the retrospective into that Milestone's
// description and closes it only when no other task in it is still open.
// --yes skips the confirm prompt, same convention as init/eject/upgrade.
// ---------------------------------------------------------------------------

type Milestone = { number: number; title: string; description: string | null }
type TaskMilestoneRef = { number: number; title: string }
type LabeledIssueRef = { number: number; title: string; state: 'OPEN' | 'CLOSED'; milestone: TaskMilestoneRef | null }
type TaskPrForRetrospective = { number: number; comments: { body: string }[] }

/** GitHub's own page-size ceiling — the size every page of the walk below requests. */
const ISSUES_PER_PAGE = 100

/** Page-count ceiling — reaching it means either a tranche far larger than this model expects, or an endpoint ignoring `page=` and returning a full page forever; both must surface as an error rather than loop forever. */
const ISSUES_MAX_PAGES = 100

/**
 * Every Issue carrying `label`, across as many pages as it takes — never a
 * single capped `--limit` read. A tranche is not itself an Issue and is
 * never deleted, so its Issue count only grows over its life; a fixed cap
 * silently drops the tail once a tranche's task count crosses it, and
 * `trancheArchivalStatus` below would then judge "complete" from a partial
 * Issue set, having never seen the still-open tasks past the cut line.
 *
 * REST (`gh api .../issues`), not `gh issue list --label` (the GraphQL-backed
 * command the archival check used before): the REST endpoint's own `page=`
 * parameter is what lets this walk explicitly to exhaustion rather than
 * trusting a single `--limit` value to be large enough. The endpoint also
 * returns pull requests carrying the label, so each page is filtered to
 * genuine Issues (no `pull_request` field) before counting.
 */
export function fetchTrancheIssuesByLabel(repoFlag: string, label: string): LabeledIssueRef[] {
  const out: LabeledIssueRef[] = []
  const params = new URLSearchParams({ labels: label, state: 'all', per_page: String(ISSUES_PER_PAGE) })
  for (let page = 1; page <= ISSUES_MAX_PAGES; page++) {
    params.set('page', String(page))
    const batch = shJson<
      Array<{
        number: number
        title: string
        state: string
        pull_request?: unknown
        milestone: { number: number; title: string } | null
      }>
    >(['gh', 'api', `repos/${repoFlag}/issues?${params.toString()}`])
    for (const issue of batch) {
      if ('pull_request' in issue) continue
      out.push({
        number: issue.number,
        title: issue.title,
        state: issue.state.toUpperCase() as 'OPEN' | 'CLOSED',
        milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title } : null
      })
    }
    if (batch.length < ISSUES_PER_PAGE) return out
  }
  throw new Error(
    `fetchTrancheIssuesByLabel: "${label}" did not terminate within ${ISSUES_MAX_PAGES} pages (${ISSUES_MAX_PAGES * ISSUES_PER_PAGE} items) — refusing to keep walking.`
  )
}

/**
 * Every Issue in a Milestone's `state`, across as many pages as it takes —
 * never a single capped `--limit` read. `gh issue list` exposes no page
 * cursor flag, so this walks to exhaustion the way that CLI allows: each
 * round re-requests the same query with a `--limit` grown by one page's
 * worth of Issues, and a returned batch shorter than the `--limit` just
 * asked for means the Milestone had no more Issues left to return.
 * `--json state` keeps every request's payload to one small field per
 * Issue, so even the largest re-fetch this loop reaches stays far under
 * the child-process output buffer a full-body Milestone read can overrun.
 */
export function fetchMilestoneIssueStates(
  repoFlag: string,
  milestoneNumber: number
): Array<{ state: 'OPEN' | 'CLOSED' }> {
  for (let page = 1; page <= ISSUES_MAX_PAGES; page++) {
    const limit = page * ISSUES_PER_PAGE
    const batch = shJson<Array<{ state: 'OPEN' | 'CLOSED' }>>([
      'gh',
      'issue',
      'list',
      '-R',
      repoFlag,
      '--milestone',
      String(milestoneNumber),
      '--state',
      'all',
      '--json',
      'state',
      '--limit',
      String(limit)
    ])
    if (batch.length < limit) return batch
  }
  throw new Error(
    `fetchMilestoneIssueStates: milestone #${milestoneNumber} did not terminate within ${ISSUES_MAX_PAGES} pages (${ISSUES_MAX_PAGES * ISSUES_PER_PAGE} items) — refusing to keep walking.`
  )
}

/**
 * The Milestone this tranche's own task Issues are actually attached to —
 * never a Milestone titled exactly the slug. Several
 * tranches can legitimately share one Milestone whose title names neither —
 * reading it off the Issues themselves is the only way to find the right
 * one. `null` when no Issue in the tranche carries a Milestone at all —
 * nothing to write a retrospective into.
 */
export function resolveTaskMilestone(issues: readonly LabeledIssueRef[]): TaskMilestoneRef | null {
  for (const issue of issues) {
    if (issue.milestone) return issue.milestone
  }
  return null
}

/**
 * The highest Developer round marker (`<!-- aeg:developer:round-<n> -->`,
 * `@attalabs/aeg-core`'s `parseDeveloperRoundMarker`) posted on a merged
 * task PR — `1` when none is found, since a task that merged on its first
 * round never had a reason to post one.
 */
export function roundsForTaskPr(pr: TaskPrForRetrospective): number {
  let max = 0
  for (const c of pr.comments) {
    const n = parseDeveloperRoundMarker(c.body)
    if (n !== null && n > max) max = n
  }
  return max || 1
}

/**
 * The `### Retrospective: <slug>` section `archive tranche` appends to the
 * Milestone description once a tranche is complete — task count, rounds per
 * task, and the merged PR list. Pure: takes the tranche's merged task
 * PRs (each with its own comments, for `roundsForTaskPr`) and renders the
 * section text; never writes anywhere itself.
 */
export function renderRetrospectiveSection(slug: string, taskPrs: TaskPrForRetrospective[]): string {
  const roundsList = taskPrs.map((pr) => `#${pr.number} (${roundsForTaskPr(pr)})`).join(', ') || 'none'
  const mergedList = taskPrs.map((pr) => `#${pr.number}`).join(', ') || 'none'
  return [
    `### Retrospective: ${slug}`,
    '',
    `- Tasks: ${taskPrs.length}`,
    `- Rounds per task: ${roundsList}`,
    `- Merged PRs: ${mergedList}`
  ].join('\n')
}

/**
 * Splices `section` into a Milestone description — appended at the end on
 * a first run, or replacing an EXISTING `### Retrospective: <slug>` block
 * in place (up to the next `###` heading or end of description) on a
 * re-run, so re-archiving never duplicates the section.
 */
export function appendRetrospectiveSection(description: string, slug: string, section: string): string {
  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // No `m` flag: `$` must mean the true end of the string, never "before any
  // line terminator" — with `m` set, the lazy `[\s\S]*?` below matched zero
  // characters (the blank line right after the heading already satisfies a
  // multiline `$`), replacing only the heading and leaving the old body
  // stranded underneath the new one. `(^|\n)` stands in for `^` in multiline
  // mode instead, and its capture is restored in the replacement so the
  // separating newline (or true start of description) survives.
  const existing = new RegExp(`(^|\\n)### Retrospective: ${escapedSlug}\\n[\\s\\S]*?(?=\\n### |$)`)
  if (existing.test(description)) {
    return `${description.replace(existing, `$1${section}`).trimEnd()}\n`
  }
  const trimmed = description.trimEnd()
  return `${trimmed}${trimmed.length > 0 ? '\n\n' : ''}${section}\n`
}

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

/** The three lifecycles a tranche can be in, read off the one derivation `@attalabs/aeg-forge-state` owns rather than restated here. */
type TrancheLifecycle = Awaited<ReturnType<typeof deriveTrancheFromForge>>['lifecycle']

export type DeclaredTranche = { slug: string; lifecycle: TrancheLifecycle }

/**
 * Every tranche a Milestone's `### Tranche intents` section declares, with
 * each one's lifecycle derived from its OWN labeled Issues — the same
 * `deriveTrancheFromForge` composition `vinaya milestone status` prints, so
 * "is that tranche done" is answered exactly once in this product, never a
 * second time here.
 *
 * The tranche being archived is `complete` by construction and is never
 * re-fetched: `trancheArchivalStatus` has already proved every Issue
 * carrying its label is closed, and re-deriving it would read a legacy
 * Milestone titled exactly the slug — still open, because closing it is what
 * this command is about to do — as `active`, leaving the tranche blocking
 * its own Milestone forever.
 */
async function declaredTranches(
  owner: string,
  repo: string,
  description: string,
  archivedSlug: string
): Promise<DeclaredTranche[]> {
  const rows: DeclaredTranche[] = []
  for (const intent of intentLines(description)) {
    if (intent.slug === archivedSlug) {
      rows.push({ slug: intent.slug, lifecycle: 'complete' })
      continue
    }
    const tranche = await deriveTrancheFromForge(owner, repo, intent.slug)
    rows.push({ slug: intent.slug, lifecycle: tranche.lifecycle })
  }
  return rows
}

/**
 * Whether this archival may close the Milestone, and — when it may not —
 * every reason it stays open, in the words the prompt and the closing
 * message both print.
 *
 * Two independent holds, because a Milestone is a product goal and a tranche
 * is one slice of it. An attached Issue still open is the older hold (a
 * shared Milestone's other tenants). A tranche the Milestone DECLARES but
 * that has no Issues yet is the second: it is real, `planned` work the
 * Milestone is still committed to, invisible to any count of attached
 * Issues, and closing on that count alone marked most of a product finished
 * the first time a tranche of it completed. `milestoneLifecycleFromTrancheLifecycles`
 * is what reads the declared set — never `.every(...)` inline, whose
 * vacuous truth on an empty list is the same bug in a new place.
 *
 * A Milestone declaring no `### Tranche intents` section at all keeps the
 * older rule untouched: nothing declared, nothing to hold it open. A
 * section present but carrying no line this parser can read is NOT that
 * case — an unreadable declaration is a declaration, and it holds.
 */
export function milestoneCloseDecision(input: {
  otherWorkOpen: boolean
  declaresIntents: boolean
  declared: readonly DeclaredTranche[]
}): { close: true } | { close: false; reasons: string[] } {
  const reasons: string[] = []
  if (input.otherWorkOpen) reasons.push('other tasks remain')
  if (
    input.declaresIntents &&
    milestoneLifecycleFromTrancheLifecycles(input.declared.map((d) => d.lifecycle)) !== 'complete'
  ) {
    const unfinished = input.declared.filter((d) => d.lifecycle !== 'complete')
    reasons.push(
      unfinished.length > 0
        ? `unfinished tranches it declares: ${unfinished.map((d) => `${d.slug} (${d.lifecycle})`).join(', ')}`
        : 'it declares a `### Tranche intents` section with no readable tranche line'
    )
  }
  return reasons.length === 0 ? { close: true } : { close: false, reasons }
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
 * The target Milestone is whatever the tranche's own task
 * Issues are attached to — `resolveTaskMilestone`, never a Milestone titled
 * exactly the slug, since several tranches can share one Milestone whose
 * title names neither. A complete tranche with no
 * Issue attached to any Milestone reports done with nothing to write into,
 * rather than erroring. The Milestone closes only once nothing else inside
 * it is still open — a shared Milestone stays open for its other tenants,
 * carrying this tranche's retrospective already recorded.
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

  const issues = fetchTrancheIssuesByLabel(repoFlag, trancheLabel(slug))
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

  // The target Milestone is whatever the tranche's own task
  // Issues are attached to — never a Milestone titled exactly the slug
  // (the legacy, now-superseded assumption). No Issue in the tranche
  // carrying a Milestone at all means there is nothing to write a
  // retrospective into yet.
  const taskMilestone = resolveTaskMilestone(issues)
  if (!taskMilestone) {
    process.stdout.write(
      `Tranche '${slug}' is complete (${issues.length} task(s), all closed) — no Milestone attached to write a retrospective into.\n`
    )
    return 0
  }
  const milestone = shJson<Milestone>(['gh', 'api', `repos/${repoFlag}/milestones/${taskMilestone.number}`])

  // O7: the Milestone can hold other tranches or backlog tasks — closing
  // it the moment THIS tranche finishes would close out work that is
  // still open. The raw `gh api .../issues?milestone=…` REST call
  // `tranchesAttachedToMilestone` (`@attalabs/aeg-forge-state`) used for
  // this same question returns each Issue's FULL body/labels/etc — a
  // Milestone with more Issues than that call can hold in one response
  // overran `execFileSync`'s default output buffer (`ENOBUFS`) before a
  // single state could be read. `fetchMilestoneIssueStates` below asks for
  // only the one field this check needs (`gh issue list --json state`),
  // the same field-selecting shape already used a few lines up for this
  // tranche's own labeled Issues, so the payload stays small regardless of
  // how many Issues the Milestone holds.
  const milestoneIssues = fetchMilestoneIssueStates(repoFlag, milestone.number)
  const otherWorkOpen = milestoneIssues.some((i) => i.state === 'OPEN')

  // An attached Issue is not the whole of a Milestone's scope: its own
  // `### Tranche intents` section declares tranches that may not have been
  // cut into Issues yet, and those hold it open too.
  const description = milestone.description ?? ''
  const verdict = milestoneCloseDecision({
    otherWorkOpen,
    declaresIntents: hasTrancheIntentsSection(description),
    declared: await declaredTranches(repo.owner, repo.repo, description, slug)
  })

  if (!yes) {
    const prompt = verdict.close
      ? `Close tranche '${slug}''s Milestone (#${milestone.number}, all tasks closed)?`
      : `Record tranche '${slug}''s retrospective in Milestone #${milestone.number} (${verdict.reasons.join('; ')} — leaving it open)?`
    const ok = await promptYesNo(prompt, false)
    closeStdin()
    if (!ok) {
      process.stdout.write('Aborted. Nothing was changed.\n')
      return 0
    }
  }

  // The retrospective: every merged task PR on this tranche's own
  // branch prefix (`task/<slug>/…`), each with its comments so
  // `roundsForTaskPr` can count Developer rounds from the same round
  // marker `roles/developer.md`'s post-open sequence posts. Never an
  // Issue write — the section lands in the Milestone description alone.
  const taskPrs = shJson<TaskPrForRetrospective[]>([
    'gh',
    'pr',
    'list',
    '-R',
    repoFlag,
    '--state',
    'merged',
    '--search',
    `head:task/${slug}/`,
    '--json',
    'number,comments',
    '--limit',
    '200'
  ])
  const section = renderRetrospectiveSection(slug, taskPrs)
  const newDescription = appendRetrospectiveSection(description, slug, section)
  const patch: { description: string; state?: 'closed' } = { description: newDescription }
  if (verdict.close) patch.state = 'closed'
  sh(
    ['gh', 'api', '-X', 'PATCH', `repos/${repoFlag}/milestones/${milestone.number}`, '--input', '-'],
    JSON.stringify(patch)
  )
  process.stdout.write(
    verdict.close
      ? `Tranche '${slug}' closed (Milestone #${milestone.number}), retrospective recorded.\n`
      : `Tranche '${slug}' retrospective recorded in Milestone #${milestone.number} (left open — ${verdict.reasons.join('; ')}).\n`
  )
  return 0
}

export async function archiveTrancheCommand(args: string[]): Promise<void> {
  process.exit(await runArchiveTranche(args, realDeps()))
}

import type { SurfaceExemption } from '../lib/surface-exemption'

export const SURFACE_EXEMPTIONS: Record<string, SurfaceExemption> = {
  archive: { date: '2026-09-05', callsToday: 2, retiresVia: 'collectTokens' },
  'archive tranche': { date: '2026-09-05', callsToday: 3, retiresVia: 'collectTokens' }
}
