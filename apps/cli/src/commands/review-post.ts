/**
 * `vinaya review post` (fix/vinaya-review-post). A Reviewer submits
 * structured data — verdict, findings, role — and this command renders
 * `roles/reviewer.md`/`roles/security.md`'s exact bare-line template,
 * resolves the PR's real head itself, posts the comment, and refuses to
 * exit 0 unless its own post re-parses clean through the SAME
 * `extractCodeReviewVerdict`/`extractSecurityReviewVerdict` functions
 * `checkReviewGate` calls (`@attalabs/aeg-core`'s `verdict-extraction.ts` —
 * reused, never re-implemented, so this command cannot silently drift from
 * what the merge gate actually checks).
 *
 * Why this exists: a Reviewer agent free-typing markdown into
 * `gh pr comment --body-file` can produce any shape, including a decorated
 * heading (`## Security Review — PASS`) the gate's line-anchored regex
 * cannot see at all — measured live, twice, with no pointer back to what was
 * wrong until CI went red minutes later. The fix is to remove the discretion
 * entirely: the caller supplies only per-field CONTENT (conformance prose,
 * a findings list, scan notes); every structural line (`VERDICT:`,
 * `Judged head:`) is rendered by this command's own code from validated
 * enum/sha inputs, never from a caller-supplied string.
 *
 * `--role code-reviewer` and `--role security` are the only two shapes —
 * mirroring `reviewer.md`/`security.md`'s templates exactly, including each
 * doc's own internal consistency rule (a BLOCKER finding forces
 * REQUEST CHANGES; a CRITICAL/HIGH finding forces FAIL; an unbacked
 * "SECRETS: none found" is refused without `--secrets-evidence-file`) — so
 * this command catches the same category of mistake at the source, not just
 * the shape of the line.
 *
 * Findings file grammar: one finding per line, `SEVERITY|file:line|description`
 * — `|` is the delimiter because `file:line` already contains a colon.
 * Severity vocab is role-specific (`BLOCKER|MAJOR|MINOR` for code-reviewer,
 * `CRITICAL|HIGH|MEDIUM|LOW` for security) and findings are re-sorted by
 * severity regardless of input order, so the rendered "ordered by severity"
 * claim never depends on the caller having gotten the ordering right.
 *
 * Self-verification (the part that actually closes the gap): after posting,
 * this command re-fetches the PR's comments, filters them to the same
 * `PRINCIPAL_ALLOWLIST`/`principals`-derived author set `checkReviewGate`
 * itself filters to (the #806 verdict-author-verification fix — a
 * non-allowlisted "VERDICT:"-shaped comment must never count, in either
 * direction), and runs the survivors through the exact gate-side extractors.
 * A single fetch-and-check, deliberately with no retry loop — a retry here
 * would risk masking a genuine GitHub comment-propagation race as a
 * transient hiccup (`aeg-root/roles/developer.md`'s stop-condition
 * discipline: report a real race precisely, never paper over it). Measured
 * during this task's own end-to-end run: an immediate re-fetch reliably saw
 * the just-posted comment, so no such race was ever observed here.
 *
 * "Self-verified: clean" proves format and head-binding only — `--verdict`
 * and each finding's severity remain caller-asserted, by the brief's explicit
 * scope. This command mechanizes the SHAPE of a verdict, never the judgment
 * behind it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractCodeReviewVerdict,
  extractSecurityReviewVerdict,
  isPrincipal,
  type ReviewGateComment,
  type VerdictExtraction
} from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../lib/config'
import { printJson } from '../lib/envelope'
import { makeCheckError, refuse } from '../lib/forge-write'

// --- shared finding grammar ---------------------------------------------------

export type Finding = { severity: string; location: string; description: string }

export class FindingsParseError extends Error {}

const CODE_REVIEW_SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'] as const
const SECURITY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const

/**
 * Parses the `SEVERITY|file:line|description` findings-file grammar. Throws
 * `FindingsParseError` (never silently drops or reinterprets a malformed
 * line) naming the exact line and what was wrong with it.
 */
