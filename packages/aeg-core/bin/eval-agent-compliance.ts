#!/usr/bin/env bun

/**
 * eval-agent-compliance — offline eval harness (vinaya-verification-v1
 * task 9, #37). Replays a live sample of this repo's own closed, merged
 * `task/*` PRs through three pure AEG gates and reports how often each gate
 * would have agreed with the PR's real historical outcome.
 *
 * Read-only, never cached: the corpus (PR bodies, labels, commits, comments,
 * linked Issue bodies) is re-fetched via `gh` on every run, and the premise
 * gate replays against the PR's merge-commit tree via local `git show` — no
 * corpus file, golden set, or report is ever written to disk (Issue #37's
 * "no committed report/scratch files" boundary).
 *
 * Gates replayed, all graded against the PR's FINAL merged state (Issue #37's
 * "Traps to avoid": a gate refusing an early draft is normal iteration, not
 * the signal this harness measures):
 *   - brief-shape    — `checkBriefSections`, the same composition
 *                       `bin/verify-brief.ts --body-file` runs, against the
 *                       PR body as merged.
 *   - issue-rationale — `checkIssueRationale` against the body of the Issue
 *                       the PR's `Closes #N` references.
 *   - premise         — `parsePremiseBlock` + `checkPremises`, re-asserted
 *                       against the PR's merge-commit tree (the shipped diff
 *                       a fresh `Premise:` block asserts facts about, per
 *                       `aeg-root/templates/pr-report-template.md` — not the
 *                       brief's original pre-fix pins), when the PR body
 *                       carries a `Premise:` block.
 * A gate that has nothing to check for a given PR (no linked Issue resolved,
 * no `Premise:` block, no merge commit available locally) is excluded from
 * that PR, not scored as a pass or a fail.
 *
 * Historical outcome, per PR:
 *   - waived  — the PR carries any `vinaya/waiver:*` label.
 *   - rework  — a commit landed after the earliest reviewer `VERDICT:`
 *               comment (this repo's code-review/security bots post verdicts
 *               as PR comments, not native GitHub reviews).
 *   - clean   — neither of the above.
 *
 * Metrics printed: per-gate false-positive rate (gate failed a PR that
 * merged clean), per-gate false-negative rate (gate passed a PR that needed
 * rework), and the corpus's first-try-green rate (fraction of the sample
 * that merged clean) — a property of the corpus, not of any one gate.
 */

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { resolveRepo } from '@attalabs/aeg-forge-state'
import {
  checkBriefSections,
  checkIssueRationale,
  checkPremises,
  extractClosesReferences,
  isTaskBranch,
  parsePremiseBlock,
  readTierFromPrBody
} from '../src/index'
import type { PremiseAssertion } from '../src/index'

const REPO_ROOT = join(import.meta.dirname, '../../..')
process.chdir(REPO_ROOT)

const DEFAULT_SAMPLE = 20
const GH_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateId = 'brief-shape' | 'issue-rationale' | 'premise'
export const GATE_IDS: GateId[] = ['brief-shape', 'issue-rationale', 'premise']

export type GateVerdict = {
  applicable: boolean
  pass: boolean
  errors: string[]
  note?: string
}

export type Outcome = 'clean' | 'rework' | 'waived'

export type PrComment = { body: string; createdAt: string }
export type PrCommit = { committedDate: string }

/** Raw shape of `gh pr view --json ...` — the fields this harness reads. */
export type PrDetailRaw = {
  number: number
  headRefName: string
  title: string
  body: string
  labels: Array<{ name: string }>
  mergedAt: string
  mergeCommit: { oid: string } | null
  commits: PrCommit[]
  comments: PrComment[]
}

export type PrFacts = {
  number: number
  headRefName: string
  title: string
  body: string
  labels: string[]
  mergedAt: string
  mergeCommitOid: string | null
  reviewActivityAt: string | null
  followUpCommits: number
  issueNumber: number | null
}

export type EvalRow = {
  facts: PrFacts
  issueBody: string | null
  outcome: Outcome
  gates: Record<GateId, GateVerdict>
}

export type GateRates = {
  gate: GateId
  applicableSamples: number
  cleanSamples: number
  reworkSamples: number
  falsePositives: number
  falseNegatives: number
  falsePositiveRate: number | null
  falseNegativeRate: number | null
}

export type EvalReport = {
  totalSamples: number
  outcomeCounts: { clean: number; rework: number; waived: number }
  gateRates: GateRates[]
  firstTryGreenCount: number
  firstTryGreenRate: number | null
}

// ---------------------------------------------------------------------------
// Pure: historical-outcome signals
// ---------------------------------------------------------------------------

