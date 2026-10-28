/**
 * The whole-loop runner: one `whole-loop.l6` case, end to end, through a real
 * `vinaya task run` against the disposable sandbox repository the freeze
 * record names, on one backend, flow and adapter, graded by the six loop
 * graders.
 *
 *  1. **Refusals, before any write.** The sandbox must be the freeze record's,
 *     never `atta-labs/vinaya`, private, writable by the forge login, and hold
 *     no open Issue or pull request; `v2` runs on the Engine backend only; a
 *     held-out case needs the held-out approval; the loaded case must target
 *     the sandbox, and the sandbox must hold its base commit.
 *  2. **The trial.** The sandbox's `main` is force-updated to the case's base
 *     commit (both runners base the task branch and its pull request on
 *     `main`), then cloned with `--single-branch --branch main --no-tags`, so
 *     the clone holds the base commit's history and nothing else; a clone
 *     holding any other ref or commit is refused before the Issue opens. The
 *     trial's Issue is the renderer's brief plus the fields the Issue grammar
 *     needs, and one `task run --issue <n>` starts in the clone with this
 *     tree's CLI, `AEG_REPO` and `GH_REPO` naming the sandbox, and a fresh
 *     runtime directory whose Log goes to a folder. A run that pauses for a
 *     ruling is stopped and recorded, never passed.
 *  3. **The record.** Built from the forge and the clone alone: the pull
 *     request (`gh pr view --json number,state,headRefOid,statusCheckRollup,
 *     reviews,body,comments`), the change measured in the clone, the checks on
 *     the head, the latest verdict of each reviewer, the ready-for-merge
 *     publication, the effects the comments show, and the hidden tests run in
 *     a grading copy of the final head. The trial's pull request and Issue are
 *     then closed unmerged.
 *  4. **The result.** The six graders' verdicts, with the case, split,
 *     backend, flow, adapter, attempt, ready-gate state, rounds, wall time and
 *     the tokens the run's Log reported. A held-out case is printed by its id
 *     alone, and its verdicts carry no reason.
 *
 * Every forge and process step is a port (`WholeLoopDeps`), so the whole
 * runner is driven in tests by a fake forge, a local repository and a fake
 * task run.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  issueBranchName,
  PUBLISHED_MARKER_LINE,
  type VerdictExtraction
} from '@attalabs/aeg-core'
import { NO_LOCAL_TESTS_MARKER } from '../pre-push-test-runner'
import type { ReviewerRole } from '../review-result'
import { PROTECTED_REPOSITORY, REPOSITORY_NAME } from './freeze-record'
import { GENERIC_GRADERS } from './generic-graders'
import { type NeutralCase, validateNeutralCase } from './neutral-case'
import type { TestResult } from './neutral-outcomes'
import { git, runGit, safeRelativePath } from './staging'
import { PRODUCTION_VINAYA_PROCESS_STEPS, STEP_ONE_ADAPTERS, type StepOneAdapter, stepOneWorkRoot } from './step-one'
import {
  extractOutcomes,
  type RecordedReview,
  renderCase,
  type VinayaProcessInput,
  type VinayaTrialRecord
} from './vinaya-renderer'

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const WHOLE_LOOP_SUITE = 'whole-loop.l6'
export const WHOLE_LOOP_BACKENDS = ['standalone', 'engine'] as const
export type WholeLoopBackend = (typeof WHOLE_LOOP_BACKENDS)[number]
export const WHOLE_LOOP_FLOWS = ['v1', 'v2'] as const
export type WholeLoopFlow = (typeof WHOLE_LOOP_FLOWS)[number]
export const WHOLE_LOOP_ADAPTERS = STEP_ONE_ADAPTERS
export type WholeLoopSplit = 'development' | 'held-out'

/** Each backend's `task run --runner` value. */
export const RUNNER_FLAG: Readonly<Record<WholeLoopBackend, string>> = {
  standalone: 'standalone',
  engine: 'atta-engine'
}
/** Each adapter's `task run --agent` value. */
export const AGENT_FLAG: Readonly<Record<StepOneAdapter, string>> = { 'claude-code': 'claude', codex: 'codex' }
/** The flows each backend runs: the standalone loop runs `v1` only. */
export const BACKEND_FLOWS: Readonly<Record<WholeLoopBackend, readonly WholeLoopFlow[]>> = {
  standalone: ['v1'],
  engine: ['v1', 'v2']
}

/** The six generic graders the whole loop passes on, in report order (evaluation program §6.18). */
export const WHOLE_LOOP_GRADER_IDS = [
  'generic-hidden-tests',
  'generic-scope-kept',
  'generic-review-bound',
  'generic-decision-bound',
  'generic-change-bound',
  'generic-effects-once'
] as const
export const WHOLE_LOOP_GRADERS = WHOLE_LOOP_GRADER_IDS.map((id) => {
  const grader = GENERIC_GRADERS.find((g) => g.identity.id === id)
  if (grader === undefined) throw new Error(`no generic grader ${id}`)
  return grader
})

