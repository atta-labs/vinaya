/**
 * report-tokens — the **portable** half of the token-report contract
 * (`aeg-root/tranche-model.md` §12, layers 1 and 3). No value this file reads,
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
 * Pure — no `fs`, no `process.env`. The CLI shim (`bin/report-tokens.ts`)
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
 * `Tokens in` is the full input-side total (`inputTokens +
 * cacheCreationInputTokens + cacheReadInputTokens`) — genuinely every
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
/**
 * An embedded newline could forge a synthetic row/line neither writer ever
 * intended, regardless of which grammar's own delimiter is in play — shared
 * by both sanitizers below.
 */
function stripNewlines(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

/**
 * Table-row sanitizer: escapes `|` (the cell delimiter `splitTableRow`
 * already expects `\|` for on read — the same escape convention, applied on
 * write) on top of `stripNewlines`. Used by `formatTokenReportRow` for every
 * free-text cell — `phase`, `role`, the derived `model`, and `date` —
 * because any of them can arrive from an untrusted CLI flag or a git branch
 * name, both of which can legally contain `|` and newlines (found live: a
 * crafted branch name produced a row whose columns silently shifted past
 * `parseTokenReportEntries`, discarding real measured usage with no error).
 */
function sanitizeForTableCell(value: string): string {
  return stripNewlines(value).replace(/\|/g, '\\|')
}

/**
 * `Tokens: …` line sanitizer. `parse-token-report.ts`'s `SEGMENT_SEP`
 * (`/\s+[—–-]\s+/`) is a whitespace-flanked dash — and a field-local fix
 * (removing the flanking whitespace around a dash the field itself
 * contains) is provably incomplete: the JOIN ITSELF contributes whitespace
 * on both sides of every field (the literal `" — "` between segments), so a
 * field merely ENDING or STARTING with a dash reconstructs the exact same
 * pattern from the boundary alone — `"9 -"` joined with the next field's
 * leading `" — "` reads back as `"...9 - — ..."`, a real `SEGMENT_SEP`
 * match, with no dash-adjacent whitespace inside the field at all to strip
 * (found live: `--phase "9 -" --role "Dev -"` silently dropped the real
 * `tokensIn`). No amount of field-local whitespace-stripping closes this —
 * the hazard is the CHARACTER, reachable from any position once anything
 * joins around it, not a particular spacing.
 *
 * The fix that actually closes it: remove the character itself from the
 * field's vocabulary, but ONLY where it's actually reachable by
 * `SEGMENT_SEP` — a dash counts as reachable on a given side when that
 * side is whitespace, OR is the very edge of the field (every field in
 * this grammar sits directly against a `" — "` join or the `"Tokens: "`
 * prefix, so an edge is guaranteed adjacent to boundary whitespace once
 * concatenated). A dash is substituted only when BOTH sides are reachable
 * — matching exactly what `SEGMENT_SEP` itself requires (whitespace on
 * both sides) once the guaranteed boundary whitespace is accounted for.
 * An ordinary hyphenated identifier like `"claude-sonnet-5"` has
 * non-whitespace, non-edge neighbors on both sides of every hyphen and is
 * left completely untouched — a whole-field substitution (an earlier draft
 * of this fix) needlessly mangled every such identifier, which is why this
 * checks each dash's actual neighbors instead of blanket-replacing the
 * class. This is also less lossy than the whitespace-stripping this
 * replaces: two phase labels that only differed in spacing around a
 * hazardous hyphen (`"9-fix"` — never hazardous, untouched — vs.
 * `"9 - fix"` — hazardous, substituted) used to sanitize to byte-identical
 * output; substitution preserves spacing, changing only the one character
 * that must never survive verbatim in a hazardous position.
 */
const DASH_LOOKALIKES: Record<string, string> = {
  '-': '‑', // U+2011 NON-BREAKING HYPHEN
  '–': '‒', // U+2012 FIGURE DASH
  '—': '―' // U+2015 HORIZONTAL BAR
}
const DASH_CHARS = new Set(Object.keys(DASH_LOOKALIKES))

/**
 * `formatTokenReportRow`'s own table cells escape `|` as `\|` because
 * `splitTableRow` reads that convention back on the other side.
 * This line has no such reader — nothing unescapes a backslash out of it —
 * so a literal `\|` here would just be a backslash followed by a visible
 * bar, one more hazardous character rather than fewer. A same-glyph
 * lookalike, matching `DASH_LOOKALIKES`'s own approach, neutralizes the
 * delimiter unconditionally (unlike a dash, no ordinary model id legitimately
 * contains a pipe, so there is no adjacency case to preserve): an
 * attacker-controlled `model` field (a real live reproduction: a transcript
 * whose `message.model` read `attacker | evil-injected-cell | extra`) must
 * not survive with a real `|` if this line is later quoted verbatim inside
 * an actual markdown table cell by anything downstream — `pr report --write`
 * already escapes correctly at its own render step (`formatTokenReportRow`),
 * but this line, not that one, is what that reproduction actually
 * printed, and it carries no such guarantee of its own once it leaves here.
 */
const PIPE_LOOKALIKE = '｜' // U+FF5C FULLWIDTH VERTICAL LINE

function sanitizeForTokensLine(value: string): string {
  const stripped = stripNewlines(value)
  let result = ''
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i] as string
    if (ch === '|') {
      result += PIPE_LOOKALIKE
      continue
    }
    if (DASH_CHARS.has(ch)) {
      const leftReachable = i === 0 || /\s/.test(stripped[i - 1] as string)
      const rightReachable = i === stripped.length - 1 || /\s/.test(stripped[i + 1] as string)
      if (leftReachable && rightReachable) {
        result += DASH_LOOKALIKES[ch]
        continue
      }
    }
    result += ch
  }
  return result
}

