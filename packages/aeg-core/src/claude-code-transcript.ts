/**
 * claude-code-transcript — the Claude Code **collection adapter** for the
 * token-report obligation (`aeg-root/tranche-model.md` §12, layer 2).
 *
 * This file is host-coupled on purpose and is the only `src/` module that is.
 * It knows one harness's session-transcript format: JSONL, one object per
 * line, assistant turns carrying a `message.usage` object whose fields are
 * named `input_tokens` / `output_tokens` / `cache_creation_input_tokens` /
 * `cache_read_input_tokens`. None of that is doctrine — it is one vendor's
 * on-disk shape, and an adopter on another harness replaces this module
 * wholesale rather than configuring it.
 *
 * **The seam is `TranscriptSummary`, not the file tree.** An adapter's entire
 * contract is to produce that shape (four integers plus a model id) from
 * whatever its own host exposes. Everything downstream of it — the
 * `formatTokensLine` renderer in `report-tokens.ts`, the `Tokens: …` grammar
 * in `parse-token-report.ts` — is portable and shared by every host. The
 * `bin/` vs `src/` split does NOT mark this boundary and never did:
 * `bin/report-tokens.ts` is equally host-coupled (it knows how Claude Code
 * points a session at its own transcript), while `src/parse-token-report.ts`
 * is fully portable. Splitting this module out of `report-tokens.ts` is what
 * makes the boundary legible in the tree rather than only in prose — the
 * package ships inside the public tarball, where a reader has no other way to
 * tell which half they may reuse.
 *
 * Pure — no `fs`, no `process.env`, per this package's purity charter. The
 * CLI shim reads the file; this takes its text.
 */

import type { TranscriptSummary, UsageComponents } from './report-tokens'

/**
 * Sum usage across every unique assistant message in a session transcript
 * (JSONL — one object per line). A single API turn is frequently split
 * across several JSONL entries (a thinking block, a tool_use block, a text
 * block, …) that each carry an identical copy of that turn's `usage` object
 * under the same `message.id` — confirmed against a live transcript, where
 * 59 assistant-typed lines held only 22 unique message ids. Summing every
 * line naively over-counts by as much as 3x. Dedup by `message.id` first; a
 * line missing an id or a usage object is skipped, not guessed at.
 */
export function summarizeTranscript(jsonl: string): TranscriptSummary {
  const seen = new Set<string>()
  const components: UsageComponents = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0
  }
  let model: string | null = null
  let messageCount = 0

  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (obj.type !== 'assistant') continue

    const message = obj.message as Record<string, unknown> | undefined
    const id = message?.id
    const usage = message?.usage as Record<string, unknown> | undefined
    if (typeof id !== 'string' || !id || !usage || seen.has(id)) continue
    seen.add(id)
    messageCount++

    components.inputTokens += numberOr(usage.input_tokens, 0)
    components.outputTokens += numberOr(usage.output_tokens, 0)
    components.cacheCreationInputTokens += numberOr(usage.cache_creation_input_tokens, 0)
    components.cacheReadInputTokens += numberOr(usage.cache_read_input_tokens, 0)

    const messageModel = message?.model
    if (typeof messageModel === 'string' && messageModel) model = messageModel
  }

  return { components, model, messageCount }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