/** The forge permissions that can open Issues, push branches and move `main`. */
const WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])
/** Pauses the driver lifts on its own after a bounded backoff; every other pause waits on a ruling. */
const SELF_RESUMING_PAUSES = new Set(['infrastructure', 'stale_driver'])
const PAUSE_MARKER = /<!--\s*aeg:loop:paused:([a-z_]+)\s*-->/i
const DEVELOPER_ROUND_MARKER = /<!--\s*aeg:developer:round-(\d+)\s*-->/gi
/** A check conclusion that is not a failure, the set the driver's own check reading counts as green. */
const PASSING_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const PENDING_CHECK_STATES = new Set(['', 'PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Git against the sandbox remote — the trial clone and its fetches — with the
 * operator's own environment, which holds the forge credentials; every read
 * of the clone's own objects goes through the harness `git`/`runGit` instead.
 */
function sandboxGit(cwd: string, args: readonly string[]): { status: number; stderr: string } {
  const run = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: run.status ?? 1, stderr: run.stderr ?? '' }
}

// ── Ports ───────────────────────────────────────────────────────────────────

/** One Issue or pull request comment, as `gh … --json comments` returns it. */
export interface ForgeComment {
  body: string
  url: string
  author: { login: string } | null
}

/** One entry of a pull request's `statusCheckRollup`: a check run (`name`, `status`, `conclusion`) or a status (`context`, `state`). */
export interface RollupEntry {
  name?: string
  context?: string
  status?: string | null
  conclusion?: string | null
  state?: string | null
}

/** The pull request as `gh pr view --json number,state,headRefOid,statusCheckRollup,reviews,body,comments` returns it. */
export interface ForgePullRequest {
  number: number
  state: string
  headRefOid: string
  statusCheckRollup: RollupEntry[]
  reviews: unknown[]
  body: string
  comments: ForgeComment[]
}

/** Every forge read and write the runner makes; each call names the repository it acts on. */
export interface WholeLoopForge {
  /** `gh repo view <repo> --json nameWithOwner,visibility,viewerPermission`; `null` when the login cannot see it. */
  repository(repo: string): { nameWithOwner: string; visibility: string; viewerPermission: string } | null
  /** The forge login the runner acts as. */
  login(): string
  /** The numbers of the repository's open Issues and open pull requests. */
  openItems(repo: string): { issues: number[]; pullRequests: number[] }
  /** Whether the repository holds this commit. */
  commitExists(repo: string, commit: string): boolean
  /** Force-updates the repository's `main` to the commit. */
  moveMain(repo: string, commit: string): void
  createIssue(repo: string, title: string, body: string): number
  issueComments(repo: string, issue: number): ForgeComment[]
  /** The newest pull request whose head is the branch, or `null` when none was opened. */
  pullRequestFor(repo: string, branch: string): ForgePullRequest | null
  closePullRequest(repo: string, pullRequest: number): void
  closeIssue(repo: string, issue: number): void
}

/** A started task run: its exit, and a stop that ends its whole process group. */
export interface TaskRunHandle {
  exited: Promise<number>
  stop(): Promise<void>
}

export interface TaskRunRequest {
  /** The CLI entry the run is started with: this tree's, never the base commit's. */
  cli: string
  argv: string[]
  cwd: string
  env: Record<string, string>
}

export interface HiddenTestRequest {
  neutralCase: NeutralCase
  split: WholeLoopSplit
  /** The trial clone, holding the final head. */
  clone: string
  head: string
  /** An empty directory the grading copy may be made in. */
  workDirectory: string
  timeoutMs: number
}

export interface WholeLoopDeps {
  forge: WholeLoopForge
  /** The git URL the trial clone fetches the sandbox from. */
  remoteUrl(repo: string): string
  /** The sandbox repository the committed freeze record names. */
  freezeRecordSandbox(): string
  /** The suite's cases of one split, targeted at the sandbox; a held-out split opens only for its approval. */
  loadCases(split: WholeLoopSplit, approval: string | undefined, sandbox: string): Promise<NeutralCase[]>
  startTaskRun(request: TaskRunRequest): TaskRunHandle
  runHiddenTests(request: HiddenTestRequest): Promise<TestResult[]>
  /** The directory each trial's own folder is made under. */
  workRoot(): string
  now(): number
  sleep(ms: number): Promise<void>
  log(line: string): void
}

// ── Options and results ─────────────────────────────────────────────────────

export interface WholeLoopOptions {
  caseId: string
  split: WholeLoopSplit
  /** The pinned held-out digest; required for a held-out case. */
  heldOutApproval?: string
  backend: string
  flow: string
  adapter: string
  attempt: number
  /** The sandbox repository, `owner/name`. */
  sandbox: string
  resultPath: string
  model?: string
  /** The `**Project:**` the trial Issue declares. */
  project?: string
  /** Longest a task run may take before it is stopped and recorded as timed out. */
  runTimeoutMs?: number
  /** Longest the runner waits for the pull request's checks to settle. */
  checksSettleMs?: number
  pollMs?: number
  hiddenTestTimeoutMs?: number
}

export type WholeLoopRefusalCode =
  | 'bad_option'
  | 'protected_repository'
  | 'wrong_sandbox'
  | 'held_out_unapproved'
  | 'unknown_case'
  | 'case_not_in_sandbox'
  | 'unrenderable_case'
  | 'sandbox_unreadable'
  | 'sandbox_public'
  | 'no_write_login'
  | 'open_trial'
  | 'base_commit_missing'
  | 'clone_not_isolated'

export interface WholeLoopRefusal {
  code: WholeLoopRefusalCode
  detail: string
}

export type ReadyGateState = 'no-local-tests' | 'local-tests' | 'not-reached'
export type RunEnd =
  | { kind: 'ready-for-merge' }
  | { kind: 'exited'; code: number }
  | { kind: 'paused'; reason: string }
  | { kind: 'timed-out' }

export interface WholeLoopVerdict {
  verdict: 'pass' | 'fail' | 'unknown'
  /** Why it failed; never written for a held-out case. */
  reason?: string
}

export interface WholeLoopResult {
  schemaVersion: 1
  suite: typeof WHOLE_LOOP_SUITE
  caseId: string
  split: WholeLoopSplit
  backend: WholeLoopBackend
  flow: WholeLoopFlow
  adapter: StepOneAdapter
  attempt: number
  rendererVersion: string
  sandbox: { repository: string; issue: number; pullRequest: number | null }
  end: RunEnd
  readyGate: ReadyGateState
  /** Every grader passed. */
  passed: boolean
  verdicts: Record<(typeof WHOLE_LOOP_GRADER_IDS)[number], WholeLoopVerdict>
  /** The highest Developer round the pull request's round markers show; `null` with no marker. */
  rounds: number | null
  wallTimeMs: number
  /** The tokens the run's Log reported, summed over its dispatches; `null` when it reported none. */
  tokens: { input: number; output: number } | null
}

export type WholeLoopOutcome = { ok: true; result: WholeLoopResult } | { ok: false; refusal: WholeLoopRefusal }

class Refused extends Error {
  constructor(readonly refusal: WholeLoopRefusal) {
    super(refusal.detail)
  }
}

function refuse(code: WholeLoopRefusalCode, detail: string): never {
  throw new Refused({ code, detail })
}

// ── Pure pieces ─────────────────────────────────────────────────────────────

/** A loaded case, targeted at the sandbox: the committed cases name the repository they were cut from. */
export function targetSandbox(c: NeutralCase, sandbox: string): NeutralCase {
  return { ...c, repository: sandbox } as NeutralCase
}

/** The `task run` arguments, after the CLI entry, for one trial. */
export function taskRunArgv(input: {
  issue: number
  backend: WholeLoopBackend
  flow: WholeLoopFlow
  adapter: StepOneAdapter
  model?: string
}): string[] {
  return [
    'task',
    'run',
    '--issue',
    String(input.issue),
    '--agent',
    AGENT_FLAG[input.adapter],
    '--runner',
    RUNNER_FLAG[input.backend],
    '--flow',
    input.flow,
    ...(input.model === undefined ? [] : ['--model', input.model])
  ]
}

/**
 * The task run's environment: the caller's, with `AEG_REPO` and `GH_REPO`
 * naming the sandbox (`AEG_REPO` wins over the `origin` remote when the CLI
 * resolves its repository), a fresh runtime directory, and the Log written to
 * a folder there, never to a server.
 */
export function taskRunEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  sandbox: string,
  runtimeDirectory: string
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  return {
    ...env,
    AEG_REPO: sandbox,
    GH_REPO: sandbox,
    VINAYA_RUNTIME_DIR: runtimeDirectory,
    VINAYA_LOG_FOLDER_ONLY: '1'
  }
}