/** Shared by `formatTokensLine` and `formatTokenReportRow` — one place that turns a summary into the model/tokensIn/tokensOut cells both grammars report, so the two shapes can never drift on the arithmetic. `model` is `null` rather than the `—` placeholder when neither `modelOverride` nor the summary supplies one — that placeholder is a sentinel THIS module emits, never untrusted content, and must never be run through either grammar's sanitizer (which would rewrite its `—` into something that no longer reads as "unknown"). Each caller substitutes the literal `—` for `null` itself, after sanitizing everything that came from `input`. */
function renderCells(input: TokensLineInput): { model: string | null; tokensIn: string; tokensOut: string } {
  const model = input.modelOverride ?? input.summary?.model ?? null
  if (!input.summary) return { model, tokensIn: '—', tokensOut: '—' }
  const { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, outputTokens } = input.summary.components
  const tokensIn = inputTokens + cacheCreationInputTokens + cacheReadInputTokens
  return { model, tokensIn: String(tokensIn), tokensOut: String(outputTokens) }
}

export function formatTokensLine(input: TokensLineInput): string {
  const { model, tokensIn, tokensOut } = renderCells(input)
  const phase = sanitizeForTokensLine(input.phase)
  const role = sanitizeForTokensLine(input.role)
  const safeModel = model === null ? '—' : sanitizeForTokensLine(model)
  if (!input.summary) {
    return `Tokens: ${phase} — ${role} — ${safeModel} — —`
  }
  return `Tokens: ${phase} — ${role} — ${safeModel} — ${tokensIn}/${tokensOut}/—`
}

export type TokenReportRowInput = TokensLineInput & {
  /** `YYYY-MM-DD`. Caller-supplied, never derived here — this file stays `Date.now()`-free per its purity charter above. */
  date: string
}

/**
 * The same cells `formatTokensLine` reports, rendered as one `| Phase | Role
 * | Agent/Model | Tokens in | Tokens out | Cost | Date |` markdown-table row
 * — the shape `aeg-root/roles/developer.md`'s "Token report" heading and
 * `parse-token-report.ts`'s `parseTokenReportEntries` (table form) both
 * already expect. `Cost` is always `—`, same reasoning as `formatTokensLine`'s
 * own Cost cell: no maintained per-model pricing table exists in this package.
 */
export function formatTokenReportRow(input: TokenReportRowInput): string {
  const { model, tokensIn, tokensOut } = renderCells(input)
  const phase = sanitizeForTableCell(input.phase)
  const role = sanitizeForTableCell(input.role)
  const safeModel = model === null ? '—' : sanitizeForTableCell(model)
  const date = sanitizeForTableCell(input.date)
  return `| ${phase} | ${role} | ${safeModel} | ${tokensIn} | ${tokensOut} | — | ${date} |`
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
    `  messages summed:       ${summary.messageCount}`
  ].join('\n')
}
