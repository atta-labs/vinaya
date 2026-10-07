/**
 * `vinaya task-tools review-result-proof --agent <claude|codex>` — the live
 * proof that each CLI delivers a REVIEWER's result (`review-result.ts`) as its
 * own native structured final output, committed as a repeatable command beside
 * `result-proof.ts` (the Developer's), whose stream readers and argv it reuses.
 *
 * Reviewers differ from the Developer in ways that proof does not exercise, so
 * every case here is a reviewer-shaped dispatch on this host: a fresh,
 * non-resumed session; the agent's own sandbox where the host supports it and
 * the subscription login; read-only grants (Claude Code `--tools
 * Read,Glob,Grep`, Codex `--sandbox read-only`); and the staged inputs a real
 * reviewer reads — a diff and the one review-input manifest (built by the same
 * `buildReviewInputManifest`) — in a throwaway two-commit repository, so the
 * real worktree is never an input. No dev-tools server is registered: a
 * reviewer has no write tools.
 *
 * The result is requested through the CLI's native structured output — Claude
 * Code `--json-schema` under `--output-format stream-json`, Codex
 * `--output-schema` under `exec --json` — for both the code-reviewer and the
 * security-reviewer role.
 *
 * The cases: both reviewers running CONCURRENTLY against one manifest, each
 * accepted result attributed to its own role; then, one live dispatch each, a
 * role mismatch, a wrong head, a wrong manifest digest, an objective id outside
 * the brief, a severity outside the role's scale (both roles), a finding with
 * no file, a finding with no line (accepted), a `blocked` result, malformed
 * output, no result at all, a cancelled run, a provider error and context
 * exhaustion. Everything but the concurrent pair and the no-line case must end
 * as NO REVIEW, never approval.
 *
 * It prints, for every case, whether a schema-valid result reached the driver
 * and what the controller made of it. It never writes the forge, never touches
 * the loop's reviewer dispatch or its result files, and designs no fallback: a
 * failing case is reported as observed.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { buildReviewInputManifest, DEFAULT_REVIEW_POLICY, type Role } from '@attalabs/aeg-core'
import { buildCodexExecpolicyRules, vendorSessionArgs, writeDispatchSettingsAt } from '../dispatch.js'
import {
  type CompletedReview,
  classifyReviewOutcome,
  manifestDigest,
  type NoReviewReason,
  REVIEW_RESULT_SCHEMA_VERSION,
  REVIEWER_ROLES,
  type ReviewBinding,
  type ReviewerRole,
  type ReviewOutcome,
  RoundReviews,
  reviewResultJsonSchema
} from '../review-result.js'
import {
  buildWorkerEnv,
  realConfinementPlatformDeps,
  resolveClaudeConfinement,
  stageCodexPolicyHome
} from '../worker-boundary.js'
import { confinedTmpEnv, resolveProofConfinement } from './dev-proof.js'
import {
  accountEnv,
  beforeStdinMarker,
  clip,
  cliVersion,
  type Launch,
  providerText,
  readClaudeTurnOutput,
  readCodexTurnOutput,
  runChild,
  type TurnRead
} from './result-proof.js'

export type ReviewProofAgent = 'claude' | 'codex'

/** Parses `--agent <claude|codex>` out of the command's argv. */
export function parseReviewProofArgs(args: readonly string[]): { agent: ReviewProofAgent } | { error: string } {
  const idx = args.indexOf('--agent')
  if (idx === -1 || idx === args.length - 1) {
    return { error: 'vinaya task-tools review-result-proof: missing required --agent <claude|codex>' }
  }
  const agent = args[idx + 1]
  if (agent !== 'claude' && agent !== 'codex') {
    return {
      error: `vinaya task-tools review-result-proof: --agent must be 'claude' or 'codex', got ${JSON.stringify(agent)}`
    }
  }
  return { agent }
}

/** The loop's own role names for the two reviewers (`Role`), which the dispatch settings and sandbox are keyed on. */
const LOOP_ROLE: Record<ReviewerRole, Role> = { 'code-reviewer': 'code-reviewer', 'security-reviewer': 'security' }

