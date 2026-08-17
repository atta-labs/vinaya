/**
 * report-tokens — the **portable** half of the token-report contract
 * (`aeg-root/tranche-model.md` §12, layers 1 and 3). Nothing in this file
 * knows what an agent host is: it defines the summary shape every collection
 * adapter must produce, and renders that shape into the frozen `Tokens: …`
 * grammar `parse-token-report.ts` reads back.
 *
 * `TranscriptSummary` **is the seam.** A host adapter's whole job is to
 * produce one — from a session transcript, an API usage response, a meter the
 * harness exposes, or figures an operator supplies by hand. AEG ships exactly
 * one such adapter, for Claude Code, in `claude-code-transcript.ts`; a repo
 * on another harness writes its own and reuses everything here unchanged.
 * Adding host knowledge to this file would silently re-couple the portable
 * layers to one vendor — that coupling is the defect the split exists to
 * prevent, and this file is where it would reappear first.
 *
 * Historical note (misc-hardening-v1 task 1, #675): this module retracted
 * §12's earlier claim that a role reports exact tokens "from `/cost`" — an
 * operator-typed slash command no unattended agent session can invoke, in
 * that host or any other. §12 records the retraction; the fix was to collect
 * from a real per-turn source instead.
 *
 * Pure — no `fs`, no `process.env`. The CLI shim (`bin/report-tokens.ts`)
 * does the I/O; these functions take values and produce the report.
 */

/**
 * The four usage figures a role reports, in host-neutral terms. Every
 * collection adapter maps its host's own field names onto these; nothing
 * downstream ever sees a vendor's spelling.
 */
export type UsageComponents = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/**
 * **The adapter seam.** What a host's collection step must produce for one
 * role-turn, and the only thing the portable layers below consume. Named for
 * the shipped adapter's source (a session transcript), but the shape is not
 * transcript-specific: an adapter that reads an API usage response or takes
 * operator-supplied figures produces this same object.
 */
export type TranscriptSummary = {
  components: UsageComponents
  /** The model id for the turn, or `null` when the host does not report one. */
  model: string | null
  /**
   * How many distinct usage records were summed. Callers use `0` as the
   * "nothing usable was collected" signal — a real turn always has at least
   * one — rather than letting a zeroed summary format as a plausible `0/0/—`.
   */
  messageCount: number
}

export type TokensLineInput = {
  phase: string
  role: string
  /**
   * `null` only when the role is operator-metered — its host exposes no
   * usage to the agent at all — which produces the all-`—` numbers segment
   * the parser already tolerates. Never a convenience escape for a
   * self-metering role whose collection step merely failed: that case is an
   * error to report, not a blank to emit (`aeg-root/tranche-model.md` §12).
   */
  summary: TranscriptSummary | null
  /** Overrides the model the adapter derived, if given. */
  modelOverride?: string
}

/**
 * Format the one-line `Tokens: <phase> — <role> — <model> — <in>/<out>/<cost>`
 * report that `parse-token-report.ts`'s `parseTokensLines` consumes. The
 * grammar is frozen (three parsers depend on it) — this function must never
 * change its shape, only what feeds it.
 *
 * `Tokens in` is the full input-side total (`input_tokens +
 * cache_creation_input_tokens + cache_read_input_tokens`) — genuinely every
 * token that went in, not a partial figure. Cache reads can outweigh fresh
 * input by two orders of magnitude on a long session, so that total is
 * never the whole story on its own; `formatBreakdown` reports the four
 * components separately for anyone reading the reporter's own output,
 * rather than letting the single blended cell stand as if it were.
 *
 * Cost is always reported as `—`: no maintained, accurate $/token pricing
 * table for current models lives in this package (the one in
 * `@atta/adapter-langgraph` is a different product's provider-pricing
 * table, out of this task's surface, and does not cover these model ids) —
 * an unverified guess baked into a PR's permanent history is worse than an
 * honest unknown.
 */
export function formatTokensLine(input: TokensLineInput): string {
  const model = input.modelOverride ?? input.summary?.model ?? '—'
  if (!input.summary) {
    return `Tokens: ${input.phase} — ${input.role} — ${model} — —`
  }
  const { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens } = input.summary.components
  const tokensIn = inputTokens + cacheCreationInputTokens + cacheReadInputTokens
  return `Tokens: ${input.phase} — ${input.role} — ${model} — ${tokensIn}/${outputTokens}/—`
}

/**
 * Human-readable component breakdown for the reporter's own console output
 * — never folded silently into the single `Tokens in` cell. Not parsed by
 * anything; informational only.
 */
export function formatBreakdown(summary: TranscriptSummary): string {
  const { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens } = summary.components
  return [
    `  fresh input tokens:    ${inputTokens}`,
    `  cache creation tokens: ${cacheCreationInputTokens}`,
    `  cache read tokens:     ${cacheReadInputTokens}`,
    `  output tokens:         ${outputTokens}`,
    `  model:                 ${summary.model ?? '—'}`,
    `  messages summed:       ${summary.messageCount} (deduped by message.id)`
  ].join('\n')
}
