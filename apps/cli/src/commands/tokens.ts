import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { formatBreakdown, formatTokensLine, resolveMeteringCapability } from '@attalabs/aeg-core'
import type { MeteringCapabilityDeps, TranscriptSummary, UsageComponents } from '@attalabs/aeg-core'
import { loadConfig } from '../lib/config.js'
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
 *     full trust framing (same class as `ci.setup`).
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
  '                 resolution entirely.'
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
 * `MeteringCapabilityDeps` plus the two seams the declared-command route
 * needs: `loadConfig` (which config resolution to consult — the walking,
 * global-stripping `loadConfig()` from `lib/config.ts`, same as every other
 * repo-local-only key) and `runCollectCommand` (how to execute the declared
 * shell command). Both injected for the same reason `MeteringCapabilityDeps`
 * itself is — testable without touching real `fs`/`process.env`/a real
 * child process. A `TokensDeps` value satisfies `MeteringCapabilityDeps`
 * structurally, so it passes unchanged into `resolveMeteringCapability`.
 */
export type TokensDeps = MeteringCapabilityDeps & {
  loadConfig: () => VinayaConfig | null
  runCollectCommand: (command: string, cwd: string) => string
  /**
   * Announces the exact command about to run, to stderr, before it runs —
   * security review, PR #303: a repo-local `tokens.collect` is trusted
   * config content, same class as `checks.run`/`ci.setup`, but unlike
   * `ci.setup` (which only ever executes inside a generated, reviewed CI
   * workflow step, under the runner's own isolation) this command executes
   * IN-PROCESS, unsandboxed, on whatever machine runs the ordinary
   * `vinaya tokens` command this repo's own doctrine has the Developer and
   * Archivist roles invoke routinely — silently, with no confirmation and no
   * printed trace, a malicious or mistaken value would run unnoticed the
   * next time anyone (human or unattended agent) simply reports tokens. A
   * blocking confirmation prompt is not the fix — the unattended-agent path
   * this key exists for cannot answer one — so this stays print-only: it
   * cannot stop a bad command, but it can no longer run invisibly. The
   * deeper question this does NOT resolve — whether `tokens.collect` should
   * execute this way at all — is a trust-boundary call for the Principal,
   * not this fix.
   */
  warn: (message: string) => void
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

/** Runs the declared command and parses its output — throws on either failure, never falling back to the transcript route (that would risk masking a real collection bug behind a different, plausible-looking result). Announces the exact command to stderr before running it — see `TokensDeps.warn`'s doc comment. */
function runDeclaredCollect(command: string, deps: TokensDeps): TranscriptSummary {
  deps.warn(`⚠ vinaya tokens: running declared tokens.collect command from this repo's vinaya.config.json: ${command}`)
  let raw: string
  try {
    raw = deps.runCollectCommand(command, deps.cwd)
  } catch (err) {
    throw new Error(`vinaya tokens: declared tokens.collect command "${command}" failed: ${(err as Error).message}`)
  }
  return parseDeclaredCollectOutput(raw, command)
}

/** Exported so other commands collecting real usage figures (`pr-report.ts`'s `AEG:TOKENS` writer) share this exact I/O shim rather than a second copy of it. */
export function realDeps(): TokensDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    exists: existsSync,
    readFile: (path: string) => readFileSync(path, 'utf8'),
    loadConfig,
    runCollectCommand: (command: string, cwd: string) => execSync(command, { cwd, encoding: 'utf-8' }),
    warn: (message: string) => console.error(message)
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

export function tokensCommand(argv: string[]): void {
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
