import { existsSync, readFileSync } from 'node:fs'
import { formatBreakdown, formatTokensLine, resolveMeteringCapability } from '@attalabs/aeg-core'
import type { MeteringCapabilityDeps, TranscriptSummary } from '@attalabs/aeg-core'

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
 * Two ways to a `Tokens:` line:
 *   - **Transcript-based** (default, or `--transcript <path>`): resolves a
 *     Claude Code session transcript (explicit path, or the Stop-hook
 *     pointer file) and summarizes real usage. Throws — never emits a
 *     plausible `0/0/—` — when the transcript can't be resolved, read, or
 *     yields zero usage records (`resolveMeteringCapability`'s three
 *     incapable reasons).
 *   - **Manual** (`--in <tokens-in> --out <tokens-out>`): for a host whose
 *     figures arrive by some other means than a Claude Code transcript (an
 *     API usage response, a meter an operator read off a dashboard). Skips
 *     transcript resolution entirely and renders the given figures through
 *     the same unchanged `formatTokensLine` grammar.
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

function realDeps(): MeteringCapabilityDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    exists: existsSync,
    readFile: (path: string) => readFileSync(path, 'utf8')
  }
}

export type TokensResult = { line: string; breakdown: string | undefined }

/** Deps-injected so the manual and transcript routes are both testable without touching real `fs`/`process.env`. */
export function buildTokensResult(parsed: ParsedTokensArgs, deps: MeteringCapabilityDeps): TokensResult {
  if (parsed.tokensIn !== undefined && parsed.tokensOut !== undefined) {
    const summary = manualSummary(parsed.tokensIn, parsed.tokensOut)
    return {
      line: formatTokensLine({ phase: parsed.phase, role: parsed.role, summary, modelOverride: parsed.model }),
      breakdown: undefined
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