/** What a trial Issue's Documentation line says each required source governs. */
const DOCUMENTATION_MECHANISM = 'a document delivered with this task, which the objective relies on'

/**
 * The trial Issue body: the renderer's brief, with its Documentation lines in
 * the Issue grammar's `- <source> — <mechanism> (O1)` form (`None` when it
 * requires none), plus only what the grammar requires and the renderer does
 * not emit — `**Project:**` and `**Tier:**` in the header, `## Parts`,
 * `## Test plan` and `## Stop conditions`.
 */
export function trialIssueBody(input: VinayaProcessInput, project = 'cli'): string {
  const lines = input.brief.split('\n')
  const firstSection = lines.findIndex((line) => line.startsWith('## '))
  const header = lines.slice(0, firstSection).filter((line) => line !== '')
  const sections = lines.slice(firstSection).join('\n')
  const required = input.sources.filter((source) => source.required)
  const documentation = [
    '## Documentation',
    '',
    ...(required.length === 0
      ? ['None']
      : required.map((source) => `- ${source.sourceId} — ${DOCUMENTATION_MECHANISM} (O1)`)),
    ''
  ].join('\n')
  const withDocumentation = sections.replace(/^## Documentation\n[\s\S]*?(?=^## |(?![\s\S]))/m, `${documentation}\n`)
  return [
    ...header,
    `**Project:** ${project}`,
    '**Tier:** 1',
    '',
    withDocumentation.trimEnd(),
    '',
    '## Parts',
    '',
    'Part 1 (O1) — the change the objective states, published as one pull request',
    '',
    '## Test plan',
    '',
    'Test plan: unit-tests-only',
    '',
    '## Stop conditions',
    '',
    '- The objective contradicts the code at the base commit in a way only the Principal can resolve.',
    '- A test still fails after genuine diagnosis.',
    ''
  ].join('\n')
}

/** A rollup entry's conclusion, as the renderer reads a check. */
export function checkConclusion(entry: RollupEntry): 'success' | 'failure' | 'pending' {
  if (entry.status != null && entry.status.toUpperCase() !== 'COMPLETED') return 'pending'
  const state = (entry.conclusion ?? entry.state ?? '').toUpperCase()
  if (PASSING_CHECK_STATES.has(state)) return 'success'
  if (PENDING_CHECK_STATES.has(state)) return 'pending'
  return 'failure'
}

/** The pause a comment carries that waits on a ruling, or `null`. */
export function rulingPauseOf(comments: readonly ForgeComment[]): string | null {
  for (const comment of [...comments].reverse()) {
    const reason = PAUSE_MARKER.exec(comment.body)?.[1]?.toLowerCase()
    if (reason !== undefined) return SELF_RESUMING_PAUSES.has(reason) ? null : reason
  }
  return null
}

/** The ready-gate state the pull request's Evidence block records. */
export function readyGateOf(pullRequest: ForgePullRequest | null, published: boolean): ReadyGateState {
  if (pullRequest === null || !published) return 'not-reached'
  const body = pullRequest.body
  if (body.includes(NO_LOCAL_TESTS_MARKER) || /No local tests ran\./.test(body)) return 'no-local-tests'
  return /<!--\s*AEG:EVIDENCE:START\s*-->/.test(body) ? 'local-tests' : 'not-reached'
}

/** The highest Developer round the comments' round markers show; `null` with no marker. */
export function roundsOf(comments: readonly ForgeComment[]): number | null {
  const rounds = comments.flatMap((comment) =>
    [...comment.body.matchAll(DEVELOPER_ROUND_MARKER)].map((m) => Number(m[1]))
  )
  return rounds.length === 0 ? null : Math.max(...rounds)
}

/**
 * The tokens the run's Log reported: the input and output of every
 * dispatch's received outcome, in every `.ndjson` file under the folder.
 * `null` when no dispatch reported usage.
 */
export function tokensReported(logFolder: string): { input: number; output: number } | null {
  if (!existsSync(logFolder)) return null
  let input = 0
  let output = 0
  let seen = false
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith('.ndjson')) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          let event: { kind?: unknown; event?: unknown; usage?: { input?: unknown; output?: unknown } | null }
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event.kind !== 'dispatch' || event.event !== 'outcome_received' || !event.usage) continue
          if (typeof event.usage.input !== 'number' || typeof event.usage.output !== 'number') continue
          input += event.usage.input
          output += event.usage.output
          seen = true
        }
      }
    }
  }
  walk(logFolder)
  return seen ? { input, output } : null
}

// ── The trial record ────────────────────────────────────────────────────────

/** The full commit a possibly short id names in the clone, or the id unchanged. */
function fullCommit(clone: string, id: string): string {
  const resolved = runGit(clone, ['rev-parse', '--verify', '--quiet', `${id}^{commit}`])
  return resolved.status === 0 ? resolved.stdout.toString().trim() : id
}

function diffDigest(clone: string, base: string, head: string): string | null {
  const diff = runGit(clone, ['diff', '--binary', base, head])
  return diff.status === 0 ? sha256(diff.stdout) : null
}

