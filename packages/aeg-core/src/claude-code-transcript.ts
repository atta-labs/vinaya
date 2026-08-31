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

export type MeteringIncapableReason =
  | 'no-transcript-resolved'
  | 'pointer-unusable'
  | 'transcript-unreadable'
  | 'transcript-empty'

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
type PointerResolution =
  | { path: string; corroborated: boolean }
  /**
   * `corroborated` — we read the pointer's session id and it is ours.
   * `oursByLocation` — we could NOT read an id, but the file sits at this
   * project's own pointer path and is owned by this user. Two different
   * grounds, deliberately not one field: an earlier revision set
   * `corroborated: Boolean(currentSessionId)` on branches where the id was
   * never read, which asserted a match that had not been established and put
   * three shipped docs at odds with the code.
   */
  | { error: string; pointerExisted: boolean; corroborated?: boolean; oursByLocation?: boolean }

function resolvePointer(explicitTranscriptPath: string | undefined, deps: MeteringCapabilityDeps): PointerResolution {
  // A caller-named transcript is self-corroborating: they told us which file
  // is theirs, so there is no session to cross-check it against.
  if (explicitTranscriptPath) return { path: explicitTranscriptPath, corroborated: true }

  const projectDir = deps.env.CLAUDE_PROJECT_DIR ?? deps.cwd
  const tmpDir = deps.env.TMPDIR ?? '/tmp'
  const pointerPath = transcriptPointerPath(projectDir, tmpDir)

  // Corroboration = we can tell this pointer belongs to THIS session. Without
  // `CLAUDE_CODE_SESSION_ID` there is nothing to cross-check against, so a
  // pointer left by an earlier session is indistinguishable from our own. A
  // plain human terminal is exactly that case, and gating its commits on
  // another session's leftovers is the false positive `#272` names as the
  // expensive failure mode.
  const currentSessionId = deps.env.CLAUDE_CODE_SESSION_ID

  if (!deps.exists(pointerPath)) {
    return {
      pointerExisted: false,
      corroborated: false,
      error:
        `No transcript pointer at ${pointerPath} and no --transcript given. ` +
        'Either this repo installs no track-transcript.sh Stop hook (lacking one is not a defect — ' +
        'name the transcript directly instead), or no session has completed a turn yet.'
    }
  }

  let contents: string
  try {
    // Trailing newline only — NEVER `.trim()`. The shipped Stop hook writes
    // `(hook.session_id || "") + "\t" + transcript_path`, so a Stop payload
    // carrying no `session_id` produces a pointer beginning with a TAB.
    // `.trim()` ate that leading tab, `split('\t')` then found no separator,
    // and a pointer naming a present, readable, summarizable transcript was
    // classified malformed — refusing every commit on a host that meters
    // perfectly. Proven end to end against the real hook body.
    contents = deps.readFile(pointerPath).replace(/\r?\n+$/, '')
  } catch (err) {
    return {
      pointerExisted: true,
      // NOT a corroboration claim: an unreadable pointer's session id is never
      // read, so nothing here can show whose it is. The refusal rests on a
      // different and sufficient ground — this is OUR project's pointer path,
      // holding a file WE own, which we cannot use. That is broken wiring
      // whoever wrote it, and it is repaired by removing the file.
      oursByLocation: true,
      error:
        `Transcript pointer at ${pointerPath} could not be read: ${(err as Error).message}. ` +
        'Remove that file to clear this — the Stop hook rewrites it on the next turn.'
    }
  }

  const [pointerSessionId, transcriptPath] = contents.split('\t')
  if (!transcriptPath) {
    return {
      pointerExisted: true,
      // Same ground as the unreadable branch, and NOT a corroboration claim: a
      // malformed pointer carries no parseable session id, so whose it is
      // cannot be established. Ours by location and ownership, and unusable.
      oursByLocation: true,
      // Bounded: this echoes an on-disk file's contents into check output,
      // which in the hook path reaches commit output and CI logs. The guard
      // upstream proves the file is owned by this user, so it is not
      // attacker-controlled — but an unbounded echo is still wrong.
      error:
        `Transcript pointer file ${pointerPath} is malformed: "${contents.slice(0, 120)}${contents.length > 120 ? '…' : ''}". ` +
        'Remove that file to clear this — the Stop hook rewrites it on the next turn.'
    }
  }

  if (currentSessionId && pointerSessionId && currentSessionId !== pointerSessionId) {
    // `corroborated: false`, and the distinction is the whole point: the ids
    // DISAGREE, so this pointer is provably NOT this session's. Two reviewers
    // reached opposite conclusions here and the second is right. Treating a
    // stale pointer as a wiring defect refuses a correctly wired host: a second
    // session in the same project directory sees the first session's pointer
    // until its own Stop hook fires, which by construction is only after its
    // first turn completes — so its very first commit is blocked, and the
    // remedy the message names (`--transcript`) is a flag `vinaya check` does
    // not accept, leaving no action that clears the refusal.
    //
    // It also makes `corroborated` mean one thing rather than two. Everywhere
    // else it answers "can we show this pointer is ours"; setting it true here
    // made it mean "we could tell, and it wasn't", which is what put the three
    // shipped docs at odds with the code.
    return {
      pointerExisted: true,
      corroborated: false,
      error:
        `Transcript pointer at ${pointerPath} is stale: written for session ${pointerSessionId}, ` +
        `but this session is ${currentSessionId}. Name your own transcript with --transcript instead of ` +
        "reporting another session's figures as yours."
    }
  }

  return { path: transcriptPath, corroborated: Boolean(currentSessionId && pointerSessionId) }
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
    // A pointer that EXISTS but cannot be used is a wiring defect, not an
    // absence of wiring — but only when we can corroborate it is ours.
    // Uncorroborated, it is indistinguishable from another session's leftover
    // and degrades to the sanctioned operator-metered case.
    // Refuse when the pointer is ours on EITHER ground: its id matches, or it
    // is a file we own at our own pointer path that we cannot use. Pass when
    // it is provably another session's (the stale branch sets neither).
    const ours = resolved.pointerExisted && (resolved.corroborated || resolved.oursByLocation)
    if (ours) return { capable: false, reason: 'pointer-unusable', detail: resolved.error }
    // Degraded, so the detail is rewritten to match. An earlier revision
    // degraded only the reason on this path, leaving a `no-transcript-resolved`
    // verdict whose detail described a pointer that HAD resolved — the
    // contradictory pair that reaches `vinaya doctor` and `pr report`'s token
    // cell. The original condition is kept, marked as diagnostic.
    return {
      capable: false,
      reason: 'no-transcript-resolved',
      detail: resolved.pointerExisted
        ? `A transcript pointer exists but belongs to another session, so this session has no wiring of its own to use. (Underlying condition, for diagnosis only: ${resolved.error})`
        : resolved.error
    }
  }

  // Downstream transcript failures gate only on a corroborated pointer, for the
  // same reason: a stale pointer naming a since-pruned transcript must not
  // refuse a human's commit.
  // Returns the reason AND a detail consistent with it. An earlier revision
  // degraded only the reason and kept the original detail, so an incapable
  // verdict could read `no-transcript-resolved` while its detail said a
  // transcript HAD been resolved and was unreadable. That pair leaks past this
  // check into `vinaya doctor` and into `pr report`'s token cell, which is the
  // false-provenance class this whole tranche exists to remove.
  const downstream = (
    r: 'transcript-unreadable' | 'transcript-empty',
    detail: string
  ): { reason: MeteringIncapableReason; detail: string } =>
    resolved.corroborated
      ? { reason: r, detail }
      : {
          reason: 'no-transcript-resolved',
          detail: `A transcript pointer was found but could not be shown to belong to this session, so it is not treated as this session's wiring. (Underlying condition, for diagnosis only: ${detail})`
        }

  if (!deps.exists(resolved.path)) {
    return {
      capable: false,
      // "not readable as a regular file owned by this user" rather than "does
      // not exist": the shipped check's `exists` dep is `lstat`-hardened, so a
      // symlinked, foreign-owned, or non-regular transcript reports false here
      // for a path that does exist. Saying "does not exist" of such a file is
      // both wrong and unactionable.
      ...downstream(
        'transcript-unreadable',
        `Resolved transcript path ${resolved.path} is not readable as a regular file owned by this user.`
      )
    }
  }

  let jsonl: string
  try {
    jsonl = deps.readFile(resolved.path)
  } catch (err) {
    return {
      capable: false,
      ...downstream(
        'transcript-unreadable',
        `Transcript at ${resolved.path} could not be read: ${(err as Error).message}`
      )
    }
  }

  const summary = summarizeTranscript(jsonl)
  if (summary.messageCount === 0) {
    return {
      capable: false,
      ...downstream(
        'transcript-empty',
        `Transcript at ${resolved.path} yielded zero assistant messages with usage data — ` +
          "it's empty, unparseable, or not yet flushed to disk."
      )
    }
  }

  return { capable: true, transcriptPath: resolved.path, summary }
}

