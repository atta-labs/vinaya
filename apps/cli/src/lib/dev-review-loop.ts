/**
 * `devReviewLoop` — the driver half of the loop spec (dev-review-loop-v1
 * task 5, `#415`; Linear "Tech spec — Developer Review Loop" rev 4, §16).
 * `assessRound` (`@attalabs/aeg-core`, task 4) is the ENTIRE policy; this
 * file never re-implements a stop condition, a confidence rule, or a
 * round-outcome decision. It only turns real forge/dispatch facts into
 * `Observations`, calls `assessRound`, and acts on the returned `Decision`.
 *
 * Content never travels through `dispatchRole`'s return value —
 * `DispatchHandle` carries only `resumeId`/`usage`/exit status by design
 * (`dispatch.ts`'s own doc comment; confirmed by reading its source, not
 * guessed). Every piece of SUBSTANTIVE content a round needs — the
 * developer's confidence line, a reviewer's findings — travels through a
 * filesystem side channel the dispatched agent is instructed (in its own
 * prompt) to write to, exactly the same way a real Developer's actual
 * output is a PR, not a return value. This is why `resolveHead`,
 * `fetchCiConclusion`, `fetchRulings`, `fetchFrozenBrief` and the two
 * findings/objectives-file readers all exist: everything this driver learns
 * about a round comes from the forge or from a file, never from a vendor's
 * raw stdout read out-of-band (Section 10 stop condition; the one thing
 * this file must never do).
 *
 * Two invariants, load-bearing for O1/O2's "nothing posted before publish":
 * this file imports no forge-WRITE function (`postMarkedComment`,
 * `gh pr comment`, `gh pr review` never appear below) and calls
 * `dispatchRole` fresh, every round, for every reviewer (never resumes a
 * reviewer session) — only the developer's session is ever resumed.
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assessRound,
  initialLoopState,
  type Confidence,
  type Decision,
  type DevReviewLoopEventInput,
  type LoopConfig,
  type LoopState,
  type Observations,
  type RoundStats,
  type VerdictObservation
} from '@attalabs/aeg-core'
import {
  deriveCodeReviewVerdict,
  deriveSecurityVerdict,
  type EscalationClass,
  type Finding,
  isEscalationClass,
  parseFindingsFile,
  parseObjectivesFile,
  renderCodeReviewComment,
  renderEscalationComment,
  renderSecurityComment
} from '../commands/review-post.js'
import {
  AGENT_VENDOR_NAMES,
  type AgentVendor,
  dispatchRole as realDispatchRole,
  type DispatchHandle
} from './dispatch.js'
import { AEG_BRIEF_V1_MARKER, contentAfterTwoLines } from './dispatch-task.js'
import { GLOBAL_VINAYA_HOME } from './config.js'
import { createLogSink, outboxPathFor } from './log-sink.js'
import { packageRoot } from './package-root.js'
import { resolveRepo } from '@attalabs/aeg-forge-state'

// --- forge reads ---------------------------------------------------------

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * The branch's true head via `git ls-remote` only — `gh pr view
 * headRefOid` is refused by name (Traps to avoid; `#403` moved both gates
 * off it because it can lag a push). Throws, never returns a placeholder,
 * on a genuine resolution failure — a caller with nothing to fall back to
 * should not be handed an empty string.
 */
export function resolveHead(branch: string): string {
  let out: string
  try {
    out = sh('git', ['ls-remote', 'origin', `refs/heads/${branch}`])
  } catch (err) {
    throw new Error(
      `resolveHead: \`git ls-remote origin refs/heads/${branch}\` failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const sha = out.split(/\s+/)[0] ?? ''
  if (!sha) throw new Error(`resolveHead: branch \`${branch}\` has no head on \`origin\` (empty ls-remote output).`)
  return sha
}

type RestCheckRun = { id: number; name: string; status: string; conclusion: string | null }

/**
 * The mechanical gate's own conclusion for `headSha`, read from CI's
 * check-runs (never run locally — Traps to avoid). `'pending'` when any
 * latest-per-name run has not completed, or the fetch itself fails (a
 * transient network hiccup reads the same as "not resolved yet", never as
 * red) — the driver is expected to poll this, not treat one `'pending'` read
 * as final.
 */
export function fetchCiConclusion(headSha: string): 'green' | 'red' | 'pending' {
  let out: string
  try {
    out = sh('gh', [
      'api',
      `repos/{owner}/{repo}/commits/${headSha}/check-runs`,
      '--paginate',
      '--jq',
      '.check_runs[] | {id, name, status, conclusion}'
    ])
  } catch {
    return 'pending'
  }
  const runs: RestCheckRun[] = out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RestCheckRun)
  if (runs.length === 0) return 'pending'

  const latestByName = new Map<string, RestCheckRun>()
  for (const run of runs) {
    const seen = latestByName.get(run.name)
    if (!seen || run.id > seen.id) latestByName.set(run.name, run)
  }
  const latest = Array.from(latestByName.values())
  if (latest.some((r) => r.status !== 'completed')) return 'pending'
  if (latest.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')) {
    return 'green'
  }
  return 'red'
}