/** The objectives the staged brief carries — a result naming any other id is refused. */
export const PROOF_OBJECTIVE_IDS = ['O1', 'O2'] as const

const STAGED_FILE = 'src/greeting.ts'

/** The staged review inputs and what the controller binds every result to. */
export type StagedReview = {
  dir: string
  headSha: string
  baseSha: string
  manifestDigest: string
}

/**
 * Builds the throwaway candidate: a two-commit repository whose diff is the
 * review subject, plus `review-input/` — the manifest (from the same builder
 * the loop uses, with its digest), the diff, and the objectives.
 */
export function stageReviewInputs(root: string): StagedReview {
  const dir = join(root, 'candidate')
  mkdirSync(join(dir, 'src'), { recursive: true })
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', ...args],
      { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root } }
    ).trim()
  git('init', '--quiet')
  writeFileSync(join(dir, STAGED_FILE), 'export function greet(name: string): string {\n  return "Hello " + name\n}\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const baseSha = git('rev-parse', 'HEAD')
  writeFileSync(
    join(dir, STAGED_FILE),
    'export function greet(name: string): string {\n  return "Hello " + name.trim()\n}\n\nexport const DEFAULT = greet(undefined as unknown as string)\n'
  )
  git('add', '.')
  git('commit', '--quiet', '-m', 'head')
  const headSha = git('rev-parse', 'HEAD')
  const diff = git('diff', baseSha, headSha)
  const manifest = buildReviewInputManifest({
    headSha,
    baseSha,
    briefContent: 'proof brief',
    objectivesVersion: 'staged-objectives',
    rulingOrdinal: 0,
    policy: DEFAULT_REVIEW_POLICY
  })
  const digest = manifestDigest(manifest)
  const inputs = join(dir, 'review-input')
  mkdirSync(inputs)
  writeFileSync(join(inputs, 'manifest.json'), `${JSON.stringify({ ...manifest, manifestDigest: digest }, null, 2)}\n`)
  writeFileSync(join(inputs, 'diff.patch'), `${diff}\n`)
  writeFileSync(
    join(inputs, 'objectives.txt'),
    'O1 greet trims its argument.\nO2 the module has no import-time side effect.\n'
  )
  return { dir, headSha, baseSha, manifestDigest: digest }
}

export function bindingFor(role: ReviewerRole, staged: StagedReview): ReviewBinding {
  return { role, headSha: staged.headSha, manifestDigest: staged.manifestDigest, objectiveIds: PROOF_OBJECTIVE_IDS }
}

/** What a case requires of its outcome. */
export type ReviewExpectation =
  /** A schema-valid, bound, semantically valid review was accepted, and it is the emission `summary` names. */
  | { kind: 'review'; summary: string; check?: (result: CompletedReview) => string | null }
  /** No review: the outcome is `no_review`, for one of `reasons`. */
  | { kind: 'no_review'; reasons: readonly NoReviewReason[] }

/** Judges one case's outcome and its read against its expectation; the lines say why. */
export function judgeReviewCase(
  expectation: ReviewExpectation,
  outcome: ReviewOutcome,
  read: TurnRead
): { pass: boolean; why: string[] } {
  const why: string[] = []
  let pass = true
  const fail = (line: string): void => {
    pass = false
    why.push(`FAIL: ${line}`)
  }
  if (expectation.kind === 'review') {
    if (outcome.kind !== 'review') fail(`no review accepted (${outcome.reason}: ${clip(outcome.detail, 200)})`)
    else {
      if (outcome.result.summary !== expectation.summary) {
        fail(`accepted summary ${JSON.stringify(outcome.result.summary)} is not ${JSON.stringify(expectation.summary)}`)
      } else why.push(`accepted result is the expected emission (summary ${JSON.stringify(expectation.summary)})`)
      const extra = expectation.check?.(outcome.result) ?? null
      if (extra !== null) fail(extra)
      if (read.terminalResults !== 1) fail(`${read.terminalResults} terminal results — exactly one must be accepted`)
      else why.push('exactly one result accepted')
    }
  } else if (outcome.kind === 'review') {
    fail('a review was accepted — this case must end with no review')
  } else if (!expectation.reasons.includes(outcome.reason)) {
    fail(
      `no review, but for ${outcome.reason} — expected ${expectation.reasons.join(' or ')}: ${clip(outcome.detail, 200)}`
    )
  } else why.push(`recorded as no review (${outcome.reason}): ${clip(outcome.detail, 300)}`)
  return { pass, why }
}