/**
 * The one fact `token-collection-wired` (task 5, #272) gates a commit on,
 * factored out here — contract-agnostic (a plain boolean, no `CheckError`
 * shape) — so both the shipped `apps/cli` check and this repo's own
 * self-hosting `bin/check-token-collection-wired.ts` gate consume the SAME
 * predicate, never two copies (the `isNewDiskStateFile` precedent).
 *
 * `no-transcript-resolved` means this session has no corroborated wiring to
 * try — no pointer file at all, or a pointer it cannot show is its own. That
 * is the sanctioned operator-metered case, never a defect.
 *
 * Every other reason means a pointer BOTH existed AND was corroborated as this
 * session's, and reaching the figures still failed: `pointer-unusable` (the
 * pointer itself is unreadable, malformed, or stale) or `transcript-unreadable`
 * / `transcript-empty` (the path it named could not be read or held nothing).
 * Those are the wiring defect this predicate flags.
 *
 * The corroboration condition is load-bearing in BOTH directions, and an
 * earlier revision got both wrong. Without it, a pointer left in a shared
 * `TMPDIR` by an unrelated session refuses a plain human's commit (a false
 * positive `#272` names as the expensive failure mode); and folding every
 * pointer failure into `no-transcript-resolved` let an unreadable, malformed,
 * or stale pointer pass silently — the exact wired-but-unreachable state this
 * check exists to refuse.
 */
/*
 * Returns a plain boolean, deliberately NOT a type predicate. As a predicate it
 * was unsound: `false` also covers `{capable: false, reason:
 * 'no-transcript-resolved'}`, so the negative branch narrowed to `capable:
 * true` and `cap.summary` compiled clean while throwing at runtime. That is a
 * false capability guarantee handed to every adopter of a published package,
 * and no caller needs the narrowing badly enough to be worth it.
 */
export function isTokenCollectionWiringBroken(capability: MeteringCapability): boolean {
  if (capability.capable) return false
  return capability.reason !== 'no-transcript-resolved'
}