export function parseFindingsFile(content: string, allowedSeverities: readonly string[]): Finding[] {
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  return lines.map((line, idx) => {
    const parts = line.split('|')
    if (parts.length !== 3) {
      throw new FindingsParseError(
        `findings file line ${idx + 1}: expected exactly 3 \`|\`-delimited fields (SEVERITY|file:line|description), found ${parts.length}: ${line}`
      )
    }
    const severity = (parts[0] as string).trim().toUpperCase()
    const location = (parts[1] as string).trim()
    const description = (parts[2] as string).trim()
    if (!allowedSeverities.includes(severity)) {
      throw new FindingsParseError(
        `findings file line ${idx + 1}: severity "${parts[0]}" is not one of ${allowedSeverities.join('|')}: ${line}`
      )
    }
    if (!location || !description) {
      throw new FindingsParseError(
        `findings file line ${idx + 1}: file:line and description must both be non-empty: ${line}`
      )
    }
    return { severity, location, description }
  })
}

/** Re-orders by severity rank, stable within a rank — the rendered "ordered by severity" claim never depends on caller-supplied ordering. */
export function sortBySeverity(findings: readonly Finding[], order: readonly string[]): Finding[] {
  return findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) => order.indexOf(a.f.severity) - order.indexOf(b.f.severity) || a.i - b.i)
    .map(({ f }) => f)
}

export function renderFindingsSection(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'None.'
  return findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.location} — ${f.description}`).join('\n')
}

function renderTokensLine(role: 'review' | 'security', roleLabel: 'Reviewer' | 'Security', input: TokensInput): string {
  return `Tokens: ${input.taskId}: ${role} — ${roleLabel} — ${input.model} — ${input.tokensIn}/${input.tokensOut}/${input.cost}`
}

/**
 * Records which role and session cast this verdict — a shared local `gh`
 * credential means the forge attributes the comment itself to the
 * Principal regardless (`atta-labs/vinaya#176`), so this line is the only
 * place an agent-authored verdict is visibly agent-authored. It closes
 * nothing on its own; it makes the inheritance auditable.
 */
function renderCastByLine(roleLabel: 'Reviewer' | 'Security', sessionId: string): string {
  return `Cast by: ${roleLabel} (session ${sessionId})`
}

/**
 * `CLAUDE_CODE_SESSION_ID` is the same best-effort session identifier
 * `report-tokens.ts`'s transcript resolver already cross-checks (set in
 * every Claude Code Bash tool call — confirmed empirically, not documented
 * in the public hook schema) — reused here rather than inventing a second
 * identifier scheme. Falls back to a literal marker, never a fabricated
 * value, when unset (a different host, or no session concept at all).
 */
export function resolveSessionId(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CODE_SESSION_ID ?? '(unknown)'
}

type TokensInput = {
  taskId: string
  model: string
  tokensIn: string
  tokensOut: string
  cost: string
  sessionId: string
}

// --- code-reviewer shape ------------------------------------------------------

export type CodeReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES'

export type CodeReviewInput = TokensInput & {
  headSha: string
  verdict: CodeReviewVerdict
  briefConformance: string
  specConformance: string
  findings: readonly Finding[]
  scope: string
  tests: string
  docs: string
}

const CODE_REVIEW_VERDICT_TEXT: Record<CodeReviewVerdict, string> = {
  APPROVE: 'APPROVE',
  REQUEST_CHANGES: 'REQUEST CHANGES'
}

/**
 * Renders `reviewer.md`'s exact bare template. `VERDICT:`/`Judged head:` are
 * built from `input.verdict`/`input.headSha` through this function's own
 * literal strings — there is no code path by which a caller-supplied string
 * can land in either position.
 */
export function renderCodeReviewComment(input: CodeReviewInput): string {
  const sorted = sortBySeverity(input.findings, CODE_REVIEW_SEVERITIES)
  return [
    `VERDICT: ${CODE_REVIEW_VERDICT_TEXT[input.verdict]}`,
    '',
    `Judged head: ${input.headSha}`,
    '',
    `BRIEF CONFORMANCE: ${input.briefConformance}`,
    `SPEC CONFORMANCE: ${input.specConformance}`,
    '',
    'FINDINGS (ordered by severity):',
    renderFindingsSection(sorted),
    '',
    `SCOPE: ${input.scope}`,
    `TESTS: ${input.tests}`,
    `DOCS: ${input.docs}`,
    '',
    renderTokensLine('review', 'Reviewer', input),
    renderCastByLine('Reviewer', input.sessionId)
  ].join('\n')
}