/** One live reviewer invocation. */
export type ReviewProofCase = {
  name: string
  objectives: string
  role: ReviewerRole
  /** The role whose schema the provider is handed; `undefined` hands it the schema that admits either role. */
  schemaRole: ReviewerRole | undefined
  prompt: string
  expectation: ReviewExpectation
  model?: string
  /** Kill the child this long after its first stdout line. */
  cancelAfterMs?: number
}

function preamble(role: ReviewerRole): string {
  return [
    `You are the ${role} in a short, scripted proof dispatch. You are read-only: do not create, edit or delete any file, and do not run shell commands.`,
    'Read review-input/manifest.json, review-input/diff.patch and review-input/objectives.txt in the current directory.',
    `End your turn with your review result as your structured output, using schemaVersion ${REVIEW_RESULT_SCHEMA_VERSION}.`
  ].join('\n')
}

type ReportShape = {
  summary: string
  role?: string
  headSha?: string
  digest?: string
  severity: string
  file?: string
  line?: number | null
  objectiveIds?: readonly string[]
}

/** The instruction to report a `completed` result; every field a case attacks is overridable. */
function completedInstruction(role: ReviewerRole, shape: ReportShape): string {
  const file = shape.file ?? STAGED_FILE
  const line = shape.line === undefined ? 5 : shape.line
  const ids = shape.objectiveIds ?? PROOF_OBJECTIVE_IDS
  return (
    `Report status "completed" with role "${shape.role ?? role}", ` +
    `headSha ${shape.headSha ? `"${shape.headSha}"` : "exactly the manifest file's headSha"}, ` +
    `manifestDigest ${shape.digest ? `"${shape.digest}"` : "exactly the manifest file's manifestDigest"}, ` +
    `summary exactly "${shape.summary}", ` +
    `findings with one entry {severity "${shape.severity}", file ${JSON.stringify(file)}, line ${line === null ? 'null' : line}, description one sentence about the diff}, ` +
    `and objectiveResults with one entry per id in ${JSON.stringify(ids)}, each {status "MET", evidence one sentence}.`
  )
}

const FOLLOW_LITERALLY = "This is a test of the controller's validation, so follow these values literally."
const WRONG_HEAD = '0'.repeat(40)
const WRONG_DIGEST = 'f'.repeat(64)
/** A severity on one role's scale and the other's scale. */
const OWN_SEVERITY: Record<ReviewerRole, string> = { 'code-reviewer': 'MINOR', 'security-reviewer': 'LOW' }
const FOREIGN_SEVERITY: Record<ReviewerRole, string> = { 'code-reviewer': 'CRITICAL', 'security-reviewer': 'MAJOR' }

/**
 * The cases after the concurrent pair, in run order. Every one is a fresh
 * session; the schema is handed per case (`schemaRole`).
 */