const WAIVER_LABEL_PATTERN = /^vinaya\/waiver:/
const VERDICT_COMMENT_PATTERN = /^VERDICT:/m

/** Earliest timestamp among comments carrying this repo's `VERDICT: ...` line (code-review/security bot verdicts posted as comments, not native GitHub reviews). */
export function firstReviewActivityAt(comments: PrComment[]): string | null {
  const verdictTimestamps = comments.filter((c) => VERDICT_COMMENT_PATTERN.test(c.body)).map((c) => c.createdAt)
  if (verdictTimestamps.length === 0) return null
  return verdictTimestamps.sort()[0] ?? null
}

/** Commits committed strictly after `reviewAt` — the retry-evidence signal. `null` (no review activity found) means no evidence either way. */
export function countFollowUpCommits(commits: PrCommit[], reviewAt: string | null): number {
  if (reviewAt === null) return 0
  return commits.filter((c) => c.committedDate > reviewAt).length
}

export function classifyOutcome(facts: Pick<PrFacts, 'labels' | 'followUpCommits'>): Outcome {
  if (facts.labels.some((l) => WAIVER_LABEL_PATTERN.test(l))) return 'waived'
  if (facts.followUpCommits > 0) return 'rework'
  return 'clean'
}

/** Assembles `PrFacts` from a raw `gh pr view` payload — pure, no I/O. */
export function toPrFacts(raw: PrDetailRaw): PrFacts {
  const labels = raw.labels.map((l) => l.name)
  const reviewActivityAt = firstReviewActivityAt(raw.comments)
  const followUpCommits = countFollowUpCommits(raw.commits, reviewActivityAt)
  const closesRefs = [...extractClosesReferences(raw.body)]
  const issueNumber = closesRefs.length > 0 ? Math.min(...closesRefs) : null
  return {
    number: raw.number,
    headRefName: raw.headRefName,
    title: raw.title,
    body: raw.body,
    labels,
    mergedAt: raw.mergedAt,
    mergeCommitOid: raw.mergeCommit?.oid ?? null,
    reviewActivityAt,
    followUpCommits,
    issueNumber
  }
}

// ---------------------------------------------------------------------------
// Pure: gate replay
// ---------------------------------------------------------------------------

/**
 * Replays the three §2 gates against one PR's facts. `premiseFileReader` is
 * injected so this stays pure and offline-testable: `null` means the merge
 * commit could not be read locally (the premise gate is then not-applicable,
 * distinct from "no `Premise:` block" but reported the same way — a gate
 * with nothing it could check).
 */
export function runGates(
  facts: PrFacts,
  issueBody: string | null,
  premiseFileReader: ((path: string) => string | null) | null
): Record<GateId, GateVerdict> {
  const briefErrors = checkBriefSections(facts.body, readTierFromPrBody, {
    requireClosesN: isTaskBranch(facts.headRefName)
  }).errors
  const briefShape: GateVerdict = { applicable: true, pass: briefErrors.length === 0, errors: briefErrors }

  let issueRationale: GateVerdict
  if (issueBody === null) {
    issueRationale = {
      applicable: false,
      pass: true,
      errors: [],
      note: facts.issueNumber === null ? 'no Closes #N reference found' : 'linked Issue body unavailable'
    }
  } else {
    const r = checkIssueRationale(issueBody)
    issueRationale = { applicable: true, pass: r.status === 'pass', errors: r.errors }
  }

  const assertions: PremiseAssertion[] = parsePremiseBlock(facts.body)
  let premise: GateVerdict
  if (assertions.length === 0) {
    premise = { applicable: false, pass: true, errors: [], note: 'no Premise: block in the PR body' }
  } else if (premiseFileReader === null) {
    premise = {
      applicable: false,
      pass: true,
      errors: [],
      note: 'merge commit unavailable locally — cannot replay offline'
    }
  } else {
    const r = checkPremises(assertions, premiseFileReader)
    premise = { applicable: true, pass: r.pass, errors: r.failures }
  }

  return { 'brief-shape': briefShape, 'issue-rationale': issueRationale, premise }
}

// ---------------------------------------------------------------------------
// Pure: rate computation
// ---------------------------------------------------------------------------