// --- security shape ------------------------------------------------------------

export type SecurityVerdict = 'PASS' | 'FAIL'

export type SecurityInput = TokensInput & {
  headSha: string
  verdict: SecurityVerdict
  findings: readonly Finding[]
  configScan: string
  /** The `SECRETS:` line's own text, e.g. `none found` or `listed above, redacted`. */
  secrets: string
  /** Raw scanner output backing a `none found` claim; null when not supplied. */
  secretsEvidence: string | null
}

/** `security.md`'s "none found" claim, tolerant of `none-found`/extra whitespace/case. */
export function isNoneFoundClaim(value: string): boolean {
  return value.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ') === 'none found'
}

/**
 * Renders `security.md`'s exact bare template. Same no-caller-injection
 * guarantee as `renderCodeReviewComment` for `VERDICT:`/`Judged head:`. When
 * `secretsEvidence` is supplied, the scanner's raw output is pasted in a
 * fenced block ABOVE the `SECRETS:` line, per `security.md`'s own rule that
 * the pasted evidence must appear there to back the claim.
 */
export function renderSecurityComment(input: SecurityInput): string {
  const sorted = sortBySeverity(input.findings, SECURITY_SEVERITIES)
  const lines = [
    `VERDICT: ${input.verdict}`,
    '',
    `Judged head: ${input.headSha}`,
    '',
    'FINDINGS (ordered by severity):',
    renderFindingsSection(sorted),
    '',
    `CONFIG SCAN: ${input.configScan}`,
    ''
  ]
  if (input.secretsEvidence !== null) {
    lines.push('```', input.secretsEvidence, '```', '')
  }
  lines.push(
    `SECRETS: ${input.secrets}`,
    '',
    renderTokensLine('security', 'Security', input),
    renderCastByLine('Security', input.sessionId)
  )
  return lines.join('\n')
}

// --- self-verification ---------------------------------------------------------

export type SelfVerifyResult = { ok: boolean; reason: string }

/**
 * True when `extraction.headSha` covers `headSha` — the identical binding
 * rule `review-gate.ts`'s `isBoundToHead` uses, so a comment this command
 * considers "clean" is exactly what the merge gate will also consider clean.
 */
function isBoundToHead(extraction: { headSha: string | null }, headSha: string): boolean {
  if (!extraction.headSha) return false
  return headSha.toLowerCase().startsWith(extraction.headSha.toLowerCase())
}

function checkExtraction(extraction: VerdictExtraction, expectedValue: string, headSha: string): SelfVerifyResult {
  if (extraction.danglingNote) {
    return {
      ok: false,
      reason: `no clean VERDICT was found on re-fetch (${extraction.danglingNote}) — the posted comment does not match the gate's line-anchored \`VERDICT:\` pattern.`
    }
  }
  if (extraction.value !== expectedValue) {
    return {
      ok: false,
      reason: `re-extraction found VERDICT "${extraction.value}", expected "${expectedValue}" — the posted comment's VERDICT line does not match what this command rendered.`
    }
  }
  if (!extraction.headSha) {
    return { ok: false, reason: 'the winning VERDICT comment carries no `Judged head:` line on re-fetch.' }
  }
  if (!isBoundToHead(extraction, headSha)) {
    return {
      ok: false,
      reason: `re-extraction found \`Judged head: ${extraction.headSha}\`, which does not cover the resolved head ${headSha}.`
    }
  }
  return { ok: true, reason: 'clean' }
}

/**
 * Same author filter `checkReviewGate` applies before calling either
 * extractor (the #806 verdict-author-verification fix) — a non-allowlisted
 * "VERDICT:"-shaped comment must never count toward self-verification either,
 * or "self-verified: clean" would not be a faithful proxy for what the real
 * merge gate concludes at CI time.
 */
function principalBodies(comments: readonly ReviewGateComment[], principalAllowlist: readonly string[]): string[] {
  return comments.filter((c) => isPrincipal(c.author, principalAllowlist as string[])).map((c) => c.body)
}

export function verifyPostedCodeReview(
  comments: readonly ReviewGateComment[],
  verdict: CodeReviewVerdict,
  headSha: string,
  principalAllowlist: readonly string[]
): SelfVerifyResult {
  return checkExtraction(
    extractCodeReviewVerdict(principalBodies(comments, principalAllowlist)),
    CODE_REVIEW_VERDICT_TEXT[verdict],
    headSha
  )
}

