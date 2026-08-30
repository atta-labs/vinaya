import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { formatBreakdown, formatTokensLine, resolveMeteringCapability } from '@attalabs/aeg-core'
import type { MeteringCapabilityDeps, TranscriptSummary, UsageComponents } from '@attalabs/aeg-core'
import { gitCommonDir, isTokensCollectTrusted, loadConfig, trustTokensCollectCommand } from '../lib/config.js'
import type { VinayaConfig } from '../lib/config.js'

/**
 * `vinaya tokens` — the portable front door over the token-report
 * collection adapter (`aeg-root/tranche-model.md` §12 layer 2). Fixes the
 * gap `packages/aeg-core/bin/report-tokens.ts` cannot: that script is
 * invoked by a repo-relative path (`bun packages/aeg-core/bin/report-tokens.ts`)
 * that exists only inside this monorepo checkout, never in an adopter that
 * installed `@attalabs/vinaya` as a package. This command imports
 * `resolveMeteringCapability`/`formatTokensLine`/`formatBreakdown` from the
 * INSTALLED `@attalabs/aeg-core` package — no repo-relative path anywhere —
 * so the same capability is reachable wherever the package is installed.
 *
 * Three ways to a `Tokens:` line, tried in this order:
 *   - **Manual** (`--in <tokens-in> --out <tokens-out>`): an explicit
 *     per-invocation override. Skips both routes below entirely and renders
 *     the given figures through the same unchanged `formatTokensLine`
 *     grammar — for a host whose figures arrive by some other means than
 *     either route below (an API usage response, a meter an operator read
 *     off a dashboard).
 *   - **Declared** (`tokens.collect` in a repo-local `vinaya.config.json`,
 *     checked when `--in`/`--out` are absent): for a non-Claude-Code host.
 *     Runs the declared shell command, and parses its stdout as JSON
 *     matching the `TranscriptSummary` seam (`inputTokens`/`outputTokens`/
 *     `cacheCreationInputTokens`/`cacheReadInputTokens`/`model`). Wins
 *     outright when declared — never silently falls through to the
 *     transcript route on a run/parse failure, since that would risk
 *     masking a real collection bug behind a plausible-looking
 *     transcript-route result. See `config.ts`'s `tokens` comment for the
 *     full trust framing (same class as `ci.setup`). **Gated on trust**
 *     (security review, PR #303, round 2): a declared command never runs
 *     until a human has explicitly approved that exact command string for
 *     this repo on this machine, via `vinaya tokens --trust-collect` — see
 *     `config.ts`'s `tokens.collect trust cache` section for the full
 *     mechanism and why it survives this repo's per-task fresh worktrees.
 *   - **Transcript-based** (default, or `--transcript <path>`, when
 *     `tokens.collect` is undeclared): resolves a Claude Code session
 *     transcript (explicit path, or the Stop-hook pointer file) and
 *     summarizes real usage. Throws — never emits a plausible `0/0/—` —
 *     when the transcript can't be resolved, read, or yields zero usage
 *     records (`resolveMeteringCapability`'s three incapable reasons).
 */

const USAGE = [
  'Usage: vinaya tokens --phase "<task-id>: develop" --role Developer',
  '  [--model <id>] [--transcript <path>] [--in <tokens-in> --out <tokens-out>]',
  '',
  '  --transcript   Read this transcript directly. Supported primary route — use it whenever you know',
  '                 which transcript is yours, and always in a repo with no track-transcript.sh hook.',
  '  (omitted)      Resolve via the Stop-hook pointer file, if this repo installs that hook.',
  '  --in/--out     Manual entry: the exact token figures, for a host whose usage arrives by some other',
  '                 means than a Claude Code transcript. Both required together; skips transcript',
  '                 resolution entirely.',
  '',
  'Usage: vinaya tokens --trust-collect',
  "  Approves this repo's declared tokens.collect command for this exact string, on this machine.",
  '  Run this once before tokens.collect will ever execute. A changed command string needs its own',
  '  fresh approval — this does not take --phase/--role and never emits a Tokens: line.'
].join('\n')