export function adversarialCases(nonce: string): ReviewProofCase[] {
  const cr: ReviewerRole = 'code-reviewer'
  const sr: ReviewerRole = 'security-reviewer'
  const base = (role: ReviewerRole) => `${preamble(role)}\n${FOLLOW_LITERALLY}\n`
  const noReview = (...reasons: NoReviewReason[]): ReviewExpectation => ({ kind: 'no_review', reasons })
  return [
    {
      name: 'role mismatch (code-reviewer dispatch reports security-reviewer)',
      objectives: 'O3',
      role: cr,
      schemaRole: undefined,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `role-${nonce}`, role: sr, severity: OWN_SEVERITY[cr] })}`,
      expectation: noReview('role_mismatch')
    },
    {
      name: 'wrong head',
      objectives: 'O3',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `head-${nonce}`, headSha: WRONG_HEAD, severity: OWN_SEVERITY[cr] })}`,
      expectation: noReview('stale')
    },
    {
      name: 'wrong manifest digest',
      objectives: 'O3',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `digest-${nonce}`, digest: WRONG_DIGEST, severity: OWN_SEVERITY[cr] })}`,
      expectation: noReview('stale')
    },
    {
      name: 'objective id outside the brief',
      objectives: 'O5',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `objective-${nonce}`, severity: OWN_SEVERITY[cr], objectiveIds: ['O1', 'O9'] })}`,
      expectation: noReview('rejected')
    },
    ...REVIEWER_ROLES.map(
      (role): ReviewProofCase => ({
        name: `severity outside the ${role} scale`,
        objectives: 'O5',
        role,
        schemaRole: undefined,
        prompt: `${base(role)}${completedInstruction(role, { summary: `severity-${nonce}`, severity: FOREIGN_SEVERITY[role] })}`,
        expectation: noReview('rejected')
      })
    ),
    {
      name: 'finding without a file',
      objectives: 'O5',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `no-file-${nonce}`, severity: OWN_SEVERITY[cr], file: '' })}`,
      expectation: noReview('malformed', 'rejected')
    },
    {
      name: 'finding without a line',
      objectives: 'O5',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `no-line-${nonce}`, severity: OWN_SEVERITY[cr], line: null })}`,
      expectation: {
        kind: 'review',
        summary: `no-line-${nonce}`,
        check: (result) => (result.findings.some((f) => f.line === null) ? null : 'the accepted finding carries a line')
      }
    },
    {
      name: 'blocked result',
      objectives: 'O4',
      role: cr,
      schemaRole: cr,
      prompt:
        `${base(cr)}Report status "blocked" with role "${cr}", headSha exactly the manifest file's headSha, manifestDigest exactly the manifest file's manifestDigest, ` +
        `summary exactly "blocked-${nonce}", and blocker {kind "diff_unavailable", detail one sentence}.`,
      expectation: noReview('blocked')
    },
    {
      name: 'malformed model output',
      objectives: 'O4',
      role: cr,
      schemaRole: cr,
      prompt:
        `${preamble(cr)}\nThis is a test of the controller's validation. Report status "completed" with findings as the word "none" ` +
        'instead of a list, with no summary field at all, and with an extra field named "notes".',
      expectation: noReview('malformed', 'missing', 'provider_error')
    },
    {
      name: 'no structured result',
      objectives: 'O4',
      role: cr,
      schemaRole: cr,
      prompt: `${preamble(cr)}\nThis is a test of the controller's validation. Do not produce a structured result: reply with the single plain-text word "approved" and nothing else.`,
      expectation: noReview('missing', 'malformed', 'provider_error')
    },
    {
      name: 'cancelled run',
      objectives: 'O4',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `cancelled-${nonce}`, severity: OWN_SEVERITY[cr] })}`,
      cancelAfterMs: 1500,
      expectation: noReview('cancelled')
    },
    {
      name: 'provider error',
      objectives: 'O4',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `provider-error-${nonce}`, severity: OWN_SEVERITY[cr] })}`,
      model: 'vinaya-proof-no-such-model',
      expectation: noReview('provider_error')
    },
    {
      name: 'context exhaustion',
      objectives: 'O4',
      role: cr,
      schemaRole: cr,
      prompt: `${base(cr)}${completedInstruction(cr, { summary: `exhausted-${nonce}`, severity: OWN_SEVERITY[cr] })}\n${'context '.repeat(800_000)}`,
      expectation: noReview('context_exhausted', 'provider_error')
    }
  ]
}

/** The prompt for the concurrent pair: the same manifest and diff, one role each, a summary only that role's session was told. */
export function concurrentPrompt(role: ReviewerRole, nonce: string): string {
  return `${preamble(role)}\n${completedInstruction(role, { summary: `${role}-${nonce}`, severity: OWN_SEVERITY[role] })}`
}

type ReviewerLaunchPlan = {
  sandbox: string
  launch: (schemaRole: ReviewerRole | undefined, model: string | undefined) => Launch
}