export function verifyPostedSecurity(
  comments: readonly ReviewGateComment[],
  verdict: SecurityVerdict,
  headSha: string,
  principalAllowlist: readonly string[]
): SelfVerifyResult {
  return checkExtraction(extractSecurityReviewVerdict(principalBodies(comments, principalAllowlist)), verdict, headSha)
}

// --- CLI plumbing ----------------------------------------------------------

/**
 * Never consumes a token that itself looks like a flag (`--foo`) as the
 * PRECEDING flag's value — a misordered invocation (a nullary flag left
 * un-filtered before this call, or simply a missing value) sets that flag to
 * `''` instead, so a real `requireFlag` refusal fires loudly on the flag that
 * is actually missing, rather than silently swallowing the NEXT flag's name
 * and value (review finding, PR #144: `--role` immediately before a
 * `--json`-like token used to eat the following `--verdict APPROVE` pair
 * whole with no error at all).
 */
export function parseFlags(args: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    // `--` ends the options. `unknownFlags` stops scanning here, so if this did
    // not, an argument past the marker would silently override a real flag —
    // `--verdict X -- --verdict Y` posting `Y` with the refusal blind to it.
    if (a === '--') break
    if (!a.startsWith('--')) continue
    // `--flag=value` keyed on the whole token used to land in the map under a
    // name nothing reads, so the flag was accepted by the refusal check and
    // then silently dropped — `--findings-file=x` rendered `FINDINGS … None.`
    // and the BLOCKER-versus-APPROVE cross-check quietly became a no-op. The
    // `=` spelling is accepted elsewhere in this CLI, so it is parsed, not
    // refused.
    const eq = a.indexOf('=')
    if (eq > 2) {
      map.set(a.slice(0, eq), a.slice(eq + 1))
      continue
    }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) {
      map.set(a, '')
      continue
    }
    map.set(a, value)
    i++
  }
  return map
}

function refuseCmd(message: string, recovery: string): never {
  refuse([makeCheckError('review-post', message, recovery)])
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const v = flags.get(name)
  if (v === undefined || v === '') {
    refuseCmd(`Missing required \`${name}\` flag.`, `Pass \`${name} <value>\`, then re-run \`vinaya review post ...\`.`)
  }
  return v
}

function requireTokenField(flags: Map<string, string>, name: string): string {
  const v = requireFlag(flags, name)
  if (v !== '-' && !/^\d+$/.test(v)) {
    refuseCmd(
      `\`${name} ${v}\` is neither a non-negative integer nor \`-\` (unknown).`,
      `Pass a whole number or \`-\` for ${name}.`
    )
  }
  return v
}

function readFindingsFile(path: string | undefined, allowedSeverities: readonly string[]): Finding[] {
  if (path === undefined) return []
  // `--findings-file=` and `--findings-file` with nothing after it both yield
  // `''`, which used to collapse onto "flag omitted" — so a caller who meant to
  // pass findings silently posted none, and the BLOCKER-versus-APPROVE and
  // CRITICAL/HIGH-versus-PASS cross-checks had nothing to fire on. Naming the
  // flag and passing no path is a mistake, not a choice.
  if (path.trim() === '') {
    refuseCmd(
      '`--findings-file` was given with no path.',
      'Pass the path to the findings file, or omit the flag entirely if there are no findings.'
    )
  }
  if (!path) return []
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    refuseCmd(`Could not read findings file at ${path}.`, 'Check the path and re-run.')
  }
  try {
    return parseFindingsFile(content, allowedSeverities)
  } catch (err) {
    if (err instanceof FindingsParseError) {
      refuseCmd(err.message, 'Fix the malformed line in the findings file, then re-run.')
    }
    throw err
  }
}

function normalizeCodeReviewVerdict(raw: string): CodeReviewVerdict {
  const v = raw
    .trim()
    .toUpperCase()
    .replace(/[-\s]+/g, '_')
  if (v === 'APPROVE') return 'APPROVE'
  if (v === 'REQUEST_CHANGES') return 'REQUEST_CHANGES'
  refuseCmd(
    `\`--verdict ${raw}\` is not APPROVE or REQUEST_CHANGES.`,
    'Pass `--verdict APPROVE` or `--verdict REQUEST_CHANGES`.'
  )
}