export type ParsedTokensArgs = {
  phase: string
  role: string
  model: string | undefined
  transcriptPath: string | undefined
  tokensIn: number | undefined
  tokensOut: number | undefined
}

export function parseArgs(argv: string[]): ParsedTokensArgs {
  let phase: string | undefined
  let role: string | undefined
  let model: string | undefined
  let transcriptPath: string | undefined
  let tokensInRaw: string | undefined
  let tokensOutRaw: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--phase') phase = argv[++i]
    else if (arg === '--role') role = argv[++i]
    else if (arg === '--model') model = argv[++i]
    else if (arg === '--transcript') transcriptPath = argv[++i]
    else if (arg === '--in') tokensInRaw = argv[++i]
    else if (arg === '--out') tokensOutRaw = argv[++i]
  }

  if (!phase || !role) {
    throw new Error(USAGE)
  }

  if ((tokensInRaw === undefined) !== (tokensOutRaw === undefined)) {
    throw new Error('vinaya tokens: --in and --out must be given together, or not at all.')
  }

  const tokensIn = tokensInRaw === undefined ? undefined : Number(tokensInRaw)
  const tokensOut = tokensOutRaw === undefined ? undefined : Number(tokensOutRaw)

  if (tokensIn !== undefined && (!Number.isFinite(tokensIn) || tokensIn < 0)) {
    throw new Error(`vinaya tokens: --in must be a non-negative integer, got "${tokensInRaw}".`)
  }
  if (tokensOut !== undefined && (!Number.isFinite(tokensOut) || tokensOut < 0)) {
    throw new Error(`vinaya tokens: --out must be a non-negative integer, got "${tokensOutRaw}".`)
  }

  return { phase, role, model, transcriptPath, tokensIn, tokensOut }
}

/** `messageCount: 1` — a manual entry is never the "nothing usable collected" signal `summarizeTranscript` uses `0` for; the operator handed us real figures directly. */
function manualSummary(tokensIn: number, tokensOut: number): TranscriptSummary {
  return {
    components: {
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    },
    model: null,
    messageCount: 1
  }
}

/**
 * `MeteringCapabilityDeps` plus the seams the declared-command route needs:
 * `loadConfig` (which config resolution to consult — the walking,
 * global-stripping `loadConfig()` from `lib/config.ts`, same as every other
 * repo-local-only key) and `runCollectCommand` (how to execute the declared
 * shell command). All injected for the same reason `MeteringCapabilityDeps`
 * itself is — testable without touching real `fs`/`process.env`/a real git
 * or child process. A `TokensDeps` value satisfies `MeteringCapabilityDeps`
 * structurally, so it passes unchanged into `resolveMeteringCapability`.
 */
export type TokensDeps = MeteringCapabilityDeps & {
  loadConfig: () => VinayaConfig | null
  runCollectCommand: (command: string, cwd: string) => string
  /**
   * Announces the exact command about to run, to stderr, immediately before
   * it runs. Round 1 of security review, PR #303 — kept as a per-run audit
   * trail even now that trust (below) is what actually gates execution.
   */
  warn: (message: string) => void
  /**
   * This repo's git common directory, or `null` if it cannot be resolved —
   * `config.ts`'s `gitCommonDir`. The trust-gate's repo identity: shared by
   * every worktree of one repo, so approving a command once covers this
   * repo's own per-task fresh worktrees (`.worktrees/task/<tranche>/<n>/`).
   */
  gitCommonDir: () => string | null
  /**
   * `true` only if a human has explicitly approved this exact (repo,
   * command) pair on this machine via `vinaya tokens --trust-collect` —
   * `config.ts`'s `isTokensCollectTrusted`. Security review, PR #303, round
   * 2 (HIGH): a printed warning alone (round 1's fix) gave no real window to
   * react before a blocking `execSync` ran — this is the actual gate.
   * `buildTokensResult` refuses outright, never runs, never falls back to
   * the transcript route, when this returns `false`.
   */
  isCollectTrusted: (repoGitCommonDir: string, command: string) => boolean
  /** Records approval — `config.ts`'s `trustTokensCollectCommand`. Called from nowhere in this file except the `--trust-collect` CLI path a human types themselves; `buildTokensResult`'s own declared-route branch never calls this. */
  trustCollect: (repoGitCommonDir: string, command: string) => void
}