/** One reviewer launch plan: its own scratch, settings/CODEX_HOME and sandbox, read-only grants, and the one structured-output flag. */
function planReviewerLaunch(
  agent: ReviewProofAgent,
  role: ReviewerRole,
  candidateDir: string,
  root: string
): ReviewerLaunchPlan {
  const scratchDir = join(root, `scratch-${role}`)
  mkdirSync(scratchDir, { recursive: true })
  const runId = randomUUID()
  const loopRole = LOOP_ROLE[role]
  if (agent === 'claude') {
    const confinement = resolveClaudeConfinement(
      { role: loopRole, agent: 'claude', worktreeDir: candidateDir, scratchDir, allowedHosts: [] },
      realConfinementPlatformDeps()
    )
    const confined = confinement.ok && confinement.confined ? confinement.settings : null
    const settingsPath = writeDispatchSettingsAt(
      join(scratchDir, 'hooks'),
      runId,
      [],
      loopRole,
      candidateDir,
      [],
      [],
      confined
    )
    if (settingsPath === null) throw new Error('the dispatch settings file could not be written')
    return {
      sandbox: confined
        ? "ON — Claude Code's own sandbox, in the dispatch settings file"
        : `OFF (disclosed) — ${confinement.ok && !confinement.confined ? confinement.warning : 'unavailable'}`,
      launch: (schemaRole, model) => ({
        args: [
          ...vendorSessionArgs('claude', model),
          '--tools',
          'Read,Glob,Grep',
          '--settings',
          settingsPath,
          '--json-schema',
          JSON.stringify(reviewResultJsonSchema(schemaRole))
        ],
        env: buildWorkerEnv(process.env, {
          ...accountEnv(process.env, () => userInfo().username),
          VINAYA_RUN_ID: runId,
          ...confinedTmpEnv(confined !== null, scratchDir)
        })
      })
    }
  }
  const confinement = resolveProofConfinement('codex', loopRole, candidateDir, scratchDir)
  const codexHome = confinement.codexHome ?? join(scratchDir, 'codex-home')
  const staged =
    confinement.codexSandboxToml !== null
      ? stageCodexPolicyHome({
          targetDir: codexHome,
          realHome: homedir(),
          execpolicyRules: buildCodexExecpolicyRules(loopRole) ?? '',
          sandboxConfigToml: confinement.codexSandboxToml
        })
      : null
  if (staged === null) mkdirSync(codexHome, { recursive: true })
  let schemaCount = 0
  return {
    sandbox: confinement.confined ? `ON — ${confinement.detail}` : `OFF (disclosed) — ${confinement.detail}`,
    launch: (schemaRole, model) => {
      const schemaPath = join(scratchDir, `review-result-${schemaCount++}.schema.json`)
      writeFileSync(schemaPath, `${JSON.stringify(reviewResultJsonSchema(schemaRole), null, 2)}\n`)
      const args = vendorSessionArgs('codex', model).map((a) => (a === 'workspace-write' ? 'read-only' : a))
      return {
        args: beforeStdinMarker(args, ['--output-schema', schemaPath]),
        env: buildWorkerEnv(process.env, {
          ...accountEnv(process.env, () => userInfo().username),
          CODEX_HOME: codexHome,
          VINAYA_RUN_ID: runId,
          ...confinedTmpEnv(confinement.confined, scratchDir)
        })
      }
    }
  }
}

type CaseRun = { read: TurnRead; outcome: ReviewOutcome; exit: string; stderrTail: string; spawnError?: string }

async function runReviewer(
  agent: ReviewProofAgent,
  plan: ReviewerLaunchPlan,
  proofCase: Pick<ReviewProofCase, 'schemaRole' | 'prompt' | 'model' | 'cancelAfterMs'>,
  candidateDir: string,
  binding: ReviewBinding,
  shownArgs: (args: string[]) => void
): Promise<CaseRun> {
  const launch = plan.launch(proofCase.schemaRole, proofCase.model)
  shownArgs(launch.args.map((a) => (a.startsWith('{') ? '<schema>' : a)))
  const ran = await runChild(agent, launch, proofCase.prompt, candidateDir, proofCase.cancelAfterMs)
  const read = agent === 'claude' ? readClaudeTurnOutput(ran.stdout) : readCodexTurnOutput(ran.stdout)
  const cancelled = proofCase.cancelAfterMs !== undefined && ran.signal !== null
  const errors = [...read.errors, ...(ran.spawnError ? [ran.spawnError] : [])]
  const stderrTail = ran.stderr.trim().split('\n').slice(-3).join(' | ')
  if (read.event === null && errors.length === 0 && stderrTail.length > 0 && ran.exitCode !== 0) errors.push(stderrTail)
  const outcome = classifyReviewOutcome(
    { cancelled, terminal: read.terminal, errors, hasResult: read.event !== null, raw: read.raw },
    binding
  )
  return {
    read,
    outcome,
    exit: `code ${ran.exitCode}${ran.signal ? `, signal ${ran.signal}` : ''}; terminal event: ${read.terminal ?? '(none)'}`,
    stderrTail,
    spawnError: ran.spawnError
  }
}