function normalizeSecurityVerdict(raw: string): SecurityVerdict {
  const v = raw.trim().toUpperCase()
  if (v === 'PASS') return 'PASS'
  if (v === 'FAIL') return 'FAIL'
  refuseCmd(`\`--verdict ${raw}\` is not PASS or FAIL.`, 'Pass `--verdict PASS` or `--verdict FAIL`.')
}

function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    throw new Error(String(stderr ?? (err as Error).message).trim() || 'gh command failed')
  }
}

/** `gh pr view <n> --json headRefOid` — never an agent-supplied sha (`aeg-root/roles/developer.md`'s head-resolution rule every gate in this repo already follows). */
function resolveHeadSha(pr: string): string {
  let out: string
  try {
    out = gh(['pr', 'view', pr, '--json', 'headRefOid', '-q', '.headRefOid'])
  } catch (err) {
    refuseCmd(
      `Could not resolve PR ${pr}'s head via \`gh pr view --json headRefOid\`: ${err instanceof Error ? err.message : String(err)}`,
      'Confirm `gh auth status` passes and the PR number is correct, then re-run.'
    )
  }
  if (!out) {
    refuseCmd(`\`gh pr view ${pr} --json headRefOid\` returned no head sha.`, 'Confirm PR exists, then re-run.')
  }
  return out
}

function postComment(pr: string, body: string): string {
  const tmp = join(tmpdir(), `vinaya-review-post-${process.pid}-${Date.now()}.md`)
  writeFileSync(tmp, body)
  try {
    return gh(['pr', 'comment', pr, '--body-file', tmp]).trim()
  } catch (err) {
    refuseCmd(
      `Rendered comment failed to post via \`gh pr comment\`: ${err instanceof Error ? err.message : String(err)}`,
      'Check `gh auth status`/network, then re-run — nothing was posted.'
    )
  } finally {
    rmSync(tmp, { force: true })
  }
}

function fetchComments(pr: string): ReviewGateComment[] {
  const out = gh(['pr', 'view', pr, '--json', 'comments'])
  const parsed = JSON.parse(out) as { comments: { body: string; author?: { login?: string } | null }[] }
  return parsed.comments.map((c) => ({ body: c.body, author: c.author?.login ?? null }))
}

/**
 * Every flag this command reads, plus the nullary ones stripped before the
 * pairwise scan. An argument starting with `--` that is not here is refused
 * (`rejectUnknownFlags`) rather than ignored.
 *
 * Silently ignoring was the old behaviour and it cost a real forge write: a
 * reviewer passed `--print-only` — a genuine flag on `vinaya waiver`, and a
 * reasonable guess here — intending a dry run, and this command posted the
 * verdict anyway (atta-labs/vinaya#184). The failure direction is the wrong
 * one: the caller's intent was "do not post", and the outcome was a governance
 * verdict on a real PR, consumed by a blocking merge gate.
 *
 * Declaring the VALUE-taking flags separately also retires the `--json`
 * special case rather than adding a second one beside it. The scan consumes
 * the next token as a value, so a nullary flag left in it is misread as the
 * next flag's value and the flag after that vanishes — found live in PR #144,
 * fixed then for `--json` alone. Knowing which flags take values fixes the
 * class.
 */
const VALUE_FLAGS = [
  '--brief-conformance',
  '--config-scan',
  '--cost',
  '--docs',
  '--findings-file',
  '--model',
  '--pr',
  '--role',
  '--scope',
  '--secrets',
  '--secrets-evidence-file',
  '--spec-conformance',
  '--task-id',
  '--tests',
  '--tokens-in',
  '--tokens-out',
  '--verdict'
] as const
const NULLARY_FLAGS = ['--json'] as const

/**
 * Exported so `review-post.test.ts` can re-derive this surface from the source
 * and prove the tables cover it. The first version of this table omitted
 * `--tokens-in`/`--tokens-out`, which made the command refuse the exact
 * invocation `roles/reviewer.md` prescribes AND that `requireTokenField`
 * demands two lines later — a refusal loop with no way out, in the one command
 * whose job is to post an honest verdict. A hand-kept list of a thing the file
 * already states is a second copy, and the second copy is the one that rots.
 */
