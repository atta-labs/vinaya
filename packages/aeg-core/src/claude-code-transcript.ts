/**
 * claude-code-transcript — the Claude Code **collection adapter** for the
 * token-report obligation (`aeg-root/tranche-model.md` §12, layer 2).
 *
 * This file is host-coupled on purpose: it is the only `src/` module whose
 * LOGIC parses a host's own data format. Others name host paths as
 * classification patterns — `file-classify.ts` matches `.claude/skills/` and
 * `CLAUDE.md` — which is a different and weaker kind of coupling.
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

/**
 * `resolveMeteringCapability`'s I/O — injected, never imported directly, per
 * this package's purity charter (`fs`/`process.env` stay out of `src/`). The
 * real caller (`apps/cli`'s `tokens`/`doctor` commands) supplies
 * `existsSync`/`readFileSync`/`process.env`/`process.cwd()`; tests supply
 * fakes.
 */
export type MeteringCapabilityDeps = {
  env: Record<string, string | undefined>
  cwd: string
  exists: (path: string) => boolean
  readFile: (path: string) => string
}

export type MeteringIncapableReason = 'no-transcript-resolved' | 'transcript-unreadable' | 'transcript-empty'

export type MeteringCapability =
  | { capable: true; transcriptPath: string; summary: TranscriptSummary }
  | { capable: false; reason: MeteringIncapableReason; detail: string }

function sanitizeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '-')
}

/**
 * Mirrors `bin/report-tokens.ts`'s own pointer-file convention (a
 * `track-transcript.sh` Stop hook, keyed by `CLAUDE_PROJECT_DIR`) so a repo
 * that already wires that hook gets probe support for free. Deliberately
 * duplicated rather than imported from `bin/`: `bin/` is I/O-shim code that
 * imports `src/`, never the reverse, and is not part of this package's
 * published `exports` map — the whole reason this probe exists is to work
 * where that path is unreachable.
 */
function transcriptPointerPath(projectDir: string, tmpDir: string): string {
  return `${tmpDir}/claude-transcript-${sanitizeKey(projectDir)}.txt`
}

/**
 * Resolves a transcript path to probe — `explicitTranscriptPath` (the
 * caller's own `--transcript`) wins outright, exactly like
 * `bin/report-tokens.ts`'s `--transcript`. Otherwise consults the Stop-hook
 * pointer file, applying the same `CLAUDE_CODE_SESSION_ID` staleness
 * cross-check that adapter uses — a stale pointer left by a previous session
 * sharing this worktree must not be silently trusted.
 *
 * Returns an error string rather than throwing: this is the
 * "nothing to even try" case (Stop-and-escalate's "no transcript exists"),
 * kept distinct in `resolveMeteringCapability` from a resolved-but-unreadable
 * path.
 */
function resolvePointer(
  explicitTranscriptPath: string | undefined,
  deps: MeteringCapabilityDeps
): { path: string } | { error: string } {
  if (explicitTranscriptPath) return { path: explicitTranscriptPath }

  const projectDir = deps.env.CLAUDE_PROJECT_DIR ?? deps.cwd
  const tmpDir = deps.env.TMPDIR ?? '/tmp'
  const pointerPath = transcriptPointerPath(projectDir, tmpDir)

  if (!deps.exists(pointerPath)) {
    return {
      error:
        `No transcript pointer at ${pointerPath} and no --transcript given. ` +
        'Either this repo installs no track-transcript.sh Stop hook (lacking one is not a defect — ' +
        'name the transcript directly instead), or no session has completed a turn yet.'
    }
  }

  let contents: string
  try {
    contents = deps.readFile(pointerPath).trim()
  } catch (err) {
    return { error: `Transcript pointer at ${pointerPath} could not be read: ${(err as Error).message}` }
  }

  const [pointerSessionId, transcriptPath] = contents.split('\t')
  if (!transcriptPath) {
    return { error: `Transcript pointer file ${pointerPath} is malformed: "${contents}"` }
  }

  const currentSessionId = deps.env.CLAUDE_CODE_SESSION_ID
  if (currentSessionId && pointerSessionId && currentSessionId !== pointerSessionId) {
    return {
      error:
        `Transcript pointer at ${pointerPath} is stale: written for session ${pointerSessionId}, ` +
        `but this session is ${currentSessionId}. Name your own transcript with --transcript instead of ` +
        "reporting another session's figures as yours."
    }
  }

  return { path: transcriptPath }
}

/**
 * Probes whether this host can currently produce real token figures —
 * capable/incapable, never declared by host identity (`vinaya doctor`'s
 * whole reason for calling this rather than checking `process.env` itself).
 * Distinguishes the two failure classes the Stop-and-escalate condition
 * names: `no-transcript-resolved` (nothing to even try — no `--transcript`,
 * no pointer file) is a different fact from `transcript-unreadable` (a path
 * was resolved but the file can't be read) or `transcript-empty` (the file
 * reads but summarizes to zero assistant messages — empty, unparseable, or
 * not yet flushed). Conflating any of these into one "incapable" bit would
 * reproduce the false "host has no usage" claim this tranche removes.
 *
 * `explicitTranscriptPath`, when given, wins outright over pointer-file
 * discovery — the caller's own `--transcript` is always better evidence than
 * any inference this function could make.
 */
export function resolveMeteringCapability(
  deps: MeteringCapabilityDeps,
  explicitTranscriptPath?: string
): MeteringCapability {
  const resolved = resolvePointer(explicitTranscriptPath, deps)
  if ('error' in resolved) {
    return { capable: false, reason: 'no-transcript-resolved', detail: resolved.error }
  }

  if (!deps.exists(resolved.path)) {
    return {
      capable: false,
      reason: 'transcript-unreadable',
      detail: `Resolved transcript path ${resolved.path} does not exist.`
    }
  }

  let jsonl: string
  try {
    jsonl = deps.readFile(resolved.path)
  } catch (err) {
    return {
      capable: false,
      reason: 'transcript-unreadable',
      detail: `Transcript at ${resolved.path} could not be read: ${(err as Error).message}`
    }
  }

  const summary = summarizeTranscript(jsonl)
  if (summary.messageCount === 0) {
    return {
      capable: false,
      reason: 'transcript-empty',
      detail:
        `Transcript at ${resolved.path} yielded zero assistant messages with usage data — ` +
        "it's empty, unparseable, or not yet flushed to disk."
    }
  }

  return { capable: true, transcriptPath: resolved.path, summary }
}