function describeOutcome(out: (line?: string) => void, run: CaseRun): void {
  const { read, outcome } = run
  out(`exit: ${run.exit}`)
  out(`provider session: ${read.sessionId ?? '(none reported)'}`)
  out(`structured emissions seen: ${read.emissions.length}`)
  for (const emission of read.emissions) out(`  ${clip(JSON.stringify(emission))}`)
  if (read.errors.length > 0) out(`stream errors: ${providerText(read.errors.join(' | '))}`)
  if (run.stderrTail.length > 0) out(`stderr tail: ${providerText(run.stderrTail)}`)
  out(`event read: ${read.event ?? '(none)'}`)
  out(`schema-valid result reached the driver: ${outcome.kind === 'review' || isValidShape(outcome) ? 'yes' : 'no'}`)
  out(
    outcome.kind === 'review'
      ? `controller: accepted review — ${JSON.stringify(outcome.result)}`
      : `controller: NO REVIEW (${outcome.reason}) — ${clip(providerText(outcome.detail), 400)}`
  )
}

/** Whether a no-review outcome was a schema-valid result the controller then refused (as opposed to nothing valid ever arriving). */
function isValidShape(outcome: ReviewOutcome): boolean {
  return (
    outcome.kind === 'no_review' &&
    ['stale', 'role_mismatch', 'rejected', 'blocked', 'duplicate'].includes(outcome.reason)
  )
}