/** The comments the runner's own login wrote: in a disposable sandbox only the trial's own processes write. */
function ownComments(comments: readonly ForgeComment[], login: string): ForgeComment[] {
  return comments.filter((comment) => comment.author?.login === login)
}

const REVIEWERS: readonly { role: ReviewerRole; extract: (comments: string[]) => VerdictExtraction }[] = [
  { role: 'code-reviewer', extract: extractCodeReviewVerdict },
  { role: 'security-reviewer', extract: extractSecurityReviewVerdict }
]

/** The comment's finding location's file: `file:line` or a bare file. */
function findingFile(location: string): string {
  return location.replace(/:\d+(?:-\d+)?$/, '')
}

/**
 * Each reviewer's latest verdict comment, as the merge gate reads it, as a
 * recorded review: its output is the structured result the comment states,
 * bound to the head and base it judged, to the trial's brief when its brief
 * hash is the one frozen on the trial Issue, and to the diff between the two
 * commits it judged.
 */
function recordedReviews(
  comments: readonly ForgeComment[],
  input: VinayaProcessInput,
  frozenBriefHashes: ReadonlySet<string>,
  clone: string
): RecordedReview[] {
  const reviews: RecordedReview[] = []
  for (const { role, extract } of REVIEWERS) {
    const candidates = comments.filter((comment) => !extract([comment.body]).danglingNote?.startsWith('no '))
    const latest = candidates.at(-1)
    if (latest === undefined) continue
    const verdict = extract([latest.body])
    const headSha = verdict.headSha === null ? '' : fullCommit(clone, verdict.headSha)
    const baseSha = verdict.baseSha === null ? '' : fullCommit(clone, verdict.baseSha)
    const bound = verdict.briefHash !== null && frozenBriefHashes.has(verdict.briefHash)
    reviews.push({
      reviewId: latest.url,
      role,
      binding: {
        headSha,
        baseSha,
        briefHash: bound ? input.briefHash : (verdict.briefHash ?? ''),
        diffDigest: (headSha && baseSha && diffDigest(clone, baseSha, headSha)) || ''
      },
      output:
        verdict.danglingNote !== null
          ? { dangling: verdict.danglingNote }
          : {
              reviewResult: {
                schemaVersion: 1,
                role,
                status: 'completed',
                headSha,
                manifestDigest: `forge-comment:${latest.url}`,
                summary: verdict.value,
                findings: verdict.findingSeverities.map((finding) => ({
                  severity: finding.severity,
                  file: findingFile(finding.location),
                  line: null,
                  description: null
                })),
                objectiveResults: []
              }
            }
    })
  }
  return reviews
}

/** The `Brief hash:` lines of the frozen-brief comments on the trial Issue. */
function frozenBriefHashesOf(comments: readonly ForgeComment[]): Set<string> {
  const hashes = new Set<string>()
  for (const comment of comments) {
    const m = /^Brief hash:\s*([0-9a-f]{64})\s*$/im.exec(comment.body.split('\n')[0] ?? '')
    if (m) hashes.add((m[1] as string).toLowerCase())
  }
  return hashes
}

interface RecordFacts {
  input: VinayaProcessInput
  clone: string
  branch: string
  login: string
  pullRequest: ForgePullRequest | null
  issueComments: ForgeComment[]
  hiddenTests: (head: string) => Promise<TestResult[]>
}