const RULING_MARKER = /^<!-- aeg:principal:ruling:\d+-\d+ -->$/

/**
 * `postMarkedComment('pr', ...)` composes a ruling comment as exactly
 * `${marker}\n${body}\n` (`forge-write.ts`) — ONE header line, not two. This
 * is deliberately its own one-line split, not `dispatch-task.ts`'s
 * `contentAfterTwoLines`: that function skips the marker line AND a second
 * `Brief hash:` header line that only the frozen-brief comment shape has
 * (`dispatchTask` composes `Brief hash: <hash>\n<brief>` as the body it
 * hands to `postMarkedComment`). Applying `contentAfterTwoLines` here would
 * silently drop every ruling's own first content line. See this PR's
 * Decisions section.
 */
function contentAfterOneLine(body: string): string {
  const idx = body.indexOf('\n')
  return idx === -1 ? '' : body.slice(idx + 1)
}

/** Every ruling comment's body (after its marker line) on PR `prNumber`, in the forge's own comment order. */
export function fetchRulings(prNumber: number): string[] {
  let out: string
  try {
    out = sh('gh', ['pr', 'view', String(prNumber), '--json', 'comments'])
  } catch (err) {
    throw new Error(
      `fetchRulings: could not fetch PR #${prNumber}'s comments: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const comments = (JSON.parse(out) as { comments: { body: string }[] }).comments
  return comments
    .filter((c) => RULING_MARKER.test(c.body.split('\n')[0] ?? ''))
    .map((c) => contentAfterOneLine(c.body).trim())
}

/** The Issue's frozen `aeg:brief:v1` comment's brief text — refuses (throws) rather than inventing a brief when none exists yet. */
export function fetchFrozenBrief(issueNumber: number): string {
  let out: string
  try {
    out = sh('gh', ['issue', 'view', String(issueNumber), '--json', 'comments'])
  } catch (err) {
    throw new Error(
      `fetchFrozenBrief: could not fetch Issue #${issueNumber}'s comments: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const comments = (JSON.parse(out) as { comments: { body: string }[] }).comments
  const found = comments.find((c) => c.body.split('\n')[0] === AEG_BRIEF_V1_MARKER)
  if (!found) {
    throw new Error(
      `fetchFrozenBrief: Issue #${issueNumber} carries no frozen \`aeg:brief:v1\` comment — \`vinaya task dispatch\` must post the brief before this loop can start.`
    )
  }
  return contentAfterTwoLines(found.body)
}

export function fetchIssueTitle(issueNumber: number): string {
  const out = sh('gh', ['issue', 'view', String(issueNumber), '--json', 'title'])
  return (JSON.parse(out) as { title: string }).title
}

const ISSUE_TITLE_SHAPE = /^\[([^\]]+)\]\s+(\d+)\s+[—-]/

/** `task/<tranche>/<n>`, derived from the Issue's own `[<tranche>] <n> — …` title — never guessed or configured separately. */
export function developerBranchFor(issueNumber: number, fetchTitle: (n: number) => string = fetchIssueTitle): string {
  const title = fetchTitle(issueNumber)
  const m = ISSUE_TITLE_SHAPE.exec(title)
  if (!m) {
    throw new Error(
      `developerBranchFor: Issue #${issueNumber}'s title \`${title}\` does not match the \`[<tranche>] <n> — …\` shape — cannot derive the developer's branch.`
    )
  }
  return `task/${m[1]}/${m[2]}`
}

type PrRef = { number: number; branch: string }

/** `null` when no open PR carries `branch` as its head yet — polled, never treated as a final answer on one read. */
export function findOpenPrForBranch(branch: string): PrRef | null {
  try {
    const out = sh('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,headRefName'])
    const list = JSON.parse(out) as { number: number; headRefName: string }[]
    const found = list.find((p) => p.headRefName === branch)
    return found ? { number: found.number, branch } : null
  } catch {
    return null
  }
}

// --- reviewer prompt (facts only) -----------------------------------------

export type ReviewerPromptFacts = {
  objectives: string
  rulings: string[]
  head: string
  ciConclusion: 'green' | 'red' | 'pending'
}

/**
 * Phrasing that would smuggle a conclusion, rather than a fact, into a
 * reviewer's prompt. Facts (objectives text, ruling bodies) are Principal-
 * or Planner-authored prose the driver does not control — this lint exists
 * to catch that prose leaking framing into the rendered prompt, not to
 * police this renderer's own fixed strings (which never use any of these
 * phrases — Section 10: a lint failure here is fixed in the renderer only
 * when the renderer's OWN fixed text is at fault, never by loosening the
 * lint).
 */