export function computeRates(rows: EvalRow[]): EvalReport {
  const gateRates: GateRates[] = GATE_IDS.map((gate) => {
    const applicableRows = rows.filter((r) => r.gates[gate].applicable)
    const cleanRows = applicableRows.filter((r) => r.outcome === 'clean')
    const reworkRows = applicableRows.filter((r) => r.outcome === 'rework')
    const falsePositives = cleanRows.filter((r) => !r.gates[gate].pass).length
    const falseNegatives = reworkRows.filter((r) => r.gates[gate].pass).length
    return {
      gate,
      applicableSamples: applicableRows.length,
      cleanSamples: cleanRows.length,
      reworkSamples: reworkRows.length,
      falsePositives,
      falseNegatives,
      falsePositiveRate: cleanRows.length > 0 ? falsePositives / cleanRows.length : null,
      falseNegativeRate: reworkRows.length > 0 ? falseNegatives / reworkRows.length : null
    }
  })

  const outcomeCounts = {
    clean: rows.filter((r) => r.outcome === 'clean').length,
    rework: rows.filter((r) => r.outcome === 'rework').length,
    waived: rows.filter((r) => r.outcome === 'waived').length
  }

  return {
    totalSamples: rows.length,
    outcomeCounts,
    gateRates,
    firstTryGreenCount: outcomeCounts.clean,
    firstTryGreenRate: rows.length > 0 ? outcomeCounts.clean / rows.length : null
  }
}

// ---------------------------------------------------------------------------
// I/O: argv, `gh`/`git` shims
// ---------------------------------------------------------------------------

export type ParsedArgs = { sample: number; json: boolean }

export function parseArgs(argv: string[]): ParsedArgs {
  let sample = DEFAULT_SAMPLE
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--sample') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Usage: --sample <positive integer> (got ${argv[i]})`)
      }
      sample = value
    } else if (arg === '--json') {
      json = true
    }
  }
  return { sample, json }
}

function ghJson<T>(args: string[]): T {
  const out = execFileSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out) as T
}

type PrListItem = { number: number; headRefName: string; mergedAt: string | null }

/** Newest-first merged `task/*` PRs, capped at `sampleSize`. Fetches a wider window than `sampleSize` since not every merged PR is a task PR. */
function fetchMergedTaskPrs(repoFlag: string, sampleSize: number): PrListItem[] {
  const fetchLimit = Math.max(sampleSize * 5, 100)
  const all = ghJson<PrListItem[]>([
    'pr',
    'list',
    '--state',
    'merged',
    '--limit',
    String(fetchLimit),
    '--json',
    'number,headRefName,mergedAt',
    '-R',
    repoFlag
  ])
  return all
    .filter((p) => p.headRefName.startsWith('task/') && p.mergedAt !== null)
    .sort((a, b) => (b.mergedAt as string).localeCompare(a.mergedAt as string))
    .slice(0, sampleSize)
}

function fetchPrDetail(repoFlag: string, number: number): PrDetailRaw {
  return ghJson<PrDetailRaw>([
    'pr',
    'view',
    String(number),
    '-R',
    repoFlag,
    '--json',
    'number,headRefName,title,body,labels,mergedAt,mergeCommit,commits,comments'
  ])
}

function fetchIssueBody(repoFlag: string, issueNumber: number): string | null {
  try {
    return ghJson<{ body: string }>(['issue', 'view', String(issueNumber), '-R', repoFlag, '--json', 'body']).body
  } catch {
    return null
  }
}