export const FLAG_TABLES = { value: VALUE_FLAGS, nullary: NULLARY_FLAGS } as const

/**
 * Every unrecognised `--flag` in `args`, in order. PURE — it decides, it does
 * not exit, so the decision is unit-testable without a process boundary.
 */
export function unknownFlags(args: string[], known: readonly string[] = [...VALUE_FLAGS, ...NULLARY_FLAGS]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    // Position first, shape second. A token consumed as the VALUE of a known
    // value flag is never a flag, whatever it looks like — `--scope "- clean"`,
    // `--cost "-$1.20"` and `--tests "-.5% regression"` are all legitimate, and
    // a shape-only heuristic refused every one of them with no way to pass the
    // text at all.
    if (known.includes(a) && !NULLARY_FLAGS.includes(a as (typeof NULLARY_FLAGS)[number])) {
      // Skip the value exactly as `parseFlags` consumes it — and it declines a
      // `--`-prefixed token, so `--pr --bogus 178` still reports `--bogus`
      // rather than swallowing it as a value.
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) i++
      continue
    }
    // `--` is the POSIX end-of-options marker, not a flag named `--`. Refusing
    // it with a list of valid flags would explain nothing. `parseFlags` stops
    // at the same token, so the two agree about where the options end — an
    // earlier version of this comment asserted that agreement without it
    // holding, which let an argument past the marker override a real flag.
    if (a === '--') break
    // A single dash is the near-miss that motivated this: `-print-only` is one
    // keystroke from the spelling that shipped a verdict nobody asked for.
    const looksLikeFlag = a.startsWith('--') || (a.startsWith('-') && a.length > 1)
    if (!looksLikeFlag) continue
    const name = a.split('=')[0] as string
    if (!known.includes(name)) {
      out.push(name)
      continue
    }
    // `--json=true` reads as known, then `args.includes('--json')` is false and
    // the caller silently gets no JSON. A nullary flag takes no value.
    if (NULLARY_FLAGS.includes(name as (typeof NULLARY_FLAGS)[number]) && a.includes('=')) out.push(name)
  }
  return out
}

/** Refuses when `unknownFlags` finds any, naming all of them. */
export function rejectUnknownFlags(
  args: string[],
  known: readonly string[] = [...VALUE_FLAGS, ...NULLARY_FLAGS]
): void {
  // `unknownFlags` returns names only, never `--flag=value` — a refusal is
  // printed to stderr and lands in CI logs, and an argv value can be a token.
  const unknown = unknownFlags(args, known)
  if (unknown.length === 0) return
  refuseCmd(
    `unrecognised flag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
    `\`vinaya review post\` accepts: ${[...known].sort().join(', ')}. If you meant to preview without posting, note that this command has no dry-run flag — see atta-labs/vinaya#184.`
  )
}