const BANNED_FRAMING: readonly RegExp[] = [
  /\bthe developer says\b/i,
  /\baccording to the developer\b/i,
  /\bin my opinion\b/i,
  /\bI think\b/,
  /\bthe pr body says\b/i,
  /\bclearly\b/i
]

/** Non-empty when `rendered` carries banned framing — each entry names the phrase that matched. */
export function lintReviewerPrompt(rendered: string): string[] {
  return BANNED_FRAMING.filter((re) => re.test(rendered)).map((re) => `banned framing matched: ${re.source}`)
}

/** Facts only — no developer-authored text, no PR-body prose (Traps to avoid). */
export function renderReviewerPrompt(facts: ReviewerPromptFacts): string {
  return [
    'OBJECTIVES:',
    facts.objectives.trim() || '(none found on the Issue)',
    '',
    'RULINGS ON THIS PR:',
    facts.rulings.length > 0 ? facts.rulings.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none)',
    '',
    `HEAD: ${facts.head}`,
    `CI: ${facts.ciConclusion}`
  ].join('\n')
}

// --- held-verdict outbox ---------------------------------------------------

/** `join(GLOBAL_VINAYA_HOME, 'outbox')` — the same root `log-sink.ts`'s own `outboxPathFor` resolves, never a second hardcoded path. */
export function outboxRoot(): string {
  return join(GLOBAL_VINAYA_HOME, 'outbox')
}

/** One file per verdict: `<outboxRoot>/dev-review-loop/<task>/round-<round>-<role>.md`. Real `fs.writeFileSync`, never `gh pr comment` — the held verdict lives here until task 6 (not this task) posts it. */
export function writeHeldVerdict(
  root: string,
  task: number,
  round: number,
  role: 'reviewer' | 'security',
  renderedComment: string
): void {
  const dir = join(root, 'dev-review-loop', String(task))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `round-${round}-${role}.md`), renderedComment, 'utf8')
}

function reviewerWorkDir(root: string, task: number, round: number, role: 'reviewer' | 'security'): string {
  return join(root, 'dev-review-loop', String(task), `round-${round}-${role}-work`)
}

// --- confidence -------------------------------------------------------------

/**
 * Fixed text, appended to the developer's resume prompt on every round ≥ 2
 * (Part 3). The file path is a fixed, well-known relative convention — the
 * worktree root every Developer already works in
 * (`aeg-root/roles/developer.md`'s own `.worktrees/task/<tranche>/<n>/`) —
 * so this constant needs no per-round interpolation to stay fixed.
 */
export const CONFIDENCE_PROMPT_LINE =
  "Before ending this turn, write your confidence in this round's changes to a file named `.vinaya-confidence` at the root of your worktree, containing exactly one line: `CONFIDENCE: <0-100> — <one-sentence reason>` (a whole number from 0 to 100, an em dash, then your reason in one sentence). This is read by the review loop before it decides the next step — do not skip it."

const CONFIDENCE_LINE = /^CONFIDENCE:\s*(\d{1,3})\s*(?:—|-)\s*(.+)$/m

/** `'absent'` for a missing or malformed reply — never guessed into a number. */
export function parseConfidenceReply(replyText: string): Confidence {
  const m = CONFIDENCE_LINE.exec(replyText)
  if (!m) return 'absent'
  const value = Number(m[1])
  if (!Number.isFinite(value) || value < 0 || value > 100) return 'absent'
  const reason = (m[2] ?? '').trim()
  return reason ? { value, reason } : { value }
}

const CONFIDENCE_FILE_NAME = '.vinaya-confidence'

// --- reviewer report grammar (this task's own design; see PR Decisions) ---

/**
 * A reviewer/security dispatch is instructed to write three files to an
 * absolute, driver-chosen work directory: `findings.txt`
 * (`review-post.ts`'s existing `SEVERITY|file:line|description` grammar),
 * `objectives.txt` (existing `O<n>|MET|evidence` grammar, optional), and
 * `report.txt` — this task's own new `KEY: value` grammar for the
 * remaining prose fields `renderCodeReviewComment`/`renderSecurityComment`
 * need (brief conformance, scope, tests, docs, config scan, secrets), plus
 * an optional `ESCALATE: <class>` / `SUMMARY:` pair. Only `findings.txt`
 * and `objectives.txt` are reused grammars per the brief; `report.txt` is
 * new because neither existing parser covers free-text prose fields.
 */
type ReviewerReport = Record<string, string>

function parseReport(content: string): ReviewerReport {
  const report: ReviewerReport = {}
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    report[line.slice(0, idx).trim().toUpperCase()] = line.slice(idx + 1).trim()
  }
  return report
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// --- dispatch plumbing -------------------------------------------------------

