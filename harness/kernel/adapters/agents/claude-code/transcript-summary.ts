/**
 * report-tokens — the **portable** half of the token-report contract
 * (the tranche model's token-report layers). No value this file reads,
 * computes or emits is host-specific: it defines the summary shape every
 * collection adapter must produce, and renders that shape into the frozen
 * `Tokens: …` grammar `parse-token-report.ts` reads back. A host is named
 * below only to point at the one shipped adapter and to record a retraction —
 * never to branch on, and never in rendered output.
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
 * Historical note: this module retracted
 * §12's earlier claim that a role reports exact tokens "from `/cost`" — an
 * operator-typed slash command no unattended agent session can invoke, in
 * that host or any other. §12 records the retraction; the fix was to collect
 * from a real per-turn source instead.
 *
 * Pure — no `fs`, no `process.env`. The token-report program
 * does the I/O; these functions take values and produce the report.
 */

/**
 * The four usage figures a role reports, in host-neutral terms. Every
 * collection adapter maps its host's own field names onto these, so no field
 * name from a host's own API or transcript format appears downstream of the
 * adapter — including in this file.
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
