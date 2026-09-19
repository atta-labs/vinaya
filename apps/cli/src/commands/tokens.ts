import { execFileSync } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { formatBreakdown, formatTokensLine, hardenedMeteringDeps, resolveMeteringCapability } from '@attalabs/aeg-core'
import type {
  MeteringCapabilityDeps,
  MeteringIncapableReason,
  TranscriptSummary,
  UsageComponents
} from '@attalabs/aeg-core'
import {
  getTokensCollectTrust,
  gitBlobHash,
  gitCommonDir,
  loadConfig,
  parseTokensCollectDeclaration,
  repoLocalConfigDir,
  trustTokensCollectCommand
} from '../lib/config.js'
import type { TokensCollectTrustEntry, VinayaConfig } from '../lib/config.js'

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
 *     `tokens.collect` is exactly `"<interpreter> <repo-relative-script-
 *     path>"` (`config.ts`'s `parseTokensCollectDeclaration`) — spawned
 *     directly via `execFile`, never through a shell. Its stdout must be
 *     JSON matching the `TranscriptSummary` seam (`inputTokens`/
 *     `outputTokens`/`cacheCreationInputTokens`/`cacheReadInputTokens`/
 *     `model`). Wins outright when declared — never silently falls through
 *     to the transcript route on a run/parse failure, since that would risk
 *     masking a real collection bug behind a plausible-looking
 *     transcript-route result. **Gated on trust** (a security review):
 *     never runs until a human has explicitly approved
 *     this exact interpreter/script declaration AT this exact script
 *     content, for this repo, on this machine, via
 *     `vinaya tokens --trust-collect` — see `config.ts`'s
 *     `tokens.collect trust cache` section for the full mechanism, why it
 *     survives this repo's per-task fresh worktrees, and why content is
 *     pinned rather than just the declaration string.
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
  "  Approves this repo's declared tokens.collect command, pinned to the script's exact current",
  '  content, on this machine. Run this once before tokens.collect will ever execute — a changed',
  '  interpreter, script path, or script CONTENT needs its own fresh approval. Does not take',
  '  --phase/--role and never emits a Tokens: line.'
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
 * `MeteringCapabilityDeps` plus the seams the declared-command route needs.
 * All injected for the same reason `MeteringCapabilityDeps` itself is —
 * testable without touching real `fs`/`process.env`/a real git or child
 * process. A `TokensDeps` value satisfies `MeteringCapabilityDeps`
 * structurally, so it passes unchanged into `resolveMeteringCapability`.
 */
export type TokensDeps = MeteringCapabilityDeps & {
  /** Which config resolution to consult — the walking, global-stripping `loadConfig()` from `lib/config.ts`, same as every other repo-local-only key. */
  loadConfig: () => VinayaConfig | null
  /** The directory `tokens.collect`'s script segment resolves relative to — `config.ts`'s `repoLocalConfigDir`. */
  repoConfigDir: () => string | null
  /** Runs the already-trusted `[interpreter, scriptAbsolutePath]` via `execFile`, never a shell — returns stdout. */
  runScript: (interpreter: string, scriptAbsolutePath: string, cwd: string) => string
  /**
   * Announces the exact interpreter/script about to run, to stderr,
   * immediately before it runs. An early round of security review — kept
   * as a per-run audit trail even now that trust (below) is what actually
   * gates execution.
   */
  warn: (message: string) => void
  /**
   * This repo's git common directory, or `null` if it cannot be resolved —
   * `config.ts`'s `gitCommonDir`. The trust-gate's repo identity: shared by
   * every worktree of one repo, so approving a declaration once covers this
   * repo's own per-task fresh worktrees (`.worktrees/task/<tranche>/<n>/`).
   */
  gitCommonDir: () => string | null
  /** The `git hash-object` blob hash of a file's current on-disk bytes — `config.ts`'s `gitBlobHash`. `null` on any failure, never a license to trust anyway. */
  scriptContentHash: (scriptAbsolutePath: string, cwd: string) => string | null
  /**
   * The recorded trust entry for this exact (repo, interpreter, script)
   * triple, or `null` if never approved — `config.ts`'s
   * `getTokensCollectTrust`. A security review, across rounds: one HIGH
   * finding closed "runs with no real window to react" by gating on approval
   * at all; a later BLOCKER finding closed "approval covers the STRING, not the
   * script's CONTENT" by pinning `entry.scriptBlobHash` alongside it —
   * `runDeclaredCollect` compares that hash against `scriptContentHash`'s
   * CURRENT answer itself, refusing on either "never approved" or "approved,
   * but content has since changed", and never falls back to the transcript
   * route on either refusal.
   */
  getTrust: (repoGitCommonDir: string, interpreter: string, script: string) => TokensCollectTrustEntry | null
  /** Records approval — `config.ts`'s `trustTokensCollectCommand`. Called from nowhere in this file except the `--trust-collect` CLI path a human types themselves; `runDeclaredCollect` never calls this. */
  trustCollect: (repoGitCommonDir: string, interpreter: string, script: string, scriptBlobHash: string) => void
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
 * Resolves a declared `tokens.collect` string against `deps` into its
 * parsed parts, the repo identity, and the script's absolute path — the
 * shared setup `runDeclaredCollect` and `runTrustCollect` both need before
 * they diverge (execute vs. approve). Throws on anything that makes further
 * resolution meaningless (malformed declaration — should be unreachable,
 * the schema already validated it; unresolvable repo identity; script not
 * found).
 */
function resolveDeclaredCollect(
  command: string,
  deps: TokensDeps
): { interpreter: string; script: string; scriptAbsolutePath: string; repoGitCommonDir: string } {
  const parsed = parseTokensCollectDeclaration(command)
  if (!parsed) {
    throw new Error(
      `vinaya tokens: declared tokens.collect "${command}" is not shaped "<interpreter> <script-path>" — ` +
        'this should have been rejected at config-load time; the config may have been edited after loading.'
    )
  }
  const repoConfigDir = deps.repoConfigDir()
  if (repoConfigDir === null) {
    throw new Error(
      "vinaya tokens: declared tokens.collect command could not be resolved — this repo's local " +
        'vinaya.config.json directory could not be found. Refusing to run an unresolvable command.'
    )
  }
  const repoGitCommonDir = deps.gitCommonDir()
  if (repoGitCommonDir === null) {
    throw new Error(
      "vinaya tokens: declared tokens.collect command could not be verified — this repo's git common " +
        'directory could not be resolved. Refusing to run an unverifiable command.'
    )
  }
  const scriptAbsolutePath = resolvePath(repoConfigDir, parsed.script)
  if (!deps.exists(scriptAbsolutePath)) {
    throw new Error(
      `vinaya tokens: declared tokens.collect script "${parsed.script}" does not exist at ${scriptAbsolutePath}.`
    )
  }
  return { interpreter: parsed.interpreter, script: parsed.script, scriptAbsolutePath, repoGitCommonDir }
}

/**
 * Runs the declared interpreter/script and parses its output — throws on
 * any failure, never falling back to the transcript route (that would risk
 * masking a real collection bug behind a different, plausible-looking
 * result).
 *
 * Gated on trust before anything runs (a security review):
 * refuses outright unless a human has already approved this exact
 * (interpreter, script) declaration, AT the script's exact current content,
 * for this repo, on this machine, via `vinaya tokens --trust-collect`. Two
 * distinguishable refusals — "never approved" vs. "approved, but the
 * script's content has since changed" — since they call for different
 * remediation-reading (a first-time declaration vs. a possibly-unreviewed
 * edit). Once past the gate, the exact interpreter/script is still
 * announced to stderr before it runs (round 1's fix, kept as a per-run
 * audit trail), then spawned via `execFile` — never a shell.
 */
function runDeclaredCollect(command: string, deps: TokensDeps): TranscriptSummary {
  const { interpreter, script, scriptAbsolutePath, repoGitCommonDir } = resolveDeclaredCollect(command, deps)

  const currentHash = deps.scriptContentHash(scriptAbsolutePath, deps.cwd)
  if (currentHash === null) {
    throw new Error(
      `vinaya tokens: declared tokens.collect script "${script}" could not be hashed for verification ` +
        '(git unavailable, or the file could not be read). Refusing to run an unverifiable script.'
    )
  }

  const trust = deps.getTrust(repoGitCommonDir, interpreter, script)
  if (trust === null) {
    throw new Error(
      'vinaya tokens: declared tokens.collect is not yet trusted on this machine:\n' +
        `  ${interpreter} ${script}\n` +
        'Run `vinaya tokens --trust-collect` once to approve it. Refusing — no `Tokens:` line emitted, no zeros.'
    )
  }
  if (trust.scriptBlobHash !== currentHash) {
    throw new Error(
      `vinaya tokens: declared tokens.collect script "${script}" no longer matches its trusted content ` +
        `(approved at ${trust.scriptBlobHash}, now ${currentHash}).\n` +
        'Run `vinaya tokens --trust-collect` again to approve the new content. Refusing — no `Tokens:` line emitted, no zeros.'
    )
  }

  deps.warn(`⚠ vinaya tokens: running declared tokens.collect: ${interpreter} ${script}`)
  let raw: string
  try {
    raw = deps.runScript(interpreter, scriptAbsolutePath, deps.cwd)
  } catch (err) {
    throw new Error(
      `vinaya tokens: declared tokens.collect "${interpreter} ${script}" failed: ${(err as Error).message}`
    )
  }
  return parseDeclaredCollectOutput(raw, command)
}

/** A declared script may legitimately do real work (hit an API, read a log) — longer than `config.ts`'s plumbing-only `GIT_IDENTITY_TIMEOUT_MS` — but a stuck or hostile process must not block `vinaya tokens` forever either (a code-review finding). */
const COLLECT_COMMAND_TIMEOUT_MS = 30_000

/** Exported so other commands collecting real usage figures (`pr-report.ts`'s `AEG:TOKENS` writer) share this exact I/O shim rather than a second copy of it. */
export function realDeps(): TokensDeps {
  return {
    ...hardenedMeteringDeps(),
    loadConfig,
    repoConfigDir: repoLocalConfigDir,
    runScript: (interpreter: string, scriptAbsolutePath: string, cwd: string) =>
      execFileSync(interpreter, [scriptAbsolutePath], { cwd, encoding: 'utf-8', timeout: COLLECT_COMMAND_TIMEOUT_MS }),
    warn: (message: string) => console.error(message),
    gitCommonDir,
    scriptContentHash: gitBlobHash,
    getTrust: getTokensCollectTrust,
    trustCollect: trustTokensCollectCommand
  }
}

/**
 * The single wording for "the probe could not reach real usage figures",
 * shared by `vinaya tokens` and by `pr report --write`'s `AEG:TOKENS` writer
 * (`pr-report.ts`'s `collectTokensAddition`) so one fact never reaches an
 * operator under two different names. The command prefix and whatever remedy
 * text follows are the caller's — the remedies differ per command, the fact
 * does not.
 */
export function meteringRefusalMessage(
  command: string,
  capability: { reason: MeteringIncapableReason; detail: string }
): string {
  return `${command}: refused — could not resolve real usage figures (${capability.reason}).\n${capability.detail}`
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
    throw new Error(`${meteringRefusalMessage('vinaya tokens', capability)}\n\n${USAGE}`)
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

export type TrustCollectOutcome =
  | { ok: true; interpreter: string; script: string; scriptBlobHash: string }
  | { ok: false; message: string }

/**
 * `vinaya tokens --trust-collect` — the only sanctioned way to make
 * `runDeclaredCollect`'s trust gate pass. Requires a declared command (no
 * key, nothing to trust), a shape-valid declaration (should be unreachable,
 * the schema already validated it), a resolvable repo identity, and a
 * hashable script (must exist, must be readable by `git hash-object`) —
 * any missing piece is a refusal, never a silent no-op. Never emits a
 * `Tokens:` line; approving is a distinct act from reporting.
 */
export function runTrustCollect(deps: TokensDeps): TrustCollectOutcome {
  const declaredCommand = deps.loadConfig()?.tokens?.collect
  if (!declaredCommand) {
    return {
      ok: false,
      message:
        "vinaya tokens --trust-collect: no tokens.collect declared in this repo's vinaya.config.json — nothing to trust."
    }
  }

  let resolved: ReturnType<typeof resolveDeclaredCollect>
  try {
    resolved = resolveDeclaredCollect(declaredCommand, deps)
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
  const { interpreter, script, scriptAbsolutePath, repoGitCommonDir } = resolved

  const scriptBlobHash = deps.scriptContentHash(scriptAbsolutePath, deps.cwd)
  if (scriptBlobHash === null) {
    return {
      ok: false,
      message: `vinaya tokens --trust-collect: script "${script}" could not be hashed (git unavailable, or the file could not be read) — refusing to trust blindly.`
    }
  }

  deps.trustCollect(repoGitCommonDir, interpreter, script, scriptBlobHash)
  return { ok: true, interpreter, script, scriptBlobHash }
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
        `interpreter, script path, or script content changes.\n${outcome.interpreter} ${outcome.script}\n` +
        `  content hash: ${outcome.scriptBlobHash}\n`
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