export async function reviewPostCommand(args: string[]): Promise<void> {
  // Before anything is rendered or resolved: an unknown flag here means the
  // caller asked for something this command does not do, and posting anyway
  // is the one outcome that cannot be taken back.
  rejectUnknownFlags(args)
  const json = args.includes('--json')
  const flags = parseFlags(args.filter((a) => !NULLARY_FLAGS.includes(a as (typeof NULLARY_FLAGS)[number])))

  const role = flags.get('--role')
  if (role !== 'code-reviewer' && role !== 'security') {
    refuseCmd(
      `\`--role ${role ?? '(missing)'}\` is not \`code-reviewer\` or \`security\`.`,
      'Pass `--role code-reviewer` or `--role security`.'
    )
  }

  const pr = requireFlag(flags, '--pr')
  const taskId = requireFlag(flags, '--task-id')
  const model = requireFlag(flags, '--model')
  const tokensIn = requireTokenField(flags, '--tokens-in')
  const tokensOut = requireTokenField(flags, '--tokens-out')
  const cost = requireFlag(flags, '--cost')
  const sessionId = resolveSessionId(process.env)
  const tokens: TokensInput = { taskId, model, tokensIn, tokensOut, cost, sessionId }

  const headSha = resolveHeadSha(pr)
  // Same trust anchor `checkReviewGate` itself uses — the repo's own
  // `principals` field on the default branch (never the PR's checkout),
  // falling back to the hardcoded `PRINCIPAL_ALLOWLIST` on any read failure.
  const principalAllowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())

  let body: string
  let verify: (comments: ReviewGateComment[]) => SelfVerifyResult

  if (role === 'code-reviewer') {
    const verdict = normalizeCodeReviewVerdict(requireFlag(flags, '--verdict'))
    const findings = readFindingsFile(flags.get('--findings-file'), CODE_REVIEW_SEVERITIES)
    if (findings.some((f) => f.severity === 'BLOCKER') && verdict === 'APPROVE') {
      refuseCmd(
        'Findings include a BLOCKER but `--verdict APPROVE` — reviewer.md requires REQUEST CHANGES whenever any BLOCKER finding exists.',
        'Pass `--verdict REQUEST_CHANGES`, or fix the finding severity if BLOCKER was a miscategorization.'
      )
    }
    const input: CodeReviewInput = {
      ...tokens,
      headSha,
      verdict,
      briefConformance: requireFlag(flags, '--brief-conformance'),
      specConformance: requireFlag(flags, '--spec-conformance'),
      findings,
      scope: requireFlag(flags, '--scope'),
      tests: requireFlag(flags, '--tests'),
      docs: requireFlag(flags, '--docs')
    }
    body = renderCodeReviewComment(input)
    verify = (comments) => verifyPostedCodeReview(comments, verdict, headSha, principalAllowlist)
  } else {
    const verdict = normalizeSecurityVerdict(requireFlag(flags, '--verdict'))
    const findings = readFindingsFile(flags.get('--findings-file'), SECURITY_SEVERITIES)
    if (findings.some((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH') && verdict === 'PASS') {
      refuseCmd(
        'Findings include a CRITICAL/HIGH finding but `--verdict PASS` — security.md requires FAIL whenever any CRITICAL or HIGH finding exists.',
        'Pass `--verdict FAIL`, or fix the finding severity if it was a miscategorization.'
      )
    }
    const secrets = requireFlag(flags, '--secrets')
    const secretsEvidenceFile = flags.get('--secrets-evidence-file')
    if (isNoneFoundClaim(secrets) && !secretsEvidenceFile) {
      refuseCmd(
        '`--secrets` normalizes to "none found" but no `--secrets-evidence-file` was given — security.md: "SECRETS: none found" with no scan output pasted is an unbacked self-attestation.',
        'Pass `--secrets-evidence-file <path>` containing the actual scanner output, or change `--secrets` to describe what was found instead.'
      )
    }
    let secretsEvidence: string | null = null
    if (secretsEvidenceFile) {
      try {
        secretsEvidence = readFileSync(secretsEvidenceFile, 'utf8')
      } catch {
        refuseCmd(`Could not read secrets evidence file at ${secretsEvidenceFile}.`, 'Check the path and re-run.')
      }
    }
    const input: SecurityInput = {
      ...tokens,
      headSha,
      verdict,
      findings,
      configScan: requireFlag(flags, '--config-scan'),
      secrets,
      secretsEvidence
    }
    body = renderSecurityComment(input)
    verify = (comments) => verifyPostedSecurity(comments, verdict, headSha, principalAllowlist)
  }

  const url = postComment(pr, body)

  let comments: ReviewGateComment[]
  try {
    comments = fetchComments(pr)
  } catch (err) {
    refuseCmd(
      `Posted the comment (${url}) but could not re-fetch PR ${pr}'s comments to self-verify: ${err instanceof Error ? err.message : String(err)}`,
      'Check `gh auth status`/network and manually confirm the posted comment parses cleanly — this command could not verify it.'
    )
  }

  const result = verify(comments)
  if (!result.ok) {
    refuseCmd(
      `Posted comment ${url}, but self-verification FAILED on re-parse: ${result.reason}`,
      'The posted comment does not re-parse clean through the same extractCodeReviewVerdict/extractSecurityReviewVerdict functions the merge gate calls. Do not treat the post as valid — inspect the comment and this command for drift, fix, and re-run.'
    )
  }

  if (json) {
    printJson({ posted: true, url, role, headSha, selfVerified: true })
  } else {
    process.stdout.write(
      `${body}\n\nPosted: ${url}\nSelf-verification: clean — re-parsed VERDICT is bound to head ${headSha}.\n`
    )
  }
}