/** The trial record, built from what the forge and the clone show once the run ended. */
export async function buildTrialRecord(facts: RecordFacts): Promise<VinayaTrialRecord> {
  const { input, clone, branch, pullRequest } = facts
  // The forge's view of the branch and of `main`, beside the clone's own.
  sandboxGit(clone, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  sandboxGit(clone, ['fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  const localHead = runGit(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])
  let measuredChange: VinayaTrialRecord['measuredChange'] = null
  if (localHead.status === 0) {
    const head = localHead.stdout.toString().trim()
    const base = git(clone, ['merge-base', 'refs/heads/main', head]).trim()
    measuredChange = {
      base,
      head,
      patchDigest: diffDigest(clone, base, head) ?? '',
      changedPaths: git(clone, ['diff', '--name-only', base, head]).split('\n').filter(Boolean)
    }
  }

  let recordedPullRequest: VinayaTrialRecord['pullRequest'] = null
  let checks: VinayaTrialRecord['checks'] = null
  let reviews: VinayaTrialRecord['reviews'] = null
  let readyForMerge: VinayaTrialRecord['readyForMerge'] = null
  const effects: { idempotencyKey: string; kind: string }[] = []
  if (pullRequest !== null) {
    const head = pullRequest.headRefOid
    const base = runGit(clone, ['merge-base', 'refs/remotes/origin/main', head])
    const recordedBase = base.status === 0 ? base.stdout.toString().trim() : ''
    recordedPullRequest = {
      headSha: head,
      baseSha: recordedBase,
      diffDigest: (recordedBase && diffDigest(clone, recordedBase, head)) || '',
      body: pullRequest.body
    }
    const evidenceId = `checks@${head}`
    checks = {
      evidenceId,
      headSha: head,
      // The sandbox's checks on the pull request; with no branch protection to say which are required, every one is.
      checks: pullRequest.statusCheckRollup.map((entry) => ({
        name: entry.name ?? entry.context ?? '',
        required: true,
        conclusion: checkConclusion(entry)
      }))
    }
    const own = ownComments(pullRequest.comments, facts.login)
    reviews = recordedReviews(own, input, frozenBriefHashesOf(ownComments(facts.issueComments, facts.login)), clone)
    const publications = own.filter((comment) =>
      comment.body.split('\n').some((line) => PUBLISHED_MARKER_LINE.test(line.trim()))
    )
    effects.push({ idempotencyKey: `open-pull-request:${branch}`, kind: 'open_change_request' })
    for (const comment of own) {
      for (const m of comment.body.matchAll(DEVELOPER_ROUND_MARKER)) {
        effects.push({ idempotencyKey: `developer-round:${m[1]}`, kind: 'developer_round' })
      }
    }
    for (const publication of publications) {
      const line = publication.body.split('\n').find((l) => PUBLISHED_MARKER_LINE.test(l.trim())) as string
      const published = fullCommit(clone, (PUBLISHED_MARKER_LINE.exec(line.trim()) as RegExpExecArray)[1] as string)
      effects.push({ idempotencyKey: `ready-for-merge:${published}`, kind: 'publish_ready_for_merge' })
    }
    const latest = publications.at(-1)
    if (latest !== undefined) {
      const line = latest.body.split('\n').find((l) => PUBLISHED_MARKER_LINE.test(l.trim())) as string
      const published = fullCommit(clone, (PUBLISHED_MARKER_LINE.exec(line.trim()) as RegExpExecArray)[1] as string)
      readyForMerge = {
        id: latest.url,
        headSha: published,
        evidenceId: `checks@${published}`,
        reviewIds: reviews.filter((review) => review.binding.headSha === published).map((review) => review.reviewId)
      }
    }
  }

  let hiddenTests: VinayaTrialRecord['hiddenTests'] = null
  if (measuredChange !== null) {
    try {
      hiddenTests = { revision: measuredChange.head, results: await facts.hiddenTests(measuredChange.head) }
    } catch {
      // A grading copy that could not run leaves the fact unobserved, never passing.
      hiddenTests = undefined
    }
  }

  return {
    rendererVersion: input.rendererVersion,
    input,
    pullRequest: recordedPullRequest,
    measuredChange,
    hiddenTests,
    checks,
    reviews,
    readyForMerge,
    // The Developer's turn result, its receipts and its trace stay in the run's own runtime state; the trial does not observe them.
    developerTurnResult: undefined,
    receipts: undefined,
    trace: undefined,
    effects
  }
}

/** Each of the six graders' verdict on the record. */
export async function gradeTrial(
  c: NeutralCase,
  record: VinayaTrialRecord
): Promise<WholeLoopResult['verdicts'] | { refused: string }> {
  const extracted = extractOutcomes(record)
  if (!extracted.ok) return { refused: extracted.refusal.code }
  const verdicts = {} as WholeLoopResult['verdicts']
  for (const grader of WHOLE_LOOP_GRADERS) {
    const id = grader.identity.id as (typeof WHOLE_LOOP_GRADER_IDS)[number]
    const verdict = await grader.grade({ case: c, outcomes: extracted.outcomes })
    verdicts[id] =
      verdict.verdict === 'pass' ? { verdict: 'pass' } : { verdict: verdict.verdict, reason: verdict.reason }
  }
  return verdicts
}

// ── The runner ──────────────────────────────────────────────────────────────

function parseOptions(options: WholeLoopOptions) {
  const backend = options.backend as WholeLoopBackend
  if (!WHOLE_LOOP_BACKENDS.includes(backend))
    refuse('bad_option', `--backend must be ${WHOLE_LOOP_BACKENDS.join(' or ')}`)
  const flow = options.flow as WholeLoopFlow
  if (!WHOLE_LOOP_FLOWS.includes(flow)) refuse('bad_option', `--flow must be ${WHOLE_LOOP_FLOWS.join(' or ')}`)
  if (!BACKEND_FLOWS[backend].includes(flow)) {
    refuse('bad_option', `--flow ${flow} runs on the engine backend only; the standalone backend runs v1`)
  }
  const adapter = options.adapter as StepOneAdapter
  if (!WHOLE_LOOP_ADAPTERS.includes(adapter))
    refuse('bad_option', `--adapter must be ${WHOLE_LOOP_ADAPTERS.join(' or ')}`)
  if (options.split !== 'development' && options.split !== 'held-out')
    refuse('bad_option', '--split must be development or held-out')
  if (!Number.isInteger(options.attempt) || options.attempt < 1)
    refuse('bad_option', '--attempt must be a positive integer')
  if (!REPOSITORY_NAME.test(options.sandbox)) refuse('bad_option', '--sandbox must be owner/name')
  return { backend, flow, adapter }
}

/** The refusals that read and never write: options, the sandbox's identity and state, and the case. */
async function preflight(options: WholeLoopOptions, deps: WholeLoopDeps) {
  const parsed = parseOptions(options)
  const sandbox = options.sandbox
  if (sandbox.toLowerCase() === PROTECTED_REPOSITORY) {
    refuse('protected_repository', `a whole-loop trial never runs against ${PROTECTED_REPOSITORY}`)
  }
  const named = deps.freezeRecordSandbox()
  if (sandbox !== named) refuse('wrong_sandbox', `${sandbox} is not the sandbox the freeze record names, ${named}`)
  if (options.split === 'held-out' && (options.heldOutApproval ?? '') === '') {
    refuse('held_out_unapproved', 'a held-out case runs only with the held-out approval')
  }
  let cases: NeutralCase[]
  try {
    cases = await deps.loadCases(options.split, options.heldOutApproval, sandbox)
  } catch (error) {
    if (options.split === 'held-out') refuse('held_out_unapproved', 'the held-out split refused the approval')
    throw error
  }
  const found = cases.find((c) => c.id === options.caseId)
  if (found === undefined) refuse('unknown_case', `no ${options.split} whole-loop case ${options.caseId}`)
  const validated = validateNeutralCase(found)
  if (!validated.ok || validated.value.kind !== 'loop') refuse('unknown_case', `${options.caseId} is not a loop case`)
  const c = validated.value
  if (c.repository !== sandbox) {
    refuse('case_not_in_sandbox', `case ${c.id} targets ${c.repository}, not the sandbox ${sandbox}`)
  }
  const rendered = renderCase(c)
  if (!rendered.ok) refuse('unrenderable_case', `case ${c.id} cannot be rendered: ${rendered.refusal.field}`)

  const repository = deps.forge.repository(sandbox)
  if (repository === null || repository.nameWithOwner.toLowerCase() !== sandbox.toLowerCase()) {
    refuse('sandbox_unreadable', `the forge login cannot read ${sandbox}`)
  }
  if (repository.visibility.toUpperCase() !== 'PRIVATE') {
    refuse(
      'sandbox_public',
      `${sandbox} is ${repository.visibility.toLowerCase()}; a trial runs only in a private sandbox`
    )
  }
  if (!WRITE_PERMISSIONS.has(repository.viewerPermission.toUpperCase())) {
    refuse('no_write_login', `the forge login holds ${repository.viewerPermission || 'no'} permission on ${sandbox}`)
  }
  const open = deps.forge.openItems(sandbox)
  if (open.issues.length > 0 || open.pullRequests.length > 0) {
    refuse(
      'open_trial',
      `${sandbox} still has open Issues [${open.issues.join(', ')}] and pull requests [${open.pullRequests.join(', ')}] from an earlier trial`
    )
  }
  if (!deps.forge.commitExists(sandbox, c.baseRevision)) {
    refuse('base_commit_missing', `${sandbox} does not hold the base commit ${c.baseRevision}`)
  }
  return { ...parsed, c, input: rendered.input }
}

/**
 * The clone's isolation (evaluation program §11): it holds the base commit,
 * no ref but `main` and `origin/main`, and no commit outside the base
 * commit's history.
 */
export function cloneIsolation(clone: string, baseCommit: string): string | null {
  if (runGit(clone, ['cat-file', '-e', `${baseCommit}^{commit}`]).status !== 0) {
    return `the trial clone does not contain the base commit ${baseCommit}`
  }
  const refs = git(clone, ['for-each-ref', '--format=%(refname)']).split('\n').filter(Boolean).sort()
  const extra = refs.filter((ref) => ref !== 'refs/heads/main' && ref !== 'refs/remotes/origin/main')
  if (extra.length > 0) return `the trial clone holds refs other than main and origin/main: ${extra.join(', ')}`
  const all = git(clone, ['rev-list', '--all']).split('\n').filter(Boolean).sort()
  const history = git(clone, ['rev-list', baseCommit]).split('\n').filter(Boolean).sort()
  if (all.join('\n') !== history.join('\n')) {
    return "the trial clone holds commits outside the base commit's history"
  }
  return null
}

/** Waits for the run to end, stopping it at a ruling pause or at its deadline. */
async function awaitRun(
  handle: TaskRunHandle,
  deps: WholeLoopDeps,
  sandbox: string,
  issue: number,
  branch: string,
  deadline: number,
  pollMs: number
): Promise<RunEnd> {
  let code: number | null = null
  handle.exited.then((exit) => {
    code = exit
  })
  for (;;) {
    await Promise.race([handle.exited, deps.sleep(pollMs)])
    if (code !== null) return { kind: 'exited', code }
    const pullRequest = deps.forge.pullRequestFor(sandbox, branch)
    const paused = rulingPauseOf([...deps.forge.issueComments(sandbox, issue), ...(pullRequest?.comments ?? [])])
    if (paused !== null) {
      await handle.stop()
      return { kind: 'paused', reason: paused }
    }
    if (deps.now() >= deadline) {
      await handle.stop()
      return { kind: 'timed-out' }
    }
  }
}

/** Reads the pull request until its checks settle or the wait runs out. */
async function settledPullRequest(
  deps: WholeLoopDeps,
  sandbox: string,
  branch: string,
  settleMs: number,
  pollMs: number
): Promise<ForgePullRequest | null> {
  const until = deps.now() + settleMs
  for (;;) {
    const pullRequest = deps.forge.pullRequestFor(sandbox, branch)
    if (pullRequest === null) return null
    const pending = pullRequest.statusCheckRollup.some((entry) => checkConclusion(entry) === 'pending')
    if (!pending || deps.now() >= until) return pullRequest
    await deps.sleep(pollMs)
  }
}

/** The CLI entry of this tree, which the trial runs — the Engine runner loads its process from the CLI's own tree. */
export const CURRENT_TREE_CLI = resolve(import.meta.dir, '../../index.ts')

/** Runs one whole-loop trial and writes its result, or refuses before any forge write. */
export async function runWholeLoopTrial(options: WholeLoopOptions, deps: WholeLoopDeps): Promise<WholeLoopOutcome> {
  let prepared: Awaited<ReturnType<typeof preflight>>
  try {
    prepared = await preflight(options, deps)
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal }
    throw error
  }
  const { backend, flow, adapter, c, input } = prepared
  const sandbox = options.sandbox
  const heldOut = options.split === 'held-out'
  const pollMs = options.pollMs ?? 30_000
  const trialRoot = mkdtempSync(join(deps.workRoot(), 'whole-loop-'))
  const clone = join(trialRoot, 'clone')
  const runtimeDirectory = join(trialRoot, 'runtime')
  mkdirSync(runtimeDirectory, { recursive: true })
  deps.log(`whole-loop: ${c.id} (${options.split}) on ${backend} ${flow} ${adapter}, attempt ${options.attempt}`)

  // Only the sandbox's `main` moves, and only while no trial is open.
  deps.forge.moveMain(sandbox, c.baseRevision)
  const cloned = sandboxGit(trialRoot, [
    'clone',
    '--quiet',
    '--single-branch',
    '--branch',
    'main',
    '--no-tags',
    '--',
    deps.remoteUrl(sandbox),
    clone
  ])
  const isolation =
    cloned.status !== 0
      ? `the trial clone could not be made: ${cloned.stderr.trim().slice(-500)}`
      : cloneIsolation(clone, c.baseRevision)
  if (isolation !== null) {
    rmSync(trialRoot, { recursive: true, force: true })
    return { ok: false, refusal: { code: 'clone_not_isolated', detail: isolation } }
  }

  const title = `Whole-loop trial ${c.id} attempt ${options.attempt}`
  const issue = deps.forge.createIssue(sandbox, title, trialIssueBody(input, options.project))
  const branch = issueBranchName(issue)
  let pullRequest: ForgePullRequest | null = null
  try {
    const started = deps.now()
    const handle = deps.startTaskRun({
      cli: CURRENT_TREE_CLI,
      argv: taskRunArgv({ issue, backend, flow, adapter, ...(options.model ? { model: options.model } : {}) }),
      cwd: clone,
      env: taskRunEnvironment(process.env, sandbox, runtimeDirectory)
    })
    const exited = await awaitRun(
      handle,
      deps,
      sandbox,
      issue,
      branch,
      started + (options.runTimeoutMs ?? 36_000_000),
      pollMs
    )
    const wallTimeMs = deps.now() - started

    pullRequest = await settledPullRequest(deps, sandbox, branch, options.checksSettleMs ?? 1_800_000, pollMs)
    const issueComments = deps.forge.issueComments(sandbox, issue)
    const login = deps.forge.login()
    const record = await buildTrialRecord({
      input,
      clone,
      branch,
      login,
      pullRequest,
      issueComments,
      hiddenTests: (head) =>
        deps.runHiddenTests({
          neutralCase: c,
          split: options.split,
          clone,
          head,
          workDirectory: mkdtempSync(join(trialRoot, 'grading-')),
          timeoutMs: options.hiddenTestTimeoutMs ?? 1_800_000
        })
    })
    const graded = await gradeTrial(c, record)
    const verdicts =
      'refused' in graded
        ? (Object.fromEntries(
            WHOLE_LOOP_GRADER_IDS.map((id) => [
              id,
              { verdict: 'unknown', reason: `extraction refused: ${graded.refused}` }
            ])
          ) as WholeLoopResult['verdicts'])
        : graded
    if (heldOut) for (const verdict of Object.values(verdicts)) delete verdict.reason
    const published = record.readyForMerge !== null && record.readyForMerge !== undefined
    const result: WholeLoopResult = {
      schemaVersion: 1,
      suite: WHOLE_LOOP_SUITE,
      caseId: c.id,
      split: options.split,
      backend,
      flow,
      adapter,
      attempt: options.attempt,
      rendererVersion: input.rendererVersion,
      sandbox: { repository: sandbox, issue, pullRequest: pullRequest?.number ?? null },
      end: published && exited.kind === 'exited' && exited.code === 0 ? { kind: 'ready-for-merge' } : exited,
      readyGate: readyGateOf(pullRequest, published),
      passed: Object.values(verdicts).every((v) => v.verdict === 'pass'),
      verdicts,
      rounds: roundsOf(ownComments(pullRequest?.comments ?? [], login)),
      wallTimeMs,
      tokens: tokensReported(join(runtimeDirectory, 'logs'))
    }
    mkdirSync(dirname(options.resultPath), { recursive: true })
    writeFileSync(options.resultPath, `${JSON.stringify(result, null, 2)}\n`)
    deps.log(`whole-loop: ${c.id} ${result.passed ? 'passed' : 'failed'} (${result.end.kind})`)
    return { ok: true, result }
  } finally {
    // Never merged, never reused: the next trial finds the sandbox with nothing open.
    const open = pullRequest ?? deps.forge.pullRequestFor(sandbox, branch)
    if (open !== null && open.state.toUpperCase() === 'OPEN') deps.forge.closePullRequest(sandbox, open.number)
    deps.forge.closeIssue(sandbox, issue)
    rmSync(trialRoot, { recursive: true, force: true })
  }
}

// ── Production ports ────────────────────────────────────────────────────────

function gh(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const run = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
}

function ghJson<T>(args: readonly string[]): T {
  const run = gh(args)
  if (run.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${run.stderr.trim().slice(-500)}`)
  return JSON.parse(run.stdout) as T
}

const PULL_REQUEST_FIELDS = 'number,state,headRefOid,statusCheckRollup,reviews,body,comments'

/** The forge through `gh`, every call naming the repository with `--repo` or its API path. */
export const GH_FORGE: WholeLoopForge = {
  repository(repo) {
    const run = gh(['repo', 'view', repo, '--json', 'nameWithOwner,visibility,viewerPermission'])
    return run.status === 0 ? JSON.parse(run.stdout) : null
  },
  login: () => ghJson<{ login: string }>(['api', 'user']).login,
  openItems(repo) {
    const issues = ghJson<{ number: number }[]>([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--json',
      'number',
      '--limit',
      '100'
    ])
    const prs = ghJson<{ number: number }[]>([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--json',
      'number',
      '--limit',
      '100'
    ])
    return { issues: issues.map((i) => i.number), pullRequests: prs.map((p) => p.number) }
  },
  commitExists: (repo, commit) => gh(['api', `repos/${repo}/commits/${commit}`, '--jq', '.sha']).status === 0,
  moveMain(repo, commit) {
    const run = gh([
      'api',
      '-X',
      'PATCH',
      `repos/${repo}/git/refs/heads/main`,
      '-f',
      `sha=${commit}`,
      '-F',
      'force=true'
    ])
    if (run.status !== 0) throw new Error(`moving ${repo} main to ${commit} failed: ${run.stderr.trim().slice(-500)}`)
  },
  createIssue(repo, title, body) {
    const dir = mkdtempSync(join(stepOneWorkRoot(), 'whole-loop-issue-'))
    try {
      const file = join(dir, 'body.md')
      writeFileSync(file, body)
      const run = gh(['issue', 'create', '--repo', repo, '--title', title, '--body-file', file])
      const number = /\/issues\/(\d+)\s*$/.exec(run.stdout.trim())?.[1]
      if (run.status !== 0 || number === undefined)
        throw new Error(`opening the trial Issue failed: ${run.stderr.trim()}`)
      return Number(number)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  issueComments: (repo, issue) =>
    ghJson<{ comments: ForgeComment[] }>(['issue', 'view', String(issue), '--repo', repo, '--json', 'comments'])
      .comments,
  pullRequestFor(repo, branch) {
    const run = gh(['pr', 'view', branch, '--repo', repo, '--json', PULL_REQUEST_FIELDS])
    return run.status === 0 ? (JSON.parse(run.stdout) as ForgePullRequest) : null
  },
  closePullRequest(repo, pullRequest) {
    gh(['pr', 'close', String(pullRequest), '--repo', repo])
  },
  closeIssue(repo, issue) {
    gh(['issue', 'close', String(issue), '--repo', repo, '--reason', 'not planned'])
  }
}

/** Starts the task run in its own process group, so a stop ends every child it started. */
export function spawnTaskRun(request: TaskRunRequest): TaskRunHandle {
  const child = spawn('bun', [request.cli, ...request.argv], {
    cwd: request.cwd,
    env: request.env,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit']
  })
  const exited = new Promise<number>((done) => {
    child.on('exit', (code, signal) => done(code ?? (signal === null ? 1 : 128)))
    child.on('error', () => done(1))
  })
  return {
    exited,
    async stop() {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
      }
      await exited
    }
  }
}

const INSTALL_COMMAND = ['bun', 'install', '--frozen-lockfile', '--ignore-scripts', '--silent']
const INSTALL_BUDGET_MS = 600_000
const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../../..')

/**
 * The hidden tests on the final head, in a grading copy cloned from the trial
 * clone at that head: the merged change's test files and the pinned
 * pass-to-pass files are read from this repository and written there only,
 * and the tests run in the grading sandbox, as a Developer trial's do.
 */
export async function runHiddenTestsInGradingCopy(request: HiddenTestRequest): Promise<TestResult[]> {
  const generic = await import('../../../tests/eval/generic-suites')
  const suite = await import('../../../tests/eval/developer-capability-suite')
  const item = generic.developerReferenceCases(request.split).find((p) => p.id === request.neutralCase.id)
  if (item === undefined) throw new Error(`no developer case ${request.neutralCase.id}`)
  const steps = PRODUCTION_VINAYA_PROCESS_STEPS
  const hidden = steps.hiddenInputs(REPOSITORY_ROOT, item)
  const copy = join(request.workDirectory, 'repository')
  git(request.workDirectory, [
    'clone',
    '--quiet',
    '--no-local',
    '--no-hardlinks',
    '--no-tags',
    '--template=',
    `--revision=${request.head}`,
    '--',
    request.clone,
    copy
  ])
  git(copy, ['remote', 'remove', 'origin'])
  for (const [path, content] of [
    ...Object.entries(hidden.failToPassTests),
    ...Object.entries(hidden.pinnedPassToPassTests ?? {})
  ]) {
    const target = join(copy, safeRelativePath(path))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  const sandbox = steps.openGradingSandbox()
  try {
    await steps.warmPackageCache(sandbox, REPOSITORY_ROOT, item.baseCommit)
    await sandbox.run(INSTALL_COMMAND, copy, [copy], INSTALL_BUDGET_MS)
    const testFiles = [
      ...new Set([...item.hiddenTests.files.map((f) => f.path), ...item.passToPassFiles.map((f) => f.path)])
    ]
    const outcomes = suite.outcomesOf(await steps.gradeInSandbox(sandbox, copy, testFiles, request.timeoutMs))
    const loop = request.neutralCase as Extract<NeutralCase, { kind: 'loop' }>
    return loop.hiddenTests.map((test) => {
      // A fail-to-pass test is named by its name digest in the outcomes, a pass-to-pass one by its name.
      const name = test.expectation === 'fail-to-pass' ? suite.testDigest(test.name) : test.name
      const outcome = outcomes[suite.outcomeKey(test.path, name)]
      const result = outcome === undefined ? 'not-run' : outcome === 'skip' ? 'skipped' : outcome
      return { path: test.path, name: test.name, result }
    })
  } finally {
    sandbox.dispose()
  }
}

/** The production ports: the forge through `gh`, the sandbox over SSH, the committed cases and freeze record. */
export function productionWholeLoopDeps(): WholeLoopDeps {
  return {
    forge: GH_FORGE,
    remoteUrl: (repo) => `git@github.com:${repo}.git`,
    freezeRecordSandbox: () => {
      const record = JSON.parse(
        readFileSync(resolve(import.meta.dir, '../../../tests/eval/freeze-record.json'), 'utf8')
      ) as { wholeLoopSandboxRepository?: string }
      return record.wholeLoopSandboxRepository ?? ''
    },
    loadCases: loadSandboxCases,
    startTaskRun: spawnTaskRun,
    runHiddenTests: runHiddenTestsInGradingCopy,
    workRoot: () => stepOneWorkRoot(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => process.stderr.write(`${line}\n`)
  }
}

/**
 * The committed whole-loop cases of a split, each targeted at the sandbox at
 * load time: the cases name the repository they were cut from, and the trial
 * runs in the sandbox. The held-out split opens only through its approval.
 */
export async function loadSandboxCases(
  split: WholeLoopSplit,
  approval: string | undefined,
  sandbox: string
): Promise<NeutralCase[]> {
  const suites = await import('../../../tests/eval/generic-suites')
  const cases =
    split === 'development' ? suites.developmentCases('wholeLoop') : suites.heldOutCases('wholeLoop', approval ?? '')
  return cases.map((c) => targetSandbox(c, sandbox))
}

// ── Command ─────────────────────────────────────────────────────────────────

export const WHOLE_LOOP_USAGE =
  'usage: whole-loop.ts --case <id> --split development|held-out [--held-out-approval <digest>] --backend standalone|engine --flow v1|v2 --adapter claude-code|codex --attempt <n> --sandbox <owner/name> --result <file> [--model <model>] [--project <name>]'

const flag = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

/** The command entry: exit 0 when the trial recorded its result, 2 on a refusal. */
export async function wholeLoopCommand(argv: readonly string[], deps?: WholeLoopDeps): Promise<number> {
  const required = ['case', 'split', 'backend', 'flow', 'adapter', 'attempt', 'sandbox', 'result'] as const
  const missing = required.filter((name) => flag(argv, name) === undefined)
  if (missing.length > 0) {
    process.stderr.write(`${WHOLE_LOOP_USAGE}\nmissing: ${missing.map((name) => `--${name}`).join(', ')}\n`)
    return 2
  }
  const sandbox = flag(argv, 'sandbox') as string
  const ports = deps ?? productionWholeLoopDeps()
  const model = flag(argv, 'model')
  const project = flag(argv, 'project')
  const approval = flag(argv, 'held-out-approval')
  const outcome = await runWholeLoopTrial(
    {
      caseId: flag(argv, 'case') as string,
      split: flag(argv, 'split') as WholeLoopSplit,
      backend: flag(argv, 'backend') as string,
      flow: flag(argv, 'flow') as string,
      adapter: flag(argv, 'adapter') as string,
      attempt: Number(flag(argv, 'attempt')),
      sandbox,
      resultPath: flag(argv, 'result') as string,
      ...(approval === undefined ? {} : { heldOutApproval: approval }),
      ...(model === undefined ? {} : { model }),
      ...(project === undefined ? {} : { project })
    },
    ports
  )
  if (outcome.ok) return 0
  process.stderr.write(`whole-loop refused (${outcome.refusal.code}): ${outcome.refusal.detail}\n`)
  return 2
}

if (import.meta.main) {
  wholeLoopCommand(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