/** `messageCount: 1` for the same reason `manualSummary` uses it — the declared command handed us real figures directly, never the "nothing usable collected" `0` sentinel. */
function declaredSummary(components: UsageComponents, model: string | null): TranscriptSummary {
  return { components, model, messageCount: 1 }
}

const COLLECT_FIELDS = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens'] as const

/**
 * Parses a declared `tokens.collect` command's stdout into the
 * `TranscriptSummary` shape. Fails loudly on anything short of a fully valid
 * payload — invalid JSON, a non-object, a missing/non-numeric/negative usage
 * field, a non-string `model` — never coercing a bad field to `0` and
 * quietly emitting a plausible-looking report (the failure mode this
 * declared route exists to avoid, same discipline `resolveMeteringCapability`
 * already applies to the transcript route).
 */
export function parseDeclaredCollectOutput(raw: string, command: string): TranscriptSummary {
  const trimmed = raw.trim()
  const fail = (why: string): never => {
    throw new Error(
      `vinaya tokens: declared tokens.collect command "${command}" ${why}\n` +
        'Expected stdout to be a JSON object: ' +
        '{"inputTokens":N,"outputTokens":N,"cacheCreationInputTokens":N,"cacheReadInputTokens":N,"model":"…"|null}\n' +
        `Got: ${trimmed.slice(0, 500)}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    fail(`did not print valid JSON on stdout (${(err as Error).message}).`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('printed JSON that is not an object.')
  }
  const obj = parsed as Record<string, unknown>

  const components = {} as UsageComponents
  for (const field of COLLECT_FIELDS) {
    const value = obj[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(`printed an invalid "${field}" (must be a non-negative number), got ${JSON.stringify(value)}.`)
    }
    components[field] = value as number
  }

  const model = obj.model
  if (model !== undefined && model !== null && typeof model !== 'string') {
    fail(`printed a non-string "model" field: ${JSON.stringify(model)}.`)
  }

  return declaredSummary(components, typeof model === 'string' ? model : null)
}

/**
 * Runs the declared command and parses its output — throws on any failure,
 * never falling back to the transcript route (that would risk masking a
 * real collection bug behind a different, plausible-looking result).
 *
 * Gated on trust before anything else runs (security review, PR #303, round
 * 2, HIGH): refuses outright — no execution — unless a human has already
 * approved this exact command string for this repo on this machine via
 * `vinaya tokens --trust-collect`. A repo whose git identity cannot be
 * resolved (`gitCommonDir()` returns `null`) is refused the same way —
 * never treated as automatically trusted. Once past the gate, the exact
 * command is still announced to stderr before it runs (round 1's fix,
 * kept as a per-run audit trail).
 */
function runDeclaredCollect(command: string, deps: TokensDeps): TranscriptSummary {
  const repoGitCommonDir = deps.gitCommonDir()
  if (repoGitCommonDir === null) {
    throw new Error(
      "vinaya tokens: declared tokens.collect command could not be verified — this repo's git common " +
        'directory could not be resolved. Refusing to run an unverifiable command.'
    )
  }
  if (!deps.isCollectTrusted(repoGitCommonDir, command)) {
    throw new Error(
      'vinaya tokens: declared tokens.collect command is not yet trusted on this machine:\n' +
        `  ${command}\n` +
        'Run `vinaya tokens --trust-collect` once to approve it. Refusing — no `Tokens:` line emitted, no zeros.'
    )
  }

  deps.warn(`⚠ vinaya tokens: running declared tokens.collect command from this repo's vinaya.config.json: ${command}`)
  let raw: string
  try {
    raw = deps.runCollectCommand(command, deps.cwd)
  } catch (err) {
    throw new Error(`vinaya tokens: declared tokens.collect command "${command}" failed: ${(err as Error).message}`)
  }
  return parseDeclaredCollectOutput(raw, command)
}

/** A declared command may legitimately do real work (hit an API, read a log) — longer than `config.ts`'s plumbing-only `GIT_IDENTITY_TIMEOUT_MS` — but a stuck or hostile command must not block `vinaya tokens` forever either (code review, PR #303, round 2 follow-up). */
const COLLECT_COMMAND_TIMEOUT_MS = 30_000

/** Exported so other commands collecting real usage figures (`pr-report.ts`'s `AEG:TOKENS` writer) share this exact I/O shim rather than a second copy of it. */
export function realDeps(): TokensDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    exists: existsSync,
    readFile: (path: string) => readFileSync(path, 'utf8'),
    loadConfig,
    runCollectCommand: (command: string, cwd: string) =>
      execSync(command, { cwd, encoding: 'utf-8', timeout: COLLECT_COMMAND_TIMEOUT_MS }),
    warn: (message: string) => console.error(message),
    gitCommonDir,
    isCollectTrusted: isTokensCollectTrusted,
    trustCollect: trustTokensCollectCommand
  }
}