function commitAvailableLocally(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: ['ignore', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/** Reads a path's content as of `sha` via local `git show` — no network, no working-tree mutation. `null` when the path doesn't exist at that commit. */
function makeFileReaderAt(sha: string): (path: string) => string | null {
  return (path: string) => {
    try {
      return execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const METHODOLOGY = [
  'Corpus: merged PRs whose head branch matches `task/*`, newest by mergedAt first, capped at --sample. Re-fetched live via `gh` every run — never cached to disk.',
  "Gates replayed against the PR's FINAL merged state: brief-shape (checkBriefSections, the composition bin/verify-brief.ts --body-file runs, against the PR body); issue-rationale (checkIssueRationale against the body of the Issue the PR Closes); premise (parsePremiseBlock + checkPremises, re-asserted against the PR merge-commit tree via local `git show` — the shipped diff a fresh Premise: block asserts facts about — only when the PR body carries a Premise: block).",
  'A gate with nothing to check for a PR (no resolvable linked Issue, no Premise: block, no merge commit available locally) is excluded from that PR — not scored pass or fail.',
  'Historical outcome per PR: waived (carries a vinaya/waiver:* label) > rework (a commit landed after the earliest reviewer `VERDICT:` comment — this repo posts review verdicts as PR comments, not native GitHub reviews) > clean.',
  '"Would have blocked" = the gate returns fail replayed against the PR\'s merged body/diff. "Needed rework" is approximated by the outcome above, not by inspecting every intermediate commit.',
  'False-positive rate (per gate) = (gate failed) / (clean PRs the gate applies to). False-negative rate (per gate) = (gate passed) / (rework PRs the gate applies to).',
  'First-try-green rate = clean PRs / total sampled PRs — a property of the corpus itself, not of any one gate.'
].join('\n')

function printPlainReport(report: EvalReport, rows: EvalRow[], repoFlag: string, requestedSample: number): void {
  console.log('[eval-agent-compliance] Offline agent-compliance eval\n')
  console.log(`Repo: ${repoFlag}`)
  console.log(`Requested sample: ${requestedSample}, usable sample: ${report.totalSamples}\n`)
  console.log('Methodology:')
  console.log(METHODOLOGY)
  console.log('')

  if (report.totalSamples < 3) {
    console.log(
      `WARNING: only ${report.totalSamples} usable merged task/* PR(s) — too thin to compute a meaningful rate. Reporting what exists rather than inventing data.\n`
    )
  }

  console.log('Per-PR:')
  for (const row of rows) {
    const gateSummary = GATE_IDS.map((g) => {
      const v = row.gates[g]
      if (!v.applicable) return `${g}=n/a`
      return `${g}=${v.pass ? 'pass' : 'FAIL'}`
    }).join(' ')
    console.log(`  #${row.facts.number} (${row.facts.headRefName}) outcome=${row.outcome} ${gateSummary}`)
  }
  console.log('')

  console.log(
    `Outcome counts: clean=${report.outcomeCounts.clean} rework=${report.outcomeCounts.rework} waived=${report.outcomeCounts.waived}\n`
  )

  console.log('Per-gate rates:')
  for (const gr of report.gateRates) {
    const fp = gr.falsePositiveRate === null ? 'n/a' : `${(gr.falsePositiveRate * 100).toFixed(1)}%`
    const fn = gr.falseNegativeRate === null ? 'n/a' : `${(gr.falseNegativeRate * 100).toFixed(1)}%`
    console.log(
      `  ${gr.gate}: applicable=${gr.applicableSamples} false-positive-rate=${fp} (${gr.falsePositives}/${gr.cleanSamples} clean) false-negative-rate=${fn} (${gr.falseNegatives}/${gr.reworkSamples} rework)`
    )
  }
  console.log('')

  const green = report.firstTryGreenRate === null ? 'n/a' : `${(report.firstTryGreenRate * 100).toFixed(1)}%`
  console.log(`First-try-green rate: ${green} (${report.firstTryGreenCount}/${report.totalSamples})`)
}

function printJsonReport(report: EvalReport, rows: EvalRow[], repoFlag: string, requestedSample: number): void {
  console.log(
    JSON.stringify(
      {
        methodology: METHODOLOGY,
        repo: repoFlag,
        requestedSample,
        rows: rows.map((r) => ({
          number: r.facts.number,
          headRefName: r.facts.headRefName,
          outcome: r.outcome,
          gates: r.gates
        })),
        ...report
      },
      null,
      2
    )
  )
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[eval-agent-compliance] ${(err as Error).message}`)
    process.exit(1)
  }

  const repo = await resolveRepo()
  if (!repo) {
    console.error('[eval-agent-compliance] could not resolve a GitHub repo (set AEG_REPO or check `git remote`).')
    process.exit(1)
  }
  const repoFlag = `${repo.owner}/${repo.repo}`

  let corpus: PrListItem[]
  try {
    corpus = fetchMergedTaskPrs(repoFlag, args.sample)
  } catch (err) {
    console.error(
      `[eval-agent-compliance] could not fetch the merged-PR corpus via \`gh pr list\`: ${(err as Error).message}`
    )
    process.exit(1)
  }

  const rows: EvalRow[] = []
  for (const item of corpus) {
    try {
      const raw = fetchPrDetail(repoFlag, item.number)
      const facts = toPrFacts(raw)
      const issueBody = facts.issueNumber !== null ? fetchIssueBody(repoFlag, facts.issueNumber) : null
      const premiseFileReader =
        facts.mergeCommitOid !== null && commitAvailableLocally(facts.mergeCommitOid)
          ? makeFileReaderAt(facts.mergeCommitOid)
          : null
      const gates = runGates(facts, issueBody, premiseFileReader)
      const outcome = classifyOutcome(facts)
      rows.push({ facts, issueBody, outcome, gates })
    } catch (err) {
      console.error(`[eval-agent-compliance] skipping PR #${item.number}: ${(err as Error).message}`)
    }
  }

  const report = computeRates(rows)

  if (args.json) {
    printJsonReport(report, rows, repoFlag, args.sample)
  } else {
    printPlainReport(report, rows, repoFlag, args.sample)
  }

  process.exit(0)
}

if (import.meta.main) {
  await main()
}