/** The command entry point: run every case for one agent and print the report. */
export async function reviewResultProofCommand(args: string[]): Promise<void> {
  const parsed = parseReviewProofArgs(args)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`)
    process.exitCode = 2
    return
  }
  const { agent } = parsed
  const nonce = randomBytes(4).toString('hex')
  const root = mkdtempSync(join(tmpdir(), `vinaya-review-proof-${agent}-`))
  const out = (line = ''): void => {
    process.stdout.write(`${line}\n`)
  }
  let allPass = true
  const summaries: string[] = []
  const sessions = new Map<string, string>()
  try {
    const staged = stageReviewInputs(root)
    const plans = Object.fromEntries(
      REVIEWER_ROLES.map((role) => [role, planReviewerLaunch(agent, role, staged.dir, root)])
    ) as Record<ReviewerRole, ReviewerLaunchPlan>
    out(`\n=== Reviewer result — native structured output proof — agent: ${agent} ===`)
    out(`host: ${process.platform} ${process.arch}`)
    out(`CLI version: ${cliVersion(agent)}`)
    out(
      `schema: ReviewResult v${REVIEW_RESULT_SCHEMA_VERSION} via ${agent === 'claude' ? '--json-schema' : '--output-schema'}`
    )
    out(`sandbox: ${plans['code-reviewer'].sandbox}`)
    out(
      `read-only grants: ${agent === 'claude' ? '--tools Read,Glob,Grep' : '--sandbox read-only'}; no dev-tools server registered`
    )
    out(
      `staged review inputs: head ${staged.headSha}, base ${staged.baseSha}, manifest digest ${staged.manifestDigest}`
    )
    out(`brief objectives: ${PROOF_OBJECTIVE_IDS.join(', ')}`)

    const record = (name: string, pass: boolean, line: string): void => {
      if (!pass) allPass = false
      summaries.push(`${pass ? 'PASS' : 'FAIL'}  ${name} — ${line}`)
    }
    const noteSession = (name: string, run: CaseRun): string | null => {
      const id = run.read.sessionId
      if (id === null) return null
      const earlier = sessions.get(id)
      sessions.set(id, name)
      return earlier === undefined ? null : `provider session ${id} was already used by case "${earlier}" — not fresh`
    }

    // --- both reviewers, concurrently, against one manifest ---
    out('\n--- case: concurrent reviewers, one manifest (O1 O2 O6) ---')
    const shown: Record<string, string[]> = {}
    const pair = await Promise.all(
      REVIEWER_ROLES.map((role) =>
        runReviewer(
          agent,
          plans[role],
          { schemaRole: role, prompt: concurrentPrompt(role, nonce) },
          staged.dir,
          bindingFor(role, staged),
          (a) => {
            shown[role] = a
          }
        )
      )
    )
    const round = new RoundReviews()
    let pairPass = true
    for (const [i, role] of REVIEWER_ROLES.entries()) {
      const run = pair[i] as CaseRun
      out(`\n  [${role}] invocation: ${agent} ${(shown[role] ?? []).join(' ')}`)
      describeOutcome(out, run)
      const judged = judgeReviewCase(
        {
          kind: 'review',
          summary: `${role}-${nonce}`,
          check: (r) => (r.role === role ? null : `result names ${r.role}`)
        },
        run.outcome,
        run.read
      )
      const recorded = round.offer(role, run.outcome)
      if (recorded.kind !== 'review') {
        judged.pass = false
        judged.why.push('FAIL: the round did not record this review')
      }
      const reused = noteSession(`concurrent ${role}`, run)
      if (reused) {
        judged.pass = false
        judged.why.push(`FAIL: ${reused}`)
      } else judged.why.push('fresh provider session')
      for (const line of judged.why) out(`  ${line}`)
      if (!judged.pass) pairPass = false
    }
    const first = round.get('code-reviewer')
    if (first !== undefined) {
      const second = round.offer('code-reviewer', { kind: 'review', result: first })
      const refused = second.kind === 'no_review' && second.reason === 'duplicate'
      out(`  a second result for code-reviewer this round: ${refused ? 'refused (duplicate)' : 'ACCEPTED'}`)
      if (!refused) pairPass = false
    }
    if (round.size !== REVIEWER_ROLES.length) pairPass = false
    out(`  reviews accepted this round: ${round.size} of ${REVIEWER_ROLES.length}, one per role`)
    out(`verdict: ${pairPass ? 'PASS' : 'FAIL'}`)
    record('concurrent reviewers, one manifest', pairPass, `accepted ${round.size} of ${REVIEWER_ROLES.length}`)

    // --- adversarial and failure cases, each a fresh session ---
    for (const proofCase of adversarialCases(nonce)) {
      out(`\n--- case: ${proofCase.name} (${proofCase.objectives}; role ${proofCase.role}) ---`)
      const run = await runReviewer(
        agent,
        plans[proofCase.role],
        proofCase,
        staged.dir,
        bindingFor(proofCase.role, staged),
        (a) => out(`invocation: ${agent} ${a.join(' ')}`)
      )
      if (run.spawnError) {
        out(`FAIL: could not spawn ${agent}: ${run.spawnError}`)
        record(proofCase.name, false, `could not spawn ${agent}`)
        continue
      }
      describeOutcome(out, run)
      const judged = judgeReviewCase(proofCase.expectation, run.outcome, run.read)
      const reused = noteSession(proofCase.name, run)
      if (reused) {
        judged.pass = false
        judged.why.push(`FAIL: ${reused}`)
      }
      for (const line of judged.why) out(`  ${line}`)
      out(`verdict: ${judged.pass ? 'PASS' : 'FAIL'}`)
      const failures = judged.why.filter((l) => l.startsWith('FAIL: '))
      record(
        proofCase.name,
        judged.pass,
        run.outcome.kind === 'review'
          ? 'accepted review'
          : `no review (${run.outcome.reason})${failures.length > 0 ? `; ${clip(failures.join(' / '), 300)}` : ''}`
      )
    }
    out(`\n=== summary — ${agent} ===`)
    for (const line of summaries) out(line)
    out(`PROOF: ${allPass ? 'PASS' : 'FAIL'}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  if (!allPass) process.exitCode = 1
}