export type TokensResult = { line: string; breakdown: string | undefined }

/** Deps-injected so the manual, declared, and transcript routes are all testable without touching real `fs`/`process.env`/a real child process. */
export function buildTokensResult(parsed: ParsedTokensArgs, deps: TokensDeps): TokensResult {
  if (parsed.tokensIn !== undefined && parsed.tokensOut !== undefined) {
    const summary = manualSummary(parsed.tokensIn, parsed.tokensOut)
    return {
      line: formatTokensLine({ phase: parsed.phase, role: parsed.role, summary, modelOverride: parsed.model }),
      breakdown: undefined
    }
  }

  const declaredCommand = deps.loadConfig()?.tokens?.collect
  if (declaredCommand) {
    const summary = runDeclaredCollect(declaredCommand, deps)
    return {
      line: formatTokensLine({ phase: parsed.phase, role: parsed.role, summary, modelOverride: parsed.model }),
      breakdown: formatBreakdown(summary)
    }
  }

  const capability = resolveMeteringCapability(deps, parsed.transcriptPath)
  if (!capability.capable) {
    throw new Error(
      `vinaya tokens: refused — could not resolve real usage figures (${capability.reason}).\n${capability.detail}\n\n${USAGE}`
    )
  }

  return {
    line: formatTokensLine({
      phase: parsed.phase,
      role: parsed.role,
      summary: capability.summary,
      modelOverride: parsed.model
    }),
    breakdown: formatBreakdown(capability.summary)
  }
}

/**
 * `vinaya tokens --trust-collect` — the only sanctioned way to make
 * `runDeclaredCollect`'s trust gate pass. Requires a declared command (no
 * key, nothing to trust) and a resolvable repo identity (no git identity,
 * nothing safe to key trust to) — either missing is a refusal, never a
 * silent no-op. Never emits a `Tokens:` line; approving is a distinct act
 * from reporting.
 */
export function runTrustCollect(deps: TokensDeps): { ok: true; command: string } | { ok: false; message: string } {
  const declaredCommand = deps.loadConfig()?.tokens?.collect
  if (!declaredCommand) {
    return {
      ok: false,
      message:
        "vinaya tokens --trust-collect: no tokens.collect declared in this repo's vinaya.config.json — nothing to trust."
    }
  }
  const repoGitCommonDir = deps.gitCommonDir()
  if (repoGitCommonDir === null) {
    return {
      ok: false,
      message:
        "vinaya tokens --trust-collect: this repo's git common directory could not be resolved — refusing to trust blindly."
    }
  }
  deps.trustCollect(repoGitCommonDir, declaredCommand)
  return { ok: true, command: declaredCommand }
}

export function tokensCommand(argv: string[]): void {
  if (argv.includes('--trust-collect')) {
    const outcome = runTrustCollect(realDeps())
    if (!outcome.ok) {
      console.error(outcome.message)
      process.exit(1)
    }
    process.stdout.write(
      'Trusted. Future `vinaya tokens` runs on this machine execute it without asking again until the ' +
        `command string changes.\n${outcome.command}\n`
    )
    return
  }

  let parsed: ParsedTokensArgs
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(2)
  }

  let result: TokensResult
  try {
    result = buildTokensResult(parsed, realDeps())
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  if (result.breakdown) console.error(result.breakdown)
  process.stdout.write(`${result.line}\n`)
}