function withPromptFile<T>(prompt: string, fn: (promptFile: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-dev-review-loop-prompt-'))
  const promptFile = join(dir, 'prompt.md')
  writeFileSync(promptFile, prompt, 'utf8')
  try {
    return fn(promptFile)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Thrown when a round's resume attempt fails for a vendor whose previous round succeeded — Section 10's own stop-and-escalate, never a fallback to a fresh session. */
export class DevReviewLoopResumeError extends Error {}

// --- deps (injectable; every field defaults to the real implementation) -----

export type LoopDeps = {
  dispatchRole: typeof realDispatchRole
  resolveHead: typeof resolveHead
  fetchCiConclusion: typeof fetchCiConclusion
  fetchRulings: typeof fetchRulings
  fetchFrozenBrief: typeof fetchFrozenBrief
  developerBranchFor: (issueNumber: number) => string
  findOpenPrForBranch: typeof findOpenPrForBranch
  outboxRoot: () => string
  repoRoot: () => string
  gitRevParseOriginMain: () => string
  gitFetch: (sha: string) => void
  gitDiffShortstat: (base: string, head: string) => string
  flushOutbox: (task: number) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  prPollMaxAttempts: number
  prPollIntervalMs: number
  gatePollMaxAttempts: number
  gatePollIntervalMs: number
}

function defaultRepoRoot(): string {
  return sh('git', ['rev-parse', '--show-toplevel'])
}

function defaultGitRevParseOriginMain(): string {
  return sh('git', ['rev-parse', 'origin/main'])
}

function defaultGitFetch(sha: string): void {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', sha], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch {
    // Non-fatal — the object may already be local; the diff below is the real test.
  }
}

function defaultGitDiffShortstat(base: string, head: string): string {
  try {
    return sh('git', ['diff', `${base}...${head}`, '--shortstat'])
  } catch {
    return ''
  }
}

/**
 * Spawns `vinaya log flush --issue <task>` as a SUBPROCESS rather than
 * importing `logFlushCommand` and calling it in-process. `logFlushCommand`
 * calls `process.exit()` directly on its own terminal paths (`0` for
 * "nothing to flush", `2` for a refusal) — calling that in-process inside
 * this driver's long-running, multi-round loop would kill the whole
 * `dev-review-loop` process on the very first such edge case, abandoning
 * every round still to come. A subprocess boundary contains that exit to
 * the child; a non-zero child exit is logged to stderr and never fatal to
 * the loop (flush failures don't undo a dispatch's own already-durable
 * outbox lines — `dispatch.ts`'s own doc comment).
 */
function defaultFlushOutbox(task: number): void {
  try {
    const cliEntry = join(packageRoot(import.meta.url), 'src', 'index.ts')
    execFileSync('bun', [cliEntry, 'log', 'flush', '--issue', String(task)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    process.stderr.write(
      `vinaya dev-review-loop: round-end flush failed (non-fatal, lines stay in the outbox for a later flush): ${
        err instanceof Error ? err.message : String(err)
      }\n`
    )
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultDeps(): LoopDeps {
  return {
    dispatchRole: realDispatchRole,
    resolveHead,
    fetchCiConclusion,
    fetchRulings,
    fetchFrozenBrief,
    developerBranchFor: (n) => developerBranchFor(n),
    findOpenPrForBranch,
    outboxRoot,
    repoRoot: defaultRepoRoot,
    gitRevParseOriginMain: defaultGitRevParseOriginMain,
    gitFetch: defaultGitFetch,
    gitDiffShortstat: defaultGitDiffShortstat,
    flushOutbox: defaultFlushOutbox,
    sleep: defaultSleep,
    now: () => Date.now(),
    prPollMaxAttempts: 120,
    prPollIntervalMs: 15_000,
    gatePollMaxAttempts: 120,
    gatePollIntervalMs: 15_000
  }
}

// --- the loop -----------------------------------------------------------------

export type LoopInput = { task: number; agent: AgentVendor }
export type LoopResult = { finalDecision: Decision; prNumber: number }

function parseShortstat(stat: string): { filesChanged: number; insertions: number; deletions: number } {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat)
  if (!m) return { filesChanged: 0, insertions: 0, deletions: 0 }
  return { filesChanged: Number(m[1] ?? 0), insertions: Number(m[2] ?? 0), deletions: Number(m[3] ?? 0) }
}

async function assertDispatchOrEscalate(
  handle: DispatchHandle,
  vendor: AgentVendor,
  isResume: boolean,
  previousRoundSucceededForVendor: boolean
): Promise<void> {
  if (!handle.failureReason) return
  if (isResume && previousRoundSucceededForVendor) {
    throw new DevReviewLoopResumeError(
      `devReviewLoop: ${vendor}'s resume failed this round (${handle.failureReason}) after succeeding last round — ` +
        `stop-and-escalate severity:product, vendor: ${vendor}. Never falling back to a fresh developer session (Principal ruling, 2026-09-04).`
    )
  }
  throw new Error(`devReviewLoop: dispatching ${vendor} failed (${handle.failureReason}).`)
}

async function pollUntil<T>(
  fn: () => T | null,
  maxAttempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  timeoutMessage: string
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = fn()
    if (result !== null) return result
    await sleep(intervalMs)
  }
  throw new Error(timeoutMessage)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

function sizeOfSafe(path: string): number {
  try {
    return readFileSync(path).byteLength
  } catch {
    return 0
  }
}

/**
 * True when a line APPENDED SINCE `priorSize` (never the whole file — a
 * prior round can log the identical shape, e.g. another `round_started`)
 * carries `meta.run_id === runId` and, stripped of `meta`/`subject`, deep-
 * equals `event`. Mirrors `dispatch.ts`'s private `hasOwnDispatchLine`,
 * matched on the event's own shape instead of an `effect_id` — `DevReviewLoopEvent`
 * carries none.
 */
function hasOwnLoopLine(path: string, priorSize: number, runId: string, event: DevReviewLoopEventInput): boolean {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    return false
  }
  if (buf.byteLength <= priorSize) return false
  for (const raw of buf.subarray(priorSize).toString('utf8').split('\n')) {
    if (!raw) continue
    try {
      const obj = JSON.parse(raw) as { meta?: { run_id?: unknown }; [k: string]: unknown }
      if (obj.meta?.run_id !== runId) continue
      const { meta: _meta, subject: _subject, ...rest } = obj
      if (deepEqual(rest, event)) return true
    } catch {
      // not a JSON line — never trusted blindly
    }
  }
  return false
}

/**
 * `log()` is fire-and-forget (`log-sink.ts`'s own `.then()` chain, no
 * returned promise) — a caller that fires the next `log()` call right after
 * can race a still-pending write, exactly `dispatch.ts`'s own
 * `waitForDispatchLine` doc comment describes for its equivalent hazard, and
 * this driver logs SEVERAL events per round, back to back. Not merely
 * theoretical: observed live authoring this task, two `log()` calls in the
 * same synchronous loop landed OUT OF ORDER in the outbox — `resolveRepo()`
 * only caches a DETERMINISTIC outcome (`resolve-repo.ts`'s own doc comment);
 * on an unresolvable repo (this task's own test fixtures; no git remote) it
 * caches NOTHING, so every `log()` call races an independent, uncached async
 * resolution. Waiting for a raw line COUNT to reach N after firing N calls
 * does not fix this — it can be satisfied by N lines in the WRONG order.
 * `logEvents` (below) awaits THIS, per event, before firing the next
 * `log()` call, so no two of this driver's own writes are ever in flight at
 * once — order follows call order because nothing races.
 */
async function waitForOwnLoopLine(
  path: string,
  priorSize: number,
  runId: string,
  event: DevReviewLoopEventInput,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hasOwnLoopLine(path, priorSize, runId, event)) return
    await sleep(5)
  }
  // Best-effort durability wait, not a correctness gate — `log()` itself
  // never throws, and a timeout here is already `log()`'s own silently-
  // warned failure mode (an unwritable outbox, an unresolvable repo, or a
  // schema violation `log()` refused and warned about instead of writing).
}

type RoundVerdictParse = { observation: VerdictObservation; rendered: string }

function buildVerdictFromReport(
  role: 'reviewer' | 'security',
  workDir: string,
  headSha: string,
  agent: AgentVendor,
  taskId: number,
  handle: DispatchHandle
): RoundVerdictParse {
  const reportRaw = readIfExists(join(workDir, 'report.txt')) ?? ''
  const report = parseReport(reportRaw)
  const sessionId = handle.resumeId ?? '(unknown)'
  const tokensIn = handle.usage ? String(handle.usage.input) : '—'
  const tokensOut = handle.usage ? String(handle.usage.output) : '—'
  const roleLabel = role === 'reviewer' ? ('Reviewer' as const) : ('Security' as const)

  const escalateClass = report.ESCALATE
  if (escalateClass !== undefined) {
    if (!isEscalationClass(escalateClass)) {
      throw new Error(
        `devReviewLoop: ${role}'s report.txt carries \`ESCALATE: ${escalateClass}\`, not one of authority|strategy|product.`
      )
    }
    const rendered = renderEscalationComment({
      headSha,
      escalationClass: escalateClass as EscalationClass,
      summary: report.SUMMARY ?? '(no summary given)',
      role: role === 'reviewer' ? 'review' : 'security',
      roleLabel,
      objectivesVersion: null,
      taskId: String(taskId),
      model: agent,
      tokensIn,
      tokensOut,
      cost: '—',
      sessionId
    })
    return { observation: { role, verdict: 'ESCALATE', objectives: [], findings: [] }, rendered }
  }

  const findingsRaw = readIfExists(join(workDir, 'findings.txt')) ?? ''
  const allowedSeverities =
    role === 'reviewer' ? (['BLOCKER', 'MAJOR', 'MINOR'] as const) : (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)
  const findings: Finding[] = findingsRaw.trim() ? parseFindingsFile(findingsRaw, allowedSeverities) : []

  const objectivesRaw = readIfExists(join(workDir, 'objectives.txt'))
  const objectiveResults = objectivesRaw?.trim() ? parseObjectivesFile(objectivesRaw) : []
  const objectives = objectiveResults.map((o) => ({ id: o.id, met: o.status === 'MET' }))

  const findingObservations = findings.map((f, i) => ({ id: `F${i + 1}`, severity: f.severity, state: null }))

  if (role === 'reviewer') {
    const verdict = deriveCodeReviewVerdict(findings)
    const rendered = renderCodeReviewComment({
      headSha,
      verdict,
      briefConformance: report.BRIEF_CONFORMANCE ?? '(not reported)',
      specConformance: report.SPEC_CONFORMANCE ?? '(not reported)',
      findings,
      scope: report.SCOPE ?? '(not reported)',
      scopeEvidence: null,
      tests: report.TESTS ?? '(not reported)',
      docs: report.DOCS ?? '(not reported)',
      objectivesVersion: null,
      objectiveResults: null,
      taskId: String(taskId),
      model: agent,
      tokensIn,
      tokensOut,
      cost: '—',
      sessionId
    })
    return {
      observation: {
        role,
        verdict: verdict === 'APPROVE' ? 'APPROVE' : 'REQUEST CHANGES',
        objectives,
        findings: findingObservations
      },
      rendered
    }
  }

  const verdict = deriveSecurityVerdict(findings)
  const rendered = renderSecurityComment({
    headSha,
    verdict,
    findings,
    configScan: report.CONFIG_SCAN ?? '(not reported)',
    secrets: report.SECRETS ?? 'none found',
    secretsEvidence: null,
    objectivesVersion: null,
    objectiveResults: null,
    taskId: String(taskId),
    model: agent,
    tokensIn,
    tokensOut,
    cost: '—',
    sessionId
  })
  return { observation: { role, verdict, objectives, findings: findingObservations }, rendered }
}

function renderReviewerDispatchPrompt(
  role: 'reviewer' | 'security',
  facts: ReviewerPromptFacts,
  workDir: string
): string {
  const base = renderReviewerPrompt(facts)
  const lint = lintReviewerPrompt(base)
  if (lint.length > 0) {
    throw new Error(
      `devReviewLoop: renderReviewerPrompt produced banned framing: ${lint.join('; ')} — fix the renderer, never the lint.`
    )
  }
  const roleLine =
    role === 'reviewer' ? 'You are the code-reviewer for this round.' : 'You are the security reviewer for this round.'
  const instructions = [
    roleLine,
    'Review the PR at the HEAD above against the OBJECTIVES and RULINGS above.',
    `Write your findings to ${join(workDir, 'findings.txt')}, one per line: SEVERITY|file:line|description`,
    role === 'reviewer'
      ? '(severities: BLOCKER, MAJOR, MINOR — leave the file empty if there are none).'
      : '(severities: CRITICAL, HIGH, MEDIUM, LOW — leave the file empty if there are none).',
    `Write a short report to ${join(workDir, 'report.txt')} as one \`KEY: value\` line per field:`,
    role === 'reviewer' ? '  BRIEF_CONFORMANCE, SPEC_CONFORMANCE, SCOPE, TESTS, DOCS' : '  CONFIG_SCAN, SECRETS',
    'To escalate instead of casting a verdict, write only `ESCALATE: authority|strategy|product` and `SUMMARY: <text>` to report.txt.'
  ].join('\n')
  return `${base}\n\n${instructions}`
}

/**
 * Dispatches the developer through `dispatchRole`, with the brief text read
 * from the Issue's frozen `aeg:brief:v1` comment (O1), waits for the PR the
 * developer opens, then runs rounds by calling `assessRound` with
 * observations read from the forge and from held reviewer outcomes, until
 * a `publish` or `pause` decision.
 */
export async function devReviewLoop(input: LoopInput, deps: Partial<LoopDeps> = {}): Promise<LoopResult> {
  const d: LoopDeps = { ...defaultDeps(), ...deps }
  const { log, runId } = createLogSink()
  if (!process.env.VINAYA_RUN_ID) process.env.VINAYA_RUN_ID = runId
  // `buildHeader` derives `subject.issue` (and thus the outbox file this
  // loop's OWN `log()` calls land in) purely from `env.VINAYA_TASK`
  // (`envelope.ts`'s `issueFromTask`) — never self-declared. `dispatchRole`
  // sets it on each CHILD's env already; this driver's own top-level events
  // (`loop_started`, `round_started`, …) need it on THIS process's env too,
  // or they land under the `none` bucket instead of this task's.
  process.env.VINAYA_TASK = String(input.task)

  // Primes `resolveRepo()`'s process-lifetime cache BEFORE this loop's own
  // `log()` calls start racing each other on it (see `waitForLoopLineCount`'s
  // doc comment) — every later call in this process, including the ones
  // inside `log()` itself, resolves the identical value instantly.
  const repo = await resolveRepo().catch(() => null)
  const branch = d.developerBranchFor(input.task)
  const root = d.outboxRoot()
  const repoRoot = d.repoRoot()
  const confidenceFilePath = join(repoRoot, '.worktrees', branch, CONFIDENCE_FILE_NAME)
  const loopOutboxPath = outboxPathFor({ outboxRoot: () => root }, repo, input.task)
  /**
   * Awaits EACH event's own landing before firing the next `log()` call —
   * not just the batch's last one. `resolveRepo()` only caches a
   * DETERMINISTIC outcome (a parsed `AEG_REPO`, or a successful git-remote
   * lookup); on an unresolvable repo (no remote, or the lookup itself
   * throws) it caches nothing (`resolve-repo.ts`'s own doc comment) — every
   * `log()` call in that case races an independent, uncached async
   * resolution, and two calls fired back-to-back can land out of order
   * (observed live: `gate_result_read` beat `round_started` to the file).
   * Sequencing each write removes the race outright rather than merely
   * waiting for the LAST one and hoping the rest arrived in order.
   */
  async function logEvents(events: readonly DevReviewLoopEventInput[]): Promise<void> {
    for (const e of events) {
      const priorSize = sizeOfSafe(loopOutboxPath)
      log(e)
      await waitForOwnLoopLine(loopOutboxPath, priorSize, runId, e, d.sleep)
    }
  }

  const config: LoopConfig = {
    loopId: randomUUID(),
    task: input.task,
    // `loop_started`'s own schema constrains `policy.reviewers`/`policy.models`
    // keys to `RoleSchema` (`schema.ts`) — the DOCTRINE role vocabulary
    // (`code-reviewer`), not `VerdictObservation.role`'s separate
    // `'reviewer' | 'security'` vocabulary this driver uses everywhere else
    // for the policy's own findings/verdict shape. Using `'reviewer'` here
    // fails schema validation silently (`log()` never throws — `loop_started`
    // just never lands in the outbox; found live authoring this task).
    reviewers: ['code-reviewer', 'security'],
    models: { developer: input.agent, 'code-reviewer': input.agent, security: input.agent }
  }
  let state: LoopState = initialLoopState(config)

  let round = 1
  let devResumeId: string | null = null
  let devDispatchSucceededBefore = false
  let prNumber = -1 // resolved below, before any use — never read while -1
  let lastReviewContext: string | null = null

  async function dispatchDeveloper(prompt: string, roundNum: number): Promise<DispatchHandle> {
    const isResume = devResumeId !== null
    const handle = await withPromptFile(prompt, (promptFile) =>
      d.dispatchRole('developer', input.agent, prompt, {
        task: input.task,
        round: roundNum,
        resumeId: devResumeId ?? undefined,
        promptFile
      })
    )
    await assertDispatchOrEscalate(handle, input.agent, isResume, devDispatchSucceededBefore)
    if (!handle.failureReason) {
      devDispatchSucceededBefore = true
      if (handle.resumeId) devResumeId = handle.resumeId
    }
    return handle
  }

  async function dispatchReviewer(
    role: 'reviewer' | 'security',
    roundNum: number,
    facts: ReviewerPromptFacts
  ): Promise<RoundVerdictParse> {
    const workDir = reviewerWorkDir(root, input.task, roundNum, role)
    mkdirSync(workDir, { recursive: true })
    const dispatchRoleName = role === 'reviewer' ? ('code-reviewer' as const) : ('security' as const)
    const prompt = renderReviewerDispatchPrompt(role, facts, workDir)
    const handle = await withPromptFile(prompt, (promptFile) =>
      d.dispatchRole(dispatchRoleName, input.agent, prompt, { task: input.task, round: roundNum, promptFile })
    )
    await assertDispatchOrEscalate(handle, input.agent, false, false)
    const parsed = buildVerdictFromReport(role, workDir, facts.head, input.agent, input.task, handle)
    writeHeldVerdict(root, input.task, roundNum, role, parsed.rendered)
    return parsed
  }

  function computeStats(head: string, roundStartMs: number): RoundStats {
    const baseHead = d.gitRevParseOriginMain()
    d.gitFetch(head)
    const { filesChanged, insertions, deletions } = parseShortstat(d.gitDiffShortstat(baseHead, head))
    return { baseHead, head, filesChanged, insertions, deletions, wallMs: d.now() - roundStartMs }
  }

  async function waitForGreenGate(
    roundStartMs: number
  ): Promise<{ green: boolean; stats: RoundStats; ciConclusion: 'green' | 'red' | 'pending' }> {
    const head = d.resolveHead(branch)
    const conclusion = await pollUntil(
      () => {
        const c = d.fetchCiConclusion(head)
        return c === 'pending' ? null : c
      },
      d.gatePollMaxAttempts,
      d.gatePollIntervalMs,
      d.sleep,
      `devReviewLoop: CI never resolved off 'pending' for head ${head} within the poll budget.`
    ).catch(() => 'red' as const)
    return { green: conclusion === 'green', stats: computeStats(head, roundStartMs), ciConclusion: conclusion }
  }

  function readAndClearConfidence(): Confidence {
    const content = readIfExists(confidenceFilePath)
    try {
      unlinkSync(confidenceFilePath)
    } catch {
      // Never written, or already gone — nothing to clean up.
    }
    return content ? parseConfidenceReply(content) : 'absent'
  }

  // Round 1: fresh dispatch, brief read from the frozen Issue comment (O1).
  const roundStart0 = d.now()
  const brief = d.fetchFrozenBrief(input.task)
  await dispatchDeveloper(brief, round)

  prNumber = await pollUntil(
    () => d.findOpenPrForBranch(branch),
    d.prPollMaxAttempts,
    d.prPollIntervalMs,
    d.sleep,
    `devReviewLoop: no open PR appeared for branch \`${branch}\` within the poll budget.`
  ).then((pr) => pr.number)

  let decision: Decision = { type: 'dispatch_developer' }
  let roundStartMs = roundStart0
  let firstPass = true

  /**
   * Round-number discipline: `round` increments ONLY when a genuine review
   * round (`dispatch_reviewers` → `verdicts`) concludes `changes_requested`
   * and hands back `dispatch_developer` for the next real round. A
   * mechanical-gate-red retry and a confidence-collapse "extra turn" (spec
   * §6.7: "may repeat once, for the same round") both resubmit the SAME
   * round number — `assessGate` itself is built for exactly this (`pending`
   * clears on both paths, and `state.extraTurnUsed` is a flat, round-
   * independent flag, so reusing the round number changes nothing about
   * whether the confidence rule's one-extra-turn bound is honored).
   * Advancing `round` on every `dispatch_developer` instead would make a
   * mechanical CI hiccup on round 1 silently start asking the round-1-never-
   * asks confidence question — a real behavioral bug, not a style choice.
   */
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (decision.type === 'dispatch_developer') {
      if (!firstPass) {
        const prompt = [
          lastReviewContext
            ? `Round ${round} review findings:\n\n${lastReviewContext}\n`
            : 'CI was red on the last head — fix and push.',
          'Address the findings above per aeg-root/roles/developer.md. Push fixes as new commits on the SAME branch; do not open a new PR.',
          round >= 2 ? CONFIDENCE_PROMPT_LINE : ''
        ]
          .filter(Boolean)
          .join('\n\n')
        roundStartMs = d.now()
        await dispatchDeveloper(prompt, round)
      }
      firstPass = false

      const gate = await waitForGreenGate(roundStartMs)
      const confidence = round >= 2 && gate.green ? readAndClearConfidence() : undefined
      const obs: Observations = { kind: 'gate', round, green: gate.green, confidence, stats: gate.stats }
      const result = assessRound(state, obs)
      state = result.state
      decision = result.decision
      await logEvents(result.events)
      d.flushOutbox(input.task)
    } else if (decision.type === 'ask_confidence') {
      const reaskPrompt = `Your last reply did not include a valid confidence line.\n\n${CONFIDENCE_PROMPT_LINE}`
      await dispatchDeveloper(reaskPrompt, round)
      const head = d.resolveHead(branch)
      const stats = computeStats(head, roundStartMs)
      const confidence = readAndClearConfidence()
      const obs: Observations = { kind: 'gate', round, green: true, confidence, stats }
      const result = assessRound(state, obs)
      state = result.state
      decision = result.decision
      await logEvents(result.events)
      d.flushOutbox(input.task)
    } else if (decision.type === 'dispatch_reviewers') {
      const head = d.resolveHead(branch)
      const ciConclusion = d.fetchCiConclusion(head)
      const objectives = d.fetchFrozenBrief(input.task)
      const rulings = d.fetchRulings(prNumber)
      const facts: ReviewerPromptFacts = { objectives, rulings, head, ciConclusion }

      const [reviewer, security] = await Promise.all([
        dispatchReviewer('reviewer', round, facts),
        dispatchReviewer('security', round, facts)
      ])
      lastReviewContext = `${reviewer.rendered}\n\n---\n\n${security.rendered}`

      const obs: Observations = { kind: 'verdicts', round, verdicts: [reviewer.observation, security.observation] }
      const result = assessRound(state, obs)
      state = result.state
      decision = result.decision
      await logEvents(result.events)
      d.flushOutbox(input.task)
      if (decision.type === 'dispatch_developer') round += 1
    }

    if (decision.type === 'publish' || decision.type === 'pause') {
      d.flushOutbox(input.task)
      return { finalDecision: decision, prNumber }
    }
  }
}

export const DEV_REVIEW_LOOP_AGENTS = AGENT_VENDOR_NAMES
